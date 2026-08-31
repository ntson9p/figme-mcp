#!/usr/bin/env node
// Manual smoke test (mcp-implementation-plan.md §9): spawn the built server as a real child
// process, talk to it over stdio exactly as an MCP client would, and walk the demo script.
//
// Usage: node scripts/smoke.mjs [file.fig]

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.resolve(process.argv[2] ?? path.join(ROOT, 'figma-input', 'sample.fig'));
const SERVER = path.join(ROOT, 'dist', 'mcp', 'server.js');

if (!fs.existsSync(SERVER)) {
  console.error('ERROR: dist/mcp/server.js is missing — run `npm run build` first');
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.log(`SKIP: no .fig at ${FILE}`);
  process.exit(0);
}

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const client = new Client({ name: 'figfile-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER] });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: { file: FILE, ...args } });
  const first = res.content?.[0];
  const textBlock = res.content?.find((c) => c.type === 'text');
  const text = textBlock?.text ?? '';
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* outline responses are plain text */
  }
  return { res, text, json, first, size: text.length, isError: res.isError === true };
};

const server = client.getServerVersion();
console.log(`connected to ${server?.name} v${server?.version} over stdio`);
const { tools } = await client.listTools();
check('tools/list returns the 11 v1 tools', tools.length === 11, tools.map((t) => t.name).join(', '));

// 1 -------------------------------------------------------------------------------------
console.log('\n1. fig_overview');
const overview = await call('fig_overview', {});
check('overview succeeds', !overview.isError);
check('10 pages', overview.json.pages?.length === 10);
check('116,142 nodes', overview.json.nodes === 116142);
check('2,046 components / 273 variables / 212 images',
  overview.json.components === 2046 && overview.json.variables === 273 && overview.json.images === 212);
check('under the 20k budget', overview.size < 20000, `${overview.size} chars`);
console.log(`   name=${overview.json.name} version=${overview.json.formatVersion} parse=${overview.json.parseMs}ms`);

// 2 -------------------------------------------------------------------------------------
console.log('\n2. fig_tree on the "Page 7" page, depth 2, outline');
const ver1 = overview.json.pages.find((p) => p.name === 'Page 7');
check('found the Page 7 page', Boolean(ver1), JSON.stringify(ver1));
const tree = await call('fig_tree', { root: ver1.guid, depth: 2, format: 'outline' });
check('outline succeeds', !tree.isError);
check('outline is indented text', /^\[|\n {2}\[/.test(tree.text));
check('under the 20k budget', tree.size < 20000, `${tree.size} chars`);
console.log(tree.text.split('\n').slice(0, 8).map((l) => `   ${l}`).join('\n'));

// 3 -------------------------------------------------------------------------------------
console.log('\n3. fig_find query "sample" types ["TEXT"]');
const find = await call('fig_find', { query: 'sample', types: ['TEXT'], limit: 5 });
check('find succeeds', !find.isError);
check('has hits', find.json.results?.length > 0, `${find.json.totalMatches} total matches`);
check('every hit carries a breadcrumb', find.json.results.every((r) => r.path && r.page));
for (const hit of find.json.results.slice(0, 3)) {
  console.log(`   ${hit.guid} [${hit.type}] ${JSON.stringify(hit.text ?? hit.name)}  <- ${hit.path}`);
}

// 4 -------------------------------------------------------------------------------------
console.log('\n4. fig_node then fig_style on 2:1339');
const node = await call('fig_node', { guid: '2:1339' });
check('node succeeds', !node.isError);
check('geometry is 134x40', node.json.node?.geometry?.width === 134 && node.json.node?.geometry?.height === 40);
const style = await call('fig_style', { guid: '2:1339' });
check('style succeeds', !style.isError);
const layout = style.json.style?.layout ?? {};
check('auto-layout reads as flexbox',
  layout.direction === 'row' && layout.gap === 8 && layout.padding === '8px 16px',
  JSON.stringify(layout));
check('the stroke variable alias is surfaced',
  style.json.style?.strokes?.[0]?.colorVar?.variable === 'tab/large/underline',
  JSON.stringify(style.json.style?.strokes?.[0]?.colorVar?.values));

// 5 -------------------------------------------------------------------------------------
console.log('\n5. fig_text with runs on a small frame (2:7098)');
const text = await call('fig_text', { scope: '2:7098', includeRuns: true });
check('text succeeds', !text.isError);
const time = text.json.texts?.find((t) => t.guid === '2:7099');
check('found "Yesterday 9:41"', time?.characters === 'Yesterday 9:41');
check('4 resolved runs', time?.runs?.length === 4, JSON.stringify(time?.runs?.map((r) => [r.text, r.styleID])));

// 6 -------------------------------------------------------------------------------------
console.log('\n6. fig_image on a known hash');
const image = await call('fig_image', { hash: '01ef2f8cd2d276901473acb9ddd7afb2421198e3' });
check('image succeeds', !image.isError);
check('returns image content', image.first?.type === 'image', `mime=${image.first?.mimeType}`);
check('4,553 bytes of PNG', Buffer.from(image.first?.data ?? '', 'base64').length === 4553);
console.log(`   ${image.text}`);

// 7 -------------------------------------------------------------------------------------
console.log('\n7. fig_variables');
const vars = await call('fig_variables', { limit: 5 });
check('variables succeed', !vars.isError);
check('27 sets / 273 variables', vars.json.totalSets === 27 && vars.json.totalVariables === 273);
check('modes and values are listed',
  vars.json.sets?.some((s) => s.modes?.length > 1) && vars.json.variables?.[0]?.values,
  JSON.stringify(vars.json.variables?.[0]));

await client.close();
console.log(`\n${failures === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures} checks)`}`);
process.exit(failures === 0 ? 0 : 1);
