#!/usr/bin/env node
// fig2json.mjs — dependency-free reader for local Figma `.fig` files.
//
// A `.fig` file is either:
//   (a) a ZIP archive containing `canvas.fig` (+ meta.json, thumbnail.png, images/<sha1>), or
//   (b) a bare `fig-kiwi` stream (older exports).
// The `fig-kiwi` stream is:
//   "fig-kiwi" magic (8 bytes) | u32 LE version | repeated { u32 LE size | chunk bytes }
//   chunk[0] = Kiwi *binary schema* (compressed), chunk[1] = Kiwi-encoded `Message` (compressed).
// Compression per chunk is sniffed: zstd (magic 28 B5 2F FD), raw deflate, zlib, or stored.
// The data chunk is decoded against the schema embedded in the SAME file, so field additions
// by Figma never break decoding. Kiwi reference: https://github.com/evanw/kiwi
//
// Usage: node fig2json.mjs <file.fig> [outdir]

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- ByteBuffer
class BB {
  constructor(buf) { this.b = buf; this.i = 0; }
  get remaining() { return this.b.length - this.i; }
  byte() {
    if (this.i >= this.b.length) throw new Error(`read past end at ${this.i}`);
    return this.b[this.i++];
  }
  bytes(n) {
    if (this.i + n > this.b.length) throw new Error(`read past end at ${this.i}+${n}`);
    const s = this.b.subarray(this.i, this.i + n); this.i += n; return s;
  }
  // Unsigned LEB128, max 5 bytes (32-bit) — mirrors kiwi readVarUint
  varUint() {
    let value = 0, shift = 0, b;
    do { b = this.byte(); value |= (b & 127) << shift; shift += 7; } while (b & 128 && shift < 35);
    return value >>> 0;
  }
  // Zigzag-encoded signed — mirrors kiwi readVarInt
  varInt() { const v = this.varUint() | 0; return v & 1 ? ~(v >>> 1) : v >>> 1; }
  varUint64() {
    let value = 0n, shift = 0n;
    while (true) {
      const b = this.byte();
      if (shift === 56n) { value |= BigInt(b) << 56n; break; } // 9th byte carries full 8 bits
      value |= BigInt(b & 127) << shift;
      if (!(b & 128)) break;
      shift += 7n;
    }
    return value;
  }
  varInt64() { const v = this.varUint64(); return v & 1n ? ~(v >> 1n) : v >> 1n; }
  // Kiwi float: single 0x00 byte for 0.0, else 4 bytes bit-rotated so the exponent lands
  // in the first byte (better entropy for compression) — mirrors kiwi readVarFloat
  varFloat() {
    const first = this.byte();
    if (first === 0) return 0;
    const b2 = this.byte(), b3 = this.byte(), b4 = this.byte();
    let bits = first | (b2 << 8) | (b3 << 16) | (b4 << 24);
    bits = (bits << 23) | (bits >>> 9);
    F32_INT[0] = bits;
    return F32[0];
  }
  string() {
    const end = this.b.indexOf(0, this.i);
    if (end < 0) throw new Error('unterminated string');
    const s = this.b.toString('utf8', this.i, end);
    this.i = end + 1;
    return s;
  }
}
const F32_INT = new Int32Array(1);
const F32 = new Float32Array(F32_INT.buffer);

// ---------------------------------------------------------------- minimal ZIP reader
function readZip(buf) {
  const min = Math.max(0, buf.length - 65558); // EOCD max distance from EOF
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: end-of-central-directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP: bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataOff = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(dataOff, dataOff + compSize);
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------------------------------------------------------------- chunk codec sniffing
function decompressChunk(chunk) {
  if (chunk.length >= 4 && chunk.readUInt32LE(0) === 0xfd2fb528) {
    return { data: zlib.zstdDecompressSync(chunk), codec: 'zstd' };
  }
  try { return { data: zlib.inflateRawSync(chunk), codec: 'deflate-raw' }; } catch {}
  try { return { data: zlib.inflateSync(chunk), codec: 'zlib' }; } catch {}
  return { data: chunk, codec: 'stored' };
}

// ---------------------------------------------------------------- Kiwi binary schema
const BUILTINS = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];
const KINDS = ['ENUM', 'STRUCT', 'MESSAGE'];

