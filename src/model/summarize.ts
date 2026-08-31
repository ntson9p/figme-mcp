/**
 * Node projections at three detail levels (plan §4).
 *
 *  - `summary` — one line of JSON, safe to return 300 of.
 *  - `full`    — geometry, paints, strokes, effects, radii, auto-layout, text basics,
 *                component/variable links. Floats rounded, colors as hex, unset fields omitted.
 *  - `raw`     — the decoded NodeChange verbatim (JSON-safe). The forward-compat escape hatch:
 *                anything these mappers do not understand is still reachable.
 */
import type { NodeChange } from '../fig/parse.js';
import type { KiwiObject, KiwiValue } from '../fig/kiwi.js';
import type { FileIndex } from './index.js';
import { nodeImageHashes } from './index.js';
import { breadcrumb, guidKey, type Guid, type TreeNode } from './tree.js';
import {
  assetRefString, bool, bytes, colorHex, compact, hex, jsonSafe, num, obj, objArr, r2, str,
} from './access.js';
import { describeVariableData } from './variables.js';

export interface NodeSummary {
  guid: string;
  type: string;
  name?: string;
  /** `"134x40"` — denser than `{x,y}` and still trivially parseable. */
  size?: string;
  children?: number;
  page?: string;
}

export function summarize(t: TreeNode, opts: { page?: boolean } = {}): NodeSummary {
  const size = obj(t.node, 'size');
  const w = num(size, 'x');
  const h = num(size, 'y');
  return compact({
    guid: t.key,
    type: str(t.node, 'type') ?? 'UNKNOWN',
    name: str(t.node, 'name'),
    size: w !== undefined && h !== undefined ? `${r2(w)}x${r2(h)}` : undefined,
    children: t.children.length || undefined,
    page: opts.page && t.page ? str(t.page.node, 'name') : undefined,
  }) as NodeSummary;
}

/** `[FRAME] 134x40 "Frame 39" (2:1339) x3` — ~4x denser than the JSON summary. */
export function outlineLine(t: TreeNode, depth: number): string {
  const s = summarize(t);
  const parts = [`${'  '.repeat(depth)}[${s.type}]`];
  if (s.size) parts.push(s.size);
  parts.push(JSON.stringify(s.name ?? ''));
  parts.push(`(${s.guid})`);
  if (s.children) parts.push(`x${s.children}`);
  return parts.join(' ');
}

// --------------------------------------------------------------------------- geometry

function rotationDegrees(m: KiwiObject | undefined): number | undefined {
  const m00 = num(m, 'm00');
  const m10 = num(m, 'm10');
  if (m00 === undefined || m10 === undefined) return undefined;
  const deg = (Math.atan2(m10, m00) * 180) / Math.PI;
  return Math.abs(deg) < 0.01 ? undefined : r2(deg);
}

/** Origin of the node in its page's coordinate space (§9.3: compose transforms down the tree). */
export function absoluteOrigin(t: TreeNode): { x: number; y: number } | undefined {
  let x = 0;
  let y = 0;
  let seen = false;
  for (let cur: TreeNode | undefined = t; cur; cur = cur.parent) {
    const type = str(cur.node, 'type');
    if (type === 'CANVAS' || type === 'DOCUMENT') break;
    const m = obj(cur.node, 'transform');
    if (!m) continue;
    seen = true;
    const nx = (num(m, 'm00') ?? 1) * x + (num(m, 'm01') ?? 0) * y + (num(m, 'm02') ?? 0);
    const ny = (num(m, 'm10') ?? 0) * x + (num(m, 'm11') ?? 1) * y + (num(m, 'm12') ?? 0);
    x = nx;
    y = ny;
  }
  return seen ? { x: r2(x)!, y: r2(y)! } : undefined;
}

