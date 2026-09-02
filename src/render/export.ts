/**
 * The exporter (plan §4.4): a node subtree → one SVG document.
 *
 * This is the project-specific part. Everything it draws comes from geometry Figma already
 * derived at save time (F3, F5): outlined strokes, combined booleans and per-glyph outlines, so
 * no vector networks, font files or boolean solvers are involved.
 *
 * Rendering degrades, it never crashes (ground rule 6): a node that cannot be drawn is skipped
 * and recorded in the report.
 */
import type { CacheEntry } from '../cache.js';
import type { KiwiObject } from '../fig/kiwi.js';
import type { TreeNode } from '../model/tree.js';
import { bytes, num, obj, objArr, str } from '../model/access.js';
import { BoundsCache } from './bounds.js';
import { fromFigma, isIdentity, type Box } from './matrix.js';
import {
  classify,
  clipsChildren,
  isBooleanOperation,
  isVisible,
  nodeOpacity,
  nodeSize,
  nodeType,
  strokeAlign,
  hasFillGeometry,
} from './node.js';
import { decodeCommands, toPathData } from './path.js';
import { paintAttrs, paintsForStyle, type PaintEnv } from './paint.js';
import { ReportBuilder, feat } from './report.js';
import { SvgWriter, fmt, toAttr, type Attrs } from './svg.js';

