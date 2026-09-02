/**
 * The exporter (plan §4.4): a node subtree → one SVG document.
 *
 * This is the project-specific part. Everything it draws comes from geometry Figma already
 * derived at save time (F3, F5, F17): outlined strokes, combined booleans, per-glyph outlines
 * and per-instance resolved geometry — so no vector networks, font files, boolean solvers or
 * auto-layout engine are involved.
 *
 * Rendering degrades, it never crashes (ground rule 6): a node that cannot be drawn is skipped
 * and recorded in the report.
 */
import type { CacheEntry } from '../cache.js';
import type { KiwiObject } from '../fig/kiwi.js';
import type { NodeChange } from '../fig/parse.js';
import type { TreeNode } from '../model/tree.js';
import { bool, bytes, num, obj, objArr, str } from '../model/access.js';
import { BoundsCache, effectMargins } from './bounds.js';
import {
  descend,
  instanceShapeNode,
  mergeNode,
  overrideKeyOf,
  resolveInstance,
  type OverrideRecords,
} from './instance.js';
import { expandBox, fromFigma, isIdentity, transformBox, unionBox, type Box } from './matrix.js';
import {
  classify,
  clipsChildren,
  hasFillGeometry,
  isBooleanOperation,
  isInstance,
  isMask,
  isVisible,
  nodeOpacity,
  nodeSize,
  nodeType,
  strokeAlign,
} from './node.js';
import { decodeCommands, ellipseCommands, roundedRectCommands, toPathData } from './path.js';
import { paintAttrs, paintsForStyle, type PaintEnv } from './paint.js';
import { alphaToWhiteFilter, blendStyle, effectsFilter } from './effects.js';
import { ReportBuilder, feat } from './report.js';
import { buildText, hasCharactersWithoutOutlines } from './text.js';
import { SvgWriter, fmt, toAttr, type Attrs } from './svg.js';

export const DEFAULT_MAX_NODES = 20_000;
export const HARD_MAX_NODES = 60_000;
/**
 * `maxNodes` counts nodes in the TREE, which is the number a caller can see with fig_tree. The
 * traversal visits many more, because every INSTANCE expands into the symbol it points at
 * (F17) — page `0:1` is 14 912 tree nodes but walks several times that. So the runtime guard is
 * a separate, larger budget derived from `maxNodes`.
 */
export const VISIT_FACTOR = 12;
export const HARD_MAX_VISITS = 400_000;
/** A render whose SVG exceeds this is refused rather than handed to the rasterizer. */
export const MAX_SVG_BYTES = 64 * 1024 * 1024;
/** Instances nested deeper than this are almost certainly a cycle in a damaged file. */
const MAX_INSTANCE_DEPTH = 24;

/** Node types whose shape can be rebuilt from size and corner radii when geometry is absent. */
const RECTANGULAR = new Set([
  'RECTANGLE',
  'ROUNDED_RECTANGLE',
  'FRAME',
  'SYMBOL',
  'INSTANCE',
  'SECTION',
  'GROUP',
]);

/** Per-corner radii in SVG order: top-left, top-right, bottom-right, bottom-left. */
function cornerRadii(node: NodeChange): [number, number, number, number] {
  const uniform = num(node, 'cornerRadius') ?? 0;
  if (bool(node, 'rectangleCornerRadiiIndependent') !== true) {
    return [uniform, uniform, uniform, uniform];
  }
  return [
    num(node, 'rectangleTopLeftCornerRadius') ?? uniform,
    num(node, 'rectangleTopRightCornerRadius') ?? uniform,
    num(node, 'rectangleBottomRightCornerRadius') ?? uniform,
    num(node, 'rectangleBottomLeftCornerRadius') ?? uniform,
  ];
}

/** A stop that must abort the whole render rather than being isolated to one node. */
export class RenderBudgetError extends Error {}

/** Where a drawn node ended up, in root-local units — input to the tester's attribution. */
export interface NodeBox {
  readonly guid: string;
  readonly type: string;
  readonly name?: string;
  readonly box: Box;
}

