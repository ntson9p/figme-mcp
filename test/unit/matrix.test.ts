import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY,
  apply,
  expandBox,
  fromFigma,
  invert,
  isIdentity,
  multiply,
  scale,
  transformBox,
  translate,
  unionBox,
} from '../../dist/render/matrix.js';

test('fromFigma maps m00/m10/m01/m11/m02/m12 onto a/b/c/d/e/f', () => {
  assert.deepEqual(fromFigma({ m00: 1, m01: 2, m02: 3, m10: 4, m11: 5, m12: 6 }), {
    a: 1,
    b: 4,
    c: 2,
    d: 5,
    e: 3,
    f: 6,
  });
});

test('an absent or partial matrix falls back to the identity components', () => {
  assert.deepEqual(fromFigma(undefined), IDENTITY);
  assert.deepEqual(fromFigma({ m02: 10, m12: 20 }), { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 });
});

test('multiply(p, q) applies q first, then p', () => {
  const t = translate(10, 20);
  const s = scale(2, 3);
  // scale then translate: (1,1) -> (2,3) -> (12,23)
  assert.deepEqual(apply(multiply(t, s), 1, 1), [12, 23]);
  // translate then scale: (1,1) -> (11,21) -> (22,63)
  assert.deepEqual(apply(multiply(s, t), 1, 1), [22, 63]);
});

test('multiply matches a hand-computed product', () => {
  const p = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };
  const q = { a: 7, b: 8, c: 9, d: 10, e: 11, f: 12 };
  assert.deepEqual(multiply(p, q), {
    a: 1 * 7 + 3 * 8,
    b: 2 * 7 + 4 * 8,
    c: 1 * 9 + 3 * 10,
    d: 2 * 9 + 4 * 10,
    e: 1 * 11 + 3 * 12 + 5,
    f: 2 * 11 + 4 * 12 + 6,
  });
});

test('invert round-trips to the identity', () => {
  const m = { a: 2, b: 0.5, c: -1, d: 3, e: 7, f: -4 };
  const back = multiply(m, invert(m)!);
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    assert.ok(Math.abs(back[k] - IDENTITY[k]) < 1e-12, `${k} = ${back[k]}`);
  }
});

test('a singular matrix inverts to undefined instead of NaN', () => {
  assert.equal(invert({ a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 }), undefined);
  assert.equal(invert(scale(0, 0)), undefined);
});

test('isIdentity is exact', () => {
  assert.ok(isIdentity(IDENTITY));
  assert.ok(!isIdentity(translate(0, 0.0001)));
});

test('transformBox grows the box under a 90 degree rotation', () => {
  // 90° clockwise in SVG axes: (x,y) -> (-y,x)
  const rot = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
  const b = transformBox(rot, { x: 0, y: 0, w: 10, h: 4 });
  assert.deepEqual(b, { x: -4, y: 0, w: 4, h: 10 });
});

test('unionBox tolerates undefined on either side', () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 5, y: -5, w: 10, h: 10 };
  assert.deepEqual(unionBox(a, undefined), a);
  assert.deepEqual(unionBox(undefined, b), b);
  assert.deepEqual(unionBox(undefined, undefined), undefined);
  assert.deepEqual(unionBox(a, b), { x: 0, y: -5, w: 15, h: 15 });
});

test('expandBox grows per side and ignores negative margins', () => {
  const b = { x: 10, y: 10, w: 20, h: 20 };
  assert.deepEqual(expandBox(b, 1, 2, 3, 4), { x: 9, y: 8, w: 24, h: 26 });
  assert.deepEqual(expandBox(b, -5, 0, 0, 0), b);
});

test('F7: the gradient transform maps the unit box onto a vertical gradient', () => {
  // Figma's default top-to-bottom gradient, measured on the sample file.
  const T = fromFigma({ m00: 0, m01: 1, m02: 0, m10: -1, m11: 0, m12: 1 });
  const G = multiply(scale(100, 100), invert(T)!);
  const start = apply(G, 0, 0.5);
  const end = apply(G, 1, 0.5);
  assert.ok(Math.abs(start[0] - 50) < 1e-9 && Math.abs(start[1] - 0) < 1e-9, String(start));
  assert.ok(Math.abs(end[0] - 50) < 1e-9 && Math.abs(end[1] - 100) < 1e-9, String(end));
});
