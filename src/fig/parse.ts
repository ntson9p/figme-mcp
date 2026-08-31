/**
 * parseFig — the whole Stage A→D pipeline in one call (fig-reading-solution.md §0).
 *
 * Layer 1 boundary: this module knows bytes, chunks and Kiwi. It knows nothing about frames,
 * paints or auto-layout — that lives in ../model.
 */
import { openContainer, readFigStream, decompressChunk, type ChunkInfo } from './container.js';
import { decodeBinarySchema, makeDecoder, type KiwiDefinition, type KiwiObject } from './kiwi.js';
import type { ZipArchive } from './zip.js';
import { checkInvariants } from './invariants.js';

/** A decoded `NodeChange`: an open record, because the schema grows constantly. */
export type NodeChange = KiwiObject;

export interface FigMeta {
  readonly file_name?: string;
  readonly exported_at?: string;
  readonly [key: string]: unknown;
}

export interface ParsedFig {
  readonly container: 'zip' | 'bare';
  /** ZIP entries (images/, thumbnail.png, meta.json); undefined for bare streams. */
  readonly zip: ZipArchive | undefined;
  readonly meta: FigMeta | undefined;
  readonly version: number;
  readonly chunks: readonly ChunkInfo[];
  readonly schema: readonly KiwiDefinition[];
  readonly message: KiwiObject;
  readonly nodeChanges: readonly NodeChange[];
  readonly blobs: readonly KiwiObject[];
  /** Non-fatal observations (unresolved images, odd counts). Structural corruption throws. */
  readonly warnings: readonly string[];
  readonly parseMs: number;
}

export interface ParseOptions {
  /** Skip §7 invariant checks (used by micro-benchmarks; on by default). */
  readonly checkInvariants?: boolean;
}

function chunkContext(index: number, raw: Buffer, codec: string): string {
  const magic = [...raw.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const what = index === 0 ? 'Kiwi schema' : 'Message data';
  return (
    `failed to decode the ${what} (chunk ${index}, ${raw.length} bytes, ` +
    `codec sniffed as ${codec}, first bytes ${magic || '<empty>'})`
  );
}

export function parseFig(buf: Buffer, opts: ParseOptions = {}): ParsedFig {
  const started = performance.now();
  const warnings: string[] = [];

  const container = openContainer(buf);
  const { version, chunks } = readFigStream(container.stream);

  const chunkInfos: ChunkInfo[] = [];
  const schemaChunk = decompressChunk(chunks[0]!);
  chunkInfos.push({
    index: 0,
    compressedSize: chunks[0]!.length,
    size: schemaChunk.data.length,
    codec: schemaChunk.codec,
  });
  const dataChunk = decompressChunk(chunks[1]!);
  chunkInfos.push({
    index: 1,
    compressedSize: chunks[1]!.length,
    size: dataChunk.data.length,
    codec: dataChunk.codec,
  });
  // Further chunks may exist in other files: record them, never fail on them.
  for (let i = 2; i < chunks.length; i++) {
    chunkInfos.push({
      index: i,
      compressedSize: chunks[i]!.length,
      size: -1,
      codec: 'stored',
    });
    warnings.push(`chunk ${i} present and ignored (${chunks[i]!.length} compressed bytes)`);
  }

  // A chunk that matches no known codec is passed through as "stored"; if that guess is wrong
  // the decode below fails. Re-throw with the codec and the chunk's first bytes so a future
  // compression change is a one-line diagnosis rather than a mystery (solution doc §3, §12).
  let schema;
  try {
    schema = decodeBinarySchema(schemaChunk.data);
  } catch (err) {
    throw new Error(`${chunkContext(0, chunks[0]!, schemaChunk.codec)}: ${(err as Error).message}`);
  }
  let message;
  try {
    message = makeDecoder(schema).decode('Message', dataChunk.data);
  } catch (err) {
    throw new Error(`${chunkContext(1, chunks[1]!, dataChunk.codec)}: ${(err as Error).message}`);
  }

  const nodeChanges = (message['nodeChanges'] ?? []) as NodeChange[];
  const blobs = (message['blobs'] ?? []) as KiwiObject[];

  let meta: FigMeta | undefined;
  const metaBytes = container.zip?.read('meta.json');
  if (metaBytes) {
    try {
      meta = JSON.parse(metaBytes.toString('utf8')) as FigMeta;
    } catch (err) {
      warnings.push(`meta.json is not valid JSON: ${(err as Error).message}`);
    }
  }

  const parsed: ParsedFig = {
    container: container.kind,
    zip: container.zip,
    meta,
    version,
    chunks: chunkInfos,
    schema,
    message,
    nodeChanges,
    blobs,
    warnings,
    parseMs: performance.now() - started,
  };

  if (opts.checkInvariants !== false) warnings.push(...checkInvariants(parsed));
  return parsed;
}
