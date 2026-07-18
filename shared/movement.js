// The deterministic movement + equipment simulation. The client predicts with this
// EXACT module and the server integrates with it — any divergence is production
// rubber-banding, so keep every operation deterministic (no Date, no Math.random).
import {
  BTN, SPEED, SPEED_SCOPED, AIR_MULT, GRAVITY, JUMP_VEL, STEP_UP,
  PLAYER_HALF, PLAYER_HEIGHT, BOLT_MS, BOLT_TOLERANCE_MS, SCOPE_DROP_MS,
  MAG_SIZE, RELOAD_MS,
  EXHALE_MS, BREATH_HOLD_S, BREATH_REFILL_SCOPED_S, BREATH_REFILL_UNSCOPED_S,
  ARENA_X, ARENA_Z, ARENA_Y_MIN, ARENA_Y_MAX,
} from './constants.js';

export function defaultState(x = 0, y = 0, z = 0) {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0,
    grounded: false, landMs: 9999,
    scoped: false, scopedMs: 0,
    breath: 1, exhaleMs: 0, holding: false,
    ammo: MAG_SIZE, boltMs: 0, reloadMs: 0,
  };
}

export function cloneState(s) {
  return {
    x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz,
    grounded: s.grounded, landMs: s.landMs,
    scoped: s.scoped, scopedMs: s.scopedMs,
    breath: s.breath, exhaleMs: s.exhaleMs, holding: s.holding,
    ammo: s.ammo, boltMs: s.boltMs, reloadMs: s.reloadMs,
  };
}

function overlapsBox(x, y, z, box) {
  return x + PLAYER_HALF > box.min[0] && x - PLAYER_HALF < box.max[0]
    && y + PLAYER_HEIGHT > box.min[1] && y < box.max[1]
    && z + PLAYER_HALF > box.min[2] && z - PLAYER_HALF < box.max[2];
}

function collides(x, y, z, boxes) {
  for (let i = 0; i < boxes.length; i++) if (overlapsBox(x, y, z, boxes[i])) return true;
  return false;
}