function geometryOf(t: TreeNode): Record<string, unknown> | undefined {
  const node = t.node;
  const size = obj(node, 'size');
  const m = obj(node, 'transform');
  const abs = absoluteOrigin(t);
  const g = compact({
    width: r2(num(size, 'x')),
    height: r2(num(size, 'y')),
    x: r2(num(m, 'm02')),
    y: r2(num(m, 'm12')),
    absoluteX: abs?.x,
    absoluteY: abs?.y,
    rotation: rotationDegrees(m),
  });
  return Object.keys(g).length ? g : undefined;
}

function cornerRadiusOf(node: NodeChange): unknown {
  const uniform = num(node, 'cornerRadius');
  if (!bool(node, 'rectangleCornerRadiiIndependent')) return r2(uniform);
  const corners = [
    num(node, 'rectangleTopLeftCornerRadius') ?? uniform ?? 0,
    num(node, 'rectangleTopRightCornerRadius') ?? uniform ?? 0,
    num(node, 'rectangleBottomRightCornerRadius') ?? uniform ?? 0,
    num(node, 'rectangleBottomLeftCornerRadius') ?? uniform ?? 0,
  ].map((v) => r2(v)!);
  return corners.every((v) => v === corners[0]) ? corners[0] : corners;
}

// --------------------------------------------------------------------------- paints & effects

export function paintView(idx: FileIndex, p: KiwiObject): Record<string, unknown> {
  const image = obj(p, 'image');
  const stops = objArr(p, 'stops').map((s) =>
    compact({ at: r2(num(s, 'position')), color: colorHex(obj(s, 'color')) }),
  );
  const w = num(p, 'originalImageWidth');
  const h = num(p, 'originalImageHeight');
  return compact({
    type: str(p, 'type'),
    color: colorHex(obj(p, 'color')),
    opacity: num(p, 'opacity') === 1 ? undefined : r2(num(p, 'opacity')),
    visible: bool(p, 'visible') === false ? false : undefined,
    blendMode: str(p, 'blendMode') === 'NORMAL' ? undefined : str(p, 'blendMode'),
    stops: stops.length ? stops : undefined,
    imageHash: hex(bytes(image, 'hash')),
    imageName: str(image, 'name'),
    imageScaleMode: str(p, 'imageScaleMode'),
    imageSize: w !== undefined && h !== undefined ? `${w}x${h}` : undefined,
    colorVar: describeVariableData(idx, obj(p, 'colorVar')),
    opacityVar: describeVariableData(idx, obj(p, 'opacityVar')),
    imageVar: describeVariableData(idx, obj(p, 'imageVar')),
  });
}

export function effectView(idx: FileIndex, e: KiwiObject): Record<string, unknown> {
  const offset = obj(e, 'offset');
  const hasOffset = offset !== undefined && (num(offset, 'x') !== 0 || num(offset, 'y') !== 0);
  return compact({
    type: str(e, 'type'),
    color: colorHex(obj(e, 'color')),
    offset: hasOffset ? { x: r2(num(offset, 'x')), y: r2(num(offset, 'y')) } : undefined,
    radius: r2(num(e, 'radius')),
    spread: num(e, 'spread') ? r2(num(e, 'spread')) : undefined,
    visible: bool(e, 'visible') === false ? false : undefined,
    blendMode: str(e, 'blendMode') === 'NORMAL' ? undefined : str(e, 'blendMode'),
    showShadowBehindNode: bool(e, 'showShadowBehindNode') || undefined,
    colorVar: describeVariableData(idx, obj(e, 'colorVar')),
    radiusVar: describeVariableData(idx, obj(e, 'radiusVar')),
  });
}

// --------------------------------------------------------------------------- auto-layout

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Figma stores the left/top pair in `stackHorizontalPadding`/`stackVerticalPadding` and only
 * writes `stackPaddingRight`/`stackPaddingBottom` when the box is asymmetric (§9.5).
 */
