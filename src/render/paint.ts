/**
 * Paints → SVG fill attributes (plan §4.7).
 *
 * `paintAttrs` returns the attributes to put on a `<path>`/`<rect>`, or `undefined` when the
 * paint contributes nothing (invisible, or a type we cannot draw — already reported).
 * `box` is the node-local box `{0,0,width,height}`, which is also the "normalized box" of F7.
 */
import type { CacheEntry } from '../cache.js';
import type { KiwiObject } from '../fig/kiwi.js';
import type { NodeChange } from '../fig/parse.js';
import { bool, bytes, hex, num, obj, objArr, str } from '../model/access.js';
import { sniffImage } from '../fig/imagemeta.js';
import { alphaOf, hexOf } from './color.js';
import { fromFigma, invert, isIdentity, multiply, scale as scaleMat, type Box, type Mat } from './matrix.js';
import { esc, fmt, toAttr, type Attrs, type SvgWriter } from './svg.js';
import { feat, type ReportBuilder } from './report.js';

export interface PaintEnv {
  readonly report: ReportBuilder;
  readonly out: SvgWriter;
  readonly entry: CacheEntry;
  /** Image hash → data URI, or null when the bytes are missing or a format we cannot embed. */
  readonly images: Map<string, string | null>;
  /** OUTLINE masks paint everything opaque white (plan §4.10). */
  readonly whiteout: boolean;
}

/** resvg decodes these; anything else is reported and drawn as nothing. */
const EMBEDDABLE = new Set(['image/png', 'image/jpeg', 'image/gif']);

function paintOpacity(paint: KiwiObject): number {
  const o = num(paint, 'opacity');
  return o === undefined ? 1 : o;
}

function opacityAttr(alpha: number): Attrs {
  return alpha >= 1 ? {} : { 'fill-opacity': alpha };
}

/**
 * §4.7.5 — a `Path.styleID` selects an entry of the node's `styleOverrideTable`, which carries
 * only the fields that differ from the node's own. Returns undefined when there is no override.
 */
export function paintsForStyle(
  node: NodeChange,
  styleID: number | undefined,
  field: 'fillPaints' | 'strokePaints',
): KiwiObject[] | undefined {
  if (!styleID) return undefined;
  const tables = [
    objArr(obj(node, 'vectorData'), 'styleOverrideTable'),
    objArr(obj(node, 'textData'), 'styleOverrideTable'),
  ];
  for (const table of tables) {
    for (const override of table) {
      if (num(override, 'styleID') !== styleID) continue;
      if (!Array.isArray(override[field])) continue;
      return objArr(override, field);
    }
  }
  return undefined;
}

// ------------------------------------------------------------------------------- gradients

interface Stop {
  readonly offset: number;
  readonly color: string;
  readonly alpha: number;
}

function stopsOf(paint: KiwiObject, opacity: number): Stop[] {
  return objArr(paint, 'stops')
    .map((s) => {
      const color = obj(s, 'color');
      return {
        offset: Math.max(0, Math.min(1, num(s, 'position') ?? 0)),
        color: hexOf(color),
        alpha: alphaOf(color) * opacity,
      };
    })
    .sort((a, b) => a.offset - b.offset);
}

function stopMarkup(stops: readonly Stop[]): string {
  return stops
    .map(
      (s) =>
        `<stop offset="${fmt(s.offset)}" stop-color="${esc(s.color)}"` +
        (s.alpha >= 1 ? '' : ` stop-opacity="${fmt(s.alpha)}"`) +
        '/>',
    )
    .join('');
}

/** Mean of the stop colours — what an unsupported gradient type is approximated with. */
function averageStop(stops: readonly Stop[]): Attrs | undefined {
  if (stops.length === 0) return undefined;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const s of stops) {
    r += parseInt(s.color.slice(1, 3), 16);
    g += parseInt(s.color.slice(3, 5), 16);
    b += parseInt(s.color.slice(5, 7), 16);
    a += s.alpha;
  }
  const n = stops.length;
  const ch = (v: number): string => Math.round(v / n).toString(16).padStart(2, '0');
  return { fill: `#${ch(r)}${ch(g)}${ch(b)}`, ...opacityAttr(a / n) };
}

