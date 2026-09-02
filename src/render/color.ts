/**
 * Colour conversion for SVG output.
 *
 * Figma stores `{ r, g, b, a }` as floats 0..1. SVG wants `#rrggbb` plus a separate opacity,
 * which keeps the hex stable when only alpha differs and lets paints de-duplicate better.
 */
import type { KiwiObject } from '../fig/kiwi.js';
import type { TreeNode } from '../model/tree.js';
import { bool, num, obj } from '../model/access.js';

function channel(v: number | undefined): string {
  const n = Math.max(0, Math.min(255, Math.round((v ?? 0) * 255)));
  return n.toString(16).padStart(2, '0');
}

/** `{r,g,b}` → `#rrggbb` (lowercase; alpha is returned separately by `alphaOf`). */
export function hexOf(c: KiwiObject | undefined): string {
  return `#${channel(num(c, 'r'))}${channel(num(c, 'g'))}${channel(num(c, 'b'))}`;
}

/** Alpha 0..1; an absent `a` means opaque. */
export function alphaOf(c: KiwiObject | undefined): number {
  const a = num(c, 'a');
  return a === undefined ? 1 : Math.max(0, Math.min(1, a));
}

/** A CSS colour usable in a `fill` attribute or as resvg's `background` option. */
export function cssColor(c: KiwiObject | undefined): string {
  const a = alphaOf(c);
  if (a >= 1) return hexOf(c);
  const ch = (k: string): number => Math.max(0, Math.min(255, Math.round((num(c, k) ?? 0) * 255)));
  return `rgba(${ch('r')},${ch('g')},${ch('b')},${Math.round(a * 1000) / 1000})`;
}

/**
 * F13 — the page background. Returns undefined when the node is not a page, when the
 * background is disabled, or when it is fully transparent.
 */
export function pageBackground(t: TreeNode | undefined): string | undefined {
  for (let cur: TreeNode | undefined = t; cur; cur = cur.parent) {
    if (cur.node['type'] !== 'CANVAS') continue;
    if (bool(cur.node, 'backgroundEnabled') === false) return undefined;
    const color = obj(cur.node, 'backgroundColor');
    if (!color) return undefined;
    if (alphaOf(color) <= 0) return undefined;
    return cssColor(color);
  }
  return undefined;
}
