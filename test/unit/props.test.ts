import test from 'node:test';
import assert from 'node:assert/strict';
import type { KiwiObject } from '../../dist/fig/kiwi.js';
import { assignmentValue, propValueOfVariableData } from '../../dist/model/instance.js';
import { sceneOf } from '../../dist/model/scene.js';
import { componentView, instanceView } from '../../dist/model/components.js';
import { exportSubtree } from '../../dist/render/export.js';
import { entryOf, fileOf, guid } from '../fixtures/file.ts';

// F26 — current Figma files keep some component-property values only in `varValue`, a
// VariableData, with the value names of VariableAnyValue: `symbolIdValue`, `textDataValue`.

const solid = (r: number, g: number, b: number) => ({ type: 'SOLID', color: { r, g, b, a: 1 }, opacity: 1, visible: true });
const PURPLE = solid(0.5, 0, 0.5); // #800080
const DARK = solid(0.2, 0.2, 0.2); // #333333
const BLUE = solid(0, 0, 1); // #0000ff
const RED = solid(1, 0, 0); // #ff0000

const text = (characters: string) => ({ characters, lines: [{ lineType: 'PLAIN', styleId: 0 }] });
const data = (value: KiwiObject, dataType: string) => ({ value, dataType, resolvedDataType: dataType });
const ref = (defID: string, field: string) => ({ defID: guid(defID), componentPropNodeField: field });
const box = { x: 20, y: 20 };

const records = [
  // Three icons. The default draws a purple circle; the other two are published under a key.
  { guid: guid('2:10'), type: 'SYMBOL', name: 'Icon / Circle', size: box },
  { guid: guid('2:11'), parent: '2:10', type: 'RECTANGLE', name: 'Circle', size: box, fillPaints: [PURPLE] },
  { guid: guid('2:20'), type: 'SYMBOL', name: 'Icon / Star', size: box, componentKey: 'k-star' },
  { guid: guid('2:21'), parent: '2:20', type: 'RECTANGLE', name: 'Star', size: box, fillPaints: [DARK] },
  { guid: guid('2:30'), type: 'SYMBOL', name: 'Icon / Heart', size: box, componentKey: 'k-heart' },
  { guid: guid('2:31'), parent: '2:30', type: 'RECTANGLE', name: 'Heart', size: box, fillPaints: [BLUE] },
  // A card header: an icon slot, a title and a flag, each bound to a property. The swap property's
  // default exists only as variable data, as Figma writes it for INSTANCE_SWAP definitions.
  {
    guid: guid('2:100'), type: 'SYMBOL', name: 'Card header', size: { x: 160, y: 32 },
    componentPropDefs: [
      { id: guid('6:1'), name: 'icon', type: 'INSTANCE_SWAP', varValue: data({ symbolIdValue: { guid: guid('2:10') } }, 'SYMBOL_ID') },
      { id: guid('6:2'), name: 'title', type: 'TEXT', initialValue: { textValue: text('Title') } },
      { id: guid('6:3'), name: 'show flag', type: 'BOOL', initialValue: { boolValue: true } },
    ],
  },
  {
    guid: guid('2:101'), parent: '2:100', type: 'INSTANCE', name: 'Icon slot', size: box,
    symbolData: { symbolID: guid('2:10') }, componentPropRefs: [ref('6:1', 'OVERRIDDEN_SYMBOL_ID')],
  },
  { guid: guid('2:102'), parent: '2:100', type: 'TEXT', name: 'Title', textData: text('Title'), componentPropRefs: [ref('6:2', 'TEXT_DATA')] },
  { guid: guid('2:103'), parent: '2:100', type: 'RECTANGLE', name: 'Flag', size: { x: 8, y: 8 }, fillPaints: [RED], componentPropRefs: [ref('6:3', 'VISIBLE')] },
  // Every value only in varValue.
  {
    guid: guid('2:200'), type: 'INSTANCE', name: 'Starred', size: { x: 160, y: 32 }, symbolData: { symbolID: guid('2:100') },
    componentPropAssignments: [
      { defID: guid('6:1'), varValue: data({ symbolIdValue: { guid: guid('2:20') } }, 'SYMBOL_ID') },
      { defID: guid('6:2'), varValue: data({ textDataValue: text('Starred') }, 'TEXT_DATA') },
      { defID: guid('6:3'), varValue: data({ boolValue: false }, 'BOOLEAN') },
    ],
  },
  // A swap that names the component by its publish key.
  {
    guid: guid('2:201'), type: 'INSTANCE', name: 'Loved', size: { x: 160, y: 32 }, symbolData: { symbolID: guid('2:100') },
    componentPropAssignments: [
      { defID: guid('6:1'), varValue: data({ symbolIdValue: { assetRef: { key: 'k-heart', version: '1:1' } } }, 'SYMBOL_ID') },
    ],
  },
];

const idx = fileOf(records);
const chars = (node: KiwiObject) => (node['textData'] as { characters: string }).characters;

// ----------------------------------------------------------------------------- the resolver

