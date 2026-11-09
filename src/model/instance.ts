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
 * assignments have to be evaluated, not read back. An assignment keeps its value in `value` or,
 * in files from current Figma, only in `varValue` (F26) — `assignmentValue` reads both.
 */
import type { KiwiObject } from '../fig/kiwi.js';
import type { NodeChange } from '../fig/parse.js';
import type { FileIndex } from './index.js';
import { guidKey, overrideIdentity, type Guid, type TreeNode } from './tree.js';
import { assetRefKey, bool, num, obj, objArr, str } from './access.js';

/** Addressing fields that must never be merged into a node as content. */
const OVERRIDE_META = new Set(['guidPath', 'overrideLevel', 'guid', 'phase', 'parentIndex']);

/** Record map for one instance level: identity path (joined by '/') → partial NodeChange. */
export type OverrideRecords = ReadonlyMap<string, KiwiObject>;
/**
 * Component-property assignments of one instance: defID → the value in `ComponentPropValue`
 * shape, `{textValue|boolValue|guidValue}`, whichever slot the file stored it in.
 */
export type PropAssignments = ReadonlyMap<string, KiwiObject>;

/** The index lookups the instance resolver needs. */
type ResolverIndex = Pick<FileIndex, 'node' | 'componentByKey'>;

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
 * A component property's value held as `VariableData` — the `varValue` of an assignment or of a
 * property definition — in the `ComponentPropValue` shape the rest of the resolver reads, or
 * undefined when it holds nothing this file can turn into one (F26).
 *
 * The names differ between the two shapes: a swap is `symbolIdValue { guid | assetRef }`, not
 * `guidValue`, and text is `textDataValue`, because a `VariableAnyValue`'s `textValue` is a plain
 * string. A `propRefValue` (a property of the enclosing instance) or an `alias` (a variable)
 * carries no value of its own and is left to the caller.
 */
export function propValueOfVariableData(
  index: Pick<FileIndex, 'componentByKey'>,
  data: KiwiObject | undefined,
): KiwiObject | undefined {
  const value = obj(data, 'value');
  if (!value) return undefined;
  const flag = bool(value, 'boolValue');
  if (flag !== undefined) return { boolValue: flag };
  const text = obj(value, 'textDataValue');
  if (text) return { textValue: text };
  const symbol = obj(value, 'symbolIdValue');
  if (symbol) {
    const byGuid = obj(symbol, 'guid');
    if (guidKey(byGuid as Guid | undefined)) return { guidValue: byGuid };
    const key = assetRefKey(symbol);
    const local = key ? index.componentByKey(key) : undefined;
    const guid = local ? obj(local.node, 'guid') : undefined;
    if (guid) return { guidValue: guid };
  }
  return undefined;
}

/**
 * The value one assignment gives its property, in `ComponentPropValue` shape: the `value` slot
 * when the file wrote it, else what `varValue` holds — a value of its own (F26), or a PROP_REF to
 * a property of the enclosing instance, looked up in `outerProps`. Undefined when the assignment
 * carries nothing usable, and the component's own default then stands.
 */
