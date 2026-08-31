import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffImage } from '../../dist/fig/imagemeta.js';

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpeg(width: number, height: number): Buffer {
  // SOI, an APP0 segment to prove the walker skips segments, then SOF0 with the dimensions.
  const app0 = Buffer.alloc(2 + 2 + 14);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  const sof = Buffer.alloc(2 + 2 + 5);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(7, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), app0.subarray(1), sof, Buffer.alloc(4)]);
}

test('sniffs PNG with dimensions from IHDR', () => {
  assert.deepEqual(sniffImage(png(88, 84)), {
    mime: 'image/png',
    extension: 'png',
    byteLength: 24,
    width: 88,
    height: 84,
  });
});

test('sniffs JPEG and walks segments to the SOF marker', () => {
  const meta = sniffImage(jpeg(640, 480));
  assert.equal(meta.mime, 'image/jpeg');
  assert.equal(meta.extension, 'jpg');
  assert.equal(meta.width, 640);
  assert.equal(meta.height, 480);
});

test('sniffs GIF, WebP and BMP', () => {
  const gif = Buffer.alloc(10);
  gif.write('GIF89a', 0, 'latin1');
  gif.writeUInt16LE(12, 6);
  gif.writeUInt16LE(34, 8);
  assert.deepEqual(sniffImage(gif), {
    mime: 'image/gif',
    extension: 'gif',
    byteLength: 10,
    width: 12,
    height: 34,
  });

  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBP', 8, 'latin1');
  webp.write('VP8X', 12, 'latin1');
  webp.writeUIntLE(255, 24, 3);
  webp.writeUIntLE(127, 27, 3);
  const webpMeta = sniffImage(webp);
  assert.equal(webpMeta.mime, 'image/webp');
  assert.equal(webpMeta.width, 256);
  assert.equal(webpMeta.height, 128);

  const bmp = Buffer.alloc(26);
  bmp.write('BM', 0, 'latin1');
  bmp.writeInt32LE(64, 18);
  bmp.writeInt32LE(-32, 22); // negative height = top-down bitmap
  const bmpMeta = sniffImage(bmp);
  assert.equal(bmpMeta.mime, 'image/bmp');
  assert.deepEqual([bmpMeta.width, bmpMeta.height], [64, 32]);
});

test('sniffs SVG text and falls back to octet-stream for unknown bytes', () => {
  assert.equal(sniffImage(Buffer.from('  <svg xmlns="..."></svg>')).mime, 'image/svg+xml');
  assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?><svg/>')).mime, 'image/svg+xml');
  assert.deepEqual(sniffImage(Buffer.from([1, 2, 3, 4, 5])), {
    mime: 'application/octet-stream',
    extension: 'bin',
    byteLength: 5,
  });
});

test('truncated headers degrade instead of throwing', () => {
  assert.equal(sniffImage(Buffer.alloc(0)).mime, 'application/octet-stream');
  const shortPng = png(1, 1).subarray(0, 12);
  const meta = sniffImage(shortPng);
  assert.equal(meta.mime, 'image/png');
  assert.equal(meta.width, undefined);
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff])).width, undefined);
});
