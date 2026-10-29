import test from 'node:test';
import assert from 'node:assert/strict';
import type { KiwiObject } from '../../dist/fig/kiwi.js';
import { paintView } from '../../dist/model/summarize.js';
import { fileOf } from '../fixtures/file.ts';

const idx = fileOf([]);
const rgba = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });
const linear = (transform: KiwiObject | undefined, stops: KiwiObject[], extra: KiwiObject = {}) => ({
  type: 'GRADIENT_LINEAR', visible: true, opacity: 1, ...(transform ? { transform } : {}), stops, ...extra,
});
const t = (m00: number, m01: number, m02: number) => ({ m00, m01, m02, m10: 0, m11: 1, m12: 0 });
const css = (p: KiwiObject, w = 100, h = 50) => paintView(idx, p, { w, h })['css'];

test('a linear gradient comes back as CSS: left to right by default', () => {
  const p = linear(undefined, [{ position: 0, color: rgba(1, 0, 0) }, { position: 1, color: rgba(0, 0, 1) }]);
  assert.equal(css(p), 'linear-gradient(90deg, #FF0000 0%, #0000FF 100%)');
  assert.equal(paintView(idx, p)['css'], undefined, 'without the box it fills, no CSS');
});

test('the CSS angle is the direction the gradient grows in, on the box\'s own pixels', () => {
  const stops = [{ position: 0, color: rgba(1, 1, 1) }, { position: 1, color: rgba(0, 0, 0) }];
  // Gradient value = y/h: top to bottom, whatever the box's proportions.
  assert.equal(css(linear(t(0, 1, 0), stops)), 'linear-gradient(180deg, #FFFFFF 0%, #000000 100%)');
  // Value = 1 - x/w: right to left.
  assert.equal(css(linear(t(-1, 0, 1), stops)), 'linear-gradient(270deg, #FFFFFF 0%, #000000 100%)');
});

test('stops land where the transform puts them on CSS\'s gradient line', () => {
  // m00 = 1.25: the gradient reaches its end at 80 % of the width (the iOS kit's tab highlights).
  const p = linear(t(1.25, 0, 0), [{ position: 0, color: rgba(0, 0, 1, 0) }, { position: 1, color: rgba(0, 0, 1) }]);
  assert.equal(css(p), 'linear-gradient(90deg, #0000FF00 0%, #0000FF 80%)');
});

test('the paint\'s opacity goes into every stop\'s alpha', () => {
  const p = linear(undefined, [{ position: 0, color: rgba(0, 0, 0) }, { position: 1, color: rgba(0, 0, 0, 0.5) }], { opacity: 0.5 });
  assert.equal(css(p), 'linear-gradient(90deg, #00000080 0%, #00000040 100%)');
});

test('a stretch whose colour and alpha both change is sampled the way Figma blends it', () => {
  // Transparent white into 50 % black: CSS would blend it premultiplied and lose Figma's pale fringe.
  const fringe = css(linear(t(0, 1, 0), [{ position: 0, color: rgba(1, 1, 1, 0) }, { position: 1, color: rgba(0, 0, 0, 0.5) }])) as string;
  const stops = fringe.slice(fringe.indexOf(',') + 2, -1).split(', ');
  assert.equal(stops.length, 9, 'the two stops and seven between them');
  assert.equal(stops[4], '#80808040 50%', 'the midpoint is half white, half black, a quarter opaque');
  // A change of alpha alone blends the same either way: nothing is added.
  const fade = css(linear(undefined, [{ position: 0, color: rgba(0, 0, 1, 0) }, { position: 1, color: rgba(0, 0, 1) }])) as string;
  assert.equal(fade.split(', ').length, 3);
});

test('a degenerate transform has no direction and gets no CSS', () => {
  const p = linear(t(0, 0, 0.5), [{ position: 0, color: rgba(0, 0, 0) }]);
  assert.equal(css(p), undefined);
  assert.equal(paintView(idx, { type: 'GRADIENT_RADIAL', stops: [] }, { w: 10, h: 10 })['css'], undefined);
});
