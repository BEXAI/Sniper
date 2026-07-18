// DOM HUD. Binding rule (grep-able): no innerHTML with interpolated data — every
// player-provided string reaches the DOM via textContent/createTextNode only.
import { RANKS, MAG_SIZE } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);
const CHEV = ['·', '▸', '▸▸', '▸▸▸', '◆', '◆◆', '★'];

function chev(rank) { return CHEV[Math.min(rank, CHEV.length - 1)] || '·'; }

// Duplicate display names get a #ab discriminator from the pid.
export function dedupeNames(rows) {
  const counts = {};
  for (const r of rows) counts[r.name] = (counts[r.name] || 0) + 1;
  return rows.map((r) => ({
    ...r,
    shown: counts[r.name] > 1 ? `${r.name}#${String(r.id).slice(0, 2)}` : r.name,
  }));
}

export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), crosshair: $('crosshair'), breathWrap: $('breathWrap'), breathBar: $('breathBar'),
      hitmarker: $('hitmarker'), damageVignette: $('damageVignette'), damageWedge: $('damageWedge'),
      matchTimer: $('matchTimer'), compassStrip: $('compassStrip'), pingChip: $('pingChip'),
      killfeed: $('killfeed'), streakToast: $('streakToast'), rankToast: $('rankToast'),
      healthBar: $('healthBar'), hpNum: $('hpNum'), ammo: $('ammo'), boltFill: $('boltFill'),
      reloadHint: $('reloadHint'), guestChip: $('guestChip'), scoreboard: $('scoreboard'),
      sbBody: $('sbBody'), deathScreen: $('deathScreen'), deathKiller: $('deathKiller'),
      deathRespawn: $('deathRespawn'), protectChip: $('protectChip'),
      intermission: $('intermission'), imPlace: $('imPlace'), imBody: $('imBody'),
      imXp: $('imXp'), imRankUp: $('imRankUp'), imCountdown: $('imCountdown'),
      connOverlay: $('connOverlay'), connMsg: $('connMsg'),
      menu: $('menu'), nameInput: $('nameInput'), nameError: $('nameError'),
      lbBody: $('lbBody'), lbEmpty: $('lbEmpty'), seasonBanner: $('seasonBanner'),
      menuStatus: $('menuStatus'), scopeOverlay: $('scopeOverlay'),
    };
    this._hmTimer = null;
    this._toastTimer = null;
    this._rankTimer = null;
    this._compassPings = [];
    this._buildCompass();
  }

  _buildCompass() {
    const dirs = [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]];
    this._compassDirs = dirs.map(([label, deg]) => {
      const span = document.createElement('span');
      span.textContent = label;
      span.style.position = 'absolute';
      this.el.compassStrip.appendChild(span);
      return { span, deg };
    });
  }

  show(inGame) { this.el.hud.classList.toggle('hidden', !inGame); }
  showMenu(v) { this.el.menu.classList.toggle('hidden', !v); }

  conn(show, msg) {
    this.el.connOverlay.classList.toggle('hidden', !show);
    if (msg) this.el.connMsg.textContent = msg;
  }

  vitals(you) {
    const hp = Math.max(0, you.hp);
    this.el.healthBar.style.width = `${hp}%`;
    this.el.healthBar.classList.toggle('low', hp <= 40);
    this.el.hpNum.textContent = String(hp);
    this.el.ammo.textContent = `${you.ammo}/${MAG_SIZE}`;
    const boltFrac = you.boltMs > 0 ? 1 - you.boltMs / 1500 : 1;
    document.getElementById('boltArc').style.background =
      `conic-gradient(var(--amber) ${boltFrac * 360}deg, rgba(0,0,0,.5) ${boltFrac * 360}deg)`;
    this.el.reloadHint.classList.toggle('hidden', you.reloadMs <= 0);
    this.el.protectChip.classList.toggle('hidden', !(you.protectMs > 0));
  }

  breath(you, scopedVisual) {
    const show = scopedVisual && you.state === 'ALIVE';
    this.el.breathWrap.style.display = show ? 'block' : 'none';
    if (show) {
      this.el.breathBar.style.width = `${Math.round(you.breath * 100)}%`;
      this.el.breathWrap.classList.toggle('exhale', you.exhaleMs > 0);
    }
  }

  crosshair(scopedVisual) {
    this.el.crosshair.style.display = scopedVisual ? 'none' : 'block';
  }

  hitmarker(head) {
    const el = this.el.hitmarker;
    el.classList.toggle('head', !!head);
    el.classList.add('show');
    clearTimeout(this._hmTimer);
    this._hmTimer = setTimeout(() => el.classList.remove('show'), 120);
  }

  damageFrom(relBearingDeg) {
    this.el.damageVignette.style.opacity = '1';
    setTimeout(() => { this.el.damageVignette.style.opacity = '0'; }, 150);
    const w = this.el.damageWedge;
    w.style.transform = `rotate(${relBearingDeg}deg)`;
    w.style.opacity = '1';
    clearTimeout(this._wedgeTimer);
    this._wedgeTimer = setTimeout(() => { w.style.opacity = '0'; }, 700);
  }

  addKill({ killer, killerRank, victim, victimRank, hs, dist, meKiller, meVictim }) {
    const row = document.createElement('div');
    row.className = 'kf-row';
    const k = document.createElement('span');
    k.className = 'kf-killer';
    k.textContent = `${chev(killerRank)} ${killer}`;
    if (meKiller) k.style.color = '#ffd77e';
    const mid = document.createElement('span');
    mid.textContent = hs ? '  ☠ ' : '  ✕ ';
    if (hs) mid.className = 'kf-hs';
    const v = document.createElement('span');
    v.className = 'kf-victim';
    v.textContent = `${victim}`;
    if (meVictim) v.style.color = '#ff8d7e';
    const d = document.createElement('span');
    d.className = 'kf-dist';
    d.textContent = `  ${Math.round(dist)} m`;
    row.append(k, mid, v, d);
    this.el.killfeed.prepend(row);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.lastChild.remove();
    setTimeout(() => { row.remove(); }, 8000);
  }

  streakToast(n) {
    const el = this.el.streakToast;
    el.textContent = n >= 5 ? `UNSTOPPABLE — ${n} STREAK` : n >= 3 ? `${n} KILL STREAK` : 'KILL';
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 1600);
  }

  rankToast(text) {
    const el = this.el.rankToast;
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(this._rankTimer);
    this._rankTimer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  scoreboard(visible, rows, myId) {
    this.el.scoreboard.classList.toggle('hidden', !visible);
    if (!visible) return;
    const body = this.el.sbBody;
    body.replaceChildren();
    for (const r of dedupeNames([...rows].sort((a, b) => b.k - a.k || a.d - b.d))) {
      const tr = document.createElement('tr');
      if (r.id === myId) tr.className = 'me';
      const name = document.createElement('td');
      const ch = document.createElement('span');
      ch.className = 'rank-chev';
      ch.textContent = chev(r.rank);
      name.append(ch, document.createTextNode(r.shown));
      for (const val of [null, r.k, r.d, r.streak, r.ping]) {
        if (val === null) { tr.appendChild(name); continue; }
        const td = document.createElement('td');
        td.textContent = String(val);
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  matchTimer(msLeft, state) {
    if (state === 'INTERMISSION') { this.el.matchTimer.textContent = '—'; return; }
    const s = Math.max(0, Math.ceil(msLeft / 1000));
    this.el.matchTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  ping(ms) { this.el.pingChip.textContent = `${ms} ms`; }

  compass(yawRad, nowMs) {
    const yawDeg = (-yawRad * 180 / Math.PI + 360 * 10) % 360;
    const pxPerDeg = 340 / 180;
    for (const { span, deg } of this._compassDirs) {
      let rel = ((deg - yawDeg + 540) % 360) - 180;
      span.style.left = `${170 + rel * pxPerDeg - 8}px`;
      span.style.opacity = Math.abs(rel) < 85 ? '1' : '0';
    }
    for (let i = this._compassPings.length - 1; i >= 0; i--) {
      const p = this._compassPings[i];
      if (nowMs - p.at > 2000) { p.el.remove(); this._compassPings.splice(i, 1); continue; }
      let rel = ((p.bearing - yawDeg + 540) % 360) - 180;
      p.el.style.left = `${170 + rel * pxPerDeg - 3}px`;
      p.el.style.opacity = Math.abs(rel) < 88 ? String(1 - (nowMs - p.at) / 2000) : '0';
    }
  }

  compassPing(bearingDeg, nowMs) {
    const el = document.createElement('div');
    el.className = 'compass-ping';
    document.getElementById('compass').appendChild(el);
    this._compassPings.push({ el, bearing: (bearingDeg + 360) % 360, at: nowMs });
  }

  deathScreen(show, killerName, killerHp, msLeft, deathNum = 0) {
    this.el.deathScreen.classList.toggle('hidden', !show);
    if (!show) return;
    const dk = this.el.deathKiller;
    dk.replaceChildren();
    if (killerName) {
      dk.append(document.createTextNode(`${killerName} — `));
      const hp = document.createElement('span');
      hp.className = 'hp';
      hp.textContent = `${killerHp} HP`;
      dk.appendChild(hp);
    }
    this.el.deathRespawn.textContent = msLeft > 0 ? `redeploying in ${Math.ceil(msLeft / 1000)}` : 'redeploying…';
    // The first four deaths ARE the tutorial, delivered while the player is captive.
    const TIPS = [
      'a scoped rifle flashes gold — spot the glint before the shot lands',
      'a sniper\'s first shot at range always misses — that crack past your ear is your one bolt-cycle to break line of sight',
      'hip fire sprays 4 degrees — hold RMB and let the scope settle before the trigger',
      'the sunken trench along the north edge is a zero-exposure flank to every perch',
    ];
    document.getElementById('deathTip').textContent = deathNum > 0 ? TIPS[(deathNum - 1) % TIPS.length] : '';
  }

  guest(show) { this.el.guestChip.classList.toggle('hidden', !show); }

  season(show) { this.el.seasonBanner.classList.toggle('hidden', !show); }

  intermission(data, msLeft) {
    const el = this.el.intermission;
    if (!data) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    if (data.you && data.you.place) {
      this.el.imPlace.textContent = `You placed #${data.you.place} — ${data.you.k} kills`;
    } else {
      this.el.imPlace.textContent = '';
    }
    const body = this.el.imBody;
    body.replaceChildren();
    dedupeNames(data.scoreboard.map((r) => ({ ...r, name: r.n }))).forEach((r, i) => {
      const tr = document.createElement('tr');
      if (i < 3) tr.className = 'podium';
      const cells = [i + 1, null, r.k, r.d, r.hs];
      cells.forEach((val, ci) => {
        const td = document.createElement('td');
        if (ci === 1) {
          const ch = document.createElement('span');
          ch.className = 'rank-chev';
          ch.textContent = chev(r.rank);
          td.append(ch, document.createTextNode(r.shown));
        } else td.textContent = String(val);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    const xp = this.el.imXp;
    xp.replaceChildren();
    if (data.you && data.you.xpItems) {
      for (const [label, val] of data.you.xpItems) {
        const span = document.createElement('span');
        const b = document.createElement('b');
        b.textContent = `+${val} `;
        span.append(b, document.createTextNode(label));
        xp.appendChild(span);
      }
      const total = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = `${data.you.xpGain} XP`;
      total.append(document.createTextNode('total '), b);
      xp.appendChild(total);
    }
    if (data.you && data.you.rankUp) {
      this.el.imRankUp.classList.remove('hidden');
      this.el.imRankUp.textContent = `RANK UP — ${data.you.rankUp.to}`;
    } else this.el.imRankUp.classList.add('hidden');
    this.el.imCountdown.textContent = `next round in ${Math.max(0, Math.ceil(msLeft / 1000))}`;
  }

  intermissionCountdown(msLeft) {
    this.el.imCountdown.textContent = `next round in ${Math.max(0, Math.ceil(msLeft / 1000))}`;
  }

  leaderboard(rows) {
    const body = this.el.lbBody;
    body.replaceChildren();
    this.el.lbEmpty.classList.toggle('hidden', rows.length > 0);
    dedupeNames(rows.slice(0, 10)).forEach((r) => {
      const tr = document.createElement('tr');
      const rank = document.createElement('td');
      rank.textContent = `#${r.rank}`;
      const name = document.createElement('td');
      name.textContent = `${chev(RANKS.findIndex((x) => x.name === r.rankName))} ${r.shown}`;
      const xp = document.createElement('td');
      xp.className = 'num';
      xp.textContent = `${r.xp} xp`;
      const k = document.createElement('td');
      k.className = 'num';
      k.textContent = `${r.kills}k`;
      tr.append(rank, name, xp, k);
      body.appendChild(tr);
    });
  }

  nameError(msg) {
    this.el.nameError.classList.toggle('hidden', !msg);
    if (msg) this.el.nameError.textContent = msg;
  }

  menuStatus(msg) { this.el.menuStatus.textContent = msg || ''; }
}
