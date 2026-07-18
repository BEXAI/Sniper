// 60 s soak in NORMAL mode (bots on) with a short match cycle: 4 wandering humans
// + bot fill, full lifecycle running twice, a half-open peer, and health metrics.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { BTN, TICK_MS } from '../shared/constants.js';

const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SoakClient {
  constructor(name) {
    this.name = name;
    this.snapTimes = [];
    this.acks = [];
    this.events = [];
    this.matchEnds = 0;
    this.nanSeen = false;
    this.seq = 0;
    this.keys = BTN.FWD;
    this.yaw = Math.random() * Math.PI * 2;
    this.pitch = 0;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      const to = setTimeout(() => reject(new Error(`${this.name}: welcome timeout`)), 5000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'hello', name: this.name })));
      this.ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === 'welcome') { this.pid = m.pid; clearTimeout(to); resolve(); }
        else if (m.type === 'snap') {
          this.snapTimes.push(performance.now());
          this.acks.push(m.ack);
          const scan = (o) => {
            for (const v of Object.values(o)) {
              if (typeof v === 'number' && !Number.isFinite(v)) this.nanSeen = true;
              else if (v && typeof v === 'object') scan(v);
            }
          };
          scan(m);
          for (const ev of m.d.events) this.events.push(ev);
        } else if (m.type === 'matchEnd') { this.matchEnds++; this.lastMatchEnd = m; }
        else if (m.type === 'error') { this.serverError = m; }
      });
      this.ws.on('close', (code, reason) => {
        if (this.stopping) return;   // our own teardown close, not a disconnect
        this.closed = true;
        this.closeInfo = `code=${code} reason=${reason} at=${performance.now().toFixed(0)}ms err=${JSON.stringify(this.serverError || null)}`;
      });
      this.ws.on('error', () => {});
      this.loop = setInterval(() => {
        if (this.ws.readyState !== 1) return;
        this.ws.send(JSON.stringify({ type: 'input', seq: ++this.seq, b: this.keys, yaw: this.yaw, pitch: this.pitch }));
      }, TICK_MS);
      this.wander = setInterval(() => {
        this.yaw = Math.random() * Math.PI * 2;
        this.keys = BTN.FWD | (Math.random() < 0.2 ? BTN.JUMP : 0) | (Math.random() < 0.15 ? BTN.SCOPE : 0);
      }, 2000);
      this.pinger = setInterval(() => {
        if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping', cn: performance.now() }));
      }, 2000);
    });
  }

  stop() { this.stopping = true; clearInterval(this.loop); clearInterval(this.wander); clearInterval(this.pinger); try { this.ws.close(); } catch { /* gone */ } }
}

// Fail fast if a stale server already holds the port: the health poll below would
// come back ok:true from the WRONG server/config and soak it for 60 s.
try {
  await fetch(`${BASE}/api/status`);
  console.error(`port ${PORT} already in use — kill the stale server`);
  process.exit(1);
} catch { /* nothing listening — good */ }

const server = spawn('node', ['server/index.js'], {
  env: {
    ...process.env, PORT: String(PORT), MATCH_MS: '20000', INTERMISSION_MS: '5000',
    SERVER_SECRET: 'soak-secret', DATABASE_URL: '', TEST_MODE: '',
    // 4 clients + the half-open peer all arrive from 127.0.0.1 — must clear the
    // per-IP socket cap and the 5/min join limit.
    MAX_SOCKETS_PER_IP: '8', JOIN_RATE_PER_MIN: '60',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
let shuttingDown = false;
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const fail = (msg) => { console.error(msg); console.error('--- server log ---\n' + serverLog.slice(-4000)); server.kill(); process.exit(1); };
// A child that dies (e.g. EADDRINUSE) must abort the run, not soak a ghost.
server.on('exit', (code) => { if (!shuttingDown) fail(`server died: code=${code}`); });
process.on('uncaughtException', (e) => fail(`UNCAUGHT: ${e.stack}`));

for (let i = 0; ; i++) {
  await sleep(300);
  try { if ((await (await fetch(`${BASE}/api/status`)).json()).ok) break; } catch { /* booting */ }
  if (i > 30) fail('server never became healthy');
}

const clients = [new SoakClient('SoakA'), new SoakClient('SoakB'), new SoakClient('SoakC'), new SoakClient('SoakD')];
for (const c of clients) await c.connect();
const humanPids = new Set(clients.map((c) => c.pid));

// Half-open peer: hellos, then goes completely silent — liveness must reap it.
const halfOpen = new WebSocket(`ws://127.0.0.1:${PORT}`);
let halfOpenPid = null, halfOpenClosedAt = 0;
const halfOpenStart = performance.now();
halfOpen.on('open', () => halfOpen.send(JSON.stringify({ type: 'hello', name: 'Silent' })));
halfOpen.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'welcome') halfOpenPid = m.pid;
});
halfOpen.on('close', () => { halfOpenClosedAt = performance.now(); });
halfOpen.on('error', () => {});

