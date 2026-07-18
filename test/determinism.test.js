// The #1 prediction failure is client/server divergence = production rubber-banding.
// Replay 600 pseudo-random inputs through shared/movement.js twice: the two state
// histories must be bit-identical.
import assert from 'node:assert';
import { step, defaultState, cloneState } from '../shared/movement.js';
import { MAP, SPAWNS } from '../shared/map.js';
import { mulberry32 } from '../shared/math.js';
import { BTN, TICK_DT } from '../shared/constants.js';

function makeInputs() {
  const rng = mulberry32(424242);
  const inputs = [];
  let yaw = 0, pitch = 0;
  for (let i = 0; i < 600; i++) {
    let b = 0;
    if (rng() < 0.7) b |= BTN.FWD;
    if (rng() < 0.2) b |= BTN.LEFT;
    if (rng() < 0.2) b |= BTN.RIGHT;
    if (rng() < 0.1) b |= BTN.BACK;
    if (rng() < 0.08) b |= BTN.JUMP;
    if (rng() < 0.3) b |= BTN.SCOPE;
    if (rng() < 0.15) b |= BTN.BREATH;
    if (rng() < 0.02) b |= BTN.RELOAD;
    yaw += (rng() - 0.5) * 0.4;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + (rng() - 0.5) * 0.2));
    const input = { seq: i + 1, b, yaw, pitch };
    if (rng() < 0.05) { input.fire = { tt: i * 33.3 }; input.b |= BTN.FIRE; }
    inputs.push(input);
  }
  return inputs;
}

function run(inputs) {
  const sp = SPAWNS[0];
  const s = defaultState(sp.x, sp.y, sp.z);
  s.grounded = true;
  const history = [];
  for (const input of inputs) {
    step(s, input, TICK_DT, MAP);
    history.push(cloneState(s));
  }
  return JSON.stringify(history);
}

const inputs = makeInputs();
const h1 = run(inputs);
const h2 = run(inputs);
assert.strictEqual(h1, h2, 'movement histories diverged between identical runs');

// Sanity: the run actually moved, jumped, scoped, and fired.
const last = JSON.parse(h1)[599];
assert.ok(Number.isFinite(last.x) && Number.isFinite(last.y) && Number.isFinite(last.z), 'NaN leaked into state');
assert.ok(JSON.parse(h1).some((s) => !s.grounded), 'never left the ground');
assert.ok(JSON.parse(h1).some((s) => s.scoped), 'never scoped');
assert.ok(JSON.parse(h1).some((s) => s.ammo < 5), 'never fired');

console.log('determinism.test OK — 600-input replay bit-identical');
