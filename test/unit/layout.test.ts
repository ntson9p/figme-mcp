import test from 'node:test';
import assert from 'node:assert/strict';
import type { KiwiObject } from '../../dist/fig/kiwi.js';
import { nodeDetail, styleBlock } from '../../dist/model/summarize.js';
import { fileOf, guid } from '../fixtures/file.ts';

/** One auto-layout frame, reported by fig_node (Figma terms) and fig_style (CSS terms). */
function report(frame: KiwiObject) {
  const idx = fileOf([{ guid: guid('2:1'), type: 'FRAME', name: 'Row', size: { x: 325, y: 44 }, ...frame }]);
  const t = idx.node('2:1')!;
  return {
    figma: nodeDetail(idx, t)['autoLayout'] as Record<string, unknown>,
    css: styleBlock(idx, t)['layout'] as Record<string, unknown>,
  };
}

test('Figma\'s auto spacing is reported as auto, never as the gap it ignores', () => {
  // The DatePicker month header: SPACE_EVENLY with a stored 141 that Figma does not use.
  const { figma, css } = report({
    stackMode: 'HORIZONTAL', stackSpacing: 141, stackPrimaryAlignItems: 'SPACE_EVENLY',
    stackCounterAlignItems: 'CENTER', stackPrimarySizing: 'FIXED',
  });
  assert.equal(figma['spacing'], 'auto');
  assert.equal(figma['primaryAlign'], 'SPACE_BETWEEN', 'the name Figma\'s plugin and REST APIs use');
  assert.equal(css['gap'], undefined, 'a CSS gap would be a minimum that overflows a narrower box');
  assert.equal(css['justifyContent'], 'space-between');

  const newer = report({ stackMode: 'VERTICAL', stackSpacing: 8, stackPrimaryAlignItems: 'SPACE_BETWEEN' });
  assert.equal(newer.figma['spacing'], 'auto');
  assert.equal(newer.css['gap'], undefined);
});

test('auto spacing on an axis that hugs its content keeps the stored gap', () => {
  const { figma, css } = report({
    stackMode: 'HORIZONTAL', stackSpacing: 12, stackPrimaryAlignItems: 'SPACE_EVENLY',
    stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE',
  });
  assert.equal(figma['spacing'], 12, 'nothing to spread, so the stored gap is the gap');
  assert.equal(figma['primaryAlign'], 'SPACE_BETWEEN');
  assert.equal(css['gap'], 12);
});

test('a fixed gap is reported unchanged', () => {
  const { figma, css } = report({
    stackMode: 'HORIZONTAL', stackSpacing: 8, stackPrimaryAlignItems: 'CENTER', stackCounterAlignItems: 'CENTER',
  });
  assert.equal(figma['spacing'], 8);
  assert.equal(figma['primaryAlign'], 'CENTER');
  assert.equal(css['gap'], 8);
  assert.equal(css['justifyContent'], 'center');
});

test('the gap between wrapped lines is reported only for a layout that wraps', () => {
  const single = report({ stackMode: 'HORIZONTAL', stackSpacing: 8, stackCounterSpacing: 20 });
  assert.equal(single.figma['counterSpacing'], undefined);
  assert.equal(single.css['rowGap'], undefined);

  const wrapped = report({ stackMode: 'HORIZONTAL', stackSpacing: 8, stackCounterSpacing: 20, stackWrap: 'WRAP' });
  assert.equal(wrapped.figma['counterSpacing'], 20);
  assert.equal(wrapped.css['rowGap'], 20);
  assert.equal(wrapped.css['flexWrap'], 'wrap');

  const spread = report({
    stackMode: 'HORIZONTAL', stackSpacing: 8, stackCounterSpacing: 20, stackWrap: 'WRAP',
    stackCounterAlignContent: 'SPACE_BETWEEN',
  });
  assert.equal(spread.figma['counterSpacing'], 'auto');
  assert.equal(spread.css['rowGap'], undefined);
  assert.equal(spread.css['alignContent'], 'space-between');
});

test('a grid layout keeps both stored gaps', () => {
  const { figma, css } = report({ stackMode: 'GRID', stackSpacing: 4, stackCounterSpacing: 6 });
  assert.equal(figma['spacing'], 4);
  assert.equal(figma['counterSpacing'], 6);
  assert.equal(css['gap'], 4);
  assert.equal(css['rowGap'], 6);
});
