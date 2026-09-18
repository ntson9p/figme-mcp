/**
 * Text → outlined paths (plan §4.8, fact F5).
 *
 * Figma stores a per-glyph outline for every text node, so no font file is ever needed. The
 * outline blob uses the same command grammar as F4 but in **em units with y pointing up**, while
 * `position` is the pen point on the baseline in node-local pixels with kerning already applied.
 * A glyph point (gx, gy) therefore lands at:
 *
 *     X = position.x + gx · fontSize
 *     Y = position.y − gy · fontSize          ← note the sign flip
 *
 * Verified on the digit "2" (node 2:1336): its flat base bar sits at em y = 0 and its top arc at
 * y = 0.751, which at fontSize 12 from a baseline at y = 12.72 puts the ink in rows 3..13 of an
 * 18-pixel-tall box. Getting the sign wrong mirrors every glyph below its baseline.
 *
 * Do NOT use `advance` to place glyphs — `position` already includes kerning (Pitfall 12).
 *
 * Two more things the derived data encodes (F21):
 *   - Truncation. `truncationStartIndex` indexes the GLYPH array, not the characters: the glyphs
 *     from that index on are the cut-off tail, and the one just before it is the ellipsis Figma
 *     inserted (which has no `firstCharacter`). All 920 truncated texts in the sample agree.
 *   - Run styles. A glyph's `styleID` is never set for a styled run (12 576 of 12 576 in the
 *     sample); the run is `textData.characterStyleIDs[firstCharacter]`, one entry per character
 *     with an implicit 0 past the end of the array.
 */
import type { NodeChange } from '../fig/parse.js';
import type { KiwiObject } from '../fig/kiwi.js';
import { arr, num, obj, objArr, str } from '../model/access.js';
import type { Box } from './matrix.js';
import { decodeCommands, toPathData } from './path.js';
import { type ReportBuilder } from './report.js';

/** Glyph outlines sharing one `styleID`, already flattened to node-local pixel path data. */
export interface GlyphRun {
  readonly styleID: number;
  readonly d: string;
}

export interface DecorationRun {
  readonly styleID: number;
  readonly rects: readonly Box[];
}

export interface TextDraw {
  readonly glyphs: GlyphRun[];
  readonly decorations: DecorationRun[];
}

export type BlobLookup = (index: number | undefined) => Uint8Array | undefined;

/**
 * `undefined` when the node carries no glyph outlines at all — the caller decides whether that
 * is an empty text node (draw nothing) or a missing-outline case worth reporting.
 */
export function buildText(
  node: NodeChange,
  blob: BlobLookup,
  report: ReportBuilder,
  guid: string,
): TextDraw | undefined {
  const derived = obj(node, 'derivedTextData');
  const glyphs = objArr(derived, 'glyphs');
  if (!derived || glyphs.length === 0) return undefined;

  const cut = num(derived, 'truncationStartIndex');
  const truncated = cut !== undefined && cut >= 0;
  if (truncated) report.seen('text-truncation');
  const runStyles = arr(obj(node, 'textData'), 'characterStyleIDs') ?? [];

  const byStyle = new Map<number, string[]>();
  let rotationReported = false;

  for (const [i, glyph] of glyphs.entries()) {
    if (truncated && i >= cut) break;
    if ((arr(glyph, 'emojiCodePoints') ?? []).length > 0) {
      // The outline blob of an emoji is empty; the artwork is a bitmap set we do not decode.
      report.approximated('emoji', guid);
      continue;
    }
    const rotation = num(glyph, 'rotation') ?? 0;
    if (rotation !== 0 && !rotationReported) {
      report.approximated('glyph-rotation', guid);
      rotationReported = true;
    }

    const raw = blob(num(glyph, 'commandsBlob'));
    if (!raw || raw.length === 0) continue;
    let cmds;
    try {
      cmds = decodeCommands(raw);
    } catch {
      report.unsupported('geometry:corrupt', guid);
      continue;
    }
    if (cmds.length === 0) continue;

    const fontSize = num(glyph, 'fontSize') ?? 0;
    if (fontSize === 0) continue;
    const position = obj(glyph, 'position');
    const d = toPathData(cmds, {
      a: fontSize,
      b: 0,
      c: 0,
      d: -fontSize, // em units are y-up; node-local pixels are y-down
      e: num(position, 'x') ?? 0,
      f: num(position, 'y') ?? 0,
    });

    const first = num(glyph, 'firstCharacter');
    const runStyle = first === undefined ? undefined : runStyles[first];
    const styleID = (typeof runStyle === 'number' ? runStyle : undefined) ?? num(glyph, 'styleID') ?? 0;
    const bucket = byStyle.get(styleID);
    if (bucket) bucket.push(d);
    else byStyle.set(styleID, [d]);
  }

  const decorations: DecorationRun[] = [];
  for (const decoration of objArr(derived, 'decorations')) {
    const rects: Box[] = [];
    for (const rect of objArr(decoration, 'rects') as KiwiObject[]) {
      const w = num(rect, 'w') ?? 0;
      const h = num(rect, 'h') ?? 0;
      if (w <= 0 || h <= 0) continue;
      rects.push({ x: num(rect, 'x') ?? 0, y: num(rect, 'y') ?? 0, w, h });
    }
    if (rects.length) decorations.push({ styleID: num(decoration, 'styleID') ?? 0, rects });
  }

  return {
    // One path per style run keeps the SVG small: 137 glyphs become one or two <path> elements.
    glyphs: [...byStyle.entries()].map(([styleID, parts]) => ({ styleID, d: parts.join(' ') })),
    decorations,
  };
}

/** True when the node has text to draw but no outlines for it (§4.14). */
export function hasCharactersWithoutOutlines(node: NodeChange): boolean {
  const characters = str(obj(node, 'textData'), 'characters');
  return characters !== undefined && characters.length > 0;
}