const phases = new Set();
const statusPoll = setInterval(async () => {
  try {
    const st = await (await fetch(`${BASE}/api/status`)).json();
    phases.add(st.rooms[0].phase);
    lastStatus = st;
  } catch { /* transient */ }
}, 1500);
let lastStatus = null;

console.log('soaking 60 s…');
await sleep(60000);
clearInterval(statusPoll);
for (const c of clients) c.stop();

// ---------- assertions ----------
const st = await (await fetch(`${BASE}/api/status`)).json();

for (const c of clients) {
  assert.ok(!c.closed, `${c.name} was disconnected during the soak (${c.closeInfo})`);
  assert.ok(!c.nanSeen, `${c.name} saw NaN in a snapshot`);
  const gaps = c.snapTimes.slice(1).map((t, i) => t - c.snapTimes[i]).sort((a, b) => a - b);
  const p95 = gaps[Math.floor(gaps.length * 0.95)];
  assert.ok(p95 < 60, `${c.name} snapshot p95 gap ${p95.toFixed(1)} ms >= 60`);
  for (let i = 1; i < c.acks.length; i++) {
    assert.ok(c.acks[i] >= c.acks[i - 1], `${c.name} ack regressed at ${i}`);
  }
  assert.ok(c.matchEnds >= 1, `${c.name} received no matchEnd`);
  assert.ok(c.lastMatchEnd.scoreboard.length >= 6, `${c.name} matchEnd scoreboard too small`);
}

// Bot activity: at least one kill BY a bot (any killer outside our human pids).
const allEvents = clients[0].events;
const botKills = allEvents.filter((ev) => ev.e === 'kill' && !humanPids.has(ev.by));
assert.ok(botKills.length >= 1, 'no bot kills in 60 s');

// Lifecycle: both phases observed, and a second LIVE round started.
assert.ok(phases.has('LIVE') && phases.has('INTERMISSION'), `phases seen: ${[...phases]}`);
const liveEvents = allEvents.filter((ev) => ev.e === 'match' && ev.state === 'LIVE');
assert.ok(liveEvents.length >= 1, 'no second LIVE round started');

// K/D reset: the first score row after a round start must be (nearly) all zeros.
const liveId = liveEvents[0].id;
const scoreAfter = allEvents.find((ev) => ev.e === 'score' && ev.id > liveId);
assert.ok(scoreAfter, 'no score row after round start');
const totalK = scoreAfter.rows.reduce((s, r) => s + r[1], 0);
assert.ok(totalK <= 2, `kills not reset at round start: ${totalK}`);

// Half-open peer reaped within 15 s, with a leave broadcast.
assert.ok(halfOpenPid, 'half-open peer never joined (no welcome)');
assert.ok(halfOpenClosedAt > 0, 'half-open peer never terminated');
assert.ok(halfOpenClosedAt - halfOpenStart < 15000, `half-open reaped in ${((halfOpenClosedAt - halfOpenStart) / 1000).toFixed(1)} s`);
assert.ok(allEvents.some((ev) => ev.e === 'leave' && ev.who === halfOpenPid), 'no leave broadcast for the half-open peer');

// Health: stuck bots, memory, tick overruns.
assert.ok(st.rooms[0].botStuck < 3, `bot stuck events: ${st.rooms[0].botStuck}`);
assert.ok(st.rss < 200, `RSS ${st.rss} MB >= 200`);
assert.ok(st.overruns60s < 10, `tick overruns: ${st.overruns60s}`);

shuttingDown = true;
server.kill('SIGTERM');
await sleep(300);
console.log(`soak OK — p95 cadence fine, ${botKills.length} bot kills, lifecycle x${clients[0].matchEnds}, half-open reaped, rss ${st.rss} MB, overruns ${st.overruns60s}`);
process.exit(0);
