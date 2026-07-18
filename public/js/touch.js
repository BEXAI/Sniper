// Touch controls for mobile (iOS WebKit): dynamic virtual stick + aim drag +
// action buttons. Owns every touch listener and drives the existing Input
// instance's public fields (keys/yaw/pitch/pendingFire) so the game loop and
// desktop path stay unchanged. Multi-touch safe: the stick, the aim drag, and
// each button track their own touch identifiers independently.
import { BTN } from '/shared/constants.js';
import { clamp } from '/shared/math.js';

const AIM_SENS = 0.006;                // rad per px before sensitivity/fov scaling
const STICK_DEADZONE = 20;             // px before movement bits engage
const STICK_RADIUS = 56;               // px knob travel clamp
const PULSE_MS = 100;                  // JUMP/RELOAD one-shot hold window (~3 ticks)
const STICK_ZONE_FRAC = 0.4;           // left 40% = stick, right 60% = aim
const MOVE_MASK = BTN.FWD | BTN.BACK | BTN.LEFT | BTN.RIGHT;

// 8-way sector -> movement bits, 45° sectors counter-clockwise from screen-east.
const SECTOR_BITS = [
  BTN.RIGHT,                // E
  BTN.FWD | BTN.RIGHT,      // NE
  BTN.FWD,                  // N
  BTN.FWD | BTN.LEFT,       // NW
  BTN.LEFT,                 // W
  BTN.BACK | BTN.LEFT,      // SW
  BTN.BACK,                 // S
  BTN.BACK | BTN.RIGHT,     // SE
];

export class TouchControls {
  constructor(input, getRenderTt) {
    this.input = input;
    this.getRenderTt = getRenderTt;
    this.enabled = false;

    this.ui = document.getElementById('touchUI');
    this.canvas = document.getElementById('game');
    this.stickBase = document.getElementById('stickBase');
    this.stickKnob = document.getElementById('stickKnob');
    this.rotateGate = document.getElementById('rotateGate');
    this.btnScope = document.getElementById('btnScope');

    this.stickId = null;
    this.stickOrigin = { x: 0, y: 0 };
    this.aimId = null;
    this.aimLast = { x: 0, y: 0 };
    this.buttonTouches = new Map();    // touch identifier -> button spec
    this.jumpTimer = 0;
    this.reloadTimer = 0;

    // Inline placement so the stick tracks the finger regardless of stylesheet
    // layout: base is fixed at the touch point, knob centered in base + delta.
    this.stickBase.style.position = 'fixed';
    this.stickBase.style.transform = 'translate(-50%, -50%)';
    this.stickKnob.style.position = 'absolute';
    this.stickKnob.style.left = '50%';
    this.stickKnob.style.top = '50%';
    this.stickKnob.style.transform = 'translate(-50%, -50%)';

    // Each button owns its touches via a press count so a second finger on the
    // same button can't double-trigger or half-release it.
    this.buttons = [
      { el: document.getElementById('btnFire'), count: 0,
        press: () => {
          this.input.keys |= BTN.FIRE;
          if (!this.input.pendingFire) this.input.pendingFire = { tt: this.getRenderTt() };
        },
        release: () => { this.input.keys &= ~BTN.FIRE; } },
      { el: this.btnScope, count: 0,
        press: () => {
          this.input.keys ^= BTN.SCOPE;
          this.btnScope.classList.toggle('active', (this.input.keys & BTN.SCOPE) !== 0);
        },
        release: () => {} },
      { el: document.getElementById('btnBreath'), count: 0,
        press: () => { this.input.keys |= BTN.BREATH; },
        release: () => { this.input.keys &= ~BTN.BREATH; } },
      { el: document.getElementById('btnJump'), count: 0,
        press: () => {
          this.input.keys |= BTN.JUMP;
          clearTimeout(this.jumpTimer);
          this.jumpTimer = setTimeout(() => { this.input.keys &= ~BTN.JUMP; }, PULSE_MS);
        },
        release: () => {} },
      { el: document.getElementById('btnReload'), count: 0,
        press: () => {
          this.input.keys |= BTN.RELOAD;
          clearTimeout(this.reloadTimer);
          this.reloadTimer = setTimeout(() => { this.input.keys &= ~BTN.RELOAD; }, PULSE_MS);
        },
        release: () => {} },
      { el: document.getElementById('btnBoard'), count: 0,
        press: () => { this.input.scoreboardHeld = !this.input.scoreboardHeld; },
        release: () => {} },
    ];

    this.onTouchStart = (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        const btn = this.buttons.find((b) => b.el === t.target || b.el.contains(t.target));
        if (btn) {
          this.buttonTouches.set(t.identifier, btn);
          btn.count += 1;
          if (btn.count === 1) btn.press();
        } else if (t.clientX < window.innerWidth * STICK_ZONE_FRAC) {
          if (this.stickId === null) this.startStick(t);
        } else if (this.aimId === null) {
          this.aimId = t.identifier;
          this.aimLast.x = t.clientX;
          this.aimLast.y = t.clientY;
        }
      }
    };

