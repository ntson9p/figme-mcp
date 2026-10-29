/**
 * The scene — the layer tree as Figma shows it, with every component instance expanded into the
 * layers it displays (render-implementation-plan.md F17, F18).
 *
 * The file stores an INSTANCE with no children: its content is the SYMBOL it points at, changed
 * by the instance's override records and component-property assignments. Figma shows those
 * layers inside the instance all the same, and gives each one an id of the form
 * `I<instance>;<id>;<id>…`: the outermost instance's guid, then one segment per instance-nesting
 * level, each the override identity (`overrideKey`, else guid) of the layer inside the symbol at
 * that level. That is exactly the `guidPath` the override records use, prefixed by the instance;
 * the plugin and REST APIs, and a link copied from a layer inside an instance, use the same ids.
 *
 * A SceneNode is a TreeNode, so every projection (summaries, detail, style, text) works on it
 * unchanged. A stored node keeps its guid and its record. A sublayer carries the record as its
 * instances show it — the symbol descendant merged with the override records and with the
 * component-property values applied — exactly as the renderer sees it, through the same
 * `model/instance.ts` resolution. Children are expanded lazily, on first access.
 *
 * Only an instance's CHILDREN come from its symbol. Its own record is complete: a field it omits
 * is at its default. On the iOS 16 UI Kit, of every visual or layout field an instance record
 * omits while its symbol's root sets it, the root's value is the default as well (an empty
 * paint list, a zero radius), or a style reference with nothing in it — never a value the
 * instance would show — so nothing is filled in from the symbol.
 */
import type { NodeChange } from '../fig/parse.js';
import type { KiwiObject } from '../fig/kiwi.js';
import type { FileIndex } from './index.js';
import { guidKey, overrideIdentity, type Guid, type TreeNode } from './tree.js';
import {
  applyProps,
  descend,
  mergeNode,
  resolveInstance,
  type ResolvedInstance,
} from './instance.js';
import { obj, objArr, str } from './access.js';

/** Instances nested deeper than this are almost certainly a cycle in a damaged file. */
const MAX_INSTANCE_DEPTH = 24;

/** The records and property values in force for the layers of one expanded instance. */
export interface Level {
  /** Guid of the outermost, stored instance: the first segment of every sublayer id. */
  readonly root: string;
  /** Override-identity path from that instance down to the instance this level expands. */
  readonly path: readonly string[];
  readonly instance: ResolvedInstance;
  /** Symbols expanded on the way here, so a self-referential component cannot loop. */
  readonly active: ReadonlySet<string>;
}

export interface SceneNode extends TreeNode {
  /** The stored node this layer shows: itself, or the symbol descendant for a sublayer. */
  readonly source: TreeNode;
  /** True for a layer inside an instance — one Figma shows but the file does not store. */
  readonly virtual: boolean;
  /** For a sublayer, the expansion it belongs to. */
  readonly level: Level | undefined;
  readonly children: SceneNode[];
}

/** `I<guid>;<guid>…` — Figma's id for a layer inside an instance. */
const SUBLAYER_ID = /^I(\d+:\d+)((?:;\d+:\d+)+)$/;

export function isSublayerId(id: string): boolean {
  return SUBLAYER_ID.test(id);
}

class Layer implements SceneNode {
  readonly key: string;
  readonly node: NodeChange;
  readonly source: TreeNode;
  readonly virtual: boolean;
  readonly level: Level | undefined;
  order: number;
  depth: number;
  page: TreeNode | undefined;
  private readonly index: FileIndex;
  private parentLayer: SceneNode | undefined;
  private expanded: SceneNode[] | undefined;
  private expansion: Level | null | undefined;

  constructor(
    index: FileIndex,
    init: { key: string; node: NodeChange; source: TreeNode; level?: Level; parent?: SceneNode },
  ) {
    this.index = index;
    this.key = init.key;
    this.node = init.node;
    this.source = init.source;
    this.level = init.level;
    this.virtual = init.level !== undefined;
    this.parentLayer = init.parent;
    this.order = this.virtual ? -1 : init.source.order;
    this.depth = init.parent && this.virtual ? init.parent.depth + 1 : init.source.depth;
    this.page = this.virtual ? init.parent?.page : init.source.page;
  }

  /** A stored node's parent is wrapped on demand, so wrapping one node never walks the tree. */
  get parent(): SceneNode | undefined {
    if (!this.parentLayer && !this.virtual && this.source.parent) {
      this.parentLayer = new Layer(this.index, {
        key: this.source.parent.key,
        node: this.source.parent.node,
        source: this.source.parent,
      });
    }
    return this.parentLayer;
  }

  set parent(_value: TreeNode | undefined) {
    throw new Error('a scene node cannot be re-parented');
  }

  get children(): SceneNode[] {
    this.expanded ??= this.expand();
    return this.expanded;
  }

  /** The expansion this INSTANCE opens — its symbol, records and property values. */
  instanceLevel(): Level | undefined {
    if (this.expansion === undefined) this.expansion = this.resolveLevel() ?? null;
    return this.expansion ?? undefined;
  }

