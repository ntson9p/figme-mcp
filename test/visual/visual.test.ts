/**
 * Fixture-based visual tests (render-implementation-plan.md §9.9).
 *
 * These run only when `fixtures/<design>/design.fig` files exist, so a clone without fixtures is
 * green and silent. Each fixture is a full parse, so this file is deliberately the only one that
 * touches them, and `VISUAL=0 npm test` skips it entirely when the machine is short of memory.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { rasterizer } from '../../dist/render/index.js';
import { discoverFixtures, FIXTURES_DIR, readExpectations } from './lib/fixtures.ts';
import { runFixture, RATCHET_SLACK, type FixtureRun } from './lib/cli.ts';
import { buildCoverage } from './lib/coverage.ts';

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
    for (const fixture of fixtures) {
      runs.push(await runFixture(fixture, { outDir: OUT }));
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