export function paddingOf(node: NodeChange): Padding | undefined {
  const uniform = num(node, 'stackPadding');
  const left = num(node, 'stackHorizontalPadding') ?? uniform;
  const top = num(node, 'stackVerticalPadding') ?? uniform;
  const right = num(node, 'stackPaddingRight') ?? left;
  const bottom = num(node, 'stackPaddingBottom') ?? top;
  if (left === undefined && top === undefined && right === undefined && bottom === undefined) {
    return undefined;
  }
  return {
    top: r2(top ?? 0)!,
    right: r2(right ?? 0)!,
    bottom: r2(bottom ?? 0)!,
    left: r2(left ?? 0)!,
  };
}

function autoLayoutOf(node: NodeChange): Record<string, unknown> | undefined {
  const mode = str(node, 'stackMode');
  if (!mode || mode === 'NONE') return undefined;
  return compact({
    mode,
    spacing: r2(num(node, 'stackSpacing')),
    counterSpacing: r2(num(node, 'stackCounterSpacing')),
    padding: paddingOf(node),
    primaryAlign: str(node, 'stackPrimaryAlignItems'),
    counterAlign: str(node, 'stackCounterAlignItems'),
    counterAlignContent: str(node, 'stackCounterAlignContent'),
    primarySizing: str(node, 'stackPrimarySizing'),
    width: str(node, 'stackWidth'),
    height: str(node, 'stackHeight'),
    wrap: str(node, 'stackWrap'),
    reverseZIndex: bool(node, 'stackReverseZIndex') || undefined,
  });
}

function layoutChildOf(node: NodeChange): Record<string, unknown> | undefined {
  const margin = compact({
    top: r2(num(node, 'stackChildMarginTop')),
    right: r2(num(node, 'stackChildMarginRight')),
    bottom: r2(num(node, 'stackChildMarginBottom')),
    left: r2(num(node, 'stackChildMarginLeft')),
  });
  return orUndefined(
    compact({
      grow: num(node, 'stackChildPrimaryGrow'),
      alignSelf: str(node, 'stackChildAlignSelf'),
      positioning: str(node, 'stackPositioning'),
      margin: Object.keys(margin).length ? margin : undefined,
    }),
  );
}

// --------------------------------------------------------------------------- text

/** `{value, units}` rendered compactly: `"1.5"` (RAW multiplier), `"13px"`, `"150%"`. */
export function lengthString(o: KiwiObject | undefined): string | undefined {
  if (!o) return undefined;
  const v = num(o, 'value');
  if (v === undefined) return undefined;
  switch (str(o, 'units')) {
    case 'PIXELS':
      return `${r2(v)}px`;
    case 'PERCENT':
      return `${r2(v)}%`;
    default:
      return String(r2(v));
  }
}

const CHARACTERS_PREVIEW = 400;

export function textBasics(node: NodeChange): Record<string, unknown> | undefined {
  const textData = obj(node, 'textData');
  const font = obj(node, 'fontName');
  const characters = str(textData, 'characters');
  if (!textData && !font && characters === undefined) return undefined;
  const truncated = characters !== undefined && characters.length > CHARACTERS_PREVIEW;
  const overrides = objArr(textData, 'styleOverrideTable').length;
  return orUndefined(
    compact({
      characters: truncated ? `${characters.slice(0, CHARACTERS_PREVIEW)}...` : characters,
      characterCount: truncated ? characters.length : undefined,
      charactersTruncated: truncated || undefined,
      font: font ? `${str(font, 'family') ?? ''} ${str(font, 'style') ?? ''}`.trim() : undefined,
      fontSize: r2(num(node, 'fontSize')),
      lineHeight: lengthString(obj(node, 'lineHeight')),
      letterSpacing: lengthString(obj(node, 'letterSpacing')),
      paragraphSpacing: r2(num(node, 'paragraphSpacing')),
      align: str(node, 'textAlignHorizontal'),
      verticalAlign: str(node, 'textAlignVertical'),
      textCase: str(node, 'textCase'),
      textDecoration: str(node, 'textDecoration'),
      autoResize: str(node, 'textAutoResize'),
      styleOverrides: overrides || undefined,
    }),
  );
}

