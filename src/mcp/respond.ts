/**
 * Response budgeting (plan §5) — the single place that decides how much a tool may return.
 *
 * A 116k-node document must stay explorable without ever flooding the agent's context, so:
 *   1. every response has a character budget (default 20k, hard cap 50k);
 *   2. no response carries more than 300 nodes;
 *   3. anything cut sets `truncated: true` and returns an opaque `nextCursor` plus a hint.
 */

export const DEFAULT_BUDGET = 20_000;
export const HARD_CAP = 50_000;
export const MAX_NODES = 300;
/**
 * Room left for the response envelope (root summary, counts, cursor, hint) so the SERIALIZED
 * response — not just its item list — stays inside DEFAULT_BUDGET.
 */
export const ENVELOPE_RESERVE = 1_500;

export interface CallToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Opaque resume token. The shape is deliberately private to this module. */
export interface Cursor {
  /** Resume immediately after this guid, in tree (DFS pre-order) order. */
  after?: string;
  /** Resume at this absolute offset, for lists that are not node-ordered. */
  offset?: number;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(s: string | undefined): Cursor {
  if (!s) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (parsed && typeof parsed === 'object') return parsed as Cursor;
  } catch {
    /* fall through */
  }
  throw new Error(`invalid cursor: ${JSON.stringify(s)}`);
}

export interface PackOptions {
  /** Character budget for the packed items alone (default DEFAULT_BUDGET - ENVELOPE_RESERVE). */
  budget?: number;
  /** Hard node/item ceiling (default MAX_NODES). */
  maxItems?: number;
  /** Caller-requested ceiling, clamped to maxItems. */
  limit?: number;
}

/**
 * Incremental accumulator: callers push items in a stable order and stop as soon as `add`
 * returns false. That keeps truncation deterministic and lets a cursor resume exactly where the
 * previous response stopped.
 */
export class Packer<T> {
  readonly items: T[] = [];
  truncated = false;
  reason: 'budget' | 'items' | 'limit' | undefined;
  private used = 0;
  private readonly budget: number;
  private readonly cap: number;
  private readonly capReason: 'items' | 'limit';

  constructor(opts: PackOptions = {}) {
    this.budget = Math.min(opts.budget ?? DEFAULT_BUDGET - ENVELOPE_RESERVE, HARD_CAP);
    const maxItems = opts.maxItems ?? MAX_NODES;
    const requested = opts.limit ?? maxItems;
    this.cap = Math.max(1, Math.min(requested, maxItems));
    this.capReason = requested < maxItems ? 'limit' : 'items';
  }

  get full(): boolean {
    return this.truncated;
  }

  /** Returns false when the item did not fit; the caller must then stop and emit a cursor. */
  add(item: T, sizeHint?: number): boolean {
    if (this.items.length >= this.cap) {
      this.truncated = true;
      this.reason = this.capReason;
      return false;
    }
    const size = sizeHint ?? measure(item);
    if (this.items.length > 0 && this.used + size > this.budget) {
      this.truncated = true;
      this.reason = 'budget';
      return false;
    }
    this.used += size;
    this.items.push(item);
    return true;
  }
}

export function measure(value: unknown): number {
  if (typeof value === 'string') return value.length + 1;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export interface JsonResultOptions {
  /** Name of the array field that should shrink first if the payload blows the hard cap. */
  listKey?: string;
}

/**
 * Serialize a payload as the tool's single text block, enforcing the hard cap as a last-resort
 * safety net (tools are expected to have budgeted already, via Packer).
 */
export function jsonResult(
  payload: Record<string, unknown>,
  opts: JsonResultOptions = {},
): CallToolResult {
  let out = payload;
  let text = stringify(out);
  if (text.length > HARD_CAP && opts.listKey) {
    const list = out[opts.listKey];
    if (Array.isArray(list)) {
      let items = list;
      while (items.length > 1 && text.length > HARD_CAP) {
        items = items.slice(0, Math.floor(items.length / 2));
        out = { ...out, [opts.listKey]: items, truncated: true, truncatedBy: 'response budget' };
        text = stringify(out);
      }
    }
  }
  if (text.length > HARD_CAP) {
    out = {
      error: 'response exceeded the hard response cap',
      hint: 'narrow the request: lower depth, add types/scope filters, or use a smaller limit',
      cap: HARD_CAP,
      wouldHaveBeen: text.length,
    };
    text = stringify(out);
  }
  return { content: [{ type: 'text', text }] };
}

export function textResult(text: string): CallToolResult {
  const capped =
    text.length > HARD_CAP
      ? `${text.slice(0, HARD_CAP - 80)}\n... [truncated at ${HARD_CAP} characters]`
      : text;
  return { content: [{ type: 'text', text: capped }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)) ?? '';
}
