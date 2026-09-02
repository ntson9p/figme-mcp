/**
 * Fixture-based visual tests (render-implementation-plan.md §9.9).
 *
 * These run only when `fixtures/<design>/design.fig` files exist, so a clone without fixtures is
 * green and silent. Each fixture is a full parse, so this file is deliberately the only one that
 * touches them, and `VISUAL=0 npm test` skips it entirely when the machine is short of memory.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileCache } from '../../dist/cache.js';
import { rasterizer, renderNode } from '../../dist/render/index.js';
import {
  discoverFixtures,
  FIXTURES_DIR,
  readExpectations,
  writeExpectations,
  type Fixture,
} from './lib/fixtures.ts';
import { runFixture, RATCHET_SLACK, type FixtureRun } from './lib/cli.ts';
import { buildCoverage } from './lib/coverage.ts';
import { decodePng, encodePng } from './lib/png.ts';

const fixtures = process.env['VISUAL'] === '0' ? [] : discoverFixtures();
const RASTER_READY = (await rasterizer()) !== undefined;

const skip =
  process.env['VISUAL'] === '0'
    ? 'VISUAL=0'
    : fixtures.length === 0
      ? `no fixtures under ${FIXTURES_DIR} — see docs/render-fixtures.md`
      : RASTER_READY
        ? false
        : 'rasterizer not installed';

const OUT = path.join(FIXTURES_DIR, '..', 'reports', 'visual-test');

describe('visual fixtures', { skip }, () => {
  const runs: FixtureRun[] = [];

  before(async () => {
    const cache = new FileCache(2);
    for (const fixture of fixtures) {
      runs.push(await runFixture(fixture, { outDir: OUT, cache }));
    }
  });

  it('every fixture produced at least one frame to test', () => {
    for (const run of runs) {
      assert.ok(
        run.frames.length > 0,
        `${run.fixture.name} matched no frames; unmatched: ${JSON.stringify(run.unmatched)}`,
      );
    }
  });

  it('level 1 — every SVG is structurally sound and the rasterizer accepts it', () => {
    const failures: string[] = [];
    for (const run of runs) {
      for (const frame of run.frames) {
        if (frame.level1.skipped || frame.level1.pass) continue;
        failures.push(`${frame.design}/${frame.guid}: ${frame.level1.notes.join('; ')}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it('level 2 — every render agrees with itself across scales and its own report', () => {
    const failures: string[] = [];
    for (const run of runs) {
      for (const frame of run.frames) {
        if (frame.level2.skipped || frame.level2.pass) continue;
        failures.push(`${frame.design}/${frame.guid}: ${frame.level2.notes.join('; ')}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it('level 3 — geometry matches Figma\'s own SVG, where one is supplied', () => {
    const failures: string[] = [];
    let ran = 0;
    for (const run of runs) {
      for (const frame of run.frames) {
        if (frame.level3.skipped) continue;
        ran++;
        if (!frame.level3.pass) failures.push(`${frame.design}/${frame.guid}: ${frame.level3.notes.join('; ')}`);
      }
    }
    assert.deepEqual(failures, []);
    if (ran === 0) console.log('      (no fixture ships a Figma SVG export yet)');
  });

  it('level 4 — the render matches Figma\'s own PNG, where one is supplied', () => {
    const failures: string[] = [];
    let ran = 0;
    for (const run of runs) {
      for (const frame of run.frames) {
        if (frame.level4.skipped) continue;
        ran++;
        if (!frame.level4.pass) failures.push(`${frame.design}/${frame.guid}: ${frame.level4.notes.join('; ')}`);
      }
    }
    assert.deepEqual(failures, []);
    if (ran === 0) console.log('      (no fixture ships a Figma PNG export yet)');
  });

  it('the ratchet — no frame is worse than its recorded best', () => {
    const regressions: string[] = [];
    for (const run of runs) {
      const best = readExpectations(run.fixture);
      for (const frame of run.frames) {
        const recorded = best[frame.guid];
        if (!recorded) continue;
        for (const level of ['level3', 'level4'] as const) {
          const now = frame[level].diffRatio;
          const then = recorded[level];
          if (now === undefined || then === undefined) continue;
          if (now > then + RATCHET_SLACK) {
            regressions.push(
              `${frame.design}/${frame.guid} ${level}: ${(now * 100).toFixed(2)}% vs best ${(then * 100).toFixed(2)}%`,
            );
          }
        }
      }
    }
    assert.deepEqual(regressions, []);
  });

  it('the coverage matrix names every feature the corpus exercises', () => {
    const coverage = buildCoverage(
      runs.flatMap((run) =>
        run.frames.map((frame) => ({
          design: frame.design,
          guid: frame.guid,
          name: frame.name,
          features: frame.report?.featuresPresent ?? [],
          level3: frame.level3.skipped ? undefined : frame.level3.pass,
          level4: frame.level4.skipped ? undefined : frame.level4.pass,
        })),
      ),
    );
    assert.ok(coverage.featuresPresent > 0, 'the corpus exercises at least one feature');
    console.log(
      `      coverage: ${coverage.featuresProven}/${coverage.featuresPresent} features proven ` +
        `(${(coverage.score * 100).toFixed(0)}%)`,
    );
  });
});

/**
 * The oracle path (levels 3 and 4, the ceiling, attribution and the ratchet) cannot be exercised
 * without Figma exports, and this repository has none. These tests supply a SELF-oracle instead:
 * exports produced by our own renderer. That proves the machinery — matching, rasterizing an
 * external SVG, the comparison, the ceiling, attribution, the ratchet — end to end. It proves
 * nothing about fidelity to Figma, which is what real fixtures are for.
 */