// --------------------------------------------------------------------------- refs

const STYLE_REF_FIELDS: Record<string, string> = {
  styleIdForFill: 'fill',
  styleIdForStrokeFill: 'stroke',
  styleIdForText: 'text',
  styleIdForEffect: 'effect',
  styleIdForGrid: 'grid',
};

/**
 * Shared-style references.
 *
 * A style definition is stored as an ordinary (hidden) node parked on a canvas, carrying the
 * publishable `key` that `styleIdFor*.assetRef.key` points at — text styles are TEXT nodes, fill
 * styles are ROUNDED_RECTANGLE nodes. So a style used from the same file resolves to a real node
 * and, with `resolve`, to the values it defines. Styles from other libraries stay opaque refs.
 */
export function styleRefsOf(
  idx: FileIndex,
  node: NodeChange,
  opts: { resolve?: boolean } = {},
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [field, label] of Object.entries(STYLE_REF_FIELDS)) {
    const ref = obj(node, field);
    if (!ref) continue;
    const local = idx.resolveAssetRef(ref);
    const guid = guidKey(obj(ref, 'guid') as Guid | undefined);
    out[label] = compact({
      name: local ? str(local.node, 'name') : undefined,
      guid: local?.key ?? guid,
      assetRef: assetRefString(ref),
      defines: opts.resolve && local ? styleDefinition(idx, label, local.node) : undefined,
    });
  }
  return orUndefined(out);
}

/** The values a locally-defined style carries: typography for text, paints for fill/stroke. */
function styleDefinition(
  idx: FileIndex,
  label: string,
  definition: NodeChange,
): Record<string, unknown> | undefined {
  if (label === 'text') return orUndefined(typography(idx, definition));
  if (label === 'effect') {
    const effects = objArr(definition, 'effects').map((e) => effectView(idx, e));
    return effects.length ? { effects } : undefined;
  }
  const paints = objArr(definition, label === 'stroke' ? 'strokePaints' : 'fillPaints');
  const views = paints.map((p) => paintView(idx, p));
  return views.length ? { paints: views } : undefined;
}

/** Every `*Var` binding set directly on the node, plus its variable-consumption maps. */
export function variableBindingsOf(
  idx: FileIndex,
  node: NodeChange,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!key.endsWith('Var')) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
      continue;
    }
    const described = describeVariableData(idx, value as KiwiObject);
    if (described !== undefined) out[key] = described;
  }
  for (const map of ['variableConsumptionMap', 'parameterConsumptionMap'] as const) {
    for (const entry of objArr(obj(node, map), 'entries')) {
      const field = str(entry, 'variableField');
      const described = describeVariableData(idx, obj(entry, 'variableData'));
      if (field && described !== undefined) out[field] = described;
    }
  }
  return orUndefined(out);
}

function componentOf(idx: FileIndex, t: TreeNode): Record<string, unknown> | undefined {
  const node = t.node;
  const type = str(node, 'type');
  if (type === 'INSTANCE') {
    const symbolData = obj(node, 'symbolData');
    const symbolId = guidKey(obj(symbolData, 'symbolID') as Guid | undefined);
    const symbol = symbolId ? idx.node(symbolId) : undefined;
    return compact({
      role: 'INSTANCE',
      symbol: symbolId,
      symbolName: symbol ? str(symbol.node, 'name') : undefined,
      symbolInFile: symbolId !== undefined && symbol === undefined ? false : undefined,
      overrides: objArr(symbolData, 'symbolOverrides').length || undefined,
      propAssignments: objArr(node, 'componentPropAssignments').length || undefined,
    });
  }
  if (type === 'SYMBOL') {
    const propDefs = objArr(node, 'componentPropDefs');
    return compact({
      role: 'SYMBOL',
      description: str(node, 'symbolDescription'),
      key: str(node, 'componentKey'),
      propDefs: propDefs.length
        ? propDefs.map((d) => compact({ name: str(d, 'name'), type: str(d, 'type') }))
        : undefined,
      instances: idx.instanceCounts.get(t.key) ?? 0,
    });
  }
  return undefined;
}

