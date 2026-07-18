// GLINT client bootstrap + game loop. Menu -> pointer lock -> predict/send at 30 Hz,
// interpolate remotes at renderTime-100ms, render effects/HUD, survive disconnects.
import { GameScene, THREE } from './scene.js';
import { Net } from './net.js';
import { Prediction } from './prediction.js';
import { Interp } from './interpolation.js';
import { Input } from './input.js';
import { Scope } from './scope.js';
import { Effects } from './effects.js';
import { Hud, dedupeNames } from './hud.js';
import { GameAudio } from './audio.js';
import { swayOffsetDeg } from '/shared/sway.js';
import { normalizeAngle } from '/shared/math.js';
import {
  TICK_DT, INTERP_DELAY_MS, ACCUMULATOR_CAP_S, EYE_HEIGHT, DEATH_CAM_MS, RANKS,
  UNSCOPED_CONE_DEG, FOV_DEG,
} from '/shared/constants.js';

const DEG = Math.PI / 180;

const qs = new URLSearchParams(location.search);
const SPECTATE = qs.get('spectate') === '1';
const FAKELAG = Number(qs.get('fakelag')) || 0;
const JITTER = Number(qs.get('jitter')) || 0;

// Touch devices: desktop-only interstitial (spectate still works with drag-look).
if (matchMedia('(pointer: coarse)').matches && !SPECTATE) {
  document.getElementById('touchGate').classList.remove('hidden');
  document.getElementById('menu').classList.add('hidden');
  throw new Error('desktop-only');
}

const canvas = document.getElementById('game');
const gs = new GameScene(canvas);
const hud = new Hud();
const audio = new GameAudio();
const effects = new Effects(gs);
const scope = new Scope(gs.camera, document.getElementById('scopeOverlay'));
const interp = new Interp();
const pred = new Prediction();

gs.camera.rotation.order = 'YXZ';

let net = null;
let phase = 'menu';               // menu | connecting | playing | spectating
let myPid = null;
let mySwaySeed = 1;
let roster = new Map();           // id -> {name, rank}
let scoreRows = new Map();        // id -> {k, d, streak, ping}
let match = { state: 'LIVE', endsAt: 0 };
let you = null;
let lastEventId = 0;
let needAnchor = false;
let recentShots = new Map();
let deathCam = null;
let deathAt = 0;
let intermissionData = null;
let seq = 0;
let acc = 0;
let paused = false;
let reconnectDelay = 1000;
let everWelcomed = false;
let intentionalClose = false;
let prevHolding = false;
let prevReloadMs = 0;
let recoilPitch = 0;                          // 1.2 deg camera kick, 300 ms recovery
let myDeaths = 0;
let hintShownAt = 0;
let killedMeBy = new Map();       // killerPid -> kills on me this round (REVENGE/NEMESIS)
let finalMinuteShown = false;      // one 'FINAL MINUTE' callout per round
let lastCountdownSec = 0;          // dedupes the last-5s ticks to one per second
const spectateCam = { x: 0, y: 26, z: 46, yaw: 0, pitch: -0.4 };

const identity = (() => {
  try { return JSON.parse(localStorage.getItem('glintIdentity')) || null; } catch { return null; }
})();
let savedIdentity = identity;

const input = new Input(canvas, () => (net ? net.serverTime() - INTERP_DELAY_MS : 0));
input.sensitivity = Number(localStorage.getItem('glintSens')) || 1;
audio.volume = localStorage.getItem('glintVol') !== null ? Number(localStorage.getItem('glintVol')) : 0.7;

// ---------------- Menu ----------------
const nameInput = document.getElementById('nameInput');
const sensSlider = document.getElementById('sensSlider');
const volSlider = document.getElementById('volSlider');
nameInput.value = (savedIdentity && savedIdentity.name) || localStorage.getItem('glintName') || '';
sensSlider.value = String(input.sensitivity);
volSlider.value = String(audio.volume);
sensSlider.oninput = () => { input.sensitivity = Number(sensSlider.value); localStorage.setItem('glintSens', sensSlider.value); };
volSlider.oninput = () => { audio.setVolume(Number(volSlider.value)); localStorage.setItem('glintVol', volSlider.value); };

