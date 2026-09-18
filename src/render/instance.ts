/**
 * The render-side half of instance resolution (plan F17): how an INSTANCE's own box is drawn.
 * The resolution itself — records, identities, property assignments — lives in
 * `model/instance.ts`, shared with `fig_instance`, and is re-exported here for the exporter.
 */
import type { NodeChange } from '../fig/parse.js';
import { overrideIdentity, type TreeNode } from '../model/tree.js';
import { mergeNode, type OverrideRecords } from '../model/instance.js';

export {
  applyProps,
  descend,
  mergeNode,
  resolveInstance,
  type AppliedProps,
  type OverrideRecords,
  type PropAssignments,
  type ResolvedInstance,
} from '../model/instance.js';

/**
 * Fields that describe how a node paints ITSELF. When an instance carries one of these it has
 * already been resolved for this instance; otherwise the symbol root's (overridden) value wins.
 */
const SHAPE_FIELDS = [
  'fillGeometry',
  'strokeGeometry',
  'size',
  'strokeAlign',
  'effects',
  'styleIdForEffect',
  'blendMode',
  'opacity',
  'frameMaskDisabled',
  'resizeToFit',
  'cornerRadius',
] as const;

/**
 * Paints and the style reference beside them travel as one unit: an instance whose root fill was
 * detached from the symbol's colour style carries its own `fillPaints` and NO reference (133 in
 * the sample, every one a different colour from the style), and taking the paints without also
 * dropping the symbol's reference would hand the fill straight back to the style (F19).
 */
const PAINT_UNITS = [
  ['fillPaints', 'styleIdForFill'],
  ['strokePaints', 'styleIdForStrokeFill'],
] as const;

/**
 * How the instance's own box should be drawn: the symbol root with its override applied, then
 * any of the shape fields the instance itself carries (13 835 instances have their own
 * `fillGeometry`, already resolved). `instance` is the node as seen in its context.
 */
export function instanceShapeNode(
  instance: NodeChange,
  symbol: TreeNode,
  records: OverrideRecords,
): NodeChange {
  const base = mergeNode(symbol.node, records.get(overrideIdentity(symbol)));
  const out: NodeChange = { ...base };
  for (const field of SHAPE_FIELDS) {
    if (instance[field] !== undefined) out[field] = instance[field];
  }
  for (const [paints, style] of PAINT_UNITS) {
    if (instance[paints] === undefined) continue;
    out[paints] = instance[paints];
    if (instance[style] !== undefined) out[style] = instance[style];
    else delete out[style];
  }
  // The instance's own transform is already applied by its group; never take the symbol's.
  out['transform'] = instance['transform'];
  out['type'] = instance['type'];
  return out;
}
