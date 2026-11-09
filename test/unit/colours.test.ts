import test from 'node:test';
import assert from 'node:assert/strict';
import type { KiwiObject } from '../../dist/fig/kiwi.js';
import { applyColours } from '../../dist/model/bindings.js';
import { resolveScene, sceneOf } from '../../dist/model/scene.js';
import { nodeDetail, styleBlock } from '../../dist/model/summarize.js';
import { textView } from '../../dist/model/text.js';
import { exportSubtree } from '../../dist/render/export.js';
import { entryOf, fileOf, guid, pathBlob } from '../fixtures/file.ts';

// F29 — inside an instance, a colour bound to a variable is the variable's value in the modes in
// force there; the colour stored beside the binding is the component's.

const g = guid;
const INK = { r: 0.2, g: 0.2, b: 0.2, a: 1 }; // #333333
const PAPER = { r: 1, g: 1, b: 1, a: 1 }; // #ffffff
const RED = { r: 1, g: 0, b: 0, a: 1 };
const GREEN = { r: 0, g: 1, b: 0, a: 1 };

const STATE = { assetRef: { key: 'k-state', version: '1:1' } };
const OUTLINE = { guid: g('5:103') };
const LIBRARY = { assetRef: { key: 'k-library-colour', version: '1:1' } };
const colourVar = (alias: KiwiObject) => ({ value: { alias }, dataType: 'ALIAS', resolvedDataType: 'COLOR' });
const solid = (color: KiwiObject, alias?: KiwiObject) => ({
  type: 'SOLID', color, opacity: 1, visible: true, ...(alias ? { colorVar: colourVar(alias) } : {}),
});
const mode = (id: string, name: string, sortPosition: string) => ({ id: g(id), name, sortPosition });
const value = (modeId: string, v: KiwiObject) => ({ modeID: g(modeId), variableData: { value: v } });
const pick = (modeId: string) => ({
  variableModeBySetMap: { entries: [{ variableSetID: STATE, variableModeID: g(modeId) }] },
});
const ON = '5:10';
const OFF = '5:11';

const variables = [
  { guid: g('5:1'), type: 'VARIABLE_SET', name: 'State', key: 'k-state', variableSetModes: [mode(ON, 'on', '!'), mode(OFF, 'off', '"')] },
  { guid: g('5:2'), type: 'VARIABLE_SET', name: 'Palette', variableSetModes: [mode('5:20', 'Mode 1', '!')] },
  { guid: g('5:101'), type: 'VARIABLE', name: 'palette/ink', variableSetID: { guid: g('5:2') }, variableDataValues: { entries: [value('5:20', { colorValue: INK })] } },
  { guid: g('5:102'), type: 'VARIABLE', name: 'palette/paper', variableSetID: { guid: g('5:2') }, variableDataValues: { entries: [value('5:20', { colorValue: PAPER })] } },
  {
    guid: g('5:103'), type: 'VARIABLE', name: 'state/outline', variableSetID: STATE,
    variableDataValues: { entries: [value(ON, { alias: { guid: g('5:102') } }), value(OFF, { alias: { guid: g('5:101') } })] },
  },
  // A colour style whose paint is bound to the variable, as design systems build them.
  { guid: g('9:1'), type: 'ROUNDED_RECTANGLE', name: 'Outline', styleType: 'FILL', fillPaints: [solid(PAPER, OUTLINE)] },
];

// One glyph outline, for a text drawn from a style its run names.
const SQUARE = pathBlob([1, 0, 0], [2, 0.5, 0], [2, 0.5, 0.7], [2, 0, 0.7], [0]);
const glyphs = { glyphs: [{ commandsBlob: 0, position: { x: 0, y: 12 }, fontSize: 12, firstCharacter: 0 }] };

