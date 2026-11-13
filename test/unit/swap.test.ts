import test from 'node:test';
import assert from 'node:assert/strict';
import { swapAppearance } from '../../dist/model/instance.js';
import { sceneOf } from '../../dist/model/scene.js';
import { exportSubtree } from '../../dist/render/export.js';
import { entryOf, fileOf, guid } from '../fixtures/file.ts';

// F27 — a nested instance's stored record copies its component root's own appearance. When a
// record or a property swaps the component, those copies are not overrides and must go.

const solid = (r: number, g: number, b: number) => ({ type: 'SOLID', color: { r, g, b, a: 1 }, opacity: 1, visible: true });
const PURPLE = solid(0.5, 0, 0.5); // #800080
const GREY = solid(0.6, 0.6, 0.6); // #999999
const WHITE = solid(1, 1, 1);
const DARK = solid(0.2, 0.2, 0.2); // #333333
const BLUE = solid(0, 0, 1); // #0000ff
const SHADOW = { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.25 }, radius: 4, visible: true };

// A status light whose root IS the filled circle, and the copy of it a nested instance carries.
const lightRoot = {
  size: { x: 20, y: 20 }, fillPaints: [PURPLE], strokePaints: [GREY], strokeWeight: 2, strokeAlign: 'INSIDE',
  cornerRadius: 10, frameMaskDisabled: true,
};
const checkRoot = { size: { x: 24, y: 24 }, strokeWeight: 0, strokeAlign: 'CENTER', frameMaskDisabled: true };

test('swapAppearance replaces what the record only copied from the old root by the new root\'s', () => {
  const stored = {
    type: 'INSTANCE', name: 'Icon slot', visible: true, transform: { m00: 1, m11: 1, m02: 4, m12: 2 },
    ...lightRoot, effects: [], fillGeometry: [{ commandsBlob: 1 }], strokeGeometry: [{ commandsBlob: 2 }],
  };
  const out = swapAppearance(stored, { ...lightRoot, effects: [] }, { ...checkRoot, effects: [SHADOW] });
  assert.equal('fillPaints' in out, false, 'the circle goes: the new root paints nothing');
  assert.equal('strokePaints' in out, false);
  assert.equal('cornerRadius' in out, false);
  assert.equal(out['strokeWeight'], 0);
  assert.equal(out['strokeAlign'], 'CENTER');
  assert.deepEqual(out['effects'], [SHADOW], 'what the new root has, the swapped instance shows');
  assert.equal('fillGeometry' in out, false, 'the outline traced the old component');
  assert.equal('strokeGeometry' in out, false);
  for (const kept of ['type', 'name', 'visible', 'transform', 'size'] as const) {
    assert.deepEqual(out[kept], stored[kept], `${kept} is the instance's own`);
  }
  assert.deepEqual(stored.fillPaints, [PURPLE], 'the input is not mutated');
});

test('swapAppearance keeps what the instance overrode, a paint with its style reference as one unit', () => {
  const blue = swapAppearance({ ...lightRoot, fillPaints: [BLUE] }, lightRoot, checkRoot);
  assert.deepEqual(blue['fillPaints'], [BLUE], 'a fill unlike the old root\'s is an override');
  assert.equal('strokePaints' in blue, false, 'the rest still goes');

  const styled = swapAppearance(
    { ...lightRoot, styleIdForFill: { guid: guid('9:1') } },
    lightRoot,
    checkRoot,
  );
  assert.deepEqual(styled['fillPaints'], [PURPLE], 'same paints, but a style the old root lacked');
  assert.deepEqual(styled['styleIdForFill'], { guid: guid('9:1') });

  const corners = swapAppearance(
    { ...lightRoot, cornerRadius: 10, rectangleCornerRadiiIndependent: true, rectangleTopLeftCornerRadius: 4 },
    lightRoot,
    checkRoot,
  );
  assert.equal(corners['cornerRadius'], 10, 'the corner group is compared whole');
  assert.equal(corners['rectangleTopLeftCornerRadius'], 4);
});

