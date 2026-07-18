// Pointer-lock mouse look + per-tick input sampling. Fire is edge-latched at click
// time (with its render-time stamp) so sub-tick clicks always fire.
import { BTN, INTERP_DELAY_MS } from '/shared/constants.js';
import { clamp } from '/shared/math.js';

const BASE_SENS = 0.0022;

export class Input {
  constructor(canvas, getRenderTt) {
    this.canvas = canvas;
    this.getRenderTt = getRenderTt;   // () => serverTime() - INTERP_DELAY at click
    this.yaw = 0;
    this.pitch = 0;
    this.keys = 0;
    this.pendingFire = null;          // { tt } latched at mousedown
    this.sensitivity = 1;
    this.fovScale = 1;                // tan(fov/2)/tan(75/2) — zoom-consistent flicks
    this.scoreboardHeld = false;
    this.enabled = false;
    this.onEscape = null;

    document.addEventListener('mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== canvas) return;
      this.yaw -= e.movementX * BASE_SENS * this.sensitivity * this.fovScale;
      this.pitch -= e.movementY * BASE_SENS * this.sensitivity * this.fovScale;
      this.pitch = clamp(this.pitch, -1.55, 1.55);
    });

    document.addEventListener('mousedown', (e) => {
      if (!this.enabled || document.pointerLockElement !== canvas) return;
      if (e.button === 0) {
        this.keys |= BTN.FIRE;
        if (!this.pendingFire) this.pendingFire = { tt: this.getRenderTt() };
      }
      if (e.button === 2) this.keys |= BTN.SCOPE;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.keys &= ~BTN.FIRE;
      if (e.button === 2) this.keys &= ~BTN.SCOPE;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    const keymap = {
      KeyW: BTN.FWD, KeyS: BTN.BACK, KeyA: BTN.LEFT, KeyD: BTN.RIGHT,
      Space: BTN.JUMP, ShiftLeft: BTN.BREATH, ShiftRight: BTN.BREATH, KeyR: BTN.RELOAD,
    };
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') { e.preventDefault(); this.scoreboardHeld = true; return; }
      if (e.code === 'Escape') { this.releaseAll(); this.onEscape && this.onEscape(); return; }
      if (!this.enabled) return;
      const bit = keymap[e.code];
      if (bit) { e.preventDefault(); this.keys |= bit; }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') { e.preventDefault(); this.scoreboardHeld = false; return; }
      const bit = keymap[e.code];
      if (bit) this.keys &= ~bit;
    });

    // Losing pointer lock (Esc, alt-tab) releases everything — the last-sent input
    // is neutral, so server-side starvation re-application is harmless.
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== canvas) this.releaseAll();
    });
  }

  releaseAll() { this.keys = 0; this.pendingFire = null; }

  lock() {
    this.canvas.requestPointerLock();
  }

  setViewFromSpawn(yaw) { this.yaw = yaw; this.pitch = 0; }

  sample(seq) {
    const input = { seq, b: this.keys, yaw: this.yaw, pitch: this.pitch };
    if (this.pendingFire) {
      input.fire = { tt: this.pendingFire.tt };
      this.pendingFire = null;
    }
    return input;
  }

  neutral(seq) { return { seq, b: 0, yaw: this.yaw, pitch: this.pitch }; }
}
