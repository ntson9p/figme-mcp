import test from 'node:test';
import assert from 'node:assert/strict';
import { SvgWriter, esc, fmt, toAttr } from '../../dist/render/svg.js';

test('fmt keeps 3 decimals and strips trailing zeros', () => {
  assert.equal(fmt(2), '2');
  assert.equal(fmt(2.5), '2.5');
  assert.equal(fmt(0.9), '0.9');
  assert.equal(fmt(1 / 3), '0.333');
  assert.equal(fmt(2.0005), '2.001');
  assert.equal(fmt(10), '10', 'a trailing zero before the decimal point must survive');
  assert.equal(fmt(100), '100');
  assert.equal(fmt(-1.25), '-1.25');
});

test('fmt normalises both zeros', () => {
  assert.equal(fmt(0), '0');
  assert.equal(fmt(-0), '0');
  assert.equal(fmt(-0.0001), '0');
});

test('fmt throws on NaN and Infinity (resvg would silently drop the element)', () => {
  assert.throws(() => fmt(NaN), /non-finite/);
  assert.throws(() => fmt(Infinity), /non-finite/);
  assert.throws(() => fmt(-Infinity), /non-finite/);
});

test('esc escapes the five XML-significant characters', () => {
  assert.equal(esc(`a&b<c>d"e'f`), 'a&amp;b&lt;c&gt;d&quot;e&apos;f');
});

test('toAttr writes SVG matrix order', () => {
  assert.equal(toAttr({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }), 'matrix(1 2 3 4 5 6)');
});

test('numeric attributes go through fmt and undefined attributes are omitted', () => {
  const w = new SvgWriter();
  w.element('rect', { x: 0.0004, y: 1.5, width: undefined, fill: '#fff' });
  assert.match(w.finish({ x: 0, y: 0, w: 1, h: 1 }, { width: 1, height: 1 }), /<rect x="0" y="1\.5" fill="#fff"\/>/);
});

test('string attributes are escaped', () => {
  const w = new SvgWriter();
  w.element('path', { d: 'M0,0', 'data-name': 'a "quoted" & <angled> name' });
  assert.match(w.finish({ x: 0, y: 0, w: 1, h: 1 }, { width: 1, height: 1 }), /&quot;quoted&quot; &amp; &lt;angled&gt;/);
});

test('close checks the tag stack', () => {
  const w = new SvgWriter();
  w.open('g');
  assert.throws(() => w.close('svg'), /nesting error/);
});

test('finish refuses to serialize an unbalanced document', () => {
  const w = new SvgWriter();
  w.open('g');
  assert.throws(() => w.finish({ x: 0, y: 0, w: 1, h: 1 }, { width: 1, height: 1 }), /left open/);
});

test('def registers once per key and returns a stable id', () => {
  const w = new SvgWriter();
  let builds = 0;
  const build = (id: string): string => {
    builds++;
    return `<linearGradient id="${id}"/>`;
  };
  const first = w.def('grad:x', build);
  const second = w.def('grad:x', build);
  assert.equal(first, second);
  assert.equal(builds, 1);
  const out = w.finish({ x: 0, y: 0, w: 1, h: 1 }, { width: 1, height: 1 });
  assert.equal(out.match(/<linearGradient/g)?.length, 1);
});

test('def is re-entrant: a def may register another def', () => {
  const w = new SvgWriter();
  const outer = w.def('mask', (id) => {
    const inner = w.def('clip', (cid) => `<clipPath id="${cid}"/>`);
    return `<mask id="${id}" clip-path="url(#${inner})"/>`;
  });
  const out = w.finish({ x: 0, y: 0, w: 1, h: 1 }, { width: 1, height: 1 });
  assert.equal(outer, 'p1');
  // Registration order: the outer def reserves its slot before building, so it stays first.
  // A forward id reference inside <defs> is legal SVG and resvg resolves it.
  assert.match(out, /<defs><mask id="p1" clip-path="url\(#p2\)"\/><clipPath id="p2"\/><\/defs>/);
});

test('capture redirects output and restores the buffer', () => {
  const w = new SvgWriter();
  w.element('rect', { x: 1 });
  const captured = w.capture(() => {
    w.open('g');
    w.element('path', { d: 'M0,0' });
    w.close('g');
  });
  assert.equal(captured, '<g><path d="M0,0"/></g>');
  const out = w.finish({ x: 0, y: 0, w: 1, h: 1 }, { width: 1, height: 1 });
  assert.match(out, /<rect x="1"\/><\/svg>/);
  assert.ok(!out.includes('<g>'), 'captured markup must not leak into the body');
});

test('capture rejects unbalanced content', () => {
  const w = new SvgWriter();
  assert.throws(() => w.capture(() => w.open('g')), /capture left 1 element/);
});

test('finish writes the header, viewBox, optional background and body', () => {
  const w = new SvgWriter();
  w.element('rect', { x: 0, y: 0, width: 10, height: 10, fill: '#f00' });
  const out = w.finish({ x: -2, y: -3, w: 14, h: 16 }, { width: 28, height: 32, background: '#1e1e1e' });
  assert.match(out, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" xmlns:xlink=/);
  assert.match(out, /width="28" height="32" viewBox="-2 -3 14 16"/);
  assert.match(out, /<rect x="-2" y="-3" width="14" height="16" fill="#1e1e1e"\/>/);
  assert.ok(out.endsWith('</svg>'));
});

test('nextId never repeats', () => {
  const w = new SvgWriter();
  const ids = new Set([w.nextId(), w.nextId(), w.nextId()]);
  assert.equal(ids.size, 3);
});
