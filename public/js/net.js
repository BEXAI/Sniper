// WebSocket client: min-RTT clock sync, ping loop, event dispatch, and the
// ?fakelag harness (the only practical way to verify prediction/lag comp locally).
import { PING_INTERVAL_MS } from '/shared/constants.js';

export class Net {
  constructor({ fakelag = 0, jitter = 0 } = {}) {
    this.fakelag = fakelag;
    this.jitter = jitter;
    this.ws = null;
    this.open = false;
    this.samples = [];            // last 10 {rtt, offset}
    this.offset = 0;              // applied clock offset (slewed)
    this.targetOffset = 0;
    this.hasSync = false;
    this.rtt = 0;
    this.onWelcome = null;
    this.onSnap = null;
    this.onMatchEnd = null;
    this.onError = null;
    this.onClose = null;
    this._timers = [];
    this._deliverAt = { in: 0, out: 0 };   // per-direction FIFO tails for fakelag
  }

  serverTime() { return performance.now() + this.offset; }

  // FIFO fakelag queue: jitter varies latency but NEVER reorders — each message
  // is delivered no earlier than the previous one in the same direction.
  _delay(fn, dir) {
    if (this.fakelag <= 0) { fn(); return; }
    const d = this.fakelag + (Math.random() * 2 - 1) * this.jitter;
    const at = Math.max(performance.now() + Math.max(0, d), this._deliverAt[dir]);
    this._deliverAt[dir] = at;
    setTimeout(fn, Math.max(0, at - performance.now()));
  }

  connect(hello) {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(proto + location.host);
    this.ws = ws;
    ws.onopen = () => {
      this.open = true;
      this.send({ type: 'hello', ...hello });
      // Clock sync burst: 5 pings at 200 ms, then steady every 2 s.
      for (let i = 0; i < 5; i++) this._timers.push(setTimeout(() => this.ping(), 200 * (i + 1)));
      this._timers.push(setInterval(() => this.ping(), PING_INTERVAL_MS));
    };
    ws.onmessage = (e) => this._delay(() => this._dispatch(e.data), 'in');
    ws.onclose = () => { this.open = false; this._stop(); this.onClose && this.onClose(); };
    ws.onerror = () => { /* onclose follows */ };
  }

  _stop() { for (const t of this._timers) { clearTimeout(t); clearInterval(t); } this._timers = []; }

  close() { this._stop(); if (this.ws) { try { this.ws.close(); } catch { /* gone */ } } }

  ping() {
    // Pings ride the SAME delayed outbound path as everything else — clock-sync
    // samples must see fakelag in both directions or the offset comes out biased.
    this.send({ type: 'ping', cn: performance.now() });
  }

  sendNow(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  send(obj) {
    this._delay(() => this.sendNow(obj), 'out');
  }

  syncBurst() {
    for (let i = 0; i < 5; i++) this._timers.push(setTimeout(() => this.ping(), 150 * (i + 1)));
  }

  _dispatch(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    switch (msg.type) {
      case 'pong': {
        const now = performance.now();
        const rtt = now - msg.cn;
        this.rtt = Math.round(rtt);
        const sampleOffset = msg.st + rtt / 2 - now;
        this.samples.push({ rtt, offset: sampleOffset });
        if (this.samples.length > 10) this.samples.shift();
        // Min-RTT filtering: the lowest-RTT sample has the least jitter inflation.
        let best = this.samples[0];
        for (const s of this.samples) if (s.rtt < best.rtt) best = s;
        this.targetOffset = best.offset;
        if (!this.hasSync) { this.offset = this.targetOffset; this.hasSync = true; }
        break;
      }
      case 'welcome': this.onWelcome && this.onWelcome(msg); break;
      case 'snap': this.onSnap && this.onSnap(msg); break;
      case 'matchEnd': this.onMatchEnd && this.onMatchEnd(msg); break;
      case 'error': this.onError && this.onError(msg); break;
      default: break;
    }
  }

  // Called once per render frame: small offset changes snap (imperceptible), jumps
  // > 50 ms slew at 5 ms/frame to avoid interpolation pops.
  frame() {
    const d = this.targetOffset - this.offset;
    if (Math.abs(d) < 0.01) return;
    if (Math.abs(d) > 50) this.offset += Math.sign(d) * 5;
    else this.offset = this.targetOffset;
  }
}
