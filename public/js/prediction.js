// Client-side prediction: fixed-step local sim through the SAME shared movement
// module the server runs, a 128-input ring, rollback-and-replay reconciliation,
// and 50 ms half-life visual smoothing of rollback error.
import { step, cloneState, defaultState } from '/shared/movement.js';
import { MAP } from '/shared/map.js';
import {
  TICK_DT, INPUT_RING, RECON_POS_EPS, RECON_VEL_EPS, SMOOTH_HALFLIFE_S,
} from '/shared/constants.js';

function fromServerYou(you) {
  const s = defaultState(you.x, you.y, you.z);
  s.vx = you.vx; s.vy = you.vy; s.vz = you.vz;
  s.grounded = !!you.grounded;
  s.landMs = you.landMs;
  s.scopedMs = you.scopedMs;
  s.scoped = you.scopedMs > 0;
  s.breath = you.breath;
  s.exhaleMs = you.exhaleMs;
  s.ammo = you.ammo;
  s.boltMs = you.boltMs;
  s.reloadMs = you.reloadMs;
  return s;
}

export class Prediction {
  constructor() {
    this.ring = new Array(INPUT_RING).fill(null);
    this.state = defaultState();
    this.prevState = defaultState();
    this.seq = 0;
    this.anchorSeq = 0;
    this.active = false;
    this.errX = 0; this.errY = 0; this.errZ = 0;   // visual-only rollback error
    this.rollbacks = 0;
  }

  // Hard-anchor to a server state (respawn / reconnect): clear the ring entirely,
  // continue seq monotonically — stale inputs must never replay against a new life.
  // Acks at or below anchorSeq reference wiped entries and must NOT re-anchor.
  anchor(you, seq) {
    this.state = fromServerYou(you);
    this.prevState = cloneState(this.state);
    this.ring.fill(null);
    this.errX = this.errY = this.errZ = 0;
    if (seq !== undefined) this.seq = seq;
    this.anchorSeq = this.seq;
    this.active = true;
  }

  deactivate() { this.active = false; this.ring.fill(null); }

  // One fixed step with a freshly sampled input. Returns the step events.
  predict(input) {
    this.prevState = cloneState(this.state);
    const ev = step(this.state, input, TICK_DT, MAP);
    this.ring[input.seq & (INPUT_RING - 1)] = { seq: input.seq, input, state: cloneState(this.state) };
    this.seq = input.seq;
    return ev;
  }

  reconcile(ack, you) {
    if (!this.active) return;
    // Acks from before (or at) the last hard anchor point at deliberately wiped
    // ring entries — ignore them instead of anchor-looping once per RTT.
    if (ack <= this.anchorSeq) return;
    const entry = this.ring[ack & (INPUT_RING - 1)];
    if (!entry || entry.seq !== ack) {
      // Too old / wrapped (e.g. long tab-hide): hard anchor.
      if (you.state === 'ALIVE') this.anchor(you);
      return;
    }
    const p = entry.state;
    const posErr = Math.hypot(you.x - p.x, you.y - p.y, you.z - p.z);
    const velErr = Math.hypot(you.vx - p.vx, you.vy - p.vy, you.vz - p.vz);
    const gearErr = you.ammo !== p.ammo || Math.abs(you.boltMs - p.boltMs) > 80
      || Math.abs(you.reloadMs - p.reloadMs) > 80 || Math.abs(you.breath - p.breath) > 0.08;
    if (posErr <= RECON_POS_EPS && velErr <= RECON_VEL_EPS && !gearErr) return;

    const oldX = this.state.x + this.errX, oldY = this.state.y + this.errY, oldZ = this.state.z + this.errZ;
    // Rollback to the server's authoritative state at ack, replay newer inputs.
    this.state = fromServerYou(you);
    for (let s = ack + 1; s <= this.seq; s++) {
      const e = this.ring[s & (INPUT_RING - 1)];
      if (!e || e.seq !== s) continue;
      step(this.state, e.input, TICK_DT, MAP);
      e.state = cloneState(this.state);
    }
    this.prevState = cloneState(this.state);
    // The sim is always exact; only the eye is smoothed.
    this.errX = oldX - this.state.x;
    this.errY = oldY - this.state.y;
    this.errZ = oldZ - this.state.z;
    this.rollbacks++;
  }

  decaySmoothing(frameDt) {
    const k = Math.pow(0.5, frameDt / SMOOTH_HALFLIFE_S);
    this.errX *= k; this.errY *= k; this.errZ *= k;
  }

  // Render position: lerp between the last two fixed steps + decayed error offset.
  renderPos(alpha) {
    const a = this.prevState, b = this.state;
    return {
      x: a.x + (b.x - a.x) * alpha + this.errX,
      y: a.y + (b.y - a.y) * alpha + this.errY,
      z: a.z + (b.z - a.z) * alpha + this.errZ,
    };
  }
}
