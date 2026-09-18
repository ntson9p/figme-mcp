// The four levels and the ceiling (render-implementation-plan.md §9.4). Not a test file.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileCache, type CacheEntry } from '../../../dist/cache.js';
import {
  HARD_MAX_SIZE,
  renderNode,
  rasterize,
  type RenderReport,
  type NodeBox,
} from '../../../dist/render/index.js';
import { attribute, type Attribution } from './attribute.ts';
import { compare, diffMask, type CompareResult } from './compare.ts';
import {
  guidToFileName,
  matchByName,
  readExpectations,
  type Expectations,
  type Fixture,
  type FixtureFrame,
} from './fixtures.ts';
import { decodePng, inkBounds, type Pixels } from './png.ts';
import { svgProblems } from './svgcheck.ts';

/** Initial thresholds from §9.4; R8 calibrates them against real exports. */
export const LEVEL3_MAX = 0.01;
export const LEVEL4_FLOOR = 0.03;
export const RATCHET_SLACK = 0.002;
export const SELF_CONSISTENCY_MAX = 0.02;

export interface LevelResult {
  readonly pass: boolean;
  readonly notes: string[];
  readonly diffRatio?: number;
  readonly badBlocks?: number;
  readonly skipped?: string;
}

export interface FrameResult {
  readonly design: string;
  readonly guid: string;
  readonly name?: string;
  readonly scale: number;
  readonly level1: LevelResult;
  readonly level2: LevelResult;
  readonly level3: LevelResult;
  readonly level4: LevelResult;
  /** How well Figma's own SVG matches Figma's own PNG through resvg — our practical best. */
  readonly ceiling?: number;
  readonly attributions: Attribution[];
  readonly report?: RenderReport;
  readonly images: { ours?: string; theirs?: string; diff?: string };
  readonly error?: string;
}

export interface RunOptions {
  readonly outDir: string;
  readonly only?: string;
  readonly update?: boolean;
  /** Reuse an existing cache so several fixtures over one file parse it once. */
  readonly cache?: FileCache;
}

const skipped = (why: string): LevelResult => ({ pass: true, notes: [], skipped: why });

/** Level 1 — the SVG is structurally sane and the rasterizer accepts it. */
function level1(svg: string, rasterOk: boolean, rasterError?: string): LevelResult {
  const notes = svgProblems(svg);
  if (!rasterOk) notes.push(`rasterizer rejected the SVG: ${rasterError ?? 'unknown'}`);
  return { pass: notes.length === 0, notes };
}

/** Level 2 — the render agrees with itself: declared size, scale independence, ink in frame. */
async function level2(
  entry: CacheEntry,
  guid: string,
  scale: number,
  ours: Pixels,
  report: RenderReport,
): Promise<LevelResult> {
  const notes: string[] = [];

  // The report's own width/height, not bounds × scale: `scale` is rounded for the report, and a
  // 3026-row frame rendered under a size cap lands one row off when recomputed from it.
  if (ours.width !== report.width || ours.height !== report.height) {
    notes.push(`PNG is ${ours.width}x${ours.height} but the report says ${report.width}x${report.height}`);
  }

  const ink = inkBounds(ours);
  if (ink && (ink.x1 >= ours.width || ink.y1 >= ours.height)) {
    notes.push('ink reaches the very edge — the render bounds may be too small');
  }

  // Rendering at half the scale and doubling must land in the same place.
  if (scale >= 2) {
    try {
      const half = await renderNode(entry, guid, { scale: scale / 2, maxSize: HARD_MAX_SIZE });
      if (half.png) {
        const result = compare(decodePng(half.png), ours, { downscale: true });
        if (result.status !== 'ok') {
          notes.push(`1x and 2x renders differ in size: ${JSON.stringify(result)}`);
        } else if ((result.diffRatio ?? 1) > SELF_CONSISTENCY_MAX) {
          notes.push(`1x vs 2x differ by ${(result.diffRatio! * 100).toFixed(2)}%`);
        }
      }
    } catch (err) {
      notes.push(`half-scale render failed: ${(err as Error).message}`);
    }
  }

  return { pass: notes.length === 0, notes };
}

function relative(outDir: string, file: string): string {
  return path.relative(outDir, file).split(path.sep).join('/');
}