test('assignmentValue reads varValue when the value slot is absent or empty', () => {
  const swap = { defID: guid('6:1'), varValue: data({ symbolIdValue: { guid: guid('2:20') } }, 'SYMBOL_ID') };
  assert.deepEqual(assignmentValue(idx, swap), { guidValue: guid('2:20') });
  assert.deepEqual(assignmentValue(idx, { ...swap, value: {} }), { guidValue: guid('2:20') }, 'an empty value is no value');

  const both = { defID: guid('6:2'), value: { textValue: text('Value') }, varValue: data({ textDataValue: text('Var') }, 'TEXT_DATA') };
  assert.deepEqual(assignmentValue(idx, both), { textValue: text('Value') }, 'the value slot comes first');

  const outer = new Map([['5:1', { boolValue: false }]]);
  const propRef = { defID: guid('6:3'), varValue: { value: { propRefValue: { defId: guid('5:1') } }, dataType: 'PROP_REF' } };
  assert.deepEqual(assignmentValue(idx, propRef, outer), { boolValue: false });
  assert.equal(assignmentValue(idx, propRef), undefined, 'a PROP_REF without the enclosing values');
});

test('propValueOfVariableData translates the VariableAnyValue names into ComponentPropValue ones', () => {
  assert.deepEqual(propValueOfVariableData(idx, data({ boolValue: true }, 'BOOLEAN')), { boolValue: true });
  assert.deepEqual(propValueOfVariableData(idx, data({ textDataValue: text('A') }, 'TEXT_DATA')), { textValue: text('A') });
  assert.equal(
    propValueOfVariableData(idx, data({ textValue: 'A' }, 'STRING')),
    undefined,
    'a VariableAnyValue textValue is a plain string, not the TextData a text property holds',
  );
  assert.deepEqual(propValueOfVariableData(idx, data({ symbolIdValue: { guid: guid('2:30') } }, 'SYMBOL_ID')), { guidValue: guid('2:30') });
  assert.deepEqual(
    propValueOfVariableData(idx, data({ symbolIdValue: { assetRef: { key: 'k-star' } } }, 'SYMBOL_ID')),
    { guidValue: guid('2:20') },
    'a publish key resolves to the local component',
  );
  assert.equal(propValueOfVariableData(idx, data({ symbolIdValue: { assetRef: { key: 'k-library' } } }, 'SYMBOL_ID')), undefined);
  assert.equal(propValueOfVariableData(idx, data({ alias: { guid: guid('9:9') } }, 'ALIAS')), undefined, 'a variable is not a value');
  assert.equal(propValueOfVariableData(idx, undefined), undefined);
});

// -------------------------------------------------------------------------------- the scene

test('an instance shows the icon, title and flag its varValue assignments choose', () => {
  const header = sceneOf(idx, idx.node('2:200')!);
  const [slot, title, flag] = header.children;
  assert.deepEqual(slot!.node['overriddenSymbolID'], guid('2:20'));
  assert.deepEqual(slot!.children.map((c) => c.key), ['I2:200;2:101;2:21'], 'the layers of the swapped-in icon');
  assert.equal(chars(title!.node), 'Starred');
  assert.equal(flag!.node['visible'], false);
});

test('a swap that names its component by publish key lands on the local component', () => {
  const slot = sceneOf(idx, idx.node('2:201')!).children[0]!;
  assert.deepEqual(slot.node['overriddenSymbolID'], guid('2:30'));
  assert.equal(slot.children[0]!.node['name'], 'Heart');
});

// ------------------------------------------------------------------------ inspection tools

test('fig_instance names the component a varValue swap picks, and reads the other values', () => {
  const view = instanceView(idx, sceneOf(idx, idx.node('2:200')!));
  assert.deepEqual(view.propAssignments, [
    { defID: '6:1', name: 'icon', type: 'INSTANCE_SWAP', value: { guid: '2:20', name: 'Icon / Star' } },
    { defID: '6:2', name: 'title', type: 'TEXT', value: 'Starred' },
    { defID: '6:3', name: 'show flag', type: 'BOOL', value: false },
  ]);
});

test('fig_components reports an INSTANCE_SWAP default held only as variable data', () => {
  const defs = componentView(idx, idx.node('2:100')!).propDefs!;
  assert.deepEqual(defs[0], { name: 'icon', type: 'INSTANCE_SWAP', default: { guid: '2:10', name: 'Icon / Circle' } });
  assert.deepEqual(defs[1], { name: 'title', type: 'TEXT', default: 'Title' });
});

// ------------------------------------------------------------------------------ the renderer

test('the renderer draws the swapped-in icon and hides what a varValue boolean switches off', () => {
  const entry = entryOf(records);
  const svg = exportSubtree(entry, entry.index.node('2:200')!).svg;
  assert.match(svg, /fill="#333333"/, 'the star');
  assert.doesNotMatch(svg, /fill="#800080"/, 'not the default circle');
  assert.doesNotMatch(svg, /fill="#ff0000"/, 'the flag is switched off');

  const byKey = exportSubtree(entry, entry.index.node('2:201')!).svg;
  assert.match(byKey, /fill="#0000ff"/);
  assert.doesNotMatch(byKey, /fill="#800080"/);
});
