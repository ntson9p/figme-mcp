import test from 'node:test';
import assert from 'node:assert/strict';
import type { KiwiObject } from '../../dist/fig/kiwi.js';
import { collectionKey, NO_MODES, variableValueIn, withModes } from '../../dist/model/variables.js';
import { mergeNode } from '../../dist/model/instance.js';
import { isHidden, resolveScene, sceneOf } from '../../dist/model/scene.js';
import { exportSubtree } from '../../dist/render/export.js';
import { renderNode } from '../../dist/render/index.js';
import { entryOf, fileOf, guid } from '../fixtures/file.ts';

// F28 — a layer bound to a variable shows the variable's value in the modes in force at it.
// Inside an instance that picks another mode than its component, the value stored beside the
// binding is the component's, and Figma stores no other.

const g = guid;
const INK = { r: 0.2, g: 0.2, b: 0.2, a: 1 };
const PAPER = { r: 1, g: 1, b: 1, a: 1 };
const RED = { type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };

const STATE_BY_KEY = { assetRef: { key: 'k-state', version: '1:1' } };
const STATE_BY_GUID = { guid: g('5:1') };
const PALETTE = { guid: g('5:2') };
const mode = (id: string, name: string, sortPosition: string) => ({ id: g(id), name, sortPosition });
const value = (modeId: string, v: KiwiObject) => ({ modeID: g(modeId), variableData: { value: v } });
const pick = (set: KiwiObject, modeId: string) => ({
  variableModeBySetMap: { entries: [{ variableSetID: set, variableModeID: g(modeId) }] },
});
const bind = (field: string, alias: KiwiObject) => ({
  variableField: field,
  variableData: { value: { alias }, dataType: 'ALIAS', resolvedDataType: field === 'VISIBLE' ? 'BOOLEAN' : 'COLOR' },
});
const bindings = (field: string, alias: KiwiObject) => ({
  variableConsumptionMap: { entries: [bind(field, alias)] },
  parameterConsumptionMap: { entries: [bind(field, alias)] },
});
const SHOW_CAPTION = { guid: g('5:100') };

const variables = [
  // A published collection with two modes, listed out of order: "on" sorts first.
  { guid: g('5:1'), type: 'VARIABLE_SET', name: 'State', key: 'k-state', variableSetModes: [mode('5:11', 'off', '"'), mode('5:10', 'on', '!')] },
  // An unpublished one, known by guid.
  { guid: g('5:2'), type: 'VARIABLE_SET', name: 'Palette', variableSetModes: [mode('5:20', 'Mode 1', '!')] },
  {
    guid: g('5:100'), type: 'VARIABLE', name: 'state/show caption', variableSetID: STATE_BY_KEY,
    variableDataValues: { entries: [value('5:10', { boolValue: true }), value('5:11', { boolValue: false })] },
  },
  { guid: g('5:101'), type: 'VARIABLE', name: 'palette/ink', variableSetID: PALETTE, variableDataValues: { entries: [value('5:20', { colorValue: INK })] } },
  { guid: g('5:102'), type: 'VARIABLE', name: 'palette/paper', variableSetID: PALETTE, variableDataValues: { entries: [value('5:20', { colorValue: PAPER })] } },
  {
    guid: g('5:103'), type: 'VARIABLE', name: 'state/outline', variableSetID: STATE_BY_KEY,
    variableDataValues: { entries: [value('5:10', { alias: { guid: g('5:102') } }), value('5:11', { alias: { guid: g('5:101') } })] },
  },
];

// A chip whose caption shows only in "on". The component itself picks "off", so the caption it
// stores is hidden; instances pick their own mode, or none.
const chip = [
  { guid: g('4:100'), type: 'SYMBOL', name: 'Chip', size: { x: 60, y: 40 }, ...pick(STATE_BY_KEY, '5:11') },
  {
    guid: g('4:101'), parent: '4:100', type: 'RECTANGLE', name: 'Caption', size: { x: 40, y: 16 },
    visible: false, fillPaints: [RED], ...bindings('VISIBLE', SHOW_CAPTION),
  },
  { guid: g('4:200'), type: 'INSTANCE', name: 'Chip off', size: { x: 60, y: 40 }, symbolData: { symbolID: g('4:100') }, ...pick(STATE_BY_GUID, '5:11') },
  { guid: g('4:201'), type: 'INSTANCE', name: 'Chip on', size: { x: 60, y: 40 }, symbolData: { symbolID: g('4:100') }, ...pick(STATE_BY_KEY, '5:10') },
  { guid: g('4:202'), type: 'INSTANCE', name: 'Chip, no pick', size: { x: 60, y: 40 }, symbolData: { symbolID: g('4:100') } },
];

