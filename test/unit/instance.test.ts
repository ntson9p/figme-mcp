import test from 'node:test';
import assert from 'node:assert/strict';
import type { FileIndex } from '../../dist/model/index.js';
import type { KiwiObject } from '../../dist/fig/kiwi.js';
import { overrideIdentity, type TreeNode } from '../../dist/model/tree.js';
import {
  applyProps,
  descend,
  mergeNode,
  resolveInstance,
  resolveOverridePath,
} from '../../dist/model/instance.js';
import { instanceShapeNode } from '../../dist/render/instance.js';
import { applyStyles, runPaints, stylePaints } from '../../dist/render/style.js';

const guid = (s: string) => {
  const [sessionID, localID] = s.split(':').map(Number);
  return { sessionID, localID };
};

function tree(key: string, node: KiwiObject, children: TreeNode[] = []): TreeNode {
  const t: TreeNode = { key, node, children, parent: undefined, order: 0, depth: 0, page: undefined };
  for (const c of children) c.parent = t;
  return t;
}

/** Just enough of FileIndex for the resolver: guid lookup and asset-key lookup. */
function fakeIndex(nodes: TreeNode[]): FileIndex {
  const byKey = new Map(nodes.map((t) => [t.key, t]));
  const byAsset = new Map(nodes.filter((t) => t.node['key']).map((t) => [t.node['key'] as string, t]));
  return {
    node: (k: string) => byKey.get(k),
    resolveAssetRef: (ref: Record<string, unknown> | undefined) => {
      const key = (ref?.['assetRef'] as { key?: string } | undefined)?.key;
      return key ? byAsset.get(key) : undefined;
    },
  } as unknown as FileIndex;
}

const black = tree('9:1', { type: 'ROUNDED_RECTANGLE', styleType: 'FILL', key: 'kblack',
  fillPaints: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2, a: 1 } }] });
const glow = tree('9:2', { type: 'ROUNDED_RECTANGLE', styleType: 'EFFECT', key: 'kglow',
  effects: [{ type: 'DROP_SHADOW', radius: 4 }] });

// ------------------------------------------------------------------------------- identity

test('overrideIdentity is the overrideKey when present, else the guid', () => {
  assert.equal(overrideIdentity(tree('2:5', { overrideKey: guid('0:77') })), '0:77');
  assert.equal(overrideIdentity(tree('2:5', {})), '2:5');
});

// ------------------------------------------------------------------------------- mergeNode

test('mergeNode overlays a record but never its addressing fields', () => {
  const out = mergeNode(
    { type: 'TEXT', visible: true, size: { x: 1, y: 1 } },
    { guidPath: { guids: [guid('2:5')] }, overrideLevel: 1, phase: 'CREATED', visible: false },
  );
  assert.equal(out['visible'], false);
  assert.equal(out['type'], 'TEXT');
  assert.equal('guidPath' in out, false);
  assert.equal('overrideLevel' in out, false);
  assert.equal('phase' in out, false);
});

test('mergeNode merges property assignments per definition instead of replacing the list', () => {
  const base = {
    componentPropAssignments: [
      { defID: guid('6:1'), value: { textValue: { characters: 'old' } } },
      { defID: guid('6:2'), value: { boolValue: true } },
    ],
  };
  const out = mergeNode(base, {
    componentPropAssignments: [{ defID: guid('6:2'), value: { boolValue: false } }],
  });
  const list = out['componentPropAssignments'] as { defID: unknown; value: unknown }[];
  assert.equal(list.length, 2, 'the untouched assignment survives');
  assert.deepEqual(list.map((a) => a.value), [{ textValue: { characters: 'old' } }, { boolValue: false }]);
});

test('mergeNode drops geometry a resizing record did not re-derive (F20)', () => {
  const base = { size: { x: 1240, y: 180 }, fillGeometry: [{ commandsBlob: 1 }], strokeGeometry: [{ commandsBlob: 2 }] };
  const resized = mergeNode(base, { size: { x: 1052, y: 503 } });
  assert.equal('fillGeometry' in resized, false, 'the 1240x180 outline cannot describe a 1052x503 box');
  assert.equal('strokeGeometry' in resized, false);

  const withGeometry = mergeNode(base, { size: { x: 1052, y: 503 }, fillGeometry: [{ commandsBlob: 3 }] });
  assert.deepEqual(withGeometry['fillGeometry'], [{ commandsBlob: 3 }]);
  assert.equal('strokeGeometry' in withGeometry, false, 'only the field the record supplies survives');

  const sameSize = mergeNode(base, { size: { x: 1240, y: 180 }, visible: false });
  assert.deepEqual(sameSize['fillGeometry'], base.fillGeometry, 'an unchanged size keeps the outline');
  const noSize = mergeNode(base, { opacity: 0.5 });
  assert.deepEqual(noSize['fillGeometry'], base.fillGeometry);
});

