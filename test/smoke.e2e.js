// True hit-registration E2E: boots the REAL server (TEST_MODE=1: no bots in r0,
// pinned mutually-visible spawns), drives two headless ws clients, and asserts the
// full pipeline — module graph, movement speed cap, sway-compensated body + head
// kills, respawn stability, fire-rate gating, REST hardening, leaderboard.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { swayOffsetDeg } from '../shared/sway.js';
import { BTN, EYE_HEIGHT, TICK_MS } from '../shared/constants.js';
import { dirFromAngles } from '../shared/math.js';

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- headless client ----------
class TestClient {
  constructor(label) {
    this.label = label;
    this.you = null;
    this.events = [];
    this.snaps = 0;
    this.acks = [];
    this.players = new Map();
    this.offsetSamples = [];
    this.offset = 0;
    this.seq = 0;
    this.keys = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.pendingFire = null;
    this.welcome = null;
    this.swaySeed = 1;
    this.spawnPos = null;
    this.closed = false;
    this.closeInfo = null;
  }

  serverTime() { return performance.now() + this.offset; }

  connect(hello) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const to = setTimeout(() => reject(new Error(`${this.label}: welcome timeout`)), 5000);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'hello', ...hello }));
        for (let i = 0; i < 5; i++) {
          setTimeout(() => this.ws.readyState === 1
            && this.ws.send(JSON.stringify({ type: 'ping', cn: performance.now() })), 60 * (i + 1));
        }
      });
      this.ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'pong') {
          const now = performance.now();
          const rtt = now - m.cn;
          this.offsetSamples.push({ rtt, offset: m.st + rtt / 2 - now });
          this.offset = this.offsetSamples.reduce((b, s) => (s.rtt < b.rtt ? s : b)).offset;
        } else if (m.type === 'welcome') {
          this.welcome = m;
          this.pid = m.pid;
          clearTimeout(to);
          resolve(m);
        } else if (m.type === 'snap') {
          this.snaps++;
          this.you = m.you;
          this.acks.push(m.ack);
          for (const p of m.d.players) this.players.set(p.id, p);
          for (const ev of m.d.events) {
            this.events.push(ev);
            if (ev.e === 'spawn' && ev.who === this.pid) {
              this.swaySeed = ev.swaySeed;
              this.spawnPos = { x: ev.x, y: ev.y, z: ev.z, yaw: ev.yaw };
            }
          }
        } else if (m.type === 'matchEnd') {
          this.matchEnd = m;
        }
      });
      this.ws.on('close', (code, reason) => { this.closed = true; this.closeInfo = { code, reason: reason.toString() }; });
      this.ws.on('error', () => {});
      this.loop = setInterval(() => {
        if (this.ws.readyState !== 1) return;
        const input = { type: 'input', seq: ++this.seq, b: this.keys, yaw: this.yaw, pitch: this.pitch };
        if (this.pendingFire) { input.fire = this.pendingFire; this.pendingFire = null; }
        this.ws.send(JSON.stringify(input));
      }, TICK_MS);
      this.pinger = setInterval(() => {
        if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping', cn: performance.now() }));
      }, 2000);
    });
  }

  async waitEvent(pred, timeoutMs, label) {
    const start = Date.now();
    let idx = 0;
    while (Date.now() - start < timeoutMs) {
      for (; idx < this.events.length; idx++) {
        if (pred(this.events[idx])) return this.events[idx];
      }
      await sleep(25);
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  // Sway-compensated aimed fire at a world point: the server evaluates sway at our
  // clamped tt with our server-side state, so compensating by -sway makes the
  // actual fired ray equal the intended ray exactly.
  aimedFire(tx, ty, tz) {
    const ox = this.you.x, oy = this.you.y + EYE_HEIGHT, oz = this.you.z;
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const aimYaw = Math.atan2(-dx, -dz);
    const aimPitch = Math.atan2(dy, Math.hypot(dx, dz));
    const tt = this.serverTime();
    const sway = swayOffsetDeg(tt / 1000, this.swaySeed, {
      movingScoped: false,
      breathHeld: true,
      forcedExhale: false,
      msSinceLanding: this.you.landMs,
    });
    const DEG = Math.PI / 180;
    this.yaw = aimYaw - sway.yawDeg * DEG;
    this.pitch = aimPitch - sway.pitchDeg * DEG;
    this.keys = BTN.SCOPE | BTN.BREATH | BTN.FIRE;
    this.pendingFire = { tt };
    return { aimYaw, aimPitch };
  }

  stop() { clearInterval(this.loop); clearInterval(this.pinger); try { this.ws.close(); } catch { /* gone */ } }
}

// ---------- boot server ----------
const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), TEST_MODE: '1', SERVER_SECRET: 'smoke-secret', DATABASE_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const fail = (msg) => { console.error(msg); console.error('--- server log ---\n' + serverLog); server.kill(); process.exit(1); };
process.on('uncaughtException', (e) => fail(`UNCAUGHT: ${e.stack}`));
process.on('unhandledRejection', (e) => fail(`UNHANDLED: ${e && e.stack || e}`));

