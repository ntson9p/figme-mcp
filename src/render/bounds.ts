/**
 * Content and render bounds in node-local coordinates (plan §4.5).
 *
 * `contentBounds` is the ink; `renderBounds` adds the margin an effect needs. Both are memoised
 * per node, so a page subtree is walked once per render rather than once per parent.
 *
 * The effect-margin rule is the initial one from the plan. Fixture `cf-effect-drop-shadow`
 * calibrates it against Figma's own export size: this is the ONE function to change, and the
 * only symptom of it being too small is a shadow cropped on one side (the `<filter>` region
 * clips its own output — Appendix E, R21).
 */
import type { CacheEntry } from '../cache.js';
import type { TreeNode } from '../model/tree.js';
import { bool, bytes, num, obj, objArr, str } from '../model/access.js';
import { expandBox, fromFigma, transformBox, unionBox, type Box } from './matrix.js';
import { decodeCommands, pathBounds } from './path.js';
import {
  clipsChildren,
  hasFillGeometry,
  isBooleanOperation,
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

export class BoundsCache {
  private readonly entry: CacheEntry;
  private readonly content = new Map<TreeNode, Box | null>();
  private readonly render = new Map<TreeNode, Box | null>();

  constructor(entry: CacheEntry) {
    this.entry = entry;
  }

  private blob(index: number | undefined): Uint8Array | undefined {
    if (index === undefined) return undefined;
    return bytes(this.entry.fig.blobs[index], 'bytes');
  }

  private fieldBounds(t: TreeNode, field: 'fillGeometry' | 'strokeGeometry'): Box | undefined {
    let box: Box | undefined;
    for (const path of objArr(t.node, field)) {
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
   * exporter clips to the fill shape (§4.4). Counting it raw would inflate the render by the
   * stroke weight on every side — the 134x40 frame 2:1339 would export as 134x41. So when the
   * node has a fill shape to clip against, the INSIDE band contributes nothing beyond it.
   */
  private geometryBounds(t: TreeNode): Box | undefined {
    const fill = this.fieldBounds(t, 'fillGeometry');
    const align = strokeAlign(t);
    if (align === 'INSIDE' && hasFillGeometry(t)) return fill;
    return unionBox(fill, this.fieldBounds(t, 'strokeGeometry'));
  }

  contentBounds(t: TreeNode): Box | undefined {
    const memo = this.content.get(t);
    if (memo !== undefined) return memo ?? undefined;
    // Guard against a cyclic parent chain in a damaged file.
    this.content.set(t, null);

    let box: Box | undefined;
    if (nodeType(t) !== 'CANVAS') {
      const size = nodeSize(t);
      box = { x: 0, y: 0, w: size.w, h: size.h };
    }
    box = unionBox(box, this.geometryBounds(t));

    // A clipping container bounds its own children; a boolean's children are operands (F3).
    if (!clipsChildren(t) && !isBooleanOperation(t)) {
      for (const child of t.children) {
        if (!isVisible(child)) continue;
        const childBox = this.renderBounds(child);
        if (!childBox) continue;
        box = unionBox(box, transformBox(fromFigma(obj(child.node, 'transform')), childBox));
      }
    }

    this.content.set(t, box ?? null);
    return box;
  }

  /** Per-side margin the node's visible effects need beyond its content. */
  effectMargins(t: TreeNode): Margins {
    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    for (const effect of objArr(t.node, 'effects')) {
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
    return { left: Math.max(0, left), top: Math.max(0, top), right: Math.max(0, right), bottom: Math.max(0, bottom) };
  }

  renderBounds(t: TreeNode): Box | undefined {
    const memo = this.render.get(t);
    if (memo !== undefined) return memo ?? undefined;
    this.render.set(t, null);

    const content = this.contentBounds(t);
    if (!content) {
      this.render.set(t, null);
      return undefined;
    }
    const m = this.effectMargins(t);
    const box = m === NO_MARGIN ? content : expandBox(content, m.left, m.top, m.right, m.bottom);
    this.render.set(t, box);
    return box;
  }

  /** Bounds of `t` expressed in the coordinate space of `ancestor` (exclusive of its transform). */
  boundsIn(t: TreeNode, ancestor: TreeNode): Box | undefined {
    let box = this.renderBounds(t);
    if (!box) return undefined;
    for (let cur: TreeNode | undefined = t; cur && cur !== ancestor; cur = cur.parent) {
      box = transformBox(fromFigma(obj(cur.node, 'transform')), box);
    }
    return box;
  }
}
