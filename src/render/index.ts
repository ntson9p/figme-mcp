/**
 * `renderNode` — the entry point used by the tool, the CLI and the visual tester.
 *
 * Resolves a guid, exports the subtree to SVG (§4), decides the effective scale (§4.13) and,
 * when a rasterizer is installed, produces PNG bytes. Nothing here touches the network and
 * nothing is ever written back into the .fig.
 */
import type { CacheEntry } from '../cache.js';
import type { TreeNode } from '../model/tree.js';
import { str } from '../model/access.js';
import { pageBackground } from './color.js';
import {
  DEFAULT_MAX_NODES,
  HARD_MAX_NODES,
  MAX_SVG_BYTES,
  exportSubtree,
  type NodeBox,
} from './export.js';
import type { Box } from './matrix.js';
import { nodeType } from './node.js';
import { rasterize } from './raster.js';
import type { RenderReport } from './report.js';

export const DEFAULT_SCALE = 2;
export const DEFAULT_MAX_SIZE = 1568;
export const HARD_MAX_SIZE = 4096;

export interface RenderOptions {
  readonly scale?: number;
  readonly maxSize?: number;
  readonly background?: 'transparent' | 'page';
  readonly maxNodes?: number;
  /** 'svg' skips rasterization entirely. Default 'png', which falls back to SVG when absent. */
  readonly format?: 'png' | 'svg';
  /** Record every drawn node's box in root-local units (used by the tester's attribution). */
  readonly collectBoxes?: boolean;
}

export interface RenderResult {
  readonly svg: string;
  readonly png?: Uint8Array;
  /** Output pixel size: `round(bounds × effective scale)`. */
  readonly width: number;
  readonly height: number;
  readonly bounds: Box;
  readonly report: RenderReport;
  readonly boxes?: NodeBox[];
  /** True when PNG was requested but no rasterizer is installed. */
  readonly rasterizerMissing: boolean;
}

function resolveRoot(entry: CacheEntry, guid: string): TreeNode {
  const t = entry.index.node(guid);
  if (!t) {
    throw new Error(
      `no node with guid ${JSON.stringify(guid)} in this file ` +
        '(guids look like "2:1339"; use fig_find or fig_tree to discover them)',
    );
  }
  if (nodeType(t.node) === 'DOCUMENT') {
    throw new Error('cannot render the DOCUMENT node — render a page or a node inside one');
  }
  return t;
}

export async function renderNode(
  entry: CacheEntry,
  guid: string,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  const root = resolveRoot(entry, guid);

  const maxNodes = Math.min(opts.maxNodes ?? DEFAULT_MAX_NODES, HARD_MAX_NODES);
  const range = entry.index.subtreeRange(root);
  const subtreeSize = range.end - range.start;
  if (subtreeSize > maxNodes) {
    throw new Error(
      `node ${guid} covers ${subtreeSize} nodes, above maxNodes (${maxNodes}); ` +
        'render a smaller node or raise maxNodes',
    );
  }

  const background = opts.background === 'page' ? pageBackground(root) : undefined;

  const startedExport = performance.now();
  const exported = exportSubtree(entry, root, {
    maxNodes,
    collectBoxes: opts.collectBoxes,
    background,
  });
  const renderMs = performance.now() - startedExport;

  if (exported.svg.length > MAX_SVG_BYTES) {
    throw new Error(
      `the generated SVG is ${exported.svg.length} bytes, above the ${MAX_SVG_BYTES}-byte limit; ` +
        'render a smaller subtree (large image fills are embedded once per distinct paint)',
    );
  }

  const bounds = exported.bounds;
  const maxSize = Math.min(opts.maxSize ?? DEFAULT_MAX_SIZE, HARD_MAX_SIZE);
  const longest = Math.max(bounds.w, bounds.h);
  const requested = opts.scale ?? DEFAULT_SCALE;
  const scale = longest * requested > maxSize && longest > 0 ? maxSize / longest : requested;
  const width = Math.max(1, Math.round(bounds.w * scale));
  const height = Math.max(1, Math.round(bounds.h * scale));

  let png: Uint8Array | undefined;
  let rasterMs: number | undefined;
  let rasterizerMissing = false;

  if (opts.format !== 'svg') {
    const startedRaster = performance.now();
    let raster;
    try {
      raster = await rasterize(exported.svg, scale);
    } catch (err) {
      // resvg rejects malformed markup with a plain Error; report it instead of crashing.
      exported.report.unsupported('svg-rejected', guid);
      throw new Error(`the rasterizer rejected the generated SVG: ${(err as Error).message}`);
    }
    if (raster) {
      png = raster.png;
      rasterMs = performance.now() - startedRaster;
    } else {
      rasterizerMissing = true;
    }
  }

  const report = exported.report.finish({
    root: { guid: root.key, name: str(root.node, 'name'), type: nodeType(root.node) },
    bounds,
    width,
    height,
    scale: Math.round(scale * 1000) / 1000,
    svgBytes: exported.svg.length,
    renderMs: Math.round(renderMs * 10) / 10,
    rasterMs: rasterMs === undefined ? undefined : Math.round(rasterMs * 10) / 10,
    note: rasterizerMissing
      ? 'rasterizer unavailable — npm install @resvg/resvg-wasm to get PNG output'
      : undefined,
  });

  return {
    svg: exported.svg,
    png,
    width,
    height,
    bounds,
    report,
    boxes: opts.collectBoxes ? exported.boxes : undefined,
    rasterizerMissing,
  };
}

export { rasterizer } from './raster.js';
export type { NodeBox } from './export.js';
export type { RenderReport } from './report.js';
export type { Box } from './matrix.js';
