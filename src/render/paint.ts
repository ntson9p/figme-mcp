/**
 * Paints → SVG fill attributes (plan §4.7).
 *
 * `paintAttrs` returns the attributes to put on a `<path>`/`<rect>`, or `undefined` when the
 * paint contributes nothing (invisible, or a type we cannot draw — already reported).
 * `box` is the node-local box `{0,0,width,height}`, which is also the "normalized box" of F7.
 */
import type { KiwiObject } from '../fig/kiwi.js';
import type { NodeChange } from '../fig/parse.js';
import { bool, num, obj, objArr, str } from '../model/access.js';
import { alphaOf, hexOf } from './color.js';
import type { Box } from './matrix.js';
import type { Attrs } from './svg.js';
import { feat, type ReportBuilder } from './report.js';

export interface PaintEnv {
  readonly report: ReportBuilder;
  /** OUTLINE masks paint everything opaque white (plan §4.10). */
  readonly whiteout: boolean;
}

/** Effective alpha of a paint: `color.a × paint.opacity`. */
function paintAlpha(paint: KiwiObject): number {
  const opacity = num(paint, 'opacity');
  return alphaOf(obj(paint, 'color')) * (opacity === undefined ? 1 : opacity);
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

/**
 * Attributes for one paint, or `undefined` when it draws nothing.
 * Records the paint type in the report vocabulary either way.
 */
export function paintAttrs(
  paint: KiwiObject,
  _box: Box,
  env: PaintEnv,
  guid: string,
): Attrs | undefined {
  const type = str(paint, 'type') ?? 'SOLID';
  env.report.seen(feat.paint(type));

  if (bool(paint, 'visible') === false) return undefined;
  const opacity = num(paint, 'opacity');
  if (opacity !== undefined && opacity <= 0) return undefined;

  // An OUTLINE mask only cares where the geometry is, not what colour it is.
  if (env.whiteout) return { fill: '#ffffff' };

  if (type === 'SOLID') {
    const alpha = paintAlpha(paint);
    if (alpha <= 0) return undefined;
    return { fill: hexOf(obj(paint, 'color')), ...opacityAttr(alpha) };
  }

  env.report.unsupported(feat.paint(type), guid);
  return undefined;
}
