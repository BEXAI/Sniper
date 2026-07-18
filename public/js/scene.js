// Three.js scene: procedural map rendering (instanced boxes by material, canvas
// textures), player rigs that EXACTLY match the server hitboxes, viewmodel, sky.
import * as THREE from '/vendor/three.module.js';
import { BOXES } from '/shared/map.js';
import { FOV_DEG, HEAD_Y, HEAD_RADIUS } from '/shared/constants.js';

// Touch devices: drop antialias and cap pixelRatio at 1.75 — fill-rate on
// mobile GPUs (iPhone) can't afford 2x MSAA'd rendering. Desktop unchanged.
const IS_TOUCH = matchMedia('(pointer: coarse)').matches ||
  new URLSearchParams(location.search).get('touch') === '1';

function noiseTexture(base, speck, density = 900, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < density; i++) {
    g.fillStyle = `rgba(${speck},${0.04 + Math.random() * 0.1})`;
    const s = 1 + Math.random() * 3;
    g.fillRect(Math.random() * size, Math.random() * size, s, s);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#4a3b28';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(30,22,12,${0.05 + Math.random() * 0.12})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  // Distance-judging grid: faint 10 m lines (texture repeats every 10 m).
  g.strokeStyle = 'rgba(120,95,60,0.25)';
  g.lineWidth = 2;
  g.strokeRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function hashHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 360) / 360;
}