function round4(m: Mat): string {
  return [m.a, m.b, m.c, m.d, m.e, m.f].map((v) => Math.round(v * 10_000) / 10_000).join(',');
}

/**
 * F7 — `paint.transform` maps the node's normalized 0..1 box TO gradient space, where a linear
 * gradient runs from (0, 0.5) to (1, 0.5) and a radial one is centred at (0.5, 0.5) with radius
 * 0.5. The exporter therefore needs the INVERSE, composed with `scale(w, h)`.
 */
function gradientAttrs(
  paint: KiwiObject,
  box: Box,
  env: PaintEnv,
  guid: string,
  type: string,
): Attrs | undefined {
  const opacity = paintOpacity(paint);
  const stops = stopsOf(paint, opacity);
  if (stops.length === 0) return undefined;

  if (type === 'GRADIENT_ANGULAR' || type === 'GRADIENT_DIAMOND') {
    // Drawn as the average colour so the shape is visible rather than missing.
    env.report.approximated(feat.paint(type), guid);
    return averageStop(stops);
  }

  const inv = invert(fromFigma(obj(paint, 'transform')));
  if (!inv) {
    env.report.approximated('gradient-singular', guid);
    const first = stops[0]!;
    return { fill: first.color, ...opacityAttr(first.alpha) };
  }
  const g = multiply(scaleMat(box.w, box.h), inv);
  const linear = type === 'GRADIENT_LINEAR';
  const key = `grad:${type}:${round4(g)}:${stops.map((s) => `${s.offset}/${s.color}/${s.alpha}`).join(',')}`;
  const id = env.out.def(key, (defId) =>
    linear
      ? `<linearGradient id="${defId}" gradientUnits="userSpaceOnUse" x1="0" y1="0.5" x2="1" y2="0.5" ` +
        `gradientTransform="${toAttr(g)}">${stopMarkup(stops)}</linearGradient>`
      : `<radialGradient id="${defId}" gradientUnits="userSpaceOnUse" cx="0.5" cy="0.5" r="0.5" ` +
        `gradientTransform="${toAttr(g)}">${stopMarkup(stops)}</radialGradient>`,
  );
  return { fill: `url(#${id})` };
}

// ---------------------------------------------------------------------------------- images

/** Image bytes: ZIP entry `images/<40-hex>`, else the blob named by `image.dataBlob` (F6). */
function imageBytes(env: PaintEnv, image: KiwiObject): Buffer | undefined {
  const hash = hex(bytes(image, 'hash'));
  if (hash) {
    const fromZip = env.entry.fig.zip?.read(`images/${hash}`);
    if (fromZip) return fromZip;
  }
  const blobIndex = num(image, 'dataBlob');
  if (blobIndex !== undefined) {
    const raw = bytes(env.entry.fig.blobs[blobIndex], 'bytes');
    if (raw) return Buffer.from(raw);
  }
  return undefined;
}

/** One data URI per distinct image, built at most once per render. */
function dataUri(env: PaintEnv, image: KiwiObject, guid: string): string | undefined {
  const hash = hex(bytes(image, 'hash')) ?? `blob:${num(image, 'dataBlob') ?? '?'}`;
  const cached = env.images.get(hash);
  if (cached !== undefined) {
    if (cached === null) return undefined;
    return cached;
  }

  const raw = imageBytes(env, image);
  if (!raw) {
    env.report.unsupported('image-missing', guid);
    env.images.set(hash, null);
    return undefined;
  }
  const meta = sniffImage(raw);
  if (!EMBEDDABLE.has(meta.mime)) {
    env.report.unsupported(feat.imageFormat(meta.mime), guid);
    env.images.set(hash, null);
    return undefined;
  }
  const uri = `data:${meta.mime};base64,${raw.toString('base64')}`;
  env.images.set(hash, uri);
  return uri;
}

