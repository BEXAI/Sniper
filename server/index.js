// GLINT server boot: ONE process — HTTP static + REST + WebSocket upgrade on
// process.env.PORT, a 30 Hz drift-corrected tick loop with stall rebase, and a
// SIGTERM stats flush.
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { performance } from 'node:perf_hooks';
import { createStore } from './store/pgStore.js';
import { SEASON } from './store/statsStore.js';
import { RoomManager } from './game/rooms.js';
import { ConnectionHub } from './net/connection.js';
import { createApi } from './http/api.js';
import { TICK_MS, MAX_PAYLOAD } from '../shared/constants.js';

const PORT = Number(process.env.PORT) || 3000;
const bootAt = Date.now();

const store = await createStore();
const manager = new RoomManager(store);
const clock = () => performance.now();
const hub = new ConnectionHub(manager, store, clock);

// --- Tick loop health counters (rolling 60 s windows) ---
let tick = 0;
let lastTickMs = 0;
let overruns = 0, rebases = 0;
let overruns60s = 0, rebases60s = 0;
setInterval(() => { overruns60s = overruns; rebases60s = rebases; overruns = 0; rebases = 0; }, 60000).unref?.();

const statusProvider = () => ({
  ok: true,
  uptime: Math.round((Date.now() - bootAt) / 1000),
  tick,
  lastTickMs: Math.round(lastTickMs * 100) / 100,
  overruns60s,
  rebases60s,
  storeMode: store.mode,
  persistent: store.persistent,
  season: SEASON,
  rss: Math.round(process.memoryUsage.rss() / 1048576),
  rooms: manager.status(clock()),
});

const server = http.createServer(createApi({ store, manager, statusProvider }));

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws, req));
});

// --- Drift-corrected setTimeout loop with stall rebase (never setInterval) ---
let baseline = performance.now();
function loop() {
  tick++;
  const t0 = performance.now();
  try {
    manager.step(tick, t0);
  } catch (err) {
    // The single-process server must never die to a sim error mid-tick.
    console.error('[tick] error:', err);
  }
  lastTickMs = performance.now() - t0;
  if (lastTickMs > 3) overruns++;
  if (lastTickMs > 25) console.warn(`[tick] overrun ${lastTickMs.toFixed(1)}ms`);
  // Rebase after a long stall (GC pause, cgroup throttle): accept dropped ticks
  // rather than a catch-up sprint that burns the whole CPU quota.
  if (performance.now() - (baseline + tick * TICK_MS) > 250) {
    baseline = performance.now() - tick * TICK_MS;
    rebases++;
  }
  setTimeout(loop, Math.max(0, baseline + tick * TICK_MS - performance.now()));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`GLINT listening on ${PORT}`);
  const r0 = manager.rooms[0];
  console.log(`room ${r0.id} up, bot fill ${r0.botFill ? 'on' : 'off (TEST_MODE)'}`);
  loop();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${signal}] flushing stats and exiting`);
  try { await store.flush(); } catch { /* best effort */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
