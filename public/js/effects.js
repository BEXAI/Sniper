// World-space effects: traveling tracers with smoke trails, muzzle flashes, scope
// glints, the death-ray beam, and the through-wall killer outline.
import { THREE } from './scene.js';
import { BOXES } from '/shared/map.js';
import { rayVsBoxes } from '/shared/math.js';
import { TRACER_SPEED, EYE_HEIGHT } from '/shared/constants.js';

function glintTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,246,220,1)');
  grad.addColorStop(0.3, 'rgba(255,214,120,0.9)');
  grad.addColorStop(1, 'rgba(255,180,60,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function outlineTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = 'rgba(232,74,61,0.95)';
  g.lineWidth = 5;
  g.beginPath();
  g.arc(32, 22, 12, 0, Math.PI * 2);          // head
  g.moveTo(32, 38);
  g.roundRect(14, 40, 36, 74, 16);            // body
  g.stroke();
  return new THREE.CanvasTexture(c);
}

export class Effects {
  constructor(gs) {
    this.gs = gs;
    this.scene = gs.scene;
    this.live = [];                            // animated items
    this.glints = new Map();
    this.glintTex = glintTexture();
    this.outlineTex = outlineTexture();
    this.lastGlintCheck = 0;
  }

  // Tracer travels visually at 400 m/s along the TRUE server ray, then a smoke
  // trail lingers 500 ms.
  tracer(o, end) {
    const from = new THREE.Vector3(...o);
    const to = new THREE.Vector3(...end);
    const dist = from.distanceTo(to);
    const dur = dist / TRACER_SPEED;

    const smokeGeo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const smoke = new THREE.Line(smokeGeo, new THREE.LineBasicMaterial({
      color: 0xcbb89a, transparent: true, opacity: 0.4,
    }));
    this.scene.add(smoke);

    const segGeo = new THREE.BufferGeometry().setFromPoints([from.clone(), from.clone()]);
    const seg = new THREE.Line(segGeo, new THREE.LineBasicMaterial({
      color: 0xffe3a0, transparent: true, opacity: 1,
    }));
    this.scene.add(seg);

    this.live.push({
      t: 0,
      update: (item, dt) => {
        item.t += dt;
        const f = Math.min(1, item.t / Math.max(0.02, dur));
        const head = from.clone().lerp(to, f);
        const tail = from.clone().lerp(to, Math.max(0, f - 8 / Math.max(8, dist)));
        seg.geometry.setFromPoints([tail, head]);
        smoke.material.opacity = 0.4 * Math.max(0, 1 - item.t / 0.5);
        if (item.t > 0.15 + dur) { seg.visible = false; }
        if (item.t > 0.5 + dur) {
          this.scene.remove(seg, smoke);
          seg.geometry.dispose(); smoke.geometry.dispose();
          return false;
        }
        return true;
      },
    });
  }