export interface ExportOptions {
  readonly maxNodes?: number;
  readonly collectBoxes?: boolean;
  /** CSS colour painted behind everything; omitted for a transparent render. */
  readonly background?: string;
}

export interface ExportResult {
  readonly svg: string;
  readonly bounds: Box;
  readonly report: ReportBuilder;
  readonly boxes: NodeBox[];
}

type GeometryField = 'fillGeometry' | 'strokeGeometry';

class Exporter {
  private readonly entry: CacheEntry;
  private readonly root: TreeNode;
  private readonly out = new SvgWriter();
  private readonly report = new ReportBuilder();
  private readonly bounds: BoundsCache;
  private readonly maxVisits: number;
  private readonly collectBoxes: boolean;
  private readonly background: string | undefined;
  private readonly boxes: NodeBox[] = [];
  /** OUTLINE masks re-render their content with every paint forced to opaque white (§4.10). */
  private whiteout = false;
  /** Override records of the innermost enclosing INSTANCE, keyed by overrideKey path (F17). */
  private frame: OverrideRecords | undefined;
  /** Symbols currently being expanded, so a self-referential component cannot loop. */
  private readonly activeSymbols = new Set<string>();
  /** Distinguishes ids for the same symbol node drawn under different instances. */
  private defScope = '';

  constructor(entry: CacheEntry, root: TreeNode, opts: ExportOptions) {
    this.entry = entry;
    this.root = root;
    this.bounds = new BoundsCache(entry);
    const maxNodes = Math.min(opts.maxNodes ?? DEFAULT_MAX_NODES, HARD_MAX_NODES);
    this.maxVisits = Math.min(maxNodes * VISIT_FACTOR, HARD_MAX_VISITS);
    this.collectBoxes = opts.collectBoxes === true;
    this.background = opts.background;
  }

  private blob(index: number | undefined): Uint8Array | undefined {
    if (index === undefined) return undefined;
    return bytes(this.entry.fig.blobs[index], 'bytes');
  }

  private readonly images = new Map<string, string | null>();

  private get env(): PaintEnv {
    return {
      report: this.report,
      out: this.out,
      entry: this.entry,
      images: this.images,
      whiteout: this.whiteout,
    };
  }

  private static box(node: NodeChange): Box {
    const size = nodeSize(node);
    return { x: 0, y: 0, w: size.w, h: size.h };
  }

  /** The node as this instance sees it: the tree node merged with the active overrides (F17). */
  private effective(t: TreeNode): NodeChange {
    if (!this.frame) return t.node;
    const key = overrideKeyOf(t);
    if (!key) return t.node;
    return mergeNode(t.node, this.frame.get(key));
  }

  /** Def keys must not collide between two instances of the same symbol with different fills. */
  private defKey(kind: string, t: TreeNode): string {
    return `${kind}:${this.defScope}${t.key}`;
  }

  run(): ExportResult {
    const measured = this.bounds.renderBounds(this.root);
    // A zero-area subtree (everything hidden, or a degenerate node) still needs a legal viewBox.
    const bounds: Box = {
      x: measured?.x ?? 0,
      y: measured?.y ?? 0,
      w: Math.max(measured?.w ?? 0, 1),
      h: Math.max(measured?.h ?? 0, 1),
    };

    this.emitNode(this.root, true);

    const svg = this.out.finish(bounds, {
      width: bounds.w,
      height: bounds.h,
      background: this.background,
    });
    return { svg, bounds, report: this.report, boxes: this.boxes };
  }