async function refreshMenu() {
  try {
    const lb = await (await fetch('/api/leaderboard?limit=10')).json();
    hud.leaderboard(lb.rows || []);
    hud.season(!lb.persistent);
  } catch { /* server waking */ }
  try {
    const st = await (await fetch('/api/status')).json();
    const r0 = st.rooms && st.rooms[0];
    if (r0) hud.menuStatus(`${r0.humans + r0.bots} in The Ravine · match ${r0.phase.toLowerCase()}`);
  } catch {
    hud.menuStatus('server waking up…');
  }
}

document.getElementById('playBtn').addEventListener('click', play);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') play(); });

async function play() {
  const name = nameInput.value.trim();
  if (!name) { hud.nameError('pick a callsign'); return; }
  hud.nameError(null);
  audio.ensure();
  try {
    const body = { name };
    if (savedIdentity) { body.pid = savedIdentity.pid; body.token = savedIdentity.token; }
    const res = await fetch('/api/guest', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (res.ok) {
      savedIdentity = await res.json();
      localStorage.setItem('glintIdentity', JSON.stringify(savedIdentity));
    } else if (res.status === 400) {
      hud.nameError((await res.json()).error || 'name not allowed');
      return;
    }
  } catch { /* play anonymously; guest chip will show */ }
  localStorage.setItem('glintName', name);
  hud.showMenu(false);
  connect();
}

// ---------------- Connection ----------------
function helloPayload() {
  if (SPECTATE) return { name: 'spectator', spectate: true };
  const h = { name: (savedIdentity && savedIdentity.name) || nameInput.value.trim() || 'Guest' };
  if (savedIdentity) { h.pid = savedIdentity.pid; h.token = savedIdentity.token; }
  return h;
}

function connect() {
  phase = 'connecting';
  hud.conn(true, everWelcomed ? 'Connection lost — reconnecting…' : 'Waking the range…');
  net = new Net({ fakelag: FAKELAG, jitter: JITTER });
  net.onWelcome = onWelcome;
  net.onSnap = onSnap;
  net.onMatchEnd = onMatchEnd;
  net.onError = onNetError;
  net.onClose = onNetClose;
  net.connect(helloPayload());
}

function onWelcome(w) {
  everWelcomed = true;
  reconnectDelay = 1000;
  hud.conn(false);
  // Fresh mid-match join: discard ALL prior prediction/interp/event/dedupe state.
  pred.deactivate();
  audio.setHeartbeat(false);
  interp.players.clear();
  recentShots.clear();
  lastEventId = 0;
  seq = 0;                          // fresh Conn on the server expects seq from 0
  acc = 0;
  deathCam = null;
  effects.clearDeathBeam();
  resetRoundTrackers();
  roster = new Map(w.roster.map((r) => [r.id, { name: r.name, rank: r.rank }]));
  scoreRows = new Map(w.roster.map((r) => [r.id, { k: r.k, d: r.d, streak: r.streak, ping: r.ping }]));
  myPid = w.pid;
  match = w.match.state === 'LIVE'
    ? { state: 'LIVE', endsAt: w.match.endsAt }
    : { state: 'INTERMISSION', endsAt: w.t + w.match.nextIn };
  if (w.match.state === 'INTERMISSION') {
    // Mid-intermission joiner sees the countdown, not a dead world (§4.1).
    intermissionData = {
      scoreboard: w.roster.map((r) => ({ id: r.id, n: r.name, rank: r.rank, k: r.k, d: r.d, hs: 0 })),
      you: null,
    };
    hud.intermission(intermissionData, w.match.nextIn);
  } else {
    intermissionData = null;
    hud.intermission(null, 0);
  }
  if (SPECTATE) {
    phase = 'spectating';
    input.enabled = true;
    canvas.addEventListener('click', lockOnce);
    for (const id of ['bottomLeft', 'bottomRight', 'crosshair', 'breathWrap']) {
      document.getElementById(id).classList.add('hidden');
    }
  } else {
    phase = 'playing';
    input.enabled = true;
    // welcome.pid is authoritative: a rejected token silently downgrades to a
    // fresh anonymous pid — the guest chip must show for that too (§4.1).
    hud.guest(!savedIdentity || w.pid !== savedIdentity.pid);
    canvas.addEventListener('click', lockOnce);
    input.lock();
  }
  hud.show(true);
}

function lockOnce() {
  if (phase === 'playing' || phase === 'spectating') { audio.ensure(); input.lock(); }
}

function onSnap(m) {
  you = m.you;
  const t = m.d.t;
  interp.onSnap(t, m.d.players.filter((p) => p.id !== myPid));
  for (const ev of m.d.events) {
    if (ev.id <= lastEventId) continue;
    lastEventId = ev.id;
    handleEvent(ev, t);
  }
  if (phase === 'playing' && you) {
    if (you.state === 'ALIVE') {
      if (!pred.active || needAnchor) { pred.anchor(you, seq); needAnchor = false; }
      else pred.reconcile(m.ack, you);
    } else if (pred.active) {
      pred.deactivate();
      audio.setHeartbeat(false);
    }
  }
}

function bearingTo(x, z) {
  const cam = gs.camera.position;
  return Math.atan2(x - cam.x, -(z - cam.z)) * 180 / Math.PI;
}

function segmentDistToCamera(o, end) {
  const p = gs.camera.position;
  const a = new THREE.Vector3(...o), b = new THREE.Vector3(...end);
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()));
  const closest = a.clone().add(ab.multiplyScalar(t));
  return { dist: closest.distanceTo(p), closest };
}

