/**
 * Content and render bounds in node-local coordinates (plan §4.5).
 *
 * `contentBounds` is the ink; `renderBounds` adds the margin an effect needs. Both are memoised
 * per node AND instance scope, so a page subtree is walked once per render rather than once per
 * parent, while the same symbol node measured under two instances — which may size it
 * differently (F20) — gets two entries.
 *
 * The effect-margin rule is the initial one from the plan. Fixture `cf-effect-drop-shadow`
 * calibrates it against Figma's own export size: this is the ONE function to change, and the
 * only symptom of it being too small is a shadow cropped on one side (the `<filter>` region
 * clips its own output — Appendix E, R21).
 */
import type { CacheEntry } from '../cache.js';
import type { NodeChange } from '../fig/parse.js';
import type { TreeNode } from '../model/tree.js';
import { bool, bytes, num, obj, objArr, str } from '../model/access.js';
import { expandBox, fromFigma, transformBox, unionBox, type Box } from './matrix.js';
import { decodeCommands, pathBounds } from './path.js';
import {
  clipsChildren,
  hasFillGeometry,
  isBooleanOperation,
  isInstance,
  isVisible,
  nodeSize,
  nodeType,
  strokeAlign,
} from './node.js';

export interface Margins {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const NO_MARGIN: Margins = { left: 0, top: 0, right: 0, bottom: 0 };

/** How a tree node looks in the current context — inside an instance, merged with its records. */
export type EffectiveNode = (t: TreeNode) => NodeChange;

export class BoundsCache {
  private readonly entry: CacheEntry;
  private readonly effective: EffectiveNode;
  private readonly scope: () => string;
  private readonly content = new Map<string, Box | null>();
  private readonly render = new Map<string, Box | null>();

  /**
   * `effective` is the node as the exporter sees it right now and `scope` names the chain of
   * instances it is being drawn under. A symbol's node has one effective shape per instance
   * that expands it, so memo entries are keyed by scope and node together.
   */
  constructor(
    entry: CacheEntry,
    effective: EffectiveNode = (t) => t.node,
    scope: () => string = () => '',
  ) {
    this.entry = entry;
    this.effective = effective;
    this.scope = scope;
  }

  private key(t: TreeNode): string {
    return `${this.scope()}${t.key}`;
  }

  private blob(index: number | undefined): Uint8Array | undefined {
    if (index === undefined) return undefined;
    return bytes(this.entry.fig.blobs[index], 'bytes');
  }

  private fieldBounds(node: NodeChange, field: 'fillGeometry' | 'strokeGeometry'): Box | undefined {
    let box: Box | undefined;
    for (const path of objArr(node, field)) {
      const raw = this.blob(num(path, 'commandsBlob'));
      if (!raw || raw.length === 0) continue;
      try {
        box = unionBox(box, pathBounds(decodeCommands(raw)));
      } catch {
        // A corrupt blob must not poison the bounds; emitPaths reports it separately.
      }
    }
    return box;
  }

  /**
   * Union of the fill and stroke path bounds, in node-local coordinates.
   *
   * An INSIDE stroke's stored geometry is a double-width band straddling the edge, which the
   * exporter clips to the fill shape (F16). Counting it raw would inflate the render by the
   * stroke weight on every side — the 134x40 frame 2:1339 would export as 134x41.
   */
  private geometryBounds(node: NodeChange): Box | undefined {
    const fill = this.fieldBounds(node, 'fillGeometry');
    if (strokeAlign(node) === 'INSIDE' && hasFillGeometry(node)) return fill;
    return unionBox(fill, this.fieldBounds(node, 'strokeGeometry'));
  }

  private childrenBounds(children: readonly TreeNode[]): Box | undefined {
    let box: Box | undefined;
    for (const child of children) {
      const childNode = this.effective(child);
      if (!isVisible(childNode)) continue;
      const childBox = this.renderBounds(child);
      if (!childBox) continue;
      box = unionBox(box, transformBox(fromFigma(obj(childNode, 'transform')), childBox));
    }
    return box;
  }