// A card component in "on", its colours stored for "on" (PAPER); the instances pick a mode.
const card = [
  { guid: g('6:100'), type: 'SYMBOL', name: 'Card', size: { x: 60, y: 40 }, ...pick(ON) },
  { guid: g('6:101'), parent: '6:100', type: 'RECTANGLE', name: 'Rule', size: { x: 60, y: 1 }, fillPaints: [solid(PAPER, OUTLINE)] },
  { guid: g('6:102'), parent: '6:100', type: 'RECTANGLE', name: 'Swatch', size: { x: 10, y: 10 }, styleIdForFill: { guid: g('9:1') }, fillPaints: [solid(RED)] },
  {
    guid: g('6:103'), parent: '6:100', type: 'TEXT', name: 'Caption', size: { x: 30, y: 16 }, fillPaints: [solid(RED)],
    textData: { characters: 'A', characterStyleIDs: [1], styleOverrideTable: [{ styleID: 1, styleIdForFill: { guid: g('9:1') } }] },
    derivedTextData: glyphs,
  },
  {
    guid: g('6:104'), parent: '6:100', type: 'RECTANGLE', name: 'Shadowed', size: { x: 10, y: 10 }, fillPaints: [solid(GREEN)],
    effects: [{ type: 'DROP_SHADOW', color: PAPER, colorVar: colourVar(OUTLINE), radius: 2, offset: { x: 0, y: 1 }, visible: true }],
  },
  { guid: g('6:200'), type: 'INSTANCE', name: 'Card off', size: { x: 60, y: 40 }, symbolData: { symbolID: g('6:100') }, ...pick(OFF) },
  { guid: g('6:201'), type: 'INSTANCE', name: 'Card on', size: { x: 60, y: 40 }, symbolData: { symbolID: g('6:100') }, ...pick(ON) },
];

// A deck holding one card in "off" whose own box is painted with the style — stored with the
// style's paint as the deck's component has it, in "on".
const deck = [
  { guid: g('6:300'), type: 'SYMBOL', name: 'Deck', size: { x: 60, y: 40 } },
  {
    guid: g('6:301'), parent: '6:300', type: 'INSTANCE', name: 'Boxed card', size: { x: 60, y: 40 },
    symbolData: { symbolID: g('6:100') }, styleIdForFill: { guid: g('9:1') }, fillPaints: [solid(PAPER, OUTLINE)], ...pick(OFF),
  },
  { guid: g('6:400'), type: 'INSTANCE', name: 'Deck', size: { x: 60, y: 40 }, symbolData: { symbolID: g('6:300') } },
];

const records = [...variables, ...card, ...deck];
const idx = fileOf(records);
const modesOf = (m: string) => new Map([['k-state', m]]);

// ------------------------------------------------------------------------------ applyColours

test('applyColours reads every bound colour in the mode in force and keeps the rest', () => {
  const node = {
    fillPaints: [solid(PAPER, OUTLINE), solid(RED)],
    strokePaints: [{ ...solid(PAPER, OUTLINE), opacity: 0.5 }],
    effects: [{ type: 'DROP_SHADOW', color: PAPER, colorVar: colourVar(OUTLINE) }],
  };
  const off = applyColours(idx, node, modesOf(OFF));
  const fills = off.node['fillPaints'] as KiwiObject[];
  assert.deepEqual(fills[0]!['color'], INK);
  assert.equal(fills[1], node.fillPaints[1], 'an unbound paint is untouched');
  const stroke = (off.node['strokePaints'] as KiwiObject[])[0]!;
  assert.deepEqual(stroke['color'], INK);
  assert.equal(stroke['opacity'], 0.5, 'the paint\'s own opacity is not part of the colour');
  assert.deepEqual((off.node['effects'] as KiwiObject[])[0]!['color'], INK);
  assert.equal(off.applied, 3);
  assert.equal(off.unresolved, 0);

  const on = applyColours(idx, node, modesOf(ON));
  assert.equal(on.node, node, 'every colour already the stored one: same record');
  assert.equal(on.applied, 3);
});