// Per-round medal state: cleared when a new match goes LIVE and on (re)welcome.
function resetRoundTrackers() {
  killedMeBy.clear();
  finalMinuteShown = false;
  lastCountdownSec = 0;
}

function handleEvent(ev, t) {
  switch (ev.e) {
    case 'shot': {
      recentShots.set(ev.id, ev);
      if (recentShots.size > 60) recentShots.delete(recentShots.keys().next().value);
      effects.tracer(ev.o, ev.end);
      // Spawn-protected hits land as harmless dust, not flesh.
      effects.impact(ev.end,
        ev.hit && ev.part !== 'protect' ? (ev.part === 'head' ? 'head' : 'flesh') : 'dust');
      const cam = gs.camera.position;
      const d = Math.hypot(ev.o[0] - cam.x, ev.o[1] - cam.y, ev.o[2] - cam.z);
      if (ev.by === myPid) {
        // Own sound/recoil were already predicted at trigger time.
      } else {
        // Pan by the camera-relative side (projection onto the camera right vector),
        // not the absolute world X delta — audible geography must survive facing.
        const camYaw = phase === 'spectating' ? spectateCam.yaw : input.yaw;
        const pan = Math.max(-1, Math.min(1,
          ((ev.o[0] - cam.x) * Math.cos(camYaw) - (ev.o[2] - cam.z) * Math.sin(camYaw)) / 40));
        audio.remoteShot(d, pan);
        effects.muzzleFlash(gs.muzzleWorld(ev.by) || new THREE.Vector3(...ev.o));
        hud.compassPing(bearingTo(ev.o[0], ev.o[2]), performance.now());
        const near = segmentDistToCamera(ev.o, ev.end);
        if (near.dist < 2 && you && you.state === 'ALIVE') {
          const side = Math.sign(new THREE.Vector3(...ev.end).sub(new THREE.Vector3(...ev.o))
            .cross(near.closest.clone().sub(gs.camera.position)).y) || 1;
          audio.whiz(side * 0.7);
        }
      }
      if (ev.by === myPid && ev.hit) {
        if (ev.part === 'protect') {
          hud.hitmarker('protect');     // zero damage — no hit/headshot audio
        } else {
          hud.hitmarker(ev.part === 'head' ? 'head' : 'body');
          if (ev.part === 'head') audio.headshot(); else audio.hitmark();
        }
      }
      if (ev.hit === myPid) {
        hud.damageFrom(bearingTo(ev.o[0], ev.o[2]) - (-input.yaw * 180 / Math.PI));
      }
      break;
    }
    case 'kill': {
      const killer = roster.get(ev.by) || { name: '?', rank: 0 };
      const victim = roster.get(ev.victim) || { name: '?', rank: 0 };
      // Colliding names get their #ab discriminator in the killfeed too (§4.3).
      const deduped = dedupeNames([...roster.entries()].map(([id, r]) => ({ id, name: r.name })));
      const shownOf = (id, fallback) => {
        const row = deduped.find((r) => r.id === id);
        return row ? row.shown : fallback;
      };
      hud.addKill({
        killer: shownOf(ev.by, killer.name), killerRank: killer.rank,
        victim: shownOf(ev.victim, victim.name), victimRank: victim.rank,
        hs: ev.part === 'head', dist: ev.dist,
        meKiller: ev.by === myPid, meVictim: ev.victim === myPid,
      });
      if (ev.by === myPid) {
        hud.streakToast(ev.streak);
        audio.killConfirm();
        // One medal per kill, most personal first: REVENGE > long-range > streak.
        let medal = null;
        if ((killedMeBy.get(ev.victim) || 0) >= 2) medal = 'REVENGE';
        else if (ev.dist >= 120) medal = `${ev.part === 'head' ? 'MARKSMAN' : 'LONGSHOT'} · ${Math.round(ev.dist)} m`;
        else if (ev.streak === 5) medal = 'UNSTOPPABLE';
        else if (ev.streak === 3) medal = 'KILL STREAK ×3';
        if (medal) { hud.medal(medal); audio.medal(); }
      }
      if (ev.victim === myPid) {
        myDeaths++;
        const killsOnMe = (killedMeBy.get(ev.by) || 0) + 1;
        killedMeBy.set(ev.by, killsOnMe);
        deathAt = performance.now();
        const shot = recentShots.get(ev.shotId);
        const kp = interp.sample(net.serverTime() - INTERP_DELAY_MS).get(ev.by);
        deathCam = {
          at: performance.now(),
          killerId: ev.by,
          // 3rd+ death to the same player brands them on the death screen.
          killerName: (killsOnMe >= 3 ? 'NEMESIS ' : '') + killer.name,
          killerHp: ev.killerHp,
          killerPos: kp ? { x: kp.x, y: kp.y, z: kp.z }
            : (shot ? { x: shot.o[0], y: shot.o[1] - EYE_HEIGHT, z: shot.o[2] } : null),
          ray: shot ? { o: shot.o, end: shot.end } : null,
          camPos: gs.camera.position.clone(),
          // Normalized: the shortest-arc pan math below assumes (-pi, pi].
          startYaw: normalizeAngle(input.yaw),
        };
        if (deathCam.ray) effects.deathBeam(deathCam.ray.o, deathCam.ray.end);
        if (deathCam.killerPos) effects.killerOutline(deathCam.killerPos);
        audio.death();
        audio.setHeartbeat(false);
      }
      break;
    }
    case 'spawn': {
      if (ev.who === myPid) {
        mySwaySeed = ev.swaySeed;
        input.setViewFromSpawn(ev.yaw);
        input.pendingFire = null;    // a click latched while dead must never fire the new life
        needAnchor = true;
        deathCam = null;
        effects.clearDeathBeam();
        hud.deathScreen(false);
        audio.unmuffle();
        if (!localStorage.getItem('glintHintDone')) {
          document.getElementById('spawnHint').classList.remove('hidden');
          hintShownAt = performance.now();
        }
      } else {
        interp.purge(ev.who);
      }
      break;
    }
    case 'join':
      roster.set(ev.who, { name: ev.name, rank: ev.rank });
      if (!scoreRows.has(ev.who)) scoreRows.set(ev.who, { k: 0, d: 0, streak: 0, ping: 0 });
      break;
    case 'leave':
      roster.delete(ev.who);
      scoreRows.delete(ev.who);
      interp.purge(ev.who);
      gs.removeRig(ev.who);
      effects.removeGlint(ev.who);
      break;
    case 'score':
      for (const [id, k, d, streak, ping] of ev.rows) {
        scoreRows.set(id, { k, d, streak, ping });
      }
      break;
    case 'match':
      match = { state: ev.state, endsAt: ev.endsAt };
      if (ev.state === 'LIVE') resetRoundTrackers();
      intermissionData = null;
      hud.intermission(null, 0);
      break;
    default: break;
  }
}

