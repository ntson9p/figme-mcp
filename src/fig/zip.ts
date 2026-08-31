/**
 * Minimal ZIP reader driven by the central directory (fig-reading-solution.md §1).
 *
 * Figma writes entries with the data-descriptor flag set, so local headers carry ZERO for the
 * CRC and both sizes; the real sizes only exist in the central directory. Reading local headers
 * for sizes therefore silently yields empty entries. Entry payloads are decompressed lazily and
 * memoised so a 39 MB archive with 250 image entries costs nothing until an entry is asked for.
 */
import * as zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50; // PK\x03\x04
const SIG_CENTRAL = 0x02014b50; // PK\x01\x02
const SIG_EOCD = 0x06054b50; // PK\x05\x06
const EOCD_MAX_SCAN = 65558; // 22-byte EOCD + 65535-byte max comment + slack

export const ZIP_MAGIC = SIG_LOCAL;

export interface ZipEntry {
  readonly name: string;
  /** 0 = stored, 8 = raw deflate. */
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly dataOffset: number;
}

export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL;
}

export class ZipArchive {
  private readonly buf: Buffer;
  private readonly entries = new Map<string, ZipEntry>();
  private readonly cache = new Map<string, Buffer>();

  constructor(buf: Buffer) {
    this.buf = buf;
    const eocd = findEocd(buf);
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length) throw new Error(`ZIP: central directory entry ${i} out of range`);
      if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
        throw new Error(
          `ZIP: bad central directory entry ${i} at ${p} (signature ${hex32(buf.readUInt32LE(p))})`,
        );
      }
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const uncompressedSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localOff = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      if (localOff + 30 > buf.length) throw new Error(`ZIP: local header of "${name}" out of range`);
      if (buf.readUInt32LE(localOff) !== SIG_LOCAL) {
        throw new Error(`ZIP: "${name}" has no local header at ${localOff}`);
      }
      // The local header's own name/extra lengths differ from the central ones in real Figma
      // archives, so the data offset must be computed from the LOCAL header.
      const dataOffset =
        localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      this.entries.set(name, { name, method, compressedSize, uncompressedSize, dataOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  entry(name: string): ZipEntry | undefined {
    return this.entries.get(name);
  }

  /** Decompressed bytes of one entry, or undefined when the entry does not exist. */
  read(name: string): Buffer | undefined {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const e = this.entries.get(name);
    if (!e) return undefined;
    const raw = this.buf.subarray(e.dataOffset, e.dataOffset + e.compressedSize);
    let out: Buffer;
    if (e.method === 0) out = raw;
    else if (e.method === 8) out = zlib.inflateRawSync(raw);
    else throw new Error(`ZIP: "${name}" uses unsupported compression method ${e.method}`);
    this.cache.set(name, out);
    return out;
  }
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - EOCD_MAX_SCAN);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('ZIP: end-of-central-directory signature (50 4B 05 06) not found');
}

function hex32(v: number): string {
  return `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
}
