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
import { effectView, paintView, textBasics } from './summarize.js';
import { describeVariableData } from './variables.js';

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
}

/** Map one partial NodeChange (an override or a derived record) to a compact field set. */
export function overrideFields(idx: FileIndex, partial: NodeChange): {
  fields: Record<string, unknown>;
  otherFields: string[];
} {
  const size = obj(partial, 'size');
  const transform = obj(partial, 'transform');
  const fills = objArr(partial, 'fillPaints');
  const strokes = objArr(partial, 'strokePaints');
  const effects = objArr(partial, 'effects');
  const w = num(size, 'x');
  const h = num(size, 'y');

  const fields = compact({
    size: w !== undefined && h !== undefined ? `${r2(w)}x${r2(h)}` : undefined,
    x: r2(num(transform, 'm02')),
    y: r2(num(transform, 'm12')),
    visible: bool(partial, 'visible'),
    opacity: r2(num(partial, 'opacity')),
    // An empty fills array is itself an override ("remove all fills"), so report the count.
    fills: 'fillPaints' in partial ? fills.map((p) => paintView(idx, p)) : undefined,
    fillsCleared: 'fillPaints' in partial && fills.length === 0 ? true : undefined,
    strokes: 'strokePaints' in partial ? strokes.map((p) => paintView(idx, p)) : undefined,
    strokesCleared: 'strokePaints' in partial && strokes.length === 0 ? true : undefined,
    effects: effects.length ? effects.map((e) => effectView(idx, e)) : undefined,
    text: textBasics(partial),
    cornerRadius: r2(num(partial, 'cornerRadius')),
    symbolID: guidKey(obj(obj(partial, 'symbolData'), 'symbolID') as Guid | undefined),
  });

  const known = new Set([
    'size', 'transform', 'visible', 'opacity', 'fillPaints', 'strokePaints', 'effects',
    'textData', 'fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'cornerRadius',
    'symbolData',
  ]);
  const otherFields = Object.keys(partial).filter((k) => !known.has(k) && !OVERRIDE_META.has(k));
  return { fields, otherFields };
}

export function instanceOverrides(idx: FileIndex, t: TreeNode, field: string): OverrideView[] {
  const symbolData = field === 'symbolOverrides' ? obj(t.node, 'symbolData') : t.node;
  const records = objArr(symbolData, field);

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

export function instanceView(idx: FileIndex, t: TreeNode): InstanceView {
  const symbolData = obj(t.node, 'symbolData');
  const symbolId = guidKey(obj(symbolData, 'symbolID') as Guid | undefined);
  const symbol = symbolId ? idx.node(symbolId) : undefined;
  const symbolParent = symbol?.parent;

  const assignments = objArr(t.node, 'componentPropAssignments').map((a) => {
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
    overrides: instanceOverrides(idx, t, 'symbolOverrides'),
    derivedRecords: objArr(t.node, 'derivedSymbolData').length || undefined,
    scaleFactor: num(symbolData, 'uniformScaleFactor') === 1 ? undefined : num(symbolData, 'uniformScaleFactor'),
  }) as InstanceView;
}
