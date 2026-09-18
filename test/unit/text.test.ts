import test from 'node:test';
import assert from 'node:assert/strict';
import type { PathCommand } from '../../dist/render/path.js';
import { buildText } from '../../dist/render/text.js';
import { ReportBuilder } from '../../dist/render/report.js';

const OPCODE: Record<string, number> = { Z: 0, M: 1, L: 2, Q: 3, C: 4 };

/** Encode commands the way a .fig blob stores them (F4): opcode byte + LE float32 args. */
function encode(cmds: readonly PathCommand[]): Uint8Array {
  let size = 0;
  for (const c of cmds) size += 1 + 4 * c.args.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let i = 0;
  for (const c of cmds) {
    out[i] = OPCODE[c.op]!;
    for (let k = 0; k < c.args.length; k++) dv.setFloat32(i + 1 + 4 * k, c.args[k]!, true);
    i += 1 + 4 * c.args.length;
  }
  return out;
}

/** A unit square in em units; every glyph below shares it, so only placement differs. */
const SQUARE = encode([
  { op: 'M', args: [0, 0] },
  { op: 'L', args: [1, 0] },
  { op: 'L', args: [1, 1] },
  { op: 'L', args: [0, 1] },
  { op: 'Z', args: [] },
]);
const blob = (i: number | undefined) => (i === 7 ? SQUARE : undefined);

function glyph(x: number, firstCharacter?: number, styleID?: number) {
  return {
    commandsBlob: 7,
    position: { x, y: 10 },
    fontSize: 10,
    ...(firstCharacter === undefined ? {} : { firstCharacter }),
    ...(styleID === undefined ? {} : { styleID }),
  };
}

test('a glyph\'s run style comes from characterStyleIDs, with 0 past the end of the array (F21)', () => {
  const node = {
    type: 'TEXT',
    textData: { characters: 'abc', characterStyleIDs: [0, 17] },
    derivedTextData: { glyphs: [glyph(0, 0), glyph(10, 1), glyph(20, 2)] },
  };
  const draw = buildText(node, blob, new ReportBuilder(), 't')!;
  const runs = new Map(draw.glyphs.map((g) => [g.styleID, g.d]));
  assert.deepEqual([...runs.keys()].sort(), [0, 17]);
  assert.equal(runs.get(0)!.split('M').length - 1, 2, 'characters 0 and 2 share run 0');
  assert.equal(runs.get(17)!.split('M').length - 1, 1, 'character 1 is the styled run');
  assert.ok(runs.get(17)!.startsWith('M10,10'), 'placed at its pen position, y flipped from em units');
});

test('a glyph without firstCharacter keeps its own styleID', () => {
  const node = {
    type: 'TEXT',
    textData: { characters: 'ab', characterStyleIDs: [0, 0] },
    derivedTextData: { glyphs: [glyph(0, 0), glyph(10, undefined, 5)] },
  };
  const draw = buildText(node, blob, new ReportBuilder(), 't')!;
  assert.deepEqual(draw.glyphs.map((g) => g.styleID).sort(), [0, 5]);
});

test('truncationStartIndex cuts the glyph array, keeping the ellipsis just before it (F21)', () => {
  // Five characters laid out as: a b c … d e — the ellipsis glyph (no firstCharacter) sits at
  // array index 3 and truncationStartIndex is 4, so glyphs 4 and 5 are the hidden tail.
  const node = {
    type: 'TEXT',
    textData: { characters: 'abcde' },
    derivedTextData: {
      truncationStartIndex: 4,
      truncatedHeight: 12,
      glyphs: [glyph(0, 0), glyph(10, 1), glyph(20, 2), glyph(30, undefined, 0), glyph(30, 3), glyph(0, 4)],
    },
  };
  const report = new ReportBuilder();
  const draw = buildText(node, blob, report, 't')!;
  assert.equal(draw.glyphs.length, 1);
  assert.equal(draw.glyphs[0]!.d.split('M').length - 1, 4, 'three characters plus the ellipsis');
  assert.ok(!draw.glyphs[0]!.d.includes('M0,10 L10,10 L10,0 L0,0 Z M0,10'), 'the tail is never drawn');
  assert.ok(report.finish({} as never).featuresPresent.includes('text-truncation'));

  const untruncated = buildText(
    { ...node, derivedTextData: { ...node.derivedTextData, truncationStartIndex: -1 } },
    blob,
    new ReportBuilder(),
    't',
  )!;
  assert.equal(untruncated.glyphs[0]!.d.split('M').length - 1, 6, '-1 means nothing is cut');
});
