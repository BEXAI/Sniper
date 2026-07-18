// Message validation + snapshot frame splicing. Every inbound frame is hostile
// until proven otherwise; every helper here is exercised by test/protocol.test.js.
import { BTN_MAX, MAX_SEQ_JUMP } from '../../shared/constants.js';
import { normalizeAngle, clamp } from '../../shared/math.js';

export function qp(v) { return Math.round(v * 100) / 100; }      // positions -> cm
export function qa(v) { return Math.round(v * 1000) / 1000; }    // angles -> mrad

// Validates and normalizes an input message in place.
// Returns null when acceptable, otherwise a short violation reason.
export function validateInput(msg, lastSeq) {
  if (!Number.isInteger(msg.seq)) return 'seq';
  if (msg.seq <= lastSeq) return 'seq-regress';
  if (msg.seq > lastSeq + MAX_SEQ_JUMP) return 'seq-jump';
  if (!Number.isInteger(msg.b) || msg.b < 0 || msg.b > BTN_MAX) return 'buttons';
  if (typeof msg.yaw !== 'number' || !Number.isFinite(msg.yaw)) return 'yaw';
  if (typeof msg.pitch !== 'number' || !Number.isFinite(msg.pitch)) return 'pitch';
  msg.yaw = normalizeAngle(msg.yaw);
  msg.pitch = clamp(msg.pitch, -1.55, 1.55);
  if (msg.fire !== undefined) {
    if (typeof msg.fire !== 'object' || msg.fire === null) return 'fire';
    if (typeof msg.fire.tt !== 'number' || !Number.isFinite(msg.fire.tt)) return 'fire-tt';
  }
  return null;
}

export function validateHello(msg) {
  if (typeof msg.name !== 'string') return 'name';
  if (msg.pid !== undefined && typeof msg.pid !== 'string') return 'pid';
  if (msg.token !== undefined && typeof msg.token !== 'string') return 'token';
  if (msg.spectate !== undefined && typeof msg.spectate !== 'boolean') return 'spectate';
  return null;
}

export function validatePing(msg) {
  return typeof msg.cn === 'number' && Number.isFinite(msg.cn) ? null : 'ping-cn';
}

// The per-client snapshot frame: shared portion serialized ONCE per tick, ack + you
// spliced per client via string concatenation (the main CPU trick for 0.1 CPU).
// selfJson must be a JSON string or the literal string 'null' (spectators).
export function spliceSnapFrame(ack, selfJson, sharedStr) {
  return `{"type":"snap","ack":${ack},"you":${selfJson},"d":${sharedStr}}`;
}
