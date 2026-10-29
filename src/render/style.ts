/**
 * Colour and effect styles (plan F19).
 *
 * A node that references a local style — `styleIdForFill`, `styleIdForStrokeFill`,
 * `styleIdForEffect` — draws the STYLE's current paints or effects, not the copy cached beside
 * the reference. Measured on the sample's card icon: Figma's export is #333333, the "Black"
 * style, while the override's cached paint says #F18D00.
 *
 * The resolution itself lives in `model/styles.ts`, shared with the inspection tools so a colour
 * never differs between the picture and the numbers; it is re-exported here for the exporter.
 * The exporter resolves colour and effect styles only: text styles change no pixel, because the
 * glyph outlines are baked (F5).
 */
import type { KiwiObject } from '../fig/kiwi.js';
import type { NodeChange } from '../fig/parse.js';
import type { FileIndex } from '../model/index.js';
import { num, obj, objArr } from '../model/access.js';
import { stylePaints } from '../model/styles.js';

export { applyStyles, styleEffects, stylePaints } from '../model/styles.js';

/**
 * §4.7.5 — a `Path.styleID`, or the run style of a glyph, selects an entry of the node's
 * `styleOverrideTable`, which carries only the fields that differ from the node's own. An entry
 * may name a colour style instead of carrying paints, so the style is followed first. Returns
 * undefined when nothing overrides the field, and the caller falls back to the node's paints.
 */
export function runPaints(
  index: FileIndex,
  node: NodeChange,
  styleID: number | undefined,
  field: 'fillPaints' | 'strokePaints',
): KiwiObject[] | undefined {
  if (!styleID) return undefined;
  const styleField = field === 'fillPaints' ? 'styleIdForFill' : 'styleIdForStrokeFill';
  const tables = [
    objArr(obj(node, 'vectorData'), 'styleOverrideTable'),
    objArr(obj(node, 'textData'), 'styleOverrideTable'),
  ];
  for (const table of tables) {
    for (const override of table) {
      if (num(override, 'styleID') !== styleID) continue;
      const styled = stylePaints(index, override[styleField]);
      if (styled) return styled;
      if (Array.isArray(override[field])) return objArr(override, field);
    }
  }
  return undefined;
}
