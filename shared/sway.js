// Deterministic scope sway — a pure function of absolute synced server time plus a
// per-life seed. The client renders reticle wander from this function at its synced
// clock; the server evaluates the SAME function at the clamped client fire time `tt`.
// What you see is exactly what the server fires. A hacked client cannot remove sway.
import { mulberry32 } from './math.js';
import {
  SWAY_BASE_DEG, SWAY_MOVING_MULT, SWAY_BREATH_MULT, SWAY_EXHALE_MULT,
  SWAY_LAND_DEG, SWAY_LAND_HALFLIFE_MS,
} from './constants.js';

const LN2 = Math.log(2);
const TAU = Math.PI * 2;

// Per-life phases derived from the spawn-event seed.
export function swayPhases(seed) {
  const rng = mulberry32(seed >>> 0);
  return [rng() * TAU, rng() * TAU, rng() * TAU, rng() * TAU];
}

// state: { movingScoped: bool, breathHeld: bool, forcedExhale: bool, msSinceLanding: number }
// Returns { yawDeg, pitchDeg } offsets to ADD to the aim direction while scoped.
export function swayOffsetDeg(tSeconds, seed, state) {
  const [p1, p2, p3, p4] = swayPhases(seed);
  let A = SWAY_BASE_DEG
    * (state.movingScoped ? SWAY_MOVING_MULT : 1)
    * (state.breathHeld ? SWAY_BREATH_MULT : 1)
    * (state.forcedExhale ? SWAY_EXHALE_MULT : 1);
  A += SWAY_LAND_DEG * Math.exp(-LN2 * (state.msSinceLanding ?? 1e9) / SWAY_LAND_HALFLIFE_MS);
  const yawDeg = A * (0.6 * Math.sin(TAU * 0.30 * tSeconds + p1) + 0.4 * Math.sin(TAU * 0.71 * tSeconds + p2));
  const pitchDeg = A * (0.6 * Math.sin(TAU * 0.23 * tSeconds + p3) + 0.4 * Math.sin(TAU * 0.53 * tSeconds + p4));
  return { yawDeg, pitchDeg };
}
