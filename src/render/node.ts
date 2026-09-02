/**
 * Node classification and the structural predicates of plan §4.4, §4.6 and F10/F11/F16.
 *
 * Everything here takes a raw `NodeChange` rather than a `TreeNode`, because inside an instance
 * the node being drawn is the symbol's node merged with that instance's overrides (F17) — a
 * record with no tree position of its own.
 */
import type { NodeChange } from '../fig/parse.js';
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
/** Only these ever clip their children (F10). SECTION and groups never do. */
const CLIPPERS = new Set(['FRAME', 'SYMBOL', 'INSTANCE']);

export function nodeType(node: NodeChange): string {
  return str(node, 'type') ?? 'UNKNOWN';
}

export function classify(node: NodeChange, isRoot: boolean): NodeClass {
  const type = nodeType(node);
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
export function clipsChildren(node: NodeChange): boolean {
  if (!CLIPPERS.has(nodeType(node))) return false;
  if (bool(node, 'frameMaskDisabled') === true) return false;
  if (bool(node, 'resizeToFit') === true) return false;
  return true;
}

/** A BOOLEAN_OPERATION carries the combined geometry; its children are operands (F3). */
export function isBooleanOperation(node: NodeChange): boolean {
  return nodeType(node) === 'BOOLEAN_OPERATION';
}

export function isInstance(node: NodeChange): boolean {
  return nodeType(node) === 'INSTANCE';
}

export function isMask(node: NodeChange): boolean {
  return bool(node, 'mask') === true;
}

/** Ground rule 8: an absent `visible` means visible. */
export function isVisible(node: NodeChange): boolean {
  return bool(node, 'visible') !== false;
}

export function nodeOpacity(node: NodeChange): number {
  const o = num(node, 'opacity');
  return o === undefined ? 1 : o;
}

export type StrokeAlign = 'CENTER' | 'INSIDE' | 'OUTSIDE' | 'OFFSET';

/**
 * F16 — Figma bakes a stroke outline of DOUBLE the weight for INSIDE and OUTSIDE alignment and
 * clips it at render time; only CENTER geometry is final. Measured across the sample: overshoot
 * beyond the node box is exactly 1.00x weight for INSIDE (8 930 nodes) and OUTSIDE (125), and
 * 0.50x for CENTER (2 737). `StrokeAlign` is `{ CENTER=0, INSIDE=1, OUTSIDE=2, OFFSET=3 }`, so
 * an absent field means CENTER — the alignment that needs no clip.
 */
export function strokeAlign(node: NodeChange): StrokeAlign {
  const raw = str(node, 'strokeAlign');
  return raw === 'INSIDE' || raw === 'OUTSIDE' || raw === 'OFFSET' ? raw : 'CENTER';
}

export function hasFillGeometry(node: NodeChange): boolean {
  const geometry = node['fillGeometry'];
  return Array.isArray(geometry) && geometry.length > 0;
}

export function hasGeometry(node: NodeChange): boolean {
  for (const field of ['fillGeometry', 'strokeGeometry'] as const) {
    const g = node[field];
    if (Array.isArray(g) && g.length > 0) return true;
  }
  return false;
}

export interface Size {
  readonly w: number;
  readonly h: number;
}

/** Node-local box size. TEXT prefers `derivedTextData.layoutSize` when it is present. */
export function nodeSize(node: NodeChange): Size {
  if (nodeType(node) === 'TEXT') {
    const layout = obj(obj(node, 'derivedTextData'), 'layoutSize');
    const lw = num(layout, 'x');
    const lh = num(layout, 'y');
    if (lw !== undefined && lh !== undefined) return { w: lw, h: lh };
  }
  const size = obj(node, 'size');
  return { w: num(size, 'x') ?? 0, h: num(size, 'y') ?? 0 };
}
