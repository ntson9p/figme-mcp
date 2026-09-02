// PNG pixel helpers shared by the golden render tests and the visual tester. Not a test file.
//
// Everything decodes the PNG bytes with pngjs, never resvg's `pixels` buffer: that buffer is
// premultiplied (plan Appendix E, R5), so mixing the two would compare different colour spaces.
import { PNG } from 'pngjs';

export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** Straight-alpha RGBA, 4 bytes per pixel, row-major. */
  readonly data: Buffer;
}

export function decodePng(bytes: Uint8Array | Buffer): Pixels {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: png.data };
}

export function encodePng(p: Pixels): Buffer {
  const png = new PNG({ width: p.width, height: p.height });
  p.data.copy(png.data);
  return PNG.sync.write(png);
}

export type Rgba = [number, number, number, number];

export function pixelAt(p: Pixels, x: number, y: number): Rgba {
  if (x < 0 || y < 0 || x >= p.width || y >= p.height) {
    throw new Error(`pixel (${x},${y}) is outside a ${p.width}x${p.height} image`);
  }
  const i = (y * p.width + x) * 4;
  return [p.data[i]!, p.data[i + 1]!, p.data[i + 2]!, p.data[i + 3]!];
}

export function alphaAt(p: Pixels, x: number, y: number): number {
  return pixelAt(p, x, y)[3];
}

/** "Ink" is any pixel more opaque than `threshold` — the default ignores faint anti-aliasing. */
export function inkRows(p: Pixels, threshold = 32): number[] {
  const rows: number[] = [];
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      if (p.data[(y * p.width + x) * 4 + 3]! > threshold) {
        rows.push(y);
        break;
      }
    }
  }
  return rows;
}

export function inkColumns(p: Pixels, threshold = 32): number[] {
  const cols: number[] = [];
  for (let x = 0; x < p.width; x++) {
    for (let y = 0; y < p.height; y++) {
      if (p.data[(y * p.width + x) * 4 + 3]! > threshold) {
        cols.push(x);
        break;
      }
    }
  }
  return cols;
}

export interface InkBounds {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Bounding box of every inked pixel, inclusive; undefined for a fully transparent image. */
export function inkBounds(p: Pixels, threshold = 32): InkBounds | undefined {
  const rows = inkRows(p, threshold);
  const cols = inkColumns(p, threshold);
  if (rows.length === 0 || cols.length === 0) return undefined;
  return { x0: cols[0]!, y0: rows[0]!, x1: cols[cols.length - 1]!, y1: rows[rows.length - 1]! };
}

/** Fraction of pixels with alpha above the threshold. */
export function inkRatio(p: Pixels, threshold = 32): number {
  let n = 0;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i]! > threshold) n++;
  return n / (p.width * p.height);
}
