/**
 * Shared styles are the live source of the values they define (plan F19, F22).
 *
 * A node that references a local style — `styleIdForFill`, `styleIdForStrokeFill`,
 * `styleIdForEffect`, `styleIdForText` — takes the STYLE's current value. The copy cached on the
 * node beside the reference is what the node looked like when it was last touched, and it can be
 * stale (1 779 nodes and 1 064 override records in the sample disagree with their colour style)
 * or missing altogether (3 905 override records and 265 text-run entries carry only the
 * reference). Text styles behave the same way: on the iOS 16 UI Kit community file 75 text nodes
 * cache typography that disagrees with their text style, and wherever the two differ Figma's own
 * text layout (`derivedTextData`: glyph size, font, metrics) follows the STYLE — 39 of 39 font
 * sizes, 22 of 22 families, 26 of 26 weights.
 *
 * A style that is not in the file (a library style) cannot be followed, and neither can the
 * "no style" sentinel a detached override writes; both leave the cached copy in charge.
 *
 * Shared by the renderer and the inspection tools, so a colour never differs between the picture
 * and the numbers. Only `node` and `resolveAssetRef` of the index are used.
 */
import type { KiwiObject } from '../fig/kiwi.js';
import type { NodeChange } from '../fig/parse.js';
import type { FileIndex } from './index.js';
import { guidKey, type Guid, type TreeNode } from './tree.js';
import { obj, objArr, str } from './access.js';

export type StyleType = 'FILL' | 'EFFECT' | 'TEXT' | 'GRID';

type StyleIndex = Pick<FileIndex, 'node' | 'resolveAssetRef'>;

/** The guid a detached style reference is written with (plan F19). */
export const DETACHED_STYLE_GUID = '4294967295:4294967295';

/**
 * The local node defining a style reference: by publishable key for `{assetRef:{key}}`, by guid
 * for a style that was never published (`{guid}`). Undefined for a library style, for the
 * detached sentinel, and for a node of another style type than `type`.
 */
export function resolveStyle(index: StyleIndex, ref: unknown, type?: StyleType): TreeNode | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  const r = ref as KiwiObject;
  const local = guidKey(obj(r, 'guid') as Guid | undefined);
  const t = index.resolveAssetRef(r) ?? (local ? index.node(local) : undefined);
  if (!t) return undefined;
  const styleType = str(t.node, 'styleType');
  if (type ? styleType !== type : styleType === undefined) return undefined;
  return t;
}

/** The paints of a local colour style, or undefined when the reference cannot be followed. */
export function stylePaints(index: StyleIndex, ref: unknown): KiwiObject[] | undefined {
  const t = resolveStyle(index, ref, 'FILL');
  if (!t || !Array.isArray(t.node['fillPaints'])) return undefined;
  return objArr(t.node, 'fillPaints');
}

/** The effects of a local effect style, or undefined when the reference cannot be followed. */
export function styleEffects(index: StyleIndex, ref: unknown): KiwiObject[] | undefined {
  const t = resolveStyle(index, ref, 'EFFECT');
  if (!t || !Array.isArray(t.node['effects'])) return undefined;
  return objArr(t.node, 'effects');
}

/**
 * What a text style defines, in NodeChange field names (Figma's TextStyle). Alignment, auto-resize
 * and colour are not part of a text style: the style node carries them only for its own preview.
 * The first four are on every text style; the rest are written only when they differ from the
 * default, so a style without one of them means the default.
 */
const TEXT_STYLE_ALWAYS = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing'] as const;
const TEXT_STYLE_OPTIONAL = [
  'paragraphSpacing',
  'paragraphIndent',
  'listSpacing',
  'leadingTrim',
  'hangingPunctuation',
  'hangingList',
  'textCase',
  'textDecoration',
  'textDecorationStyle',
  'textDecorationSkipInk',
  'textUnderlineOffset',
  'textDecorationThickness',
] as const;

/** The local text style a reference names, or undefined when it cannot be followed. */
export function styleText(index: StyleIndex, ref: unknown): NodeChange | undefined {
  return resolveStyle(index, ref, 'TEXT')?.node;
}

export interface ApplyStylesOptions {
  /**
   * Also resolve `styleIdForText` to the text style's typography (F22). The renderer does not
   * need it — glyph outlines are baked — but every number reported about a text node does.
   */
  readonly text?: boolean;
  /**
   * The node is a PARTIAL record (an override, or a `styleOverrideTable` entry) that reports only
   * the fields it changes: a text style's defaults are then not written, since an absent field
   * there means "inherited", not "default".
   */
  readonly partial?: boolean;
}

/** The node with every style reference it carries resolved to the style's live value. */
export function applyStyles(
  index: StyleIndex,
  node: NodeChange,
  opts: ApplyStylesOptions = {},
): NodeChange {
  const fill = stylePaints(index, node['styleIdForFill']);
  const stroke = stylePaints(index, node['styleIdForStrokeFill']);
  const effects = styleEffects(index, node['styleIdForEffect']);
  const text = opts.text ? styleText(index, node['styleIdForText']) : undefined;
  if (!fill && !stroke && !effects && !text) return node;
  const out: NodeChange = { ...node };
  if (fill) out['fillPaints'] = fill;
  if (stroke) out['strokePaints'] = stroke;
  if (effects) out['effects'] = effects;
  if (text) {
    for (const field of TEXT_STYLE_ALWAYS) {
      if (text[field] !== undefined) out[field] = text[field];
    }
    for (const field of TEXT_STYLE_OPTIONAL) {
      if (text[field] !== undefined) out[field] = text[field];
      else if (!opts.partial) delete out[field];
    }
  }
  return out;
}