// A row of two chips. Restyling their captions made the row's records write an empty binding
// map beside the text style; one variant of the row unbinds the second caption instead.
const captionOf = (chipId: string) => ({ guids: [g(chipId), g('4:101')] });
const row = [
  { guid: g('4:300'), type: 'SYMBOL', name: 'Chip row', size: { x: 130, y: 40 } },
  { guid: g('4:301'), parent: '4:300', type: 'INSTANCE', name: 'First', size: { x: 60, y: 40 }, symbolData: { symbolID: g('4:100') }, ...pick(STATE_BY_KEY, '5:10') },
  {
    guid: g('4:302'), parent: '4:300', type: 'INSTANCE', name: 'Second', size: { x: 60, y: 40 },
    transform: { m00: 1, m11: 1, m02: 70, m12: 0 }, symbolData: { symbolID: g('4:100') }, ...pick(STATE_BY_KEY, '5:11'),
  },
  {
    guid: g('4:400'), type: 'INSTANCE', name: 'Chip row', size: { x: 130, y: 40 },
    symbolData: {
      symbolID: g('4:300'),
      symbolOverrides: [
        { guidPath: captionOf('4:301'), variableConsumptionMap: { entries: [] } },
        { guidPath: captionOf('4:302'), variableConsumptionMap: { entries: [] } },
      ],
    },
  },
  {
    guid: g('4:401'), type: 'INSTANCE', name: 'Chip row, second caption unbound', size: { x: 130, y: 40 },
    symbolData: {
      symbolID: g('4:300'),
      symbolOverrides: [{
        guidPath: captionOf('4:302'), visible: true,
        variableConsumptionMap: { entries: [{ variableField: 'VISIBLE' }] },
        parameterConsumptionMap: { entries: [{ variableField: 'VISIBLE' }] },
      }],
    },
  },
];

// A marker bound to a library variable this file does not hold.
const marker = [
  { guid: g('4:500'), type: 'SYMBOL', name: 'Marker', size: { x: 8, y: 8 } },
  {
    guid: g('4:501'), parent: '4:500', type: 'RECTANGLE', name: 'Dot', size: { x: 8, y: 8 }, fillPaints: [RED],
    ...bindings('VISIBLE', { assetRef: { key: 'k-library-flag', version: '1:1' } }),
  },
  { guid: g('4:600'), type: 'INSTANCE', name: 'Marker, mode picked', size: { x: 8, y: 8 }, symbolData: { symbolID: g('4:500') }, ...pick(STATE_BY_KEY, '5:11') },
  { guid: g('4:601'), type: 'INSTANCE', name: 'Marker', size: { x: 8, y: 8 }, symbolData: { symbolID: g('4:500') } },
];

const records = [...variables, ...chip, ...row, ...marker];
const idx = fileOf(records);

// ------------------------------------------------------------------------- modes and values

test('collectionKey names a collection the same way whether a reference uses its guid or its key', () => {
  assert.equal(collectionKey(idx, STATE_BY_GUID), 'k-state');
  assert.equal(collectionKey(idx, STATE_BY_KEY), 'k-state');
  assert.equal(collectionKey(idx, PALETTE), '5:2', 'an unpublished collection is known by its guid');
  assert.equal(collectionKey(idx, { assetRef: { key: 'k-library' } }), 'k-library', 'one not in the file by its key');
  assert.equal(collectionKey(idx, undefined), undefined);
});

test('withModes lays a layer\'s own picks over those above it', () => {
  const off = withModes(idx, NO_MODES, pick(STATE_BY_GUID, '5:11'));
  assert.deepEqual([...off], [['k-state', '5:11']]);
  const on = withModes(idx, off, pick(STATE_BY_KEY, '5:10'));
  assert.equal(on.get('k-state'), '5:10', 'the nearer pick wins');
  assert.equal(off.get('k-state'), '5:11', 'the map above is not changed');
  const none = {};
  assert.equal(withModes(idx, off, none), off, 'no pick, same map');
  const extended = withModes(idx, NO_MODES, {
    variableModeBySetMap: { entries: [{ variableSetID: STATE_BY_KEY, variableModeID: g('5:11'), variableSetExtensionID: { guid: g('5:9') } }] },
  });
  assert.equal(variableValueIn(idx, SHOW_CAPTION, extended), undefined, 'an extended collection\'s mode is not evaluated');
});

test('variableValueIn reads the mode in force, the default mode first by sort position', () => {
  const at = (modes: Map<string, string>) => variableValueIn(idx, SHOW_CAPTION, modes);
  assert.deepEqual(at(new Map()), { boolValue: true }, '"on" sorts first, so it is the default');
  assert.deepEqual(at(new Map([['k-state', '5:11']])), { boolValue: false });
  assert.deepEqual(variableValueIn(idx, { assetRef: { key: 'k-missing' } }, NO_MODES), undefined);
});

test('variableValueIn follows an alias into another collection, read in that collection\'s mode', () => {
  const line = { guid: g('5:103') };
  assert.deepEqual(variableValueIn(idx, line, new Map([['k-state', '5:11']])), { colorValue: INK });
  assert.deepEqual(variableValueIn(idx, line, NO_MODES), { colorValue: PAPER });
});