function onMatchEnd(m) {
  intermissionData = m;
  match = { state: 'INTERMISSION', endsAt: net.serverTime() + m.nextIn };
  deathCam = null;
  effects.clearDeathBeam();
  hud.deathScreen(false);
  hud.intermission(m, m.nextIn);
  if (m.you && m.you.rankUp) hud.rankToast(`RANK UP — ${m.you.rankUp.to}`);
}

function onNetError(e) {
  if (e.code === 'NAME_INVALID') {
    intentionalClose = true;
    phase = 'menu';
    hud.show(false); hud.conn(false); hud.showMenu(true);
    hud.nameError(e.msg || 'name not allowed');
  } else if (e.code === 'FULL') {
    intentionalClose = true;
    phase = 'menu';
    hud.show(false); hud.conn(false); hud.showMenu(true);
    hud.menuStatus('Server full — retrying in 10 s');
    setTimeout(() => { hud.showMenu(false); connect(); }, 10000);
  } else {
    // RATE/PROTO: the server kicked us on purpose — back to the menu, no
    // auto-reconnect loop against the very server that just rejected us (§4.1).
    intentionalClose = true;
    phase = 'menu';
    input.enabled = false;
    document.exitPointerLock();
    hud.show(false); hud.conn(false); hud.showMenu(true);
    hud.menuStatus('Disconnected: too many messages');
  }
}

