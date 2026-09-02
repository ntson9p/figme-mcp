// Pixel comparison for the visual tester (render-implementation-plan.md §9.3). Not a test file.
//
// Both sides always arrive as decoded PNG bytes, never resvg's `pixels` buffer, which is
// premultiplied (Appendix E, R5).
import pixelmatch from 'pixelmatch';
import { encodePng, type Pixels } from './png.ts';

export interface CompareOptions {
  /** Opaque colour both images are composited onto before comparing. Default white. */
  readonly background?: [number, number, number];
  /** Halve both images first — at 2x this removes most anti-aliasing noise. Default true. */
  readonly downscale?: boolean;
  /** pixelmatch colour tolerance, 0..1. Default 0.1. */
  readonly threshold?: number;
}

export interface CompareResult {
  readonly status: 'ok' | 'size-mismatch';
  readonly ours?: { width: number; height: number };
  readonly theirs?: { width: number; height: number };
  readonly diffPixels?: number;
  readonly diffRatio?: number;
  /** 8x8 blocks in which more than half the pixels differ — clustered noise, not edge noise. */
  readonly badBlocks?: number;
  readonly width?: number;
  readonly height?: number;
  readonly diffPng?: Buffer;
}

/** Composite straight-alpha RGBA onto an opaque background so alpha differences show as colour. */
function flatten(p: Pixels, bg: [number, number, number]): Pixels {
  const out = Buffer.allocUnsafe(p.width * p.height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = p.data[i + 3]! / 255;
    out[i] = Math.round(p.data[i]! * a + bg[0] * (1 - a));
    out[i + 1] = Math.round(p.data[i + 1]! * a + bg[1] * (1 - a));
    out[i + 2] = Math.round(p.data[i + 2]! * a + bg[2] * (1 - a));
    out[i + 3] = 255;
  }
  return { width: p.width, height: p.height, data: out };
}

function crop(p: Pixels, width: number, height: number): Pixels {
  if (p.width === width && p.height === height) return p;
  const out = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    p.data.copy(out, y * width * 4, (y * p.width) * 4, (y * p.width + width) * 4);
  }
  return { width, height, data: out };
}

/** 2x2 box filter. Odd trailing rows/columns are dropped, which is fine for a comparison. */
function halve(p: Pixels): Pixels {
  const width = Math.max(1, p.width >> 1);
  const height = Math.max(1, p.height >> 1);
  const out = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        const a = p.data[((2 * y) * p.width + 2 * x) * 4 + c]!;
        const b = p.data[((2 * y) * p.width + 2 * x + 1) * 4 + c]!;
        const d = p.data[((2 * y + 1) * p.width + 2 * x) * 4 + c]!;
        const e = p.data[((2 * y + 1) * p.width + 2 * x + 1) * 4 + c]!;
        out[(y * width + x) * 4 + c] = (a + b + d + e + 2) >> 2;
      }
    }
  }
  return { width, height, data: out };
}

export const SIZE_TOLERANCE = 2;

export function compare(ours: Pixels, theirs: Pixels, opts: CompareOptions = {}): CompareResult {
  const bg = opts.background ?? [255, 255, 255];

  if (
    Math.abs(ours.width - theirs.width) > SIZE_TOLERANCE ||
    Math.abs(ours.height - theirs.height) > SIZE_TOLERANCE
  ) {
    return {
      status: 'size-mismatch',
      ours: { width: ours.width, height: ours.height },
      theirs: { width: theirs.width, height: theirs.height },
    };
  }

  const width = Math.min(ours.width, theirs.width);
  const height = Math.min(ours.height, theirs.height);
  let a = crop(flatten(ours, bg), width, height);
  let b = crop(flatten(theirs, bg), width, height);
  if (opts.downscale !== false && width >= 2 && height >= 2) {
    a = halve(a);
    b = halve(b);
  }

  const diff = Buffer.allocUnsafe(a.width * a.height * 4);
  const diffPixels = pixelmatch(a.data, b.data, diff, a.width, a.height, {
    threshold: opts.threshold ?? 0.1,
    includeAA: false,
  });

  // Count 8x8 blocks where more than half the pixels differ: a cluster is a real defect,
  // scattered single pixels are usually anti-aliasing the threshold did not catch.
  let badBlocks = 0;
  for (let by = 0; by < a.height; by += 8) {
    for (let bx = 0; bx < a.width; bx += 8) {
      let n = 0;
      let total = 0;
      for (let y = by; y < Math.min(by + 8, a.height); y++) {
        for (let x = bx; x < Math.min(bx + 8, a.width); x++) {
          total++;
          if (diff[(y * a.width + x) * 4]! > 0 || diff[(y * a.width + x) * 4 + 1]! > 0) n++;
        }
      }
      if (total > 0 && n * 2 > total) badBlocks++;
    }
  }

  return {
    status: 'ok',
    ours: { width: ours.width, height: ours.height },
    theirs: { width: theirs.width, height: theirs.height },
    diffPixels,
    diffRatio: diffPixels / (a.width * a.height),
    badBlocks,
    width: a.width,
    height: a.height,
    diffPng: encodePng({ width: a.width, height: a.height, data: diff }),
  };
}

/** The diff mask as a boolean grid, for attribution (§9.5). */
export function diffMask(diffPng: Pixels): boolean[] {
  const mask: boolean[] = new Array(diffPng.width * diffPng.height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = diffPng.data[i * 4]! > 0 || diffPng.data[i * 4 + 1]! > 0;
  }
  return mask;
}