function prototypeOf(node: NodeChange): Record<string, unknown> | undefined {
  return orUndefined(
    compact({
      startNode: guidKey(obj(node, 'prototypeStartNodeID') as Guid | undefined),
      transitionNode: guidKey(obj(node, 'transitionNodeID') as Guid | undefined),
      interactions: objArr(node, 'prototypeInteractions').length || undefined,
      backgroundColor: colorHex(obj(node, 'prototypeBackgroundColor')),
    }),
  );
}

function blobIndexes(paths: KiwiObject[]): number[] | undefined {
  const out: number[] = [];
  for (const p of paths) {
    const i = num(p, 'commandsBlob');
    if (i !== undefined) out.push(i);
  }
  return out.length ? out : undefined;
}

function vectorOf(node: NodeChange): Record<string, unknown> | undefined {
  const vectorData = obj(node, 'vectorData');
  const normalized = obj(vectorData, 'normalizedSize');
  return orUndefined(
    compact({
      networkBlob: num(vectorData, 'vectorNetworkBlob'),
      normalizedSize: normalized
        ? `${r2(num(normalized, 'x'))}x${r2(num(normalized, 'y'))}`
        : undefined,
      fillBlobs: blobIndexes(objArr(node, 'fillGeometry')),
      strokeBlobs: blobIndexes(objArr(node, 'strokeGeometry')),
    }),
  );
}

function orUndefined<T extends object>(o: T): T | undefined {
  return Object.keys(o).length ? o : undefined;
}

// --------------------------------------------------------------------------- full detail

export interface NodeDetailOptions {
  /** Include child summaries (default true at the tool boundary). */
  children?: boolean;
  maxChildren?: number;
}

export function nodeDetail(
  idx: FileIndex,
  t: TreeNode,
  opts: NodeDetailOptions = {},
): Record<string, unknown> {
  const node = t.node;
  const maxChildren = opts.maxChildren ?? 100;
  const fills = objArr(node, 'fillPaints').map((p) => paintView(idx, p));
  const strokes = objArr(node, 'strokePaints').map((p) => paintView(idx, p));
  const effects = objArr(node, 'effects').map((e) => effectView(idx, e));
  const images = nodeImageHashes(node);
  const dashPattern = node['dashPattern'];

  return compact({
    guid: t.key,
    type: str(node, 'type') ?? 'UNKNOWN',
    name: str(node, 'name'),
    page: t.page ? str(t.page.node, 'name') : undefined,
    path: breadcrumb(t) || undefined,
    parent: t.parent?.key,
    childrenCount: t.children.length || undefined,
    depth: t.depth,

    visible: bool(node, 'visible') === false ? false : undefined,
    locked: bool(node, 'locked') || undefined,
    opacity: num(node, 'opacity') === 1 ? undefined : r2(num(node, 'opacity')),
    blendMode: str(node, 'blendMode') === 'NORMAL' ? undefined : str(node, 'blendMode'),
    mask: bool(node, 'mask') || undefined,

    geometry: geometryOf(t),
    constraints: orUndefined(
      compact({
        horizontal: str(node, 'horizontalConstraint'),
        vertical: str(node, 'verticalConstraint'),
      }),
    ),
    cornerRadius: cornerRadiusOf(node),

    fills: fills.length ? fills : undefined,
    strokes: strokes.length ? strokes : undefined,
    strokeWeight: num(node, 'strokeWeight') ? r2(num(node, 'strokeWeight')) : undefined,
    strokeAlign: strokes.length ? str(node, 'strokeAlign') : undefined,
    strokeCap: str(node, 'strokeCap'),
    strokeJoin: strokes.length ? str(node, 'strokeJoin') : undefined,
    dashPattern: Array.isArray(dashPattern) && dashPattern.length
      ? (dashPattern as number[]).map((v) => r2(v))
      : undefined,
    effects: effects.length ? effects : undefined,

    autoLayout: autoLayoutOf(node),
    layout: layoutChildOf(node),
    text: textBasics(node),
    component: componentOf(idx, t),
    styles: styleRefsOf(idx, node),
    variables: variableBindingsOf(idx, node),
    prototype: prototypeOf(node),
    vector: vectorOf(node),
    images: images.length ? images : undefined,

    children:
      opts.children === false ? undefined : t.children.slice(0, maxChildren).map((c) => summarize(c)),
    childrenTruncated:
      opts.children !== false && t.children.length > maxChildren ? true : undefined,
  });
}

