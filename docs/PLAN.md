# GLINT — Unified Final Implementation Plan
## Full-Stack Browser Sniper PvP (Node.js + ws + Three.js, Render free tier)

**This is the executable plan of record.** Backbone: the netcode-excellence design (winner). Grafted: judge-endorsed ideas from the other two designs. Every open question is resolved inline — an agent team executes this verbatim with zero further choices. Game name: **GLINT**.

**Stack (fixed, no deviation):** Node.js ≥ 20 + `ws`, Three.js client, plain ES modules, **no build step**, ONE web service serving static client + REST + WebSocket upgrade on `process.env.PORT`. Runtime deps: `ws` (+ `pg` lazily imported only when `DATABASE_URL` is set). No Express, no bundler, no Docker.

---

## 0. The Ordering Law (binding directive for all agents)

Within every milestone, **build strictly top-down in the listed order and cut strictly bottom-up from the milestone's cut line — never from the top.** Every milestone below also lists what it **explicitly ships WITHOUT**, so no agent gold-plates early. Two things are globally untouchable at any scope pressure:

1. **The lag-compensated hit pipeline (§1.6) and its test.** In a one-shot-kill game, hit registration IS the fun. It is never cut, never downgraded to "raycast current positions."
2. **Bots sharing the human code path (§5.1).** "Fun at zero humans" is a hard constraint of the brief.

---

## 1. Architecture Overview

### 1.1 Process model

ONE Node.js process (`node server/index.js`, `"type":"module"`). Inside it:

