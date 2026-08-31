/**
 * Figma Variables (fig-reading-solution.md §9.8).
 *
 * A VARIABLE_SET node is a collection with named modes; VARIABLE nodes hold one value per mode.
 * Consumption sites carry a `VariableData` whose `value.alias` points at a variable either by
 * local GUID or by library `assetRef`. Local aliases are followed (with a cycle guard); library
 * aliases are surfaced as-is, since the library is not in the file.
 */
import type { FileIndex } from './index.js';
import type { TreeNode } from './tree.js';
import type { KiwiObject } from '../fig/kiwi.js';
import { assetRefString, bool, colorHex, compact, num, obj, objArr, r2, str, jsonSafe } from './access.js';
import { guidKey, type Guid } from './tree.js';

const MAX_ALIAS_DEPTH = 8;

export interface VariableRef {
  /** Local variable name when resolvable, else undefined. */
  name?: string;
  guid?: string;
  /** Library asset reference `key@version` when the target is not in this file. */
  assetRef?: string;
  /** Resolved concrete value per mode name, when the chain ends locally. */
  values?: Record<string, unknown>;
  unresolved?: true;
}

/** A concrete (non-alias) `VariableAnyValue` rendered compactly; aliases return undefined. */
function concreteValue(value: KiwiObject | undefined): unknown {
  if (!value) return undefined;
  const color = obj(value, 'colorValue');
  if (color) return colorHex(color);
  const f = num(value, 'floatValue');
  if (f !== undefined) return r2(f);
  const t = str(value, 'textValue');
  if (t !== undefined) return t;
  const b = bool(value, 'boolValue');
  if (b !== undefined) return b;
  const len = obj(value, 'lengthValue');
  if (len) return r2(num(len, 'value')) ?? jsonSafe(len);
  const alias = obj(value, 'alias');
  if (alias) return undefined;
  // Anything else (gradients, symbol ids, expressions…) is passed through verbatim.
  const keys = Object.keys(value);
  return keys.length ? { [keys[0]!]: jsonSafe(value[keys[0]!]) } : undefined;
}

/** Mode GUID → mode name for the set a variable belongs to. */
function modeNames(idx: FileIndex, variable: TreeNode): Map<string, string> {
  const out = new Map<string, string>();
  const set = variableSetOf(idx, variable);
  if (!set) return out;
  for (const mode of objArr(set.node, 'variableSetModes')) {
    const id = guidKey(obj(mode, 'id') as Guid | undefined);
    if (id) out.set(id, str(mode, 'name') ?? id);
  }
  return out;
}

export function variableSetOf(idx: FileIndex, variable: TreeNode): TreeNode | undefined {
  const ref = obj(variable.node, 'variableSetID');
  if (!ref) return undefined;
  const byGuid = guidKey(obj(ref, 'guid') as Guid | undefined);
  if (byGuid) {
    const t = idx.node(byGuid);
    if (t) return t;
  }
  return idx.resolveAssetRef(ref);
}

/** Per-mode values of one VARIABLE node, following local alias chains. */
export function variableValues(idx: FileIndex, variable: TreeNode, depth = 0): Record<string, unknown> {
  const names = modeNames(idx, variable);
  const out: Record<string, unknown> = {};
  for (const entry of objArr(obj(variable.node, 'variableDataValues'), 'entries')) {
    const modeId = guidKey(obj(entry, 'modeID') as Guid | undefined) ?? '?';
    const data = obj(entry, 'variableData');
    const value = obj(data, 'value');
    const alias = obj(value, 'alias');
    const label = names.get(modeId) ?? modeId;
    if (alias) {
      const ref = resolveVariableRef(idx, alias, depth + 1);
      out[label] = ref.values && Object.keys(ref.values).length === 1
        ? Object.values(ref.values)[0]
        : compact({ alias: ref.name ?? ref.assetRef, guid: ref.guid, values: ref.values });
    } else {
      out[label] = concreteValue(value);
    }
  }
  return out;
}

/** Resolve a `VariableID` (`{guid}` or `{assetRef}`) to a named local variable when possible. */
export function resolveVariableRef(idx: FileIndex, alias: KiwiObject | undefined, depth = 0): VariableRef {
  if (!alias) return { unresolved: true };
  const assetRef = assetRefString(alias);
  const localByGuid = guidKey(obj(alias, 'guid') as Guid | undefined);
  const target =
    (localByGuid ? idx.node(localByGuid) : undefined) ?? idx.resolveAssetRef(alias);
  if (!target) return compact({ guid: localByGuid, assetRef, unresolved: true as const }) as VariableRef;
  const ref: VariableRef = compact({
    name: str(target.node, 'name'),
    guid: target.key,
    assetRef,
  }) as VariableRef;
  if (depth < MAX_ALIAS_DEPTH) {
    const values = variableValues(idx, target, depth);
    if (Object.keys(values).length) ref.values = values;
  }
  return ref;
}

/** A `VariableData` binding at a consumption site (`colorVar`, `radiusVar`, …). */
export function describeVariableData(idx: FileIndex, data: KiwiObject | undefined): unknown {
  if (!data) return undefined;
  const value = obj(data, 'value');
  const alias = obj(value, 'alias');
  if (alias) {
    const ref = resolveVariableRef(idx, alias);
    return compact({
      variable: ref.name,
      guid: ref.guid,
      assetRef: ref.assetRef,
      values: ref.values,
      resolvedType: str(data, 'resolvedDataType'),
    });
  }
  const concrete = concreteValue(value);
  if (concrete !== undefined) return concrete;
  return compact({ dataType: str(data, 'dataType'), resolvedType: str(data, 'resolvedDataType') });
}

export interface VariableSetView {
  guid: string;
  name?: string;
  key?: string;
  modes: { id: string; name: string }[];
  variableCount: number;
}

export function variableSetView(idx: FileIndex, set: TreeNode): VariableSetView {
  const modes = objArr(set.node, 'variableSetModes').map((m) => ({
    id: guidKey(obj(m, 'id') as Guid | undefined) ?? '?',
    name: str(m, 'name') ?? '',
  }));
  const key = str(set.node, 'key');
  let variableCount = 0;
  for (const v of idx.variables) if (variableSetOf(idx, v)?.key === set.key) variableCount++;
  return compact({ guid: set.key, name: str(set.node, 'name'), key, modes, variableCount }) as VariableSetView;
}

export interface VariableView {
  guid: string;
  name?: string;
  type?: string;
  key?: string;
  set?: string;
  values: Record<string, unknown>;
  scopes?: unknown;
}

export function variableView(idx: FileIndex, variable: TreeNode): VariableView {
  const set = variableSetOf(idx, variable);
  return compact({
    guid: variable.key,
    name: str(variable.node, 'name'),
    type: str(variable.node, 'variableResolvedType'),
    key: str(variable.node, 'key'),
    set: set ? (str(set.node, 'name') ?? set.key) : undefined,
    values: variableValues(idx, variable),
  }) as VariableView;
}