  private emitNode(t: TreeNode, isRoot: boolean): void {
    this.report.nodesVisited += 1;
    if (this.report.nodesVisited > this.maxVisits) {
      throw new RenderBudgetError(
        `this render walked more than ${this.maxVisits} nodes — every instance expands into the ` +
          `component it points at, so a page costs far more than its layer count; ` +
          `render a smaller node or raise maxNodes`,
      );
    }
    const node = this.effective(t);
    if (!isVisible(node)) return;
    const opacity = nodeOpacity(node);
    if (opacity <= 0) return;

    const type = nodeType(node);
    const cls = classify(node, isRoot);
    if (cls === 'skip') {
      this.report.unsupported(feat.nodeType(type), t.key);
      return;
    }
    this.report.seen(feat.nodeType(type));
    this.report.nodesDrawn += 1;

    const attrs: Attrs = {};
    if (!isRoot) {
      // The root is drawn in its own local space; the viewBox carries its position (Pitfall 4).
      const m = fromFigma(obj(node, 'transform'));
      if (!isIdentity(m)) attrs['transform'] = toAttr(m);
    }
    // A mask's coverage is its geometry, not its appearance: no opacity, blend or effects.
    if (!this.whiteout) {
      if (opacity < 1) attrs['opacity'] = opacity;
      attrs['style'] = blendStyle(node, cls === 'container', this.report, t.key);
      attrs['filter'] = this.effectsFor(t, node);
    }

    // Ground rule 6: one node that throws must not abort the whole render. The writer is
    // unwound to the depth it had before this group, so the document stays well-formed.
    const depth = this.out.depth;
    this.out.open('g', attrs);
    try {
      if (isInstance(node)) {
        this.emitInstance(t, node);
      } else {
        this.emitOwnContent(t, node, cls, t.children);
      }
    } catch (err) {
      if (err instanceof RenderBudgetError) throw err; // a budget stop must abort everything
      this.report.unsupported('node-failed', t.key);
    } finally {
      this.out.unwindTo(depth);
    }

    if (this.collectBoxes) {
      const box = this.bounds.boundsIn(t, this.root);
      if (box) this.boxes.push({ guid: t.key, type, name: str(node, 'name'), box });
    }
  }

  /** Draw order inside a node (F12): own fills, then children, then own strokes. */
  private emitOwnContent(
    t: TreeNode,
    node: NodeChange,
    cls: 'container' | 'shape' | 'text',
    children: readonly TreeNode[],
  ): void {
    if (cls === 'text') {
      this.emitText(t, node);
    } else {
      this.emitPaths(t, node, 'fillGeometry', objArr(node, 'fillPaints'));
    }

    if (cls === 'container' && !isBooleanOperation(node)) {
      const clipId = clipsChildren(node) ? this.fillShapeClip(t, node) : undefined;
      if (clipId) this.out.open('g', { 'clip-path': `url(#${clipId})` });
      this.emitChildren(children);
      if (clipId) this.out.close('g');
    }

    if (cls !== 'text') this.emitStrokes(t, node);
  }

  /** The node's `<filter>`, sized from its own content plus the effective node's effects. */
  private effectsFor(t: TreeNode, node: NodeChange): string | undefined {
    if (objArr(node, 'effects').length === 0) return undefined;
    const content = this.bounds.contentBounds(t) ?? Exporter.box(node);
    const m = effectMargins(node);
    const region = expandBox(content, m.left, m.top, m.right, m.bottom);
    const id = effectsFilter(node, region, this.out, this.report, t.key, this.defKey('filter', t));
    return id ? `url(#${id})` : undefined;
  }

  /**
   * F11 — a child with `mask: true` masks the siblings ABOVE it (later indices) within the same
   * parent, up to the next sibling that is itself a mask, or the end of the list. The mask layer
   * is never painted as content.
   *
   * Whether a second mask really ends the first one's run could not be measured on the sample;
   * fixture `cf-mask-two-in-one-parent` decides it. This is the only line to change.
   */
  private emitChildren(children: readonly TreeNode[]): void {
    let i = 0;
    while (i < children.length) {
      const child = children[i]!;
      const childNode = this.effective(child);
      if (!isMask(childNode)) {
        this.emitNode(child, false);
        i += 1;
        continue;
      }
      if (!isVisible(childNode)) {
        // A hidden mask masks nothing in Figma, so its run is drawn unmasked.
        this.report.approximated('mask-hidden', child.key);
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < children.length && !isMask(this.effective(children[j]!))) j += 1;
      const masked = children.slice(i + 1, j);
      if (masked.length > 0) {
        const maskId = this.defineMask(child, childNode, masked);
        this.out.open('g', { mask: `url(#${maskId})` });
        for (const m of masked) this.emitNode(m, false);
        this.out.close('g');
      }
      i = j;
    }
  }

