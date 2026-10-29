import test from 'node:test';
import assert from 'node:assert/strict';
import type { KiwiObject } from '../../dist/fig/kiwi.js';
import { nodeDetail, styleBlock } from '../../dist/model/summarize.js';
import { fileOf, guid } from '../fixtures/file.ts';

const grey = { type: 'SOLID', color: { r: 0.24, g: 0.24, b: 0.26, a: 1 }, opacity: 0.36, visible: true };

function both(record: KiwiObject) {
  const idx = fileOf([{ guid: guid('2:1'), type: 'FRAME', name: 'Bar', size: { x: 390, y: 44 }, ...record }]);
  const t = idx.node('2:1')!;
  return [nodeDetail(idx, t), styleBlock(idx, t)];
}

test('a node without a visible stroke reports no stroke weight, alignment, cap or dashes', () => {
  // Figma writes strokeWeight 1 on almost every node; without a stroke it describes nothing.
  for (const out of both({ strokeWeight: 1, strokeAlign: 'INSIDE', strokeCap: 'ROUND', dashPattern: [0, 0] })) {
    for (const field of ['strokeWeight', 'strokeWeights', 'strokeAlign', 'strokeCap', 'dashPattern']) {
      assert.equal(out[field], undefined, field);
    }
  }
  for (const out of both({ strokeWeight: 1, strokePaints: [{ ...grey, visible: false }] })) {
    assert.equal(out['strokeWeight'], undefined, 'a hidden stroke is no stroke');
    assert.equal((out['strokes'] as unknown[]).length, 1, 'but the paint is still listed');
  }
});

test('a visible stroke reports its weight and alignment as before', () => {
  for (const out of both({ strokeWeight: 1, strokeAlign: 'INSIDE', strokePaints: [grey] })) {
    assert.equal(out['strokeWeight'], 1);
    assert.equal(out['strokeAlign'], 'INSIDE');
    assert.equal(out['strokeWeights'], undefined, 'one weight for every side');
  }
});

test('independent sides report the weight of each side (F25)', () => {
  // The iOS navigation bar: a 0.5 px hairline at the bottom, beside a strokeWeight of 0.
  const navigation = { strokeWeight: 0, strokePaints: [grey], borderStrokeWeightsIndependent: true, borderBottomWeight: 0.5 };
  for (const out of both(navigation)) {
    assert.deepEqual(out['strokeWeights'], { top: 0, right: 0, bottom: 0.5, left: 0 });
    assert.equal(out['strokeWeight'], undefined);
  }
  // The tab bar: a hairline at the top, beside a strokeWeight of 1 that no side has.
  const tabBar = { strokeWeight: 1, strokePaints: [grey], borderStrokeWeightsIndependent: true, borderTopWeight: 0.5 };
  for (const out of both(tabBar)) {
    assert.deepEqual(out['strokeWeights'], { top: 0.5, right: 0, bottom: 0, left: 0 });
  }
});