export function assignmentValue(
  index: ResolverIndex,
  assignment: KiwiObject,
  outerProps?: PropAssignments,
): KiwiObject | undefined {
  const value = obj(assignment, 'value');
  if (value && Object.keys(value).length > 0) return value;
  const varValue = obj(assignment, 'varValue');
  const ref = guidKey(obj(obj(obj(varValue, 'value'), 'propRefValue'), 'defId') as Guid | undefined);
  if (ref) return outerProps?.get(ref);
  return propValueOfVariableData(index, varValue);
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

function sizeDiffers(a: KiwiObject | undefined, b: KiwiObject | undefined): boolean {
  if (!a || !b) return false;
  return (
    Math.abs((num(a, 'x') ?? 0) - (num(b, 'x') ?? 0)) > 1e-3 ||
    Math.abs((num(a, 'y') ?? 0) - (num(b, 'y') ?? 0)) > 1e-3
  );
}

/**
 * `{ ...base, ...patch }` minus the addressing fields.
 *
 * Figma re-derives geometry only for nodes that paint something (F20): of the sample's 22 097
 * resized painted nodes, 18 lack it. A record that resizes a node without supplying geometry
 * therefore leaves the base geometry describing the OLD size — the 1240x180 symbol behind a
 * 1052x503 panel — so it is dropped and the exporter rebuilds the box from `size` (§4.14).
 */
export function mergeNode(base: NodeChange, patch: KiwiObject | undefined): NodeChange {
  if (!patch) return base;
  const out: NodeChange = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (OVERRIDE_META.has(k)) continue;
    out[k] = k === 'componentPropAssignments' ? mergeAssignments(base[k], v) : v;
  }
  if (sizeDiffers(obj(base, 'size'), obj(patch, 'size'))) {
    if (patch['fillGeometry'] === undefined) delete out['fillGeometry'];
    if (patch['strokeGeometry'] === undefined) delete out['strokeGeometry'];
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
  index: ResolverIndex,
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
    const value = assignmentValue(index, a, outerProps);
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
 * The fields of an instance's own box that come from its component's root unless the instance
 * overrides them, in the units Figma writes together: paints with their style reference, the
 * stroke-weight group, the corner group (F27).
 */
const ROOT_APPEARANCE: readonly (readonly string[])[] = [
  ['fillPaints', 'styleIdForFill'],
  ['strokePaints', 'styleIdForStrokeFill'],
  ['strokeWeight', 'borderStrokeWeightsIndependent', 'borderTopWeight', 'borderRightWeight',
    'borderBottomWeight', 'borderLeftWeight'],
  ['strokeAlign'],
  ['strokeJoin'],
  ['strokeCap'],
  ['dashPattern'],
  ['effects', 'styleIdForEffect'],
  ['cornerRadius', 'rectangleCornerRadiiIndependent', 'rectangleTopLeftCornerRadius',
    'rectangleTopRightCornerRadius', 'rectangleBottomRightCornerRadius', 'rectangleBottomLeftCornerRadius'],
  ['cornerSmoothing'],
  ['opacity'],
  ['blendMode'],
  ['frameMaskDisabled'],
];

/** Structural equality of two decoded values: primitives, bytes, arrays and records. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array &&
      a.length === b.length && a.every((v, i) => v === b[i]);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) &&
      a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length &&
      ka.every((k) => Object.hasOwn(b, k) && sameValue((a as KiwiObject)[k], (b as KiwiObject)[k]));
  }
  return false;
}

/** The component an INSTANCE record shows: its swap target, else its own symbol. */
function componentOf(node: NodeChange): string | undefined {
  return (
    guidKey(obj(node, 'overriddenSymbolID') as Guid | undefined) ??
    guidKey(obj(obj(node, 'symbolData'), 'symbolID') as Guid | undefined)
  );
}

/**
 * F27 — the stored record of a nested instance whose component is swapped, as the swapped-in
 * component shows it. The record is complete for the component it was written for, so it holds
 * copies of that component root's own appearance — an icon's filled circle and round corners —
 * that are not overrides. Swapped, the instance keeps only what it overrides: every unit of
 * `ROOT_APPEARANCE` equal to the old root's takes the new root's value (or none, where the new
 * root has none), and the outline, which traced the old component's shape, is dropped.
 */
export function swapAppearance(stored: NodeChange, from: NodeChange, to: NodeChange): NodeChange {
  const out: NodeChange = { ...stored };
  delete out['fillGeometry'];
  delete out['strokeGeometry'];
  for (const unit of ROOT_APPEARANCE) {
    if (!unit.every((field) => sameValue(stored[field], from[field]))) continue;
    for (const field of unit) {
      if (to[field] === undefined) delete out[field];
      else out[field] = to[field];
    }
  }
  return out;
}

export interface ShownLayer extends AppliedProps {
  /** True when a property value changed the layer. */
  readonly propsApplied: boolean;
}

/**
 * A component layer as the instance that expands it shows it: the stored node merged with its
 * record, with the instance's property values applied (F17, F18) — and, for a nested instance
 * whose component that swaps, with the copies of the old component's root appearance taken out
 * before the record goes on top (F27). Shared by the exporter and the scene, so the picture and
 * the inspection tools see the same layer.
 */
export function showLayer(
  index: Pick<FileIndex, 'node'>,
  t: TreeNode,
  records: OverrideRecords,
  props: PropAssignments,
): ShownLayer {
  const record = records.get(overrideIdentity(t));
  const outlines = record?.['derivedTextData'] !== undefined;
  const merged = mergeNode(t.node, record);
  const applied = applyProps(merged, props, outlines);
  if (str(t.node, 'type') === 'INSTANCE') {
    const from = componentOf(t.node);
    const to = componentOf(applied.node);
    const old = from && to && from !== to ? index.node(from) : undefined;
    const swapped = old && to ? index.node(to) : undefined;
    if (old && swapped) {
      // A component missing from the file (a library one) cannot be compared; nothing changes.
      const cleaned = mergeNode(swapAppearance(t.node, old.node, swapped.node), record);
      const reapplied = applyProps(cleaned, props, outlines);
      return { ...reapplied, propsApplied: reapplied.node !== cleaned };
    }
  }
  return { ...applied, propsApplied: applied.node !== merged };
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