export const DEFAULT_MAX_NODES = 20_000;
export const HARD_MAX_NODES = 60_000;
/** A render whose SVG exceeds this is refused rather than handed to the rasterizer. */
export const MAX_SVG_BYTES = 64 * 1024 * 1024;

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
  private readonly maxNodes: number;
  private readonly collectBoxes: boolean;
  private readonly background: string | undefined;
  private readonly boxes: NodeBox[] = [];
  /** OUTLINE masks re-render their content with every paint forced to opaque white (§4.10). */
  private whiteout = false;

  constructor(entry: CacheEntry, root: TreeNode, opts: ExportOptions) {
    this.entry = entry;
    this.root = root;
    this.bounds = new BoundsCache(entry);
    this.maxNodes = Math.min(opts.maxNodes ?? DEFAULT_MAX_NODES, HARD_MAX_NODES);
    this.collectBoxes = opts.collectBoxes === true;
    this.background = opts.background;
  }

  private blob(index: number | undefined): Uint8Array | undefined {
    if (index === undefined) return undefined;
    return bytes(this.entry.fig.blobs[index], 'bytes');
  }

  private get env(): PaintEnv {
    return { report: this.report, whiteout: this.whiteout };
  }

  private nodeBox(t: TreeNode): Box {
    const size = nodeSize(t);
    return { x: 0, y: 0, w: size.w, h: size.h };
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
    if (this.report.nodesVisited > this.maxNodes) {
      throw new Error(
        `subtree exceeds maxNodes (${this.maxNodes}); render a smaller node or raise maxNodes`,
      );
    }
    if (!isVisible(t)) return;
    const opacity = nodeOpacity(t);
    if (opacity <= 0) return;

    const type = nodeType(t);
    const cls = classify(t, isRoot);
    if (cls === 'skip') {
      this.report.unsupported(feat.nodeType(type), t.key);
      return;
    }
    this.report.seen(feat.nodeType(type));
    this.report.nodesDrawn += 1;

    const attrs: Attrs = {};
    if (!isRoot) {
      // The root is drawn in its own local space; the viewBox carries its position (Pitfall 4).
      const m = fromFigma(obj(t.node, 'transform'));
      if (!isIdentity(m)) attrs['transform'] = toAttr(m);
    }
    if (opacity < 1 && !this.whiteout) attrs['opacity'] = opacity;

    this.out.open('g', attrs);

    // Draw order inside a node (F12): own fills, then children, then own strokes.
    if (cls === 'text') {
      this.emitText(t);
    } else {
      this.emitPaths(t, 'fillGeometry', objArr(t.node, 'fillPaints'));
    }

    if (cls === 'container' && !isBooleanOperation(t)) {
      const clipId = this.clipPathFor(t);
      if (clipId) this.out.open('g', { 'clip-path': `url(#${clipId})` });
      this.emitChildren(t);
      if (clipId) this.out.close('g');
    }

    if (cls !== 'text') {
      this.emitStrokes(t);
    }

    this.out.close('g');

    if (this.collectBoxes) {
      const box = this.bounds.boundsIn(t, this.root);
      if (box) {
        this.boxes.push({ guid: t.key, type, name: str(t.node, 'name'), box });
      }
    }
  }

  private emitChildren(t: TreeNode): void {
    for (const child of t.children) this.emitNode(child, false);
  }

  /** One `<path>` per (geometry, visible paint) pair. */
  private emitPaths(t: TreeNode, field: GeometryField, paints: readonly KiwiObject[]): void {
    const geometry = objArr(t.node, field);
    if (geometry.length === 0) return;
    const box = this.nodeBox(t);
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
      const styled = paintsForStyle(t, num(path, 'styleID'), paintField);
      const list = styled ?? paints;
      for (const paint of list) {
        const attrs = paintAttrs(paint, box, this.env, t.key);
        if (!attrs) continue;
        this.out.element('path', { d, 'fill-rule': rule, ...attrs });
      }
    }
  }

  /**
   * Strokes, with the alignment clip Figma applies at render time.
   *
   * `strokeGeometry` for an INSIDE or OUTSIDE stroke is a band of DOUBLE the weight straddling
   * the shape edge; Figma keeps the half that falls inside (INSIDE) or outside (OUTSIDE) the
   * fill shape. Drawing it unclipped paints a double-width border that bleeds past the node —
   * on this sample that would be wrong on 9 055 nodes. CENTER geometry is already final.
   */
  private emitStrokes(t: TreeNode): void {
    const geometry = objArr(t.node, 'strokeGeometry');
    if (geometry.length === 0) return;
    const paints = objArr(t.node, 'strokePaints');

    const align = strokeAlign(t);
    let wrapped = false;
    if (align === 'INSIDE' && hasFillGeometry(t)) {
      this.out.open('g', { 'clip-path': `url(#${this.fillShapeClip(t)})` });
      wrapped = true;
    } else if (align === 'OUTSIDE' && hasFillGeometry(t)) {
      this.out.open('g', { mask: `url(#${this.outsideStrokeMask(t)})` });
      wrapped = true;
    } else if (align === 'OFFSET') {
      // Not present in the sample; drawn as CENTER until a fixture pins the offset down.
      this.report.approximated(feat.strokeAlign(align), t.key);
    }
    this.report.seen(feat.strokeAlign(align));
    if (str(t.node, 'dashPattern') !== undefined || (t.node['dashPattern'] as unknown[] | undefined)?.length) {
      this.report.seen('stroke-dashed');
    }

    this.emitPaths(t, 'strokeGeometry', paints);
    if (wrapped) this.out.close('g');
  }

  /** The node's fill shape as a `<clipPath>`; shared by frame clipping and INSIDE strokes. */
  private fillShapeClip(t: TreeNode): string {
    return this.out.def(`clip:${t.key}`, (id) => {
      const parts: string[] = [];
      for (const path of objArr(t.node, 'fillGeometry')) {
        const raw = this.blob(num(path, 'commandsBlob'));
        if (!raw || raw.length === 0) continue;
        try {
          const cmds = decodeCommands(raw);
          if (cmds.length === 0) continue;
          // clip-rule, NOT fill-rule: resvg ignores fill-rule inside a clipPath (Appendix E R11).
          const rule = str(path, 'windingRule') === 'ODD' ? ' clip-rule="evenodd"' : '';
          parts.push(`<path d="${toPathData(cmds)}"${rule}/>`);
        } catch {
          // reported by emitPaths for the same node
        }
      }
      if (parts.length === 0) {
        const size = nodeSize(t);
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
  private outsideStrokeMask(t: TreeNode): string {
    return this.out.def(`outside:${t.key}`, (id) => {
      const region = this.bounds.contentBounds(t) ?? this.nodeBox(t);
      const parts = [
        `<rect x="${fmt(region.x)}" y="${fmt(region.y)}" width="${fmt(region.w)}" ` +
          `height="${fmt(region.h)}" fill="#ffffff"/>`,
      ];
      for (const path of objArr(t.node, 'fillGeometry')) {
        const raw = this.blob(num(path, 'commandsBlob'));
        if (!raw || raw.length === 0) continue;
        try {
          const cmds = decodeCommands(raw);
          if (cmds.length === 0) continue;
          const rule = str(path, 'windingRule') === 'ODD' ? ' fill-rule="evenodd"' : '';
          parts.push(`<path d="${toPathData(cmds)}" fill="#000000"${rule}/>`);
        } catch {
          // reported by emitPaths for the same node
        }
      }
      return (
        `<mask id="${id}" maskUnits="userSpaceOnUse" x="${fmt(region.x)}" y="${fmt(region.y)}" ` +
        `width="${fmt(region.w)}" height="${fmt(region.h)}">${parts.join('')}</mask>`
      );
    });
  }

  /** §4.6. The clip shape is the container's own fillGeometry, which includes corner radius. */
  private clipPathFor(t: TreeNode): string | undefined {
    if (!clipsChildren(t)) return undefined;
    return this.fillShapeClip(t);
  }

  /** Implemented in R2. */
  private emitText(t: TreeNode): void {
    this.report.unsupported('text-without-outlines', t.key);
  }
}

export function exportSubtree(
  entry: CacheEntry,
  root: TreeNode,
  opts: ExportOptions = {},
): ExportResult {
  return new Exporter(entry, root, opts).run();
}
