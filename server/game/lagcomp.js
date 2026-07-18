// Lag-compensated hit validation — the load-bearing wall. The server rewinds every
// potential victim to the shooter's perceived render time `tt`, lerping between the
// two straddling history poses, then raycasts from the shooter's CURRENT
// server-authoritative eye position. The shooter is never rewound.
import {
  LAGCOMP_RING, MAX_REWIND_MS, EYE_HEIGHT, HEAD_Y, HEAD_RADIUS,
  BODY_RADIUS, BODY_SEG_MIN, BODY_SEG_MAX,
  UNSCOPED_CONE_DEG, QUICKSCOPE_CONE_DEG, QUICKSCOPE_SETTLE_MS,
} from '../../shared/constants.js';
import { dirFromAngles, rayVsBoxes, raySphere, rayVsVerticalCapsule, clamp } from '../../shared/math.js';
import { swayOffsetDeg } from '../../shared/sway.js';

const DEG = Math.PI / 180;
const MAX_RANGE = 400;

export function makeRing() {
  return new Array(LAGCOMP_RING).fill(null);
}

export function recordPose(ring, tick, t, s) {
  ring[tick % LAGCOMP_RING] = { t, x: s.x, y: s.y, z: s.z };
}

// Lerped pose at time tt (already clamped by the caller). Falls back to the
// nearest recorded pose when tt is outside the recorded window.
export function poseAt(ring, tt) {
  let before = null, after = null, oldest = null, newest = null;
  for (let i = 0; i < ring.length; i++) {
    const e = ring[i];
    if (!e) continue;
    if (!oldest || e.t < oldest.t) oldest = e;
    if (!newest || e.t > newest.t) newest = e;
    if (e.t <= tt && (!before || e.t > before.t)) before = e;
    if (e.t >= tt && (!after || e.t < after.t)) after = e;
  }
  if (!oldest) return null;
  if (!before) return oldest;
  if (!after) return newest;
  if (after.t === before.t) return before;
  const f = (tt - before.t) / (after.t - before.t);
  return {
    x: before.x + (after.x - before.x) * f,
    y: before.y + (after.y - before.y) * f,
    z: before.z + (after.z - before.z) * f,
  };
}

// fire: { yaw, pitch, tt, scoped, scopedMs, swayState }  (captured at input processing)
// victims: alive, unprotected players excluding the shooter.
// Returns { origin, dir, end, t, hit: player|null, part: 'head'|'body'|null, ttUsed }.
export function resolveFire(shooter, fire, victims, serverNow, mapBoxes, rng) {
  const tt = clamp(fire.tt, serverNow - MAX_REWIND_MS, serverNow);

  // Ray direction: aim angles + deterministic sway (evaluated at the clamped client
  // fire time — the instant the client rendered its reticle) + server-rolled spread.
  let yawOffDeg = 0, pitchOffDeg = 0;
  let coneDeg = 0;
  if (fire.scoped) {
    const sway = swayOffsetDeg(tt / 1000, shooter.swaySeed, fire.swayState);
    yawOffDeg += sway.yawDeg;
    pitchOffDeg += sway.pitchDeg;
    if (fire.scopedMs < QUICKSCOPE_SETTLE_MS) {
      coneDeg = QUICKSCOPE_CONE_DEG * (1 - fire.scopedMs / QUICKSCOPE_SETTLE_MS);
    }
  } else {
    coneDeg = UNSCOPED_CONE_DEG;
  }
  if (coneDeg > 0) {
    const phi = rng() * Math.PI * 2;
    const r = coneDeg * Math.sqrt(rng());
    yawOffDeg += r * Math.cos(phi);
    pitchOffDeg += r * Math.sin(phi);
  }
  const dir = dirFromAngles(fire.yaw + yawOffDeg * DEG, clamp(fire.pitch + pitchOffDeg * DEG, -1.55, 1.55));
  const origin = [shooter.state.x, shooter.state.y + EYE_HEIGHT, shooter.state.z];

  const wallT = rayVsBoxes(origin, dir, mapBoxes, MAX_RANGE);
  let best = null;
  for (const v of victims) {
    const pose = poseAt(v.ring, tt);
    if (!pose) continue;
    // Head sphere FIRST, with priority: a ray through the head is a headshot even
    // if it also clips the body capsule.
    const tHead = raySphere(origin, dir, pose.x, pose.y + HEAD_Y, pose.z, HEAD_RADIUS);
    if (tHead < wallT && tHead <= MAX_RANGE) {
      if (!best || tHead < best.t) best = { t: tHead, part: 'head', victim: v };
      continue;
    }
    const tBody = rayVsVerticalCapsule(origin, dir, pose.x, pose.z,
      pose.y + BODY_SEG_MIN, pose.y + BODY_SEG_MAX, BODY_RADIUS);
    if (tBody < wallT && tBody <= MAX_RANGE) {
      if (!best || tBody < best.t) best = { t: tBody, part: 'body', victim: v };
    }
  }

  const endT = best ? best.t : Math.min(wallT, MAX_RANGE);
  const end = [origin[0] + dir[0] * endT, origin[1] + dir[1] * endT, origin[2] + dir[2] * endT];
  return {
    origin, dir, end, t: endT, ttUsed: tt,
    hit: best ? best.victim : null,
    part: best ? best.part : null,
  };
}