  /**
   * §4.10 — every Figma mask type becomes a luminance `<mask>`, which avoids depending on the
   * `mask-type` property. resvg computes mask luminance in sRGB and ignores
   * `color-interpolation` (Appendix E, R7/R8); the attribute is emitted anyway so browsers agree.
   */
  private defineMask(
    maskT: TreeNode,
    maskNode: NodeChange,
    masked: readonly TreeNode[],
  ): string {
    const maskType = str(maskNode, 'maskType') ?? 'ALPHA';
    this.report.seen(feat.mask(maskType));

    return this.out.def(this.defKey('mask', maskT), (id) => {
      // Never an unbounded region: the rasterizer allocates it (Pitfall 5).
      let region: Box | undefined;
      for (const node of [maskT, ...masked]) {
        const box = this.bounds.renderBounds(node);
        if (!box) continue;
        region = unionBox(
          region,
          transformBox(fromFigma(obj(this.effective(node), 'transform')), box),
        );
      }
      const r = region ?? { x: 0, y: 0, w: 1, h: 1 };

      const content = this.out.capture(() => {
        if (maskType === 'OUTLINE') {
          // Coverage is where the geometry is, whatever colour it was painted.
          const saved = this.whiteout;
          this.whiteout = true;
          try {
            this.emitNode(maskT, false);
          } finally {
            this.whiteout = saved;
          }
        } else {
          this.emitNode(maskT, false);
        }
      });

      const body =
        maskType === 'ALPHA'
          ? `<g filter="url(#${alphaToWhiteFilter(this.out)})">${content}</g>`
          : content;

      return (
        `<mask id="${id}" maskUnits="userSpaceOnUse" x="${fmt(r.x)}" y="${fmt(r.y)}" ` +
        `width="${fmt(r.w)}" height="${fmt(r.h)}" color-interpolation="sRGB">${body}</mask>`
      );
    });
  }

  /**
   * F17 — an INSTANCE has no children of its own; its content is the SYMBOL it points at, with
   * this instance's overrides and Figma's per-instance derived geometry applied.
   */
  private emitInstance(t: TreeNode, node: NodeChange): void {
    const resolved = resolveInstance(this.entry.index, t, descend(this.frame ?? new Map(), overrideKeyOf(t)));
    if (!resolved) {
      // No symbol in this file (a library component that was never published locally).
      this.report.unsupported('instance-unresolved', t.key);
      this.emitOwnContent(t, node, 'container', []);
      return;
    }
    if (this.activeSymbols.has(resolved.symbol.key) || this.activeSymbols.size >= MAX_INSTANCE_DEPTH) {
      this.report.unsupported('instance-recursive', t.key);
      return;
    }

    const savedFrame = this.frame;
    const savedScope = this.defScope;
    this.frame = resolved.records;
    this.defScope = `${this.defScope}${t.key}~`;
    this.activeSymbols.add(resolved.symbol.key);
    try {
      // The instance's own box: the symbol root with its override applied, overlaid by whatever
      // the instance itself already carries resolved.
      const shape = instanceShapeNode(t, resolved.symbol, resolved.records);
      this.emitOwnContent(t, shape, 'container', resolved.symbol.children);
    } finally {
      this.activeSymbols.delete(resolved.symbol.key);
      this.frame = savedFrame;
      this.defScope = savedScope;
    }
  }

  /** One `<path>` per (geometry, visible paint) pair. */
  private emitPaths(
    t: TreeNode,
    node: NodeChange,
    field: GeometryField,
    paints: readonly KiwiObject[],
  ): void {
    const geometry = objArr(node, field);
    if (geometry.length === 0) {
      this.emitSynthesised(t, node, field, paints);
      return;
    }
    const box = Exporter.box(node);
    const paintField = field === 'fillGeometry' ? 'fillPaints' : 'strokePaints';

    for (const path of geometry) {
      const raw = this.blob(num(path, 'commandsBlob'));
      if (!raw || raw.length === 0) continue;
      let d: string;
      try {
        const cmds = decodeCommands(raw);
        if (cmds.length === 0) continue;
        d = toPathData(cmds);
      } catch {
        this.report.unsupported('geometry:corrupt', t.key);
        continue;
      }
      // SVG's default fill-rule is nonzero, so it is only written when the winding is ODD.
      const rule = str(path, 'windingRule') === 'ODD' ? 'evenodd' : undefined;
      const styled = paintsForStyle(node, num(path, 'styleID'), paintField);
      for (const paint of styled ?? paints) {
        const attrs = paintAttrs(paint, box, this.env, t.key);
        if (!attrs) continue;
        this.out.element('path', { d, 'fill-rule': rule, ...attrs });
      }
    }
  }

