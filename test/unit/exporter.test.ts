import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSubtree } from '../../dist/render/export.js';
import { entryOf, guid, pathBlob } from '../fixtures/file.ts';

const solid = (r: number, g: number, b: number) => ({ type: 'SOLID', color: { r, g, b, a: 1 }, opacity: 1, visible: true });
const DARK = solid(0.2, 0.2, 0.2); // #333333
const RED = solid(1, 0, 0); // #ff0000

const text = (characters: string) => ({ characters, lines: [{ lineType: 'PLAIN', styleId: 0 }] });
const glyphs = { glyphs: [{ commandsBlob: 0, position: { x: 0, y: 12 }, fontSize: 12, firstCharacter: 0 }] };
// One glyph outline, in em units (F5).
const SQUARE = pathBlob([1, 0, 0], [2, 0.5, 0], [2, 0.5, 0.7], [2, 0, 0.7], [0]);
// What `ReportBuilder.finish` needs besides the buckets the tests read.
const base = {
  root: { guid: '-', type: 'INSTANCE' }, bounds: { x: 0, y: 0, w: 1, h: 1 }, width: 1, height: 1, scale: 1,
  svgBytes: 0, renderMs: 0,
};

test('a text property without outlines is reported, not drawn, also under a colour style (F18)', () => {
  // The label's colour comes from a local style, so resolving it hands emitText a new record;
  // the "these glyphs spell the old words" mark must survive that.
  const entry = entryOf([
    { guid: guid('9:1'), type: 'ROUNDED_RECTANGLE', name: 'Ink', styleType: 'FILL', fillPaints: [DARK] },
    { guid: guid('2:100'), type: 'SYMBOL', name: 'Button', size: { x: 60, y: 16 } },
    {
      guid: guid('2:101'), parent: '2:100', type: 'TEXT', name: 'Label', size: { x: 30, y: 16 },
      textData: text('OK'), derivedTextData: glyphs, styleIdForFill: { guid: guid('9:1') }, fillPaints: [RED],
      componentPropRefs: [{ defID: guid('6:1'), componentPropNodeField: 'TEXT_DATA' }],
    },
    {
      guid: guid('2:200'), type: 'INSTANCE', name: 'Cancel', size: { x: 60, y: 16 }, symbolData: { symbolID: guid('2:100') },
      componentPropAssignments: [{ defID: guid('6:1'), value: { textValue: text('Cancel') } }],
    },
    {
      guid: guid('2:201'), type: 'INSTANCE', name: 'Cancel, laid out', size: { x: 60, y: 16 },
      symbolData: { symbolID: guid('2:100') },
      derivedSymbolData: [{ guidPath: { guids: [guid('2:101')] }, derivedTextData: glyphs }],
      componentPropAssignments: [{ defID: guid('6:1'), value: { textValue: text('Cancel') } }],
    },
  ], [SQUARE]);

  const stale = exportSubtree(entry, entry.index.node('2:200')!);
  assert.doesNotMatch(stale.svg, /fill="#333333"/, 'the component\'s glyphs spell "OK", not "Cancel"');
  assert.ok(stale.report.finish(base).unsupported.some((u) => u.feature === 'text-property-without-outlines'));

  const laidOut = exportSubtree(entry, entry.index.node('2:201')!);
  assert.match(laidOut.svg, /fill="#333333"/, 'outlines from the record are drawn, in the style\'s colour');
  assert.ok(!laidOut.report.finish(base).unsupported.some((u) => u.feature === 'text-property-without-outlines'));
});