// ------------------------------------------------------------------- the scene and the picture

const records = [
  { guid: guid('3:10'), type: 'SYMBOL', name: 'Icon / Status', ...lightRoot },
  { guid: guid('3:11'), parent: '3:10', type: 'ELLIPSE', name: 'Glint', size: { x: 6, y: 6 }, fillPaints: [WHITE] },
  { guid: guid('3:20'), type: 'SYMBOL', name: 'Icon / Check', ...checkRoot },
  { guid: guid('3:21'), parent: '3:20', type: 'RECTANGLE', name: 'Check', size: { x: 24, y: 24 }, fillPaints: [DARK] },
  {
    guid: guid('3:100'), type: 'SYMBOL', name: 'Menu entry', size: { x: 160, y: 32 },
    componentPropDefs: [{ id: guid('7:1'), name: 'icon', type: 'INSTANCE_SWAP' }],
  },
  {
    guid: guid('3:101'), parent: '3:100', type: 'INSTANCE', name: 'Icon slot', symbolData: { symbolID: guid('3:10') },
    ...lightRoot, componentPropRefs: [{ defID: guid('7:1'), componentPropNodeField: 'OVERRIDDEN_SYMBOL_ID' }],
  },
  {
    guid: guid('3:200'), type: 'INSTANCE', name: 'By property', size: { x: 160, y: 32 }, symbolData: { symbolID: guid('3:100') },
    componentPropAssignments: [{ defID: guid('7:1'), value: { guidValue: guid('3:20') } }],
  },
  {
    guid: guid('3:201'), type: 'INSTANCE', name: 'By record', size: { x: 160, y: 32 },
    symbolData: { symbolID: guid('3:100'), symbolOverrides: [{ guidPath: { guids: [guid('3:101')] }, overriddenSymbolID: guid('3:20') }] },
  },
  { guid: guid('3:202'), type: 'INSTANCE', name: 'Default', size: { x: 160, y: 32 }, symbolData: { symbolID: guid('3:100') } },
  {
    guid: guid('3:203'), type: 'INSTANCE', name: 'Swapped and filled', size: { x: 160, y: 32 },
    symbolData: {
      symbolID: guid('3:100'),
      symbolOverrides: [{ guidPath: { guids: [guid('3:101')] }, overriddenSymbolID: guid('3:20'), fillPaints: [BLUE] }],
    },
  },
];

test('the scene shows a swapped slot without the old component\'s circle', () => {
  const idx = fileOf(records);
  for (const id of ['3:200', '3:201']) {
    const slot = sceneOf(idx, idx.node(id)!).children[0]!;
    assert.equal(slot.node['fillPaints'], undefined, id);
    assert.equal(slot.node['cornerRadius'], undefined, id);
    assert.equal(slot.node['strokeAlign'], 'CENTER', id);
  }
  const unswapped = sceneOf(idx, idx.node('3:202')!).children[0]!;
  assert.deepEqual(unswapped.node['fillPaints'], [PURPLE], 'without a swap the copy is the instance\'s appearance');
  const filled = sceneOf(idx, idx.node('3:203')!).children[0]!;
  assert.deepEqual(filled.node['fillPaints'], [BLUE], 'a record\'s fill on the swapped slot is an override');
});

test('the renderer draws a swapped slot without the old component\'s circle', () => {
  const entry = entryOf(records);
  const svg = (id: string) => exportSubtree(entry, entry.index.node(id)!).svg;
  for (const id of ['3:200', '3:201']) {
    assert.doesNotMatch(svg(id), /fill="#800080"/, id);
    assert.match(svg(id), /fill="#333333"/, id);
  }
  assert.match(svg('3:202'), /fill="#800080"/, 'the default status light still draws its circle');
  assert.match(svg('3:203'), /fill="#0000ff"/);
  assert.doesNotMatch(svg('3:203'), /fill="#800080"/);
});
