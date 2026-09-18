/**
 * Instance resolution — what an INSTANCE looks like once its records and properties are applied
 * (render-implementation-plan.md F17, F18). Shared by the renderer and by `fig_instance`, so the
 * two never disagree about which node a record addresses.
 *
 * An INSTANCE has NO children of its own — all 38 164 in the sample have zero — so its content
 * is the SYMBOL it points at. Figma supplies two record sets on the instance, both addressed by
 * `guidPath.guids`, a path of override identities (`overrideIdentity`: the node's `overrideKey`,
 * else its guid):
 *
 *   `symbolData.symbolOverrides`  what the user changed (fillPaints, visible, textData, size, …)
 *   `derivedSymbolData`           what Figma recomputed as a result — the resolved `size`,
 *                                 `transform`, `fillGeometry`, `strokeGeometry` and
 *                                 `derivedTextData` for each affected descendant
 *
 * `guidPath` counts INSTANCE nesting levels, not node depth: a one-segment path addresses a node
 * anywhere inside this instance's own symbol, a two-segment path `[a, b]` addresses the node `b`
 * inside the nested instance `a`, and so on.
 *
 * A third input is not expressed as records at all (F18): `componentPropAssignments`, the values
 * an instance gives the component's properties. A symbol descendant bound to a property through
 * `componentPropRefs` takes its `visible`, its text or its symbol from the assignment. Not one of
 * the sample's 29 877 BOOLEAN=false assignments is mirrored by a `visible:false` record, so the
 * assignments have to be evaluated, not read back.
 */
import type { KiwiObject } from '../fig/kiwi.js';
import type { NodeChange } from '../fig/parse.js';
import type { FileIndex } from './index.js';
import { guidKey, overrideIdentity, type Guid, type TreeNode } from './tree.js';
import { bool, obj, objArr, str } from './access.js';

/** Addressing fields that must never be merged into a node as content. */
const OVERRIDE_META = new Set(['guidPath', 'overrideLevel', 'guid', 'phase', 'parentIndex']);

/** Record map for one instance level: identity path (joined by '/') → partial NodeChange. */
export type OverrideRecords = ReadonlyMap<string, KiwiObject>;
/** Component-property assignments of one instance: defID → `{textValue|boolValue|guidValue}`. */
export type PropAssignments = ReadonlyMap<string, KiwiObject>;

export interface ResolvedInstance {
  readonly symbol: TreeNode;
  readonly records: OverrideRecords;
  readonly props: PropAssignments;
}

function pathOf(record: KiwiObject): string | undefined {
  const guids = objArr(obj(record, 'guidPath'), 'guids')
    .map((g) => guidKey(g as unknown as Guid))
    .filter((g): g is string => g !== undefined);
  return guids.length ? guids.join('/') : undefined;
}

function defIdOf(assignment: KiwiObject): string | undefined {
  return guidKey(obj(assignment, 'defID') as Guid | undefined);
}

/**
 * Property assignments merge per definition: a record that reassigns a nested instance's
 * properties lists only the ones it changes (1 251 of the sample's 2 591 such records are
 * partial), so replacing the array would silently reset the others to the component's defaults.
 */
function mergeAssignments(base: unknown, patch: unknown): KiwiObject[] {
  const out = new Map<string, KiwiObject>();
  for (const a of Array.isArray(base) ? (base as KiwiObject[]) : []) {
    const id = defIdOf(a);
    if (id) out.set(id, a);
  }
  for (const a of Array.isArray(patch) ? (patch as KiwiObject[]) : []) {
    const id = defIdOf(a);
    if (id) out.set(id, a);
  }
  return [...out.values()];
}