for (let i = 0; ; i++) {
  await sleep(300);
  try {
    const st = await (await fetch(`${BASE}/api/status`)).json();
    if (st.ok) break;
  } catch { /* booting */ }
  if (i > 30) fail('server never became healthy');
}

// ---------- 1. static + module-graph check (highest-probability one-shot failure) ----------
{
  const res = await fetch(BASE + '/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);

  const queue = ['/js/main.js'];
  const seenFiles = new Set(queue);
  while (queue.length) {
    const path = queue.shift();
    const r = await fetch(BASE + path);
    assert.strictEqual(r.status, 200, `module ${path} -> ${r.status}`);
    assert.match(r.headers.get('content-type'), /text\/javascript/, `${path} content-type`);
    const src = await r.text();
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      let spec = m[1];
      if (spec.startsWith('./')) spec = path.slice(0, path.lastIndexOf('/') + 1) + spec.slice(2);
      if (!spec.startsWith('/')) continue;
      if (!seenFiles.has(spec)) { seenFiles.add(spec); queue.push(spec); }
    }
  }
  assert.ok(seenFiles.has('/vendor/three.module.js'), 'vendored three.js must be in the graph');
  assert.ok(seenFiles.has('/shared/movement.js'), 'shared movement must be in the graph');
  console.log(`module graph OK — ${seenFiles.size} files all 200 text/javascript`);
}

// ---------- 2. traversal defense ----------
for (const path of ['/public/../package.json', '/shared/%2e%2e/%2e%2e/server/index.js', '/..%2f..%2fpackage.json']) {
  const r = await fetch(BASE + path);
  assert.strictEqual(r.status, 404, `traversal ${path} must 404, got ${r.status}`);
}
console.log('traversal defense OK');