  /**
   * §4.14 — this file's own nodes always carry derived geometry, but files written by other
   * tools may not. A rectangle or ellipse can be rebuilt from `size` and its corner radii;
   * anything else is reported rather than guessed at.
   */
  private emitSynthesised(
    t: TreeNode,
    node: NodeChange,
    field: GeometryField,
    paints: readonly KiwiObject[],
  ): void {
    const visible = paints.filter((p) => bool(p, 'visible') !== false);
    if (visible.length === 0) return;

    if (field === 'strokeGeometry') {
      this.report.unsupported('stroke-without-geometry', t.key);
      return;
    }

    const type = nodeType(node);
    const size = nodeSize(node);
    if (size.w <= 0 || size.h <= 0) return;

    let cmds;
    if (type === 'ELLIPSE') {
      cmds = ellipseCommands(size.w, size.h);
    } else if (RECTANGULAR.has(type)) {
      cmds = roundedRectCommands(size.w, size.h, cornerRadii(node));
    } else {
      this.report.unsupported('vector-without-geometry', t.key);
      return;
    }
    if (cmds.length === 0) return;

    this.report.approximated('geometry:synthesised', t.key);
    const d = toPathData(cmds);
    const box = Exporter.box(node);
    for (const paint of visible) {
      const attrs = paintAttrs(paint, box, this.env, t.key);
      if (attrs) this.out.element('path', { d, ...attrs });
    }
  }

  /**
   * Strokes, with the alignment clip Figma applies at render time (F16).
   *
   * `strokeGeometry` for an INSIDE or OUTSIDE stroke is a band of DOUBLE the weight straddling
   * the shape edge; Figma keeps the half that falls inside (INSIDE) or outside (OUTSIDE) the
   * fill shape. Drawing it unclipped paints a double-width border that bleeds past the node —
   * on this sample that would be wrong on 9 055 nodes. CENTER geometry is already final.
   */
  private emitStrokes(t: TreeNode, node: NodeChange): void {
    if (objArr(node, 'strokeGeometry').length === 0) return;

    const align = strokeAlign(node);
    this.report.seen(feat.strokeAlign(align));
    const dashes = node['dashPattern'];
    if (Array.isArray(dashes) && dashes.length) this.report.seen('stroke-dashed');

    let wrapped = false;
    if (align === 'INSIDE' && hasFillGeometry(node)) {
      this.out.open('g', { 'clip-path': `url(#${this.fillShapeClip(t, node)})` });
      wrapped = true;
    } else if (align === 'OUTSIDE' && hasFillGeometry(node)) {
      this.out.open('g', { mask: `url(#${this.outsideStrokeMask(t, node)})` });
      wrapped = true;
    } else if (align === 'OFFSET') {
      // Not present in the sample; drawn as CENTER until a fixture pins the offset down.
      this.report.approximated(feat.strokeAlign(align), t.key);
    }

    this.emitPaths(t, node, 'strokeGeometry', objArr(node, 'strokePaints'));
    if (wrapped) this.out.close('g');
  }

  /** The node's fill shape as a `<clipPath>`; shared by frame clipping and INSIDE strokes. */
  private fillShapeClip(t: TreeNode, node: NodeChange): string {
    return this.out.def(this.defKey('clip', t), (id) => {
      const parts = this.shapePaths(node, 'clip');
      if (parts.length === 0) {
        const size = nodeSize(node);
        parts.push(`<rect x="0" y="0" width="${fmt(size.w)}" height="${fmt(size.h)}"/>`);
      }
      return `<clipPath id="${id}" clipPathUnits="userSpaceOnUse">${parts.join('')}</clipPath>`;
    });
  }

