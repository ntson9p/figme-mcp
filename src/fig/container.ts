/**
 * Container sniffing, chunk framing and per-chunk decompression
 * (fig-reading-solution.md §1–§3).
 *
 * Every sniff point fails loudly with the observed magic bytes: a future container or codec
 * change should be a five-minute diagnosis, not a mystery.
 */
import * as zlib from 'node:zlib';
import { ZipArchive, looksLikeZip } from './zip.js';

export const FIG_KIWI_MAGIC = 'fig-kiwi';
const ZSTD_MAGIC = 0xfd2fb528;

export type Codec = 'zstd' | 'deflate-raw' | 'zlib' | 'stored';

export interface ChunkInfo {
  readonly index: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly codec: Codec;
}

export interface FigStream {
  readonly version: number;
  readonly chunks: readonly Buffer[];
}

export interface Container {
  readonly kind: 'zip' | 'bare';
  readonly zip: ZipArchive | undefined;
  /** The raw `fig-kiwi` stream (`canvas.fig` inside a ZIP, or the whole file). */
  readonly stream: Buffer;
}

function hexDump(buf: Buffer, n = 16): string {
  return [...buf.subarray(0, n)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Stage A: sniff the container and produce the fig-kiwi stream. Never trusts the extension. */
export function openContainer(buf: Buffer): Container {
  if (looksLikeZip(buf)) {
    const zip = new ZipArchive(buf);
    const stream = zip.read('canvas.fig');
    if (!stream) {
      throw new Error(
        `.fig ZIP has no canvas.fig entry (entries: ${zip.names().slice(0, 10).join(', ')}${zip.size > 10 ? ', …' : ''})`,
      );
    }
    return { kind: 'zip', zip, stream };
  }
  if (buf.length >= 8 && buf.toString('latin1', 0, 8) === FIG_KIWI_MAGIC) {
    return { kind: 'bare', zip: undefined, stream: buf };
  }
  throw new Error(
    `not a readable .fig: expected ZIP (50 4b 03 04) or "fig-kiwi" magic, got ${hexDump(buf)}`,
  );
}

/** Stage B: validate the header and walk the length-prefixed chunks; must land exactly on EOF. */
export function readFigStream(buf: Buffer): FigStream {
  if (buf.length < 12 || buf.toString('latin1', 0, 8) !== FIG_KIWI_MAGIC) {
    throw new Error(`bad fig-kiwi magic: ${hexDump(buf)}`);
  }
  const version = buf.readUInt32LE(8);
  const chunks: Buffer[] = [];
  let off = 12;
  while (off < buf.length) {
    if (off + 4 > buf.length) {
      throw new Error(`truncated chunk length prefix at offset ${off} (file ends at ${buf.length})`);
    }
    const size = buf.readUInt32LE(off);
    off += 4;
    if (off + size > buf.length) {
      throw new Error(
        `chunk ${chunks.length} overruns file: needs ${size} bytes at ${off}, only ${buf.length - off} left`,
      );
    }
    chunks.push(buf.subarray(off, off + size));
    off += size;
  }
  if (off !== buf.length) throw new Error(`chunk walk ended at ${off}, file length ${buf.length}`);
  if (chunks.length < 2) throw new Error(`expected >= 2 chunks (schema, data), got ${chunks.length}`);
  return { version, chunks };
}

/**
 * Stage C: decompress one chunk, sniffing the codec. Codecs differ BETWEEN chunks of the same
 * file (the sample is deflate for chunk 0 and zstd for chunk 1), so never reuse a decision.
 */
export function decompressChunk(chunk: Buffer): { data: Buffer; codec: Codec } {
  if (chunk.length >= 4 && chunk.readUInt32LE(0) === ZSTD_MAGIC) {
    return { data: zlib.zstdDecompressSync(chunk), codec: 'zstd' };
  }
  try {
    return { data: zlib.inflateRawSync(chunk), codec: 'deflate-raw' };
  } catch {
    /* not raw deflate */
  }
  try {
    return { data: zlib.inflateSync(chunk), codec: 'zlib' };
  } catch {
    /* not zlib */
  }
  // "Stored" is the last resort, and only plausible for a chunk that is not obviously garbage.
  if (chunk.length === 0) throw new Error('empty chunk');
  return { data: chunk, codec: 'stored' };
}