// Advance one fixed step. Mutates `s` in place; returns { fired, landed } events.
// `input`: { seq, b, yaw, pitch, fire? }. `map`: { boxes: [...] }.
export function step(s, input, dt, map) {
  const boxes = map.boxes;
  const b = input.b | 0;
  const dtMs = dt * 1000;
  const events = { fired: false, landed: false };

  // --- Equipment timers ---
  if (s.boltMs > 0) s.boltMs = Math.max(0, s.boltMs - dtMs);
  if (s.reloadMs > 0) {
    s.reloadMs = Math.max(0, s.reloadMs - dtMs);
    if (s.reloadMs === 0) s.ammo = MAG_SIZE;
  }

  // --- Scope (auto-drops during the first SCOPE_DROP_MS of a bolt cycle) ---
  const scopeBlocked = s.boltMs > (BOLT_MS - SCOPE_DROP_MS) || s.reloadMs > 0;
  const scoped = !!(b & BTN.SCOPE) && !scopeBlocked;
  if (scoped) s.scopedMs = Math.min(600000, s.scopedMs + dtMs);
  else s.scopedMs = 0;
  s.scoped = scoped;

  // --- Breath ---
  if (s.exhaleMs > 0) s.exhaleMs = Math.max(0, s.exhaleMs - dtMs);
  const holding = scoped && !!(b & BTN.BREATH) && s.exhaleMs === 0 && s.breath > 0;
  if (holding) {
    s.breath = Math.max(0, s.breath - dt / BREATH_HOLD_S);
    if (s.breath === 0) s.exhaleMs = EXHALE_MS;
  } else {
    const rate = scoped ? 1 / BREATH_REFILL_SCOPED_S : 1 / BREATH_REFILL_UNSCOPED_S;
    s.breath = Math.min(1, s.breath + dt * rate);
  }
  s.holding = holding;

  // --- Reload edge (blocked mid-bolt; cancels scope via scopeBlocked next step) ---
  if ((b & BTN.RELOAD) && s.reloadMs === 0 && s.boltMs === 0 && s.ammo < MAG_SIZE) {
    s.reloadMs = RELOAD_MS;
  }
  // Auto-reload on empty once the bolt settles.
  if (s.ammo === 0 && s.boltMs === 0 && s.reloadMs === 0) s.reloadMs = RELOAD_MS;

  // --- Fire edge (identical gating on both sides; blocked fires are simply dropped).
  // A click landing one tick early is honored: the tolerance window is credited back
  // onto the new bolt so the effective cadence stays exactly BOLT_MS.
  if (input.fire && s.boltMs <= BOLT_TOLERANCE_MS && s.reloadMs === 0 && s.ammo > 0) {
    s.ammo -= 1;
    s.boltMs = BOLT_MS + s.boltMs;
    events.fired = true;
  }

  // --- Horizontal wish velocity (set directly; 0.8x airborne, full air control) ---
  const fwd = ((b & BTN.FWD) ? 1 : 0) - ((b & BTN.BACK) ? 1 : 0);
  const rgt = ((b & BTN.RIGHT) ? 1 : 0) - ((b & BTN.LEFT) ? 1 : 0);
  let wx = 0, wz = 0;
  if (fwd !== 0 || rgt !== 0) {
    const sy = Math.sin(input.yaw), cy = Math.cos(input.yaw);
    // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)  [yaw 0 faces -Z]
    wx = -sy * fwd + cy * rgt;
    wz = -cy * fwd - sy * rgt;
    const len = Math.sqrt(wx * wx + wz * wz);
    wx /= len; wz /= len;
  }
  const speed = (scoped ? SPEED_SCOPED : SPEED) * (s.grounded ? 1 : AIR_MULT);
  s.vx = wx * speed;
  s.vz = wz * speed;

  // --- Jump / gravity ---
  if ((b & BTN.JUMP) && s.grounded) { s.vy = JUMP_VEL; s.grounded = false; }
  if (!s.grounded) s.vy -= GRAVITY * dt;

  const wasGrounded = s.grounded;

  // --- Per-axis horizontal move-and-slide with step-up ---
  const nx = s.x + s.vx * dt;
  if (!collides(nx, s.y, s.z, boxes)) s.x = nx;
  else if (wasGrounded && !collides(nx, s.y + STEP_UP, s.z, boxes)) { s.x = nx; s.y += STEP_UP; }
  else s.vx = 0;

  const nz = s.z + s.vz * dt;
  if (!collides(s.x, s.y, nz, boxes)) s.z = nz;
  else if (wasGrounded && !collides(s.x, s.y + STEP_UP, nz, boxes)) { s.z = nz; s.y += STEP_UP; }
  else s.vz = 0;

  // --- Vertical move: land on box tops passed through; snap down steps when grounded ---
  if (s.vy <= 0) {
    const ny = s.y + s.vy * dt;
    // When grounded we extend the landing search below by STEP_UP so walking down
    // stairs (and settling after a step-up lift) stays glued to the ground.
    const searchLo = wasGrounded ? ny - STEP_UP : ny;
    let top = -Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (s.x + PLAYER_HALF > box.min[0] && s.x - PLAYER_HALF < box.max[0]
        && s.z + PLAYER_HALF > box.min[2] && s.z - PLAYER_HALF < box.max[2]) {
        const bt = box.max[1];
        if (bt <= s.y + 1e-6 && bt >= searchLo && bt > top) top = bt;
      }
    }
    if (top > -Infinity && (ny <= top || wasGrounded)) {
      if (!wasGrounded) { s.landMs = 0; events.landed = true; }
      s.y = top; s.vy = 0; s.grounded = true;
    } else {
      s.y = ny; s.grounded = false;
    }
  } else {
    let ny = s.y + s.vy * dt;
    // Head bump against box undersides we'd cross into.
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (s.x + PLAYER_HALF > box.min[0] && s.x - PLAYER_HALF < box.max[0]
        && s.z + PLAYER_HALF > box.min[2] && s.z - PLAYER_HALF < box.max[2]) {
        const bb = box.min[1];
        if (bb >= s.y + PLAYER_HEIGHT - 1e-6 && bb < ny + PLAYER_HEIGHT) {
          ny = bb - PLAYER_HEIGHT; s.vy = 0;
        }
      }
    }
    s.y = ny; s.grounded = false;
  }

  // --- Landing timer + arena clamp ---
  if (!events.landed) s.landMs = Math.min(9999, s.landMs + dtMs);
  if (s.x > ARENA_X) { s.x = ARENA_X; s.vx = 0; }
  if (s.x < -ARENA_X) { s.x = -ARENA_X; s.vx = 0; }
  if (s.z > ARENA_Z) { s.z = ARENA_Z; s.vz = 0; }
  if (s.z < -ARENA_Z) { s.z = -ARENA_Z; s.vz = 0; }
  if (s.y < ARENA_Y_MIN) { s.y = ARENA_Y_MIN; s.vy = 0; s.grounded = true; }
  if (s.y > ARENA_Y_MAX) { s.y = ARENA_Y_MAX; s.vy = 0; }

  return events;
}
