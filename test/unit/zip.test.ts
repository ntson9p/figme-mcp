import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { ZipArchive, looksLikeZip } from '../../dist/fig/zip.js';

interface Spec {
  name: string;
  content: Buffer;
  deflate: boolean;
  /** Emulate Figma: bit 3 set, zeroed sizes/CRC in the local header, sizes only in the CD. */
  dataDescriptor: boolean;
  localExtra: number;
  centralExtra: number;
}

/** Builds a ZIP by hand so the data-descriptor case can be exercised without a fixture file. */
function makeZip(specs: Spec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const payload = s.deflate ? zlib.deflateRawSync(s.content) : s.content;
    const crc = zlib.crc32(s.content);
    const nameBuf = Buffer.from(s.name, 'utf8');
    const local = Buffer.alloc(30 + nameBuf.length + s.localExtra);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(s.dataDescriptor ? 0x0008 : 0, 6);
    local.writeUInt16LE(s.deflate ? 8 : 0, 8);
    local.writeUInt32LE(s.dataDescriptor ? 0 : crc, 14);
    local.writeUInt32LE(s.dataDescriptor ? 0 : payload.length, 18);
    local.writeUInt32LE(s.dataDescriptor ? 0 : s.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(s.localExtra, 28);
    nameBuf.copy(local, 30);
    const descriptor = s.dataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (s.dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(payload.length, 8);
      descriptor.writeUInt32LE(s.content.length, 12);
    }
    locals.push(local, payload, descriptor);

    const central = Buffer.alloc(46 + nameBuf.length + s.centralExtra);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(s.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(s.content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(s.centralExtra, 30);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + payload.length + descriptor.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const stored = Buffer.from('canvas-bytes-stand-in', 'utf8');
const deflated = Buffer.from(JSON.stringify({ file_name: 'Sample Design' }), 'utf8');

test('reads stored and deflated entries via the central directory', () => {
  const zip = new ZipArchive(
    makeZip([
      { name: 'canvas.fig', content: stored, deflate: false, dataDescriptor: true, localExtra: 0, centralExtra: 0 },
      { name: 'meta.json', content: deflated, deflate: true, dataDescriptor: true, localExtra: 0, centralExtra: 0 },
    ]),
  );
  assert.deepEqual(zip.names(), ['canvas.fig', 'meta.json']);
  assert.equal(zip.size, 2);
  assert.deepEqual(zip.read('canvas.fig'), stored);
  assert.deepEqual(zip.read('meta.json'), deflated);
  assert.equal(zip.read('missing.txt'), undefined);
  assert.equal(zip.has('meta.json'), true);
});

test('data-descriptor entries: local header sizes are zero, central sizes are used', () => {
  const buf = makeZip([
    { name: 'canvas.fig', content: stored, deflate: false, dataDescriptor: true, localExtra: 0, centralExtra: 0 },
  ]);
  // Prove the fixture really is the hostile case: local header CRC and both sizes are zero.
  assert.equal(buf.readUInt32LE(14), 0, 'local CRC should be zero');
  assert.equal(buf.readUInt32LE(18), 0, 'local compressed size should be zero');
  assert.equal(buf.readUInt32LE(22), 0, 'local uncompressed size should be zero');
  const zip = new ZipArchive(buf);
  assert.equal(zip.entry('canvas.fig')?.compressedSize, stored.length);
  assert.deepEqual(zip.read('canvas.fig'), stored);
});

test('data offset uses the LOCAL extra-field length, which differs from the central one', () => {
  const zip = new ZipArchive(
    makeZip([
      { name: 'canvas.fig', content: stored, deflate: false, dataDescriptor: true, localExtra: 9, centralExtra: 0 },
      { name: 'images/aa', content: deflated, deflate: false, dataDescriptor: true, localExtra: 0, centralExtra: 13 },
    ]),
  );
  assert.deepEqual(zip.read('canvas.fig'), stored);
  assert.deepEqual(zip.read('images/aa'), deflated);
});

test('looksLikeZip sniffs PK\x03\x04 only', () => {
  assert.equal(looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04])), true);
  assert.equal(looksLikeZip(Buffer.from('fig-kiwi', 'utf8')), false);
  assert.equal(looksLikeZip(Buffer.alloc(2)), false);
});

test('a missing end-of-central-directory fails loudly', () => {
  assert.throws(() => new ZipArchive(Buffer.alloc(100)), /end-of-central-directory/);
});