export class GameScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_TOUCH });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, IS_TOUCH ? 1.75 : 2));
    this.scene = new THREE.Scene();
    // Matches the sky-shader horizon color; 0.0045 keeps ~47% transmittance at the
    // 170 m signature sightlines so far silhouettes stay readable.
    this.scene.fog = new THREE.FogExp2(0xc9763a, 0.0045);
    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 600);
    this.rigs = new Map();
    this.tmpM = new THREE.Matrix4();
    this.tmpV = new THREE.Vector3();

    this.resize();
    addEventListener('resize', () => this.resize());

    // Dusk lighting
    const hemi = new THREE.HemisphereLight(0xffd9a0, 0x2a2018, 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffb060, 1.1);
    sun.position.set(-140, 90, 60);
    this.scene.add(sun);

    // Sky: inverted sphere, dusk-orange -> deep blue vertex gradient
    const skyGeo = new THREE.SphereGeometry(450, 24, 12);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {},
      vertexShader: 'varying float vY; void main(){ vY = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying float vY;
        void main(){
          vec3 horizon = vec3(0.86, 0.48, 0.22);
          vec3 zenith = vec3(0.07, 0.09, 0.20);
          float t = clamp(vY * 1.6 + 0.12, 0.0, 1.0);
          gl_FragColor = vec4(mix(horizon, zenith, t), 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.sky);

    this.buildMap();
    this.buildViewmodel();
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  buildMap() {
    const mats = {
      ground: new THREE.MeshLambertMaterial({ map: gridTexture() }),
      rock: new THREE.MeshLambertMaterial({ map: noiseTexture('#6b5236', '90,70,45') }),
      concrete: new THREE.MeshLambertMaterial({ map: noiseTexture('#7a746a', '60,58,52') }),
      metal: new THREE.MeshLambertMaterial({ map: noiseTexture('#5a5f66', '35,38,44', 400) }),
      wall: new THREE.MeshLambertMaterial({ map: noiseTexture('#54432c', '35,28,18') }),
    };
    mats.ground.map.repeat.set(20, 12);
    const byMat = {};
    for (const box of BOXES) (byMat[box.mat] ||= []).push(box);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const [mat, boxes] of Object.entries(byMat)) {
      const mesh = new THREE.InstancedMesh(geo, mats[mat] || mats.rock, boxes.length);
      boxes.forEach((b, i) => {
        const sx = b.max[0] - b.min[0], sy = b.max[1] - b.min[1], sz = b.max[2] - b.min[2];
        this.tmpM.makeScale(sx, sy, sz);
        this.tmpM.setPosition(b.min[0] + sx / 2, b.min[1] + sy / 2, b.min[2] + sz / 2);
        mesh.setMatrixAt(i, this.tmpM);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
    }
  }

  buildViewmodel() {
    this.viewmodel = new THREE.Group();
    const wood = new THREE.MeshLambertMaterial({ color: 0x4a3520 });
    const steel = new THREE.MeshLambertMaterial({ color: 0x2c2f33 });
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.7), steel);
    barrel.position.set(0.16, -0.14, -0.5);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.42), wood);
    body.position.set(0.16, -0.17, -0.22);
    const scope = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.16), steel);
    scope.position.set(0.16, -0.1, -0.28);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.09), new THREE.MeshLambertMaterial({ color: 0xb08d63 }));
    hand.position.set(0.16, -0.19, -0.38);
    this.viewmodel.add(barrel, body, scope, hand);
    this.camera.add(this.viewmodel);
    this.scene.add(this.camera);
    this.vmBobPhase = 0;
    this.vmRecoil = 0;
  }

  updateViewmodel(dt, speed, scoped) {
    this.viewmodel.visible = !scoped;
    this.vmBobPhase += dt * (2 + speed * 1.4);
    this.vmRecoil = Math.max(0, this.vmRecoil - dt * 3.3);   // ~300 ms recovery
    const bob = speed > 0.3 ? Math.sin(this.vmBobPhase * 3.2) * 0.008 : 0;
    this.viewmodel.position.set(0, bob, this.vmRecoil * 0.08);
  }

  kickRecoil() { this.vmRecoil = 1; }

  ensureRig(id, name) {
    let rig = this.rigs.get(id);
    if (rig) return rig;
    const hue = hashHue(id);
    const bodyMat = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(hue, 0.42, 0.42) });
    const root = new THREE.Group();

    const yawGroup = new THREE.Group();
    root.add(yawGroup);
    // Body capsule: segment 0.4 -> 1.3, r 0.4 — matches server hitbox exactly.
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.9, 4, 10), bodyMat);
    body.position.y = 0.85;
    yawGroup.add(body);

    // Head: r 0.22 at 1.62, visibly proud of the shoulders.
    const pitchGroup = new THREE.Group();
    pitchGroup.position.y = HEAD_Y;
    yawGroup.add(pitchGroup);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_RADIUS, 12, 10),
      new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(hue, 0.3, 0.6) }),
    );
    pitchGroup.add(head);

    // Rifle: 3 boxes following head pitch.
    const steel = new THREE.MeshLambertMaterial({ color: 0x24262a });
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 1.1), steel);
    barrel.position.set(0.24, -0.18, -0.6);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.4), new THREE.MeshLambertMaterial({ color: 0x3d2c18 }));
    stock.position.set(0.24, -0.2, -0.06);
    const scopeBox = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.2), steel);
    scopeBox.position.set(0.24, -0.1, -0.35);
    pitchGroup.add(barrel, stock, scopeBox);

    // Blob shadow
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    root.add(shadow);

    // Nametag sprite (canvas — inherently XSS-safe)
    const nc = document.createElement('canvas');
    nc.width = 256; nc.height = 40;
    const g = nc.getContext('2d');
    g.font = 'bold 24px monospace';
    g.textAlign = 'center';
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, 0, 256, 40);
    g.fillStyle = '#e8dcc8';
    g.fillText(String(name).slice(0, 16), 128, 28);
    const tagTex = new THREE.CanvasTexture(nc);
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTex, depthTest: true }));
    tag.scale.set(1.6, 0.25, 1);
    tag.position.y = 2.15;
    root.add(tag);

    rig = { root, yawGroup, pitchGroup, tag, body, dead: false, toppleT: 0 };
    this.rigs.set(id, rig);
    this.scene.add(root);
    return rig;
  }

  updateRig(id, pose, camPos, dt) {
    const rig = this.rigs.get(id);
    if (!rig) return;
    rig.root.position.set(pose.x, pose.y, pose.z);
    rig.yawGroup.rotation.y = pose.yaw;
    rig.pitchGroup.rotation.x = pose.pitch;
    rig.tag.visible = camPos.distanceTo(rig.root.position) < 60 && !rig.dead;
    if (pose.st === 'DEAD') {
      if (!rig.dead) { rig.dead = true; rig.toppleT = 0; }
      rig.toppleT = Math.min(1, rig.toppleT + dt * 3.3);
      rig.yawGroup.rotation.x = -(Math.PI / 2) * rig.toppleT;
      rig.root.visible = rig.toppleT < 1 || true; // stays toppled until hidden by cam end
    } else {
      rig.dead = false;
      rig.yawGroup.rotation.x = 0;
      rig.root.visible = true;
    }
  }

  setRigVisible(id, v) {
    const rig = this.rigs.get(id);
    if (rig) rig.root.visible = v;
  }

  muzzleWorld(id) {
    const rig = this.rigs.get(id);
    if (!rig) return null;
    this.tmpV.set(0.24, -0.05, -1.1);
    rig.pitchGroup.localToWorld(this.tmpV);
    return this.tmpV.clone();
  }

  removeRig(id) {
    const rig = this.rigs.get(id);
    if (!rig) return;
    this.scene.remove(rig.root);
    this.rigs.delete(id);
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

export { THREE };
