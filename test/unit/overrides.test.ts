import test from 'node:test';
import assert from 'node:assert/strict';
import { overrideFields } from '../../dist/model/components.js';
import { fileOf, guid } from '../fixtures/file.ts';

const idx = fileOf([
  { guid: guid('2:1'), type: 'SYMBOL', name: 'Toggle',
    componentPropDefs: [{ id: guid('6:1'), name: 'show icon', type: 'BOOL' }] },
  { guid: guid('2:2'), type: 'SYMBOL', name: 'Toggle / Dark' },
]);

test('a record\'s corner group reads like a node\'s, square where a corner is not written', () => {
  const uniform = overrideFields(idx, {
    cornerRadius: 100, rectangleCornerRadiiIndependent: false,
    rectangleTopLeftCornerRadius: 100, rectangleTopRightCornerRadius: 100,
    rectangleBottomLeftCornerRadius: 100, rectangleBottomRightCornerRadius: 100,
  });
  assert.equal(uniform.fields['cornerRadius'], 100);
  assert.deepEqual(uniform.otherFields, [], 'every corner field is translated');

  const top = overrideFields(idx, {
    cornerRadius: 23, rectangleCornerRadiiIndependent: true,
    rectangleTopLeftCornerRadius: 23, rectangleTopRightCornerRadius: 23,
  });
  assert.deepEqual(top.fields['cornerRadius'], [23, 23, 0, 0]);
  assert.equal(overrideFields(idx, { cornerRadius: 8 }).fields['cornerRadius'], 8);
});

test('a record\'s stroke sides read like a node\'s', () => {
  const { fields, otherFields } = overrideFields(idx, {
    strokeWeight: 1, borderStrokeWeightsIndependent: true,
    borderTopWeight: 0.5, borderBottomWeight: 0, borderLeftWeight: 0, borderRightWeight: 0,
  });
  assert.equal(fields['strokeWeight'], 1);
  assert.deepEqual(fields['strokeWeights'], { top: 0.5, right: 0, bottom: 0, left: 0 });
  assert.deepEqual(otherFields, []);
});

test('a swap, a rename and property values set on a nested instance are translated', () => {
  const { fields, otherFields } = overrideFields(idx, {
    name: 'Wi-Fi toggle',
    overriddenSymbolID: guid('2:2'),
    componentPropAssignments: [{ defID: guid('6:1'), value: { boolValue: false } }],
  });
  assert.equal(fields['name'], 'Wi-Fi toggle');
  assert.deepEqual(fields['swappedTo'], { guid: '2:2', name: 'Toggle / Dark' });
  assert.deepEqual(fields['propAssignments'], [{ defID: '6:1', name: 'show icon', type: 'BOOL', value: false }]);
  assert.deepEqual(otherFields, []);
});

test('text fields the text block translates are not reported as untranslated', () => {
  const { fields, otherFields } = overrideFields(idx, {
    textData: { characters: '6' }, textAlignHorizontal: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT',
    fontVersion: '1',
  });
  assert.equal((fields['text'] as Record<string, unknown>)['align'], 'CENTER');
  assert.deepEqual(otherFields, ['fontVersion'], 'only what is really not mapped');
});
