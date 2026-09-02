#!/usr/bin/env node
// Visual regression tester (render-implementation-plan.md §9).
//
// Usage:
//   node scripts/visual.mjs [--fixtures <dir>] [--only <design>[/<guid>]] [--update] [--out <dir>]
//
// Levels 1 and 2 need nothing but the .fig. Levels 3 and 4 compare against Figma's own SVG and
// PNG exports and are skipped per frame when a fixture does not ship them.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!fs.existsSync(path.join(ROOT, 'dist', 'render', 'index.js'))) {
  console.error('ERROR: dist/render/index.js is missing — run `npm run build` first');
  process.exit(1);
}

const flags = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const name = arg.slice(2);
  if (name === 'update') flags.set('update', true);
  else flags.set(name, process.argv[++i]);
}

const { discoverFixtures, FIXTURES_DIR, REPORTS_DIR, writeExpectations } = await import(
  '../test/visual/lib/fixtures.ts'
);
const { runFixture, RATCHET_SLACK } = await import('../test/visual/lib/cli.ts');
const { buildCoverage } = await import('../test/visual/lib/coverage.ts');
const { writeReport } = await import('../test/visual/lib/gallery.ts');

const fixturesDir = flags.get('fixtures') ? path.resolve(flags.get('fixtures')) : FIXTURES_DIR;
const outDir = flags.get('out') ? path.resolve(flags.get('out')) : REPORTS_DIR;
const fixtures = discoverFixtures(fixturesDir);

if (fixtures.length === 0) {
  console.log(`No fixtures under ${fixturesDir}.`);
  console.log('A fixture is a directory containing design.fig, optionally with exports/ and');
  console.log('manifest.json — see docs/render-fixtures.md.');
  process.exit(0);
}

const runs = [];
for (const fixture of fixtures) {
  process.stdout.write(`${fixture.name}: `);
  const run = await runFixture(fixture, {
    outDir,
    only: flags.get('only'),
    update: flags.get('update') === true,
  });
  runs.push(run);
  console.log(`${run.frames.length} frame(s), ${run.unmatched.length} unmatched`);
}

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

const { html, json } = writeReport(outDir, {
  runs,
  coverage,
  generatedAt: new Date().toISOString(),
});

// --update stores improvements only: a ratchet never records a worse score (§9.7).
if (flags.get('update') === true) {
  for (const run of runs) {
    const next = { ...run.expectations };
    for (const frame of run.frames) {
      const entry = { ...next[frame.guid] };
      for (const level of ['level3', 'level4']) {
        const result = frame[level];
        if (result.skipped || result.diffRatio === undefined) continue;
        const best = entry[level];
        if (best === undefined || result.diffRatio < best) entry[level] = result.diffRatio;
      }
      if (Object.keys(entry).length) next[frame.guid] = entry;
    }
    writeExpectations(run.fixture, next);
    console.log(`updated ${path.relative(ROOT, run.fixture.expectPath)}`);
  }
}

let failed = 0;
let regressed = 0;
for (const run of runs) {
  for (const frame of run.frames) {
    const label = `${frame.design}/${frame.guid}`;
    for (const [name, result] of [
      ['L1', frame.level1],
      ['L2', frame.level2],
      ['L3', frame.level3],
      ['L4', frame.level4],
    ]) {
      if (result.skipped || result.pass) continue;
      failed++;
      console.log(`FAIL ${label} ${name}: ${result.notes.join('; ')}`);
    }
    const best = run.expectations[frame.guid];
    if (!best) continue;
    for (const level of ['level3', 'level4']) {
      const now = frame[level].diffRatio;
      const then = best[level];
      if (now === undefined || then === undefined) continue;
      if (now > then + RATCHET_SLACK) {
        regressed++;
        console.log(
          `REGRESSION ${label} ${level}: ${(now * 100).toFixed(2)}% vs best ${(then * 100).toFixed(2)}%`,
        );
      }
    }
  }
}

console.log(`\ncoverage: ${coverage.featuresProven}/${coverage.featuresPresent} features proven`);
console.log(`report:   ${path.relative(ROOT, html)}`);
console.log(`json:     ${path.relative(ROOT, json)}`);
process.exit(failed === 0 && regressed === 0 ? 0 : 1);
