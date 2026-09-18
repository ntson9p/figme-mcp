/**
 * Layer-tree reconstruction (fig-reading-solution.md §8).
 *
 * `message.nodeChanges` is flat; every node carries `parentIndex.{guid, position}`. Siblings are
 * ordered by a fractional-index string that MUST be compared by raw UTF-16 code units — numeric
 * or locale-aware comparison scrambles layer order.
 */
import type { NodeChange } from '../fig/parse.js';
import type { KiwiObject } from '../fig/kiwi.js';

export interface Guid {
  readonly sessionID?: number;
  readonly localID?: number;
}

/** Canonical guid string used at every API boundary: `"2:1339"`. */
export function guidKey(g: Guid | undefined): string | undefined {
  if (!g || g.sessionID === undefined || g.localID === undefined) return undefined;
  return `${g.sessionID}:${g.localID}`;
}

export function readGuid(obj: KiwiObject | undefined, field: string): string | undefined {
  return guidKey(obj?.[field] as Guid | undefined);
}

export interface TreeNode {
  readonly key: string;
  readonly node: NodeChange;
  readonly children: TreeNode[];
  parent: TreeNode | undefined;
  /** DFS pre-order position; stable for a given parse, and the basis of every cursor. */
  order: number;
  depth: number;
  /** Nearest CANVAS ancestor (the page a node lives on); undefined for DOCUMENT and pages. */
  page: TreeNode | undefined;
}

/**
 * The identity that instance override paths (`symbolData.symbolOverrides[].guidPath.guids` and
 * `derivedSymbolData[].guidPath.guids`) use for a component descendant: its `overrideKey` when
 * it has one — a node created by copying a component keeps the original's — else its own guid.
 *
 * Measured on the sample: 8 893 of 10 480 symbol descendants carry an explicit key; the other
 * 1 587 are addressed by guid, by 30 061 of the file's 303 833 records.
 */
export function overrideIdentity(t: TreeNode): string {
  return readGuid(t.node, 'overrideKey') ?? t.key;
}

export interface Tree {
  readonly root: TreeNode | undefined;
  readonly byKey: ReadonlyMap<string, TreeNode>;
  /** DFS pre-order list; index === TreeNode.order. */
  readonly ordered: readonly TreeNode[];
  readonly orphans: readonly TreeNode[];
}

/** Raw code-unit comparison — see pitfall §11.4. */
function comparePosition(a: TreeNode, b: TreeNode): number {
  const pa = (a.node['parentIndex'] as KiwiObject | undefined)?.['position'];
  const pb = (b.node['parentIndex'] as KiwiObject | undefined)?.['position'];
  const sa = typeof pa === 'string' ? pa : '';
  const sb = typeof pb === 'string' ? pb : '';
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  // Deterministic tiebreak so identical positions never reorder between calls.
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function buildTree(nodeChanges: readonly NodeChange[]): Tree {
  const byKey = new Map<string, TreeNode>();
  for (const node of nodeChanges) {
    const key = guidKey(node['guid'] as Guid | undefined);
    if (key === undefined) continue;
    byKey.set(key, { key, node, children: [], parent: undefined, order: -1, depth: 0, page: undefined });
  }

  let root: TreeNode | undefined;
  const orphans: TreeNode[] = [];
  for (const entry of byKey.values()) {
    const parentGuid = (entry.node['parentIndex'] as KiwiObject | undefined)?.['guid'];
    const parent = parentGuid ? byKey.get(guidKey(parentGuid as Guid) ?? '') : undefined;
    if (parent) {
      parent.children.push(entry);
      entry.parent = parent;
    } else if (entry.node['type'] === 'DOCUMENT' && !root) {
      root = entry;
    } else {
      orphans.push(entry);
    }
  }

  for (const entry of byKey.values()) {
    if (entry.children.length > 1) entry.children.sort(comparePosition);
  }

  // Iterative DFS: numbering, depth and page assignment in one pass, no recursion depth limit.
  const ordered: TreeNode[] = [];
  const roots: TreeNode[] = root ? [root, ...orphans] : [...orphans];
  for (const start of roots) {
    const stack: TreeNode[] = [start];
    while (stack.length) {
      const t = stack.pop()!;
      t.order = ordered.length;
      ordered.push(t);
      const parent = t.parent;
      t.depth = parent ? parent.depth + 1 : 0;
      t.page = t.node['type'] === 'CANVAS' ? t : parent?.page;
      for (let i = t.children.length - 1; i >= 0; i--) stack.push(t.children[i]!);
    }
  }

  return { root, byKey, ordered, orphans };
}

/** Names from the node up to (excluding) the DOCUMENT, root-first — a readable breadcrumb. */
export function breadcrumb(t: TreeNode, separator = ' / '): string {
  const parts: string[] = [];
  for (let cur: TreeNode | undefined = t.parent; cur; cur = cur.parent) {
    if (cur.node['type'] === 'DOCUMENT') break;
    parts.push(String(cur.node['name'] ?? cur.key));
  }
  return parts.reverse().join(separator);
}
