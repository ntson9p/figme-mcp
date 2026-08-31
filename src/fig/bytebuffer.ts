/**
 * Kiwi primitive decoders (fig-reading-solution.md §4).
 *
 * Direct port of class `BB` in tools/fig2json.mjs, which was validated byte-for-byte against
 * the official `kiwi-schema` package. Do not "improve" these — every later stage desynchronizes
 * within a few fields if a primitive is off by one byte.
 */

// Scratch buffers for the float32 bit-reinterpretation in varFloat(); module-scoped so the hot
// decode loop never allocates.
const F32_INT = new Int32Array(1);
const F32 = new Float32Array(F32_INT.buffer);

export class ByteBuffer {
  readonly b: Buffer;
  i: number;

  constructor(buf: Buffer, offset = 0) {
    this.b = buf;
    this.i = offset;
  }

  get remaining(): number {
    return this.b.length - this.i;
  }

  byte(): number {
    if (this.i >= this.b.length) throw new Error(`read past end at ${this.i}`);
    return this.b[this.i++]!;
  }

  bytes(n: number): Buffer {
    if (this.i + n > this.b.length) throw new Error(`read past end at ${this.i}+${n}`);
    const s = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return s;
  }

  /** Unsigned LEB128, max 5 bytes (32-bit) — mirrors kiwi readVarUint. */
  varUint(): number {
    let value = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.byte();
      value |= (b & 127) << shift;
      shift += 7;
    } while (b & 128 && shift < 35);
    return value >>> 0;
  }

  /** Zigzag-encoded signed 32-bit — mirrors kiwi readVarInt. */
  varInt(): number {
    const v = this.varUint() | 0;
    return v & 1 ? ~(v >>> 1) : v >>> 1;
  }

  /** Unsigned LEB128 up to 9 bytes; the 9th byte contributes all 8 bits. */
  varUint64(): bigint {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.byte();
      if (shift === 56n) {
        value |= BigInt(b) << 56n;
        break;
      }
      value |= BigInt(b & 127) << shift;
      if (!(b & 128)) break;
      shift += 7n;
    }
    return value;
  }

  varInt64(): bigint {
    const v = this.varUint64();
    return v & 1n ? ~(v >> 1n) : v >> 1n;
  }

  /**
   * Kiwi float32: a single 0x00 byte means 0.0, otherwise 4 bytes bit-rotated so the exponent
   * lands in the first byte (better entropy for compression) — mirrors kiwi readVarFloat.
   * Values decode as float32, so 0.2 legitimately reads back as 0.20000000298023224.
   */
  varFloat(): number {
    const first = this.byte();
    if (first === 0) return 0;
    const b2 = this.byte();
    const b3 = this.byte();
    const b4 = this.byte();
    let bits = first | (b2 << 8) | (b3 << 16) | (b4 << 24);
    bits = (bits << 23) | (bits >>> 9);
    F32_INT[0] = bits;
    return F32[0]!;
  }

  /** UTF-8 bytes up to (not including) the next NUL; the cursor advances past the NUL. */
  string(): string {
    const end = this.b.indexOf(0, this.i);
    if (end < 0) throw new Error(`unterminated string at ${this.i}`);
    const s = this.b.toString('utf8', this.i, end);
    this.i = end + 1;
    return s;
  }
}
