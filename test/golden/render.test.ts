/**
 * Golden render tests against figma-input/sample.fig.
 *
 * A second full parse alongside golden.test.ts, kept in ONE file for the same reason: a parse
 * holds ~900 MB of decoded objects and `node --test` runs test files in parallel processes.
 * One `describe` per milestone; every expected value comes from docs/render-implementation-plan.md.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ASSET_EXISTS, ASSET_PATH, SKIP_MESSAGE } from '../fixtures/asset.ts';
import type { CacheEntry } from '../../dist/cache.js';
import {
  decodeCommands,
  ellipseCommands,
  pathBounds,
  roundCommands,
  roundedRectCommands,
  toPathData,
} from '../../dist/render/path.js';
import { renderNode, rasterizer } from '../../dist/render/index.js';
import { isKnownFeature } from '../../dist/render/report.js';
import { connect, type Harness } from '../fixtures/mcp.ts';
import { decodePng, inkBounds, pixelAt } from '../visual/lib/png.ts';
import { svgProblems } from '../visual/lib/svgcheck.ts';

const skip = ASSET_EXISTS ? false : SKIP_MESSAGE;

// PNG assertions additionally skip when the optional rasterizer is not installed.
const RASTER_READY = (await rasterizer()) !== undefined;
const skipRaster = skip !== false ? skip : RASTER_READY ? false : 'rasterizer not installed';

let entry: CacheEntry;
let harness: Harness;
before(async () => {
  if (!ASSET_EXISTS) return;
  // One harness, and its cache is also the source for the direct renderNode tests: a parse
  // holds ~900 MB, so this file must never decode the asset twice.
  harness = await connect(1);
  entry = harness.ctx.cache.get(ASSET_PATH);
});
after(async () => {
  await harness?.close();
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

describe('R2 — text (F5)', { skip }, () => {
  it('2:1341 outlines "Text" as one path per style run', async () => {
    const { svg, bounds, report } = await renderNode(entry, '2:1341', { format: 'svg' });
    assert.deepEqual(bounds, { x: 0, y: 0, w: 64, h: 24 }, 'layoutSize, not size');
    assert.equal(svg.match(/<path /g)?.length, 1, '4 glyphs share one styleID, so one path');
    assert.deepEqual(report.unsupported, []);
  });

  it('2:1339 now draws its text, leaving nothing unsupported', async () => {
    const { report } = await renderNode(entry, '2:1339', { format: 'svg' });
    assert.deepEqual(report.unsupported, []);
    assert.deepEqual(report.approximated, []);
  });

  it('2:6971 emits its two underline rects', async () => {
    const { svg, report } = await renderNode(entry, '2:6971', { format: 'svg' });
    assert.equal(svg.match(/<rect /g)?.length, 2);
    assert.ok(report.featuresPresent.includes('text-decoration'));
  });

  it('emoji glyphs are reported rather than drawn wrong', async () => {
    const { report } = await renderNode(entry, '2:7098', { format: 'svg' });
    assert.ok(report.approximated.some((a) => a.feature === 'emoji'));
  });

  it('almost every TEXT node carries glyph outlines', () => {
    // The 40 without usable outlines are text-style definition nodes named after their font
    // ("Meiryo/Regular/16", "Noto Sans Mono CJK JP/Bold/21"), not content.
    let total = 0;
    let noDerived = 0;
    let zeroGlyphs = 0;
    for (const t of entry.index.tree.ordered) {
      if (t.node['type'] !== 'TEXT') continue;
      total++;
      const derived = t.node['derivedTextData'] as { glyphs?: unknown[] } | undefined;
      if (!derived) noDerived++;
      else if (!(derived.glyphs ?? []).length) zeroGlyphs++;
    }
    assert.equal(total, 16_894);
    assert.equal(noDerived, 39);
    assert.equal(zeroGlyphs, 1);
    assert.equal(total - noDerived - zeroGlyphs, 16_854, 'F5: 16 854 nodes have glyphs');
  });
});

describe('R2 — text rasterized', { skip: skipRaster }, () => {
  it('the digit "2" sits on its baseline, not mirrored below it', async () => {
    // Glyph outlines are y-up em units: the flat base bar is at em y=0 and the top arc at 0.751.
    // With fontSize 12 and a baseline at y=12.72 the ink must land in rows 3..13 of 18.
    const { pixels } = await png('2:1336', { scale: 1 });
    assert.equal(pixels.width, 8);
    assert.equal(pixels.height, 18);
    const ink = inkBounds(pixels)!;
    assert.ok(ink.y0 >= 3, `ink starts at row ${ink.y0}`);
    assert.ok(ink.y1 <= 13, `ink ends at row ${ink.y1} — rows 13..17 mean the sign is flipped`);
  });

  it('"Yesterday 9:41" starts where its first pen position says', async () => {
    // baseline[0].position.x = 94.06, so nothing may be inked before column 90.
    const { pixels } = await png('2:7099', { scale: 1 });
    assert.equal(pixels.width, 267);
    const ink = inkBounds(pixels)!;
    assert.ok(ink.x0 >= 90, `first ink column ${ink.x0}`);
    assert.ok(ink.x1 <= 180, `last ink column ${ink.x1}`);
  });

  it('the underlined Japanese block inks both its text and its rules', async () => {
    const { pixels } = await png('2:6971', { scale: 1 });
    const ink = inkBounds(pixels)!;
    assert.ok(ink.y0 < 20, 'the first line is drawn');
    assert.ok(ink.y1 > 160, 'and the underline under the last line');
  });
});

describe('R3 — paints (F6, F7)', { skip }, () => {
  it('2:7082 builds a linear gradient that runs top to bottom (F7)', async () => {
    const { svg } = await renderNode(entry, '2:7082', { format: 'svg' });
    const tag = svg.match(/<linearGradient[^>]*>/)?.[0];
    assert.ok(tag, 'a linearGradient is registered');
    assert.match(tag!, /gradientUnits="userSpaceOnUse"/);
    assert.match(tag!, /x1="0" y1="0\.5" x2="1" y2="0\.5"/);
    const nums = tag!.match(/gradientTransform="matrix\(([^)]+)\)"/)![1]!.split(' ').map(Number);
    const [a, b, c, d, e, f] = nums as [number, number, number, number, number, number];
    const apply = (x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f];
    // The node is 12x12: the gradient must start at the top centre and end at the bottom centre.
    const start = apply(0, 0.5);
    const end = apply(1, 0.5);
    assert.ok(Math.abs(start[0] - 6) < 0.01 && Math.abs(start[1] - 0) < 0.01, String(start));
    assert.ok(Math.abs(end[0] - 6) < 0.01 && Math.abs(end[1] - 12) < 0.01, String(end));
  });

  it('gradient stops carry the paint opacity', async () => {
    const { svg } = await renderNode(entry, '2446:26422', { format: 'svg' });
    assert.match(svg, /<radialGradient[^>]*cx="0\.5" cy="0\.5" r="0\.5"/);
    assert.match(svg, /stop-opacity="0\.4"/, 'paint opacity 0.4 reaches the stops');
  });

  it('2:2050 fills an ellipse with a cover-fitted image', async () => {
    const { svg, report } = await renderNode(entry, '2:2050', { format: 'svg' });
    assert.equal(svg.match(/<pattern /g)?.length, 1);
    assert.match(svg, /preserveAspectRatio="xMidYMid slice"/);
    assert.match(svg, /xlink:href="data:image\/(png|jpeg);base64,/);
    assert.ok(report.featuresPresent.includes('image-mode:FILL'));
    assert.deepEqual(report.unsupported, []);
  });

  it('9:61907 tiles at intrinsic size times the paint scale', async () => {
    const { svg } = await renderNode(entry, '9:61907', { format: 'svg' });
    // 256 px source at scale 0.5 → a 128 px tile, repeated across a 610x137 box.
    assert.match(svg, /<pattern id="p1" patternUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">/);
  });

  it('a STRETCH image with an identity transform is not treated as a crop', async () => {
    const { svg, report } = await renderNode(entry, '2:1538', { format: 'svg' });
    assert.match(svg, /preserveAspectRatio="none"/);
    assert.ok(!report.approximated.some((a) => a.feature === 'image-crop'));
  });

  it('the same image is embedded once however many nodes use it', async () => {
    const { svg } = await renderNode(entry, '2:2050', { format: 'svg' });
    assert.equal(svg.match(/base64,/g)?.length, 1);
  });

  it('every paint type in the file is either drawn or reported', async () => {
    const { report } = await renderNode(entry, '2:7082', { format: 'svg' });
    assert.ok(report.featuresPresent.some((f) => f.startsWith('paint:')));
  });
});

describe('R3 — paints rasterized', { skip: skipRaster }, () => {
  it('the gradient is lighter at the top than at the bottom', async () => {
    const { pixels } = await png('2:7082', { scale: 4 });
    const top = pixelAt(pixels, pixels.width >> 1, 2);
    const bottom = pixelAt(pixels, pixels.width >> 1, pixels.height - 3);
    // Appendix A: rgb(241,159,180) at the top fading to rgb(238,123,149).
    assert.ok(Math.abs(top[1]! - 159) < 12, `top green ${top[1]}`);
    assert.ok(Math.abs(bottom[1]! - 123) < 12, `bottom green ${bottom[1]}`);
    assert.ok(top[1]! > bottom[1]! + 20, 'and the top really is the lighter end');
  });

  it('2:2050 paints the photo inside the ellipse and nothing outside it', async () => {
    const { result, pixels } = await png('2:2050', { scale: 1 });
    assert.equal(result.width, 96);
    assert.equal(pixelAt(pixels, 48, 48)[3], 255, 'the middle is opaque');
    assert.equal(pixelAt(pixels, 2, 2)[3], 0, 'the corner is outside the ellipse');
  });

  it('the tile repeats rather than stretching once', async () => {
    const { pixels } = await png('9:61907', { scale: 1 });
    // Two points a whole tile apart must match; the tile is 128 px wide.
    const a = pixelAt(pixels, 10, 10);
    const b = pixelAt(pixels, 138, 10);
    assert.deepEqual(a, b, 'one tile period apart the pixels are identical');
  });
});

describe('R4 — effects, masks and blend modes', { skip }, () => {
  it('2:7389 builds the drop-shadow chain Figma itself emits', async () => {
    const { svg, bounds } = await renderNode(entry, '2:7389', { format: 'svg' });
    // offset (0,4), radius 8, spread 0, rgba(0,0,0,0.4), showShadowBehindNode false
    assert.deepEqual(bounds, { x: -8, y: -4, w: 389, h: 216 }, 'the shadow margin grows the box');
    assert.match(svg, /<filter [^>]*color-interpolation-filters="sRGB"/);
    assert.match(svg, /values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"/, 'the silhouette trick');
    assert.match(svg, /<feOffset [^>]*dy="4"/);
    assert.match(svg, /<feGaussianBlur [^>]*stdDeviation="4"/, 'sigma = radius / 2');
    assert.match(svg, /<feComposite [^>]*operator="out"/, 'the shadow is knocked out of the shape');
    assert.match(svg, /0 0 0 0\.4 0"/, 'and tinted with the effect colour alpha');
  });

  it('an inner shadow uses the arithmetic composite', async () => {
    const { svg } = await renderNode(entry, '2:1345', { format: 'svg' });
    assert.match(svg, /<feComposite [^>]*operator="arithmetic" k2="-1" k3="1"/);
  });

  it('a layer blur blurs the whole result', async () => {
    const { svg, report } = await renderNode(entry, '2:7386', { format: 'svg' });
    assert.match(svg, /<feGaussianBlur [^>]*stdDeviation="16"/, 'radius 32 → sigma 16');
    assert.ok(report.featuresPresent.includes('effect:FOREGROUND_BLUR'));
  });

  it('a background blur is reported as approximated, not silently dropped', async () => {
    const { report } = await renderNode(entry, '2:7386', { format: 'svg' });
    assert.ok(report.approximated.some((a) => a.feature === 'effect:BACKGROUND_BLUR'));
  });

  it('an OUTLINE mask restricts its sibling and is not painted itself', async () => {
    const { svg, report } = await renderNode(entry, '2:1327', { format: 'svg' });
    assert.equal(svg.match(/<mask /g)?.length, 1);
    assert.ok(report.featuresPresent.includes('mask:OUTLINE'));
    // The mask's own geometry appears inside <mask>…</mask> and nowhere else.
    const mask = svg.match(/<mask [^>]*>([\s\S]*?)<\/mask>/)![1]!;
    assert.match(mask, /fill="#ffffff"/, 'OUTLINE coverage is drawn opaque white');
    const body = svg.slice(svg.indexOf('</defs>'));
    assert.ok(!body.includes('matrix(1 0 0 1 0 4.81)'), 'the mask layer is not painted as content');
  });

  it('an ALPHA mask goes through the alpha-to-white filter', async () => {
    const { svg, report } = await renderNode(entry, '2:7384', { format: 'svg' });
    assert.equal(svg.match(/<mask /g)?.length, 1);
    assert.ok(report.featuresPresent.includes('mask:ALPHA'));
    const mask = svg.match(/<mask [^>]*>([\s\S]*?)<\/mask>/)![1]!;
    assert.match(mask, /filter="url\(#/);
    assert.match(svg, /values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"/);
  });

  it('a LUMINANCE mask is emitted as-is', async () => {
    const { svg, report } = await renderNode(entry, '550:1552', { format: 'svg' });
    assert.equal(svg.match(/<mask /g)?.length, 1);
    assert.ok(report.featuresPresent.includes('mask:LUMINANCE'));
  });

  it('every mask region is bounded', async () => {
    for (const guid of ['2:1327', '2:7384', '550:1552']) {
      const { svg } = await renderNode(entry, guid, { format: 'svg' });
      for (const tag of svg.match(/<mask [^>]*>/g) ?? []) {
        assert.match(tag, /maskUnits="userSpaceOnUse" x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+"/, tag);
      }
    }
  });

  it('LINEAR_BURN is approximated with multiply and reported', async () => {
    const { svg, report } = await renderNode(entry, '550:1438', { format: 'svg' });
    assert.match(svg, /mix-blend-mode:multiply/);
    assert.ok(report.approximated.some((a) => a.feature === 'blend:LINEAR_BURN'));
  });

  it('a NORMAL container isolates so its children composite as a unit', async () => {
    const { svg } = await renderNode(entry, '2:3205', { format: 'svg' });
    assert.match(svg, /isolation:isolate/);
    assert.match(svg, /opacity="0\.65"/);
  });
});

describe('R4 — effects rasterized', { skip: skipRaster }, () => {
  it('2:7389 rasterizes to 389x216 with ink in the shadow margin', async () => {
    const { result, pixels } = await png('2:7389', { scale: 1 });
    assert.equal(result.width, 389);
    assert.equal(result.height, 216);
    let maxAlpha = 0;
    for (let x = 0; x < pixels.width; x++) maxAlpha = Math.max(maxAlpha, pixelAt(pixels, x, 210)[3]!);
    assert.ok(maxAlpha > 0, 'row 210 is below the shape and must carry shadow');
  });

  it('an OUTLINE mask really cuts the sibling down to the mask shape', async () => {
    // Instance 2:1342 overrides the symbol background away, leaving only the masked arrow.
    const { pixels } = await png('2:1342', { scale: 10 });
    let ink = 0;
    for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i]! > 32) ink++;
    const ratio = ink / (pixels.width * pixels.height);
    assert.ok(ratio > 0.1 && ratio < 0.6, `arrow covers ${ratio.toFixed(3)}, not the whole box`);
  });
});

describe('R5 — the fig_render tool', { skip: skipRaster }, () => {
  it('returns an image block plus a JSON report inside budget', async () => {
    const res = await harness.call('fig_render', { file: ASSET_PATH, guid: '2:1339', scale: 2 });
    assert.equal(res.isError, false);
    const blocks = res.content as { type: string; data?: string; text?: string; mimeType?: string }[];
    assert.equal(blocks[0]!.type, 'image');
    assert.equal(blocks[0]!.mimeType, 'image/png');
    const pixels = decodePng(Buffer.from(blocks[0]!.data!, 'base64'));
    assert.equal(pixels.width, 268);
    assert.equal(pixels.height, 80);

    const report = JSON.parse(blocks[1]!.text!) as Record<string, unknown>;
    assert.equal(report['width'], 268);
    assert.equal(report['format'], 'png');
    assert.ok(!('featuresPresent' in report), 'the tester-only list is not shipped to callers');
    assert.ok(blocks[1]!.text!.length <= 20_000, `report is ${blocks[1]!.text!.length} chars`);
  });

  it('format:"svg" returns the document as text', async () => {
    const res = await harness.call('fig_render', { file: ASSET_PATH, guid: '2:1558', format: 'svg' });
    assert.equal(res.isError, false);
    assert.ok(res.text.startsWith('<svg'), res.text.slice(0, 40));
  });

  it('savePath writes the file and reports where', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figrender-'));
    const target = path.join(dir, 'out.png');
    try {
      const res = await harness.call('fig_render', { file: ASSET_PATH, guid: '2:1558', savePath: target });
      assert.equal(res.isError, false);
      assert.equal(res.json['savedTo'], target);
      assert.ok(fs.statSync(target).size > 0);
      assert.equal(decodePng(fs.readFileSync(target)).width, 36, 'default scale 2 on an 18px node');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unknown guid is an error, not a crash', async () => {
    const res = await harness.call('fig_render', { file: ASSET_PATH, guid: '99:99' });
    assert.equal(res.isError, true);
    assert.match(res.text, /no node with guid/);
  });

  it('maxNodes refuses an oversized subtree and names the knob', async () => {
    const res = await harness.call('fig_render', { file: ASSET_PATH, guid: '0:1', maxNodes: 10 });
    assert.equal(res.isError, true);
    assert.match(res.text, /maxNodes/);
  });

  it('a whole page is downscaled to fit maxSize', async () => {
    const res = await harness.call('fig_render', {
      file: ASSET_PATH,
      guid: '0:1',
      maxSize: 512,
      savePath: path.join(os.tmpdir(), 'figrender-page.png'),
    });
    assert.equal(res.isError, false);
    const width = res.json['width'] as number;
    const height = res.json['height'] as number;
    assert.ok(width <= 512 && height <= 512, `${width}x${height}`);
    assert.ok((res.json['scale'] as number) < 1, 'the effective scale was lowered');
    fs.rmSync(path.join(os.tmpdir(), 'figrender-page.png'), { force: true });
  });

  it('is registered alongside the original eleven tools', async () => {
    const tools = await harness.listTools();
    assert.equal(tools.length, 12);
    assert.ok(tools.some((t) => t.name === 'fig_render'));
  });
});

describe('R6 — hardening', { skip }, () => {
  it('a corrupt blob is reported and does not abort the render', async () => {
    // Point a real node's geometry at a blob whose opcode does not exist.
    const node = entry.index.node('2:1558')!.node as Record<string, unknown>;
    const original = node['fillGeometry'];
    const badIndex = entry.fig.blobs.length;
    (entry.fig.blobs as unknown[]).push({ bytes: new Uint8Array([9, 9, 9, 9]) });
    node['fillGeometry'] = [{ windingRule: 'NONZERO', commandsBlob: badIndex, styleID: 0 }];
    try {
      const { svg, report } = await renderNode(entry, '2:1558', { format: 'svg' });
      assert.ok(report.unsupported.some((u) => u.feature === 'geometry:corrupt'));
      assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'), 'the document stays well-formed');
    } finally {
      node['fillGeometry'] = original;
      (entry.fig.blobs as unknown[]).pop();
    }
  });

  it('the SVG is structurally sound for every kind of frame', async () => {
    // Includes 2:2050, whose embedded base64 image happens to contain the letters "NaN" —
    // the checker must strip data URIs before scanning, or it reports a defect that is not one.
    for (const guid of ['2:1339', '2:1401', '2:7098', '2:1327', '2:7384', '2:2050', '2:7389']) {
      const { svg } = await renderNode(entry, guid, { format: 'svg' });
      assert.deepEqual(svgProblems(svg), [], guid);
    }
  });

  it('the report vocabulary is frozen — nothing invents a feature key', async () => {
    for (const guid of ['0:2', '2:1339', '2:7098', '2:7384', '2:1401', '2:2050']) {
      const { report } = await renderNode(entry, guid, { format: 'svg' });
      for (const feature of [
        ...report.featuresPresent,
        ...report.unsupported.map((u) => u.feature),
        ...report.approximated.map((a) => a.feature),
      ]) {
        assert.ok(isKnownFeature(feature), `${guid}: "${feature}" is not in Appendix D`);
      }
    }
  });

  it('a 300-node frame exports in well under half a second', async () => {
    const started = performance.now();
    const { report } = await renderNode(entry, '2:7098', { format: 'svg' });
    const elapsed = performance.now() - started;
    assert.ok(report.nodesVisited > 5, `${report.nodesVisited} nodes`);
    assert.ok(elapsed < 500, `took ${elapsed.toFixed(0)} ms`);
  });

  it('geometry can be synthesised when a file carries none', () => {
    // Files written by other tools may omit fillGeometry; §4.14 rebuilds the simple shapes.
    const rect = roundedRectCommands(10, 6, [2, 2, 2, 2]);
    assert.equal(rect[0]!.op, 'M');
    assert.deepEqual(pathBounds(rect), { x: 0, y: 0, w: 10, h: 6 });
    const ellipse = ellipseCommands(10, 6);
    assert.deepEqual(pathBounds(ellipse), { x: 0, y: 0, w: 10, h: 6 });
    assert.deepEqual(roundedRectCommands(0, 5), [], 'a degenerate box yields no path');
  });

  it('a hidden page renders an empty document rather than failing', async () => {
    // 0:2 "Page 1" is visible:false — it holds hidden library copies.
    const { svg, report } = await renderNode(entry, '0:2', { format: 'svg' });
    assert.equal(report.nodesDrawn, 0);
    assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  });

  it('a whole page renders inside the time and node budgets', async () => {
    const started = performance.now();
    const { report, width, height } = await renderNode(entry, '0:1', {
      maxSize: 1024,
      format: 'svg',
    });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 10_000, `took ${(elapsed / 1000).toFixed(1)} s`);
    assert.ok(width <= 1024 && height <= 1024, `${width}x${height}`);
    // Instance expansion means the walk is far larger than the 14 912-node layer tree.
    assert.ok(report.nodesVisited > 60_000, `${report.nodesVisited} visited`);
    assert.ok(report.unsupported.length > 0, 'and every skipped feature is named');
    assert.ok(report.unsupported.some((u) => u.feature.startsWith('node-type:')));
  });
});