// ------------------------------------------------------------------------------ applyProps

const refs = (defID: string, field: string) => [{ defID: guid(defID), componentPropNodeField: field }];

test('applyProps hides a node bound to a false BOOLEAN property', () => {
  const props = new Map([['6:2', { boolValue: false }]]);
  const { node } = applyProps({ visible: true, componentPropRefs: refs('6:2', 'VISIBLE') }, props, false);
  assert.equal(node['visible'], false);
});

test('applyProps leaves a node alone when nothing is assigned to its property', () => {
  const input = { visible: true, componentPropRefs: refs('6:2', 'VISIBLE') };
  const { node, staleOutlines } = applyProps(input, new Map([['6:9', { boolValue: false }]]), false);
  assert.equal(node, input, 'same object, so callers can tell nothing changed');
  assert.equal(staleOutlines, false);
});

test('applyProps assigns text, and flags it when no record supplied outlines for the new words', () => {
  const props = new Map([['6:1', { textValue: { characters: 'new words', lines: [] } }]]);
  const input = { textData: { characters: 'Text', lines: [{}] }, componentPropRefs: refs('6:1', 'TEXT_DATA') };
  const withOutlines = applyProps(input, props, true);
  assert.equal((withOutlines.node['textData'] as { characters: string }).characters, 'new words');
  assert.equal(withOutlines.staleOutlines, false);
  const without = applyProps(input, props, false);
  assert.equal(without.staleOutlines, true);
  const same = applyProps(input, new Map([['6:1', { textValue: { characters: 'Text' } }]]), false);
  assert.equal(same.staleOutlines, false, 'the symbol\'s own glyphs are right when the words are unchanged');
});

test('applyProps swaps the symbol of a nested instance bound to an INSTANCE_SWAP property', () => {
  const props = new Map([['6:3', { guidValue: guid('2:900') }]]);
  const { node } = applyProps(
    { type: 'INSTANCE', symbolData: { symbolID: guid('2:100') }, componentPropRefs: refs('6:3', 'OVERRIDDEN_SYMBOL_ID') },
    props,
    false,
  );
  assert.deepEqual(node['overriddenSymbolID'], guid('2:900'));
});

// --------------------------------------------------------------------------- resolveInstance

test('resolveInstance keys records by identity path and lets the enclosing instance win', () => {
  const shape = tree('2:1401', { type: 'VECTOR' });
  const symbol = tree('2:100', { type: 'SYMBOL', size: { x: 22, y: 22 } }, [shape]);
  const index = fakeIndex([symbol, shape]);
  const node = {
    type: 'INSTANCE',
    symbolData: {
      symbolID: guid('2:100'),
      symbolOverrides: [{ guidPath: { guids: [guid('2:1401')] }, visible: false, opacity: 0.5 }],
    },
    derivedSymbolData: [{ guidPath: { guids: [guid('2:1401')] }, size: { x: 16, y: 16 } }],
    componentPropAssignments: [{ defID: guid('6:2'), value: { boolValue: false } }],
  };
  const inherited = new Map([['2:1401', { opacity: 1 }]]);
  const resolved = resolveInstance(index, node, inherited)!;
  assert.equal(resolved.symbol, symbol);
  const record = resolved.records.get('2:1401')!;
  assert.equal(record['visible'], false, 'the user\'s override');
  assert.deepEqual(record['size'], { x: 16, y: 16 }, 'Figma\'s derived size');
  assert.equal(record['opacity'], 1, 'the enclosing instance\'s edit is the more specific one');
  assert.deepEqual(resolved.props.get('6:2'), { boolValue: false });
});

test('resolveInstance follows a swapped symbol and a PROP_REF to the enclosing instance', () => {
  const a = tree('2:100', { type: 'SYMBOL' });
  const b = tree('2:900', { type: 'SYMBOL' });
  const index = fakeIndex([a, b]);
  const outer = new Map([['5:1', { textValue: { characters: 'from outside' } }]]);
  const resolved = resolveInstance(
    index,
    {
      type: 'INSTANCE',
      symbolData: { symbolID: guid('2:100') },
      overriddenSymbolID: guid('2:900'),
      componentPropAssignments: [
        { defID: guid('6:1'), varValue: { dataType: 'PROP_REF', value: { propRefValue: { defId: guid('5:1') } } } },
      ],
    },
    undefined,
    outer,
  )!;
  assert.equal(resolved.symbol, b);
  assert.deepEqual(resolved.props.get('6:1'), { textValue: { characters: 'from outside' } });
});

