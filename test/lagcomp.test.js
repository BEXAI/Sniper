// Lag-comp asymmetry: aiming at where a strafing victim was RENDERED (200 ms ago)
// with tt=then must HIT; identical aim with tt=now must MISS; rewind clamps at
// 250 ms; a ray through the head is a HEADSHOT even when it clips the body; and
// the input-debt pipeline never double-integrates or loses acks.
import assert from 'node:assert';
import { makeRing, recordPose, resolveFire, poseAt } from '../server/game/lagcomp.js';
import { Player } from '../server/game/player.js';
import { mulberry32 } from '../shared/math.js';
import { EYE_HEIGHT, HEAD_Y, BTN, TICK_MS, SPEED, TICK_DT } from '../shared/constants.js';

// No walls: an empty box list isolates the hitbox math.
const NO_WALLS = [];
const rng = mulberry32(7);

function aimAt(shooter, tx, ty, tz) {
  const ox = shooter.state.x, oy = shooter.state.y + EYE_HEIGHT, oz = shooter.state.z;
  const dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const horiz = Math.hypot(dx, dz);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, horiz) };
}

// Victim strafes at 5 m/s along +X, 40 m straight ahead of the shooter (LOS along
// -Z), so the strafe is fully LATERAL: 200 ms of movement = 1 m of miss margin
// against a 0.4 m capsule.
const vx = (t) => 5 * (t / 1000) - 45;   // x(now=10000) = 5
function makeVictim() {
  const v = new Player({ id: 'victim0000000000', name: 'V' });
  v.status = 'ALIVE';
  const now = 10000;
  for (let i = 0; i < 30; i++) {
    const t = now - (29 - i) * TICK_MS;
    v.state.x = vx(t);
    v.state.y = 0;
    v.state.z = -40;
    recordPose(v.ring, i, t, v.state);
  }
  v.state.x = vx(now);                   // current authoritative pos
  return { v, now };
}

const shooter = new Player({ id: 'shooter000000000', name: 'S' });
shooter.status = 'ALIVE';
shooter.state.x = 0; shooter.state.y = 0; shooter.state.z = 0;
shooter.swaySeed = 99;

// For a clean geometric test we fire "scoped and fully settled" but with a sway
// state whose amplitude is effectively zero: breath held + landed long ago gives
// A = 0.35 * 0.1 + ~0 = 0.035 deg -> at 100 m that's ~6 cm, well inside the capsule.
const CALM = { movingScoped: false, breathHeld: true, forcedExhale: false, msSinceLanding: 1e9 };

function settledFire(target, tt) {
  const { yaw, pitch } = aimAt(shooter, target.x, target.y, target.z);
  return { yaw, pitch, tt, scoped: true, scopedMs: 5000, swayState: CALM };
}

{
  // HIT: aim at the victim's 200 ms-old rendered position, tt = then.
  const { v, now } = makeVictim();
  const renderedX = vx(now - 200);
  const fire = settledFire({ x: renderedX, y: 0.9, z: -40 }, now - 200);
  const res = resolveFire(shooter, fire, [v], now, NO_WALLS, rng);
  assert.strictEqual(res.hit, v, 'lag-compensated shot at rendered position must hit');
  assert.strictEqual(res.part, 'body');
}

{
  // MISS: identical aim point, but tt = now (victim has moved 1 m since).
  const { v, now } = makeVictim();
  const renderedX = vx(now - 200);
  const fire = settledFire({ x: renderedX, y: 0.9, z: -40 }, now);
  const res = resolveFire(shooter, fire, [v], now, NO_WALLS, rng);
  assert.strictEqual(res.hit, null, 'same aim with tt=now must miss the moved victim');
}

{
  // CLAMP: tt = now-400 clamps to now-250; aiming at pose(now-250) must hit.
  const { v, now } = makeVictim();
  const clampedX = vx(now - 250);
  const fire = settledFire({ x: clampedX, y: 0.9, z: -40 }, now - 400);
  const res = resolveFire(shooter, fire, [v], now, NO_WALLS, rng);
  assert.strictEqual(res.hit, v, 'tt older than 250 ms must clamp to the 250 ms pose');
  assert.ok(Math.abs(res.ttUsed - (now - 250)) < 1e-6, 'ttUsed must be clamped');
}

{
  // HEADSHOT PRIORITY: a ray through the head center also clips the body cap
  // sphere (head 1.62 r .22 vs body cap 1.3 r .4) — must report head, 150 dmg class.
  const { v, now } = makeVictim();
  const pose = poseAt(v.ring, now - 100);
  const fire = settledFire({ x: pose.x, y: pose.y + HEAD_Y, z: pose.z }, now - 100);
  const res = resolveFire(shooter, fire, [v], now, NO_WALLS, rng);
  assert.strictEqual(res.hit, v, 'head-center ray must hit');
  assert.strictEqual(res.part, 'head', 'body-shadowed head must still be a HEADSHOT');
}

{
  // INPUT-DEBT: jittered delivery (gaps + bursts) must not double-integrate
  // movement or lose acks. Simulate 90 ticks of holding FWD where packets arrive
  // in bursts of 3 every 3rd tick.
  const p = new Player({ id: 'debt000000000000', name: 'D' });
  p.status = 'ALIVE';
  p.state.x = 0; p.state.y = 0; p.state.z = 0; p.state.grounded = true;
  // Start mid-air-free flat ground far from map walls: use spawn on open canyon floor.
  p.state.x = -20; p.state.z = 0;
  let seq = 0;
  const yaw = -Math.PI / 2;              // forward = +X on open ground
  let stepped = 0;
  for (let tick = 1; tick <= 90; tick++) {
    if (tick % 3 === 0) {
      for (let k = 0; k < 3; k++) p.queueInput({ seq: ++seq, b: BTN.FWD, yaw, pitch: 0 });
    }
    p.processTick();
    stepped++;
  }
  // Drain any queue remainder (2/tick catch-up may lag the final burst).
  for (let tick = 91; p.queue.length > 0 && tick < 120; tick++) { p.processTick(); stepped++; }
  const dist = p.state.x - (-20);
  const maxDist = stepped * SPEED * TICK_DT * 1.001;
  assert.ok(dist > 0, 'debt player must move forward');
  assert.ok(dist <= maxDist, `debt displacement ${dist.toFixed(2)} exceeds ${maxDist.toFixed(2)} — double integration`);
  assert.strictEqual(p.lastAckSeq, seq, 'final ack must equal last delivered seq');
}

console.log('lagcomp.test OK — hit/miss asymmetry, clamp, head priority, input debt');