  muzzleFlash(pos) {
    if (!pos) return;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glintTex, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 1,
    }));
    s.position.copy(pos);
    s.scale.set(0.8, 0.8, 1);
    this.scene.add(s);
    this.live.push({
      t: 0,
      update: (item, dt) => {
        item.t += dt;
        s.material.opacity = 1 - item.t / 0.07;
        if (item.t > 0.07) { this.scene.remove(s); s.material.dispose(); return false; }
        return true;
      },
    });
  }

  // Impact puff at a ray terminus: dust on walls, red on flesh, gold on heads —
  // gives ranging misses and 150 m third-party hits a world-space read.
  impact(end, kind) {
    const colors = { dust: 0xcbb089, flesh: 0xd8402a, head: 0xffd77e };
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glintTex, color: colors[kind] || colors.dust,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9,
    }));
    s.position.set(end[0], end[1], end[2]);
    s.scale.setScalar(0.4);
    this.scene.add(s);
    this.live.push({
      t: 0,
      update: (item, dt) => {
        item.t += dt;
        const f = item.t / 0.3;
        s.scale.setScalar(0.4 + f * 0.9);
        s.material.opacity = 0.9 * Math.max(0, 1 - f);
        if (f >= 1) { this.scene.remove(s); s.material.dispose(); return false; }
        return true;
      },
    });
  }

  deathBeam(o, end) {
    const from = new THREE.Vector3(...o);
    const to = new THREE.Vector3(...end);
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xff3a2a, transparent: true, opacity: 0.9, depthTest: false,
    }));
    line.renderOrder = 999;
    this.scene.add(line);
    this.beam = line;
  }

  clearDeathBeam() {
    if (this.beam) { this.scene.remove(this.beam); this.beam.geometry.dispose(); this.beam = null; }
    if (this.outline) { this.scene.remove(this.outline); this.outline = null; }
  }

  // Per-frame retarget: the outline tracks the killer's live interpolated pose.
  moveOutline(kp) {
    if (this.outline) this.outline.position.set(kp.x, kp.y + 0.95, kp.z);
  }

  // Killer died/left mid-cam: drop the outline rather than freeze a stale ghost.
  dropOutline() {
    if (this.outline) { this.scene.remove(this.outline); this.outline = null; }
  }

  killerOutline(pos) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.outlineTex, depthTest: false, transparent: true, opacity: 0.9,
    }));
    s.position.set(pos.x, pos.y + 0.95, pos.z);
    s.scale.set(1.1, 2.1, 1);
    s.renderOrder = 998;
    this.scene.add(s);
    this.outline = s;
    this.live.push({
      t: 0,
      update: (item, dt) => {
        item.t += dt;
        s.material.opacity = 0.9 * Math.max(0, 1 - item.t / 2);
        if (item.t > 2) { if (this.outline === s) this.outline = null; this.scene.remove(s); return false; }
        return true;
      },
    });
  }

  // Scope glint: remote scoped players aiming within 10 degrees of my camera with
  // clear LOS get an additive sprite at the muzzle, always >= ~8 px on screen.
  updateGlints(remotes, myEye, nowMs, canvasHeight, fovDeg) {
    if (nowMs - this.lastGlintCheck < 200) return;   // 5 Hz
    this.lastGlintCheck = nowMs;
    const seen = new Set();
    for (const [id, pose] of remotes) {
      if (!pose.sc || pose.st !== 'ALIVE') continue;
      const gx = pose.x, gy = pose.y + EYE_HEIGHT, gz = pose.z;
      const toMe = new THREE.Vector3(myEye.x - gx, myEye.y - gy, myEye.z - gz);
      const dist = toMe.length();
      if (dist < 4) continue;
      toMe.normalize();
      const aim = new THREE.Vector3(
        -Math.sin(pose.yaw) * Math.cos(pose.pitch),
        Math.sin(pose.pitch),
        -Math.cos(pose.yaw) * Math.cos(pose.pitch),
      );
      if (aim.dot(toMe) < Math.cos(10 * Math.PI / 180)) { this.hideGlint(id); continue; }
      const wallT = rayVsBoxes([gx, gy, gz], [toMe.x, toMe.y, toMe.z], BOXES, dist);
      if (wallT < dist) { this.hideGlint(id); continue; }
      seen.add(id);
      let g = this.glints.get(id);
      if (!g) {
        g = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glintTex, blending: THREE.AdditiveBlending, depthWrite: false,
          transparent: true, opacity: 0.95,
        }));
        this.scene.add(g);
        this.glints.set(id, g);
      }
      g.visible = true;
      g.position.set(gx, gy, gz);
      // Distance-scaled but never below ~8 px of screen height — the floor is
      // applied AFTER the pulse so the trough never dips under the guarantee.
      const worldPerPx = 2 * Math.tan((fovDeg / 2) * Math.PI / 180) * dist / canvasHeight;
      const pulsed = Math.max(0.35, worldPerPx * 8) * (1 + Math.sin(nowMs / 90) * 0.15);
      g.scale.setScalar(Math.max(worldPerPx * 8, 0.35, pulsed));
    }
    for (const [id, g] of this.glints) if (!seen.has(id)) g.visible = false;
  }

  hideGlint(id) {
    const g = this.glints.get(id);
    if (g) g.visible = false;
  }

  removeGlint(id) {
    const g = this.glints.get(id);
    if (g) { this.scene.remove(g); this.glints.delete(id); }
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (!this.live[i].update(this.live[i], dt)) this.live.splice(i, 1);
    }
  }
}