/** `{ ...base, ...patch }` minus the addressing fields. */
export function mergeNode(base: NodeChange, patch: KiwiObject | undefined): NodeChange {
  if (!patch) return base;
  const out: NodeChange = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (OVERRIDE_META.has(k)) continue;
    out[k] = k === 'componentPropAssignments' ? mergeAssignments(base[k], v) : v;
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
 * The symbol, the record map and the property assignments for one instance, taken from the node
 * AS SEEN in its context: inside another instance that is the merged node, whose records may
 * reassign this instance's properties or swap its symbol (`overriddenSymbolID`).
 *
 * `inherited` carries records handed down from an enclosing instance, already stripped of the
 * segment that addressed this one. The outer instance wins, because an override applied at the
 * outer level is the more specific edit. `outerProps` are the enclosing instance's assignments,
 * which an assignment of this instance may point at instead of carrying a value (PROP_REF —
 * none in the sample, so this path is untested against real data).
 */
export function resolveInstance(
  index: FileIndex,
  node: NodeChange,
  inherited?: OverrideRecords,
  outerProps?: PropAssignments,
): ResolvedInstance | undefined {
  const symbolData = obj(node, 'symbolData');
  const symbolId =
    guidKey(obj(node, 'overriddenSymbolID') as Guid | undefined) ??
    guidKey(obj(symbolData, 'symbolID') as Guid | undefined);
  if (!symbolId) return undefined;
  const symbol = index.node(symbolId);
  if (!symbol) return undefined;

  const records = new Map<string, KiwiObject>();
  // Order matters: what the user set, then what Figma recomputed, then the enclosing instance.
  collect(records, objArr(symbolData, 'symbolOverrides'));
  collect(records, objArr(node, 'derivedSymbolData'));
  if (inherited) {
    for (const [path, patch] of inherited) {
      const existing = records.get(path);
      records.set(path, existing ? mergeNode(existing, patch) : patch);
    }
  }

  const props = new Map<string, KiwiObject>();
  for (const a of objArr(node, 'componentPropAssignments')) {
    const id = defIdOf(a);
    if (!id) continue;
    const ref = obj(obj(obj(obj(a, 'varValue'), 'value'), 'propRefValue'), 'defId');
    const value = obj(a, 'value') ?? (ref ? outerProps?.get(guidKey(ref as Guid) ?? '') : undefined);
    if (value) props.set(id, value);
  }
  return { symbol, records, props };
}

/**
 * The records an enclosing instance contributes to a nested one: every entry whose path starts
 * with the nested instance's own identity, with that segment removed.
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

export interface AppliedProps {
  readonly node: NodeChange;
  /** True when a text assignment changed the characters but no record supplied outlines for it. */
  readonly staleOutlines: boolean;
}

/**
 * F18 — a symbol descendant bound to a component property (`componentPropRefs`) takes the value
 * the instance assigned. Without an assignment the symbol's own state already IS the default: in
 * the sample every one of the 108 VISIBLE bindings with a known default matches it.
 *
 * `outlinesFromRecord` says whether the enclosing instance's records supplied `derivedTextData`
 * for this node. A text assignment without them would be drawn with the SYMBOL's glyphs — the
 * wrong words — so the caller reports it instead.
 */
export function applyProps(
  node: NodeChange,
  props: PropAssignments,
  outlinesFromRecord: boolean,
): AppliedProps {
  const refs = objArr(node, 'componentPropRefs');
  if (refs.length === 0 || props.size === 0) return { node, staleOutlines: false };
  let out = node;
  let staleOutlines = false;
  for (const ref of refs) {
    const id = guidKey(obj(ref, 'defID') as Guid | undefined);
    const value = id ? props.get(id) : undefined;
    if (!value) continue;
    switch (str(ref, 'componentPropNodeField')) {
      case 'VISIBLE': {
        const visible = bool(value, 'boolValue');
        if (visible !== undefined) out = { ...out, visible };
        break;
      }
      case 'TEXT_DATA': {
        const text = obj(value, 'textValue');
        if (!text) break;
        const before = str(obj(out, 'textData'), 'characters');
        if (str(text, 'characters') !== before && !outlinesFromRecord) staleOutlines = true;
        out = { ...out, textData: { ...(obj(out, 'textData') ?? {}), ...text } };
        break;
      }
      case 'OVERRIDDEN_SYMBOL_ID': {
        const guid = obj(value, 'guidValue');
        if (guid) out = { ...out, overriddenSymbolID: guid };
        break;
      }
      default:
        break;
    }
  }
  return { node: out, staleOutlines };
}

/**
 * The node a record path addresses, walked exactly the way the renderer expands the instance:
 * each segment names a node inside the current symbol by identity, and a segment that lands on a
 * nested INSTANCE continues inside the symbol that nested instance resolves to — after the
 * enclosing level's records and property assignments, which may have swapped it.
 */
export function resolveOverridePath(
  index: FileIndex,
  instance: TreeNode,
  path: readonly string[],
): TreeNode | undefined {
  let level = resolveInstance(index, instance.node);
  let target: TreeNode | undefined;
  for (let i = 0; i < path.length; i++) {
    if (!level) return undefined;
    const segment = path[i]!;
    const { symbol, records, props } = level;
    target =
      overrideIdentity(symbol) === segment
        ? symbol
        : (index.byOverrideIdentity().get(segment) ?? []).find((c) => index.isDescendant(c, symbol));
    if (!target) return undefined;
    if (i === path.length - 1) break;
    if (str(target.node, 'type') !== 'INSTANCE') return undefined;
    const effective = applyProps(mergeNode(target.node, records.get(segment)), props, true).node;
    level = resolveInstance(index, effective, descend(records, segment), props);
  }
  return target;
}