test('resolveInstance is undefined for a symbol that is not in the file', () => {
  assert.equal(resolveInstance(fakeIndex([]), { symbolData: { symbolID: guid('2:100') } }), undefined);
});

test('resolveOverridePath walks nested instances the way the renderer expands them', () => {
  // Symbol A contains a nested instance N of symbol B; N is bound to an INSTANCE_SWAP property
  // that the outer instance sets to symbol C. A record path [N, leaf] must land inside C.
  const leafB = tree('2:201', { type: 'VECTOR' });
  const b = tree('2:200', { type: 'SYMBOL' }, [leafB]);
  const leafC = tree('2:301', { type: 'VECTOR', overrideKey: guid('0:31') });
  const c = tree('2:300', { type: 'SYMBOL' }, [leafC]);
  const nested = tree('2:1401', {
    type: 'INSTANCE',
    symbolData: { symbolID: guid('2:200') },
    componentPropRefs: refs('6:3', 'OVERRIDDEN_SYMBOL_ID'),
  });
  const a = tree('2:100', { type: 'SYMBOL' }, [nested]);
  const all = [a, nested, b, leafB, c, leafC];
  // Give the fake index a DFS order so isDescendant works, and an identity index.
  all.forEach((t, i) => { t.order = i; });
  const order = new Map(all.map((t, i) => [t.key, i]));
  const ranges = new Map<string, [number, number]>([
    ['2:100', [0, 2]], ['2:1401', [1, 2]], ['2:200', [2, 4]], ['2:201', [3, 4]], ['2:300', [4, 6]], ['2:301', [5, 6]],
  ]);
  const index = {
    ...fakeIndex(all),
    isDescendant: (cand: TreeNode, anc: TreeNode) => {
      const [s, e] = ranges.get(anc.key)!;
      const o = order.get(cand.key)!;
      return o >= s && o < e;
    },
    byOverrideIdentity: () => new Map(all.map((t) => [overrideIdentity(t), [t]])),
  } as unknown as FileIndex;

  const instance = tree('5:1', {
    type: 'INSTANCE',
    symbolData: { symbolID: guid('2:100') },
    componentPropAssignments: [{ defID: guid('6:3'), value: { guidValue: guid('2:300') } }],
  });
  assert.equal(resolveOverridePath(index, instance, ['2:1401'])?.key, '2:1401');
  assert.equal(resolveOverridePath(index, instance, ['2:1401', '0:31'])?.key, '2:301', 'inside the swapped-in symbol');
  assert.equal(resolveOverridePath(index, instance, ['2:1401', '2:201']), undefined, 'not in the original one');

  const unswapped = tree('5:2', { type: 'INSTANCE', symbolData: { symbolID: guid('2:100') } });
  assert.equal(resolveOverridePath(index, unswapped, ['2:1401', '2:201'])?.key, '2:201');
});

test('descend keeps the records under one nested instance, minus its own segment', () => {
  const records = new Map([
    ['0:1', { a: 1 }],
    ['0:1/0:2', { b: 2 }],
    ['0:1/0:2/0:3', { c: 3 }],
    ['0:9/0:2', { d: 4 }],
  ]);
  const nested = descend(records, '0:1')!;
  assert.deepEqual([...nested.keys()], ['0:2', '0:2/0:3']);
  assert.equal(descend(records, '0:7'), undefined);
});

// -------------------------------------------------------------------------- instanceShapeNode

test('instanceShapeNode takes the instance\'s paints together with its style reference', () => {
  const symbol = tree('2:100', {
    type: 'SYMBOL',
    size: { x: 22, y: 22 },
    styleIdForFill: { assetRef: { key: 'kblack' } },
    fillPaints: [{ type: 'SOLID', color: { r: 0.2, g: 0.2, b: 0.2, a: 1 } }],
    transform: { m00: 1, m11: 1, m02: 500, m12: 500 },
  });
  const instance = {
    type: 'INSTANCE',
    size: { x: 16, y: 16 },
    fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    transform: { m00: 1, m11: 1, m02: 3, m12: 4 },
  };
  const out = instanceShapeNode(instance, symbol, new Map());
  assert.deepEqual(out['size'], { x: 16, y: 16 });
  assert.equal((out['fillPaints'] as { color: { r: number } }[])[0]!.color.r, 1);
  assert.equal('styleIdForFill' in out, false, 'a detached fill must not fall back to the symbol\'s style');
  assert.deepEqual(out['transform'], instance.transform);
  assert.equal(out['type'], 'INSTANCE');
});

