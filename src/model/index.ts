/**
 * FileIndex — every lookup the tools need, built once per parsed file.
 *
 * Everything cheap is built eagerly (one pass over 116k nodes); the full-text search index is
 * built on first use because it duplicates every name and text run in lowercase.
 */
import type { ParsedFig, NodeChange } from '../fig/parse.js';
import { buildTree, guidKey, overrideIdentity, type Tree, type TreeNode, type Guid } from './tree.js';
import { obj, objArr, str, bytes, hex, assetRefKey } from './access.js';
import type { KiwiObject } from '../fig/kiwi.js';

export interface PropDefEntry {
  readonly id: string;
  readonly name?: string;
  readonly type?: string;
  /** The SYMBOL or component-set FRAME that declares the property. */
  readonly owner: TreeNode;
  readonly def: KiwiObject;
}

export interface SearchEntry {
  readonly t: TreeNode;
  readonly name: string;
  readonly nameLower: string;
  readonly textLower: string | undefined;
}

export class FileIndex {
  readonly fig: ParsedFig;
  readonly tree: Tree;
  readonly typeCounts: Readonly<Record<string, number>>;
  readonly pages: readonly TreeNode[];
  readonly symbols: readonly TreeNode[];
  readonly variables: readonly TreeNode[];
  readonly variableSets: readonly TreeNode[];
  /** Publishable `key` (a 40-hex asset key) → the local node that defines it. */
  readonly byAssetKey: ReadonlyMap<string, TreeNode>;
  /** SYMBOL guid → number of INSTANCE nodes pointing at it. */
  readonly instanceCounts: ReadonlyMap<string, number>;
  /** Lowercase hex hashes of every image referenced by a paint. */
  readonly imageHashes: ReadonlySet<string>;
  readonly textNodeCount: number;

  private searchIndex: SearchEntry[] | undefined;
  private overrideIdentityIndex: Map<string, TreeNode[]> | undefined;
  private propDefIndex: Map<string, PropDefEntry> | undefined;

  constructor(fig: ParsedFig) {
    this.fig = fig;
    this.tree = buildTree(fig.nodeChanges);

    const typeCounts: Record<string, number> = {};
    const pages: TreeNode[] = [];
    const symbols: TreeNode[] = [];
    const variables: TreeNode[] = [];
    const variableSets: TreeNode[] = [];
    const byAssetKey = new Map<string, TreeNode>();
    const instanceCounts = new Map<string, number>();
    const imageHashes = new Set<string>();
    let textNodeCount = 0;

    for (const t of this.tree.ordered) {
      const node = t.node;
      const type = str(node, 'type') ?? 'UNKNOWN';
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;

      switch (type) {
        case 'CANVAS':
          pages.push(t);
          break;
        case 'SYMBOL':
          symbols.push(t);
          break;
        case 'VARIABLE':
          variables.push(t);
          break;
        case 'VARIABLE_SET':
          variableSets.push(t);
          break;
        case 'TEXT':
          textNodeCount++;
          break;
        case 'INSTANCE': {
          const symbolId = guidKey(obj(obj(node, 'symbolData'), 'symbolID') as Guid | undefined);
          if (symbolId) instanceCounts.set(symbolId, (instanceCounts.get(symbolId) ?? 0) + 1);
          break;
        }
        default:
          break;
      }

      const key = str(node, 'key');
      if (key && !byAssetKey.has(key)) byAssetKey.set(key, t);

      for (const paints of [objArr(node, 'fillPaints'), objArr(node, 'strokePaints')]) {
        for (const paint of paints) {
          const h = hex(bytes(obj(paint, 'image'), 'hash'));
          if (h) imageHashes.add(h);
        }
      }
    }

    this.typeCounts = typeCounts;
    this.pages = pages;
    this.symbols = symbols;
    this.variables = variables;
    this.variableSets = variableSets;
    this.byAssetKey = byAssetKey;
    this.instanceCounts = instanceCounts;
    this.imageHashes = imageHashes;
    this.textNodeCount = textNodeCount;
  }

  get root(): TreeNode | undefined {
    return this.tree.root;
  }