async function rasterizeSvgFile(file: string, scale: number): Promise<Pixels | undefined> {
  const svg = fs.readFileSync(file, 'utf8');
  const raster = await rasterize(svg, scale);
  return raster ? decodePng(raster.png) : undefined;
}

/** Resolve name-matched frames to guids now that the file is parsed (§9.2). */
function resolveFrames(entry: CacheEntry, fixture: Fixture): {
  frames: FixtureFrame[];
  unmatched: { base: string; reason: string }[];
} {
  const frames: FixtureFrame[] = [];
  const unmatched: { base: string; reason: string }[] = [];

  for (const frame of fixture.frames) {
    if (frame.guid) {
      if (entry.index.node(frame.guid)) frames.push(frame);
      else unmatched.push({ base: frame.name ?? frame.guid, reason: `guid ${frame.guid} is not in this file` });
      continue;
    }
    const png = frame.png2x ?? frame.png;
    if (!png) {
      unmatched.push({ base: frame.name ?? '?', reason: 'no PNG to size-match against' });
      continue;
    }
    const pixels = decodePng(fs.readFileSync(png));
    const candidates = entry.index.tree.ordered
      .filter((t) => t.node['name'] === frame.name)
      .map((t) => {
        const size = t.node['size'] as { x?: number; y?: number } | undefined;
        return { guid: t.key, width: size?.x ?? 0, height: size?.y ?? 0 };
      });
    const match = matchByName(candidates, pixels.width, pixels.height, frame.scale);
    if (match.guid) frames.push({ ...frame, guid: match.guid, matchedBy: 'name' });
    else unmatched.push({ base: frame.name ?? '?', reason: match.reason ?? 'no match' });
  }
  return { frames, unmatched };
}

export interface FixtureRun {
  readonly fixture: Fixture;
  readonly frames: FrameResult[];
  readonly unmatched: { base: string; reason: string }[];
  readonly expectations: Expectations;
}

/**
 * Run every level that has the inputs it needs. Levels 3 and 4 are skipped per frame when the
 * fixture ships no Figma export, so a fixture that is only a `.fig` still exercises 1 and 2 and
 * still contributes to the coverage matrix.
 */
export async function runFixture(fixture: Fixture, opts: RunOptions): Promise<FixtureRun> {
  const entry = (opts.cache ?? new FileCache(1)).get(fixture.file);
  const { frames: resolved, unmatched } = resolveFrames(entry, fixture);
  const expectations = readExpectations(fixture);
  const outDir = path.join(opts.outDir, fixture.name);
  fs.mkdirSync(outDir, { recursive: true });

  const results: FrameResult[] = [];
  for (const frame of resolved) {
    if (opts.only && !`${fixture.name}/${frame.guid}`.includes(opts.only)) continue;
    results.push(await runFrame(entry, fixture, frame, outDir, opts));
  }
  return { fixture, frames: results, unmatched, expectations };
}

