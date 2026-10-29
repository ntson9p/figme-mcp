/**
 * Components (SYMBOL) and instances (fig-reading-solution.md §9.7).
 *
 * Two addressing quirks matter here and are not obvious from the schema:
 *   1. `symbolData.symbolOverrides[].guidPath.guids` addresses descendants of the component by
 *      their override identity — `overrideKey` when present, else guid — one segment per
 *      instance-nesting level. See `overrideIdentity` and `resolveOverridePath` (model/instance).
 *   2. A variant member SYMBOL repeats its component-set's property ids with no name; the named
 *      definitions live on the component set (a FRAME with `isStateGroup`).
 */
import type { NodeChange } from '../fig/parse.js';
import type { KiwiObject } from '../fig/kiwi.js';
import type { FileIndex } from './index.js';
import { guidKey, breadcrumb, type Guid, type TreeNode } from './tree.js';
import { resolveOverridePath } from './instance.js';
import { bool, colorHex, compact, jsonSafe, num, obj, objArr, r2, str } from './access.js';
import {
  cornerRadiusOf, effectView, paintView, sideWeights, styleRefsOf, textBasics,
} from './summarize.js';
import { describeVariableData } from './variables.js';
import { applyStyles } from './styles.js';

/** Fields present on every override/derived record that are addressing, not content. */
const OVERRIDE_META = new Set(['guidPath', 'overrideLevel', 'guid', 'phase', 'parentIndex']);

export interface ComponentView {
  guid: string;
  name?: string;
  description?: string;
  key?: string;
  page?: string;
  path?: string;
  size?: string;
  /** Name of the component set when this SYMBOL is one of its variants. */
  variantOf?: string;
  variantOfGuid?: string;
  propDefs?: { name?: string; type?: string; default?: unknown }[];
  instances: number;
}

function componentPropValue(idx: FileIndex, value: KiwiObject | undefined): unknown {
  if (!value) return undefined;
  const text = obj(value, 'textValue');
  if (text) return str(text, 'characters');
  const b = bool(value, 'boolValue');
  if (b !== undefined) return b;
  const f = num(value, 'floatValue');
  if (f !== undefined) return r2(f);
  const guid = guidKey(obj(value, 'guidValue') as Guid | undefined);
  if (guid) {
    const target = idx.node(guid);
    return target ? { guid, name: str(target.node, 'name') } : { guid };
  }
  const color = obj(value, 'colorValue');
  if (color) return colorHex(color);
  const keys = Object.keys(value);
  return keys.length ? { [keys[0]!]: jsonSafe(value[keys[0]!]) } : undefined;
}

/** Component-property assignments with the property names resolved. */
function propAssignmentViews(idx: FileIndex, assignments: readonly KiwiObject[]): Record<string, unknown>[] {
  return assignments.map((a) => {
    const defID = guidKey(obj(a, 'defID') as Guid | undefined) ?? '?';
    const def = idx.propDefs().get(defID);
    const value = componentPropValue(idx, obj(a, 'value'));
    return compact({
      defID,
      name: def?.name,
      type: def?.type,
      value: value ?? describeVariableData(idx, obj(a, 'varValue')),
    });
  });
}

export function componentView(idx: FileIndex, t: TreeNode): ComponentView {
  const node = t.node;
  const size = obj(node, 'size');
  const parent = t.parent;
  const isVariant = parent !== undefined && bool(parent.node, 'isStateGroup') === true;
  const propDefs = objArr(node, 'componentPropDefs')
    .concat(isVariant ? objArr(parent.node, 'componentPropDefs') : [])
    .map((d) => {
      const id = guidKey(obj(d, 'id') as Guid | undefined);
      const resolved = id ? idx.propDefs().get(id) : undefined;
      return compact({
        name: str(d, 'name') ?? resolved?.name,
        type: str(d, 'type') ?? resolved?.type,
        default: componentPropValue(idx, obj(d, 'initialValue')),
      });
    })
    .filter((d) => d.name !== undefined);

  const w = num(size, 'x');
  const h = num(size, 'y');
  return compact({
    guid: t.key,
    name: str(node, 'name'),
    description: str(node, 'symbolDescription'),
    key: str(node, 'componentKey') ?? str(node, 'key'),
    page: t.page ? str(t.page.node, 'name') : undefined,
    path: breadcrumb(t) || undefined,
    size: w !== undefined && h !== undefined ? `${r2(w)}x${r2(h)}` : undefined,
    variantOf: isVariant ? str(parent.node, 'name') : undefined,
    variantOfGuid: isVariant ? parent.key : undefined,
    propDefs: propDefs.length ? propDefs : undefined,
    instances: idx.instanceCounts.get(t.key) ?? 0,
  }) as ComponentView;
}