// ---------- 3. identities + join ----------
async function guest(name) {
  const r = await fetch(`${BASE}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  assert.strictEqual(r.status, 200);
  return r.json();
}
const idA = await guest('TestA');
const idB = await guest('TestB');

const A = new TestClient('A');
const B = new TestClient('B');
await A.connect({ name: 'TestA', pid: idA.pid, token: idA.token });
await B.connect({ name: 'TestB', pid: idB.pid, token: idB.token });
await sleep(700);                                  // clock sync + first snapshots
assert.ok(A.you && B.you, 'both clients receive you-state');
assert.strictEqual(A.spawnPos.x, -20, 'A pinned spawn');
assert.strictEqual(B.spawnPos.x, 20, 'B pinned spawn');
const st0 = await (await fetch(`${BASE}/api/status`)).json();
assert.strictEqual(st0.rooms[0].bots, 0, 'TEST_MODE room 0 must have no bots');

// ---------- 4. movement + speed cap ----------
{
  const x0 = A.you.x;
  A.yaw = -Math.PI / 2;                            // forward = +X, toward B along the clear lane
  A.keys = BTN.FWD;
  const t0 = performance.now();
  await sleep(2000);
  A.keys = 0;
  await sleep(300);                                // let the last inputs settle
  const elapsed = (performance.now() - t0 + 300) / 1000;
  const dist = A.you.x - x0;
  assert.ok(dist > 5, `A moved only ${dist.toFixed(2)} m`);
  assert.ok(dist <= 6.0 * elapsed * 1.1, `A moved ${dist.toFixed(2)} m in ${elapsed.toFixed(2)} s — speed cap breached`);
  console.log(`movement OK — ${dist.toFixed(1)} m in ${elapsed.toFixed(1)} s`);
}

// ---------- 5. sway-compensated body shot ----------
async function scopedShotAt(client, tx, ty, tz) {
  client.keys = BTN.SCOPE | BTN.BREATH;
  await sleep(500);                                // settle past the quickscope cone
  const marker = client.events.length;
  const { aimYaw, aimPitch } = client.aimedFire(tx, ty, tz);
  const shot = await client.waitEvent(
    (ev, i) => ev.e === 'shot' && ev.by === client.pid && client.events.indexOf(ev) >= marker,
    2000, 'own shot event');
  client.keys = 0;
  return { shot, aimYaw, aimPitch };
}

{
  const b = A.players.get(B.pid);
  const { shot, aimYaw, aimPitch } = await scopedShotAt(A, b.x, b.y + 0.9, b.z);
  // Echoed ray must match the intended ray within 0.2 degrees.
  const want = dirFromAngles(aimYaw, aimPitch);
  const dx = shot.end[0] - shot.o[0], dy = shot.end[1] - shot.o[1], dz = shot.end[2] - shot.o[2];
  const len = Math.hypot(dx, dy, dz);
  const dot = (dx * want[0] + dy * want[1] + dz * want[2]) / len;
  const angErr = Math.acos(Math.min(1, dot)) * 180 / Math.PI;
  assert.ok(angErr < 0.2, `echoed ray off by ${angErr.toFixed(3)} deg`);
  assert.strictEqual(shot.hit, B.pid, 'first body shot must hit B');
  assert.strictEqual(shot.part, 'body');
  await sleep(300);
  assert.strictEqual(B.you.hp, 40, `B hp should be 40, got ${B.you.hp}`);
  console.log(`body shot OK — ray err ${angErr.toFixed(3)} deg, B at 40 hp`);
}

// ---------- 6. second body shot -> kill ----------
{
  await sleep(1700);                               // bolt cycle
  const b = A.players.get(B.pid);
  await scopedShotAt(A, b.x, b.y + 0.9, b.z);
  const kill = await A.waitEvent((ev) => ev.e === 'kill' && ev.victim === B.pid, 2000, 'kill event');
  assert.strictEqual(kill.by, A.pid);
  assert.ok(kill.killerHp === 100, 'killerHp rides the kill event');
  console.log('kill OK — two body shots dropped B');
}

// ---------- 7. respawn stability + headshot one-shot ----------
{
  const spawnEv = await B.waitEvent((ev) => ev.e === 'spawn' && ev.who === B.pid && ev.id > 5, 6000, 'B respawn');
  // First 10 post-respawn snapshots: B (sending neutral inputs) must not drift.
  const positions = [];
  const snaps0 = B.snaps;
  while (B.snaps < snaps0 + 10) { await sleep(15); positions.push({ x: B.you.x, y: B.you.y, z: B.you.z }); }
  for (const p of positions.slice(2)) {
    assert.ok(Math.hypot(p.x - spawnEv.x, p.z - spawnEv.z) < 0.05,
      `B drifted post-respawn: ${JSON.stringify(p)} vs spawn ${spawnEv.x},${spawnEv.z}`);
  }
  await sleep(3200);                               // let spawn protection lapse (2500 ms)
  const b = A.players.get(B.pid);
  const { shot } = await scopedShotAt(A, b.x, b.y + 1.62, b.z);
  assert.strictEqual(shot.part, 'head', 'head-center ray must be a HEADSHOT');
  const kill = await A.waitEvent((ev) => ev.e === 'kill' && ev.victim === B.pid && ev.part === 'head', 2000, 'headshot kill');
  assert.strictEqual(kill.by, A.pid);
  console.log('headshot OK — one-shot kill on the visible head, respawn stable');
}

// ---------- 8. fire-rate spam: 5 fires in 200 ms -> exactly 1 shot ----------
{
  await sleep(1700);                               // bolt from the headshot
  const marker = A.events.length;
  for (let i = 0; i < 5; i++) {
    A.pendingFire = { tt: A.serverTime() };
    A.keys = BTN.FIRE;
    await sleep(40);
  }
  A.keys = 0;
  await sleep(800);
  const shots = A.events.slice(marker).filter((ev) => ev.e === 'shot' && ev.by === A.pid);
  assert.strictEqual(shots.length, 1, `spam produced ${shots.length} shots, want exactly 1`);
  console.log('fire-rate gate OK — 5 spam fires -> 1 shot');
}

// ---------- 9. leaderboard shows A's kills + XP ----------
{
  const lb = await (await fetch(`${BASE}/api/leaderboard?limit=37`)).json();
  assert.strictEqual(lb.persistent, false);
  const row = lb.rows.find((r) => r.name === 'TestA');
  assert.ok(row, 'TestA must be on the leaderboard');
  assert.ok(row.kills >= 2, `TestA kills ${row && row.kills} < 2`);
  // kill1 body streak1 = 100; kill2 head streak2 = 100+50+25 = 175 -> 275 total
  assert.ok(row.xp >= 275, `TestA xp ${row && row.xp} too low`);
  const stats = await (await fetch(`${BASE}/api/stats/${idA.pid}`)).json();
  assert.ok(stats.kills >= 2 && stats.headshots >= 1, 'stats endpoint must show the headshot');
  console.log(`leaderboard OK — TestA ${row.kills} kills, ${row.xp} xp`);
}

// ---------- 10. REST hardening: 429 + 413 ----------
{
  // 413 first — the 21-request hammer below intentionally drains the API bucket.
  const big = await fetch(`${BASE}/api/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(5000) }),
  });
  assert.strictEqual(big.status, 413, `5 KB body -> ${big.status}, want 413`);
  const results = await Promise.all(Array.from({ length: 21 }, () => fetch(`${BASE}/api/leaderboard`)));
  assert.ok(results.some((r) => r.status === 429), 'no 429 after 21 rapid requests');
  console.log('REST hardening OK — 413 and 429 both enforced');
}

// ---------- 11. oversized ws frame -> connection dropped pre-parse ----------
{
  B.ws.send('x'.repeat(5000));
  await sleep(1500);
  assert.ok(B.closed, 'oversized frame must close the socket (maxPayload)');
  console.log('maxPayload OK — 5 KB frame dropped the socket');
}

A.stop(); B.stop();
server.kill('SIGTERM');
await sleep(300);
console.log('smoke.e2e OK — all assertions passed');
process.exit(0);
