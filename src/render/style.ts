/**
 * Colour and effect styles (plan F19).
 *
 * A node that references a local style — `styleIdForFill`, `styleIdForStrokeFill`,
 * `styleIdForEffect` — draws the STYLE's current paints or effects. The copy cached on the node
 * beside the reference is what the node looked like when it was last touched, and it can be
 * stale (1 779 nodes and 1 064 override records in the sample disagree with their style) or
 * missing altogether (3 905 override records and 265 text-run entries carry only the reference).
 * Measured on the sample's card icon: Figma's export is #333333, the "Black" style, while the
 * override's cached paint says #F18D00.
 *
 * A style that is not in the file (a library style) cannot be followed, and neither can the
 * "no style" sentinel a detached override writes; both leave the cached copy in charge.
 */
import type { KiwiObject } from '../fig/kiwi.js';
import type { NodeChange } from '../fig/parse.js';
import type { FileIndex } from '../model/index.js';
import { guidKey, type Guid, type TreeNode } from '../model/tree.js';
import { num, obj, objArr, str } from '../model/access.js';

function styleNode(index: FileIndex, ref: unknown, styleType: 'FILL' | 'EFFECT'): TreeNode | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  const r = ref as KiwiObject;
  const local = guidKey(obj(r, 'guid') as Guid | undefined);
  const t = index.resolveAssetRef(r) ?? (local ? index.node(local) : undefined);
  return t && str(t.node, 'styleType') === styleType ? t : undefined;
}

/** The paints of a local colour style, or undefined when the reference cannot be followed. */
export function stylePaints(index: FileIndex, ref: unknown): KiwiObject[] | undefined {
  const t = styleNode(index, ref, 'FILL');
  if (!t || !Array.isArray(t.node['fillPaints'])) return undefined;
  return objArr(t.node, 'fillPaints');
}

/** The effects of a local effect style, or undefined when the reference cannot be followed. */
export function styleEffects(index: FileIndex, ref: unknown): KiwiObject[] | undefined {
  const t = styleNode(index, ref, 'EFFECT');
  if (!t || !Array.isArray(t.node['effects'])) return undefined;
  return objArr(t.node, 'effects');
}

/** The node with every style reference it carries resolved to the style's live value. */
export function applyStyles(index: FileIndex, node: NodeChange): NodeChange {
  const fill = stylePaints(index, node['styleIdForFill']);
  const stroke = stylePaints(index, node['styleIdForStrokeFill']);
  const effects = styleEffects(index, node['styleIdForEffect']);
  if (!fill && !stroke && !effects) return node;
  const out: NodeChange = { ...node };
  if (fill) out['fillPaints'] = fill;
  if (stroke) out['strokePaints'] = stroke;
  if (effects) out['effects'] = effects;
  return out;
}

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