// --------------------------------------------------------------------------- style block

/**
 * Typography of a node — or of a partial style-override record from a text run — reporting only
 * the fields it actually sets, so a run's block shows exactly what differs from the base style.
 */
export function typography(
  idx: FileIndex,
  node: NodeChange,
  opts: { includeStyleRefs?: boolean } = {},
): Record<string, unknown> {
  const font = obj(node, 'fontName');
  const fills = objArr(node, 'fillPaints');
  const solid = fills.find((p) => str(p, 'type') === 'SOLID');
  return compact({
    font: font ? `${str(font, 'family') ?? ''} ${str(font, 'style') ?? ''}`.trim() : undefined,
    fontPostScript: str(font, 'postscript'),
    fontSize: r2(num(node, 'fontSize')),
    lineHeight: lengthString(obj(node, 'lineHeight')),
    letterSpacing: lengthString(obj(node, 'letterSpacing')),
    paragraphSpacing: r2(num(node, 'paragraphSpacing')),
    textCase: str(node, 'textCase'),
    textDecoration: str(node, 'textDecoration'),
    align: str(node, 'textAlignHorizontal'),
    verticalAlign: str(node, 'textAlignVertical'),
    color: solid ? colorHex(obj(solid, 'color')) : undefined,
    fills: fills.length && !solid ? fills.map((p) => paintView(idx, p)) : undefined,
    // Runs express most overrides as a shared-style ref, so keep them here by default; the
    // caller turns them off when it already reports the node's style refs separately.
    styles: opts.includeStyleRefs === false ? undefined : styleRefsOf(idx, node),
  });
}

// Figma's layout vocabulary in CSS terms. Figma's "primary axis" is the flex main axis and its
// "counter axis" is the cross axis, so StackJustify maps to justify-content and StackAlign /
// StackCounterAlign map to align-items / align-self.
const JUSTIFY: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_EVENLY: 'space-between',
  SPACE_BETWEEN: 'space-between',
  SPACE_AROUND: 'space-around',
  SPACE_EVENLY_CSS: 'space-evenly',
};

const ALIGN: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  STRETCH: 'stretch',
  BASELINE: 'baseline',
  AUTO: 'auto',
};

const SIZING: Record<string, string> = {
  FIXED: 'fixed',
  RESIZE_TO_FIT: 'hug',
  RESIZE_TO_FIT_WITH_IMPLICIT_SIZE: 'hug',
};

function cssPadding(p: Padding): string {
  if (p.top === p.right && p.right === p.bottom && p.bottom === p.left) return `${p.top}px`;
  if (p.top === p.bottom && p.left === p.right) return `${p.top}px ${p.right}px`;
  return `${p.top}px ${p.right}px ${p.bottom}px ${p.left}px`;
}

/**
 * The resolved, code-generation-oriented style of one node: paints as hex, radii, typography and
 * auto-layout expressed in CSS-flexbox terms. Shared-style and variable references are named
 * whenever the target is defined in this same file.
 */