// ------------------------------------------------------------------------- binding maps

test('binding maps merge per bound field: an empty map keeps the bindings, a bare entry unbinds', () => {
  const base = {
    variableConsumptionMap: { entries: [bind('VISIBLE', SHOW_CAPTION), bind('WIDTH', { guid: g('5:7') })] },
  };
  const fields = (n: KiwiObject) =>
    ((n['variableConsumptionMap'] as KiwiObject)['entries'] as KiwiObject[]).map((e) => e['variableField']);
  assert.deepEqual(fields(mergeNode(base, { variableConsumptionMap: { entries: [] } })), ['VISIBLE', 'WIDTH']);
  assert.deepEqual(fields(mergeNode(base, { variableConsumptionMap: { entries: [{ variableField: 'VISIBLE' }] } })), ['WIDTH']);
  const rebound = mergeNode(base, { variableConsumptionMap: { entries: [bind('VISIBLE', { guid: g('5:8') })] } });
  assert.deepEqual(fields(rebound), ['VISIBLE', 'WIDTH']);
  const visible = ((rebound['variableConsumptionMap'] as KiwiObject)['entries'] as KiwiObject[])[0]!;
  assert.deepEqual(visible, bind('VISIBLE', { guid: g('5:8') }));
});

// ------------------------------------------------------------------------------- the scene

const captionIn = (instance: string) => sceneOf(idx, idx.node(instance)!).children[0]!;

test('an instance shows a bound caption in the mode it picks, not in its component\'s', () => {
  assert.equal(isHidden(captionIn('4:200')), true, '"off", picked by the collection\'s guid');
  assert.equal(isHidden(captionIn('4:201')), false, '"on" — the component stores it hidden');
  assert.equal(isHidden(captionIn('4:202')), false, 'no pick: the default mode, not the component\'s pick');
  const stored = sceneOf(idx, idx.node('4:100')!).children[0]!;
  assert.equal(isHidden(stored), true, 'the component keeps what Figma stored for it');
});

test('nested instances read their own picks, through a restyled caption\'s empty binding map', () => {
  assert.equal(isHidden(resolveScene(idx, 'I4:400;4:301;4:101')!), false);
  assert.equal(isHidden(resolveScene(idx, 'I4:400;4:302;4:101')!), true);
  assert.equal(isHidden(resolveScene(idx, 'I4:401;4:302;4:101')!), false, 'a bare entry unbinds it');
  assert.equal(resolveScene(idx, 'I4:400;4:302')!.modes.get('k-state'), '5:11');
});

// ------------------------------------------------------------------------------ the renderer

const entry = entryOf(records);
const reds = (svg: string) => svg.match(/fill="#ff0000"/g)?.length ?? 0;
const svgOf = (id: string) => exportSubtree(entry, entry.index.node(id)!);
const finish = (r: ReturnType<typeof svgOf>) => r.report.finish({
  root: { guid: '-', type: 'INSTANCE' }, bounds: { x: 0, y: 0, w: 1, h: 1 }, width: 1, height: 1, scale: 1,
  svgBytes: 0, renderMs: 0,
});

test('the renderer draws a bound caption in the mode the instance picks', () => {
  assert.equal(reds(svgOf('4:200').svg), 0);
  assert.equal(reds(svgOf('4:201').svg), 1);
  assert.equal(reds(svgOf('4:202').svg), 1);
  assert.equal(reds(svgOf('4:100').svg), 0, 'the component as stored');
  assert.ok(finish(svgOf('4:201')).featuresPresent.includes('variable-binding'));
});

test('the renderer reads nested picks, and a layer of an instance rendered on its own', async () => {
  assert.equal(reds(svgOf('4:400').svg), 1, 'only the first chip shows its caption');
  assert.equal(reds(svgOf('4:401').svg), 2, 'the unbound caption follows its own visible');
  const second = await renderNode(entry, 'I4:400;4:302', { format: 'svg' });
  assert.equal(reds(second.svg), 0, 'the chip keeps its pick when it is the root');
  const caption = await renderNode(entry, 'I4:400;4:302;4:101', { format: 'svg' });
  assert.equal(reds(caption.svg), 0, 'and so does its caption');
  const first = await renderNode(entry, 'I4:400;4:301;4:101', { format: 'svg' });
  assert.equal(reds(first.svg), 1);
});

test('a binding the file cannot resolve keeps its stored value, reported only under a picked mode', () => {
  const picked = svgOf('4:600');
  assert.equal(reds(picked.svg), 1);
  assert.deepEqual(
    finish(picked).approximated.find((a) => a.feature === 'variable-unresolved'),
    { feature: 'variable-unresolved', count: 1, examples: ['4:501'] },
  );
  const plain = svgOf('4:601');
  assert.equal(reds(plain.svg), 1);
  assert.equal(finish(plain).approximated.some((a) => a.feature === 'variable-unresolved'), false);
});
