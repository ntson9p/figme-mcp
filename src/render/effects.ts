/**
 * Effects → one `<filter>` per node (plan §4.9).
 *
 * The primitive chains below are the ones Figma's own SVG export emits, which is why they are
 * written out literally rather than invented: resvg and Chromium both render them identically,
 * and it means a geometry comparison against a Figma SVG compares like with like. Every
 * primitive used here is verified in Appendix E (R19, R20).
 *
 * Figma's blur `radius` is a Gaussian `stdDeviation = radius / 2`.
 */
import type { NodeChange } from '../fig/parse.js';
import type { KiwiObject } from '../fig/kiwi.js';
import { bool, num, obj, objArr, str } from '../model/access.js';
import { alphaOf } from './color.js';
import type { Box } from './matrix.js';
import { fmt, type SvgWriter } from './svg.js';
import { feat, type ReportBuilder } from './report.js';

/** Effects that produce filter primitives rather than only a report entry. */
const DRAWN = new Set(['DROP_SHADOW', 'INNER_SHADOW', 'FOREGROUND_BLUR']);

function visibleEffects(node: NodeChange): KiwiObject[] {
  return objArr(node, 'effects').filter((e) => bool(e, 'visible') !== false);
}

function channels(effect: KiwiObject): { r: number; g: number; b: number; a: number } {
  const color = obj(effect, 'color');
  return {
    r: num(color, 'r') ?? 0,
    g: num(color, 'g') ?? 0,
    b: num(color, 'b') ?? 0,
    a: alphaOf(color),
  };
}

function colorMatrix(input: string, effect: KiwiObject, result: string): string {
  const c = channels(effect);
  return (
    `<feColorMatrix in="${input}" type="matrix" values="0 0 0 0 ${fmt(c.r)} 0 0 0 0 ${fmt(c.g)} ` +
    `0 0 0 0 ${fmt(c.b)} 0 0 0 ${fmt(c.a)} 0" result="${result}"/>`
  );
}

/** Any non-zero alpha becomes a hard silhouette; 127 is what Figma's own export uses. */
function silhouette(result: string): string {
  return (
    `<feColorMatrix in="SourceAlpha" type="matrix" ` +
    `values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="${result}"/>`
  );
}

/**
 * Registers the node's filter and returns its id, or `undefined` when nothing needs one.
 * `region` is the node's render bounds in node-local units — the filter clips its own output to
 * it, so a region that is too small crops the shadow rather than moving it (Appendix E, R21).
 */
