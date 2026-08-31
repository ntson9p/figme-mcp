/**
 * Post-parse validation (fig-reading-solution.md §7).
 *
 * Policy: structural corruption throws (already handled by the exact-consumption asserts in
 * container/kiwi); everything else is reported as a warning so a slightly unusual file still
 * yields a fully usable document.
 */
import type { ParsedFig } from './parse.js';
import type { KiwiObject } from './kiwi.js';

export function checkInvariants(fig: ParsedFig): string[] {
  const warnings: string[] = [];

  const type = fig.message['type'];
  if (type !== 'NODE_CHANGES') {
    warnings.push(`message.type is ${JSON.stringify(type)}, expected "NODE_CHANGES"`);
  }
  if (!Array.isArray(fig.message['nodeChanges'])) {
    throw new Error('decoded message has no nodeChanges array — not a document snapshot');
  }

  // Exactly one DOCUMENT root, and no node whose parent is missing.
  const keys = new Set<string>();
  let documents = 0;
  for (const nc of fig.nodeChanges) {
    const guid = nc['guid'] as { sessionID?: number; localID?: number } | undefined;
    if (guid) keys.add(`${guid.sessionID}:${guid.localID}`);
    if (nc['type'] === 'DOCUMENT') documents++;
  }
  if (documents !== 1) warnings.push(`expected exactly 1 DOCUMENT node, found ${documents}`);

  let orphans = 0;
  for (const nc of fig.nodeChanges) {
    if (nc['type'] === 'DOCUMENT') continue;
    const pi = nc['parentIndex'] as { guid?: { sessionID?: number; localID?: number } } | undefined;
    const pg = pi?.guid;
    if (!pg || !keys.has(`${pg.sessionID}:${pg.localID}`)) orphans++;
  }
  if (orphans > 0) warnings.push(`${orphans} node(s) have no resolvable parent`);

  // Every image fill must resolve to an images/<sha1> entry; a miss is "unavailable", not fatal.
  if (fig.zip) {
    const present = new Set(
      fig.zip
        .names()
        .filter((n) => n.startsWith('images/') && n.length > 'images/'.length)
        .map((n) => n.slice('images/'.length)),
    );
    const missing = new Set<string>();
    let referenced = 0;
    for (const nc of fig.nodeChanges) {
      for (const key of ['fillPaints', 'strokePaints'] as const) {
        const paints = nc[key];
        if (!Array.isArray(paints)) continue;
        for (const paint of paints as KiwiObject[]) {
          const hash = (paint['image'] as KiwiObject | undefined)?.['hash'];
          if (!(hash instanceof Uint8Array)) continue;
          referenced++;
          const hex = Buffer.from(hash).toString('hex');
          if (!present.has(hex)) missing.add(hex);
        }
      }
    }
    if (missing.size > 0) {
      warnings.push(
        `${missing.size} image hash(es) referenced by paints are not in images/ ` +
          `(first: ${[...missing][0]}; ${referenced} paint references total)`,
      );
    }
  }

  return warnings;
}
