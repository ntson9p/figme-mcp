import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalGuid } from '../../dist/model/tree.js';
import { inheritedOverrides, isHidden, isSublayerId, resolveScene, sceneOf } from '../../dist/model/scene.js';
import { fileOf, guid } from '../fixtures/file.ts';

const path = (...ids: string[]) => ({ guids: ids.map(guid) });

// A button component with a label bound to a TEXT property and an icon bound to a BOOLEAN one,
// a card component that nests the button, and an instance of each.
const idx = fileOf([
  { guid: guid('2:100'), type: 'SYMBOL', name: 'Button', size: { x: 120, y: 40 } },
  { guid: guid('2:101'), parent: '2:100', type: 'TEXT', name: 'Label', textData: { characters: 'OK' } },
  { guid: guid('2:102'), parent: '2:100', type: 'FRAME', name: 'Icon wrap', overrideKey: guid('0:77') },
  {
    guid: guid('2:103'), parent: '2:102', type: 'VECTOR', name: 'Icon', visible: true,
    componentPropRefs: [{ defID: guid('6:2'), componentPropNodeField: 'VISIBLE' }],
  },
  {
    guid: guid('2:200'), type: 'INSTANCE', name: 'Primary', size: { x: 120, y: 40 },
    symbolData: {
      symbolID: guid('2:100'),
      symbolOverrides: [{ guidPath: path('2:101'), textData: { characters: 'Save' } }],
    },
    componentPropAssignments: [{ defID: guid('6:2'), value: { boolValue: false } }],
  },
  { guid: guid('2:300'), type: 'SYMBOL', name: 'Card' },
  { guid: guid('2:301'), parent: '2:300', type: 'INSTANCE', name: 'Card button', symbolData: { symbolID: guid('2:100') } },
  { guid: guid('2:302'), parent: '2:300', type: 'TEXT', name: 'Title', textData: { characters: 'Title' } },
  {
    guid: guid('2:400'), type: 'INSTANCE', name: 'Card A',
    symbolData: {
      symbolID: guid('2:300'),
      symbolOverrides: [{ guidPath: path('2:301', '2:101'), textData: { characters: 'Nested' } }],
    },
  },
  // A component that contains an instance of itself — only a damaged file does this.
  { guid: guid('3:1'), type: 'SYMBOL', name: 'Loop' },
  { guid: guid('3:2'), parent: '3:1', type: 'INSTANCE', name: 'Self', symbolData: { symbolID: guid('3:1') } },
  { guid: guid('3:3'), type: 'INSTANCE', name: 'Loop instance', symbolData: { symbolID: guid('3:1') } },
]);

const chars = (id: string) => (resolveScene(idx, id)!.node['textData'] as { characters: string }).characters;

test('a sublayer id is the instance guid, then one override identity per nesting level', () => {
  assert.equal(isSublayerId('I2:200;2:101'), true);
  assert.equal(isSublayerId('I2:400;2:301;2:101'), true);
  for (const not of ['2:200', 'I2:200', 'I2:200;', 'I2:200;x', 'i2:200;2:101']) assert.equal(isSublayerId(not), false, not);
});

test('canonicalGuid accepts every spelling of a sublayer id a Figma link produces', () => {
  assert.equal(canonicalGuid('I2:200;2:101'), 'I2:200;2:101');
  assert.equal(canonicalGuid('I2-200;2-101'), 'I2:200;2:101');
  assert.equal(canonicalGuid('I2-200%3B2-101'), 'I2:200;2:101');
  assert.equal(canonicalGuid('https://www.figma.com/design/k/n?node-id=I2-200%3B2-101&t=x'), 'I2:200;2:101');
  assert.equal(canonicalGuid('I2-200'), 'I2-200', 'an instance alone is not a sublayer id');
});

test('an instance lists the layers its component shows, as it shows them', () => {
  const button = sceneOf(idx, idx.node('2:200')!);
  assert.deepEqual(button.children.map((c) => c.key), ['I2:200;2:101', 'I2:200;0:77']);
  const [label, wrap] = button.children;
  assert.equal((label!.node['textData'] as { characters: string }).characters, 'Save', 'the override applies');
  assert.equal(label!.virtual, true);
  assert.equal(label!.source.key, '2:101');
  assert.equal(wrap!.key, 'I2:200;0:77', 'a layer with an overrideKey is addressed by it');
  const icon = wrap!.children[0]!;
  assert.equal(icon.key, 'I2:200;2:103', 'one segment per nesting level, not per depth');
  assert.equal(icon.node['visible'], false, 'the BOOLEAN property switches the icon off');
  assert.equal(isHidden(icon), true);
  assert.equal(isHidden(label!), false);
});

test('the component itself keeps its own record', () => {
  const symbol = sceneOf(idx, idx.node('2:100')!);
  assert.deepEqual(symbol.children.map((c) => c.key), ['2:101', '2:102']);
  assert.equal(symbol.children[0]!.virtual, false);
  assert.equal((symbol.children[0]!.node['textData'] as { characters: string }).characters, 'OK');
});

test('resolveScene finds a sublayer with real parents, depth and page', () => {
  const icon = resolveScene(idx, 'I2:200;2:103')!;
  assert.equal(icon.node['name'], 'Icon');
  assert.equal(icon.parent!.key, 'I2:200;0:77');
  assert.equal(icon.parent!.parent!.key, '2:200');
  assert.equal(icon.depth, idx.node('2:200')!.depth + 2);
  assert.equal(icon.page?.key, '0:1');
  assert.equal(resolveScene(idx, '2:101')!.virtual, false, 'a stored guid stays a stored node');
});

test('records of an enclosing instance reach into a nested one', () => {
  const card = sceneOf(idx, idx.node('2:400')!);
  assert.deepEqual(card.children.map((c) => c.key), ['I2:400;2:301', 'I2:400;2:302']);
  const nested = card.children[0]!;
  assert.deepEqual(nested.children.map((c) => c.key), ['I2:400;2:301;2:101', 'I2:400;2:301;0:77']);
  assert.equal(chars('I2:400;2:301;2:101'), 'Nested');
  assert.equal(resolveScene(idx, 'I2:400;2:301;2:101')!.parent!.key, 'I2:400;2:301');

  const inherited = inheritedOverrides(resolveScene(idx, 'I2:400;2:301')!);
  assert.equal(inherited.length, 1);
  assert.deepEqual(inherited[0]!['guidPath'], path('2:101'), 're-addressed from the nested instance');
  assert.deepEqual(inheritedOverrides(sceneOf(idx, idx.node('2:400')!)), [], 'a stored instance inherits nothing');
});

test('resolveScene refuses ids that do not name a layer of that instance', () => {
  for (const bad of [
    'I9:9;2:101', // no such instance
    'I2:100;2:101', // a component, not an instance
    'I2:200;2:999', // not in the component
    'I2:200;2:100', // the component root is the instance itself, not a layer of it
    'I2:200;2:102', // addressed by its overrideKey 0:77, never by its guid
    'I2:200;2:101;2:101', // a text layer has no layers of its own
  ]) {
    assert.equal(resolveScene(idx, bad), undefined, bad);
  }
});

test('a component that contains itself expands once, never forever', () => {
  const loop = sceneOf(idx, idx.node('3:3')!);
  const self = loop.children[0]!;
  assert.equal(self.key, 'I3:3;3:2');
  assert.deepEqual(self.children, [], 'the cycle is cut instead of recursing');
});