function onNetClose() {
  audio.setHeartbeat(false);
  if (intentionalClose) { intentionalClose = false; return; }
  if (phase === 'menu') return;
  phase = 'connecting';
  input.enabled = false;
  hud.conn(true, everWelcomed ? 'Connection lost — reconnecting…' : 'Waking the range…');
  const delay = reconnectDelay;
  reconnectDelay = Math.min(8000, reconnectDelay * 2);
  setTimeout(() => { if (phase === 'connecting') connect(); }, delay);
}

// ---------------- Background tab handling ----------------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    paused = true;
    acc = 0;
    audio.setHeartbeat(false);       // rAF is suspended — nothing else can stop it
    if (net && phase === 'playing') net.send(input.neutral(++seq));
  } else {
    paused = false;
    acc = 0;
    if (net) net.syncBurst();
  }
});

// ---------------- Spectate free-cam (incl. one-finger drag on touch) ----------------
let lastTouch = null;
canvas.addEventListener('touchstart', (e) => { lastTouch = e.touches[0]; }, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  if (phase !== 'spectating' || !lastTouch) return;
  const t = e.touches[0];
  spectateCam.yaw -= (t.clientX - lastTouch.clientX) * 0.005;
  spectateCam.pitch = Math.max(-1.4, Math.min(1.4, spectateCam.pitch - (t.clientY - lastTouch.clientY) * 0.005));
  lastTouch = t;
}, { passive: true });

// Honest hip-fire crosshair: bracket gap = the server's 4-degree cone radius
// projected at the current viewport height.
function setCrosshairGap() {
  const gap = Math.tan(UNSCOPED_CONE_DEG * DEG) / Math.tan((FOV_DEG / 2) * DEG) * (innerHeight / 2);
  document.getElementById('crosshair').style.setProperty('--gap', `${Math.round(gap)}px`);
}
setCrosshairGap();
addEventListener('resize', setCrosshairGap);

