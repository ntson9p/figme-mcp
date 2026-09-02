/**
 * 2×3 affine transforms in SVG parameter order (plan §4.1).
 *
 * SVG writes `matrix(a b c d e f)` meaning `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 * Figma stores the same transform as `{ m00 m01 m02 / m10 m11 m12 }` with
 * `X = m00·x + m01·y + m02`, `Y = m10·x + m11·y + m12` (F1), so the mapping is
 * m00→a, m10→b, m01→c, m11→d, m02→e, m12→f.
 *
 * This module imports nothing from the rest of `render/`: `svg.ts` and `path.ts` depend on it,
 * never the other way round.
 */
import type { KiwiObject } from '../fig/kiwi.js';
import { num } from '../model/access.js';

export interface Mat {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** An axis-aligned box. Coordinate space is whatever the caller is working in. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Figma `Matrix` → SVG matrix. An absent matrix is the identity (F1 + ground rule 8). */
export function fromFigma(m: KiwiObject | undefined): Mat {
  if (!m) return IDENTITY;
  return {
    a: num(m, 'm00') ?? 1,
    b: num(m, 'm10') ?? 0,
    c: num(m, 'm01') ?? 0,
    d: num(m, 'm11') ?? 1,
    e: num(m, 'm02') ?? 0,
    f: num(m, 'm12') ?? 0,
  };
}

/** `multiply(p, q)`: apply `q` first, then `p` — the same order as SVG nesting. */
export function multiply(p: Mat, q: Mat): Mat {
  return {
    a: p.a * q.a + p.c * q.b,
    b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d,
    d: p.b * q.c + p.d * q.d,
    e: p.a * q.e + p.c * q.f + p.e,
    f: p.b * q.e + p.d * q.f + p.f,
  };
}

/** `undefined` for a singular matrix; callers fall back rather than emitting NaN. */
export function invert(m: Mat): Mat | undefined {
  const det = m.a * m.d - m.c * m.b;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

export function scale(sx: number, sy: number): Mat {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function translate(tx: number, ty: number): Mat {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

export function isIdentity(m: Mat): boolean {
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
}

/** Bounding box of the four transformed corners (a rotation grows the box, as it should). */
export function transformBox(m: Mat, b: Box): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [cx, cy] of [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ] as const) {
    const [px, py] = apply(m, cx, cy);
    xs.push(px);
    ys.push(py);
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export function unionBox(a: Box | undefined, b: Box | undefined): Box | undefined {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Grow a box by a per-side margin (left, top, right, bottom). Negative margins are ignored. */
export function expandBox(b: Box, l: number, t: number, r: number, bt: number): Box {
  const left = Math.max(0, l);
  const top = Math.max(0, t);
  return {
    x: b.x - left,
    y: b.y - top,
    w: b.w + left + Math.max(0, r),
    h: b.h + top + Math.max(0, bt),
  };
}

/** True when every component is finite — the guard before a box reaches the SVG. */
export function isFiniteBox(b: Box | undefined): b is Box {
  return (
    !!b && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h)
  );
}
