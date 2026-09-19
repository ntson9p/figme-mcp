#!/usr/bin/env node
// Dev-only gold standard: decode the same buffers with OUR parser and with the official
// `kiwi-schema` npm package, then deep-compare every field of every node.
//
// Never imported by runtime code — kiwi-schema is a devDependency. Skips gracefully (exit 0)
// when the package or the asset is absent, so an offline checkout still passes `npm run
// crosscheck` with a clear message.
//
// Usage: node scripts/crosscheck.mjs [file.fig]

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.resolve(process.argv[2] ?? path.join(ROOT, 'figma-input', 'sample.fig'));
const MAX_REPORTED = 40;

if (!fs.existsSync(file)) {
  console.log(`SKIP: test asset not found at ${file}`);
  process.exit(0);
}

let kiwi;
try {
  kiwi = await import('kiwi-schema');
} catch {
  console.log('SKIP: devDependency `kiwi-schema` is not installed (offline?); run `npm i` to enable');
  process.exit(0);
}

const distParse = path.join(ROOT, 'dist', 'fig', 'container.js');
if (!fs.existsSync(distParse)) {
  console.error('ERROR: dist/ not built — run `npm run build` first');
  process.exit(1);
}
const distUrl = (rel) => pathToFileURL(path.join(ROOT, 'dist', rel)).href;
const { openContainer, readFigStream, decompressChunk } = await import(distUrl('fig/container.js'));
const ours = await import(distUrl('fig/kiwi.js'));

const t0 = performance.now();
const container = openContainer(fs.readFileSync(file));
const { version, chunks } = readFigStream(container.stream);
const schemaBuf = decompressChunk(chunks[0]).data;
const dataBuf = decompressChunk(chunks[1]).data;
console.log(`file           : ${file}`);
console.log(`header version : ${version}`);
console.log(`schema chunk   : ${chunks[0].length} -> ${schemaBuf.length} bytes`);
console.log(`data chunk     : ${chunks[1].length} -> ${dataBuf.length} bytes`);

// --- reference decode (official package) -------------------------------------------------
const refSchema = kiwi.decodeBinarySchema(schemaBuf);
const reference = kiwi.compileSchema(refSchema).decodeMessage(dataBuf);
console.log(`kiwi-schema    : ${refSchema.definitions.length} definitions, ${reference.nodeChanges?.length ?? 0} nodes`);

// --- our decode --------------------------------------------------------------------------
const ourSchema = ours.decodeBinarySchema(schemaBuf);
const mine = ours.makeDecoder(ourSchema).decode('Message', dataBuf);
console.log(`figme parser   : ${ourSchema.length} definitions, ${mine.nodeChanges?.length ?? 0} nodes`);

// --- compare ------------------------------------------------------------------------------
const diffs = [];
/** Values our decoder deliberately reports differently: unknown enum numbers vs undefined. */
const toleratedEnums = [];
let compared = 0;

function push(pathStr, msg) {
  if (diffs.length < MAX_REPORTED) diffs.push(`${pathStr}: ${msg}`);
  else if (diffs.length === MAX_REPORTED) diffs.push('…');
}

function show(v) {
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'object' && v !== null) return Array.isArray(v) ? `[${v.length}]` : '{…}';
  return JSON.stringify(v);
}

function compare(a, b, p) {
  compared++;
  if (a === b) return;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return;
    push(p, `number ${a} (kiwi) vs ${b} (ours)`);
    return;
  }
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    if (typeof a === 'bigint' && typeof b === 'bigint' && a === b) return;
    push(p, `int64 ${show(a)} (kiwi) vs ${show(b)} (ours)`);
    return;
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
      push(p, `bytes ${show(a)} (kiwi) vs ${show(b)} (ours)`);
      return;
    }
    if (a.length !== b.length) {
      push(p, `byte length ${a.length} (kiwi) vs ${b.length} (ours)`);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        push(p, `byte ${i} differs: ${a[i]} vs ${b[i]}`);
        return;
      }
    }
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      push(p, `array vs non-array: ${show(a)} (kiwi) vs ${show(b)} (ours)`);
      return;
    }
    if (a.length !== b.length) {
      push(p, `array length ${a.length} (kiwi) vs ${b.length} (ours)`);
      return;
    }
    for (let i = 0; i < a.length; i++) compare(a[i], b[i], `${p}[${i}]`);
    return;
  }
  if (a === undefined && typeof b === 'number') {
    // Our decoder keeps unknown enum numbers; kiwi's lookup table yields undefined.
    if (toleratedEnums.length < 10) toleratedEnums.push(`${p} = ${b}`);
    return;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    push(p, `${show(a)} (kiwi) vs ${show(b)} (ours)`);
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const inA = k in a, inB = k in b;
    if (inA !== inB) {
      push(`${p}.${k}`, inA ? `present in kiwi (${show(a[k])}), absent in ours` : `absent in kiwi, present in ours (${show(b[k])})`);
      continue;
    }
    compare(a[k], b[k], `${p}.${k}`);
  }
}

compare(reference, mine, 'Message');

console.log(`\ncompared       : ${compared.toLocaleString('en-US')} values`);
if (toleratedEnums.length) {
  console.log(`tolerated      : ${toleratedEnums.length} unknown enum value(s) kept as numbers by our decoder`);
  for (const t of toleratedEnums) console.log(`  ${t}`);
}
console.log(`elapsed        : ${Math.round(performance.now() - t0)} ms`);

if (diffs.length === 0) {
  console.log('\nRESULT: 0 field differences vs kiwi-schema ✔');
  process.exit(0);
}
console.log(`\nRESULT: ${diffs.length} difference(s):`);
for (const d of diffs) console.log(`  ${d}`);
process.exit(1);