// ---------------- Main loop ----------------
let lastFrame = performance.now();

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!net) { gs.render(); return; }
  net.frame();
  const serverNow = net.serverTime();

  // Final-minute callout + last-5s countdown ticks (state lives in resetRoundTrackers).
  if (net.hasSync && match.state === 'LIVE') {
    const msLeft = match.endsAt - serverNow;
    if (!finalMinuteShown && msLeft > 0 && msLeft < 60000) {
      finalMinuteShown = true;
      hud.medal('FINAL MINUTE');
      audio.finalMinute();
    }
    if (msLeft > 0 && msLeft <= 5000) {
      const sec = Math.ceil(msLeft / 1000);
      if (sec !== lastCountdownSec) { lastCountdownSec = sec; audio.countdownTick(); }
    }
  }

  // Fixed-step prediction + input send (30 Hz), hard-clamped accumulator.
  if ((phase === 'playing') && !paused && net.open && net.hasSync) {
    acc = Math.min(acc + dt, ACCUMULATOR_CAP_S);
    while (acc >= TICK_DT) {
      acc -= TICK_DT;
      seq++;
      if (pred.active && you && you.state === 'ALIVE') {
        const inp = input.sample(seq);
        const ev = pred.predict(inp);
        if (ev.fired) {
          audio.ownShot();
          gs.kickRecoil();
          recoilPitch = 1.2 * DEG;
          setTimeout(() => audio.bolt(), 400);
        }
        net.send({ type: 'input', ...inp });
      } else {
        net.send({ type: 'input', ...input.neutral(seq) });
      }
    }
  }

  // Sound edges from predicted state
  if (pred.active) {
    if (pred.state.holding !== prevHolding) {
      if (pred.state.holding) audio.breathIn(); else audio.breathOut();
      prevHolding = pred.state.holding;
    }
    if (pred.state.reloadMs > 0 && prevReloadMs === 0) audio.reload();
    prevReloadMs = pred.state.reloadMs;
    audio.setHeartbeat(pred.state.scoped && (pred.state.holding || pred.state.exhaleMs > 0));
  }

  // ---- Camera ----
  if (phase === 'spectating') {
    const speed = 12 * dt;
    const fwd = { x: -Math.sin(spectateCam.yaw), z: -Math.cos(spectateCam.yaw) };
    if (document.pointerLockElement === canvas) {
      spectateCam.yaw = input.yaw; spectateCam.pitch = input.pitch;
    }
    if (input.keys & 1) { spectateCam.x += fwd.x * speed; spectateCam.z += fwd.z * speed; }
    if (input.keys & 2) { spectateCam.x -= fwd.x * speed; spectateCam.z -= fwd.z * speed; }
    if (input.keys & 4) { spectateCam.x += fwd.z * speed; spectateCam.z -= fwd.x * speed; }
    if (input.keys & 8) { spectateCam.x -= fwd.z * speed; spectateCam.z += fwd.x * speed; }
    if (input.keys & 16) spectateCam.y += speed;
    if (input.keys & 128) spectateCam.y -= speed;
    gs.camera.position.set(spectateCam.x, spectateCam.y, spectateCam.z);
    gs.camera.rotation.set(spectateCam.pitch, spectateCam.yaw, 0);
  } else if (deathCam) {
    // Death-ray cam: pan from death spot toward the killer (cached data only).
    const el = (performance.now() - deathCam.at) / 1000;
    gs.camera.position.copy(deathCam.camPos);
    // The through-wall outline TRACKS the killer's relocation (§4.5); if the
    // killer dies or leaves mid-cam, drop it — never freeze a stale ghost.
    if (deathCam.killerId) {
      const kp = interp.sample(serverNow - INTERP_DELAY_MS).get(deathCam.killerId);
      if (kp && kp.st === 'ALIVE') effects.moveOutline(kp);
      else effects.dropOutline();
    }
    if (deathCam.killerPos) {
      const dx = deathCam.killerPos.x - deathCam.camPos.x;
      const dz = deathCam.killerPos.z - deathCam.camPos.z;
      const dy = deathCam.killerPos.y + 1 - deathCam.camPos.y;
      const targetYaw = Math.atan2(-dx, -dz);
      const targetPitch = Math.atan2(dy, Math.hypot(dx, dz));
      const f = Math.min(1, el / 0.6);
      let dYaw = ((targetYaw - deathCam.startYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      gs.camera.rotation.set(targetPitch * f, deathCam.startYaw + dYaw * f, 0);
    }
    hud.deathScreen(true, deathCam.killerName, deathCam.killerHp,
      DEATH_CAM_MS - (performance.now() - deathAt), myDeaths);
  } else if (phase === 'playing' && pred.active) {
    const alpha = acc / TICK_DT;
    const rp = pred.renderPos(alpha);
    gs.camera.position.set(rp.x, rp.y + EYE_HEIGHT, rp.z);
    let camYaw = input.yaw, camPitch = input.pitch;
    if (pred.state.scoped) {
      const s = pred.state;
      // Evaluate sway at renderTime (= the tt stamped on fires), not serverNow —
      // the server fires at sway(tt), so the reticle must show sway(tt).
      const sway = swayOffsetDeg((serverNow - INTERP_DELAY_MS) / 1000, mySwaySeed, {
        movingScoped: Math.abs(s.vx) + Math.abs(s.vz) > 0.1,
        breathHeld: s.holding,
        forcedExhale: s.exhaleMs > 0,
        msSinceLanding: s.landMs,
      });
      camYaw += sway.yawDeg * Math.PI / 180;
      camPitch += sway.pitchDeg * Math.PI / 180;
    }
    gs.camera.rotation.set(camPitch + recoilPitch, camYaw, 0);
  } else if (phase === 'playing' && you && you.state === 'DEAD' && !deathCam
      && match.state !== 'INTERMISSION') {
    hud.deathScreen(true, null, 0, 0, myDeaths);
  }

  pred.decaySmoothing(dt);
  recoilPitch = Math.max(0, recoilPitch - dt * (1.2 * DEG / 0.3));
  const wantScoped = pred.active && pred.state.scoped;
  scope.update(dt, wantScoped);
  input.fovScale = scope.fovScale;

  // ---- Remote players ----
  const remotes = interp.sample(serverNow - INTERP_DELAY_MS);
  for (const [id, pose] of remotes) {
    const info = roster.get(id);
    gs.ensureRig(id, info ? info.name : '?');
    gs.updateRig(id, pose, gs.camera.position, dt);
  }
  for (const id of gs.rigs.keys()) {
    if (!remotes.has(id) && id !== myPid) { gs.removeRig(id); effects.removeGlint(id); }
  }
  effects.updateGlints(remotes, gs.camera.position, now, innerHeight, scope.fov);
  effects.update(dt);

  const moveSpeed = pred.active ? Math.hypot(pred.state.vx, pred.state.vz) : 0;
  gs.updateViewmodel(dt, moveSpeed, scope.isScopedVisual() || phase === 'spectating' || !!deathCam);

  // Pointer-lock prompt: playing but mouse not captured -> tell them how to aim.
  document.getElementById('lockPrompt').classList.toggle('hidden',
    !(phase === 'playing' && document.pointerLockElement !== canvas && !deathCam));
  // First-life scope hint: dismiss on first scope or after 8 s, then never again.
  if (hintShownAt && (pred.state.scoped || performance.now() - hintShownAt > 8000)) {
    document.getElementById('spawnHint').classList.add('hidden');
    localStorage.setItem('glintHintDone', '1');
    hintShownAt = 0;
  }

  // ---- HUD ----
  if (phase === 'playing' || phase === 'spectating') {
    if (you) {
      hud.vitals(you);
      hud.breath(you, scope.isScopedVisual());
    }
    hud.crosshair(scope.isScopedVisual() || phase === 'spectating' || (you && you.state !== 'ALIVE'));
    hud.matchTimer(match.endsAt - serverNow, match.state);
    hud.ping(net.rtt);
    hud.compass(phase === 'spectating' ? spectateCam.yaw : input.yaw, now);
    const rows = [...roster.entries()].map(([id, r]) => ({
      id, name: r.name, rank: r.rank,
      ...(scoreRows.get(id) || { k: 0, d: 0, streak: 0, ping: 0 }),
    }));
    hud.scoreboard(input.scoreboardHeld, rows, myPid);
    if (intermissionData) hud.intermissionCountdown(match.endsAt - serverNow);
  }

  gs.render();
}

// Debug handle (read-only inspection; harmless in production)
window.__glint = {
  gs, effects, pred, interp,
  get net() { return net; },
  get you() { return you; },
  get phase() { return phase; },
  get roster() { return roster; },
};

// ---------------- Boot ----------------
if (SPECTATE) {
  hud.showMenu(false);
  audio.ensure();
  connect();
} else {
  refreshMenu();
  setInterval(() => { if (phase === 'menu') refreshMenu(); }, 10000);
}
frame();