    this.onTouchMove = (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === this.stickId) {
          this.moveStick(t);
        } else if (t.identifier === this.aimId) {
          const s = AIM_SENS * this.input.sensitivity * this.input.fovScale;
          this.input.yaw -= (t.clientX - this.aimLast.x) * s;
          this.input.pitch = clamp(this.input.pitch - (t.clientY - this.aimLast.y) * s, -1.55, 1.55);
          this.aimLast.x = t.clientX;
          this.aimLast.y = t.clientY;
        }
      }
    };

    this.onTouchEnd = (e) => {
      e.preventDefault();
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        const btn = this.buttonTouches.get(t.identifier);
        if (btn) {
          this.buttonTouches.delete(t.identifier);
          btn.count -= 1;
          if (btn.count === 0) btn.release();
        } else if (t.identifier === this.stickId) {
          this.endStick();
        } else if (t.identifier === this.aimId) {
          this.aimId = null;
        }
      }
    };

    // iOS hygiene: block pinch zoom over the game and long-press menus on the UI.
    this.onGesture = (e) => e.preventDefault();
    this.onContextMenu = (e) => e.preventDefault();

    // Portrait shows the rotate gate; the game keeps running behind it.
    this.onViewport = () => {
      this.rotateGate.classList.toggle('hidden', window.innerHeight <= window.innerWidth);
    };
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.ui.classList.remove('hidden');
    this.ui.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.ui.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.ui.addEventListener('touchend', this.onTouchEnd, { passive: false });
    this.ui.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
    this.ui.addEventListener('contextmenu', this.onContextMenu);
    this.ui.addEventListener('gesturestart', this.onGesture);
    this.canvas.addEventListener('gesturestart', this.onGesture);
    window.addEventListener('resize', this.onViewport);
    window.addEventListener('orientationchange', this.onViewport);
    this.onViewport();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.ui.removeEventListener('touchstart', this.onTouchStart);
    this.ui.removeEventListener('touchmove', this.onTouchMove);
    this.ui.removeEventListener('touchend', this.onTouchEnd);
    this.ui.removeEventListener('touchcancel', this.onTouchEnd);
    this.ui.removeEventListener('contextmenu', this.onContextMenu);
    this.ui.removeEventListener('gesturestart', this.onGesture);
    this.canvas.removeEventListener('gesturestart', this.onGesture);
    window.removeEventListener('resize', this.onViewport);
    window.removeEventListener('orientationchange', this.onViewport);
    this.ui.classList.add('hidden');
    this.rotateGate.classList.add('hidden');
    this.endStick();
    this.aimId = null;
    this.buttonTouches.clear();
    for (const b of this.buttons) b.count = 0;
    clearTimeout(this.jumpTimer);
    clearTimeout(this.reloadTimer);
    this.btnScope.classList.remove('active');
    this.input.keys &= ~(MOVE_MASK | BTN.FIRE | BTN.SCOPE | BTN.BREATH | BTN.JUMP | BTN.RELOAD);
    this.input.scoreboardHeld = false;
  }

  startStick(t) {
    this.stickId = t.identifier;
    this.stickOrigin.x = t.clientX;
    this.stickOrigin.y = t.clientY;
    this.stickBase.style.left = t.clientX + 'px';
    this.stickBase.style.top = t.clientY + 'px';
    this.stickBase.classList.remove('hidden');
    this.moveStick(t);
  }

  moveStick(t) {
    let dx = t.clientX - this.stickOrigin.x;
    let dy = t.clientY - this.stickOrigin.y;
    const dist = Math.hypot(dx, dy);
    if (dist > STICK_RADIUS) {
      dx *= STICK_RADIUS / dist;
      dy *= STICK_RADIUS / dist;
    }
    this.stickKnob.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px)`;
    let bits = 0;
    if (dist > STICK_DEADZONE) {
      const sector = ((Math.round(Math.atan2(-dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
      bits = SECTOR_BITS[sector];
    }
    this.input.keys = (this.input.keys & ~MOVE_MASK) | bits;
  }

  endStick() {
    this.stickId = null;
    this.stickBase.classList.add('hidden');
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
    this.input.keys &= ~MOVE_MASK;
  }
}
