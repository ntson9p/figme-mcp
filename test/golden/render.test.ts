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
import { renderNode, rasterizer } from '../../dist/render/index.js';
import { decodePng, inkBounds, pixelAt } from '../visual/lib/png.ts';

const skip = ASSET_EXISTS ? false : SKIP_MESSAGE;

// PNG assertions additionally skip when the optional rasterizer is not installed.
const RASTER_READY = (await rasterizer()) !== undefined;
const skipRaster = skip !== false ? skip : RASTER_READY ? false : 'rasterizer not installed';

let entry: CacheEntry;
before(() => {
  if (ASSET_EXISTS) entry = new FileCache(1).get(ASSET_PATH);
});

/** Render and decode in one step; every PNG assertion below goes through this. */
async function png(guid: string, opts: Record<string, unknown> = {}) {
  const result = await renderNode(entry, guid, opts);
  return { result, pixels: decodePng(result.png!) };
}

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

describe('R1 — exporter core', { skip }, () => {
  it('2:1558 becomes a single filled path', async () => {
    const { svg, bounds, report } = await renderNode(entry, '2:1558', { format: 'svg' });
    assert.equal(svg.match(/<path /g)?.length, 1);
    assert.match(svg, /fill="#/);
    assert.deepEqual(bounds, { x: 0, y: 0, w: 18, h: 14 });
    assert.deepEqual(report.unsupported, []);
    assert.deepEqual(report.approximated, []);
  });

  it('2:1339 clips its children and reports the frame it drew', async () => {
    const { svg, bounds, report } = await renderNode(entry, '2:1339', { format: 'svg' });
    assert.equal(svg.match(/<clipPath /g)?.length, 1, 'the frame clips');
    assert.deepEqual(bounds, { x: 0, y: 0, w: 134, h: 40 });
    assert.equal(report.nodesDrawn, 4, 'frame + 3 visible children; 2:1343 is hidden');
    assert.ok(report.featuresPresent.includes('stroke-align:INSIDE'));
  });

  it('an INSIDE stroke is clipped to the fill shape, not drawn at double width', async () => {
    // The stored band reaches y=41 on a 40-tall frame; unclipped it would bleed 1px below.
    const raw = entry.index.node('2:1339')!.node['strokeGeometry'] as { commandsBlob: number }[];
    const cmds = decodeCommands(entry.fig.blobs[raw[0]!.commandsBlob]!['bytes'] as Uint8Array);
    const band = toPathData(cmds);
    assert.match(band, /L134,41/, 'the stored geometry really does extend past the box');

    const { svg, bounds } = await renderNode(entry, '2:1339', { format: 'svg' });
    assert.equal(bounds.h, 40, 'bounds must not include the unclipped band');
    assert.match(svg, /<g clip-path="url\(#p1\)"><path d="M0,0 L134,0/, 'strokes are wrapped in the fill clip');
  });

  it('a BOOLEAN_OPERATION draws its combined geometry and never its operands', async () => {
    const { svg, report } = await renderNode(entry, '2:1307', { format: 'svg' });
    assert.equal(svg.match(/<path /g)?.length, 1);
    assert.equal(report.nodesDrawn, 1, 'the two operands are not drawn');
    assert.equal(report.nodesVisited, 1, 'and not even visited');
  });

  it('the root is drawn in its own space, so no transform reaches the top group', async () => {
    const { svg } = await renderNode(entry, '2:1558', { format: 'svg' });
    assert.match(svg, /viewBox="0 0 18 14"><g><path/, 'the root group carries no transform');
  });

  it('refuses the DOCUMENT node and unknown guids with an actionable message', async () => {
    await assert.rejects(() => renderNode(entry, '0:0'), /render a page or a node/);
    await assert.rejects(() => renderNode(entry, '99:99'), /no node with guid/);
  });

  it('refuses a subtree larger than maxNodes before exporting anything', async () => {
    await assert.rejects(() => renderNode(entry, '0:1', { maxNodes: 10 }), /above maxNodes/);
  });
});

describe('R1 — rasterized output', { skip: skipRaster }, () => {
  it('2:1558 rasterizes to 18x14 with an opaque middle and soft corners', async () => {
    const { result, pixels } = await png('2:1558', { scale: 1 });
    assert.equal(result.width, 18);
    assert.equal(result.height, 14);
    assert.equal(pixels.width, 18, 'the reported size matches the actual PNG');
    assert.equal(pixels.height, 14);
    assert.equal(pixelAt(pixels, 9, 7)[3], 255, 'the middle is opaque');
    assert.ok(pixelAt(pixels, 0, 0)[3] < 128, 'the rounded corner is not');
  });

  it('2:1339 rasterizes to 268x80 at scale 2', async () => {
    const { result, pixels } = await png('2:1339', { scale: 2 });
    assert.equal(result.width, 268);
    assert.equal(result.height, 80);
    assert.equal(pixels.width, 268);
    assert.equal(pixels.height, 80);
  });

  it('2:1337 draws a 1px inside border, not a 2px one straddling the edge', async () => {
    const { result, pixels } = await png('2:1337', { scale: 1 });
    assert.equal(result.width, 134);
    assert.equal(result.height, 40);
    const border = pixelAt(pixels, 0, 20);
    const inside = pixelAt(pixels, 10, 20);
    assert.equal(border[3], 255);
    assert.ok(border[0]! < 100, `left border is the dark stroke, got ${border.join(',')}`);
    assert.ok(inside[0]! > 200, `one pixel in is already the white fill, got ${inside.join(',')}`);
    assert.ok(pixelAt(pixels, 60, 0)[0]! < 100, 'top border');
    assert.ok(pixelAt(pixels, 60, 2)[0]! > 200, 'and the fill directly under it');
  });

  it('2:1307 keeps the hole its XOR punches', async () => {
    const { pixels } = await png('2:1307', { scale: 1 });
    assert.equal(pixelAt(pixels, 11, 11)[3], 0, 'the centre is knocked out');
    assert.equal(pixelAt(pixels, 11, 1)[3], 255, 'a tooth is drawn');
    assert.equal(pixelAt(pixels, 0, 0)[3], 0, 'the corner is empty');
    assert.deepEqual(inkBounds(pixels), { x0: 0, y0: 0, x1: 21, y1: 21 });
  });

  it('maxSize lowers the effective scale instead of cropping', async () => {
    const { result, pixels } = await png('2:1339', { scale: 4, maxSize: 200 });
    assert.ok(result.width <= 200 && result.height <= 200, `${result.width}x${result.height}`);
    assert.equal(pixels.width, result.width);
    assert.ok(result.report.scale < 4);
  });
});