export interface OverrideView {
  /** overrideKey path from the component root down to the overridden descendant. */
  path: string[];
  targetGuid?: string;
  targetName?: string;
  targetType?: string;
  fields: Record<string, unknown>;
  /** Field names present in the record that this mapper did not translate. */
  otherFields?: string[];
  /** Applied by an enclosing instance to this nested one, rather than by this instance. */
  inherited?: boolean;
}

/** Map one partial NodeChange (an override or a derived record) to a compact field set. */
export function overrideFields(idx: FileIndex, partial: NodeChange): {
  fields: Record<string, unknown>;
  otherFields: string[];
} {
  // A record that names a style shows the style's live value, not the copy cached beside the
  // reference — or the nothing there when the record carries only the reference (F19, F22).
  const live = applyStyles(idx, partial, { text: true, partial: true });
  const size = obj(partial, 'size');
  const transform = obj(partial, 'transform');
  const fills = objArr(live, 'fillPaints');
  const strokes = objArr(live, 'strokePaints');
  const effects = objArr(live, 'effects');
  const w = num(size, 'x');
  const h = num(size, 'y');
  const swap = guidKey(obj(partial, 'overriddenSymbolID') as Guid | undefined);
  const assignments = objArr(partial, 'componentPropAssignments');

  const fields = compact({
    name: str(partial, 'name'),
    size: w !== undefined && h !== undefined ? `${r2(w)}x${r2(h)}` : undefined,
    x: r2(num(transform, 'm02')),
    y: r2(num(transform, 'm12')),
    visible: bool(partial, 'visible'),
    opacity: r2(num(partial, 'opacity')),
    // An empty fills array is itself an override ("remove all fills"), so report the count.
    fills: 'fillPaints' in live ? fills.map((p) => paintView(idx, p)) : undefined,
    fillsCleared: 'fillPaints' in live && fills.length === 0 ? true : undefined,
    strokes: 'strokePaints' in live ? strokes.map((p) => paintView(idx, p)) : undefined,
    strokesCleared: 'strokePaints' in live && strokes.length === 0 ? true : undefined,
    // A record writes the stroke-side and corner groups whole, so they read like a node's.
    strokeWeight: r2(num(partial, 'strokeWeight')),
    strokeWeights: sideWeights(partial),
    effects: effects.length ? effects.map((e) => effectView(idx, e)) : undefined,
    text: textBasics(live),
    cornerRadius: 'rectangleCornerRadiiIndependent' in partial
      ? cornerRadiusOf(partial)
      : r2(num(partial, 'cornerRadius')),
    symbolID: guidKey(obj(obj(partial, 'symbolData'), 'symbolID') as Guid | undefined),
    // A nested instance swapped for another component, or given other property values.
    swappedTo: swap ? compact({ guid: swap, name: str(idx.node(swap)?.node, 'name') }) : undefined,
    propAssignments: assignments.length ? propAssignmentViews(idx, assignments) : undefined,
    styles: styleRefsOf(idx, partial),
  });

  const known = new Set([
    'name', 'size', 'transform', 'visible', 'opacity', 'fillPaints', 'strokePaints', 'effects',
    'strokeWeight', 'borderStrokeWeightsIndependent', 'borderTopWeight', 'borderRightWeight',
    'borderBottomWeight', 'borderLeftWeight',
    'textData', 'fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'paragraphSpacing',
    'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration', 'textAutoResize',
    'cornerRadius', 'rectangleCornerRadiiIndependent', 'rectangleTopLeftCornerRadius',
    'rectangleTopRightCornerRadius', 'rectangleBottomRightCornerRadius',
    'rectangleBottomLeftCornerRadius',
    'symbolData', 'overriddenSymbolID', 'componentPropAssignments',
    'styleIdForFill', 'styleIdForStrokeFill', 'styleIdForText', 'styleIdForEffect',
    'styleIdForGrid',
  ]);
  const otherFields = Object.keys(partial).filter((k) => !known.has(k) && !OVERRIDE_META.has(k));
  return { fields, otherFields };
}

