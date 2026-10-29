import test from 'node:test';
import assert from 'node:assert/strict';
import type { KiwiObject } from '../../dist/fig/kiwi.js';
import {
  letterSpacingString, lineHeightString, nodeDetail, typography,
} from '../../dist/model/summarize.js';
import { compactStyle } from '../../dist/model/text.js';
import { fileOf, guid } from '../fixtures/file.ts';

const idx = fileOf([]);
const solid = (r: number, g: number, b: number, extra: KiwiObject = {}) => ({
  type: 'SOLID', color: { r, g, b, a: 1 }, opacity: 1, visible: true, ...extra,
});

test('a translucent text colour keeps its alpha', () => {
  // iOS "Label Color/Light/Secondary": #3C3C43 at 60 %, carried as the paint's opacity.
  const grey = { r: 0x3c / 255, g: 0x3c / 255, b: 0x43 / 255 };
  assert.equal(typography(idx, { fillPaints: [solid(grey.r, grey.g, grey.b, { opacity: 0.6 })] })['color'], '#3C3C4399');
  // ... or as the colour's own alpha, or both.
  const both = { type: 'SOLID', color: { ...grey, a: 0.5 }, opacity: 0.6 };
  assert.equal(typography(idx, { fillPaints: [both] })['color'], '#3C3C434D');
  assert.equal(typography(idx, { fillPaints: [solid(0, 0, 0)] })['color'], '#000000', 'opaque stays 6 digits');
});

test('only a paint that shows is the text colour', () => {
  const hiddenRed = solid(1, 0, 0, { visible: false });
  const style = typography(idx, { fillPaints: [hiddenRed, solid(0, 0, 0)] });
  assert.equal(style['color'], '#000000');
  assert.equal(style['fills'], undefined);
});

test('text painted with several fills has no single colour: its fills come back', () => {
  // The lock screen clock: white OVERLAY, white SOFT_LIGHT and a gradient on top.
  const node = {
    fillPaints: [
      solid(1, 1, 1, { blendMode: 'OVERLAY' }),
      solid(1, 1, 1, { opacity: 0.3, blendMode: 'SOFT_LIGHT' }),
      { type: 'GRADIENT_LINEAR', visible: true, stops: [] },
    ],
  };
  const style = typography(idx, node);
  assert.equal(style['color'], undefined, 'the first solid is not the colour of the text');
  assert.deepEqual((style['fills'] as KiwiObject[]).map((p) => p['type']), ['SOLID', 'SOLID', 'GRADIENT_LINEAR']);
  assert.deepEqual(compactStyle(style)!['fills'], style['fills'], 'fig_text keeps them too');
  assert.equal(compactStyle(typography(idx, { fillPaints: [solid(0, 0, 0)] }))!['fills'], undefined);
});

test('Figma\'s auto line height (100 PERCENT) reads as auto, not as CSS 100%', () => {
  assert.equal(lineHeightString({ value: 100, units: 'PERCENT' }), 'auto');
  assert.equal(lineHeightString({ value: 22, units: 'PIXELS' }), '22px');
  assert.equal(lineHeightString({ value: 1.5, units: 'RAW' }), '1.5');
  assert.equal(lineHeightString({ value: 150, units: 'PERCENT' }), '150%');
  assert.equal(lineHeightString(undefined), undefined);
});

test('a percent letter spacing is of the font size, which CSS spells em', () => {
  assert.equal(letterSpacingString({ value: 1, units: 'PERCENT' }), '0.01em');
  assert.equal(letterSpacingString({ value: -2.5, units: 'PERCENT' }), '-0.025em');
  assert.equal(letterSpacingString({ value: -0.408, units: 'PIXELS' }), '-0.41px');
  assert.equal(letterSpacingString(undefined), undefined);
});

test('fig_node reports the same line height and letter spacing as fig_style', () => {
  const file = fileOf([{
    guid: guid('2:1'), type: 'TEXT', name: 'Clock', fontSize: 96,
    lineHeight: { value: 100, units: 'PERCENT' }, letterSpacing: { value: -1, units: 'PERCENT' },
    textData: { characters: '9:41' },
  }]);
  const text = nodeDetail(file, file.node('2:1')!)['text'] as Record<string, unknown>;
  assert.equal(text['lineHeight'], 'auto');
  assert.equal(text['letterSpacing'], '-0.01em');
});
