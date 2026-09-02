/**
 * Golden render tests against figma-input/sample.fig.
 *
 * A second full parse alongside golden.test.ts, kept in ONE file for the same reason: a parse
 * holds ~900 MB of decoded objects and `node --test` runs test files in parallel processes.
 * One `describe` per milestone; every expected value comes from docs/render-implementation-plan.md.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_EXISTS, ASSET_PATH, SKIP_MESSAGE } from '../fixtures/asset.ts';
import { FileCache, type CacheEntry } from '../../dist/cache.js';
import { decodeCommands, roundCommands, toPathData } from '../../dist/render/path.js';

const skip = ASSET_EXISTS ? false : SKIP_MESSAGE;

let entry: CacheEntry;
before(() => {
  if (ASSET_EXISTS) entry = new FileCache(1).get(ASSET_PATH);
});

describe('R0 — path command blobs (F4)', { skip }, () => {
  it('node 2:1558 is the 18x14 rounded rectangle the golden was measured on', () => {
    const t = entry.index.node('2:1558')!;
    assert.equal(t.node['type'], 'ROUNDED_RECTANGLE');
    assert.deepEqual(t.node['size'], { x: 18, y: 14 });
    const geometry = t.node['fillGeometry'] as { commandsBlob: number; windingRule: string }[];
    assert.equal(geometry.length, 1);
    assert.equal(geometry[0]!.commandsBlob, 390);
    assert.equal(geometry[0]!.windingRule, 'NONZERO');
  });

  it('blob 390 has the exact bytes recorded in F4', () => {
    const raw = entry.fig.blobs[390]!['bytes'] as Uint8Array;
    assert.equal(raw.length, 146);
    assert.equal(
      Buffer.from(raw.subarray(0, 64)).toString('hex'),
      '0100000000ffffff3f0400000000ed3a653ff03a653f0000000000000040000000000200008041' +
        '000000000429d688410000000000009041f13a653f00009041',
    );
  });

  it('blob 390 decodes to the F4 golden path', () => {
    const raw = entry.fig.blobs[390]!['bytes'] as Uint8Array;
    const cmds = decodeCommands(raw);
    assert.equal(cmds.length, 10);
    assert.equal(
      toPathData(roundCommands(cmds, 1)),
      'M0,2 C0,0.9,0.9,0,2,0 L16,0 C17.1,0,18,0.9,18,2 L18,12 C18,13.1,17.1,14,16,14 ' +
        'L2,14 C0.9,14,0,13.1,0,12 L0,2 Z',
    );
  });

  it('every blob referenced by fill, stroke or glyph geometry decodes under the F4 grammar', () => {
    const referenced = new Set<number>();
    for (const t of entry.index.tree.ordered) {
      const n = t.node as Record<string, unknown>;
      for (const field of ['fillGeometry', 'strokeGeometry'] as const) {
        for (const p of (n[field] ?? []) as { commandsBlob?: number }[]) {
          if (typeof p?.commandsBlob === 'number') referenced.add(p.commandsBlob);
        }
      }
      const glyphs = (n['derivedTextData'] as { glyphs?: { commandsBlob?: number }[] } | undefined)?.glyphs;
      for (const g of glyphs ?? []) {
        if (typeof g?.commandsBlob === 'number') referenced.add(g.commandsBlob);
      }
    }

    let decoded = 0;
    let empty = 0;
    const failures: string[] = [];
    for (const i of referenced) {
      const raw = entry.fig.blobs[i]?.['bytes'] as Uint8Array | undefined;
      if (!raw) {
        failures.push(`blob ${i} has no bytes`);
        continue;
      }
      if (raw.length === 0) {
        empty++;
        continue;
      }
      try {
        decodeCommands(raw);
        decoded++;
      } catch (err) {
        failures.push(`blob ${i}: ${(err as Error).message}`);
      }
    }

    assert.deepEqual(failures, [], 'no referenced path blob may fail to decode');
    assert.equal(referenced.size, 7293);
    assert.equal(decoded, 7292);
    assert.equal(empty, 1, 'the single empty blob belongs to zero-height lines');
  });
});