- **HTTP server** (`node:http`): serves `/public/*` and `/shared/*` as static files with correct `Content-Type: text/javascript` for `.js` (the client imports the shared sim modules directly — the keystone of prediction), plus REST under `/api/*`. Static serving is path-traversal-hardened per §3.1.
- **WebSocket server** (`ws`, `new WebSocketServer({noServer: true, maxPayload: 4096})`, attached to the HTTP server's `upgrade` event — one port). Oversized frames are rejected by `maxPayload` before parse; every `JSON.parse` of an inbound frame is wrapped in try/catch → parse failure counts as a violation (§2). The single-process server must never die to a malformed frame.
- **RoomManager** (graft from Design 0): array of `Room` simulations. **Room #0 is created at boot, is never destroyed, and is always bot-filled to 6** — `/api/status` always shows a live match and a player is never turned away. Quick-join picks the room with the **MOST humans** that has a free slot (players cluster together); if all are full, a new room spins up (**max 2 rooms** on 0.1 CPU — the CPU budget in §1.2 does not support more; beyond that, `error {code:"FULL"}`). Overflow rooms with 0 humans for 60 s are destroyed; **any spectators attached to a destroyed overflow room are migrated to room #0 with a fresh `welcome`** (room #0 is never destroyed, so migration always succeeds).
- **Test hook (binding):** env var `TEST_MODE=1` (set only by `smoke.e2e.js` when it spawns the server) (a) disables bot fill in room #0, (b) pins spawn selection to two fixed, mutually-visible spawn points with a ≥ 15 m unobstructed forward lane between them, (c) zeroes bot reaction randomness. `soak.js` runs the normal (non-TEST_MODE) path.
- **StatsStore** (memory default, Postgres adapter behind `DATABASE_URL` — §3.3).

### 1.2 Tick model — the numbers (all in `shared/constants.js`)

| Constant | Value | Why |
|---|---|---|
| `TICK_RATE` | **30 Hz** (`TICK_MS = 1000/30`) | Fits 0.1-CPU budget |
| CPU budget/tick | **≤ 3 ms worst case** | 0.1 CPU = ~100 ms CPU per wall-second → ~3.3 ms per 33 ms tick. This is the real cgroup quota; it is why `MAX_ROOMS = 2` |
| Snapshot rate | **30 Hz** (every tick) | Max freshness for interpolation; ~10 entities ≈ 800 B payloads |
| Client input rate | **30 Hz** | Client runs the identical fixed timestep |
| `INTERP_DELAY` | **100 ms** (3 snapshot intervals) | Survives 2 lost/late snapshots before extrapolating |
| Lag-comp history | **30 entries/player = 1000 ms ring** | Rewind clamped to 250 ms; 1 s is cheap insurance |
| Prediction input ring | **128 inputs ≈ 4.2 s** | Covers pathological RTT without wrap |
| `MAX_REWIND` | **250 ms** | Bounds "shot behind cover" pain and the cheat window |
| `MATCH_MS` / `INTERMISSION_MS` | **300000 / 15000, read from env** | Defaults for play; tests shrink them to exercise the full match lifecycle (§8) |

**Server loop — drift-corrected `setTimeout` with stall rebase, never `setInterval`:**

```js
let baseline = performance.now(); let tick = 0;
function loop() {
  tick++;
  const t0 = performance.now();
  for (const room of rooms) room.step(tick);
  const elapsed = performance.now() - t0;
  if (elapsed > 3) overruns++;                       // budget breach counter → /api/status
  if (elapsed > 25) log.warn(`tick overrun ${elapsed}ms`);
  // Rebase after a long stall (GC pause, cgroup throttle): accept dropped ticks rather
  // than a permanent back-to-back catch-up sprint that burns the whole CPU quota.
  if (performance.now() - (baseline + tick * TICK_MS) > 250) {
    baseline = performance.now() - tick * TICK_MS; rebases++;
  }
  setTimeout(loop, Math.max(0, baseline + tick * TICK_MS - performance.now()));
}
```

**All wall-clock game timing (match clock, intermission, bolt/reload/spawn timers) is keyed to `performance.now()`, never to tick count** — dropped ticks may occur after a rebase and must not skew match length. `overruns` and `rebases` (60 s windows) are surfaced in `/api/status` as the sustained-throttle detector.

**Per tick, in order (`room.step`):**
1. Drain each player's network input queue with **input-debt accounting** (binding — this is what makes jitter invisible):
   - **Queue empty (late packet):** re-apply ONLY the persistent movement portion of the last received input — movement/scope/breath bits + yaw/pitch. **Fire, reload, and jump edges are STRIPPED and never replayed.** Do NOT advance the ack. Increment `guessedSteps`. After **1 s of continuous starvation**, substitute a fully neutral input (no buttons held) instead — a lagged-out player stops, they don't run into a wall or turn into a turret. After **60 s with no real input**, mark AFK, remove the entity via the normal disconnect path (slot freed for bot fill).
   - **Queue non-empty:** process up to **2** inputs (normally 1; 2 allows catch-up). For each processed input: advance `lastAckSeq` and resolve any attached fire/reload edge — but **while `guessedSteps > 0`, decrement it and SKIP `movement.step` for that input** (the guessed step already consumed that tick's movement). Otherwise run movement normally. Net effect: total stepped ticks always equal elapsed ticks, effective speed can never exceed 6.0 m/s from jitter, reconciliation converges instead of snapping, and fires are never lost or duplicated.
   - Hard cap ≤ 35 inputs/s averaged over 3 s (violation-counted). Dead tabs are handled by the §2 liveness timeout, not this cap.
2. Bots whose slot matches `tick % 6` think (5 Hz staggered, §5) and push an Input object into the same queue humans fill.
3. Apply each processed input through `shared/movement.step()` (byte-identical module the client runs).
4. Resolve fire commands (lag-compensated raycast §1.6), apply damage/deaths/respawn timers/match clock.
5. Record lag-comp history entry per player: `{tick, x, y, z, yaw, pitch}` into the 30-slot ring.
6. Build ONE snapshot: serialize the shared portion once; per client, splice in the two personalized fields via string concatenation (the main CPU trick for 0.1 CPU):
   ```js
   const shared = JSON.stringify({t: serverNow, tick, players, events});
   for (const c of clients) {
     if (c.ws.bufferedAmount > 262144) { terminate(c); continue; }   // backpressure guard, §2
     c.ws.send(`{"type":"snap","ack":${c.lastAckSeq},"you":${JSON.stringify(c.selfState)},"d":${shared}}`);
   }
   ```
   **Spectators have `selfState = null` (never `undefined`)** so the spliced frame is always valid JSON; the client treats `you === null` as observer mode (§4.9). **Mitigation for the hand-rolled-JSON risk:** `test/protocol.test.js` constructs frames — including a spectator frame — via this exact code path and asserts `JSON.parse` round-trips them (§8).

**Movement model (decision-complete, in `shared/movement.js`):** horizontal velocity is set directly each step to `wishdir × speed` — 6.0 m/s unscoped, 2.5 m/s scoped, ×0.8 airborne; gravity 20 m/s²; jump impulse 5.0 m/s (grounded only); per-axis AABB move-and-slide against the map box list with **step-up ≤ 0.45 m**; position clamped to the arena AABB. **There is NO player-vs-player collision (decided — cheapest and prediction-safe; two capsules may overlap).** Compensations: spawn scoring rejects any spawn point with a player within 2 m (§4.5), and bot ENGAGE node selection skips nodes currently occupied by another bot (§5.2). Deliberately trivial so prediction almost never mispredicts, yet fully stateful (vertical velocity, grounded flag, lastLandTime for sway).

**State to clients: full snapshots, not deltas.** ≤ 10 entities × ~60 B (positions quantized to cm, angles to 0.001 rad) ≈ 800 B × 30 Hz ≈ 24 KB/s/client — trivial. Deltas add baseline/ack machinery and desync surface for zero benefit at this scale. Events (shots, kills, spawns, joins, leaves, score rows) ride inside the snapshot `events` array — TCP ordering makes this reliable with no extra machinery. **Do not build deltas or binary encoding.**

### 1.3 Clock synchronization (min-RTT filtering)

Client maintains `serverTime() = performance.now() + bestOffset`.
- On connect: 5 pings at 200 ms intervals; thereafter 1 ping every 2000 ms.
- `ping {cn}` → `pong {cn, st}`. On pong: `rtt = now − cn`; `sampleOffset = st + rtt/2 − now`. Keep the last **10** `{rtt, offset}` samples in a ring; `bestOffset` = the offset from the **minimum-RTT** sample (min-RTT filtering rejects jitter-inflated samples — do NOT average or EMA). If `bestOffset` jumps > 50 ms, **slew** toward it at 5 ms per frame instead of snapping (prevents interpolation pops).

### 1.4 Client-side prediction + reconciliation (own movement)

Fixed-timestep accumulator at exactly the server rate:

```js
acc = Math.min(acc + frameDt, 0.25);           // HARD CLAMP: max 250 ms of banked time, excess discarded
while (acc >= TICK_MS/1000) {
  acc -= TICK_MS/1000;
  const input = sampleInput(seq++);            // keys latched since last tick; fire edge-latched
  predicted = movement.step(predicted, input, 1/30, map);   // SAME shared module as server
  ring[seq & 127] = {seq, input, state: clone(predicted)};
  net.send(input);
}
```

- **Background-tab handling (binding — rAF suspends in hidden tabs and un-clamped accumulators get players kicked):** the clamp above means a returning tab can never burst more than ~8 inputs. Additionally, on `document.visibilitychange → hidden`: send one neutral "all keys released" input and stop the accumulator; on `→ visible`: reset `acc = 0`, trigger a fresh clock-sync ping burst, and resume — the next snapshot + rollback re-anchors the player. Manual check in §8: alt-tab 30 s mid-match, return, no kick, clean snap.
- View angles apply to the camera **every render frame instantly** (mouse look never waits on the 30 Hz sim); the per-tick input snapshots the angles at sample time. Render position lerps between previous/current predicted states by `acc/(TICK_MS/1000)`.
- **Reconciliation** per snapshot: read `ack` + `you`. Compare `you` vs `ring[ack & 127].state`. If `|posError| > 0.015 m` or `|velError| > 0.1 m/s`: set `predicted = you`, then **replay** every stored input with `seq > ack` (rollback-and-replay; typical depth 2–6 steps — microseconds).
- **Death/respawn boundary (binding — prevents the classic respawn rubber-band):** while `you.state !== "ALIVE"`, the client stops stepping prediction and stops latching movement (it still sends neutral inputs at 30 Hz for liveness). On its own `spawn` event / `you.state` transition to ALIVE: hard-set `predicted = you`, **clear the entire input ring**, and continue `seq` monotonically. Stale pre-death inputs are never replayed against a new spawn position; bolt/breath/scoped state never carries across lives.
- **Visual smoothing:** on rollback, `renderErrorOffset = oldRenderPos − newPredictedPos`, decayed with **50 ms half-life** (`offset *= 0.5 ** (frameDt/0.05)`), added to render position only. The sim is always exact; only the eye is smoothed.
- Non-positional predicted state (scoped flag, scoped-start time, breath meter, ammo, bolt timer) lives in the same state object and reconciles identically.

### 1.5 Snapshot interpolation (remote players)

- Keep the last 1000 ms of snapshots sorted (~32 entries). Every render frame: `renderTime = serverTime() − 100 ms`; find bracketing snapshots A, B; lerp positions, shortest-arc lerp yaw/pitch; boolean flags (scoped) from A.
- **Starvation:** extrapolate from the last two snapshots' velocity, **capped at 100 ms**, clamped against map AABBs (never through walls), then freeze.
- On a `spawn` event, purge that player's older interp entries so they don't lerp across the map.

### 1.6 Lag-compensated hit validation (server — the load-bearing wall, NEVER cut)

1. Fire arrives inside an input: `fire: {tt}` where `tt` = the client's `renderTime` at trigger pull (`serverTime() − INTERP_DELAY`, in server-clock ms) — the one client-supplied timestamp in the protocol.
2. Validate/clamp: `serverNow − 250 ≤ tt ≤ serverNow` (clamp, don't reject — graceful for high ping, bounded for cheaters).
3. **Rewind:** for each potential victim, find the two lag-comp ring entries straddling `tt` and **lerp** position/yaw (never nearest-pose). The SHOOTER is never rewound — the ray originates from the shooter's **current server-authoritative eye position** (`pos + [0, 1.62, 0]`); any client-claimed origin is ignored.
4. **Ray direction** = shooter's input yaw/pitch **+ server-computed deterministic sway offset (§4.4)** **+ server-rolled spread**: unscoped 4.0° cone; **quickscope cone lerping 1.5° → 0° over the first 250 ms of being scoped** (graft — forces real scope commitment and the glint exposure that comes with it); fully settled scope = sway only. **Sway timestamp is bound (binding — the WYSIWYG promise hangs on it):** the server evaluates `swayOffsetDeg` at the **clamped client fire time `tt`** — the same instant the client rendered its reticle — never at the processing tick; the sway *state* inputs (breath, movingScoped, msSinceLanding) are read from the shooter's server state at the processing tick. Client-side, the reticle wander is drawn from the same clock the fire `tt` is stamped with, so `smoke.e2e.js` can compute the expected ray from its own `tt`. All rolls use the seeded RNG in `shared/math.js` so tests can reproduce them.
5. Cast in order: (a) ray vs map AABBs (slab method, nearest wall `t`); (b) **head sphere FIRST, with priority** — r = 0.22 m centered at rewound pos + 1.62 m: if the ray intersects the head sphere with `t_head < wallT`, it is a **headshot regardless of any body-capsule intersection**; (c) only if the head misses, test the **body capsule** — r = 0.4 m, **segment +0.4 → +1.3 m** (shortened so the head physically protrudes above the shoulders; the visual rig in §4.2 matches exactly). Among multiple victims, the nearest qualifying hit wins. **Head = 150 dmg (one-shot on 100 HP). Body = 60 (two-shot). No damage falloff. NO health regen** (regen quietly rewards nest-sitters who duck and reset — explicitly rejected). Head-first ordering is asserted by `lagcomp.test.js` and `smoke.e2e.js` (`part === "head"` on a ray aimed at the head center — §8).
6. Server-side gating regardless of client claims: bolt cycle **1500 ms** (50 ms tolerance), magazine 5, reload **2500 ms**, alive, not spawn-protected. Violations silently dropped and counted.
7. **The server echoes the ACTUAL fired ray (post-sway, post-spread) in the shot event** (graft): `{e:'shot', id, by, o:[…], end:[…], hit, part}`. Every client — including the shooter — renders tracer/hitmarker/killfeed from this authoritative event. Hip-spread is honest on screen, and the smoke test gets a precise assertion target. The client predicts only muzzle flash, recoil kick, and its own shot sound.

### 1.7 Hitscan vs projectile — decided: HITSCAN

At map scale (max sightline ~170 m) a real 850 m/s round arrives in < 0.2 s — sub-perceptual. Projectiles cannot be lag-compensated without teleporting bullets, so high-ping players would be structurally punished at leading. Hitscan + lag comp means a scoped flick on a strafing target registers exactly where the crosshair was — the entire product thesis. The tracer visually "travels" at 400 m/s so shots still read as bullets. Camping counterplay lost from travel-time telegraphing is restored via glint/tracers/pings/audio (§4.6). **Decided; do not revisit.**

---

## 2. WebSocket Protocol

JSON text frames. Server enforces: max frame 4 KB **via `maxPayload: 4096`** (rejected pre-parse), max 80 msgs/s per socket, malformed JSON (try/catch around parse) → violation, unknown `type` → violation, 20 violations → close 4008. Input validation before enqueue: `seq` strictly increasing and ≤ lastSeq + 64; `b` integer in [0, 511]; `yaw` finite, normalized (−π, π]; `pitch` finite, clamped ±1.55 rad; `fire.tt` finite.

**Connection lifecycle rules (binding, all in `connection.js`, all routed through ONE disconnect path — entity removal + `leave` event + stats flush — so cleanup is single-sourced):**
- **Liveness:** record `lastInboundAt` per socket; no inbound message (input or ping) for **> 10 s** → `ws.terminate()` (not `close()` — half-open peers never ACK a close). Safe: live clients send 30 inputs/s and ping every 2 s.
- **Hello timeout:** a socket that completes upgrade but sends no `hello` within **5 s** → close 4008.
- **Backpressure:** before each snapshot send, `ws.bufferedAmount > 256 KB` → terminate (§1.2 step 6).
- **Duplicate pid — newest wins:** a valid `pid+token` hello **terminates the old socket** and takes over the identity. Token possession proves it's the same person; this is the refresh-after-a-blip path. (Token-invalid hellos still downgrade to anonymous.)
- **Connection caps:** max **4 sockets per IP**, max **64 total sockets**, max **4 spectators per room** — beyond any cap, `error {code:"FULL"}` + close. All caps in `shared/constants.js`.
- **Name re-validation:** `connection.js` applies the **exact `/api/guest` validator** to `hello.name` (charset, length, profanity, reserved bot names); invalid → `error {code:"NAME_INVALID"}` + close. A modified client can never inject markup or impersonate "Vex" via hello.

### Client → Server

```jsonc
// First message. pid+token from POST /api/guest (or omitted → anonymous "Guest-1234").
// spectate:true → no-combat free-camera observer (§4.9); not counted as a human for bot fill.
{"type":"hello","pid":"a3f9c2d1e8b74a01","token":"a3f9c2d1e8b74a01.9f2ec41ab377d05512aa8c04","name":"Nate","spectate":false}

// One per client sim tick (30/s). buttons bitmask:
// 1 fwd, 2 back, 4 left, 8 right, 16 jump, 32 scope, 64 fire, 128 breath, 256 reload
{"type":"input","seq":1042,"b":33,"yaw":1.5708,"pitch":-0.0873}

// Trigger latched this tick — fire.tt = client renderTime (server-clock ms) at trigger pull
{"type":"input","seq":1043,"b":96,"yaw":1.5714,"pitch":-0.0871,"fire":{"tt":183422.6}}

{"type":"ping","cn":52341.2}
```

### Server → Client

```jsonc
// On accepted hello. NO bot flags anywhere on the wire (graft: full bot camouflage —
// bot counts are disclosed only via /api/status). rank = XP rank tier int (§3.3).
// Roster entries carry LIVE k/d/streak/ping so a mid-match joiner's scoreboard is
// correct immediately (bots get synthetic pings). When match.state is INTERMISSION,
// match also carries nextIn (ms) so the joiner sees the countdown, not a dead world.
{"type":"welcome","pid":"a3f9...","tick":48211,"t":160703.4,"tickRate":30,"interpDelay":100,
 "mapVersion":1,"room":"r0","match":{"state":"LIVE","endsAt":403000},
 "you":{"rank":2,"xp":3450},
 "roster":[{"id":"a3f9...","name":"Nate","rank":2,"k":0,"d":0,"streak":0,"ping":42},
           {"id":"b1","name":"Vex","rank":3,"k":5,"d":2,"streak":3,"ping":51}]}

// 30 Hz. ack + you are per-client; d is the shared string. Spectators receive you:null.
{"type":"snap","ack":1043,
 "you":{"x":12.41,"y":0,"z":-33.2,"vx":0,"vy":0,"vz":-6,"hp":100,"ammo":4,
        "breath":0.82,"scopedMs":410,"bolt":0,"landMs":9999,"state":"ALIVE"},
 "d":{"t":160736.7,"tick":48212,
      "players":[{"id":"b1","x":-40.11,"y":6,"z":10.55,"yaw":2.31,"pitch":-0.05,
                  "hp":100,"sc":1,"st":"ALIVE"}],
      "events":[
        {"e":"shot","id":901,"by":"b1","o":[-40.1,7.62,10.6],"end":[12.4,1.5,-33.1],
         "hit":"a3f9...","part":"body"},                       // o/end = ACTUAL post-sway ray
        {"e":"kill","id":902,"shotId":901,"by":"b1","victim":"c7...","part":"head",
         "dist":141.3,"streak":3,"killerHp":40},               // killerHp powers "Vex — 40 HP"
        {"e":"spawn","id":903,"who":"c7...","x":80,"y":0,"z":-50,"swaySeed":812371},
        {"e":"join","id":904,"who":"d2...","name":"Ana","rank":1},   // bots join/leave via these too
        {"e":"leave","id":905,"who":"d2..."},
        {"e":"score","rows":[["a3f9...",3,1,2,42],["b1",5,2,3,51]]}]}} // 1 Hz: [id,k,d,streak,ping]
                                                               // — the live scoreboard/ping source

{"type":"pong","cn":52341.2,"st":160710.9}

// 5-min rounds, 15 s intermission. you.xpItems = XP breakdown; rankUp when crossed.
{"type":"matchEnd","scoreboard":[{"id":"a3f9...","n":"Nate","rank":2,"k":11,"d":4,"hs":6,"ping":42}],
 "you":{"k":11,"place":1,"xpGain":1550,"xpItems":[["kills",1100],["headshots",300],["place",300]],
        "rankUp":{"from":"Marksman","to":"Sharpshooter"}},
 "nextIn":15000}

{"type":"error","code":"NAME_INVALID","msg":"..."}   // fatal codes → close. Codes: NAME_INVALID, FULL, RATE, PROTO
```

Notes: `events` ids are monotonic (killfeed keys, deterministic debugging). The **`score` event at 1 Hz** is the sole live source for hold-Tab scoreboard K/D/streak/ping — snapshots stay lean, mid-match joiners are seeded by the roster, bots ride the same rows with synthetic pings (constant 30–70 ms per bot ± 5 jitter). `swaySeed` per life rides the spawn event. **No chat** (moderation liability, zero sniper value — cut permanently).

---

## 3. Backend

### 3.1 HTTP routes

| Route | Method | Behavior |
|---|---|---|
| `/` + static | GET | Serve `/public/*` and `/shared/*` (correct JS MIME type). **Traversal defense (binding):** `decodeURIComponent` → `path.normalize` → `path.resolve` against the allowed root → require `resolved.startsWith(rootDir + path.sep)` else 404; additionally 404 any path segment starting with `.`. `protocol.test.js` asserts `GET /public/../package.json` and `/shared/%2e%2e/%2e%2e/server/index.js` both 404. |
| `/api/guest` | POST `{name}` (or `{pid, token, name}` to rename) | Validate name (1–16 chars, `[A-Za-z0-9_\- ]`, trimmed, 24-word profanity denylist, **the 24 bot names rejected as reserved**). Mint `pid` = 16 hex (crypto.randomBytes) and **`token = pid + "." + HMAC-SHA256(pid, SERVER_SECRET).hex.slice(0,24)`** (graft: stateless verification — identity survives a stats-store wipe; no secrets stored). Rename updates the StatsStore row's display name (last-write-wins) and the live entity's name via a roster refresh. Return `{pid, token, name}`. Client stores in localStorage. Rate limit 5/min/IP. |
| `/api/leaderboard?by=xp&limit=50` | GET | `{"persistent":false,"season":"boot-2026-07-18T12:00Z","rows":[{rank,name,rankName,xp,kills,deaths,headshots,bestStreak,longestKill,matches}]}`. `by ∈ xp\|kills` (default xp). Humans only. Response JSON is **cached and rebuilt at most every 5 s** (a store scan must never ride the hot path per request). |
| `/api/stats/:pid` | GET | One player's row + rank progress, or 404. |
| `/api/status` | GET | `{ok:true, uptime, tick, lastTickMs, overruns60s, rebases60s, storeMode:"memory"\|"postgres", persistent:false, season, rooms:[{id, humans, bots, spectators, phase, endsIn}]}` — the honest bot disclosure, the Render health check, the throttle detector, and the soak probe. |

**Global REST hardening (binding):** per-IP token bucket across ALL `/api/*` routes — 20 requests / 10 s → 429 (in addition to the 5/min `/api/guest` limit). POST bodies capped at **4 KB** (beyond: destroy socket + 413); `Content-Type: application/json` required on POST. `smoke.e2e.js` asserts the 429 and 413 paths.

### 3.2 Identity model

Guest-token accounts, passwordless. `hello` presents `pid + token`; server recomputes the HMAC and compares via **`crypto.timingSafeEqual` on equal-length Buffers (length-check first, reject on mismatch — never string `===`)**; valid → stats accrue to `pid` across sessions AND across store wipes; invalid/absent → anonymous guest (`Guest-NNNN`, session-only stats). `SERVER_SECRET` comes from env (render.yaml `generateValue: true`); if unset locally, generated at boot with a logged warning. **Duplicate concurrent `pid`: newest wins** — a valid `pid+token` hello terminates the prior socket and inherits the identity (§2); this is the refresh-after-network-blip path, and token possession proves it is the same person. This IS the lightweight persistent account the brief allows; email/password is an OWASP surface with negative fun-per-hour — cut permanently.

### 3.3 Stats storage + progression vs the ephemeral disk

**`StatsStore` interface** (`getPlayer`, `upsertPlayer`, `addDeltas`, `leaderboard`), two implementations picked at boot:

- **`MemoryStore` (default):** `Map<pid, row>`. **NOTHING is ever written to disk** — the filesystem is wiped on deploy/restart and a mid-write restart corrupts; a `/tmp` dump is a trap, not a feature. Instead the reset is *sold*: `/api/status` and `/api/leaderboard` report `persistent:false` and a `season` id (boot timestamp), and the client shows a **"Boot Season — resets when the server restarts. Everyone can be #1."** banner (graft — a requeue hook, not an apology).
- **`PgStore` (iff `DATABASE_URL` set):** lazily `import('pg')`. Schema auto-applied at boot:
  ```sql
  CREATE TABLE IF NOT EXISTS players (
    pid TEXT PRIMARY KEY, name TEXT NOT NULL,
    xp INT DEFAULT 0, kills INT DEFAULT 0, deaths INT DEFAULT 0, headshots INT DEFAULT 0,
    best_streak INT DEFAULT 0, longest_kill REAL DEFAULT 0, matches INT DEFAULT 0,
    shots_fired INT DEFAULT 0, shots_hit INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now());
  ```
  Write-behind: dirty rows flushed every 30 s, at match end, **and on SIGTERM** (graft — free-tier restarts lose at most seconds of data). Never in the hot tick path. Any pg error → log once, degrade to memory semantics; the game never dies because the DB did.
- **Persistence footnote (binding):** do NOT plan around Render's free Postgres — it **expires after ~30 days** (the developer has lived this with Origentic). The recommended `DATABASE_URL` is a free **Neon** or **Supabase** Postgres; the adapter accepts any URL. Persistence is a 1-env-var upgrade, never a launch dependency.

**XP / ranks (graft):** XP = **100/kill, +50 headshot, +25×(streak−1) per kill capped at +100, match placement +300/200/100** (top 3 humans). Rank thresholds: 0 Recruit → 1,000 Marksman → 3,000 Sharpshooter → 7,000 Veteran → 15,000 Ghost → 30,000 Phantom → 60,000 Legend (table in `shared/constants.js`). Rank chevron + name render in killfeed, scoreboard, leaderboard. Bots grant full XP but never appear on the leaderboard or in the store.

### 3.4 Match / lobby lifecycle

Per room: `LIVE` (`MATCH_MS`, default 300 s) → `INTERMISSION` (`INTERMISSION_MS`, default 15 s: `matchEnd` with scoreboard + XP breakdown; kills/deaths reset; everyone respawned; **rubber-band pass** §5.3) → `LIVE`. Both durations read from env in `shared/constants.js` so the soak can exercise the full lifecycle (§8). Humans join instantly mid-match (during INTERMISSION they see the countdown per §2/§4.1).

**Bot population (fully specified):** fill to `MIN_COMBATANTS = 6`; hard cap 10 combatants/room. **Refill:** checked every tick — when combatants < 6 (human left, bot evicted), schedule ONE bot join **3–8 s later** (randomized so it reads as a human joining), never instantaneous. **Eviction:** one bot despawns per human beyond 6 — at its next death, with a **20 s deadline** after which it despawns immediately via a normal `leave` event (a streaking Hard bot can't lock a human out of a full room). **Rubber-banding (§5.3) mutates the difficulty preset in place on an existing bot** — name, pid, rank chevron, and stats continuity unchanged, zero wire events (leave/join churn at every intermission would be the tell that breaks the camouflage). Bot join/leave uses normal `join`/`leave` events — indistinguishable from humans on the wire.

**Disconnect (single-sourced):** whether from ws `close`, the 10 s liveness terminate, the backpressure terminate, or AFK removal (§1.2), one shared path runs: entity removed next tick, `leave` broadcast, stats flushed.

### 3.5 Anti-cheat posture

**By construction:** speed/teleport (server integrates fixed-dt movement from inputs only — no client dt), fire rate/ammo (server timers), damage forging (server computes everything), wallshots (server LOS raycast), sway/spread removal (server-applied from server-owned state), fake ray origins (server-owned eye position). **By validation:** input flood caps, schema/range checks, seq monotonicity, `tt` clamping, join limit 5/min/IP, connection caps, liveness timeouts, name sanitization at BOTH `/api/guest` and `hello`. **Accepted, documented:** browser aimbots that move the real view (unsolvable client-side), snapshot wallhacks (interest management is a non-goal; glint deliberately leaks scoped positions anyway).

---

## 4. Client

### 4.1 Boot & flow

`public/index.html`: canvas + all HUD/menu DOM + `<script type="module" src="/js/main.js">`. `main.js` imports `./vendor/three.module.js` (**vendored** — agents download the pinned three.js module build once during M1 and commit it; no CDN, no import map needed).

**Touch devices:** on touch-primary devices (`matchMedia('(pointer: coarse)')` and no pointer lock), show a **"GLINT is desktop-only — watch a live match instead"** screen linking to `?spectate=1`, whose free camera accepts one-finger drag-to-look. No touch gameplay controls exist or are planned.

Flow: MENU (callsign input prefilled from localStorage → `POST /api/guest` on save; top-10 leaderboard fetch; Boot Season banner when `persistent:false`; sensitivity/volume sliders → localStorage; controls modal) → PLAY → Pointer Lock + AudioContext resume (one user gesture) → WS open → `hello` → game. If `welcome.match.state === "INTERMISSION"`, show the intermission countdown overlay (from `match.nextIn`) with a "next round in Ns" card, then spawn at LIVE. WS URL is always derived: `(location.protocol==='https:'?'wss://':'ws://') + location.host`.

**Connection lifecycle UX (binding — every disconnect path has a defined screen):**
- **Cold start (WS error/close BEFORE welcome):** "Waking the range…" overlay, retry with backoff 1→2→4→8 s up to 90 s.
- **Mid-game drop (WS close/error AFTER welcome)** — the most-hit path on Render free tier: freeze the sim, show a full-screen **"Connection lost — reconnecting…"** overlay, re-run the hello flow with stored pid/token on the same 1→2→4→8 s backoff. On the new `welcome`: **discard the entire prediction ring, interpolation buffer, clock-sync samples, and event-dedupe state** and treat it as a fresh mid-match join (which the server fully supports). Manual verification in §8: kill the server mid-duel, restart, tab recovers into the new match with no page reload.
- **Error map:** `FULL` → menu, "Server full — retrying in 10 s" with auto-retry; `RATE`/`PROTO` → menu, "Disconnected: too many messages"; `NAME_INVALID` → inline field error on the callsign input; invalid-token anonymous downgrade → persistent HUD chip **"Playing as Guest-NNNN — stats not saved."**

### 4.2 Scene & assets — 100% procedural, zero downloads beyond vendored three.js

- **Map:** built from the `shared/map.js` AABB list — one `BoxGeometry` per box, merged into ≤ 4 groups by material. 2–3 procedural 256² canvas textures (rock noise, concrete, metal). Ground 200×120 with canvas dirt/grid texture (distance judging). `FogExp2` density 0.008 dusty orange; hemisphere + one directional light; **no shadow maps** (blob-shadow disc under each player). Sky = inverted sphere with vertex-gradient dusk orange → deep blue.
- **Players:** `CapsuleGeometry(0.4, 0.9)` body (capsule segment +0.4 → +1.3 m) + `SphereGeometry(0.22)` head at 1.62 m — **exactly matching the server hitboxes in §1.6, with the head visibly proud of the shoulders** (a headshot target you can actually see) — + 3-box rifle, parented body-to-yaw / head+rifle-to-pitch. Deterministic hue from `hash(playerId)`. Canvas-sprite nametag, hidden beyond 60 m. Death: topple 90° for the death-cam duration, then hide.
- **First-person viewmodel:** rifle + hand boxes in a camera-space group, sin-bob by distance traveled, 8 cm recoil kick, hidden while scoped.

### 4.3 HUD (DOM overlay, never text-in-WebGL)

Health bar (red flash + 150 ms vignette on damage), ammo `4/5` + bolt-progress arc, breath meter (under crosshair, scoped only), crosshair (unscoped: wide brackets honestly showing the 4° bloom; hidden when scoped), scope overlay (DOM/CSS radial-gradient vignette + hairlines + mil-dots, fades in during last 40% of zoom), hitmarker (white ×, gold on headshot, 120 ms), killfeed (top-right, last 5, rank chevrons, `Vex ▸☠ [HS] Nate · 187 m`), streak toast, hold-Tab scoreboard (name, rank, K/D, streak, ping — **seeded from the welcome roster, kept live by the 1 Hz `score` event; there is no other data source**), compass strip with red fire-pings, directional damage wedge (700 ms), death screen (§4.5), match timer, ping display (own RTT from ping/pong; others from `score` rows), Boot Season banner in menu.

**XSS rule (binding, grep-able): no `innerHTML` with interpolated data — anywhere.** Every player-provided string in the DOM (killfeed, scoreboard, leaderboard, death cam nameplate, menu) is set via `textContent`/`createTextNode` only; the canvas nametag sprite is inherently safe. `protocol.test.js` asserts hellos with `<`, `"`, or 17 chars are rejected server-side as defense-in-depth.

**Name collisions:** duplicate names are allowed; whenever a name collides within the current view (scoreboard, killfeed window, leaderboard page), render it as `Name#ab` using the first 2 hex chars of the pid as discriminator.

### 4.4 Sniper mechanics (exact numbers; all in `shared/constants.js`)

- **Scope:** hold RMB. FOV lerps **75° → 20° over 220 ms** smoothstep. Move speed scoped **2.5 m/s**. Mouse sensitivity scales by **`tan(fov/2)/tan(75°/2)`** every frame — zoom-consistent flicks. **Scope auto-drops for 400 ms during the bolt cycle** (classic rhythm). Unscoped fire: 4.0° server cone — possible, never optimal. **Quickscope penalty (graft):** extra server-rolled cone lerping **1.5° → 0° over the first 250 ms scoped** — scope commitment (and its glint) is mandatory.
- **Sway — deterministic function of absolute synced server time + per-life seed (graft, replaces scoped-ticks phase):**
  ```
  t  = serverTime()/1000            // seconds, synced clock (client) / real clock (server)
  p1..p4 = seededRand(swaySeed) × 2π  // per-life phases; swaySeed rides the spawn event
  swayYawDeg   = A·(0.6·sin(2π·0.30·t + p1) + 0.4·sin(2π·0.71·t + p2))
  swayPitchDeg = A·(0.6·sin(2π·0.23·t + p3) + 0.4·sin(2π·0.53·t + p4))
  A = 0.35° × (movingScoped ? 2 : 1) × (breathHeld ? 0.1 : 1) × (forcedExhale ? 2.5 : 1)
      + 0.4°·exp(−ln2·msSinceLanding/700)          // jump-landing penalty kills jiggle-peeking
  ```
  `shared/sway.js` exports `swayOffsetDeg(tSeconds, seed, state)`. **The server evaluates it at the clamped fire time `tt` (§1.6 step 4) — the exact instant the client drew its reticle** — and the client renders the reticle wander from the same function at the same clock, so **what you see is exactly what the server fires** even across the 33–150 ms of transit + queue delay; ±20 ms clock error produces negligible phase drift. A hacked client cannot remove sway.
- **Breath-hold:** Shift while scoped. Meter 1→0 over **3.5 s**; empty → forced exhale **2.0 s** (sway ×2.5, cannot re-hold, heartbeat audio); refills over **4 s** unscoped / **8 s** scoped. Server owns; client predicts.
- **Rifle:** bolt-action **1500 ms**, magazine **5**, reload **2500 ms** (R or auto-empty). Recoil is client-visual only (1.2° pitch kick, 300 ms recovery — bolt gates the next shot anyway).
- **Damage:** 100 HP, head 150 / body 60, no falloff, **no regen**.

### 4.5 Respawn rules & death experience

Death → **3 s death-ray cam**: camera detaches, pans to face the killer, renders a red beam along the **actual killing ray** (from the referenced `shot` event) + killer nameplate **with remaining HP ("Vex — 40 HP")** + **through-wall killer outline sprite for 2 s** (graft) so the victim tracks the killer's immediate relocation — every death teaches a revenge plan. **The cam is built from data cached at the kill event — `{killerName, killerHp, killerPos, ray}` — never from live entity lookups:** if the killer disconnects or dies mid-cam, keep the beam and nameplate at the cached position and drop the outline; `matchEnd`/intermission cancels the cam immediately and shows the scoreboard. Then respawn at the best of 8 fixed spawn points scored by `distToNearestEnemy + 40·(no LOS to any enemy ? 1 : 0)`, **rejecting any point with a player (or corpse-in-cam) within 2 m** (no player-player collision means overlapped spawns must be prevented here — §1.2). **1.5 s spawn protection**, ended early by scoping or firing. Client-side prediction across the death/respawn boundary follows §1.4 exactly (ring cleared, `predicted = you`, seq continues).

### 4.6 Camping counterplay (layered stack — no shrinking zone: holding an angle should be viable, just never invisible)

1. **Scope glint:** every remote scoped player aiming within 10° of the local camera with clear LOS (client ray vs map AABBs at 5 Hz) renders an additive white-gold sprite at the muzzle, distance-scaled but **always ≥ 8 px**.
2. **Tracers:** every confirmed shot draws the TRUE server ray, 150 ms bright line + **500 ms smoke trail**.
3. **Compass fire-pings:** red blip at the shot's bearing for 2 s.
4. **Death-ray cam + killer outline** (§4.5).
5. **Audio geography:** distance-delayed cracks (§4.8) + whiz-by near-miss.
6. **Map routes** (§4.7): every perch is flankable from a zero-exposure route.
7. **Bot hard relocate rule** (§5.2): even AI campers are huntable on a clock.

### 4.7 Map: "The Ravine" (200 × 120 m, all data in `shared/map.js`)

Central dry canyon on the long axis: two uninterrupted ~170 m sightlines (floor lane east–west, nest-to-nest across the top). Two cliff shelves (y = 6) with 2 sniper nests each (waist-high parapets with firing gaps). Mid-map bridge (y = 5) — high-risk rotation. Canyon floor: staggered rocks/pillars giving 2–4 s exposure windows. Two corner towers (y = 9 platforms, stair-step "ramps" of 0.4 m AABB risers) — best sightlines, deliberately **silhouetted against the sky** and glint-visible from everywhere. **Grafted counterplay rules (binding on map authoring):** (a) a **sunken flank trench** (floor −2 m) runs the full north edge with exit ramps every 40 m — zero exposure to either long sightline, the guaranteed safe rotation; (b) **tower and nest access stairs face AWAY from the main canyon lane**, so every perch is backstab-able without crossing its own sightline; (c) **every nest/tower has ≥ 2 approach routes** (agents verify against the waypoint graph before closing M3). One exported array of ~70 `{min:[x,y,z], max:[x,y,z], mat}` boxes + 8 spawn points + ~24 waypoints with adjacency — consumed by client rendering, server collision, server occlusion rays, and bot pathing. One source of truth.

### 4.8 Input & audio

- **Input:** Pointer Lock on canvas click; mousemove → yaw/pitch (pitch clamp ±1.55 rad); WASD/Space latched per tick; RMB scope, LMB fire (edge-latched so sub-tick clicks fire), Shift breath, R reload, Tab scoreboard, Esc → menu (releases all latched keys — the last-sent input is neutral, so §1.2 starvation re-application is harmless).
- **Audio** (`audio.js`, pure WebAudio, zero files): own shot = 150 ms noise burst → lowpass sweep 8 kHz→400 Hz + 60 Hz sine thump + slap-back echo; **remote shots delayed by `distance/340` s with gain and lowpass ∝ 1/distance** (distant fights become audible geography and range info); **whiz-by (graft): any confirmed shot ray passing within 2 m of the local camera plays a 100 ms bandpassed chirp panned by side** — near-miss terror, and bot ranging misses become legible; hitmarker 2 kHz tick; headshot 1320 Hz ding with pitch bend; bolt clack ×2; reload foley; **heartbeat (55 Hz sine pairs at 1.2 Hz) during breath-hold and forced exhale** (graft — the meter is felt, not just seen); breath swells; death whoomp + master-bus muffle. One `AudioContext`, master gain + mute.

### 4.9 Spectate mode (graft)

`?spectate=1` → `hello {spectate:true}` → server registers a non-combatant observer: receives snapshots with **`you: null`** (the defined spectator selfState — §1.2 step 6; the client treats `you === null` as observer and skips prediction/HUD), spawns no entity, excluded from human counts and bot fill, capped at 4 per room (§2). Client: free-fly camera (WASD + mouse, 12 m/s; one-finger drag-to-look on touch devices), HUD reduced to killfeed + scoreboard. If a spectated overflow room is destroyed, the server migrates the spectator to room #0 with a fresh `welcome` (§1.1). Used by the bot-only soak and post-deploy verification to watch glints/tracers/relocations without perturbing the match.

### 4.10 Fake-lag harness

`?fakelag=150&jitter=30` queues all inbound AND outbound WS messages by `fakelag ± uniform(jitter)` ms in `net.js`. The only practical way to verify prediction and lag comp locally (localhost RTT ≈ 0). Never cut.

---

## 5. Bots

### 5.1 One code path — enforced by architecture

A bot is a `Player` entity plus a `BotController` whose ONLY output is a standard Input object `{seq, b, yaw, pitch, fire?}` pushed into the same per-player queue humans fill from the network. Movement, sway, breath, fire validation, lag-comp history, snapshots: byte-identical. Bots' `fire.tt` = current server time (they aim at authoritative positions — zero rewind, which is exactly correct). Bots can never do anything a human client couldn't.

**Full camouflage on the wire (graft):** no `bot` field in roster/snapshots/events; bots join and leave via normal `join`/`leave` events; scoreboard shows synthetic pings via the same `score` rows humans ride. Bot counts are disclosed ONLY via `/api/status`. You should genuinely wonder whether Vex is human.

### 5.2 Decision loop (5 Hz, staggered `tick % 6 === i % 6`)

FSM: **PATROL → INVESTIGATE → ENGAGE → RELOCATE** (+ DEAD handled by the room).

- **Perception:** per think, enemies within 110° FOV AND clear LOS (≤ 9 map raycasts per think across all bots; staggering covers the rest) → visible; remember `lastSeen` 4 s. Any `shot` event within 80 m sets `investigatePoint` to the shot origin.
- **PATROL:** walk the waypoint graph (next-hop table precomputed via Floyd–Warshall at boot; 24³ is nothing) toward a random nest/tower, 60% preference for elevated nodes; yaw sweeps ±60° sinusoidally.
- **INVESTIGATE:** path to `investigatePoint`; arrival or 8 s → PATROL.
- **ENGAGE:** stop at the nearest cover-adjacent node **not currently occupied by another bot** (occupancy set maintained in RoomManager — no player-player collision means stacked bots on one parapet must be prevented here), scope (glint appears — the human's warning window), run the aim model; target lost 4 s → INVESTIGATE at lastSeen.
- **RELOCATE:** triggered by: **HARD RULE (graft) — after 2 shots fired from within 2 m of the same position, RELOCATE is MANDATORY** (no roll; every bot camper is huntable on a predictable clock); after being hit (70%); after any kill; after 12 s static. Path to a different nest ≥ 40 m away, unscoped.
- **Stuck recovery:** if a pathing bot moves < 0.5 m over 3 s of think cycles, mark the current graph edge suspect and repath via a random different adjacent waypoint (a bot strafing into a parapet corner forever is the loudest possible camouflage break). `soak.js` counts stuck events and asserts < 3 per 60 s.
- **Steering → Input:** desired velocity → `yaw = atan2` + forward bit; jump if next node is 0.5–1.5 m up and near. Yaw output low-pass filtered (turn-rate caps below) — bots visibly track, never snap.

### 5.3 Aim model (believable to snipe and be sniped)

On acquiring a target: sample `reactionDelay` and initial error `err ~ |N(0, σ0)|` with a slowly-drifting error direction. Each think: `err *= exp(−thinkDt/τ)` (the human "wobble onto target" look). Aim = predicted head or body (per headshot roll) + err offset. Bots experience their own server-applied sway and **hold breath only in the final 0.4 s before firing** — a readable tell. Fire when reaction elapsed AND `err < fireThresh` AND bolt ready AND LOS clear. **Guaranteed first-shot ranging miss (graft): the first shot of EVERY engagement adds a fixed 1.2° offset in a random direction on top of current err — no tier can land it at range.** The crack + tracer + whiz-by give the human exactly one bolt-cycle window to react before accurate follow-up. Missed shots are real rays → real tracers and near-miss cracks. (`TEST_MODE=1` zeroes reaction randomness — §1.1.)

| Parameter | Easy | Medium | Hard |
|---|---|---|---|
| reaction (ms) | 600 ± 150 | 400 ± 100 | 260 ± 60 |
| σ0 initial error (°) | 3.5 | 2.2 | 1.4 |
| τ settle (s) | 1.2 | 0.8 | 0.55 |
| fire threshold (°) | 0.9 | 0.6 | 0.45 |
| error floor (°) | 0.5 | 0.25 | 0.1 |
| headshot preference | 30% | 55% | 75% |
| turn-rate cap (°/s) | 240 | 330 | 420 |

Default fill: 2 Easy, 2 Medium, 1 Hard, 1 random. **Rubber-banding ON (graft):** at each intermission, per room: any human with match K/D < 0.5 → swap one Hard for an Easy; all humans K/D > 2.0 → swap one Easy for a Hard; bounds: ≥ 1 Easy, ≤ 2 Hard. **Swaps mutate the difficulty preset in place on an existing bot — identity (name, pid, rank chevron, stats) unchanged, no wire events** (§3.4). Bot names from a fixed 24-name pool ("Vex","Moss","Talon","Kestrel","Juniper","Krait","Sable","Havoc","Mirage","Drift","Onyx","Juno",…), each with a plausible assigned rank chevron (Marksman–Veteran); the pool is reserved — humans cannot register or hello with these names (§2, §3.1).

---

## 6. Repo Structure

```
/package.json                  # "type":"module"; deps: ws; optionalDeps: pg; scripts: start, test, smoke, soak
/render.yaml                   # Render blueprint (§9)
/README.md                     # run, verify, deploy, controls
/.gitignore                    # node_modules
/server/index.js               # boot: http server, static (/public + /shared, traversal-hardened), /api router,
                               #   ws upgrade, RoomManager, tick loop (rebase rule), SIGTERM flush
/server/game/rooms.js          # RoomManager: room #0 always-alive, overflow create/destroy + spectator migration,
                               #   quick-join (most-humans), delayed bot refill (3–8 s), eviction deadline, occupancy set
/server/game/room.js           # Room: match state machine (MATCH_MS/INTERMISSION_MS from env), per-tick pipeline,
                               #   snapshot build/broadcast (string-splice, backpressure guard), 1 Hz score rows, rubber-band pass
/server/game/player.js         # Player entity: state, input queue, input-debt (guessedSteps) + ack semantics,
                               #   starvation edge-stripping, AFK timer, bolt/breath/scoped timers, lag-comp ring
/server/game/lagcomp.js        # history ring write + rewindAt(tt) lerp + validateFire(): sway-at-tt + spread +
                               #   head-first raycast priority (§1.6)
/server/game/combat.js         # damage, kill/streak/death, XP accrual hooks, respawn + spawn-protection timers
/server/game/spawns.js         # spawn scoring (distance + LOS + 2 m player-proximity rejection); TEST_MODE pinned spawns
/server/game/bots/controller.js# FSM, perception, aim model (ranging miss, 2-shot relocate, stuck recovery), steering → Input
/server/game/bots/names.js     # name pool + difficulty presets + synthetic pings + assigned ranks
/server/net/connection.js      # socket lifecycle: hello/HMAC verify (timingSafeEqual), hello name re-validation,
                               #   newest-wins duplicate pid, 5 s hello timeout, 10 s liveness terminate, connection caps,
                               #   spectate registration, input validation, rate limits, single-sourced disconnect path
/server/net/protocol.js        # message schemas/validators, quantization helpers, snapshot splice helper (tested, null-you safe)
/server/http/api.js            # REST: /api/guest, /api/leaderboard (5 s cache), /api/stats/:pid, /api/status;
                               #   global /api token bucket, 4 KB body cap, static file serving + MIME map + traversal defense
/server/http/identity.js       # HMAC mint/verify (node:crypto, timingSafeEqual), name validation, profanity + reserved-name denylists
/server/store/statsStore.js    # StatsStore interface + MemoryStore + season id + XP/rank math
/server/store/pgStore.js       # PgStore (lazy pg import), CREATE TABLE, 30 s write-behind, SIGTERM flush, error fallback
/shared/constants.js           # EVERY tunable: tick/interp/rewind, speeds, damages, sway/breath/scope/spread, XP table,
                               #   ranks, connection caps, MATCH_MS/INTERMISSION_MS (env-overridable)
/shared/movement.js            # step(state, input, dt, map): wishdir velocity, gravity 20, jump 5, per-axis AABB slide,
                               #   0.45 m step-up, NO player-player collision
/shared/map.js                 # Ravine AABBs (~70), spawns (8), waypoints (24 + adjacency), rayVsAABBs(), trench/stair layout
/shared/math.js                # vec3 ops, shortest-arc lerp, seeded RNG (mulberry32) for spread/tests
/shared/sway.js                # swayOffsetDeg(tSeconds, seed, state) — absolute-server-time deterministic sway
/public/index.html             # canvas + full HUD/menu DOM + module script; touch-device interstitial
/public/style.css              # HUD/menu/scope-overlay/killfeed/banner styles
/public/vendor/three.module.js # vendored Three.js (pinned r168), downloaded once in M1 and committed
/public/js/main.js             # boot, menu flow, cold-start + mid-game reconnect flows, error map, render loop +
                               #   clamped fixed-step accumulator + visibilitychange handling, spectate free-cam
/public/js/net.js              # WS client, min-RTT clock sync, snapshot buffer, event dispatch, ?fakelag harness
/public/js/prediction.js       # 128-input ring, local step, rollback-replay, 50 ms half-life smoothing,
                               #   death/respawn ring reset (§1.4)
/public/js/interpolation.js    # remote interp at renderTime−100ms, capped extrapolation, spawn purge
/public/js/input.js            # pointer lock, latching, per-tick sampling, FOV-ratio sensitivity, Esc neutral-release
/public/js/scene.js            # Three scene: map meshes, canvas textures, player rigs (capsule 0.4→1.3 + protruding head),
                               #   nametags, viewmodel, blob shadows
/public/js/scope.js            # FOV lerp, scope overlay, client sway/breath mirror (same clock as fire tt), quickscope hint
/public/js/effects.js          # tracers+smoke, muzzle flash, glint sprites, hitmarkers, death-ray cam (cached-data),
                               #   killer outline
/public/js/hud.js              # DOM HUD (textContent-only rule): bars, killfeed w/ ranks, scoreboard (roster + score rows),
                               #   name discriminators, compass pings, damage wedge, Boot Season banner, Guest chip
/public/js/audio.js            # WebAudio synth: distance-delayed shots, whiz-by, heartbeat, boltwork, dings, ambience
/test/determinism.test.js      # 600 recorded inputs through shared/movement.js twice → bit-identical state histories
/test/lagcomp.test.js          # hit/miss/clamp asymmetry + HEADSHOT assertion + jittered-delivery input-debt case (§8)
/test/protocol.test.js         # hostile inputs, traversal GETs, bad hello names, garbage frames, maxPayload;
                               #   spliced snapshots (incl. spectator you:null) JSON.parse round-trip
/test/smoke.e2e.js             # TEST_MODE=1 server; module-graph static check; walk/speed-cap; sway-compensated body+head
                               #   shots; respawn-prediction check; fire-rate spam; 429/413; leaderboard (§8)
/test/soak.js                  # 4 headless clients + 2 bots (fill rule), 60 s, MATCH_MS=20000: full match lifecycle,
                               #   cadence, acks, no NaN, ≥1 bot kill, half-open peer, stuck-bot count, memory stable
/test/run.js                   # runs determinism+lagcomp+protocol+smoke sequentially, nonzero exit on failure
```

~35 source files. No build config, no test framework (plain Node scripts + `assert`), no Docker.

---

## 7. Ordered Milestones (each ends RUNNABLE) + Cut Lines

Bots land at **M4 of 7** and a compliant sniper deathmatch exists at the end of **M4** — a badly slipped session still ships the brief. The ordering law (§0) governs inside every milestone.

**M1 — Skeleton walk.** Server boots on `PORT`, serves static + `/shared` + vendored three.js (download and commit it now) **with the §3.1 traversal defense from day one**, WS upgrade (`maxPayload:4096`, try/catch parse), `hello`/`welcome`, 30 Hz drift-corrected tick loop with overrun counter + rebase rule, naive movement (server applies inputs, client renders raw snapshots), flat ground + placeholder boxes, pointer-lock look/move, `/api/status` live.
*Ships WITHOUT:* prediction, interpolation, combat, map, bots, identity, audio.
*Cut line:* none — foundation. **DONE WHEN** two tabs see each other move (jerkily) and `curl /api/status` shows tick advancing.

**M2 — Netcode core (the product thesis).** `shared/movement.js` with AABB collision + step-up; min-RTT clock sync with slew; prediction ring + rollback-replay + 50 ms half-life smoothing; **clamped accumulator + visibilitychange handling (§1.4)**; **server input-debt accounting (§1.2)**; interpolation buffer (100 ms) + capped extrapolation; `?fakelag` harness; `determinism.test.js` green.
*Ships WITHOUT:* guns, map, scope.
*Cut line (bottom-up):* extrapolation → freeze on starvation; visual smoothing → hard snap. Never cut: prediction, reconciliation, input-debt accounting, accumulator clamp, interpolation, fakelag harness, determinism test. **DONE WHEN** strafing at `?fakelag=150&jitter=30` feels identical to 0 ms, remote players glide, and a 30 s alt-tab returns without a kick or a teleport.

**M3 — Guns, death, and the map.** `shared/map.js` Ravine (with trench, away-facing stairs, ≥2 routes per perch — verify against waypoint graph); fire input + FULL lag-comp pipeline with **head-first hit priority and sway-at-tt** (`lagcomp.test.js` green, including the headshot assertion); damage/kill/respawn/spawn-protection; **death/respawn prediction reset (§1.4)**; shot/kill/spawn events with authoritative echoed ray; tracers + smoke, hitmarker, killfeed, health/ammo HUD; bolt + reload; **basic scope** (FOV lerp 75→20, DOM overlay, 2.5 m/s, FOV-ratio sensitivity).
*Ships WITHOUT:* sway, breath, spread penalties, glint, audio, bots, identity.
*Cut line:* reload/magazine → infinite bolt-action; spawn scoring → random spawn. Never cut: lag comp, head-first priority, scope zoom, head/body split, tracers. **DONE WHEN** two `?fakelag=150` tabs duel, aiming at the rendered strafing target hits while leading it misses, and a shot at the visible head one-shots.

**M4 — Bots (fun at zero humans — hard constraint lands HERE).** Waypoint next-hop table; full FSM + stuck recovery; aim model with difficulty table, **guaranteed ranging miss**, **2-shot mandatory relocate**; population fill/evict per §3.4 (delayed refill, eviction deadline) via join/leave events; full wire camouflage + synthetic pings; **`TEST_MODE=1` hook (no bot fill in room #0, pinned spawns, zeroed reaction randomness — §1.1)**; `soak.js` green.
*Ships WITHOUT:* rubber-banding (comes with match cycle in M6), sniper-soul polish.
*Cut line:* INVESTIGATE state → go straight to lastSeen; waypoint graph → 8 nest-to-nest patrol pairs; Hard tier. Never cut: bots through the human code path, ranging miss, relocate rule, TEST_MODE hook. **DONE WHEN** one tab joins a live bot fight, gets sniped from a tower, sees the tracer, and counter-snipes — and the game is brief-compliant end to end.

**M5 — Sniper soul & counterplay.** In order: deterministic absolute-time sway (server-applied at `tt`) + breath meter + forced exhale; quickscope cone + unscoped bloom (server-rolled, honest bloom crosshair); scope glint (≥ 8 px); WebAudio pack (shots, distance-delayed remote cracks, bolt, dings); whiz-by crack; heartbeat; compass fire-pings; death-ray cam (cached-data per §4.5) + killer HP + through-wall outline; recoil + viewmodel bob; bots hold breath before firing.
*Ships WITHOUT:* identity, XP, match cycle.
*Cut line (bottom-up):* viewmodel bob → static; killer outline → nameplate-only cam; compass pings; heartbeat; whiz-by; distance delay → instant audio. Never cut: sway, breath, glint, quickscope penalty, core audio. **DONE WHEN** the fakelag manual script in §8 reads like sniping, and a settling scope + glint exposure is mandatory for accuracy.

**M6 — Full stack.** `/api/guest` + HMAC tokens (timingSafeEqual) + localStorage; StatsStore + kill/XP accrual; ranks + chevrons + rank-up toast; `/api/leaderboard` (cached) + `/api/stats/:pid`; Boot Season banner + `persistent:false`; match cycle (env-configurable `MATCH_MS`/`INTERMISSION_MS`) + intermission scoreboard + XP breakdown + rubber-band pass (in-place mutation); 1 Hz `score` rows + roster stats; menu overlay (name, leaderboard, settings, error map); PgStore + SIGTERM flush behind `DATABASE_URL`; **soak.js lifecycle assertions green (short-match config, §8)**.
*Ships WITHOUT:* accounts, chat, duel queue, room browser (all permanently out of scope).
*Cut line (bottom-up):* PgStore (memory ships fine; interface stays); rubber-banding; XP/ranks → kills-only leaderboard; match cycle → endless match + hourly reset. Never cut: guest tokens, leaderboard REST, Boot Season honesty, lifecycle soak. **DONE WHEN** menu → play → kill → intermission → next round works, k/d reset next round, and `curl /api/leaderboard` shows your kills and XP.

**M7 — Ship.** Cold-start "Waking the range…" + **mid-game reconnect overlay (§4.1)**; `?spectate=1` observer mode (`you:null`); per-socket rate/size limits + join throttle + violation kicks + **liveness/hello timeouts + backpressure terminate + connection caps (§2)** + global REST bucket/body cap (§3.1); touch-device interstitial; `test/run.js` + `smoke.e2e.js` green; final constants tuning pass; README; deploy per §9; post-deploy verification per §8.
*Cut line:* spectate mode (soak degrades to a playing tab standing still; touch interstitial then links to a static "desktop only" note). Never cut: smoke test, rate limits, liveness timeouts, reconnect flow, deploy, health check.

---

## 8. Verification Plan

**Automated — `npm test` (`node test/run.js`, plain Node, exit ≠ 0 on any failure):**
1. `determinism.test.js`: replay a 600-input recorded sequence through `shared/movement.js` twice → `JSON.stringify` of the two state histories must be **identical** (guards against the #1 prediction failure: client/server divergence = production rubber-banding).
2. `lagcomp.test.js`: victim strafes 5 m/s; shooter with simulated 200 ms latency fires at the victim's 200 ms-old rendered position with `tt = now − 200` → **hit**; identical aim with `tt = now` → **miss**; `tt = now − 400` → rewind clamped to 250 ms asserted. **Plus:** a ray aimed at the rewound head center → `part === "head"` and 150 dmg (guards the head-first priority — a body-shadowed head is the classic silent-failure); **plus** a jittered-delivery sequence (gaps + bursts) through the server input pipeline asserting total displacement ≤ stepped-ticks × per-tick distance and final ack == last seq (guards input-debt accounting — no double-integration, no lost fires).
3. `protocol.test.js`: seq regression, NaN yaw, pitch 9999, 5 KB frame (asserted rejected via the `maxPayload` path), garbage non-JSON frame → violation, 200 msg/s → all rejected/counted; hello with `<`, `"`, 17 chars, or a reserved bot name → `NAME_INVALID`; `GET /public/../package.json` and `/shared/%2e%2e/%2e%2e/server/index.js` → 404; snapshot frames built by the real string-splice helper — including a **spectator frame (`you:null`)** — `JSON.parse` cleanly with correct `ack`/`you`.
4. `smoke.e2e.js` (graft — true hitreg E2E): boots the real server on port 3100 **with `TEST_MODE=1`** (no bots in room #0, two pinned mutually-visible spawns with a clear 15 m lane — the test is deterministic by construction, and it is a **never-cut CI gate**, so it must never flake); polls `/api/status`. **Static/module-graph check first** (the highest-probability one-shot failure): `GET /` → 200 `text/html`; every file in the client module graph (`/public/js/*.js`, `/shared/*.js`, `/public/vendor/three.module.js`) → 200 `text/javascript`; regex-scan each served JS for `from '…'` specifiers and assert each resolves to a 200. Then two headless `ws` clients join; client A holds W for 2 s → assert displacement > 5 m AND ≤ 6.0·t·1.1 (speed-cap anti-cheat, valid on the pinned clear lane); A scopes 400 ms (past the quickscope cone), holds breath (sway ×0.1), **imports `shared/sway.js`, computes the sway offset at its own fire `tt`** (valid because the server evaluates sway at the clamped `tt` — §1.6), and fires sway-compensated at B's snapshot position → assert `shot` event echoes the expected ray within 0.2°, then `hit part=="body"`, then after a second body hit a `kill` event with correct victim/killer; **a third shot aimed at B's respawned head center → assert `part=="head"` and a one-shot kill**; **after B's respawn, assert B's first 10 post-respawn snapshots show `|you − predicted|` below the reconciliation threshold** (no respawn rollback storm); A spams 5 fires in 200 ms → assert exactly 1 `shot`; REST: 21 rapid `/api/leaderboard` hits → a 429; 5 KB POST body → 413; finally `POST /api/guest` + `/api/leaderboard` shows A's kill and XP.
5. `soak.js`: real server (normal mode, **not** TEST_MODE) + **4 headless input-looping clients + the 2 bots the `MIN_COMBATANTS=6` fill rule yields**, 60 s, with **`MATCH_MS=20000`, `INTERMISSION_MS=5000`** so the full match lifecycle runs twice: snapshot inter-arrival p95 < 60 ms, every `ack` monotonic, no NaN anywhere, ≥ 1 bot kill; **lifecycle assertions:** `matchEnd` received by every client with a scoreboard containing all combatants, `xpGain` consistent with kills recorded, a second LIVE phase starts, k/d reset to 0 in the next `score` rows, `/api/status` phase flips LIVE→INTERMISSION→LIVE; **one half-open peer** (client stops reading/writing without closing) → asserted terminated within 15 s with a `leave` broadcast and stable RSS; bot stuck events < 3; RSS < 200 MB; `overruns60s` < 10.

**Manual local (README checklist, run at every milestone close):**
- 3 tabs, different names: mutual visibility, smooth remotes, killfeed/respawn parity in all tabs.
- Lag-comp feel: one tab at `?fakelag=150&jitter=30`, snipe a strafing bot aiming AT its rendered body → registers; aim ahead → misses; aim at the visible head → one-shot.
- **Lifecycle:** alt-tab 30 s mid-match, return → no kick, clean snap, still in the fight. Kill the server mid-duel, restart it → "Connection lost — reconnecting…" resolves into the new match without a page reload.
- Bot-only: `http://localhost:3000/?spectate=1`, watch 3 minutes: patrols, glints, honest scope-then-fire, guaranteed first-shot misses with whiz-by audible in a playing tab, mandatory relocation after 2 shots, no stuck-in-corner bots, kill feed flows.
- Sniper soul: scope FOV/overlay/slow-walk; breath drain → heartbeat → forced exhale; quickscope shots visibly bloom; headshot one-shots on the visible head; tracer + smoke visible from a third tab; death-ray cam shows the killing ray + "Vex — 40 HP" + through-wall outline (and survives the killer disconnecting mid-cam).
- REST: `curl -s localhost:3000/api/status | jq` (tick advancing, overruns ~0, rooms populated); `curl -X POST localhost:3000/api/guest -H 'content-type: application/json' -d '{"name":"QA"}'`; play; `curl localhost:3000/api/leaderboard`.

**Post-deploy (Render):**
- `curl https://<app>.onrender.com/api/status` — retries until `ok:true` (cold start); expect room r0 with bots ≥ 5 at zero humans — proof the sim runs.
- **Two desktops on different networks (one tethered to a phone hotspot for real cellular latency): join, kill each other**, verify hit registration on a moving target at real cross-network ping, killfeed parity, both on `/api/leaderboard`. On an actual phone browser, confirm the desktop-only interstitial appears and its spectate link works with drag-to-look.
- `?spectate=1` on the live URL: watch a full bot round through intermission and restart.
- Idle 20 min → revisit → "Waking the range…" flow succeeds; memory mode shows the Boot Season banner (a fresh ladder, not an error).
- Render Logs: zero uncaught exceptions, tick-overrun warnings < 1/min under 6-bot + 2-human load, `rebases60s` ~0 at steady state; Metrics: memory flat.
- If `DATABASE_URL` (Neon) set: record a kill, trigger Manual Deploy, confirm the leaderboard survived (SIGTERM flush).

---

## 9. Render Deploy Steps

1. Commit everything (including `public/vendor/three.module.js`); push:
   `git add -A && git commit -m "GLINT v1" && gh repo create snipergame --public --source . --push`
2. `render.yaml` at repo root:
   ```yaml
   services:
     - type: web
       name: glint
       runtime: node
       plan: free
       buildCommand: npm install
       startCommand: node server/index.js
       healthCheckPath: /api/status
       autoDeploy: true
       envVars:
         - key: NODE_VERSION
           value: "20"
         - key: SERVER_SECRET
           generateValue: true
   ```
3. Render Dashboard → **New → Blueprint** → select the repo → Apply. (Manual fallback: New → Web Service, same build/start commands, Free plan. The Render MCP `create_web_service` tool with identical settings is also acceptable.)
4. Server binds `process.env.PORT` on `0.0.0.0`; `ws` shares the HTTP server, so WebSocket upgrades work with zero extra config on Render free tier.
5. Watch first-deploy logs for `listening on <port>` and `room r0 up, 6 bots`; hit `/api/status`.
6. **Optional persistence upgrade:** create a free **Neon** (or Supabase) Postgres → Render → Environment → add `DATABASE_URL` → redeploy; PgStore self-creates its table and starts write-behind + SIGTERM flushing. **Do NOT use Render's own free Postgres — it expires after ~30 days.** Without the env var, the game runs forever in Boot Season mode by design.
7. Free-tier realities already handled in-design: cold-start retry UX + mid-game reconnect (§4.1), single instance (no cross-instance state anywhere), ephemeral disk (nothing is ever written to disk), 0.1-CPU tick budget + stall rebase (§1.2), liveness/backpressure hygiene (§2), health check keeping deploys honest.
8. Run the post-deploy block from §8.

**Definition of shipped:** a stranger opens the URL, types a callsign, is sniping believable bots inside 15 seconds, hears a ranging shot crack past their ear, spots the glint, gets headshotted from a silhouetted tower, watches the death-ray trace back to a killer at 40 HP, flanks through the trench for the revenge kill, ranks up at the intermission podium, and finds their name at `/api/leaderboard` — all with hit registration that feels perfect at 150 ms of fake lag and real cross-network ping.

---

## 10. Known deferred risks (accepted, not planned)

- **Touch/mobile gameplay** is permanently out of scope; phones get the desktop-only interstitial + drag-to-look spectate (§4.1). If analytics ever show heavy mobile demand, that is a new project, not a patch.
- **Server-side tolerance of a one-time seq jump after a ≥ 1 s input gap** is not implemented; the client-side accumulator clamp + visibilitychange neutral input (§1.4) makes bursts impossible from a compliant client. Revisit only if post-deploy logs show false-positive RATE/seq kicks.
- **Snapshot wallhacks / interest management** remain accepted by design (§3.5) — glint intentionally leaks scoped positions, and the CPU budget forbids per-client visibility culling.
- **Delta/binary snapshot encoding** remains permanently rejected (§1.2); at 24 KB/s/client the bandwidth is not the bottleneck, CPU is.
- **Global name uniqueness** is not enforced at registration; collisions are handled only at the display layer via the `Name#ab` discriminator (§4.3).