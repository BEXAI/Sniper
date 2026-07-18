// Every tunable in the game. Imported by client AND server — keep it environment-agnostic.
const env = (typeof process !== 'undefined' && process.env) || {};

// --- Simulation ---
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;
export const TICK_DT = 1 / TICK_RATE;
export const INTERP_DELAY_MS = 100;          // 3 snapshot intervals of render delay
export const EXTRAP_CAP_MS = 100;            // max extrapolation on snapshot starvation
export const LAGCOMP_RING = 30;              // 1000 ms of pose history per player
export const MAX_REWIND_MS = 250;
export const INPUT_RING = 128;               // prediction ring (~4.2 s)
export const ACCUMULATOR_CAP_S = 0.25;       // client fixed-step accumulator hard clamp
export const RECON_POS_EPS = 0.015;          // m — reconciliation position threshold
export const RECON_VEL_EPS = 0.1;            // m/s
export const SMOOTH_HALFLIFE_S = 0.05;       // visual rollback error decay half-life

// --- Movement ---
export const SPEED = 6.0;                    // m/s unscoped
export const SPEED_SCOPED = 2.5;
export const AIR_MULT = 0.8;
export const GRAVITY = 20;
export const JUMP_VEL = 5.0;
export const STEP_UP = 0.45;
export const PLAYER_HALF = 0.4;              // collision half-width (x/z)
export const PLAYER_HEIGHT = 1.8;            // collision height

// --- Hitboxes (server + visual rig must match exactly) ---
export const EYE_HEIGHT = 1.62;
export const HEAD_RADIUS = 0.22;
export const HEAD_Y = 1.62;                  // head sphere center offset above feet
export const BODY_RADIUS = 0.4;
export const BODY_SEG_MIN = 0.4;             // capsule segment feet-relative
export const BODY_SEG_MAX = 1.3;

// --- Combat ---
export const MAX_HP = 100;
export const DMG_HEAD = 150;
export const DMG_BODY = 60;
export const BOLT_MS = 1500;
export const BOLT_TOLERANCE_MS = 50;
export const MAG_SIZE = 5;
export const RELOAD_MS = 2500;
export const SPAWN_PROTECT_MS = 2500;
export const SPAWN_MIN_DIST = 2;             // reject spawn with any player within 2 m
export const DEATH_CAM_MS = 3000;

// --- Scope / spread / sway / breath ---
export const FOV_DEG = 75;
export const FOV_SCOPED_DEG = 20;
export const SCOPE_LERP_MS = 220;
export const SCOPE_DROP_MS = 400;            // scope auto-drops this long at bolt-cycle start
export const UNSCOPED_CONE_DEG = 4.0;
export const QUICKSCOPE_CONE_DEG = 1.5;      // extra cone lerping 1.5 -> 0 over settle window
export const QUICKSCOPE_SETTLE_MS = 250;
export const SWAY_BASE_DEG = 0.35;
export const SWAY_MOVING_MULT = 2;
export const SWAY_BREATH_MULT = 0.1;
export const SWAY_EXHALE_MULT = 2.5;
export const SWAY_LAND_DEG = 0.4;            // jump-landing penalty amplitude
export const SWAY_LAND_HALFLIFE_MS = 700;
export const BREATH_HOLD_S = 3.5;
export const EXHALE_MS = 2000;
export const BREATH_REFILL_UNSCOPED_S = 4;
export const BREATH_REFILL_SCOPED_S = 8;
export const TRACER_SPEED = 400;             // visual-only m/s

// --- Input buttons bitmask ---
export const BTN = {
  FWD: 1, BACK: 2, LEFT: 4, RIGHT: 8, JUMP: 16,
  SCOPE: 32, FIRE: 64, BREATH: 128, RELOAD: 256,
};
export const BTN_MAX = 511;

// --- Networking / limits ---
export const MAX_PAYLOAD = 4096;
export const MAX_MSGS_PER_SEC = 80;
export const MAX_INPUTS_PER_SEC = 35;        // averaged over 3 s
export const MAX_VIOLATIONS = 20;
export const MAX_SEQ_JUMP = 64;
export const LIVENESS_TIMEOUT_MS = 10000;
export const HELLO_TIMEOUT_MS = 5000;
export const BACKPRESSURE_BYTES = 262144;
// Env-overridable: the soak runs 4 clients + a half-open peer from one loopback IP.
export const MAX_SOCKETS_PER_IP = Number(env.MAX_SOCKETS_PER_IP) > 0 ? Number(env.MAX_SOCKETS_PER_IP) : 4;
// WS join limit per IP (§3.5) — env-overridable for the same loopback reason.
export const JOIN_RATE_PER_MIN = Number(env.JOIN_RATE_PER_MIN) > 0 ? Number(env.JOIN_RATE_PER_MIN) : 5;
export const MAX_SOCKETS = 64;
export const MAX_SPECTATORS_PER_ROOM = 4;
export const PING_INTERVAL_MS = 2000;
export const STARVE_NEUTRAL_MS = 1000;       // input starvation -> neutral input after this
export const AFK_REMOVE_MS = 60000;

// --- Rooms / match ---
export const MIN_COMBATANTS = 6;
export const MAX_COMBATANTS = 10;
export const MAX_ROOMS = 2;
export const OVERFLOW_IDLE_DESTROY_MS = 60000;
export const BOT_REFILL_MIN_MS = 3000;
export const BOT_REFILL_MAX_MS = 8000;
export const BOT_EVICT_DEADLINE_MS = 20000;
export const MATCH_MS = Number(env.MATCH_MS) > 0 ? Number(env.MATCH_MS) : 300000;
export const INTERMISSION_MS = Number(env.INTERMISSION_MS) > 0 ? Number(env.INTERMISSION_MS) : 15000;

// --- Identity / names ---
export const NAME_MIN = 1;
export const NAME_MAX = 16;
export const NAME_RE = /^[A-Za-z0-9_\- ]{1,16}$/;

// --- XP / ranks ---
export const XP_KILL = 100;
export const XP_HEADSHOT = 50;
export const XP_STREAK_PER = 25;             // per (streak-1) per kill
export const XP_STREAK_CAP = 100;
export const XP_PLACE = [300, 200, 100];     // top 3 humans at match end
export const RANKS = [
  { xp: 0, name: 'Recruit' },
  { xp: 1000, name: 'Marksman' },
  { xp: 3000, name: 'Sharpshooter' },
  { xp: 7000, name: 'Veteran' },
  { xp: 15000, name: 'Ghost' },
  { xp: 30000, name: 'Phantom' },
  { xp: 60000, name: 'Legend' },
];
export function rankFor(xp) {
  let r = 0;
  for (let i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].xp) r = i;
  return r;
}

// --- Arena bounds (belt-and-braces clamp; map boxes are the real walls) ---
export const ARENA_X = 99.6;
export const ARENA_Z = 59.6;
export const ARENA_Y_MIN = -2.5;
export const ARENA_Y_MAX = 60;