function intrinsicSize(paint: KiwiObject, env: PaintEnv, image: KiwiObject): { w: number; h: number } {
  const w = num(paint, 'originalImageWidth');
  const h = num(paint, 'originalImageHeight');
  if (w && h) return { w, h };
  const raw = imageBytes(env, image);
  const meta = raw ? sniffImage(raw) : undefined;
  return { w: meta?.width ?? 1, h: meta?.height ?? 1 };
}

/**
 * §4.7.3. The four scale modes map onto `preserveAspectRatio`, so the renderer does the fitting
 * arithmetic: FILL = `slice`, FIT = `meet`, STRETCH = `none`, TILE = a pattern the size of one
 * tile. Figma's "crop" is a non-identity `paint.transform` on a STRETCH paint (the schema has no
 * separate `imageTransform` field — the plan's §4.7.3 named it wrongly).
 */
function imageAttrs(paint: KiwiObject, box: Box, env: PaintEnv, guid: string): Attrs | undefined {
  const image = obj(paint, 'image');
  if (!image) {
    env.report.unsupported('image-missing', guid);
    return undefined;
  }
  const uri = dataUri(env, image, guid);
  if (!uri) return undefined;
  if (box.w <= 0 || box.h <= 0) return undefined;

  const mode = str(paint, 'imageScaleMode') ?? 'STRETCH';
  env.report.seen(feat.imageMode(mode));
  const opacity = paintOpacity(paint);
  const rotation = num(paint, 'rotation') ?? 0;
  const tileScale = num(paint, 'scale') ?? 1;
  const transform = fromFigma(obj(paint, 'transform'));
  const intrinsic = intrinsicSize(paint, env, image);

  if (objArr(paint, 'paintFilter').length > 0 || obj(paint, 'filterColorAdjust')) {
    env.report.approximated('image-filters', guid);
  }

  // Pattern tile geometry: one tile covers the whole box except for TILE.
  let tileW = box.w;
  let tileH = box.h;
  let inner: string;

  const href = ` xlink:href="${esc(uri)}"`;
  const op = opacity >= 1 ? '' : ` opacity="${fmt(opacity)}"`;

  if (mode === 'TILE') {
    tileW = Math.max(1e-3, intrinsic.w * tileScale);
    tileH = Math.max(1e-3, intrinsic.h * tileScale);
    inner = `<image width="${fmt(tileW)}" height="${fmt(tileH)}" preserveAspectRatio="none"${op}${href}/>`;
  } else if (mode === 'FILL') {
    inner = `<image width="${fmt(box.w)}" height="${fmt(box.h)}" preserveAspectRatio="xMidYMid slice"${op}${href}/>`;
  } else if (mode === 'FIT') {
    inner = `<image width="${fmt(box.w)}" height="${fmt(box.h)}" preserveAspectRatio="xMidYMid meet"${op}${href}/>`;
  } else if (isIdentity(transform)) {
    inner = `<image width="${fmt(box.w)}" height="${fmt(box.h)}" preserveAspectRatio="none"${op}${href}/>`;
  } else {
    // Figma "crop". Candidate A of §4.7.3; fixture cf-image-crop decides between A and B.
    const inv = invert(transform);
    if (!inv) {
      inner = `<image width="${fmt(box.w)}" height="${fmt(box.h)}" preserveAspectRatio="none"${op}${href}/>`;
    } else {
      env.report.approximated('image-crop', guid);
      const m = multiply(
        multiply(scaleMat(box.w, box.h), inv),
        scaleMat(1 / intrinsic.w, 1 / intrinsic.h),
      );
      inner =
        `<image width="${fmt(intrinsic.w)}" height="${fmt(intrinsic.h)}" preserveAspectRatio="none"` +
        `${op} transform="${toAttr(m)}"${href}/>`;
    }
  }

  if (rotation !== 0) {
    // Multiples of 90 swap the tile's aspect; anything else is an approximation either way.
    env.report.approximated('image-rotation', guid);
    inner =
      `<g transform="translate(${fmt(tileW / 2)} ${fmt(tileH / 2)}) rotate(${fmt(rotation)}) ` +
      `translate(${fmt(-tileW / 2)} ${fmt(-tileH / 2)})">${inner}</g>`;
  }

  const hash = hex(bytes(image, 'hash')) ?? 'blob';
  const key = `img:${hash}:${mode}:${fmt(tileW)}x${fmt(tileH)}:${fmt(box.w)}x${fmt(box.h)}:${fmt(rotation)}:${fmt(opacity)}:${round4(transform)}`;
  const id = env.out.def(
    key,
    (defId) =>
      `<pattern id="${defId}" patternUnits="userSpaceOnUse" x="0" y="0" ` +
      `width="${fmt(tileW)}" height="${fmt(tileH)}">${inner}</pattern>`,
  );
  return { fill: `url(#${id})` };
}