  contentBounds(t: TreeNode): Box | undefined {
    const key = this.key(t);
    const memo = this.content.get(key);
    if (memo !== undefined) return memo ?? undefined;
    // Guard against a cyclic parent chain in a damaged file.
    this.content.set(key, null);

    const node = this.effective(t);
    let box: Box | undefined;
    if (nodeType(node) !== 'CANVAS') {
      const size = nodeSize(node);
      box = { x: 0, y: 0, w: size.w, h: size.h };
    }
    box = unionBox(box, this.geometryBounds(node));

    if (isInstance(node)) {
      // An instance has no children of its own (F17): its content is the symbol's, resized by
      // this instance's derived geometry. The symbol's OWN children are the wrong size — the
      // 16x16 instance 2:1340 points at a 22x22 symbol — so descending would inflate the render.
      // `size` is present on every instance in the sample and is authoritative; the cost is
      // that content deliberately overflowing a non-clipping instance can be cropped.
      // (nothing to add: the box above already is the instance)
    } else if (!clipsChildren(node) && !isBooleanOperation(node)) {
      // A clipping container bounds its own children; a boolean's children are operands (F3).
      box = unionBox(box, this.childrenBounds(t.children));
    }

    this.content.set(key, box ?? null);
    return box;
  }

  /** Per-side margin the node's visible effects need beyond its content. */
  effectMargins(t: TreeNode): Margins {
    return effectMargins(this.effective(t));
  }

  renderBounds(t: TreeNode): Box | undefined {
    const key = this.key(t);
    const memo = this.render.get(key);
    if (memo !== undefined) return memo ?? undefined;
    this.render.set(key, null);

    const content = this.contentBounds(t);
    if (!content) return undefined;
    const m = effectMargins(this.effective(t));
    const box = m === NO_MARGIN ? content : expandBox(content, m.left, m.top, m.right, m.bottom);
    this.render.set(key, box);
    return box;
  }

  /** Bounds of `t` expressed in the coordinate space of `ancestor` (excluding its transform). */
  boundsIn(t: TreeNode, ancestor: TreeNode): Box | undefined {
    let box = this.renderBounds(t);
    if (!box) return undefined;
    for (let cur: TreeNode | undefined = t; cur && cur !== ancestor; cur = cur.parent) {
      box = transformBox(fromFigma(obj(cur.node, 'transform')), box);
    }
    return box;
  }
}

/**
 * Per-side margin a node's visible effects need beyond its content.
 *
 * Pure and node-based rather than tree-based, so the exporter can size a `<filter>` from the
 * EFFECTIVE node — inside an instance the effects may come from an override (F17).
 */
export function effectMargins(node: NodeChange): Margins {
  {
    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    for (const effect of objArr(node, 'effects')) {
      if (bool(effect, 'visible') === false) continue;
      const type = str(effect, 'type');
      const radius = num(effect, 'radius') ?? 0;
      if (type === 'DROP_SHADOW') {
        const spread = num(effect, 'spread') ?? 0;
        const dx = num(obj(effect, 'offset'), 'x') ?? 0;
        const dy = num(obj(effect, 'offset'), 'y') ?? 0;
        const reach = radius + spread;
        left = Math.max(left, reach - dx);
        right = Math.max(right, reach + dx);
        top = Math.max(top, reach - dy);
        bottom = Math.max(bottom, reach + dy);
      } else if (type === 'FOREGROUND_BLUR') {
        left = Math.max(left, radius);
        right = Math.max(right, radius);
        top = Math.max(top, radius);
        bottom = Math.max(bottom, radius);
      }
      // INNER_SHADOW and BACKGROUND_BLUR stay inside the shape and add nothing.
    }
    if (left === 0 && top === 0 && right === 0 && bottom === 0) return NO_MARGIN;
    return {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.max(0, right),
      bottom: Math.max(0, bottom),
    };
  }
}
