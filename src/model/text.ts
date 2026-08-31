/**
 * Text content and styled runs (fig-reading-solution.md §9.6).
 *
 * `textData.characterStyleIDs` has one entry per UTF-16 code unit of `textData.characters`
 * (JS `string.length`, NOT code points or graphemes). Each id selects an entry of
 * `textData.styleOverrideTable`, which is a list of PARTIAL NodeChange records carrying
 * `styleID` plus only the fields that differ. Id 0 — and any character past the end of a
 * shorter ids array — falls back to the node's own typography.
 */
import type { NodeChange } from '../fig/parse.js';
import type { FileIndex } from './index.js';
import type { TreeNode } from './tree.js';
import { compact, num, obj, objArr, str } from './access.js';
import { typography } from './summarize.js';

export interface TextRun {
  /** UTF-16 code-unit offsets: `characters.slice(start, end)`. */
  start: number;
  end: number;
  text: string;
  /** 0 = the node's base style. */
  styleID: number;
  /** Only the fields this run overrides; absent when the run uses the base style. */
  style?: Record<string, unknown>;
}

export interface TextView {
  characters: string;
  characterCount: number;
  /** Node-level typography that every run inherits. */
  baseStyle?: Record<string, unknown>;
  runs?: TextRun[];
  /** True when `characterStyleIDs` is present and mentions any non-zero id. */
  hasStyledRuns: boolean;
}

/** The four fields a copy inventory actually needs, ~6x cheaper than the full typography. */
export function compactStyle(style: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!style) return undefined;
  return compact({
    font: style['font'],
    size: style['fontSize'],
    lineHeight: style['lineHeight'],
    color: style['color'],
  }) as Record<string, unknown>;
}

/**
 * Group `characterStyleIDs` into maximal runs of equal id. Consecutive characters sharing an id
 * become one run, so a 4000-character node with two styles costs two entries, not 4000.
 */
export function textView(idx: FileIndex, t: TreeNode, includeRuns: boolean): TextView | undefined {
  const textData = obj(t.node, 'textData');
  const characters = str(textData, 'characters');
  if (characters === undefined) return undefined;

  const ids = (textData?.['characterStyleIDs'] as number[] | undefined) ?? [];
  const hasStyledRuns = ids.some((id) => id !== 0);
  const view: TextView = {
    characters,
    characterCount: characters.length,
    baseStyle: orUndefined(typography(idx, t.node)),
    hasStyledRuns,
  };
  if (!includeRuns) return view;

  const overrides = new Map<number, NodeChange>();
  for (const entry of objArr(textData, 'styleOverrideTable')) {
    const id = num(entry, 'styleID');
    if (id !== undefined) overrides.set(id, entry);
  }

  const runs: TextRun[] = [];
  let start = 0;
  const idAt = (i: number): number => ids[i] ?? 0;
  for (let i = 1; i <= characters.length; i++) {
    if (i < characters.length && idAt(i) === idAt(start)) continue;
    const styleID = idAt(start);
    const override = overrides.get(styleID);
    runs.push(
      compact({
        start,
        end: i,
        text: characters.slice(start, i),
        styleID,
        style: override ? orUndefined(typography(idx, override)) : undefined,
      }) as TextRun,
    );
    start = i;
  }
  view.runs = runs;
  return view;
}

function orUndefined<T extends object>(o: T): T | undefined {
  return Object.keys(o).length ? o : undefined;
}