async function runFrame(
  entry: CacheEntry,
  fixture: Fixture,
  frame: FixtureFrame,
  outDir: string,
  opts: RunOptions,
): Promise<FrameResult> {
  const base = guidToFileName(frame.guid);
  const images: { ours?: string; theirs?: string; diff?: string } = {};
  let report: RenderReport | undefined;
  let boxes: readonly NodeBox[] = [];

  try {
    // An oracle comparison needs the export's own scale: the tool's default 1568 px cap would
    // shrink a tall frame to something its export can never match.
    const rendered = await renderNode(entry, frame.guid, {
      scale: frame.scale,
      maxSize: HARD_MAX_SIZE,
      collectBoxes: true,
    });
    report = rendered.report;
    boxes = rendered.boxes ?? [];

    let rasterOk = true;
    let rasterError: string | undefined;
    if (!rendered.png) {
      rasterOk = false;
      rasterError = 'no rasterizer installed';
    }
    const l1 = level1(rendered.svg, rasterOk, rasterError);
    if (!rendered.png) {
      return {
        design: fixture.name,
        guid: frame.guid,
        name: frame.name,
        scale: frame.scale,
        level1: l1,
        level2: skipped('no rasterizer'),
        level3: skipped('no rasterizer'),
        level4: skipped('no rasterizer'),
        attributions: [],
        report,
        images,
      };
    }

    const ours = decodePng(rendered.png);
    const oursFile = path.join(outDir, `${base}-ours.png`);
    fs.writeFileSync(oursFile, Buffer.from(rendered.png));
    images.ours = relative(opts.outDir, oursFile);

    const l2 = await level2(entry, frame.guid, frame.scale, ours, rendered.report);

    // Level 3 — our SVG against Figma's SVG, both through the same rasterizer.
    let l3: LevelResult = skipped('no Figma SVG export');
    if (frame.svg) {
      const figmaSvgText = fs.readFileSync(frame.svg, 'utf8');
      if (figmaSvgText.includes('<text')) {
        l3 = skipped('figma-svg-has-text — re-export with "Outline text" on');
      } else {
        const theirs = await rasterizeSvgFile(frame.svg, frame.scale);
        if (!theirs) l3 = skipped('no rasterizer');
        else {
          const result = compare(ours, theirs);
          l3 = gradeCompare(result, LEVEL3_MAX);
          if (figmaSvgText.includes('<foreignObject')) {
            l3.notes.push('figma-svg-has-foreignObject (background blur) — resvg ignores it');
          }
        }
      }
    }

    // Level 4 — our render against Figma's PNG, the truth.
    let l4: LevelResult = skipped('no Figma PNG export');
    let ceiling: number | undefined;
    let attributions: Attribution[] = [];
    const figmaPng = frame.scale === 2 ? frame.png2x : frame.png;
    if (figmaPng) {
      const theirs = decodePng(fs.readFileSync(figmaPng));
      fs.writeFileSync(path.join(outDir, `${base}-figma.png`), fs.readFileSync(figmaPng));
      images.theirs = relative(opts.outDir, path.join(outDir, `${base}-figma.png`));

      // The ceiling: Figma's own SVG through resvg against Figma's own PNG.
      if (frame.svg) {
        const figmaSvgRaster = await rasterizeSvgFile(frame.svg, frame.scale);
        if (figmaSvgRaster) {
          const c = compare(figmaSvgRaster, theirs);
          if (c.status === 'ok') ceiling = c.diffRatio;
        }
      }

      const result = compare(ours, theirs);
      const limit = Math.max(LEVEL4_FLOOR, (ceiling ?? 0) + 0.01);
      l4 = gradeCompare(result, limit);
      if (result.status === 'ok' && result.diffPng) {
        const diffFile = path.join(outDir, `${base}-diff.png`);
        fs.writeFileSync(diffFile, result.diffPng);
        images.diff = relative(opts.outDir, diffFile);
        const mask = diffMask(decodePng(result.diffPng));
        attributions = attribute(
          mask,
          result.width!,
          result.height!,
          boxes,
          // compare() halves the images, so one mask pixel is two output pixels.
          (rendered.width / rendered.bounds.w) / 2,
          rendered.bounds,
        );
      }
    }

    return {
      design: fixture.name,
      guid: frame.guid,
      name: frame.name,
      scale: frame.scale,
      level1: l1,
      level2: l2,
      level3: l3,
      level4: l4,
      ceiling,
      attributions,
      report,
      images,
    };
  } catch (err) {
    return {
      design: fixture.name,
      guid: frame.guid,
      name: frame.name,
      scale: frame.scale,
      level1: { pass: false, notes: [(err as Error).message] },
      level2: skipped('render failed'),
      level3: skipped('render failed'),
      level4: skipped('render failed'),
      attributions: [],
      report,
      images,
      error: (err as Error).message,
    };
  }
}

function gradeCompare(result: CompareResult, limit: number): LevelResult {
  if (result.status === 'size-mismatch') {
    return {
      pass: false,
      notes: [
        `size mismatch: ours ${result.ours?.width}x${result.ours?.height}, ` +
          `Figma ${result.theirs?.width}x${result.theirs?.height}`,
      ],
    };
  }
  const ratio = result.diffRatio ?? 1;
  return {
    pass: ratio <= limit,
    diffRatio: ratio,
    badBlocks: result.badBlocks,
    notes: ratio <= limit ? [] : [`${(ratio * 100).toFixed(2)}% differ (limit ${(limit * 100).toFixed(2)}%)`],
  };
}
