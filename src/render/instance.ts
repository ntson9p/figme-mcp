/**
 * Instance resolution (plan F17).
 *
 * An INSTANCE has NO children of its own — all 38 164 in the sample have zero — so rendering one
 * means rendering the SYMBOL it points at. Figma supplies two record sets on the instance, both
 * addressed by `guidPath.guids`, a path of **overrideKeys**:
 *
 *   `symbolData.symbolOverrides`  what the user changed (fillPaints, visible, textData, size, …)
 *   `derivedSymbolData`           what Figma recomputed as a result — the resolved `size`,
 *                                 `transform`, `fillGeometry`, `strokeGeometry` and
 *                                 `derivedTextData` for each affected descendant
 *
 * `guidPath` counts INSTANCE nesting levels, not node depth: a one-segment path addresses a node
 * anywhere inside this instance's own symbol (69 748 of 76 947 records), a two-segment path
 * `[a, b]` addresses the node with overrideKey `b` inside the nested instance with overrideKey
 * `a`, and so on.
 */
import type { KiwiObject } from '../fig/kiwi.js';
import type { NodeChange } from '../fig/parse.js';
import type { FileIndex } from '../model/index.js';
import { guidKey, type Guid, type TreeNode } from '../model/tree.js';
import { obj, objArr } from '../model/access.js';

/** Addressing fields that must never be merged into a node as content. */
const OVERRIDE_META = new Set(['guidPath', 'overrideLevel', 'guid', 'phase', 'parentIndex']);

/** Record map for one instance level: overrideKey path (joined by '/') → partial NodeChange. */
export type OverrideRecords = ReadonlyMap<string, KiwiObject>;

export interface ResolvedInstance {
  readonly symbol: TreeNode;
  readonly records: OverrideRecords;
}

export function overrideKeyOf(t: TreeNode): string | undefined {
  return guidKey(obj(t.node, 'overrideKey') as Guid | undefined);
}

function pathOf(record: KiwiObject): string | undefined {
  const guids = objArr(obj(record, 'guidPath'), 'guids')
    .map((g) => guidKey(g as unknown as Guid))
    .filter((g): g is string => g !== undefined);
  return guids.length ? guids.join('/') : undefined;
}

/** `{ ...base, ...patch }` minus the addressing fields. */
export function mergeNode(base: NodeChange, patch: KiwiObject | undefined): NodeChange {
  if (!patch) return base;
  const out: NodeChange = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (OVERRIDE_META.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function collect(target: Map<string, KiwiObject>, records: readonly KiwiObject[]): void {
  for (const record of records) {
    const path = pathOf(record);
    if (!path) continue;
    const existing = target.get(path);
    target.set(path, existing ? mergeNode(existing, record) : record);
  }
}

/**
 * The symbol and the record map for one instance.
 *
 * `inherited` carries records handed down from an enclosing instance, already stripped of the
 * segment that addressed this one. The outer instance wins, because an override applied at the
 * outer level is the more specific edit.
 */
export function resolveInstance(
  index: FileIndex,
  t: TreeNode,
  inherited?: OverrideRecords,
): ResolvedInstance | undefined {
  const symbolData = obj(t.node, 'symbolData');
  const symbolId = guidKey(obj(symbolData, 'symbolID') as Guid | undefined);
  if (!symbolId) return undefined;
  const symbol = index.node(symbolId);
  if (!symbol) return undefined;

  const records = new Map<string, KiwiObject>();
  // Order matters: what the user set, then what Figma recomputed, then the enclosing instance.
  collect(records, objArr(symbolData, 'symbolOverrides'));
  collect(records, objArr(t.node, 'derivedSymbolData'));
  if (inherited) {
    for (const [path, patch] of inherited) {
      const existing = records.get(path);
      records.set(path, existing ? mergeNode(existing, patch) : patch);
    }
  }
  return { symbol, records };
}

/**
 * The records an enclosing instance contributes to a nested one: every entry whose path starts
 * with the nested instance's own overrideKey, with that segment removed.
 */
export function descend(records: OverrideRecords, key: string | undefined): OverrideRecords | undefined {
  if (!key) return undefined;
  const prefix = `${key}/`;
  let out: Map<string, KiwiObject> | undefined;
  for (const [path, patch] of records) {
    if (!path.startsWith(prefix)) continue;
    (out ??= new Map()).set(path.slice(prefix.length), patch);
  }
  return out;
}

/**
 * Fields that describe how a node paints ITSELF. When an instance carries one of these it has
 * already been resolved for this instance; otherwise the symbol root's (overridden) value wins.
 */
const SHAPE_FIELDS = [
  'fillGeometry',
  'strokeGeometry',
  'fillPaints',
  'strokePaints',
  'size',
  'strokeAlign',
  'effects',
  'blendMode',
  'opacity',
  'frameMaskDisabled',
  'resizeToFit',
  'cornerRadius',
] as const;

/**
 * How the instance's own box should be drawn: the symbol root with its override applied, then
 * any of the shape fields the instance itself carries (13 835 instances have their own
 * `fillGeometry`, already resolved).
 */
export function instanceShapeNode(
  instance: TreeNode,
  symbol: TreeNode,
  records: OverrideRecords,
): NodeChange {
  const rootKey = overrideKeyOf(symbol);
  const base = mergeNode(symbol.node, rootKey ? records.get(rootKey) : undefined);
  const out: NodeChange = { ...base };
  for (const field of SHAPE_FIELDS) {
    if (instance.node[field] !== undefined) out[field] = instance.node[field];
  }
  // The instance's own transform is already applied by its group; never take the symbol's.
  out['transform'] = instance.node['transform'];
  out['type'] = instance.node['type'];
  return out;
}
