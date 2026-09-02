// Attributing a pixel difference back to the layer that caused it (§9.5). Not a test file.
//
// "3.1 % of pixels differ" is not actionable. "the stroke on 2:1339" is a task. This turns one
// into the other by clustering the differing blocks and asking which drawn node covers each
// cluster most tightly.
import type { Box, NodeBox } from '../../../dist/render/index.js';

export interface Cluster {
  /** Cluster bounds in root-local units. */
  readonly box: Box;
  readonly blocks: number;
}

export interface Attribution {
  readonly guid: string;
  readonly name?: string;
  readonly type: string;
  readonly clusterBox: Box;
  readonly blocks: number;
}

const BLOCK = 8;
/** A block counts as bad when more than a quarter of its pixels differ. */
const BLOCK_THRESHOLD = 0.25;
/** Single stray blocks are anti-aliasing, not a defect. */
const MIN_BLOCKS = 2;

/** 4-neighbour connected components over the bad-block grid. */
export function clusterDiff(
  mask: readonly boolean[],
  width: number,
  height: number,
): { grid: boolean[]; cols: number; rows: number; clusters: { blocks: [number, number][] }[] } {
  const cols = Math.ceil(width / BLOCK);
  const rows = Math.ceil(height / BLOCK);
  const grid: boolean[] = new Array(cols * rows).fill(false);

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let bad = 0;
      let total = 0;
      for (let y = by * BLOCK; y < Math.min((by + 1) * BLOCK, height); y++) {
        for (let x = bx * BLOCK; x < Math.min((bx + 1) * BLOCK, width); x++) {
          total++;
          if (mask[y * width + x]) bad++;
        }
      }
      grid[by * cols + bx] = total > 0 && bad / total > BLOCK_THRESHOLD;
    }
  }

  const seen: boolean[] = new Array(cols * rows).fill(false);
  const clusters: { blocks: [number, number][] }[] = [];
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i] || seen[i]) continue;
    const blocks: [number, number][] = [];
    const queue = [i];
    seen[i] = true;
    while (queue.length) {
      const at = queue.pop()!;
      const bx = at % cols;
      const by = Math.floor(at / cols);
      blocks.push([bx, by]);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = bx + dx;
        const ny = by + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (grid[n] && !seen[n]) {
          seen[n] = true;
          queue.push(n);
        }
      }
    }
    if (blocks.length >= MIN_BLOCKS) clusters.push({ blocks });
  }
  return { grid, cols, rows, clusters };
}

function area(b: Box): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

function intersection(a: Box, b: Box): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, r - x) * Math.max(0, bt - y);
}

/**
 * Map each cluster to the smallest drawn node that covers at least 80 % of it. The smallest
 * such node is the most specific explanation; the root is the fallback.
 */
export function attribute(
  mask: readonly boolean[],
  width: number,
  height: number,
  boxes: readonly NodeBox[],
  /** Pixels per root-local unit, so cluster boxes can be expressed in node coordinates. */
  scale: number,
  origin: { x: number; y: number },
  limit = 10,
): Attribution[] {
  const { clusters } = clusterDiff(mask, width, height);
  const sorted = [...boxes].sort((a, b) => area(a.box) - area(b.box));
  const out: Attribution[] = [];

  for (const cluster of clusters) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [bx, by] of cluster.blocks) {
      minX = Math.min(minX, bx * BLOCK);
      minY = Math.min(minY, by * BLOCK);
      maxX = Math.max(maxX, (bx + 1) * BLOCK);
      maxY = Math.max(maxY, (by + 1) * BLOCK);
    }
    const box: Box = {
      x: origin.x + minX / scale,
      y: origin.y + minY / scale,
      w: (maxX - minX) / scale,
      h: (maxY - minY) / scale,
    };

    const owner = sorted.find((n) => intersection(n.box, box) >= area(box) * 0.8);
    out.push({
      guid: owner?.guid ?? '(root)',
      name: owner?.name,
      type: owner?.type ?? '?',
      clusterBox: box,
      blocks: cluster.blocks.length,
    });
  }

  return out.sort((a, b) => b.blocks - a.blocks).slice(0, limit);
}
