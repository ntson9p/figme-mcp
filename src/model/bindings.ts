/**
 * Fields bound to variables, evaluated in the variable modes in force (F28, F29).
 *
 * A layer binds a field to a variable in `variableConsumptionMap` and in the newer
 * `parameterConsumptionMap` (which also carries component-property bindings, `propRefValue`):
 * `entries[] { variableField, variableData: { value: { alias } } }`; a paint, a gradient stop or
 * an effect binds its colour in `colorVar`. The value written beside a binding — the node's
 * `visible`, the paint's `color` — was resolved where the layer is defined: for a component's
 * layer, in the component's own modes. An instance that picks other modes shows other values,
 * and Figma stores none of them (no derived record ever carries `visible` or paints). So a layer
 * inside an instance is evaluated here, in the modes in force at it; a stored layer keeps the
 * values Figma stored for it, which were resolved where it stands.
 */
import type { NodeChange } from '../fig/parse.js';
import type { KiwiObject } from '../fig/kiwi.js';
import type { TreeNode } from './tree.js';
import { bool, num, obj, objArr, str } from './access.js';
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

interface Tally {
  applied: number;
  unresolved: number;
}

function sameColour(a: KiwiObject, b: KiwiObject | undefined): boolean {
  return ['r', 'g', 'b', 'a'].every((c) => num(a, c) === num(b, c));
}

/**
 * A paint, gradient stop or effect with its `color` taken from the variable its `colorVar`
 * names. The variable's colour carries its own alpha; a paint's `opacity` is a separate field,
 * with a binding of its own (`opacityVar`), and is left alone.
 */
function withBoundColour(idx: VariableIndex, holder: KiwiObject, modes: ModeMap, tally: Tally): KiwiObject {
  const alias = obj(obj(obj(holder, 'colorVar'), 'value'), 'alias');
  if (!alias) return holder;
  const colour = obj(variableValueIn(idx, alias, modes), 'colorValue');
  if (!colour) {
    tally.unresolved += 1;
    return holder;
  }
  tally.applied += 1;
  return sameColour(colour, obj(holder, 'color')) ? holder : { ...holder, color: colour };
}

/** The same list when nothing in it changed, so callers can tell. */
function mapSame(list: KiwiObject[], fn: (item: KiwiObject) => KiwiObject): KiwiObject[] {
  let changed = false;
  const out = list.map((item) => {
    const next = fn(item);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? out : list;
}

function paintsIn(idx: VariableIndex, paints: KiwiObject[], modes: ModeMap, tally: Tally): KiwiObject[] {
  return mapSame(paints, (paint) => {
    const own = withBoundColour(idx, paint, modes, tally);
    const stops = objArr(paint, 'stops');
    const bound = mapSame(stops, (stop) => withBoundColour(idx, stop, modes, tally));
    return bound === stops ? own : { ...own, stops: bound };
  });
}

/**
 * Paints with every colour bound to a variable read in `modes` (F29) — for a paint list picked at
 * draw time, such as a style a text run or vector region names.
 */
export function boundPaints(idx: VariableIndex, paints: KiwiObject[], modes: ModeMap): KiwiObject[] {
  return paintsIn(idx, paints, modes, { applied: 0, unresolved: 0 });
}

/**
 * F29 — every colour the node binds to a variable, read in the modes in force: its fills, strokes
 * and effects, and the paints of its text-run and vector-region style entries. Apply it after
 * colour styles are resolved (F19), since a style's paints can be bound too.
 */
export function applyColours(idx: VariableIndex, node: NodeChange, modes: ModeMap): BoundNode {
  const tally: Tally = { applied: 0, unresolved: 0 };
  let out = node;
  for (const field of ['fillPaints', 'strokePaints'] as const) {
    const paints = objArr(out, field);
    const bound = paintsIn(idx, paints, modes, tally);
    if (bound !== paints) out = { ...out, [field]: bound };
  }
  const effects = objArr(out, 'effects');
  const boundEffects = mapSame(effects, (e) => withBoundColour(idx, e, modes, tally));
  if (boundEffects !== effects) out = { ...out, effects: boundEffects };
  for (const holder of ['textData', 'vectorData'] as const) {
    const data = obj(out, holder);
    const table = objArr(data, 'styleOverrideTable');
    const bound = mapSame(table, (entry) => {
      let next = entry;
      for (const field of ['fillPaints', 'strokePaints'] as const) {
        const paints = objArr(next, field);
        const boundPaints = paintsIn(idx, paints, modes, tally);
        if (boundPaints !== paints) next = { ...next, [field]: boundPaints };
      }
      return next;
    });
    if (bound !== table) out = { ...out, [holder]: { ...data, styleOverrideTable: bound } };
  }
  return { node: out, ...tally };
}

/** F28 and F29 together: the node's visibility and colours, read in the modes in force. */
export function applyBindings(idx: VariableIndex, node: NodeChange, modes: ModeMap): BoundNode {
  const visibility = applyVisibility(idx, node, modes);
  const colours = applyColours(idx, visibility.node, modes);
  return {
    node: colours.node,
    applied: visibility.applied + colours.applied,
    unresolved: visibility.unresolved + colours.unresolved,
  };
}

/**
 * The modes the inspection tools read a layer's colour bindings in: those of a layer inside an
 * instance (a virtual scene node, model/scene.ts). A stored layer — or a node that is not a scene
 * node — keeps the values Figma stored for it, so this is undefined for it.
 */
export function bindingModesOf(t: TreeNode): ModeMap | undefined {
  const layer = t as TreeNode & { readonly virtual?: boolean; readonly modes?: ModeMap };
  return layer.virtual === true ? layer.modes : undefined;
}
