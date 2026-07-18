// Socket lifecycle. Every disconnect — ws close, liveness terminate, backpressure
// terminate, violation kick, AFK removal — funnels through ONE cleanup path so
// entity removal, leave events, and cap bookkeeping are single-sourced.
import { validateInput, validateHello, validatePing } from './protocol.js';
import { verifyToken, validateName } from '../http/identity.js';
import {
  MAX_MSGS_PER_SEC, MAX_INPUTS_PER_SEC, MAX_VIOLATIONS, HELLO_TIMEOUT_MS,
  LIVENESS_TIMEOUT_MS, MAX_SOCKETS, MAX_SOCKETS_PER_IP, rankFor,
} from '../../shared/constants.js';

const FATAL_CODES = new Set(['NAME_INVALID', 'FULL', 'RATE', 'PROTO']);

export class Conn {
  constructor(ws, ip, hub) {
    this.ws = ws;
    this.ip = ip;
    this.hub = hub;
    this.player = null;
    this.room = null;
    this.spectator = false;
    this.phase = 'hello';
    this.lastInboundAt = Date.now();
    this.violations = 0;
    this.msgCount = 0;
    this.msgWindow = Date.now();
    this.inputCount = 0;
    this.inputWindow = Date.now();
    this.lastSeq = 0;
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendRaw(str) {
    if (this.ws.readyState === 1) this.ws.send(str);
  }

  error(code, msg) { this.send({ type: 'error', code, msg }); }

  kick(code) {
    if (FATAL_CODES.has(code)) this.error(code);
    try { this.ws.close(4008, code); } catch { /* closing */ }
    // Half-open peers never ACK a close; force it shortly after.
    setTimeout(() => { try { this.ws.terminate(); } catch { /* gone */ } }, 1000).unref?.();
  }

  violation() {
    this.violations++;
    if (this.violations >= MAX_VIOLATIONS) this.kick('PROTO');
  }
}

export class ConnectionHub {
  constructor(manager, store, clock) {
    this.manager = manager;
    this.store = store;
    this.clock = clock;                 // () => server ms (performance.now)
    this.conns = new Set();
    this.perIp = new Map();
    // Liveness sweep: no inbound for >10 s -> terminate (never close: half-open
    // peers never ACK). Live clients send 30 inputs/s and ping every 2 s.
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const conn of this.conns) {
        if (now - conn.lastInboundAt > LIVENESS_TIMEOUT_MS) {
          try { conn.ws.terminate(); } catch { /* gone */ }
        }
      }
    }, 2000);
    this.sweep.unref?.();
    // Server-side RTT via protocol-level ping/pong (browsers auto-reply in the
    // network stack, so this must NOT feed liveness — a dead tab still pongs).
    this.rttSweep = setInterval(() => {
      const now = Date.now();
      for (const conn of this.conns) {
        if (conn.ws.readyState === 1) {
          conn.pingSentAt = now;
          try { conn.ws.ping(); } catch { /* gone */ }
        }
      }
    }, 5000);
    this.rttSweep.unref?.();
  }

  accept(ws, req) {
    const ip = (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
    if (this.conns.size >= MAX_SOCKETS || (this.perIp.get(ip) || 0) >= MAX_SOCKETS_PER_IP) {
      try { ws.send(JSON.stringify({ type: 'error', code: 'FULL', msg: 'server full' })); } catch { /* best effort */ }
      ws.close(4008, 'FULL');
      return;
    }
    const conn = new Conn(ws, ip, this);
    this.conns.add(conn);
    this.perIp.set(ip, (this.perIp.get(ip) || 0) + 1);

    const helloTimer = setTimeout(() => {
      if (conn.phase === 'hello') conn.kick('PROTO');
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    ws.on('message', (data) => this.onMessage(conn, data));
    ws.on('pong', () => {
      if (conn.pingSentAt && conn.player) {
        conn.player.ping = Math.min(999, Date.now() - conn.pingSentAt);
      }
    });
    ws.on('close', () => { clearTimeout(helloTimer); this.cleanup(conn); });
    ws.on('error', () => { try { ws.terminate(); } catch { /* gone */ } });
  }

  cleanup(conn) {
    if (!this.conns.has(conn)) return;
    this.conns.delete(conn);
    const n = (this.perIp.get(conn.ip) || 1) - 1;
    if (n <= 0) this.perIp.delete(conn.ip); else this.perIp.set(conn.ip, n);
    if (conn.room) {
      if (conn.player) conn.room.removeCombatant(conn.player);
      if (conn.spectator) conn.room.removeSpectator(conn);
    }
    conn.player = null;
    conn.room = null;
  }

  onMessage(conn, data) {
    conn.lastInboundAt = Date.now();
    // Frame-rate cap: 80 msgs/s.
    const now = Date.now();
    if (now - conn.msgWindow >= 1000) { conn.msgWindow = now; conn.msgCount = 0; }
    if (++conn.msgCount > MAX_MSGS_PER_SEC) { conn.violation(); return; }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { conn.violation(); return; }
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') {
      conn.violation(); return;
    }

    switch (msg.type) {
      case 'hello': this.onHello(conn, msg); break;
      case 'input': this.onInput(conn, msg); break;
      case 'ping':
        if (validatePing(msg) === null) conn.send({ type: 'pong', cn: msg.cn, st: this.clock() });
        else conn.violation();
        break;
      default: conn.violation();
    }
  }

  onHello(conn, msg) {
    if (conn.phase !== 'hello') { conn.violation(); return; }
    if (validateHello(msg) !== null) { conn.violation(); return; }

    // Spectators: no-combat observers, never counted for bot fill.
    if (msg.spectate === true) {
      const room = this.manager.pickRoomForSpectator();
      if (!room || !room.addSpectator(conn)) { conn.kick('FULL'); return; }
      conn.room = room;
      conn.spectator = true;
      conn.phase = 'joined';
      conn.send(room.buildWelcome(null, room.now, 0));
      return;
    }

    // Identity: valid pid+token accrues stats across sessions; anything else is an
    // anonymous session-only guest.
    let pid, name, rank = 0, xp = 0, identified = false;
    if (msg.pid && msg.token && verifyToken(msg.pid, msg.token)) {
      // Re-validate the name with the EXACT /api/guest validator — a modified
      // client can never inject markup or impersonate a bot via hello.
      const v = validateName(msg.name);
      if (!v.ok) { conn.kick('NAME_INVALID'); return; }
      pid = msg.pid;
      name = v.name;
      identified = true;
      const row = this.store.upsertPlayer(pid, name);
      xp = row.xp;
      rank = rankFor(xp);
      // Duplicate pid — newest wins: token possession proves the same person.
      for (const room of this.manager.rooms) {
        for (const p of room.combatants) {
          if (p.id === pid && p.conn && p.conn !== conn) {
            try { p.conn.ws.terminate(); } catch { /* gone */ }
            this.cleanup(p.conn);
          }
        }
      }
    } else {
      pid = `g${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 9)}`.slice(0, 16);
      name = `Guest-${1000 + Math.floor(Math.random() * 9000)}`;
    }

    const room = this.manager.pickRoomForHuman();
    if (!room) { conn.kick('FULL'); return; }
    conn.room = room;
    conn.phase = 'joined';
    conn.identified = identified;
    conn.player = room.addHuman(conn, { pid, name, rank, xp });
    conn.send(room.buildWelcome(conn.player, room.now, 0));
  }

  onInput(conn, msg) {
    if (!conn.player) { conn.violation(); return; }
    // Input-rate cap: 35/s averaged over 3 s.
    const now = Date.now();
    if (now - conn.inputWindow >= 3000) { conn.inputWindow = now; conn.inputCount = 0; }
    if (++conn.inputCount > MAX_INPUTS_PER_SEC * 3) { conn.violation(); return; }

    const reason = validateInput(msg, conn.lastSeq);
    if (reason) { conn.violation(); return; }
    conn.lastSeq = msg.seq;
    if (conn.player.queue.length > 64) { conn.violation(); return; }
    const input = { seq: msg.seq, b: msg.b, yaw: msg.yaw, pitch: msg.pitch };
    if (msg.fire) input.fire = { tt: msg.fire.tt };
    conn.player.queueInput(input);
  }
}
