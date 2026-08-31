/**
 * Kiwi binary-schema decoding and schema-driven data decoding
 * (fig-reading-solution.md §5 and §6).
 *
 * The schema ships inside the .fig file, so nothing here hardcodes a field id or a type name.
 * That is precisely what makes the reader survive Figma's unannounced schema changes.
 */
import { ByteBuffer } from './bytebuffer.js';

export const BUILTINS = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'] as const;

const KINDS = ['ENUM', 'STRUCT', 'MESSAGE'] as const;
export type DefKind = (typeof KINDS)[number];

/** ~type for the `byte` builtin — the one array type with raw length-prefixed bytes. */
const BYTE_TYPE = ~BUILTINS.indexOf('byte');

export interface KiwiField {
  readonly name: string;
  /** >= 0: index into the definition table; < 0: builtin, index = ~type. */
  readonly type: number;
  readonly isArray: boolean;
  /** MESSAGE: wire field id. ENUM: the enum member's numeric value. STRUCT: unused. */
  readonly value: number;
}

export interface KiwiDefinition {
  readonly name: string;
  readonly kind: DefKind;
  readonly fields: readonly KiwiField[];
  /** MESSAGE only: field id → field. Built once at decode time. */
  fieldById?: Map<number, KiwiField>;
  /** ENUM only: numeric value → member name. Built once at decode time. */
  enumByValue?: Map<number, string>;
}

export type KiwiSchema = readonly KiwiDefinition[];

/** Anything a decoded Kiwi value can be. `byte[]` fields decode to plain Uint8Array. */
export type KiwiValue =
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | KiwiValue[]
  | KiwiObject;
export interface KiwiObject {
  [key: string]: KiwiValue | undefined;
}

/** Decode chunk 0 (decompressed) — the binary schema. */
export function decodeBinarySchema(buf: Buffer): KiwiDefinition[] {
  const bb = new ByteBuffer(buf);
  const count = bb.varUint();
  const defs: KiwiDefinition[] = [];
  for (let i = 0; i < count; i++) {
    const name = bb.string();
    const kindByte = bb.byte();
    const kind = KINDS[kindByte];
    if (!kind) throw new Error(`schema: definition "${name}" has unknown kind byte ${kindByte}`);
    const fieldCount = bb.varUint();
    const fields: KiwiField[] = [];
    for (let j = 0; j < fieldCount; j++) {
      fields.push({
        name: bb.string(),
        type: bb.varInt(),
        isArray: !!(bb.byte() & 1),
        value: bb.varUint(),
      });
    }
    defs.push({ name, kind, fields });
  }
  if (bb.remaining !== 0) throw new Error(`schema: ${bb.remaining} trailing bytes`);
  return defs;
}

/** Render a decoded schema as Kiwi source text — the authoritative field reference. */
export function schemaToText(defs: KiwiSchema): string {
  const typeName = (t: number): string => (t < 0 ? BUILTINS[~t]! : (defs[t]?.name ?? `#${t}`));
  const out: string[] = [];
  for (const d of defs) {
    out.push(`${d.kind.toLowerCase()} ${d.name} {`);
    for (const f of d.fields) {
      out.push(
        d.kind === 'ENUM'
          ? `  ${f.name} = ${f.value};`
          : `  ${typeName(f.type)}${f.isArray ? '[]' : ''} ${f.name} = ${f.value};`,
      );
    }
    out.push('}', '');
  }
  return out.join('\n');
}

export interface KiwiDecoder {
  /** Decode `buf` as the definition named `rootName`; asserts exact byte consumption. */
  decode(rootName: string, buf: Buffer): KiwiObject;
  readonly definitions: KiwiSchema;
}

export function makeDecoder(defs: KiwiSchema): KiwiDecoder {
  const byName = new Map<string, KiwiDefinition>();
  for (const d of defs) {
    byName.set(d.name, d);
    if (d.kind === 'MESSAGE') d.fieldById = new Map(d.fields.map((f) => [f.value, f]));
    else if (d.kind === 'ENUM') d.enumByValue = new Map(d.fields.map((f) => [f.value, f.name]));
  }

  function decodeType(bb: ByteBuffer, type: number): KiwiValue {
    if (type < 0) {
      switch (BUILTINS[~type]) {
        case 'bool':
          return bb.byte() !== 0;
        case 'byte':
          return bb.byte();
        case 'int':
          return bb.varInt();
        case 'uint':
          return bb.varUint();
        case 'float':
          return bb.varFloat();
        case 'string':
          return bb.string();
        case 'int64':
          return bb.varInt64();
        case 'uint64':
          return bb.varUint64();
        default:
          throw new Error(`unknown builtin type ${type} at byte ${bb.i}`);
      }
    }
    const def = defs[type];
    if (!def) throw new Error(`type index ${type} out of range at byte ${bb.i}`);
    if (def.kind === 'ENUM') {
      const v = bb.varUint();
      // New enum members appear over time; surface the raw number rather than throwing.
      return def.enumByValue?.get(v) ?? v;
    }
    return decodeDef(bb, def);
  }

  function readField(bb: ByteBuffer, f: KiwiField): KiwiValue {
    if (f.isArray) {
      const len = bb.varUint();
      // byte[] is a length prefix followed by raw bytes. Copy into a plain Uint8Array: a Buffer
      // view would (a) pin the whole decompressed chunk and (b) hijack JSON.stringify through
      // Buffer#toJSON before any replacer runs.
      if (f.type === BYTE_TYPE) return new Uint8Array(bb.bytes(len));
      const arr = new Array<KiwiValue>(len);
      for (let k = 0; k < len; k++) arr[k] = decodeType(bb, f.type);
      return arr;
    }
    return decodeType(bb, f.type);
  }

  function decodeDef(bb: ByteBuffer, def: KiwiDefinition): KiwiObject {
    const obj: KiwiObject = {};
    if (def.kind === 'STRUCT') {
      // Structs are positional: every field, in schema order, no tags, no terminator.
      for (const f of def.fields) obj[f.name] = readField(bb, f);
      return obj;
    }
    for (;;) {
      // Messages are (varuint field-id, value)* terminated by id 0; unset fields are absent.
      const tag = bb.varUint();
      if (tag === 0) return obj;
      const f = def.fieldById?.get(tag);
      if (!f) throw new Error(`unknown field id ${tag} in ${def.name} at byte ${bb.i}`);
      obj[f.name] = readField(bb, f);
    }
  }

  return {
    definitions: defs,
    decode(rootName: string, buf: Buffer): KiwiObject {
      const def = byName.get(rootName);
      if (!def) throw new Error(`no definition named ${rootName}`);
      const bb = new ByteBuffer(buf);
      const result = decodeDef(bb, def);
      if (bb.remaining !== 0) throw new Error(`data: ${bb.remaining} trailing bytes`);
      return result;
    },
  };
}
