// Shared helper for model-level unit tests: a real FileIndex over synthetic records, so the code
// under test sees the same lookups (guid, asset key, tree, override identity) a parsed file has.
// Not a test file itself.
import type { CacheEntry } from '../../dist/cache.js';
import type { ParsedFig } from '../../dist/fig/parse.js';
import type { KiwiObject } from '../../dist/fig/kiwi.js';
import { FileIndex } from '../../dist/model/index.js';

export const guid = (s: string) => {
  const [sessionID, localID] = s.split(':').map(Number);
  return { sessionID, localID };
};

type SyntheticRecord = KiwiObject & { parent?: string };

function figOf(records: SyntheticRecord[]): ParsedFig {
  const nodeChanges = [
    { guid: guid('0:0'), type: 'DOCUMENT', name: 'Document' },
    { guid: guid('0:1'), type: 'CANVAS', name: 'Page', parentIndex: { guid: guid('0:0'), position: '!' } },
    ...records.map(({ parent, ...n }, i) => ({
      parentIndex: { guid: guid(parent ?? '0:1'), position: String.fromCharCode(34 + i) },
      ...n,
    })),
  ];
  return { nodeChanges, blobs: [] } as unknown as ParsedFig;
}

/**
 * A file: DOCUMENT 0:0 › CANVAS 0:1 › every record given. A record without `parentIndex` is
 * parented to the page; one with `parent: "a:b"` is parented to that node instead. Siblings keep
 * the order they are listed in.
 */
export function fileOf(records: SyntheticRecord[]): FileIndex {
  return new FileIndex(figOf(records));
}

/**
 * The same file as a cache entry, for the renderer. It has no blobs, so a shape is drawn from its
 * size and corner radii (§4.14) and text without glyph outlines is reported rather than drawn.
 */
export function entryOf(records: SyntheticRecord[]): CacheEntry {
  const fig = figOf(records);
  return { path: 'synthetic.fig', mtimeMs: 0, size: 0, fig, index: new FileIndex(fig), loadedAt: 0 };
}