test('instanceShapeNode rebuilds the box of a resized nested instance from its size (F20)', () => {
  // A 32x32 colour-swatch symbol stretched to 229x280 by the enclosing instance: the symbol
  // root's 32x32 outline must not become the clip of a 229x280 box.
  const symbol = tree('2:1314', { type: 'SYMBOL', size: { x: 32, y: 32 }, fillGeometry: [{ commandsBlob: 9 }] });
  const stretched = instanceShapeNode(
    { type: 'INSTANCE', size: { x: 229.5, y: 280 }, transform: {} },
    symbol,
    new Map(),
  );
  assert.equal('fillGeometry' in stretched, false);
  assert.deepEqual(stretched['size'], { x: 229.5, y: 280 });

  const own = instanceShapeNode(
    { type: 'INSTANCE', size: { x: 229.5, y: 280 }, fillGeometry: [{ commandsBlob: 10 }], transform: {} },
    symbol,
    new Map(),
  );
  assert.deepEqual(own['fillGeometry'], [{ commandsBlob: 10 }], 'an instance\'s own outline is already resolved');
});

test('instanceShapeNode applies the symbol root\'s own override record', () => {
  const symbol = tree('2:100', { type: 'SYMBOL', overrideKey: guid('0:4'), size: { x: 22, y: 22 }, fillPaints: [{}] });
  const out = instanceShapeNode(
    { type: 'INSTANCE', transform: {} },
    symbol,
    new Map([['0:4', { fillPaints: [], size: { x: 40, y: 40 } }]]),
  );
  assert.deepEqual(out['fillPaints'], []);
  assert.deepEqual(out['size'], { x: 40, y: 40 });
});

// ------------------------------------------------------------------------------------ styles

test('stylePaints follows a local FILL style and nothing else', () => {
  const index = fakeIndex([black, glow]);
  assert.deepEqual(stylePaints(index, { assetRef: { key: 'kblack' } }), black.node['fillPaints']);
  assert.equal(stylePaints(index, { assetRef: { key: 'kglow' } }), undefined, 'an effect style is not a colour');
  assert.equal(stylePaints(index, { assetRef: { key: 'not-in-file' } }), undefined);
  assert.equal(stylePaints(index, { guid: guid('4294967295:4294967295') }), undefined, 'the detached sentinel');
  assert.equal(stylePaints(index, undefined), undefined);
});

test('applyStyles replaces the cached copy with the style\'s live value, and only then', () => {
  const index = fakeIndex([black, glow]);
  const stale = {
    styleIdForFill: { assetRef: { key: 'kblack' } },
    fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0, a: 1 } }],
    styleIdForEffect: { assetRef: { key: 'kglow' } },
    effects: [],
  };
  const out = applyStyles(index, stale);
  assert.deepEqual(out['fillPaints'], black.node['fillPaints']);
  assert.deepEqual(out['effects'], glow.node['effects']);
  const untouched = { fillPaints: [{ type: 'SOLID' }] };
  assert.equal(applyStyles(index, untouched), untouched, 'no reference, same object');
  const remote = { styleIdForFill: { assetRef: { key: 'library' } }, fillPaints: [{ type: 'SOLID' }] };
  assert.equal(applyStyles(index, remote), remote, 'a library style keeps the cached copy');
});

test('runPaints prefers the entry\'s style over its cached paints and falls through otherwise', () => {
  const index = fakeIndex([black]);
  const node = {
    textData: {
      styleOverrideTable: [
        { styleID: 17, styleIdForFill: { assetRef: { key: 'kblack' } }, fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }] },
        { styleID: 18, fillPaints: [{ type: 'SOLID', color: { r: 0, g: 0, b: 1, a: 1 } }] },
        { styleID: 19, fontSize: 30 },
      ],
    },
  };
  assert.deepEqual(runPaints(index, node, 17, 'fillPaints'), black.node['fillPaints']);
  assert.equal((runPaints(index, node, 18, 'fillPaints') as { color: { b: number } }[])[0]!.color.b, 1);
  assert.equal(runPaints(index, node, 19, 'fillPaints'), undefined, 'an entry without paints overrides nothing');
  assert.equal(runPaints(index, node, 0, 'fillPaints'), undefined);
  assert.equal(runPaints(index, node, 99, 'fillPaints'), undefined);
});
