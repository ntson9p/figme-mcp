import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeBinarySchema, makeDecoder, schemaToText } from '../../dist/fig/kiwi.js';

/** Minimal Kiwi writer, transcribed from github.com/evanw/kiwi, for building fixtures. */
class Writer {
  private out: number[] = [];
  private readonly f32 = new Float32Array(1);
  private readonly i32 = new Int32Array(this.f32.buffer);

  byte(v: number): this {
    this.out.push(v & 255);
    return this;
  }
  varUint(v: number): this {
    let x = v >>> 0;
    do {
      const b = x & 127;
      x >>>= 7;
      this.out.push(x ? b | 128 : b);
    } while (x);
    return this;
  }
  varInt(v: number): this {
    return this.varUint(((v << 1) ^ (v >> 31)) >>> 0);
  }
  varFloat(v: number): this {
    this.f32[0] = v;
    let bits = ((this.i32[0]! >>> 23) | (this.i32[0]! << 9)) >>> 0;
    if ((bits & 255) === 0) return this.byte(0);
    return this.byte(bits).byte(bits >>> 8).byte(bits >>> 16).byte(bits >>> 24);
  }
  string(s: string): this {
    for (const b of Buffer.from(s, 'utf8')) this.out.push(b);
    this.out.push(0);
    return this;
  }
  raw(bytes: number[]): this {
    this.out.push(...bytes);
    return this;
  }
  buffer(): Buffer {
    return Buffer.from(this.out);
  }
}

const BOOL = ~0, BYTE = ~1, INT = ~2, UINT = ~3, FLOAT = ~4, STRING = ~5, INT64 = ~6, UINT64 = ~7;
const ENUM = 0, STRUCT = 1, MESSAGE = 2;
const COLOR = 0, VEC = 1, THING = 2;

/** ENUM Color, STRUCT Vec, MESSAGE Thing — a miniature of the real schema's shape. */
function fixtureSchema(): Buffer {
  const w = new Writer();
  w.varUint(3);
  w.string('Color').byte(ENUM).varUint(2);
  w.string('RED').varInt(0).byte(0).varUint(0);
  w.string('GREEN').varInt(0).byte(0).varUint(7);
  w.string('Vec').byte(STRUCT).varUint(2);
  w.string('x').varInt(FLOAT).byte(0).varUint(0);
  w.string('y').varInt(FLOAT).byte(0).varUint(1);
  w.string('Thing').byte(MESSAGE).varUint(9);
  w.string('id').varInt(UINT).byte(0).varUint(1);
  w.string('name').varInt(STRING).byte(0).varUint(2);
  w.string('pos').varInt(VEC).byte(0).varUint(3);
  w.string('color').varInt(COLOR).byte(0).varUint(4);
  w.string('blob').varInt(BYTE).byte(1).varUint(5);
  w.string('nums').varInt(INT).byte(1).varUint(6);
  w.string('kids').varInt(THING).byte(1).varUint(7);
  w.string('flag').varInt(BOOL).byte(0).varUint(8);
  w.string('big').varInt(INT64).byte(0).varUint(9);
  return w.buffer();
}

const schema = decodeBinarySchema(fixtureSchema());

test('decodeBinarySchema reads names, kinds, field types, array flags and ids', () => {
  assert.equal(schema.length, 3);
  assert.deepEqual(
    schema.map((d) => [d.name, d.kind, d.fields.length]),
    [
      ['Color', 'ENUM', 2],
      ['Vec', 'STRUCT', 2],
      ['Thing', 'MESSAGE', 9],
    ],
  );
  assert.deepEqual(schema[0]!.fields[1], { name: 'GREEN', type: 0, isArray: false, value: 7 });
  assert.equal(schema[2]!.fields[4]!.isArray, true);
  assert.equal(schema[2]!.fields[4]!.type, BYTE);
});

test('schema decode rejects trailing bytes', () => {
  const buf = Buffer.concat([fixtureSchema(), Buffer.from([0])]);
  assert.throws(() => decodeBinarySchema(buf), /trailing bytes/);
});

test('schemaToText renders the schema as Kiwi source', () => {
  const text = schemaToText(schema);
  assert.match(text, /enum Color \{\n {2}RED = 0;\n {2}GREEN = 7;\n\}/);
  assert.match(text, /struct Vec \{\n {2}float x = 0;\n {2}float y = 1;\n\}/);
  assert.match(text, /message Thing \{[\s\S]*byte\[\] blob = 5;/);
  assert.match(text, /Thing\[\] kids = 7;/);
});

test('message decode: tags, structs, enums, arrays, nesting, exact consumption', () => {
  const w = new Writer();
  w.varUint(1).varUint(7); // id = 7
  w.varUint(2).string('hello'); // name
  w.varUint(3).varFloat(1.5).varFloat(-2); // pos: struct, positional, no tags
  w.varUint(4).varUint(7); // color = GREEN
  w.varUint(5).varUint(3).raw([0xde, 0xad, 0xbe]); // blob: byte[] is length + raw bytes
  w.varUint(6).varUint(3).varInt(-1).varInt(0).varInt(5); // nums
  w.varUint(7).varUint(1).varUint(1).varUint(2).varUint(0); // kids: [ Thing{id:2} ]
  w.varUint(8).byte(1); // flag
  w.varUint(9).varUint(0b101); // big: zigzag(-3) -> 5
  w.varUint(0); // end of message

  const decoded = makeDecoder(schema).decode('Thing', w.buffer());
  assert.equal(decoded['id'], 7);
  assert.equal(decoded['name'], 'hello');
  assert.deepEqual(decoded['pos'], { x: 1.5, y: -2 });
  assert.equal(decoded['color'], 'GREEN');
  assert.deepEqual(decoded['nums'], [-1, 0, 5]);
  assert.deepEqual(decoded['kids'], [{ id: 2 }]);
  assert.equal(decoded['flag'], true);
  assert.equal(decoded['big'], -3n);
  // Unset fields must be absent, not zero.
  assert.equal('missing' in decoded, false);
});

test('byte[] decodes to a plain Uint8Array, never a Buffer (Buffer#toJSON pitfall)', () => {
  const w = new Writer();
  w.varUint(5).varUint(2).raw([1, 2]).varUint(0);
  const blob = makeDecoder(schema).decode('Thing', w.buffer())['blob'];
  assert.ok(blob instanceof Uint8Array);
  assert.equal(Buffer.isBuffer(blob), false);
  assert.equal(JSON.stringify({ blob }), '{"blob":{"0":1,"1":2}}');
});

test('unknown enum values survive as raw numbers', () => {
  const w = new Writer();
  w.varUint(4).varUint(99).varUint(0);
  assert.equal(makeDecoder(schema).decode('Thing', w.buffer())['color'], 99);
});

test('unknown field ids and trailing data are hard errors', () => {
  const bad = new Writer().varUint(42).varUint(1).varUint(0).buffer();
  assert.throws(() => makeDecoder(schema).decode('Thing', bad), /unknown field id 42 in Thing/);
  const trailing = new Writer().varUint(0).byte(0).buffer();
  assert.throws(() => makeDecoder(schema).decode('Thing', trailing), /trailing bytes/);
  assert.throws(() => makeDecoder(schema).decode('Nope', Buffer.alloc(1)), /no definition named/);
});