  private resolveLevel(): Level | undefined {
    if (str(this.node, 'type') !== 'INSTANCE') return undefined;
    const outer = this.level;
    const identity = overrideIdentity(this.source);
    // As the renderer does: the instance as seen in its context, the enclosing records that
    // address its descendants, and the enclosing property values its own may point at.
    const instance = resolveInstance(
      this.index,
      this.node,
      outer ? descend(outer.instance.records, identity) : undefined,
      outer?.instance.props,
    );
    if (!instance) return undefined;
    const active = outer?.active ?? new Set<string>();
    if (active.has(instance.symbol.key) || active.size >= MAX_INSTANCE_DEPTH) return undefined;
    return {
      root: outer ? outer.root : this.key,
      path: outer ? [...outer.path, identity] : [],
      instance,
      active: new Set([...active, instance.symbol.key]),
    };
  }

  private expand(): SceneNode[] {
    if (str(this.node, 'type') === 'INSTANCE') {
      const level = this.instanceLevel();
      return level ? level.instance.symbol.children.map((c) => sublayer(this.index, c, level, this)) : [];
    }
    const level = this.level;
    if (level) return this.source.children.map((c) => sublayer(this.index, c, level, this));
    return this.source.children.map(
      (c) => new Layer(this.index, { key: c.key, node: c.node, source: c, parent: this }),
    );
  }
}

/** A symbol descendant as the instance expanded at `level` shows it. */
function sublayer(index: FileIndex, c: TreeNode, level: Level, parent: SceneNode): SceneNode {
  const identity = overrideIdentity(c);
  const record = level.instance.records.get(identity);
  const node = applyProps(
    mergeNode(c.node, record),
    level.instance.props,
    record?.['derivedTextData'] !== undefined,
  ).node;
  return new Layer(index, {
    key: `I${level.root};${[...level.path, identity].join(';')}`,
    node,
    source: c,
    level,
    parent,
  });
}

/** A stored node as a scene node: its record unchanged, its instances expandable. */
export function sceneOf(index: FileIndex, t: TreeNode): SceneNode {
  return new Layer(index, { key: t.key, node: t.node, source: t });
}

/** The layer inside `symbol` (never the symbol itself) that a path segment names. */
function layerIn(index: FileIndex, symbol: TreeNode, segment: string): TreeNode | undefined {
  return (index.byOverrideIdentity().get(segment) ?? []).find(
    (c) => c !== symbol && index.isDescendant(c, symbol),
  );
}

/**
 * Resolve a stored guid or a sublayer id (`I<instance>;<id>;…`) to its scene node, with the
 * whole chain of enclosing layers as its parents. Undefined when nothing matches: an unknown
 * guid, a first segment that is not an instance, or a segment its instance does not contain.
 */
export function resolveScene(index: FileIndex, id: string): SceneNode | undefined {
  const m = SUBLAYER_ID.exec(id);
  if (!m) {
    const t = index.node(id);
    return t ? sceneOf(index, t) : undefined;
  }
  const rootNode = index.node(m[1]!);
  if (!rootNode) return undefined;
  let current: SceneNode = sceneOf(index, rootNode);
  for (const segment of m[2]!.slice(1).split(';')) {
    const level = current instanceof Layer ? current.instanceLevel() : undefined;
    if (!level) return undefined;
    const symbol = level.instance.symbol;
    const target = layerIn(index, symbol, segment);
    if (!target) return undefined;
    // Materialise the layers between the symbol and the target, so the target has real parents.
    const chain: TreeNode[] = [];
    for (let cur: TreeNode | undefined = target; cur && cur !== symbol; cur = cur.parent) chain.push(cur);
    let node: SceneNode = current;
    for (let i = chain.length - 1; i >= 0; i--) node = sublayer(index, chain[i]!, level, node);
    current = node;
  }
  return current;
}

/**
 * The override records the enclosing instances apply inside a nested instance `s` — the ones
 * whose `guidPath` runs through it — re-addressed from `s`, innermost instance first. Its own
 * records are `s.node.symbolData.symbolOverrides`; these come on top, and the outer one wins.
 */
export function inheritedOverrides(s: TreeNode): KiwiObject[] {
  if (!(s instanceof Layer) || !s.level) return [];
  const full = [...s.level.path, overrideIdentity(s.source)];
  const out: KiwiObject[] = [];
  for (let cur: TreeNode | undefined = s.parent; cur; cur = cur.parent) {
    const level = cur instanceof Layer ? cur.instanceLevel() : undefined;
    if (level && level.root === s.level.root) {
      const prefix = full.slice(level.path.length);
      for (const record of objArr(obj(cur.node, 'symbolData'), 'symbolOverrides')) {
        const path = objArr(obj(record, 'guidPath'), 'guids').map((g) => guidKey(g as Guid) ?? '');
        if (path.length <= prefix.length || prefix.some((p, i) => path[i] !== p)) continue;
        out.push({ ...record, guidPath: { guids: objArr(obj(record, 'guidPath'), 'guids').slice(prefix.length) } });
      }
    }
    if (cur.key === s.level.root) break;
  }
  return out;
}

/** True when the node, or a layer above it, is hidden. */
export function isHidden(s: TreeNode): boolean {
  for (let cur: TreeNode | undefined = s; cur; cur = cur.parent) {
    const type = str(cur.node, 'type');
    if (type === 'CANVAS' || type === 'DOCUMENT') break;
    if (cur.node['visible'] === false) return true;
  }
  return false;
}
