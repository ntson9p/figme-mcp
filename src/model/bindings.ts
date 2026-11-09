/**
 * Fields bound to variables, evaluated in the variable modes in force (F28).
 *
 * A layer binds a field to a variable in `variableConsumptionMap` and in the newer
 * `parameterConsumptionMap` (which also carries component-property bindings, `propRefValue`):
 * `entries[] { variableField, variableData: { value: { alias } } }`. The value written beside a
 * binding — the node's `visible` — was resolved where the layer is defined: for a component's
 * layer, in the component's own modes. An instance that picks other modes shows other values,
 * and Figma stores none of them (no derived record ever carries `visible`). So a layer inside an
 * instance is evaluated here, in the modes in force at it; a stored layer keeps the value Figma
 * stored for it, which was resolved where it stands.
 */
import type { NodeChange } from '../fig/parse.js';
import type { KiwiObject } from '../fig/kiwi.js';
import { bool, obj, objArr, str } from './access.js';
import { variableValueIn, type ModeMap, type VariableIndex } from './variables.js';

/** The maps that bind a node's fields; Figma writes both, the newer first. */
const BINDING_MAPS = ['parameterConsumptionMap', 'variableConsumptionMap'] as const;

/** The variable `node` binds `field` to (a `VariableID`), or undefined when it binds none. */
export function boundVariable(node: NodeChange, field: string): KiwiObject | undefined {
  for (const map of BINDING_MAPS) {
    for (const entry of objArr(obj(node, map), 'entries')) {
      if (str(entry, 'variableField') !== field) continue;
      const alias = obj(obj(obj(entry, 'variableData'), 'value'), 'alias');
      if (alias) return alias;
    }
  }
  return undefined;
}

export interface BoundNode {
  readonly node: NodeChange;
  /** Bound fields that took their variable's value in the modes in force. */
  readonly applied: number;
  /** Bound fields whose value cannot be known from this file; they keep the cached value. */
  readonly unresolved: number;
}

/** F28 — `visible` from the variable the node binds it to, read in the modes in force. */
export function applyVisibility(idx: VariableIndex, node: NodeChange, modes: ModeMap): BoundNode {
  const alias = boundVariable(node, 'VISIBLE');
  if (!alias) return { node, applied: 0, unresolved: 0 };
  const visible = bool(variableValueIn(idx, alias, modes), 'boolValue');
  if (visible === undefined) return { node, applied: 0, unresolved: 1 };
  const same = visible === (bool(node, 'visible') !== false);
  return { node: same ? node : { ...node, visible }, applied: 1, unresolved: 0 };
}
