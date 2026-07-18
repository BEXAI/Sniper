// Hostile-input unit tests: message validators, name validation (XSS, reserved
// bot names), and the hand-rolled snapshot splice — including the spectator
// you:null frame — must JSON.parse round-trip.
import assert from 'node:assert';
import { validateInput, validateHello, spliceSnapFrame, qp, qa } from '../server/net/protocol.js';
import { validateName, verifyToken, mintPid, mintToken } from '../server/http/identity.js';

// --- validateInput ---
const ok = { seq: 10, b: 33, yaw: 1.57, pitch: -0.08 };
assert.strictEqual(validateInput({ ...ok }, 9), null);
assert.strictEqual(validateInput({ ...ok, seq: 9 }, 9), 'seq-regress');
assert.strictEqual(validateInput({ ...ok, seq: 200 }, 9), 'seq-jump');
assert.strictEqual(validateInput({ ...ok, seq: 10.5 }, 9), 'seq');
assert.strictEqual(validateInput({ ...ok, b: 512 }, 9), 'buttons');
assert.strictEqual(validateInput({ ...ok, b: -1 }, 9), 'buttons');
assert.strictEqual(validateInput({ ...ok, yaw: NaN }, 9), 'yaw');
assert.strictEqual(validateInput({ ...ok, yaw: Infinity }, 9), 'yaw');
assert.strictEqual(validateInput({ ...ok, fire: { tt: NaN } }, 9), 'fire-tt');
assert.strictEqual(validateInput({ ...ok, fire: 'x' }, 9), 'fire');
{
  const m = { ...ok, pitch: 9999 };
  assert.strictEqual(validateInput(m, 9), null);
  assert.ok(m.pitch <= 1.55, 'pitch must clamp, not reject');
}
{
  const m = { ...ok, yaw: 7.0 };
  assert.strictEqual(validateInput(m, 9), null);
  assert.ok(m.yaw > -Math.PI && m.yaw <= Math.PI + 1e-9, 'yaw must normalize');
}

// --- validateHello ---
assert.strictEqual(validateHello({ name: 'A' }), null);
assert.strictEqual(validateHello({ name: 5 }), 'name');
assert.strictEqual(validateHello({ name: 'A', pid: 7 }), 'pid');
assert.strictEqual(validateHello({ name: 'A', spectate: 'yes' }), 'spectate');

// --- validateName: XSS chars, length, reserved bot names ---
assert.ok(validateName('Nate').ok);
assert.ok(validateName('  Nate  ').ok && validateName('  Nate  ').name === 'Nate');
assert.ok(!validateName('<script>').ok, 'markup chars must be rejected');
assert.ok(!validateName('a"b').ok);
assert.ok(!validateName('x'.repeat(17)).ok, '17 chars must be rejected');
assert.ok(!validateName('').ok);
assert.ok(!validateName('Vex').ok, 'reserved bot name must be rejected');
assert.ok(!validateName('vex').ok, 'reserved names are case-insensitive');
assert.ok(!validateName(42).ok);

// --- HMAC identity ---
const pid = mintPid();
assert.ok(/^[0-9a-f]{16}$/.test(pid));
const token = mintToken(pid);
assert.ok(verifyToken(pid, token));
assert.ok(!verifyToken(pid, token.slice(0, -1) + (token.endsWith('0') ? '1' : '0')));
assert.ok(!verifyToken(pid, 'short'));
assert.ok(!verifyToken('zznothex00000000', token));

// --- Snapshot splice round-trip (built via the REAL helper) ---
const shared = JSON.stringify({
  t: 12345.6, tick: 42,
  players: [{ id: 'abc', x: qp(1.23456), y: qp(0), z: qp(-33.21), yaw: qa(2.31007), pitch: qa(-0.05), hp: 100, sc: 1, st: 'ALIVE' }],
  events: [{ e: 'shot', id: 9, by: 'abc', o: [0, 1.62, 0], end: [10, 1.5, -30], hit: null, part: null }],
});
{
  const frame = spliceSnapFrame(1043, JSON.stringify({ x: 1, hp: 100, state: 'ALIVE' }), shared);
  const parsed = JSON.parse(frame);
  assert.strictEqual(parsed.type, 'snap');
  assert.strictEqual(parsed.ack, 1043);
  assert.strictEqual(parsed.you.hp, 100);
  assert.strictEqual(parsed.d.players[0].x, 1.23);
  assert.strictEqual(parsed.d.events[0].e, 'shot');
}
{
  // Spectator frame: you MUST be literal null and still parse cleanly.
  const frame = spliceSnapFrame(0, 'null', shared);
  const parsed = JSON.parse(frame);
  assert.strictEqual(parsed.you, null);
  assert.strictEqual(parsed.d.tick, 42);
}

console.log('protocol.test OK — validators, identity, splice round-trip (incl. spectator)');
