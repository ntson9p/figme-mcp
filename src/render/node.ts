/**
 * Node classification and the structural predicates of plan §4.4, §4.6 and F10/F11.
 *
 * Factored out of `export.ts` because `bounds.ts` needs the same clip rule and the two modules
 * must not import each other.
 */
import type { TreeNode } from '../model/tree.js';
import { bool, num, obj, str } from '../model/access.js';

export type NodeClass = 'container' | 'shape' | 'text' | 'skip';

const CONTAINERS = new Set(['FRAME', 'SYMBOL', 'INSTANCE', 'SECTION', 'GROUP']);
const SHAPES = new Set([
  'RECTANGLE',
  'ROUNDED_RECTANGLE',
  'ELLIPSE',
  'LINE',
  'VECTOR',
  'STAR',
  'REGULAR_POLYGON',
  'BOOLEAN_OPERATION',
]);
/** Only these three ever clip their children (F10). SECTION and groups never do. */
const CLIPPERS = new Set(['FRAME', 'SYMBOL', 'INSTANCE']);

export function nodeType(t: TreeNode): string {
  return str(t.node, 'type') ?? 'UNKNOWN';
}

export function classify(t: TreeNode, isRoot: boolean): NodeClass {
  const type = nodeType(t);
  if (type === 'CANVAS') return isRoot ? 'container' : 'skip';
  if (CONTAINERS.has(type)) return 'container';
  if (SHAPES.has(type)) return 'shape';
  if (type === 'TEXT') return 'text';
  return 'skip';
}

/**
 * F10. Groups are stored as `FRAME` with `resizeToFit: true` and `frameMaskDisabled: false`,
 * so testing `frameMaskDisabled` alone would wrongly clip every group (Pitfall 1).
 */
export function clipsChildren(t: TreeNode): boolean {
  if (!CLIPPERS.has(nodeType(t))) return false;
  if (bool(t.node, 'frameMaskDisabled') === true) return false;
  if (bool(t.node, 'resizeToFit') === true) return false;
  return true;
}

/** A BOOLEAN_OPERATION carries the combined geometry; its children are operands (F3). */
export function isBooleanOperation(t: TreeNode): boolean {
  return nodeType(t) === 'BOOLEAN_OPERATION';
}

export function isMask(t: TreeNode): boolean {
  return bool(t.node, 'mask') === true;
}

/** Ground rule 8: an absent `visible` means visible. */
export function isVisible(t: TreeNode): boolean {
  return bool(t.node, 'visible') !== false;
}

export function nodeOpacity(t: TreeNode): number {
  const o = num(t.node, 'opacity');
  return o === undefined ? 1 : o;
}

export type StrokeAlign = 'CENTER' | 'INSIDE' | 'OUTSIDE' | 'OFFSET';

/**
 * Figma bakes a stroke outline of DOUBLE the weight for INSIDE and OUTSIDE alignment and clips
 * it at render time; only CENTER geometry is final. Measured across the sample: overshoot beyond
 * the node box is exactly 1.00x weight for INSIDE (8 930 nodes) and OUTSIDE (125), and 0.50x for
 * CENTER (2 737). `StrokeAlign` is `{ CENTER=0, INSIDE=1, OUTSIDE=2, OFFSET=3 }`, so an absent
 * field means CENTER — the alignment that needs no clip.
 */
export function strokeAlign(t: TreeNode): StrokeAlign {
  const raw = str(t.node, 'strokeAlign');
  return raw === 'INSIDE' || raw === 'OUTSIDE' || raw === 'OFFSET' ? raw : 'CENTER';
}

export function hasFillGeometry(t: TreeNode): boolean {
  const geometry = t.node['fillGeometry'];
  return Array.isArray(geometry) && geometry.length > 0;
}

export interface Size {
  readonly w: number;
  readonly h: number;
}

/** Node-local box size. TEXT prefers `derivedTextData.layoutSize` when it is present. */
export function nodeSize(t: TreeNode): Size {
  if (nodeType(t) === 'TEXT') {
    const layout = obj(obj(t.node, 'derivedTextData'), 'layoutSize');
    const lw = num(layout, 'x');
    const lh = num(layout, 'y');
    if (lw !== undefined && lh !== undefined) return { w: lw, h: lh };
  }
  const size = obj(t.node, 'size');
  return { w: num(size, 'x') ?? 0, h: num(size, 'y') ?? 0 };
}