describe('the oracle path, against a self-oracle', { skip }, () => {
  const GUIDS = ['2:1558', '2:1336', '2:1307'];
  let tmp: string;
  let fixture: Fixture;
  let cache: FileCache;

  before(async () => {
    cache = new FileCache(2);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figvisual-'));
    fs.mkdirSync(path.join(tmp, 'exports'), { recursive: true });
    const entry = cache.get(fixtures[0]!.file);

    const frames = [];
    for (const guid of GUIDS) {
      const base = guid.replace(':', '_');
      const one = await renderNode(entry, guid, { scale: 1 });
      const two = await renderNode(entry, guid, { scale: 2 });
      fs.writeFileSync(path.join(tmp, 'exports', `${base}.png`), Buffer.from(one.png!));
      fs.writeFileSync(path.join(tmp, 'exports', `${base}@2x.png`), Buffer.from(two.png!));
      fs.writeFileSync(path.join(tmp, 'exports', `${base}.svg`), one.svg, 'utf8');
      frames.push({
        guid,
        name: base,
        png: path.join(tmp, 'exports', `${base}.png`),
        png2x: path.join(tmp, 'exports', `${base}@2x.png`),
        svg: path.join(tmp, 'exports', `${base}.svg`),
        scale: 2,
        matchedBy: 'manifest' as const,
      });
    }

    fixture = {
      name: 'self-oracle',
      dir: tmp,
      // The same path as the real fixture, so the shared cache serves it without a second parse.
      file: fixtures[0]!.file,
      frames,
      unmatched: [],
      expectPath: path.join(tmp, 'expect.json'),
    };
  });

  after(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('levels 3 and 4 run and pass when an oracle is present', async () => {
    const run = await runFixture(fixture, { outDir: path.join(OUT, 'self-oracle'), cache });
    assert.equal(run.frames.length, GUIDS.length);
    for (const frame of run.frames) {
      assert.equal(frame.level3.skipped, undefined, `${frame.guid} level 3 was skipped`);
      assert.equal(frame.level4.skipped, undefined, `${frame.guid} level 4 was skipped`);
      assert.ok(frame.level3.pass, `${frame.guid} level 3: ${frame.level3.notes.join('; ')}`);
      assert.ok(frame.level4.pass, `${frame.guid} level 4: ${frame.level4.notes.join('; ')}`);
      assert.equal(frame.level3.diffRatio, 0, 'an identical SVG must differ by nothing');
      assert.equal(frame.level4.diffRatio, 0);
      assert.equal(frame.ceiling, 0, 'the ceiling is computed and, for a self-oracle, perfect');
      assert.deepEqual(frame.attributions, [], 'nothing to attribute when nothing differs');
      assert.ok(frame.images.ours && frame.images.theirs && frame.images.diff);
    }
  });

  /** Deface the 2x PNG oracle of 2:1307 with a red block, run, and restore. */
  async function withDefacedPng<T>(fn: () => Promise<T>): Promise<T> {
    const target = path.join(tmp, 'exports', '2_7@2x.png');
    const original = fs.readFileSync(target);
    const pixels = decodePng(original);
    for (let y = 10; y < pixels.height - 10; y++) {
      for (let x = 10; x < pixels.width - 10; x++) {
        const i = (y * pixels.width + x) * 4;
        pixels.data[i] = 255;
        pixels.data[i + 1] = 0;
        pixels.data[i + 2] = 0;
        pixels.data[i + 3] = 255;
      }
    }
    fs.writeFileSync(target, encodePng(pixels));
    try {
      return await fn();
    } finally {
      fs.writeFileSync(target, original);
    }
  }

  it('the ceiling absorbs a difference the SVG oracle also shows', async () => {
    // Deface only the PNG. Figma's own SVG then does not match Figma's own PNG either, so the
    // ceiling rises to meet the difference and level 4 correctly declines to blame us. This is
    // the whole point of measuring a ceiling.
    const run = await withDefacedPng(() =>
      runFixture(fixture, { outDir: path.join(OUT, 'self-oracle'), cache }),
    );
    const frame = run.frames.find((f) => f.guid === '2:1307')!;
    assert.ok((frame.level4.diffRatio ?? 0) > 0.1, 'the pixels really do differ');
    assert.ok((frame.ceiling ?? 0) > 0.1, 'and the ceiling rose with them');
    assert.equal(frame.level4.pass, true, 'so the difference is not attributed to our renderer');
    assert.ok(frame.level3.pass, 'the geometry check is untouched by a defaced PNG');
  });

  it('without a ceiling to excuse it, a real difference fails level 4 and names a layer', async () => {
    const svg = path.join(tmp, 'exports', '2_7.svg');
    const svgBody = fs.readFileSync(svg);
    fs.rmSync(svg);
    const withoutSvg: Fixture = {
      ...fixture,
      frames: fixture.frames.map((f) => (f.guid === '2:1307' ? { ...f, svg: undefined } : f)),
    };
    try {
      const run = await withDefacedPng(() =>
        runFixture(withoutSvg, { outDir: path.join(OUT, 'self-oracle'), cache }),
      );
      const frame = run.frames.find((f) => f.guid === '2:1307')!;
      assert.equal(frame.ceiling, undefined, 'no SVG export means no ceiling');
      assert.equal(frame.level4.pass, false, 'so the difference is ours to answer for');
      assert.ok((frame.level4.diffRatio ?? 0) > 0.1);
      assert.ok(frame.level4.notes.length > 0, 'and it says by how much');
      assert.ok(
        frame.attributions.some((a) => a.guid === '2:1307'),
        'attributed to ' + JSON.stringify(frame.attributions.map((a) => a.guid)),
      );
    } finally {
      fs.writeFileSync(svg, svgBody);
    }
  });
  it('the ratchet records improvements and catches regressions', () => {
    writeExpectations(fixture, { '2:1307': { level4: 0.5 } });
    assert.deepEqual(readExpectations(fixture), { '2:1307': { level4: 0.5 } });
    // A stored best of 0 means any measurable difference is a regression.
    writeExpectations(fixture, { '2:1307': { level4: 0 } });
    const best = readExpectations(fixture)['2:1307']!;
    assert.ok(0.05 > best.level4! + RATCHET_SLACK, 'a 5% diff regresses against a stored 0%');
    assert.ok(!(0.001 > best.level4! + RATCHET_SLACK), 'but 0.1% is inside the slack');
  });
});