export function instanceOverrides(idx: FileIndex, t: TreeNode, field: string): OverrideView[] {
  const symbolData = field === 'symbolOverrides' ? obj(t.node, 'symbolData') : t.node;
  return overrideViews(idx, t, objArr(symbolData, field));
}

function overrideViews(
  idx: FileIndex,
  t: TreeNode,
  records: readonly KiwiObject[],
  inherited = false,
): OverrideView[] {
  return records.map((record) => {
    const path = objArr(obj(record, 'guidPath'), 'guids')
      .map((g) => guidKey(g as Guid))
      .filter((g): g is string => g !== undefined);
    const last = path[path.length - 1];
    // When the walk fails (a library symbol that is not in the file) the best that can be done
    // is any node carrying the last key.
    const target =
      resolveOverridePath(idx, t, path) ??
      (last ? idx.byOverrideIdentity().get(last)?.[0] : undefined);
    const { fields, otherFields } = overrideFields(idx, record);
    return compact({
      path,
      targetGuid: target?.key,
      targetName: target ? str(target.node, 'name') : undefined,
      targetType: target ? str(target.node, 'type') : undefined,
      fields,
      otherFields: otherFields.length ? otherFields : undefined,
      inherited: inherited || undefined,
    }) as OverrideView;
  });
}

export interface InstanceView {
  guid: string;
  name?: string;
  page?: string;
  path?: string;
  symbol?: { guid: string; name?: string; page?: string; variantOf?: string; inFile: boolean };
  propAssignments?: { defID: string; name?: string; type?: string; value?: unknown }[];
  overrides?: OverrideView[];
  derivedRecords?: number;
  scaleFactor?: number;
}

/**
 * `inherited` are the records enclosing instances apply inside this one when it is itself a
 * layer of an instance (model/scene.ts `inheritedOverrides`), already re-addressed from it.
 */
export function instanceView(
  idx: FileIndex,
  t: TreeNode,
  inherited: readonly KiwiObject[] = [],
): InstanceView {
  const symbolData = obj(t.node, 'symbolData');
  // A layer inside an instance may have had its symbol swapped by a record or a property.
  const symbolId =
    guidKey(obj(t.node, 'overriddenSymbolID') as Guid | undefined) ??
    guidKey(obj(symbolData, 'symbolID') as Guid | undefined);
  const symbol = symbolId ? idx.node(symbolId) : undefined;
  const symbolParent = symbol?.parent;

  const assignments = propAssignmentViews(idx, objArr(t.node, 'componentPropAssignments'));

  return compact({
    guid: t.key,
    name: str(t.node, 'name'),
    page: t.page ? str(t.page.node, 'name') : undefined,
    path: breadcrumb(t) || undefined,
    symbol: symbolId
      ? compact({
          guid: symbolId,
          name: symbol ? str(symbol.node, 'name') : undefined,
          page: symbol?.page ? str(symbol.page.node, 'name') : undefined,
          variantOf:
            symbolParent && bool(symbolParent.node, 'isStateGroup')
              ? str(symbolParent.node, 'name')
              : undefined,
          inFile: symbol !== undefined,
        })
      : undefined,
    propAssignments: assignments.length ? assignments : undefined,
    overrides: [
      ...instanceOverrides(idx, t, 'symbolOverrides'),
      ...overrideViews(idx, t, inherited, true),
    ],
    derivedRecords: objArr(t.node, 'derivedSymbolData').length || undefined,
    scaleFactor: num(symbolData, 'uniformScaleFactor') === 1 ? undefined : num(symbolData, 'uniformScaleFactor'),
  }) as InstanceView;
}