  get nodeCount(): number {
    return this.tree.ordered.length;
  }

  node(guid: string): TreeNode | undefined {
    return this.tree.byKey.get(guid);
  }

  /** Resolve a `{assetRef:{key}}` reference to the local node defining it, when it is local. */
  resolveAssetRef(ref: KiwiObject | undefined): TreeNode | undefined {
    const key = assetRefKey(ref);
    return key ? this.byAssetKey.get(key) : undefined;
  }

  /** DFS pre-order slice of a subtree, so pagination and cursors are stable. */
  subtreeRange(root: TreeNode): { start: number; end: number } {
    let end = root.order + 1;
    const ordered = this.tree.ordered;
    while (end < ordered.length && ordered[end]!.depth > root.depth) end++;
    return { start: root.order, end };
  }

  isDescendant(candidate: TreeNode, ancestor: TreeNode): boolean {
    const { start, end } = this.subtreeRange(ancestor);
    return candidate.order >= start && candidate.order < end;
  }

  /**
   * Override identity → the nodes carrying it. Instance override paths (`guidPath.guids`)
   * address component descendants by `overrideIdentity`: the `overrideKey` when the node has
   * one, else its guid. The same key appears on every duplicate of a component, so a key can map
   * to several nodes; a guid maps to exactly one.
   */
  byOverrideIdentity(): ReadonlyMap<string, readonly TreeNode[]> {
    if (this.overrideIdentityIndex) return this.overrideIdentityIndex;
    const map = new Map<string, TreeNode[]>();
    for (const t of this.tree.ordered) {
      const identity = overrideIdentity(t);
      const list = map.get(identity);
      if (list) list.push(t);
      else map.set(identity, [t]);
    }
    this.overrideIdentityIndex = map;
    return map;
  }

  /**
   * Component property definitions by defID. Named definitions live on standalone SYMBOLs and on
   * component sets (FRAMEs with `isStateGroup`); variant member SYMBOLs repeat the same ids with
   * no name, so named entries always win.
   */
  propDefs(): ReadonlyMap<string, PropDefEntry> {
    if (this.propDefIndex) return this.propDefIndex;
    const map = new Map<string, PropDefEntry>();
    for (const t of this.tree.ordered) {
      for (const def of objArr(t.node, 'componentPropDefs')) {
        const id = guidKey(obj(def, 'id') as Guid | undefined);
        if (!id) continue;
        const name = str(def, 'name');
        const existing = map.get(id);
        if (existing && (!name || existing.name)) continue;
        map.set(id, { id, name, type: str(def, 'type'), owner: t, def });
      }
    }
    this.propDefIndex = map;
    return map;
  }

  /** Built lazily: it duplicates every name and text body in lowercase. */
  search(): readonly SearchEntry[] {
    if (this.searchIndex) return this.searchIndex;
    const entries: SearchEntry[] = [];
    for (const t of this.tree.ordered) {
      const name = str(t.node, 'name') ?? '';
      const characters = str(obj(t.node, 'textData'), 'characters');
      entries.push({
        t,
        name,
        nameLower: name.toLowerCase(),
        textLower: characters ? characters.toLowerCase() : undefined,
      });
    }
    this.searchIndex = entries;
    return entries;
  }
}

/** Image hashes referenced by one node's paints, in fill-then-stroke order. */
export function nodeImageHashes(node: NodeChange): string[] {
  const out: string[] = [];
  for (const key of ['fillPaints', 'strokePaints'] as const) {
    for (const paint of objArr(node, key)) {
      const h = hex(bytes(obj(paint, 'image'), 'hash'));
      if (h && !out.includes(h)) out.push(h);
    }
  }
  // Text runs can carry their own image fills.
  for (const override of objArr(obj(node, 'textData'), 'styleOverrideTable')) {
    for (const paint of objArr(override, 'fillPaints')) {
      const h = hex(bytes(obj(paint, 'image'), 'hash'));
      if (h && !out.includes(h)) out.push(h);
    }
  }
  return out;
}

export type { TreeNode, Tree };