export function styleBlock(idx: FileIndex, t: TreeNode): Record<string, unknown> {
  const node = t.node;
  const size = obj(node, 'size');
  const mode = str(node, 'stackMode');
  const padding = paddingOf(node);
  const layout =
    mode && mode !== 'NONE'
      ? compact({
          display: 'flex',
          direction: mode === 'VERTICAL' ? 'column' : mode === 'GRID' ? 'grid' : 'row',
          gap: r2(num(node, 'stackSpacing')),
          rowGap: r2(num(node, 'stackCounterSpacing')),
          padding: padding ? cssPadding(padding) : undefined,
          paddingBox: padding,
          justifyContent: JUSTIFY[str(node, 'stackPrimaryAlignItems') ?? ''],
          alignItems: ALIGN[str(node, 'stackCounterAlignItems') ?? ''],
          alignContent:
            str(node, 'stackCounterAlignContent') === 'SPACE_BETWEEN' ? 'space-between' : undefined,
          flexWrap: str(node, 'stackWrap') === 'WRAP' ? 'wrap' : undefined,
          primarySizing: SIZING[str(node, 'stackPrimarySizing') ?? ''],
          widthSizing: SIZING[str(node, 'stackWidth') ?? ''],
          heightSizing: SIZING[str(node, 'stackHeight') ?? ''],
        })
      : undefined;

  const inParent = orUndefined(
    compact({
      flexGrow: num(node, 'stackChildPrimaryGrow'),
      alignSelf: ALIGN[str(node, 'stackChildAlignSelf') ?? ''],
      position: str(node, 'stackPositioning') === 'ABSOLUTE' ? 'absolute' : undefined,
      margin: orUndefined(
        compact({
          top: r2(num(node, 'stackChildMarginTop')),
          right: r2(num(node, 'stackChildMarginRight')),
          bottom: r2(num(node, 'stackChildMarginBottom')),
          left: r2(num(node, 'stackChildMarginLeft')),
        }),
      ),
    }),
  );

  const fills = objArr(node, 'fillPaints').map((p) => paintView(idx, p));
  const strokes = objArr(node, 'strokePaints').map((p) => paintView(idx, p));
  const effects = objArr(node, 'effects').map((e) => effectView(idx, e));
  const type = str(node, 'type');
  const dashPattern = node['dashPattern'];

  return compact({
    guid: t.key,
    type,
    name: str(node, 'name'),
    width: r2(num(size, 'x')),
    height: r2(num(size, 'y')),
    opacity: num(node, 'opacity') === 1 ? undefined : r2(num(node, 'opacity')),
    blendMode: str(node, 'blendMode') === 'NORMAL' ? undefined : str(node, 'blendMode'),
    cornerRadius: cornerRadiusOf(node),
    fills: fills.length ? fills : undefined,
    strokes: strokes.length ? strokes : undefined,
    strokeWeight: num(node, 'strokeWeight') ? r2(num(node, 'strokeWeight')) : undefined,
    strokeAlign: strokes.length ? str(node, 'strokeAlign') : undefined,
    dashPattern: Array.isArray(dashPattern) && dashPattern.length
      ? (dashPattern as number[]).map((v) => r2(v))
      : undefined,
    effects: effects.length ? effects : undefined,
    layout,
    inParentLayout: inParent,
    typography:
      type === 'TEXT' ? orUndefined(typography(idx, node, { includeStyleRefs: false })) : undefined,
    constraints: orUndefined(
      compact({
        horizontal: str(node, 'horizontalConstraint'),
        vertical: str(node, 'verticalConstraint'),
      }),
    ),
    styles: styleRefsOf(idx, node, { resolve: true }),
    variables: variableBindingsOf(idx, node),
  });
}

/** The decoded NodeChange verbatim, JSON-safe (BigInt -> string, bytes -> hex). */
export function nodeRaw(t: TreeNode): Record<string, unknown> {
  const out: Record<string, unknown> = { guid: t.key };
  for (const [k, v] of Object.entries(t.node)) {
    if (k === 'guid') continue;
    out[k] = jsonSafe(v as KiwiValue);
  }
  return out;
}
