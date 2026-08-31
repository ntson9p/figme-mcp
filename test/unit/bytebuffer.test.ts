import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteBuffer } from '../../dist/fig/bytebuffer.js';

// --- Reference encoders, transcribed from github.com/evanw/kiwi (ByteBuffer.write*) ---------
// They exist only so the decoders can be round-tripped without a dependency.
const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);

function encodeVarUint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    const byte = v & 127;
    v >>>= 7;
    out.push(v ? byte | 128 : byte);
  } while (v);
  return out;
}

function encodeVarInt(value: number): number[] {
  return encodeVarUint(((value << 1) ^ (value >> 31)) >>> 0);
}

function encodeVarUint64(value: bigint): number[] {
  const out: number[] = [];
  let v = value;
  for (let i = 0; i < 8; i++) {
    const byte = Number(v & 127n);
    v >>= 7n;
    if (v === 0n) {
      out.push(byte);
      return out;
    }
    out.push(byte | 128);
  }
  out.push(Number(v & 255n));
  return out;
}

function encodeVarInt64(value: bigint): number[] {
  return encodeVarUint64(BigInt.asUintN(64, (value << 1n) ^ (value >> 63n)));
}

function encodeVarFloat(value: number): number[] {
  f32[0] = value;
  let bits = i32[0]!;
  bits = ((bits >>> 23) | (bits << 9)) >>> 0; // exponent into the low byte
  if ((bits & 255) === 0) return [0]; // zero and denormals collapse to one byte
  return [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255];
}

const bb = (bytes: number[]): ByteBuffer => new ByteBuffer(Buffer.from(bytes));

test('varUint decodes LEB128 and round-trips', () => {
  assert.equal(bb([0x00]).varUint(), 0);
  assert.equal(bb([0x01]).varUint(), 1);
  assert.equal(bb([0x7f]).varUint(), 127);
  assert.equal(bb([0x80, 0x01]).varUint(), 128);
  assert.equal(bb([0xac, 0x02]).varUint(), 300);
  assert.equal(bb([0xff, 0xff, 0xff, 0xff, 0x0f]).varUint(), 0xffffffff);
  for (const v of [0, 1, 127, 128, 255, 300, 16383, 16384, 1 << 20, 0x7fffffff, 0xffffffff]) {
    assert.equal(bb(encodeVarUint(v)).varUint(), v >>> 0, `varUint ${v}`);
  }
});

test('varInt applies zigzag, including negatives', () => {
  assert.equal(bb([0x00]).varInt(), 0);
  assert.equal(bb([0x01]).varInt(), -1);
  assert.equal(bb([0x02]).varInt(), 1);
  assert.equal(bb([0x03]).varInt(), -2);
  for (const v of [0, 1, -1, 2, -2, 63, -64, 12345, -12345, 0x7fffffff, -0x80000000]) {
    assert.equal(bb(encodeVarInt(v)).varInt(), v, `varInt ${v}`);
  }
});

test('varUint64 / varInt64 round-trip through BigInt, 9th byte carries 8 bits', () => {
  for (const v of [0n, 1n, 127n, 128n, 2n ** 32n, 2n ** 56n, 2n ** 63n, 2n ** 64n - 1n]) {
    assert.equal(bb(encodeVarUint64(v)).varUint64(), v, `varUint64 ${v}`);
  }
  for (const v of [0n, 1n, -1n, 2n ** 40n, -(2n ** 40n), 2n ** 62n, -(2n ** 62n)]) {
    assert.equal(bb(encodeVarInt64(v)).varInt64(), v, `varInt64 ${v}`);
  }
  // A full 9-byte encoding: the last byte contributes all 8 bits, not 7.
  assert.equal(bb(encodeVarUint64(2n ** 64n - 1n)).varUint64(), 0xffffffffffffffffn);
  assert.equal(encodeVarUint64(2n ** 64n - 1n).length, 9);
});

test('varFloat: 0x00 is 0.0, and values round-trip at float32 precision', () => {
  assert.equal(bb([0x00]).varFloat(), 0);
  assert.equal(encodeVarFloat(0).length, 1);
  for (const v of [1, -1, 0.5, -0.5, 16, 8, 134, 40, 1e-8, 3.4028234663852886e38]) {
    assert.equal(bb(encodeVarFloat(v)).varFloat(), Math.fround(v), `varFloat ${v}`);
  }
  // float32 noise is CORRECT: 0.2 is not representable exactly.
  assert.equal(bb(encodeVarFloat(0.2)).varFloat(), 0.20000000298023224);
  // The rotation puts the exponent first: 1.0 encodes as 7f 00 00 00, not 00 00 80 3f.
  assert.deepEqual(encodeVarFloat(1), [0x7f, 0x00, 0x00, 0x00]);
});

test('string reads UTF-8 up to NUL and skips it', () => {
  const b = new ByteBuffer(Buffer.from('abc\0Text\0\0', 'utf8'));
  assert.equal(b.string(), 'abc');
  assert.equal(b.string(), 'Text');
  assert.equal(b.string(), '');
  assert.equal(b.remaining, 0);
  assert.throws(() => new ByteBuffer(Buffer.from('nope', 'utf8')).string(), /unterminated string/);
});

test('reads past the end throw instead of returning garbage', () => {
  const b = new ByteBuffer(Buffer.from([1]));
  assert.equal(b.byte(), 1);
  assert.throws(() => b.byte(), /read past end/);
  assert.throws(() => new ByteBuffer(Buffer.from([1, 2])).bytes(3), /read past end/);
});
