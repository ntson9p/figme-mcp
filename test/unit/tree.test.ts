import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, guidKey, breadcrumb } from '../../dist/model/tree.js';
import type { NodeChange } from '../../dist/fig/parse.js';

function node(
  guid: string,
  type: string,
  parent?: string,
  position?: string,
  name?: string,
): NodeChange {
  const [sessionID, localID] = guid.split(':').map(Number);
  const nc: Record<string, unknown> = { guid: { sessionID, localID }, type, name: name ?? guid };
  if (parent) {
    const [ps, pl] = parent.split(':').map(Number);
    nc['parentIndex'] = { guid: { sessionID: ps, localID: pl }, position: position ?? '!' };
  }
  return nc as NodeChange;
}

test('guidKey renders "sessionID:localID" and rejects incomplete guids', () => {
  assert.equal(guidKey({ sessionID: 2, localID: 39 }), '2:1339');
  assert.equal(guidKey({ sessionID: 0, localID: 0 }), '0:0');
  assert.equal(guidKey({ sessionID: 2 }), undefined);
  assert.equal(guidKey(undefined), undefined);
});

test('siblings sort by RAW code-unit comparison of the fractional index', () => {
  // Numeric order would be 9 < 10; locale order can put "~" anywhere. Code units give
  // "!" (0x21) < "10" (0x31…) < "9" (0x39) < "~" (0x7E).
  const nodes = [
    node('0:0', 'DOCUMENT'),
    node('1:1', 'FRAME', '0:0', '9'),
    node('1:2', 'FRAME', '0:0', '10'),
    node('1:3', 'FRAME', '0:0', '~'),
    node('1:4', 'FRAME', '0:0', '!'),
  ];
  const tree = buildTree(nodes);
  assert.deepEqual(
    tree.root!.children.map((c) => c.key),
    ['1:4', '1:2', '1:1', '1:3'],
  );
});

test('identical positions keep a deterministic, stable order', () => {
  const nodes = [
    node('0:0', 'DOCUMENT'),
    node('1:2', 'FRAME', '0:0', 'a'),
    node('1:1', 'FRAME', '0:0', 'a'),
  ];
  const a = buildTree(nodes).root!.children.map((c) => c.key);
  const b = buildTree([...nodes].reverse()).root!.children.map((c) => c.key);
  assert.deepEqual(a, b);
});

test('DFS numbering, depth and page assignment', () => {
  const nodes = [
    node('0:0', 'DOCUMENT'),
    node('0:1', 'CANVAS', '0:0', '!', 'Page A'),
    node('0:2', 'CANVAS', '0:0', '"', 'Page B'),
    node('1:1', 'FRAME', '0:1', '!', 'Outer'),
    node('1:2', 'TEXT', '1:1', '!', 'Inner'),
    node('2:1', 'FRAME', '0:2', '!', 'Other'),
  ];
  const tree = buildTree(nodes);
  assert.deepEqual(
    tree.ordered.map((t) => t.key),
    ['0:0', '0:1', '1:1', '1:2', '0:2', '2:1'],
  );
  assert.deepEqual(
    tree.ordered.map((t) => t.order),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    tree.ordered.map((t) => t.depth),
    [0, 1, 2, 3, 1, 2],
  );
  const inner = tree.byKey.get('1:2')!;
  assert.equal(inner.page?.key, '0:1');
  assert.equal(tree.byKey.get('0:1')!.page?.key, '0:1', 'a CANVAS is its own page');
  assert.equal(tree.root!.page, undefined);
  assert.equal(breadcrumb(inner), 'Page A / Outer');
  assert.equal(breadcrumb(tree.root!), '');
});

test('nodes with an unresolvable parent are reported as orphans, not attached', () => {
  const tree = buildTree([
    node('0:0', 'DOCUMENT'),
    node('1:1', 'FRAME', '0:0', '!'),
    node('9:9', 'FRAME', '404:404', '!'),
  ]);
  assert.deepEqual(
    tree.orphans.map((o) => o.key),
    ['9:9'],
  );
  assert.equal(tree.root!.children.length, 1);
  // Orphans still get DFS numbering so cursors and subtree ranges stay total.
  assert.equal(tree.ordered.length, 3);
});

test('a file with no DOCUMENT yields no root but still indexes every node', () => {
  const tree = buildTree([node('1:1', 'FRAME'), node('1:2', 'TEXT', '1:1', '!')]);
  assert.equal(tree.root, undefined);
  assert.equal(tree.byKey.size, 2);
  assert.deepEqual(
    tree.orphans.map((o) => o.key),
    ['1:1'],
  );
});
