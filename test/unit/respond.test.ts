import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUDGET,
  ENVELOPE_RESERVE,
  HARD_CAP,
  MAX_NODES,
  Packer,
  decodeCursor,
  encodeCursor,
  errorResult,
  jsonResult,
  measure,
  textResult,
} from '../../dist/mcp/respond.js';

test('cursors round-trip and are opaque base64url', () => {
  const c = encodeCursor({ after: '2:1339' });
  assert.match(c, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(c), { after: '2:1339' });
  assert.deepEqual(decodeCursor(undefined), {});
  assert.throws(() => decodeCursor('not-a-cursor'), /invalid cursor/);
});

test('Packer stops at the item cap and reports why', () => {
  const p = new Packer<string>({ limit: 3 });
  assert.equal(p.add('a'), true);
  assert.equal(p.add('b'), true);
  assert.equal(p.add('c'), true);
  assert.equal(p.add('d'), false);
  assert.deepEqual(p.items, ['a', 'b', 'c']);
  assert.equal(p.truncated, true);
  assert.equal(p.reason, 'limit');
});

test('Packer never returns more than MAX_NODES even when a bigger limit is asked for', () => {
  const p = new Packer<number>({ limit: 10_000, budget: HARD_CAP });
  for (let i = 0; i < MAX_NODES + 50; i++) if (!p.add(i)) break;
  assert.equal(p.items.length, MAX_NODES);
  assert.equal(p.reason, 'items');
});

test('Packer stops on the character budget and always admits at least one item', () => {
  const p = new Packer<string>({ budget: 100 });
  const chunk = 'x'.repeat(40);
  assert.equal(p.add(chunk), true);
  assert.equal(p.add(chunk), true);
  assert.equal(p.add(chunk), false);
  assert.equal(p.reason, 'budget');

  const tiny = new Packer<string>({ budget: 5 });
  assert.equal(tiny.add('a'.repeat(1000)), true, 'first item is always admitted');
  assert.equal(tiny.add('b'), false);
});

test('the default item budget leaves room for the response envelope', () => {
  const p = new Packer<string>();
  const chunk = 'y'.repeat(1000);
  while (p.add(chunk)) {
    /* fill it */
  }
  const used = p.items.join('').length;
  assert.ok(used <= DEFAULT_BUDGET - ENVELOPE_RESERVE + 1001, `packed ${used} chars`);
  assert.ok(used > 0);
});

test('measure sizes strings and structures without throwing on cycles', () => {
  assert.equal(measure('abcd'), 5);
  assert.equal(measure({ a: 1 }), '{"a":1}'.length);
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.equal(measure(cyclic), 0);
});

test('jsonResult shrinks the named list rather than emitting oversized JSON', () => {
  const items = Array.from({ length: 400 }, (_, i) => ({ i, pad: 'z'.repeat(300) }));
  const res = jsonResult({ results: items }, { listKey: 'results' });
  assert.ok(res.content[0]!.type === 'text');
  const text = (res.content[0] as { text: string }).text;
  assert.ok(text.length <= HARD_CAP, `got ${text.length}`);
  const parsed = JSON.parse(text) as { results: unknown[]; truncated?: boolean };
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.results.length < items.length);
});

test('jsonResult degrades to an explanatory payload when nothing can be trimmed', () => {
  const res = jsonResult({ blob: 'q'.repeat(HARD_CAP + 10) });
  const parsed = JSON.parse((res.content[0] as { text: string }).text) as { error?: string };
  assert.match(parsed.error ?? '', /hard response cap/);
});

test('jsonResult serializes BigInt as a string instead of throwing', () => {
  const res = jsonResult({ big: 2n ** 70n });
  assert.equal((res.content[0] as { text: string }).text, '{"big":"1180591620717411303424"}');
});

test('textResult caps plain-text responses; errorResult flags isError', () => {
  const res = textResult('w'.repeat(HARD_CAP * 2));
  const text = (res.content[0] as { text: string }).text;
  assert.ok(text.length <= HARD_CAP);
  assert.match(text, /truncated at 50000 characters/);
  assert.equal(errorResult('nope').isError, true);
});
