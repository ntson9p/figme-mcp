/**
 * Parsed-file cache.
 *
 * A 39 MB .fig decodes to roughly 900 MB of live JS objects, so entries are precious: keep a
 * small LRU (4 by default), key on the absolute path, and re-parse whenever mtime or size
 * changes. Parsing is lazy — nothing is read until a tool actually touches a path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseFig, type ParsedFig } from './fig/parse.js';
import { FileIndex } from './model/index.js';

export interface CacheEntry {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly fig: ParsedFig;
  readonly index: FileIndex;
  readonly loadedAt: number;
}

export interface CacheStats {
  /** Files decoded from bytes since the process started. */
  parses: number;
  /** Tool calls served from an already-decoded file. */
  hits: number;
  cached: number;
  maxFiles: number;
}

export class FileCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxFiles: number;
  readonly stats: CacheStats;

  constructor(maxFiles = 4) {
    this.maxFiles = Math.max(1, maxFiles);
    this.stats = { parses: 0, hits: 0, cached: 0, maxFiles: this.maxFiles };
  }

  /** Absolute path for a user-supplied `file` argument; relative paths resolve from CWD. */
  static resolve(file: string): string {
    return path.resolve(file);
  }

  get(file: string): CacheEntry {
    const abs = FileCache.resolve(file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new Error(`file not found: ${abs}`);
    }
    if (!stat.isFile()) throw new Error(`not a file: ${abs}`);

    const existing = this.entries.get(abs);
    if (existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size) {
      // Refresh LRU position.
      this.entries.delete(abs);
      this.entries.set(abs, existing);
      this.stats.hits++;
      return existing;
    }

    const fig = parseFig(fs.readFileSync(abs));
    const entry: CacheEntry = {
      path: abs,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      fig,
      index: new FileIndex(fig),
      loadedAt: Date.now(),
    };
    this.entries.delete(abs);
    this.entries.set(abs, entry);
    this.stats.parses++;
    while (this.entries.size > this.maxFiles) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.stats.cached = this.entries.size;
    return entry;
  }

  clear(): void {
    this.entries.clear();
    this.stats.cached = 0;
  }
}
