/**
 * Content-type and dimension sniffing for the bitmaps stored under `images/` in a .fig ZIP
 * (fig-reading-solution.md §9.11 — the bytes are the original PNG/JPEG/GIF/WebP).
 *
 * Byte-level and format-agnostic, so it lives in Layer 1. Dimensions are read from the header
 * only; nothing is decoded.
 */

export interface ImageMeta {
  mime: string;
  extension: string;
  byteLength: number;
  width?: number;
  height?: number;
}

function startsWith(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

/** JPEG dimensions live in the first SOFn marker; walk the segment chain to find it. */
function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) break;
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

function webpSize(buf: Buffer): { width: number; height: number } | undefined {
  const fourcc = buf.toString('latin1', 12, 16);
  if (fourcc === 'VP8X' && buf.length >= 30) {
    return {
      width: (buf.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (buf.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }
  if (fourcc === 'VP8 ' && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

/** Identify image bytes by magic number; unknown content becomes application/octet-stream. */
export function sniffImage(buf: Buffer): ImageMeta {
  const byteLength = buf.length;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    // IHDR is always the first chunk: width/height are big-endian u32 at 16 and 20.
    const dims =
      buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : {};
    return { mime: 'image/png', extension: 'png', byteLength, ...dims };
  }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', extension: 'jpg', byteLength, ...(jpegSize(buf) ?? {}) };
  }
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38])) {
    const dims =
      buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : {};
    return { mime: 'image/gif', extension: 'gif', byteLength, ...dims };
  }
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', extension: 'webp', byteLength, ...(webpSize(buf) ?? {}) };
  }
  if (startsWith(buf, [0x42, 0x4d]) && buf.length >= 26) {
    return {
      mime: 'image/bmp',
      extension: 'bmp',
      byteLength,
      width: buf.readInt32LE(18),
      height: Math.abs(buf.readInt32LE(22)),
    };
  }
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (brand.startsWith('avif')) return { mime: 'image/avif', extension: 'avif', byteLength };
    if (brand.startsWith('heic') || brand.startsWith('mif1')) {
      return { mime: 'image/heic', extension: 'heic', byteLength };
    }
  }
  const head = buf.toString('utf8', 0, Math.min(256, buf.length)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    return { mime: 'image/svg+xml', extension: 'svg', byteLength };
  }
  return { mime: 'application/octet-stream', extension: 'bin', byteLength };
}
