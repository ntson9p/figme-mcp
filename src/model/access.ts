/**
 * Typed accessors over decoded Kiwi objects.
 *
 * Decoded nodes are open records (`KiwiObject`) because the schema grows constantly; these
 * helpers read a field only if it has the expected shape, so an unexpected type degrades to
 * `undefined` instead of throwing somewhere far away.
 */
import type { KiwiObject, KiwiValue } from '../fig/kiwi.js';

export function str(o: KiwiObject | undefined, k: string): string | undefined {
  const v = o?.[k];
  return typeof v === 'string' ? v : undefined;
}

export function num(o: KiwiObject | undefined, k: string): number | undefined {
  const v = o?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function bool(o: KiwiObject | undefined, k: string): boolean | undefined {
  const v = o?.[k];
  return typeof v === 'boolean' ? v : undefined;
}

export function obj(o: KiwiObject | undefined, k: string): KiwiObject | undefined {
  const v = o?.[k];
  return v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)
    ? (v as KiwiObject)
    : undefined;
}

export function arr(o: KiwiObject | undefined, k: string): KiwiValue[] | undefined {
  const v = o?.[k];
  return Array.isArray(v) ? v : undefined;
}

export function objArr(o: KiwiObject | undefined, k: string): KiwiObject[] {
  const v = arr(o, k);
  if (!v) return [];
  return v.filter((e): e is KiwiObject => !!e && typeof e === 'object' && !Array.isArray(e));
}

export function bytes(o: KiwiObject | undefined, k: string): Uint8Array | undefined {
  const v = o?.[k];
  return v instanceof Uint8Array ? v : undefined;
}

export function hex(v: Uint8Array | undefined): string | undefined {
  return v ? Buffer.from(v).toString('hex') : undefined;
}

/** Drop undefined/empty entries so responses never spend tokens on "not set". */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/** Round presentation floats; raw float32 noise (0.20000000298023224) is correct but noisy. */
export function r2(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  return Math.round(n * 100) / 100;
}

/** `{r,g,b,a}` floats 0–1 → `#RRGGBB`, or `#RRGGBBAA` when alpha < 1. */
export function colorHex(c: KiwiObject | undefined): string | undefined {
  if (!c) return undefined;
  const ch = (v: number | undefined): string =>
    Math.max(0, Math.min(255, Math.round((v ?? 0) * 255)))
      .toString(16)
      .padStart(2, '0');
  const a = num(c, 'a') ?? 1;
  const base = `#${ch(num(c, 'r'))}${ch(num(c, 'g'))}${ch(num(c, 'b'))}`.toUpperCase();
  return a >= 1 ? base : `${base}${ch(a).toUpperCase()}`;
}

/** `{ assetRef: { key, version } }` → `"key@version"`; a library reference, opaque offline. */
export function assetRefString(o: KiwiObject | undefined): string | undefined {
  const ref = obj(o, 'assetRef');
  if (!ref) return undefined;
  const key = str(ref, 'key');
  if (!key) return undefined;
  const version = str(ref, 'version');
  return version ? `${key}@${version}` : key;
}

export function assetRefKey(o: KiwiObject | undefined): string | undefined {
  return str(obj(o, 'assetRef'), 'key');
}

const MAX_INLINE_BYTES = 96;

/** JSON-safe projection: BigInt → string, bytes → hex (truncated), everything else untouched. */
export function jsonSafe(value: KiwiValue | undefined): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) {
    if (value.length <= MAX_INLINE_BYTES) return Buffer.from(value).toString('hex');
    return {
      hex: Buffer.from(value.subarray(0, MAX_INLINE_BYTES)).toString('hex'),
      byteLength: value.length,
      truncated: true,
    };
  }
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v as KiwiValue);
    return out;
  }
  return value;
}