  /**
   * The complement of the fill shape, as a luminance mask: white over the node's content box,
   * black over the shape. A mask rather than an even-odd clip path, because combining an
   * arbitrary winding rule with an enclosing rectangle is not reliably the complement.
   */
  private outsideStrokeMask(t: TreeNode, node: NodeChange): string {
    return this.out.def(this.defKey('outside', t), (id) => {
      const region = this.bounds.contentBounds(t) ?? Exporter.box(node);
      const parts = [
        `<rect x="${fmt(region.x)}" y="${fmt(region.y)}" width="${fmt(region.w)}" ` +
          `height="${fmt(region.h)}" fill="#ffffff"/>`,
        ...this.shapePaths(node, 'black'),
      ];
      return (
        `<mask id="${id}" maskUnits="userSpaceOnUse" x="${fmt(region.x)}" y="${fmt(region.y)}" ` +
        `width="${fmt(region.w)}" height="${fmt(region.h)}">${parts.join('')}</mask>`
      );
    });
  }

  /**
   * The fill geometry as `<path>` markup. `clip` emits `clip-rule`, which is what a `<clipPath>`
   * child honours — resvg silently ignores `fill-rule` there (Appendix E, R11).
   */
  private shapePaths(node: NodeChange, mode: 'clip' | 'black'): string[] {
    const parts: string[] = [];
    for (const path of objArr(node, 'fillGeometry')) {
      const raw = this.blob(num(path, 'commandsBlob'));
      if (!raw || raw.length === 0) continue;
      try {
        const cmds = decodeCommands(raw);
        if (cmds.length === 0) continue;
        const odd = str(path, 'windingRule') === 'ODD';
        const d = toPathData(cmds);
        parts.push(
          mode === 'clip'
            ? `<path d="${d}"${odd ? ' clip-rule="evenodd"' : ''}/>`
            : `<path d="${d}" fill="#000000"${odd ? ' fill-rule="evenodd"' : ''}/>`,
        );
      } catch {
        // reported by emitPaths for the same node
      }
    }
    return parts;
  }

  /**
   * §4.8 — glyph outlines and decoration rects. Glyph coordinates are baked into node-local
   * pixels here, so gradient and image fills on text go through the ordinary paint path.
   */
  private emitText(t: TreeNode, node: NodeChange): void {
    const draw = buildText(node, (i) => this.blob(i), this.report, t.key);
    if (!draw) {
      if (hasCharactersWithoutOutlines(node)) {
        this.report.unsupported('text-without-outlines', t.key);
      }
      return;
    }

    const box = Exporter.box(node);
    const own = objArr(node, 'fillPaints');
    const paintsFor = (styleID: number): readonly KiwiObject[] =>
      paintsForStyle(node, styleID, 'fillPaints') ?? own;

    for (const run of draw.glyphs) {
      for (const paint of paintsFor(run.styleID)) {
        const attrs = paintAttrs(paint, box, this.env, t.key);
        if (attrs) this.out.element('path', { d: run.d, ...attrs });
      }
    }

    if (draw.decorations.length) this.report.seen('text-decoration');
    for (const decoration of draw.decorations) {
      for (const paint of paintsFor(decoration.styleID)) {
        const attrs = paintAttrs(paint, box, this.env, t.key);
        if (!attrs) continue;
        for (const rect of decoration.rects) {
          this.out.element('rect', {
            x: rect.x,
            y: rect.y,
            width: rect.w,
            height: rect.h,
            ...attrs,
          });
        }
      }
    }

    // Text strokes are not outlined into strokeGeometry (0 such nodes in the sample).
    if (objArr(node, 'strokePaints').length > 0 && objArr(node, 'strokeGeometry').length === 0) {
      this.report.unsupported('text-stroke', t.key);
    }
  }
}

export function exportSubtree(
  entry: CacheEntry,
  root: TreeNode,
  opts: ExportOptions = {},
): ExportResult {
  return new Exporter(entry, root, opts).run();
}
