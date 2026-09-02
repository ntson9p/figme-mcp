/**
 * SVG serialization (plan §4.3): escaping, number formatting, a well-formedness-checked writer
 * and a `<defs>` registry that de-duplicates gradients, patterns, filters, clips and masks.
 *
 * `fmt` throws on a non-finite number on purpose. resvg does NOT reject a `NaN` attribute — it
 * silently drops that element and renders everything else (Appendix E, R24), so this guard is
 * the only place such a bug can be caught.
 */
import type { Box, Mat } from './matrix.js';

export type Attrs = Record<string, string | number | undefined>;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** 3 decimals, trailing zeros stripped, `-0` normalised to `0`. Throws on NaN/Infinity. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`non-finite number in SVG output: ${String(n)}`);
  }
  const r = Math.round(n * 1000) / 1000;
  if (r === 0) return '0';
  // Very large magnitudes would come back in exponential form, which SVG does not accept.
  if (Math.abs(r) >= 1e15) return r.toFixed(0);
  let s = r.toFixed(3);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** `matrix(a b c d e f)` for a `transform` attribute. */
export function toAttr(m: Mat): string {
  return `matrix(${fmt(m.a)} ${fmt(m.b)} ${fmt(m.c)} ${fmt(m.d)} ${fmt(m.e)} ${fmt(m.f)})`;
}

function attrsToString(attrs: Attrs | undefined): string {
  if (!attrs) return '';
  let out = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    const text = typeof v === 'number' ? fmt(v) : esc(v);
    out += ` ${k}="${text}"`;
  }
  return out;
}

export interface FinishOptions {
  /** Solid page background painted behind everything; omitted for transparent output. */
  readonly background?: string;
  /** Pixel dimensions of the output (the viewBox is in user units). */
  readonly width: number;
  readonly height: number;
}

/**
 * Streaming writer. The tag stack is checked on every `close`, so a malformed document is a
 * loud error here rather than a mysterious parse failure inside the rasterizer.
 */
export class SvgWriter {
  private body: string[] = [];
  private stack: string[] = [];
  private readonly defsBody: (string | undefined)[] = [];
  private readonly defsByKey = new Map<string, string>();
  private idCounter = 0;

  /** Ids are `p1`, `p2`, … — never derived from layer names (which are arbitrary text). */
  nextId(): string {
    this.idCounter += 1;
    return `p${this.idCounter}`;
  }

  get depth(): number {
    return this.stack.length;
  }

  open(tag: string, attrs?: Attrs): void {
    this.body.push(`<${tag}${attrsToString(attrs)}>`);
    this.stack.push(tag);
  }

  close(tag: string): void {
    const open = this.stack.pop();
    if (open !== tag) {
      throw new Error(`SVG nesting error: closed <${tag}> while <${open ?? 'nothing'}> was open`);
    }
    this.body.push(`</${tag}>`);
  }

  element(tag: string, attrs?: Attrs, inner?: string): void {
    if (inner === undefined) {
      this.body.push(`<${tag}${attrsToString(attrs)}/>`);
    } else {
      this.body.push(`<${tag}${attrsToString(attrs)}>${inner}</${tag}>`);
    }
  }

  /** Pre-serialized markup. The caller is responsible for its escaping and balance. */
  raw(markup: string): void {
    this.body.push(markup);
  }

  /**
   * Close every element opened past `depth`. Used to recover from a node that threw halfway
   * through: the document stays well-formed and the rest of the render continues.
   */
  unwindTo(depth: number): void {
    while (this.stack.length > depth) {
      const tag = this.stack.pop()!;
      this.body.push(`</${tag}>`);
    }
  }

  /**
   * Register a `<defs>` entry once per `key` and return its id. `build` receives the id it must
   * use. Re-entrant: `build` may itself register defs (a mask whose content needs a clipPath).
   */
  def(key: string, build: (id: string) => string): string {
    const existing = this.defsByKey.get(key);
    if (existing) return existing;
    const id = this.nextId();
    this.defsByKey.set(key, id);
    const slot = this.defsBody.length;
    this.defsBody.push(undefined); // reserve the slot before building, so nesting keeps order
    this.defsBody[slot] = build(id);
    return id;
  }

  /**
   * Run `fn` with output redirected to a fresh buffer and return what it wrote. Used to render
   * mask and clip content into a `<defs>` entry through the ordinary emit path.
   */
  capture(fn: () => void): string {
    const savedBody = this.body;
    const savedDepth = this.stack.length;
    this.body = [];
    try {
      fn();
      if (this.stack.length !== savedDepth) {
        throw new Error(
          `SVG nesting error: capture left ${this.stack.length - savedDepth} element(s) open`,
        );
      }
      return this.body.join('');
    } finally {
      this.body = savedBody;
    }
  }

  /** Total characters written so far — checked against MAX_SVG_BYTES while exporting. */
  get length(): number {
    let n = 0;
    for (const s of this.body) n += s.length;
    for (const s of this.defsBody) n += s ? s.length : 0;
    return n;
  }

  finish(view: Box, opts: FinishOptions): string {
    if (this.stack.length) {
      throw new Error(`SVG nesting error: <${this.stack.join('>, <')}> left open`);
    }
    const head =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"' +
      ` width="${fmt(opts.width)}" height="${fmt(opts.height)}"` +
      ` viewBox="${fmt(view.x)} ${fmt(view.y)} ${fmt(view.w)} ${fmt(view.h)}">`;
    const defs = this.defsBody.length ? `<defs>${this.defsBody.join('')}</defs>` : '';
    const bg = opts.background
      ? `<rect x="${fmt(view.x)}" y="${fmt(view.y)}" width="${fmt(view.w)}" height="${fmt(view.h)}" fill="${esc(opts.background)}"/>`
      : '';
    return `${head}${defs}${bg}${this.body.join('')}</svg>`;
  }
}
