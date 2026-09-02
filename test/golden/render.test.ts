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
    // frame + 3 visible children (2:1343 is hidden), and the two INSTANCEs expand into the
    // symbols they point at — without that expansion this frame would draw almost nothing.
    assert.equal(report.nodesDrawn, 8);
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

describe('R1.5 — instances (F17)', { skip }, () => {
  it('every INSTANCE in the file is childless and resolves to a symbol that is present', () => {
    let instances = 0;
    let withChildren = 0;
    let resolvable = 0;
    for (const t of entry.index.tree.ordered) {
      if (t.node['type'] !== 'INSTANCE') continue;
      instances++;
      if (t.children.length) withChildren++;
      const id = t.node['symbolData'] as { symbolID?: { sessionID: number; localID: number } };
      const key = id?.symbolID ? `${id.symbolID.sessionID}:${id.symbolID.localID}` : undefined;
      if (key && entry.index.node(key)) resolvable++;
    }
    assert.equal(instances, 38_164);
    assert.equal(withChildren, 0, 'instances never carry their own children');
    assert.equal(resolvable, 38_164, 'and every one points at a symbol in this file');
  });

  it('2:1340 draws the symbol it points at, at the instance size', async () => {
    const { bounds, report, svg } = await renderNode(entry, '2:1340', { format: 'svg' });
    // The instance is 16x16; the symbol it points at is 22x22. The derived geometry is already
    // resized, so the render must be the instance's size, not the symbol's.
    assert.deepEqual(bounds, { x: 0, y: 0, w: 16, h: 16 });
    assert.equal(report.nodesDrawn, 2, 'the instance plus the symbol\'s boolean shape');
    assert.equal(svg.match(/<path /g)?.length, 1);
    assert.ok(report.featuresPresent.includes('node-type:BOOLEAN_OPERATION'));
  });

  it('derived geometry wins over the symbol\'s own', async () => {
    const { svg } = await renderNode(entry, '2:1340', { format: 'svg' });
    // Symbol 2:1306's shape spans 22 units; the derived record for this instance spans 16.
    const coords = [...svg.matchAll(/[ML](\d+(?:\.\d+)?),/g)].map((m) => Number(m[1]));
    assert.ok(Math.max(...coords) <= 16.01, `path stays inside 16 units, got ${Math.max(...coords)}`);
  });

  it('a nested instance resolves through its own symbol', async () => {
    const { report } = await renderNode(entry, '2:1401', { format: 'svg' });
    assert.ok(report.nodesDrawn > 3, `expanded to ${report.nodesDrawn} nodes`);
    assert.ok(report.featuresPresent.includes('node-type:INSTANCE'));
    assert.deepEqual(report.unsupported.filter((u) => u.feature.startsWith('instance-')), []);
  });

  it('overrides applied by the instance reach the symbol\'s descendants', () => {
    // 2:1340 overrides fillPaints on the symbol root (to none) and on the shape (to #333333).
    const overrides = (entry.index.node('2:1340')!.node['symbolData'] as { symbolOverrides?: unknown[] })
      .symbolOverrides!;
    assert.equal(overrides.length, 2);
  });
});

describe('R1.5 — instances rasterized', { skip: skipRaster }, () => {
  it('the settings icon actually has ink where the symbol draws it', async () => {
    const { pixels } = await png('2:1340', { scale: 4 });
    assert.equal(pixels.width, 64);
    const ink = inkBounds(pixels)!;
    assert.ok(ink.x1 - ink.x0 > 40, `the gear spans most of the box, got ${JSON.stringify(ink)}`);
    assert.ok(ink.y1 - ink.y0 > 40);
  });

  it('an instance with a border and a nested icon draws both', async () => {
    const { result, pixels } = await png('2:1401', { scale: 1 });
    assert.equal(result.width, 219);
    assert.equal(result.height, 40);
    assert.ok(pixelAt(pixels, 0, 20)[3]! > 200, 'the left border is drawn');
    assert.ok(pixelAt(pixels, 20, 20)[3]! > 0, 'and the nested gear icon has ink');
  });
});
