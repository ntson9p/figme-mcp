// Negative tests: every sniff point must fail loudly, naming the bytes it actually saw, so a
// future container/codec change is diagnosable from the error alone (solution doc §12).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { parseFig } from '../../dist/fig/parse.js';
import { openContainer, readFigStream, decompressChunk } from '../../dist/fig/container.js';

function figStream(chunks: Buffer[], version = 106): Buffer {
  const parts: Buffer[] = [Buffer.from('fig-kiwi', 'latin1'), Buffer.alloc(4)];
  parts[1]!.writeUInt32LE(version, 0);
  for (const c of chunks) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(c.length, 0);
    parts.push(len, c);
  }
  return Buffer.concat(parts);
}

test('a file that is neither ZIP nor fig-kiwi fails with a hex dump', () => {
  const buf = Buffer.from([0x4e, 0x4f, 0x50, 0x45, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
  assert.throws(() => openContainer(buf), (err: Error) => {
    assert.match(err.message, /not a readable \.fig/);
    assert.match(err.message, /50 4b 03 04/, 'names the ZIP magic it looked for');
    assert.match(err.message, /4e 4f 50 45 00 01 02 03/, 'dumps the bytes it actually saw');
    return true;
  });
  assert.throws(() => parseFig(buf), /not a readable \.fig/);
});

test('an empty file fails loudly rather than silently producing nothing', () => {
  assert.throws(() => parseFig(Buffer.alloc(0)), /not a readable \.fig/);
  assert.throws(() => parseFig(Buffer.from('fig')), /not a readable \.fig/);
});

test('a truncated fig-kiwi header is rejected', () => {
  assert.throws(() => readFigStream(Buffer.from('fig-kiwi', 'latin1')), /bad fig-kiwi magic/);
});

test('a chunk whose length prefix overruns the file names the shortfall', () => {
  const buf = Buffer.concat([figStream([Buffer.alloc(4)])]);
  buf.writeUInt32LE(9999, 12); // claim a chunk far longer than what remains
  assert.throws(() => readFigStream(buf), /chunk 0 overruns file: needs 9999 bytes at 16, only 4 left/);
});

test('a stream with fewer than two chunks is rejected', () => {
  assert.throws(() => readFigStream(figStream([Buffer.alloc(2)])), /expected >= 2 chunks/);
  assert.throws(() => readFigStream(figStream([])), /expected >= 2 chunks/);
});

test('a dangling length prefix at EOF is rejected', () => {
  const buf = Buffer.concat([figStream([Buffer.alloc(1), Buffer.alloc(1)]), Buffer.from([1, 2])]);
  assert.throws(() => readFigStream(buf), /truncated chunk length prefix/);
});

test('an unrecognised codec surfaces the chunk bytes and the sniff result', () => {
  // Random bytes match no codec, so they are passed through as "stored" and blow up in the Kiwi
  // schema decoder. The error must still name the codec guess and the leading bytes.
  const garbage = Buffer.from([0xab, 0xcd, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05]);
  assert.throws(() => parseFig(figStream([garbage, garbage])), (err: Error) => {
    assert.match(err.message, /failed to decode the Kiwi schema \(chunk 0, 8 bytes/);
    assert.match(err.message, /codec sniffed as stored/);
    assert.match(err.message, /first bytes ab cd ef 01/);
    return true;
  });
});

test('a valid schema chunk with a corrupt data chunk points at chunk 1', () => {
  // One ENUM definition is enough for a well-formed schema that has no `Message`.
  const schema = Buffer.from([1, ...Buffer.from('Nope\0', 'latin1'), 0, 0]);
  assert.throws(
    () => parseFig(figStream([zlib.deflateRawSync(schema), Buffer.from([0])])),
    (err: Error) => {
      assert.match(err.message, /failed to decode the Message data \(chunk 1, 1 bytes/);
      assert.match(err.message, /no definition named Message/);
      return true;
    },
  );
});

test('codec sniffing recognises zstd, both deflate flavours and stored', () => {
  const payload = Buffer.from('the quick brown fox'.repeat(10));
  assert.equal(decompressChunk(zlib.zstdCompressSync(payload)).codec, 'zstd');
  assert.deepEqual(decompressChunk(zlib.zstdCompressSync(payload)).data, payload);
  assert.equal(decompressChunk(zlib.deflateRawSync(payload)).codec, 'deflate-raw');
  assert.equal(decompressChunk(zlib.deflateSync(payload)).codec, 'zlib');
  assert.equal(decompressChunk(Buffer.from([0xab, 0xcd, 0xef, 0x77])).codec, 'stored');
  assert.throws(() => decompressChunk(Buffer.alloc(0)), /empty chunk/);
});

test('a ZIP without canvas.fig says which entries it does have', () => {
  // A minimal empty ZIP: end-of-central-directory only, prefixed with a local-header signature
  // so the container sniffs as ZIP.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  eocd.writeUInt32LE(local.length, 16);
  assert.throws(() => openContainer(Buffer.concat([local, eocd])), /ZIP has no canvas.fig|no canvas.fig entry/);
});

test('a ZIP with no end-of-central-directory names the signature it hunted for', () => {
  const buf = Buffer.alloc(64);
  buf.writeUInt32LE(0x04034b50, 0);
  assert.throws(() => openContainer(buf), /50 4B 05 06/);
});