function decodeBinarySchema(buf) {
  const bb = new BB(buf);
  const count = bb.varUint();
  const defs = [];
  for (let i = 0; i < count; i++) {
    const name = bb.string();
    const kind = KINDS[bb.byte()];
    const fieldCount = bb.varUint();
    const fields = [];
    for (let j = 0; j < fieldCount; j++) {
      fields.push({
        name: bb.string(),
        type: bb.varInt(),      // >= 0: index into defs; < 0: BUILTINS[~type]
        isArray: !!(bb.byte() & 1),
        value: bb.varUint(),    // field id (MESSAGE) or enum value (ENUM)
      });
    }
    defs.push({ name, kind, fields });
  }
  if (bb.remaining !== 0) throw new Error(`schema: ${bb.remaining} trailing bytes`);
  return defs;
}

function schemaToText(defs) {
  const typeName = (t) => (t < 0 ? BUILTINS[~t] : defs[t].name);
  const out = [];
  for (const d of defs) {
    out.push(`${d.kind.toLowerCase()} ${d.name} {`);
    for (const f of d.fields) {
      out.push(d.kind === 'ENUM'
        ? `  ${f.name} = ${f.value};`
        : `  ${typeName(f.type)}${f.isArray ? '[]' : ''} ${f.name} = ${f.value};`);
    }
    out.push('}', '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- Kiwi data decoding
function makeDecoder(defs) {
  const byName = new Map(defs.map((d) => [d.name, d]));
  for (const d of defs) d.fieldById = new Map(d.fields.map((f) => [f.value, f]));

  function decodeType(bb, type) {
    if (type < 0) {
      switch (BUILTINS[~type]) {
        case 'bool': return bb.byte() !== 0;
        case 'byte': return bb.byte();
        case 'int': return bb.varInt();
        case 'uint': return bb.varUint();
        case 'float': return bb.varFloat();
        case 'string': return bb.string();
        case 'int64': return bb.varInt64();
        case 'uint64': return bb.varUint64();
      }
    }
    const def = defs[type];
    if (def.kind === 'ENUM') {
      const v = bb.varUint();
      const f = def.fields.find((f) => f.value === v);
      return f ? f.name : v; // tolerate unknown enum values instead of throwing
    }
    return decodeDef(bb, def);
  }

  function readField(bb, f) {
    if (f.isArray) {
      const len = bb.varUint();
      // byte[] is length-prefixed raw bytes; plain Uint8Array (not Buffer) so
      // JSON.stringify replacers see the bytes rather than Buffer#toJSON output
      if (f.type === ~BUILTINS.indexOf('byte')) return new Uint8Array(bb.bytes(len));
      const arr = new Array(len);
      for (let k = 0; k < len; k++) arr[k] = decodeType(bb, f.type);
      return arr;
    }
    return decodeType(bb, f.type);
  }

  function decodeDef(bb, def) {
    const obj = {};
    if (def.kind === 'STRUCT') {
      for (const f of def.fields) obj[f.name] = readField(bb, f); // structs: every field, in order
      return obj;
    }
    for (;;) { // messages: (varuint field-id, value)* terminated by 0
      const tag = bb.varUint();
      if (tag === 0) return obj;
      const f = def.fieldById.get(tag);
      if (!f) throw new Error(`unknown field id ${tag} in ${def.name} at byte ${bb.i}`);
      obj[f.name] = readField(bb, f);
    }
  }

  return {
    decode(rootName, buf) {
      const def = byName.get(rootName);
      if (!def) throw new Error(`no definition named ${rootName}`);
      const bb = new BB(buf);
      const result = decodeDef(bb, def);
      if (bb.remaining !== 0) throw new Error(`data: ${bb.remaining} trailing bytes`);
      return result;
    },
  };
}

// ---------------------------------------------------------------- .fig container
export function parseFig(buf) {
  let zip = null;
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) { // 'PK\x03\x04'
    zip = readZip(buf);
    buf = zip.get('canvas.fig');
    if (!buf) throw new Error('ZIP has no canvas.fig');
  }
  if (buf.toString('latin1', 0, 8) !== 'fig-kiwi') {
    throw new Error(`bad magic: ${JSON.stringify(buf.toString('latin1', 0, 8))}`);
  }
  const version = buf.readUInt32LE(8);
  const chunks = [];
  for (let off = 12; off < buf.length; ) {
    const size = buf.readUInt32LE(off); off += 4;
    if (off + size > buf.length) throw new Error('chunk overruns file');
    chunks.push(buf.subarray(off, off + size)); off += size;
  }
  if (chunks.length < 2) throw new Error(`expected >=2 chunks, got ${chunks.length}`);
  const schemaChunk = decompressChunk(chunks[0]);
  const dataChunk = decompressChunk(chunks[1]);
  const schema = decodeBinarySchema(schemaChunk.data);
  const message = makeDecoder(schema).decode('Message', dataChunk.data);
  return { zip, version, chunks, schemaChunk, dataChunk, schema, message };
}

// ---------------------------------------------------------------- node tree
const guidKey = (g) => `${g.sessionID}:${g.localID}`;

export function buildTree(message) {
  const nodes = new Map();
  for (const nc of message.nodeChanges ?? []) {
    nodes.set(guidKey(nc.guid), { node: nc, children: [] });
  }
  let root = null;
  const orphans = [];
  for (const entry of nodes.values()) {
    const pi = entry.node.parentIndex;
    const parent = pi && nodes.get(guidKey(pi.guid));
    if (parent) parent.children.push(entry);
    else if (entry.node.type === 'DOCUMENT') root = entry;
    else orphans.push(entry);
  }
  for (const entry of nodes.values()) {
    // Sibling order = lexicographic compare of the fractional-index position strings
    entry.children.sort((a, b) => {
      const pa = a.node.parentIndex.position, pb = b.node.parentIndex.position;
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }
  return { root, orphans, nodes };
}

// ---------------------------------------------------------------- JSON serialization
function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) {
    return value.length <= 64
      ? { $bytes: Buffer.from(value).toString('hex') }
      : { $bytes: Buffer.from(value.subarray(0, 24)).toString('hex') + '…', $byteLength: value.length };
  }
  return value;
}

function treeToJson(entry) {
  const { guid, parentIndex, ...rest } = entry.node;
  return {
    guid: guidKey(guid),
    ...JSON.parse(JSON.stringify(rest, jsonReplacer)),
    children: entry.children.map(treeToJson),
  };
}

// ---------------------------------------------------------------- CLI
function main() {
  const [input, outdir = '.'] = process.argv.slice(2);
  if (!input) { console.error('usage: node fig2json.mjs <file.fig> [outdir]'); process.exit(1); }
  fs.mkdirSync(outdir, { recursive: true });

  const raw = fs.readFileSync(input);
  const fig = parseFig(raw);
  const { zip, version, chunks, schemaChunk, dataChunk, schema, message } = fig;

  console.log(`container      : ${zip ? 'ZIP (canvas.fig + ' + [...zip.keys()].filter((n) => n !== 'canvas.fig').length + ' other entries)' : 'bare fig-kiwi stream'}`);
  console.log(`header version : ${version}`);
  chunks.forEach((c, i) => {
    const info = i === 0 ? schemaChunk : i === 1 ? dataChunk : decompressChunk(c);
    console.log(`chunk ${i}        : ${c.length} bytes -> ${info.data.length} bytes (${info.codec})`);
  });
  console.log(`schema         : ${schema.length} definitions (${schema.filter((d) => d.kind === 'MESSAGE').length} messages, ${schema.filter((d) => d.kind === 'STRUCT').length} structs, ${schema.filter((d) => d.kind === 'ENUM').length} enums)`);
  console.log(`message keys   : ${Object.keys(message).join(', ')}`);
  console.log(`message.type   : ${message.type}`);
  console.log(`nodeChanges    : ${message.nodeChanges?.length ?? 0} nodes, blobs: ${message.blobs?.length ?? 0}`);

  const { root, orphans } = buildTree(message);
  const counts = {};
  for (const nc of message.nodeChanges ?? []) counts[nc.type] = (counts[nc.type] ?? 0) + 1;
  console.log(`node types     : ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(' ')}`);
  console.log(`orphan nodes   : ${orphans.length}`);

  if (root) {
    console.log(`\ndocument "${root.node.name ?? ''}" pages:`);
    for (const page of root.children) {
      console.log(`  [${page.node.type}] "${page.node.name}" — ${page.children.length} top-level children`);
      for (const child of page.children.slice(0, 5)) {
        const s = child.node.size ? ` ${child.node.size.x}x${child.node.size.y}` : '';
        console.log(`      [${child.node.type}]${s} "${child.node.name}"`);
      }
      if (page.children.length > 5) console.log(`      … ${page.children.length - 5} more`);
    }
  }

  // Text samples — proves textData decoding
  const texts = (message.nodeChanges ?? []).filter((n) => n.type === 'TEXT' && n.textData?.characters).slice(0, 8);
  console.log(`\ntext samples:`);
  for (const t of texts) console.log(`  "${t.name}" => ${JSON.stringify(t.textData.characters.slice(0, 60))}`);

  // Image hash cross-check — proves paint.image.hash === images/<sha1> filename
  if (zip) {
    const zipImages = new Set([...zip.keys()].filter((n) => n.startsWith('images/') && n.length > 8).map((n) => n.slice(7)));
    const referenced = new Set();
    for (const nc of message.nodeChanges ?? []) {
      for (const paint of [...(nc.fillPaints ?? []), ...(nc.strokePaints ?? [])]) {
        const hash = paint.image?.hash?.$bytes ?? paint.image?.hash;
        if (hash instanceof Uint8Array) referenced.add(Buffer.from(hash).toString('hex'));
      }
    }
    const matched = [...referenced].filter((h) => zipImages.has(h)).length;
    console.log(`\nimage paints   : ${referenced.size} unique hashes referenced; ${matched} found in zip images/ (${zipImages.size} files in zip)`);
  }

  // Artifacts. The full decoded message is too big for one JSON.stringify call
  // (63MB binary -> >512MB of pretty JSON), so nodes go out as NDJSON in batches.
  fs.writeFileSync(path.join(outdir, 'schema.kiwi.txt'), schemaToText(schema));

  const ndjsonPath = path.join(outdir, 'nodes.ndjson');
  fs.writeFileSync(ndjsonPath, '');
  const lines = [];
  const flush = () => { fs.appendFileSync(ndjsonPath, lines.join('\n') + '\n'); lines.length = 0; };
  for (const nc of message.nodeChanges ?? []) {
    lines.push(JSON.stringify(nc, jsonReplacer));
    if (lines.length >= 4000) flush();
  }
  if (lines.length) flush();

  if (root) {
    const outline = [];
    const walk = (entry, depth) => {
      const n = entry.node;
      const sz = n.size ? ` ${Math.round(n.size.x)}x${Math.round(n.size.y)}` : '';
      outline.push(`${'  '.repeat(depth)}[${n.type}]${sz} ${JSON.stringify(n.name ?? '')}`);
      for (const c of entry.children) walk(c, depth + 1);
    };
    walk(root, 0);
    fs.writeFileSync(path.join(outdir, 'tree-outline.txt'), outline.join('\n'));
  }
  if (zip?.get('meta.json')) fs.writeFileSync(path.join(outdir, 'meta.json'), zip.get('meta.json'));
  console.log(`\nwrote ${outdir}/{schema.kiwi.txt, nodes.ndjson, tree-outline.txt${zip ? ', meta.json' : ''}}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
