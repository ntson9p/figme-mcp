import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeDetail, styleBlock } from '../../dist/model/summarize.js';
import { cornerRadii } from '../../dist/render/export.js';
import { fileOf, guid } from '../fixtures/file.ts';

// The iOS 16 UI Kit's notification: rounded only at the top. Figma writes the two top corners
// and the uniform radius, and nothing for the square bottom corners.
const topOnly = {
  cornerRadius: 23,
  rectangleCornerRadiiIndependent: true,
  rectangleTopLeftCornerRadius: 23,
  rectangleTopRightCornerRadius: 23,
};

test('an independent corner the record does not write is square, not the uniform radius (F24)', () => {
  const idx = fileOf([{ guid: guid('2:1'), type: 'FRAME', name: 'Notification', size: { x: 370, y: 66 }, ...topOnly }]);
  const t = idx.node('2:1')!;
  assert.deepEqual(nodeDetail(idx, t)['cornerRadius'], [23, 23, 0, 0]);
  assert.deepEqual(styleBlock(idx, t)['cornerRadius'], [23, 23, 0, 0]);
  assert.deepEqual(cornerRadii(topOnly), [23, 23, 0, 0], 'the renderer draws it the same way');
});

test('uniform and fully written corners are unchanged', () => {
  assert.deepEqual(cornerRadii({ cornerRadius: 12 }), [12, 12, 12, 12]);
  assert.deepEqual(cornerRadii({ cornerRadius: 12, rectangleCornerRadiiIndependent: false, rectangleTopLeftCornerRadius: 4 }), [12, 12, 12, 12]);
  const all = {
    rectangleCornerRadiiIndependent: true,
    rectangleTopLeftCornerRadius: 1, rectangleTopRightCornerRadius: 2,
    rectangleBottomRightCornerRadius: 3, rectangleBottomLeftCornerRadius: 4,
  };
  assert.deepEqual(cornerRadii(all), [1, 2, 3, 4]);
  const idx = fileOf([
    { guid: guid('2:1'), type: 'FRAME', cornerRadius: 8 },
    { guid: guid('2:2'), type: 'FRAME', rectangleCornerRadiiIndependent: true, rectangleTopLeftCornerRadius: 6,
      rectangleTopRightCornerRadius: 6, rectangleBottomRightCornerRadius: 6, rectangleBottomLeftCornerRadius: 6 },
  ]);
  assert.equal(nodeDetail(idx, idx.node('2:1')!)['cornerRadius'], 8);
  assert.equal(nodeDetail(idx, idx.node('2:2')!)['cornerRadius'], 6, 'four equal corners collapse to one');
});
