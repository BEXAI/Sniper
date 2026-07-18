# GLINT

GLINT is a full-stack browser sniper PvP game — Node.js + `ws` on the server, Three.js on the client, plain ES modules with **no build step**. One Node process serves the static client, a REST API, and the WebSocket game protocol on a single port. Hit registration is **server-authoritative, lag-compensated hitscan**: the server rewinds player hitboxes (clamped to 250 ms) to the shooter's rendered time, so aiming at what you *see* registers, even at 150 ms of real latency. Rooms are always **bot-filled to 6 combatants** — the range is alive and fun at zero humans, and bots run the exact same code path as humans. Kills and XP accrue to a **Boot Season leaderboard** (in-memory by default, Postgres-persistent when `DATABASE_URL` is set), with ranks, chevrons, and an intermission podium every match.

## Controls

| Input | Action |
|---|---|
| **W / A / S / D** | Move |
| **Space** | Jump |
| **Right mouse (hold)** | Scope |
| **Left mouse** | Fire |
| **Shift (hold)** | Hold breath (steadies sway while scoped) |
| **R** | Reload |
| **Tab (hold)** | Scoreboard |

## Run locally

```sh
npm install
npm start
```

Open **http://localhost:3000**, type a callsign, and you're sniping bots within seconds. Open **multiple tabs** with different names to play against yourself — killfeed, respawns, and scoreboard stay in sync across all tabs.

Requires Node.js ≥ 20. Only runtime dependency is `ws` (`pg` is optional, lazily imported only when `DATABASE_URL` is set).

## Tests

```sh
npm test        # determinism, lagcomp, protocol, smoke.e2e (real server on port 3100)
npm run soak    # 60 s soak: real server on port 3101, 4 headless clients + 2 bots,
                # short-match config exercising the full match lifecycle twice
```

- `determinism.test.js` — replays 600 recorded inputs through `shared/movement.js` twice; the state histories must be byte-identical (guards client/server prediction divergence).
- `lagcomp.test.js` — hit at rendered (200 ms-old) position, miss at current position, rewind clamp at 250 ms, head-first hit priority, jittered-delivery input-debt accounting.
- `protocol.test.js` — malformed/oversized/spammed frames, invalid names, path-traversal 404s, spectator-frame (`you: null`) JSON round-trip.
- `smoke.e2e.js` — boots the real server (`TEST_MODE=1`), verifies the full client module graph serves 200, then two headless clients move, scope, breath-hold, fire sway-compensated shots, and assert body hits, a headshot one-shot, kill events, fire-rate clamping, REST 429/413, and leaderboard accrual.

The test servers bind fixed ports (**3100** smoke, **3101** soak) — don't run both suites at the same time.

## Manual fakelag checklist

Run this at every milestone close (from `docs/PLAN.md` §8):

- **3 tabs, different names:** mutual visibility, smooth remote movement, killfeed/respawn parity in all tabs.
- **Lag-comp feel:** one tab at `http://localhost:3000/?fakelag=150&jitter=30`, snipe a strafing bot aiming **at its rendered body** → registers; aim ahead → misses; aim at the visible head → one-shot.
- **Lifecycle:** alt-tab 30 s mid-match, return → no kick, clean snap, still in the fight. Kill the server mid-duel, restart it → "Connection lost — reconnecting…" resolves into the new match without a page reload.
- **Bot-only:** `http://localhost:3000/?spectate=1`, watch 3 minutes: patrols, glints, honest scope-then-fire, guaranteed first-shot misses with whiz-by audible in a playing tab, mandatory relocation after 2 shots, no stuck-in-corner bots, kill feed flows.
- **Sniper soul:** scope FOV/overlay/slow-walk; breath drain → heartbeat → forced exhale; quickscope shots visibly bloom; headshot one-shots on the visible head; tracer + smoke visible from a third tab; death-ray cam shows the killing ray, killer HP, and through-wall outline (and survives the killer disconnecting mid-cam).
- **REST:** `curl -s localhost:3000/api/status | jq` (tick advancing, overruns ~0, rooms populated); `curl -X POST localhost:3000/api/guest -H 'content-type: application/json' -d '{"name":"QA"}'`; play; `curl localhost:3000/api/leaderboard`.

## Deploy to Render

The repo ships a blueprint — `render.yaml` at the root defines one free-tier web service (`buildCommand: npm install`, `startCommand: node server/index.js`, health check on `/api/status`, `SERVER_SECRET` auto-generated via `generateValue: true`).

1. Push the repo to GitHub (make sure `public/vendor/three.module.js` is committed).
2. Render Dashboard → **New → Blueprint** → select the repo → Apply. (Manual fallback: New → Web Service with the same build/start commands on the Free plan.)
3. The server binds `process.env.PORT` on `0.0.0.0` and `ws` shares the HTTP server, so WebSocket upgrades work with zero extra config.
4. Watch first-deploy logs for `GLINT listening on <port>`; then hit `https://<app>.onrender.com/api/status`.
5. **Optional persistence:** create a free **Neon** (or Supabase) Postgres and add its `DATABASE_URL` in Render → Environment → redeploy. PgStore self-creates its table and does write-behind + SIGTERM flushing. **Do NOT use Render's own free Postgres — it expires after ~30 days.** Without `DATABASE_URL`, the game runs forever in Boot Season (in-memory ladder) mode by design.

Free-tier realities are handled in-design: cold-start "Waking the range…" retry UX, mid-game reconnect overlay, single instance (no cross-instance state), nothing written to disk, 0.1-CPU tick budget with stall rebase.

## Architecture

- **`server/`** — one Node process: `index.js` (HTTP + WS upgrade + 30 Hz drift-corrected tick loop with stall rebase), `game/` (rooms, players, bots, spawns, and `lagcomp.js` — the rewind-and-raycast hit pipeline), `net/` (WS connection lifecycle + protocol validation/rate limits), `http/` (REST API + HMAC guest identity), `store/` (in-memory StatsStore + optional Postgres adapter).
- **`shared/`** — `constants.js`, `math.js`, `map.js`, `movement.js`, `sway.js`: the simulation modules imported **byte-identical by both client and server** (served as static ES modules). This is the keystone of client-side prediction — determinism is enforced by test, so predicted movement never diverges from the authoritative sim.
- **`public/js/`** — the Three.js client: `net.js` (WS + clock sync + the `?fakelag` harness), `prediction.js` (input ring + reconciliation rollback), `interpolation.js` (100 ms-delayed remote entity buffer), plus `scene.js`, `input.js`, `hud.js`, `scope.js`, `effects.js`, `audio.js`, and `main.js` tying it together.
- **`public/vendor/`** — vendored `three.module.js`; no CDN, no bundler.
- **`test/`** — `run.js` orchestrates `determinism`, `lagcomp`, `protocol`, and `smoke.e2e`; `soak.js` is the separate 60 s load/lifecycle harness.
- **Netcode shape:** client predicts itself from shared modules, interpolates remotes 100 ms in the past, and stamps each shot with its render time (`tt`); the server rewinds hitboxes to that time (clamped to 250 ms) before raycasting — head sphere first (150 dmg, one-shot), then body capsule (60 dmg).
- **Rooms:** room #0 exists from boot, is never destroyed, and is always bot-filled to 6, so `/api/status` always shows a live match; overflow caps at 2 rooms to fit the 0.1-CPU budget.