// ----------------------------------------------------------------------------------- entry

/**
 * Attributes for one paint, or `undefined` when it draws nothing.
 * Records the paint type in the report vocabulary either way.
 */
export function paintAttrs(
  paint: KiwiObject,
  box: Box,
  env: PaintEnv,
  guid: string,
): Attrs | undefined {
  const type = str(paint, 'type') ?? 'SOLID';
  env.report.seen(feat.paint(type));

  if (bool(paint, 'visible') === false) return undefined;
  const opacity = paintOpacity(paint);
  if (opacity <= 0) return undefined;

  // An OUTLINE mask only cares where the geometry is, not what colour it is.
  if (env.whiteout) return { fill: '#ffffff' };

  const attrs = paintFill(paint, box, env, guid, type);
  if (!attrs) return undefined;

  // §4.11 — a paint may carry its own blend mode, which lands on the element it paints.
  const blend = paintBlendStyle(paint, env, guid);
  return blend ? { ...attrs, style: blend } : attrs;
}

/** Paint-level `blendMode`, mapped the same way as the node-level one. */
function paintBlendStyle(paint: KiwiObject, env: PaintEnv, guid: string): string | undefined {
  const mode = str(paint, 'blendMode') ?? 'NORMAL';
  if (mode === 'NORMAL' || mode === 'PASS_THROUGH') return undefined;
  env.report.seen(feat.blend(mode));
  const exact = PAINT_BLEND_CSS[mode];
  if (exact) return `mix-blend-mode:${exact}`;
  const near = PAINT_BLEND_APPROXIMATE[mode];
  if (near) {
    env.report.approximated(feat.blend(mode), guid);
    return `mix-blend-mode:${near}`;
  }
  env.report.unsupported(feat.blend(mode), guid);
  return undefined;
}

const PAINT_BLEND_CSS: Record<string, string> = {
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  COLOR_BURN: 'color-burn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  COLOR_DODGE: 'color-dodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light',
  HARD_LIGHT: 'hard-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

const PAINT_BLEND_APPROXIMATE: Record<string, string> = {
  LINEAR_DODGE: 'screen',
  LINEAR_BURN: 'multiply',
};

function paintFill(
  paint: KiwiObject,
  box: Box,
  env: PaintEnv,
  guid: string,
  type: string,
): Attrs | undefined {
  const opacity = paintOpacity(paint);
  switch (type) {
    case 'SOLID': {
      const alpha = alphaOf(obj(paint, 'color')) * opacity;
      if (alpha <= 0) return undefined;
      return { fill: hexOf(obj(paint, 'color')), ...opacityAttr(alpha) };
    }
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND':
      return gradientAttrs(paint, box, env, guid, type);
    case 'IMAGE':
      return imageAttrs(paint, box, env, guid);
    case 'VIDEO': {
      // Draw the poster frame when the file kept one; otherwise nothing.
      env.report.approximated(feat.paint(type), guid);
      const poster = obj(paint, 'imageThumbnail') ?? obj(paint, 'image');
      if (!poster) return undefined;
      return imageAttrs({ ...paint, image: poster, imageScaleMode: 'FILL' }, box, env, guid);
    }
    default:
      env.report.unsupported(feat.paint(type), guid);
      return undefined;
  }
}