test('applyColours reaches gradient stops and the paints of run style entries', () => {
  const node = {
    fillPaints: [{ type: 'GRADIENT_LINEAR', stops: [{ position: 0, color: PAPER, colorVar: colourVar(OUTLINE) }, { position: 1, color: RED }] }],
    textData: { styleOverrideTable: [{ styleID: 1, fillPaints: [solid(PAPER, OUTLINE)] }, { styleID: 2, fontSize: 9 }] },
  };
  const off = applyColours(idx, node, modesOf(OFF)).node;
  const stops = ((off['fillPaints'] as KiwiObject[])[0]!['stops'] as KiwiObject[]);
  assert.deepEqual(stops[0]!['color'], INK);
  assert.deepEqual(stops[1]!['color'], RED);
  const table = (off['textData'] as KiwiObject)['styleOverrideTable'] as KiwiObject[];
  assert.deepEqual((table[0]!['fillPaints'] as KiwiObject[])[0]!['color'], INK);
  assert.equal(table[1], node.textData.styleOverrideTable[1]);
});

test('applyColours keeps a colour it cannot resolve, and says so', () => {
  const node = { fillPaints: [solid(RED, LIBRARY)] };
  const out = applyColours(idx, node, modesOf(OFF));
  assert.equal(out.node, node);
  assert.equal(out.unresolved, 1);
  assert.equal(out.applied, 0);
});

// ------------------------------------------------------------------------ inspection tools

const hexOfFill = (view: Record<string, unknown>) => ((view['fills'] as Record<string, unknown>[])[0]!)['color'];

test('fig_style and fig_node report a bound colour in the mode the instance picks', () => {
  assert.equal(hexOfFill(styleBlock(idx, resolveScene(idx, 'I6:200;6:101')!)), '#333333');
  assert.equal(hexOfFill(nodeDetail(idx, resolveScene(idx, 'I6:200;6:101')!)), '#333333');
  assert.equal(hexOfFill(styleBlock(idx, resolveScene(idx, 'I6:201;6:101')!)), '#FFFFFF');
  assert.equal(hexOfFill(styleBlock(idx, resolveScene(idx, 'I6:200;6:102')!)), '#333333', 'through a colour style');
  const effect = (styleBlock(idx, resolveScene(idx, 'I6:200;6:104')!)['effects'] as Record<string, unknown>[])[0]!;
  assert.equal(effect['color'], '#333333');
  assert.equal(hexOfFill(styleBlock(idx, sceneOf(idx, idx.node('6:101')!))), '#FFFFFF', 'the component as stored');
});

test('fig_text reports a run\'s bound colour in the mode the instance picks', () => {
  const run = textView(idx, resolveScene(idx, 'I6:200;6:103')!, true)!.runs![0]!;
  assert.equal(run.style!['color'], '#333333');
  const stored = textView(idx, idx.node('6:103')!, true)!.runs![0]!;
  assert.equal(stored.style!['color'], '#FFFFFF');
});

// ------------------------------------------------------------------------------ the renderer

const entry = entryOf(records, [SQUARE]);
const count = (svg: string, hex: string) => svg.match(new RegExp(`fill="${hex}"`, 'g'))?.length ?? 0;
const svgOf = (id: string) => exportSubtree(entry, entry.index.node(id)!).svg;
const INK_SHADOW = 'values="0 0 0 0 0.2 0 0 0 0 0.2 0 0 0 0 0.2 0 0 0 1 0"';
const PAPER_SHADOW = 'values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0"';

test('the renderer draws bound colours in the mode the instance picks', () => {
  const off = svgOf('6:200');
  assert.equal(count(off, '#333333'), 3, 'the rule, the swatch and the styled run');
  assert.equal(count(off, '#ffffff'), 0);
  assert.equal(count(off, '#ff0000'), 0, 'never the stale paints beside the style references');
  assert.ok(off.includes(INK_SHADOW), 'the shadow too');

  const on = svgOf('6:201');
  assert.equal(count(on, '#ffffff'), 3);
  assert.equal(count(on, '#333333'), 0);
  assert.ok(on.includes(PAPER_SHADOW));

  const stored = svgOf('6:100');
  assert.equal(count(stored, '#ffffff'), 3, 'the component itself, as stored');
});

test('the renderer draws a nested instance\'s own styled box in that instance\'s mode', () => {
  const svg = svgOf('6:400');
  assert.equal(count(svg, '#333333'), 4, 'the box and the three layers inside it');
  assert.equal(count(svg, '#ffffff'), 0);
});
