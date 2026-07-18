// Scope zoom: FOV 75 -> 20 over 220 ms smoothstep, DOM overlay fading in over the
// last 40% of the zoom, and the tan-ratio sensitivity scale so flicks transfer.
import { FOV_DEG, FOV_SCOPED_DEG, SCOPE_LERP_MS } from '/shared/constants.js';

const TAN_BASE = Math.tan((FOV_DEG / 2) * Math.PI / 180);

export class Scope {
  constructor(camera, overlayEl) {
    this.camera = camera;
    this.overlay = overlayEl;
    this.t = 0;                    // 0 unscoped .. 1 scoped
    this.fov = FOV_DEG;
    this.fovScale = 1;
  }

  update(dt, wantScoped) {
    const dir = wantScoped ? 1 : -1;
    this.t = Math.min(1, Math.max(0, this.t + dir * (dt * 1000) / SCOPE_LERP_MS));
    const s = this.t * this.t * (3 - 2 * this.t);   // smoothstep
    const fov = FOV_DEG + (FOV_SCOPED_DEG - FOV_DEG) * s;
    if (Math.abs(fov - this.fov) > 0.01) {
      this.fov = fov;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.fovScale = Math.tan((fov / 2) * Math.PI / 180) / TAN_BASE;
    this.overlay.style.opacity = this.t < 0.6 ? '0' : String((this.t - 0.6) / 0.4);
  }

  isScopedVisual() { return this.t > 0.6; }
}
