#!/usr/bin/env node
// Render one node of a .fig to PNG or SVG (render-implementation-plan.md §7).
//
// Usage:
//   node scripts/render.mjs <file.fig> <guid> <out.png|out.svg>
//        [--scale N] [--max-size N] [--background page] [--max-nodes N] [--quiet]
//
// A `.svg` output extension writes SVG; anything else writes PNG, falling back to SVG with a
// warning when the optional rasterizer is not installed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const USAGE =
  'usage: node scripts/render.mjs <file.fig> <guid> <out.png|out.svg> ' +
  '[--scale N] [--max-size N] [--background page] [--max-nodes N] [--quiet]';

function fail(message) {
  console.error(`ERROR: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

const positional = [];
const flags = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    const name = arg.slice(2);
    if (name === 'quiet') flags.set('quiet', 'true');
    else flags.set(name, process.argv[++i]);
  } else {
    positional.push(arg);
  }
}

const [file, guid, out] = positional;
if (!file || !guid || !out) fail('need <file.fig> <guid> <out.png|out.svg>');

if (!fs.existsSync(path.join(DIST, 'render', 'index.js'))) {
  fail('dist/render/index.js is missing — run `npm run build` first');
}

const number = (name, fallback) => {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${name} needs a number, got ${JSON.stringify(raw)}`);
  return n;
};

const imp = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);
const { FileCache } = await imp('cache.js');
const { renderNode } = await imp('render/index.js');

const wantSvg = path.extname(out).toLowerCase() === '.svg';
const quiet = flags.get('quiet') === 'true';

let entry;
try {
  entry = new FileCache(1).get(file);
} catch (err) {
  fail(err.message);
}

let result;
try {
  result = await renderNode(entry, guid, {
    scale: number('scale', undefined),
    maxSize: number('max-size', undefined),
    maxNodes: number('max-nodes', undefined),
    background: flags.get('background') === 'page' ? 'page' : 'transparent',
    format: wantSvg ? 'svg' : 'png',
  });
} catch (err) {
  fail(err.message);
}

const abs = path.resolve(out);
fs.mkdirSync(path.dirname(abs), { recursive: true });

let written;
if (wantSvg || !result.png) {
  const target = result.png || wantSvg ? abs : `${abs.replace(/\.[^.]*$/, '')}.svg`;
  fs.writeFileSync(target, result.svg, 'utf8');
  written = target;
  if (!wantSvg) {
    console.error(
      'WARNING: no rasterizer installed (npm install @resvg/resvg-wasm) — wrote SVG instead',
    );
  }
} else {
  fs.writeFileSync(abs, result.png);
  written = abs;
}

if (!quiet) {
  console.log(
    JSON.stringify(
      {
        savedTo: written,
        bytes: fs.statSync(written).size,
        ...result.report,
      },
      null,
      2,
    ),
  );
}
