/**
 * Path command blobs (plan §4.2, fact F4).
 *
 * A blob is a flat sequence of commands: one opcode byte followed by little-endian float32
 * arguments. Verified on all 7 292 non-empty fill, stroke and glyph blobs of the sample file:
 *
 *   0 close (0 floats)   1 moveTo (x y)   2 lineTo (x y)   3 quadTo (cx cy x y)
 *   4 cubicTo (c1x c1y c2x c2y x y)
 *
 * An empty blob is a valid empty path ("no fill area", e.g. a zero-height line).
 */
import type { Box, Mat } from './matrix.js';
import { apply } from './matrix.js';
import { fmt } from './svg.js';

export type PathOp = 'Z' | 'M' | 'L' | 'Q' | 'C';

export interface PathCommand {
  readonly op: PathOp;
  readonly args: readonly number[];
}

const ARG_COUNT: Record<number, number> = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };
const OPS = ['Z', 'M', 'L', 'Q', 'C'] as const;

export function decodeCommands(raw: Uint8Array): PathCommand[] {
  const out: PathCommand[] = [];
  if (raw.length === 0) return out;
  const dv = new DataView(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength);
  let i = 0;
  while (i < raw.length) {
    const op = raw[i]!;
    const n = ARG_COUNT[op];
    if (n === undefined) {
      throw new Error(`unknown path opcode ${op} at byte ${i} of ${raw.length}`);
    }
    if (i + 1 + 4 * n > raw.length) {
      throw new Error(`truncated path command ${op} at byte ${i} of ${raw.length}`);
    }
    const args: number[] = [];
    for (let k = 0; k < n; k++) args.push(dv.getFloat32(i + 1 + 4 * k, true));
    out.push({ op: OPS[op]!, args });
    i += 1 + 4 * n;
  }
  return out;
}

/** SVG `d` string. `m`, when given, is applied to every coordinate pair before formatting. */
export function toPathData(cmds: readonly PathCommand[], m?: Mat): string {
  const parts: string[] = [];
  for (const cmd of cmds) {
    if (cmd.op === 'Z') {
      parts.push('Z');
      continue;
    }
    const nums: string[] = [];
    for (let k = 0; k + 1 < cmd.args.length; k += 2) {
      const x = cmd.args[k]!;
      const y = cmd.args[k + 1]!;
      if (m) {
        const [px, py] = apply(m, x, y);
        nums.push(fmt(px), fmt(py));
      } else {
        nums.push(fmt(x), fmt(y));
      }
    }
    parts.push(`${cmd.op}${nums.join(',')}`);
  }
  return parts.join(' ');
}

/**
 * Conservative bounds: control points are included, so a curve's box may be slightly larger
 * than the ink. That is the safe direction — a render region is never too small.
 */
export function pathBounds(cmds: readonly PathCommand[], m?: Mat): Box | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let seen = false;
  for (const cmd of cmds) {
    for (let k = 0; k + 1 < cmd.args.length; k += 2) {
      const rx = cmd.args[k]!;
      const ry = cmd.args[k + 1]!;
      const [x, y] = m ? apply(m, rx, ry) : [rx, ry];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      seen = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!seen) return undefined;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Round every coordinate to `decimals` places — used by the golden tests, not by the exporter. */
export function roundCommands(cmds: readonly PathCommand[], decimals: number): PathCommand[] {
  const factor = 10 ** decimals;
  return cmds.map((c) => ({ op: c.op, args: c.args.map((v) => Math.round(v * factor) / factor) }));
}
