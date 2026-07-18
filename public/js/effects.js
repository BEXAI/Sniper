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

// Colder white-blue variant for scope glints — reads as glass, not muzzle fire.
function coldGlintTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(214,232,255,0.9)');
  grad.addColorStop(1, 'rgba(150,190,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// Shared unit primitives for tracer/beam bodies — oriented and stretched per
// use via position/quaternion/scale, never disposed (module lifetime).
const UP = new THREE.Vector3(0, 1, 0);
const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true);

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
    this.coldGlintTex = coldGlintTexture();
    this.outlineTex = outlineTexture();
    this.lastGlintCheck = 0;
  }

  // Tracer travels visually at 400 m/s along the TRUE server ray, then a smoke
  // trail lingers 500 ms. The bright head is a thin stretched additive cylinder
  // (~6 cm) plus a glow sprite, fog off, so rounds still read at 150 m.
  tracer(o, end) {
    const from = new THREE.Vector3(...o);
    const to = new THREE.Vector3(...end);
    const dist = from.distanceTo(to);
    const dur = dist / TRACER_SPEED;
    const dir = to.clone().sub(from).normalize();

    // Smoke line revealed progressively behind the moving head, not full-span.
    const smokeGeo = new THREE.BufferGeometry().setFromPoints([from, from.clone()]);
    const smoke = new THREE.Line(smokeGeo, new THREE.LineBasicMaterial({
      color: 0xcbb89a, transparent: true, opacity: 0.4,
    }));
    this.scene.add(smoke);

    const seg = new THREE.Mesh(unitCyl, new THREE.MeshBasicMaterial({
      color: 0xffedc4, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 1, fog: false,
    }));
    seg.quaternion.setFromUnitVectors(UP, dir);       // direction never changes
    seg.position.copy(from);
    seg.scale.set(0.06, 0.001, 0.06);
    this.scene.add(seg);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glintTex, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 0.9, fog: false,
    }));
    glow.position.copy(from);
    glow.scale.setScalar(0.5);
    this.scene.add(glow);

    this.live.push({
      t: 0,
      update: (item, dt) => {
        item.t += dt;
        const f = Math.min(1, item.t / Math.max(0.02, dur));
        const head = from.clone().lerp(to, f);
        const tail = from.clone().lerp(to, Math.max(0, f - 8 / Math.max(8, dist)));
        seg.position.copy(tail).add(head).multiplyScalar(0.5);
        seg.scale.y = Math.max(0.001, tail.distanceTo(head));
        glow.position.copy(head);
        if (f >= 1) glow.visible = false;             // impact puff takes over
        smoke.geometry.setFromPoints([from, head]);
        smoke.material.opacity = 0.4 * Math.max(0, 1 - item.t / 0.5);
        if (item.t > 0.15 + dur) { seg.visible = false; }
        if (item.t > 0.5 + dur) {
          this.scene.remove(seg, glow, smoke);
          seg.material.dispose(); glow.material.dispose();   // unitCyl is shared
          smoke.geometry.dispose(); smoke.material.dispose();
          return false;
        }
        return true;
      },
    });
  }

  // Double sprite: bright core + larger soft halo. World size is clamped so the
  // flash never covers more than ~40 px of screen height at point-blank range.
  muzzleFlash(pos) {
    if (!pos) return;
    const dist = Math.max(0.5, pos.distanceTo(this.gs.camera.position));
    const worldPerPx = 2 * Math.tan((this.gs.camera.fov / 2) * Math.PI / 180) * dist / innerHeight;
    const k = Math.min(1, (worldPerPx * 40) / 1.6);   // 1.6 m halo is the largest
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glintTex, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 1,
    }));
    core.position.copy(pos);
    core.scale.setScalar(0.7 * k);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glintTex, color: 0xffb35c, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0.5,
    }));
    halo.position.copy(pos);
    halo.scale.setScalar(1.6 * k);
    this.scene.add(core, halo);
    this.live.push({
      t: 0,
      update: (item, dt) => {
        item.t += dt;
        core.material.opacity = Math.max(0, 1 - item.t / 0.07);
        halo.material.opacity = 0.5 * Math.max(0, 1 - item.t / 0.11);
        if (item.t > 0.11) {
          this.scene.remove(core, halo);
          core.material.dispose(); halo.material.dispose();
          return false;
        }
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

  // Core line + a slightly thicker additive glow pass, both pulsing at ~2.5 Hz
  // (opacity 0.5..1.0) until clearDeathBeam().
  deathBeam(o, end) {
    const from = new THREE.Vector3(...o);
    const to = new THREE.Vector3(...end);
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xff3a2a, transparent: true, opacity: 0.9, depthTest: false,
    }));
    line.renderOrder = 999;
    const glow = new THREE.Mesh(unitCyl, new THREE.MeshBasicMaterial({
      color: 0xff5a3a, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 0.35, depthTest: false, fog: false,
    }));
    glow.position.copy(from).add(to).multiplyScalar(0.5);
    glow.quaternion.setFromUnitVectors(UP, to.clone().sub(from).normalize());
    glow.scale.set(0.1, from.distanceTo(to), 0.1);
    glow.renderOrder = 998;
    const group = new THREE.Group();
    group.add(line, glow);
    this.scene.add(group);
    this.beam = group;
    this.beamLine = line;
    this.beamGlow = glow;
    this.live.push({
      t: 0,
      update: (item, dt) => {
        if (this.beam !== group) return false;       // cleared by clearDeathBeam()
        item.t += dt;
        const pulse = 0.75 + 0.25 * Math.sin(item.t * Math.PI * 5);   // 2.5 Hz
        line.material.opacity = pulse;
        glow.material.opacity = 0.35 * pulse;
        return true;
      },
    });
  }

  clearDeathBeam() {
    if (this.beam) {
      this.scene.remove(this.beam);
      this.beamLine.geometry.dispose(); this.beamLine.material.dispose();
      this.beamGlow.material.dispose();              // unitCyl is shared
      this.beam = this.beamLine = this.beamGlow = null;
    }
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
          map: this.coldGlintTex, blending: THREE.AdditiveBlending, depthWrite: false,
          transparent: true, opacity: 0.95,
        }));
        g.userData.seed = Math.random() * 1600;      // desyncs twinkles per player
        g.userData.base = 0.35;
        this.scene.add(g);
        this.glints.set(id, g);
      }
      g.visible = true;
      g.position.set(gx, gy, gz);
      // Distance-scaled but never below ~8 px of screen height — the per-frame
      // twinkle in update() only multiplies UP from this floor, never below it.
      const worldPerPx = 2 * Math.tan((fovDeg / 2) * Math.PI / 180) * dist / canvasHeight;
      g.userData.base = Math.max(worldPerPx * 8, 0.35);
      g.scale.setScalar(g.userData.base);
    }
    for (const [id, g] of this.glints) if (!seen.has(id)) g.visible = false;
  }

  hideGlint(id) {
    const g = this.glints.get(id);
    if (g) g.visible = false;
  }

  removeGlint(id) {
    const g = this.glints.get(id);
    if (g) { this.scene.remove(g); g.material.dispose(); this.glints.delete(id); }
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (!this.live[i].update(this.live[i], dt)) this.live.splice(i, 1);
    }
    // Glint twinkle runs per frame (not in the 5 Hz LOS pass) so the ~120 ms
    // lens-catch spike every ~1.6 s is never skipped between checks.
    const nowMs = performance.now();
    for (const g of this.glints.values()) {
      if (!g.visible) continue;
      const tick = (nowMs + g.userData.seed) % 1600;
      const spike = tick < 120 ? 1 + Math.sin((tick / 120) * Math.PI) : 1;   // up to 2x
      const pulse = 1 + Math.sin((nowMs + g.userData.seed) / 90) * 0.15;
      g.scale.setScalar(Math.max(g.userData.base, g.userData.base * pulse) * spike);
      g.material.color.setScalar(spike);             // >1 brightens the additive pass
      g.material.opacity = Math.min(1, 0.95 * spike);
    }
  }
}