export function effectsFilter(
  node: NodeChange,
  region: Box,
  out: SvgWriter,
  report: ReportBuilder,
  guid: string,
  defKey: string,
): string | undefined {
  const effects = visibleEffects(node);
  if (effects.length === 0) return undefined;

  const drawn: KiwiObject[] = [];
  for (const effect of effects) {
    const type = str(effect, 'type') ?? 'DROP_SHADOW';
    report.seen(feat.effect(type));
    if (DRAWN.has(type)) {
      drawn.push(effect);
    } else if (type === 'BACKGROUND_BLUR') {
      // A backdrop blur needs what is *behind* the node, which an isolated SVG filter cannot
      // reach. The fill is drawn flat instead.
      report.approximated(feat.effect(type), guid);
    } else {
      report.unsupported(feat.effect(type), guid);
    }
  }
  if (drawn.length === 0) return undefined;

  const parts: string[] = [];
  let prev = 'bg';
  parts.push('<feFlood flood-opacity="0" result="bg"/>');

  // Drop shadows first, underneath the shape, in array order (the first is the lowest).
  let k = 0;
  for (const effect of drawn) {
    if (str(effect, 'type') !== 'DROP_SHADOW') continue;
    const radius = num(effect, 'radius') ?? 0;
    const spread = num(effect, 'spread') ?? 0;
    const dx = num(obj(effect, 'offset'), 'x') ?? 0;
    const dy = num(obj(effect, 'offset'), 'y') ?? 0;
    const sigma = radius / 2;

    const alpha = `ha${k}`;
    parts.push(silhouette(alpha));
    let cur = alpha;
    if (spread > 0) {
      parts.push(`<feMorphology in="${cur}" operator="dilate" radius="${fmt(spread)}" result="sp${k}"/>`);
      cur = `sp${k}`;
    } else if (spread < 0) {
      parts.push(`<feMorphology in="${cur}" operator="erode" radius="${fmt(-spread)}" result="sp${k}"/>`);
      cur = `sp${k}`;
    }
    parts.push(`<feOffset in="${cur}" dx="${fmt(dx)}" dy="${fmt(dy)}" result="of${k}"/>`);
    cur = `of${k}`;
    if (sigma > 0) {
      parts.push(`<feGaussianBlur in="${cur}" stdDeviation="${fmt(sigma)}" result="bl${k}"/>`);
      cur = `bl${k}`;
    }
    if (bool(effect, 'showShadowBehindNode') !== true) {
      // "Do not show the shadow behind the node": knock the silhouette back out of the blur.
      parts.push(`<feComposite in="${cur}" in2="${alpha}" operator="out" result="ko${k}"/>`);
      cur = `ko${k}`;
    }
    parts.push(colorMatrix(cur, effect, `co${k}`));
    parts.push(`<feBlend in="co${k}" in2="${prev}" mode="normal" result="ds${k}"/>`);
    prev = `ds${k}`;
    k++;
  }

  parts.push(`<feBlend in="SourceGraphic" in2="${prev}" mode="normal" result="shape"/>`);
  prev = 'shape';

  for (const effect of drawn) {
    if (str(effect, 'type') !== 'INNER_SHADOW') continue;
    const radius = num(effect, 'radius') ?? 0;
    const spread = num(effect, 'spread') ?? 0;
    const dx = num(obj(effect, 'offset'), 'x') ?? 0;
    const dy = num(obj(effect, 'offset'), 'y') ?? 0;
    const sigma = radius / 2;

    const alpha = `ia${k}`;
    parts.push(silhouette(alpha));
    let cur = alpha;
    if (spread > 0) {
      parts.push(`<feMorphology in="${cur}" operator="erode" radius="${fmt(spread)}" result="isp${k}"/>`);
      cur = `isp${k}`;
    }
    parts.push(`<feOffset in="${cur}" dx="${fmt(dx)}" dy="${fmt(dy)}" result="io${k}"/>`);
    cur = `io${k}`;
    if (sigma > 0) {
      parts.push(`<feGaussianBlur in="${cur}" stdDeviation="${fmt(sigma)}" result="ib${k}"/>`);
      cur = `ib${k}`;
    }
    // silhouette minus the offset, blurred silhouette = the band just inside the edge.
    parts.push(
      `<feComposite in="${cur}" in2="${alpha}" operator="arithmetic" k2="-1" k3="1" result="ii${k}"/>`,
    );
    parts.push(colorMatrix(`ii${k}`, effect, `ic${k}`));
    parts.push(`<feBlend in="ic${k}" in2="${prev}" mode="normal" result="is${k}"/>`);
    prev = `is${k}`;
    k++;
  }

  const blur = drawn.find((e) => str(e, 'type') === 'FOREGROUND_BLUR');
  if (blur) {
    const sigma = (num(blur, 'radius') ?? 0) / 2;
    if (sigma > 0) parts.push(`<feGaussianBlur in="${prev}" stdDeviation="${fmt(sigma)}"/>`);
  }

  return out.def(defKey, (id) => {
    return (
      `<filter id="${id}" filterUnits="userSpaceOnUse" x="${fmt(region.x)}" y="${fmt(region.y)}" ` +
      `width="${fmt(region.w)}" height="${fmt(region.h)}" color-interpolation-filters="sRGB">` +
      `${parts.join('')}</filter>`
    );
  });
}

/**
 * The filter that turns any coverage into white-with-the-same-alpha, so a luminance `<mask>`
 * reproduces Figma's ALPHA mask exactly (Appendix E, R9). Registered once per document.
 */
export function alphaToWhiteFilter(out: SvgWriter): string {
  return out.def(
    'filter:alpha-to-white',
    (id) =>
      `<filter id="${id}"><feColorMatrix type="matrix" ` +
      `values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"/></filter>`,
  );
}

// ------------------------------------------------------------------------------ blend modes

/** Figma blend mode → CSS `mix-blend-mode`. Only the two Figma-only modes are approximated. */
const BLEND_CSS: Record<string, string> = {
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

/** CSS has no linear-dodge / linear-burn; screen and multiply are the closest siblings. */
const BLEND_APPROXIMATE: Record<string, string> = {
  LINEAR_DODGE: 'screen',
  LINEAR_BURN: 'multiply',
};

/**
 * §4.11 — the `style` attribute for a node's group, or `undefined` when nothing is needed.
 *
 * PASS_THROUGH (the default) lets children composite with what is behind the group; NORMAL makes
 * the group composite as a unit, which is what `isolation: isolate` expresses. Both are verified
 * to work in resvg (Appendix E, R16 and R17).
 */
export function blendStyle(
  node: NodeChange,
  isContainer: boolean,
  report: ReportBuilder,
  guid: string,
): string | undefined {
  const mode = str(node, 'blendMode') ?? 'PASS_THROUGH';
  if (mode !== 'PASS_THROUGH') report.seen(feat.blend(mode));

  if (mode === 'PASS_THROUGH') return undefined;
  if (mode === 'NORMAL') return isContainer ? 'isolation:isolate' : undefined;

  const exact = BLEND_CSS[mode];
  if (exact) {
    return isContainer ? `mix-blend-mode:${exact};isolation:isolate` : `mix-blend-mode:${exact}`;
  }
  const near = BLEND_APPROXIMATE[mode];
  if (near) {
    report.approximated(feat.blend(mode), guid);
    return isContainer ? `mix-blend-mode:${near};isolation:isolate` : `mix-blend-mode:${near}`;
  }
  report.unsupported(feat.blend(mode), guid);
  return undefined;
}
