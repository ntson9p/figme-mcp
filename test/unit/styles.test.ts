import test from 'node:test';
import assert from 'node:assert/strict';
import type { KiwiObject } from '../../dist/fig/kiwi.js';
import { applyStyles, resolveStyle, DETACHED_STYLE_GUID } from '../../dist/model/styles.js';
import { nodeDetail, styleBlock, styleRefsOf } from '../../dist/model/summarize.js';
import { textView } from '../../dist/model/text.js';
import { overrideFields } from '../../dist/model/components.js';
import { fileOf, guid } from '../fixtures/file.ts';

const solid = (r: number, g: number, b: number, a = 1) => ({ type: 'SOLID', color: { r, g, b, a }, opacity: 1, visible: true });
const RED = solid(1, 0.23137255, 0.18823530);
const BLACK = solid(0, 0, 0);
const WHITE = solid(1, 1, 1);

// The shape of the DatePicker header in the iOS 16 UI Kit: the text style says 17px SF Pro Text,
// the fill style says black, and the copy cached beside both references says otherwise.
const bodyBold = {
  guid: guid('9:1'), type: 'TEXT', name: 'Body/Bold', styleType: 'TEXT',
  fontName: { family: 'SF Pro Text', style: 'Semibold', postscript: 'SFProText-Semibold' },
  fontSize: 17, lineHeight: { value: 22, units: 'PIXELS' }, letterSpacing: { value: -0.408, units: 'PIXELS' },
  textAlignVertical: 'TOP', fillPaints: [BLACK],
};
const labelPrimary = { guid: guid('9:2'), type: 'ROUNDED_RECTANGLE', name: 'Label/Primary', styleType: 'FILL', fillPaints: [BLACK] };
const systemRed = { guid: guid('9:3'), type: 'ROUNDED_RECTANGLE', name: 'SystemRed', styleType: 'FILL', key: 'kred', fillPaints: [RED] };
const labelInverse = { guid: guid('9:4'), type: 'ROUNDED_RECTANGLE', name: 'Label/Inverse', styleType: 'FILL', fillPaints: [WHITE] };
const shadow = { guid: guid('9:5'), type: 'ROUNDED_RECTANGLE', name: 'Shadow', styleType: 'EFFECT',
  effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 10 }, radius: 60, visible: true }] };
const notAStyle = { guid: guid('9:6'), type: 'FRAME', name: 'Just a frame' };

const month = {
  guid: guid('2:10'), type: 'TEXT', name: 'Month',
  styleIdForText: { guid: guid('9:1') }, styleIdForFill: { guid: guid('9:2') },
  fontName: { family: 'SF Pro Display', style: 'Semibold', postscript: 'SFProDisplay-Semibold' },
  fontSize: 20, lineHeight: { value: 24, units: 'PIXELS' }, letterSpacing: { value: 0.38, units: 'PIXELS' },
  textCase: 'UPPER', fillPaints: [RED],
  textData: { characters: 'June 2022' },
};

const idx = fileOf([bodyBold, labelPrimary, systemRed, labelInverse, shadow, notAStyle, month]);

// ------------------------------------------------------------------------------ resolveStyle

test('resolveStyle follows a published key and an unpublished guid, and checks the style type', () => {
  assert.equal(resolveStyle(idx, { assetRef: { key: 'kred', version: '1:1' } }, 'FILL')?.key, '9:3');
  assert.equal(resolveStyle(idx, { guid: guid('9:2') }, 'FILL')?.key, '9:2');
  assert.equal(resolveStyle(idx, { guid: guid('9:2') }, 'TEXT'), undefined, 'a fill style is not a text style');
  assert.equal(resolveStyle(idx, { guid: guid('9:2') })?.key, '9:2', 'any style type when none is asked for');
});

test('resolveStyle refuses library styles, the detached sentinel and nodes that are not styles', () => {
  assert.equal(resolveStyle(idx, { assetRef: { key: 'not-in-this-file' } }, 'FILL'), undefined);
  const [s, l] = DETACHED_STYLE_GUID.split(':').map(Number);
  assert.equal(resolveStyle(idx, { guid: { sessionID: s, localID: l } }), undefined);
  assert.equal(resolveStyle(idx, { guid: guid('9:6') }), undefined, 'a frame is not a style');
  assert.equal(resolveStyle(idx, undefined), undefined);
});

// ------------------------------------------------------------------------------ applyStyles

test('applyStyles without text resolves paints and effects only, as the renderer needs', () => {
  const node = { ...month, styleIdForEffect: { guid: guid('9:5') } };
  const out = applyStyles(idx, node);
  assert.deepEqual(out['fillPaints'], [BLACK]);
  assert.equal((out['effects'] as KiwiObject[]).length, 1);
  assert.equal(out['fontSize'], 20, 'typography is left alone');
  assert.equal(out['textCase'], 'UPPER');
});

test('applyStyles with text takes the text style\'s typography, and its defaults (F22)', () => {
  const out = applyStyles(idx, month, { text: true });
  assert.deepEqual(out['fontName'], bodyBold.fontName);
  assert.equal(out['fontSize'], 17);
  assert.deepEqual(out['lineHeight'], { value: 22, units: 'PIXELS' });
  assert.deepEqual(out['letterSpacing'], { value: -0.408, units: 'PIXELS' });
  assert.equal('textCase' in out, false, 'the style sets no case, so the cached UPPER is stale');
  assert.equal(out['textAlignVertical'], undefined, 'alignment is not part of a text style');
  assert.deepEqual(month.fontSize, 20, 'the input is not mutated');
});

test('applyStyles on a partial record never writes a text style default over an inherited value', () => {
  const run = { styleID: 3, styleIdForText: { guid: guid('9:1') }, textCase: 'UPPER' };
  const out = applyStyles(idx, run, { text: true, partial: true });
  assert.equal(out['fontSize'], 17);
  assert.equal(out['textCase'], 'UPPER', 'absent from the style means inherited for a partial record');
});

test('applyStyles returns the very same node when nothing resolves', () => {
  const node = { type: 'RECTANGLE', fillPaints: [RED], styleIdForFill: { assetRef: { key: 'remote' } } };
  assert.equal(applyStyles(idx, node, { text: true }), node);
});

// ------------------------------------------------------------------------------ styleRefsOf

test('styleRefsOf names styles referenced by guid, which were never published', () => {
  const refs = styleRefsOf(idx, month) as Record<string, Record<string, unknown>>;
  assert.deepEqual(refs['fill'], { name: 'Label/Primary', guid: '9:2' });
  assert.deepEqual(refs['text'], { name: 'Body/Bold', guid: '9:1' });
});

test('styleRefsOf drops the detached sentinel and keeps library refs opaque', () => {
  const [s, l] = DETACHED_STYLE_GUID.split(':').map(Number);
  const refs = styleRefsOf(idx, {
    styleIdForFill: { guid: { sessionID: s, localID: l } },
    styleIdForText: { assetRef: { key: 'remote', version: '7:7' } },
  }) as Record<string, Record<string, unknown>>;
  assert.equal(refs['fill'], undefined, 'a detached style is no style');
  assert.deepEqual(refs['text'], { assetRef: 'remote@7:7' });
});

test('a resolved text style defines typography, never the colour or alignment of its preview node', () => {
  const refs = styleRefsOf(idx, month, { resolve: true }) as Record<string, Record<string, unknown>>;
  assert.deepEqual(refs['text']!['defines'], {
    font: 'SF Pro Text Semibold',
    fontPostScript: 'SFProText-Semibold',
    fontSize: 17,
    lineHeight: '22px',
    letterSpacing: '-0.41px',
  });
  assert.deepEqual(refs['fill']!['defines'], { paints: [{ type: 'SOLID', color: '#000000' }] });
});

// ------------------------------------------------------------------------- the inspection tools

test('fig_node and fig_style report the live style values, not the stale cached copy', () => {
  const t = idx.node('2:10')!;
  const detail = nodeDetail(idx, t);
  assert.deepEqual(detail['fills'], [{ type: 'SOLID', color: '#000000' }]);
  const text = detail['text'] as Record<string, unknown>;
  assert.equal(text['font'], 'SF Pro Text Semibold');
  assert.equal(text['fontSize'], 17);
  assert.equal(text['lineHeight'], '22px');
  assert.equal(text['textCase'], undefined);

  const style = styleBlock(idx, t);
  assert.deepEqual(style['fills'], [{ type: 'SOLID', color: '#000000' }]);
  const typo = style['typography'] as Record<string, unknown>;
  assert.equal(typo['fontSize'], 17);
  assert.equal(typo['color'], '#000000');
  assert.equal(typo['letterSpacing'], '-0.41px');
});

test('fig_text reports live typography for the node and for every styled run', () => {
  const runs = {
    guid: guid('2:11'), type: 'TEXT', name: 'Mixed', fontSize: 12, fillPaints: [RED],
    styleIdForFill: { guid: guid('9:2') },
    textData: {
      characters: 'ab',
      characterStyleIDs: [0, 4],
      styleOverrideTable: [
        // Only references, no cached values — 265 text-run entries in the sample look like this.
        { styleID: 4, styleIdForFill: { guid: guid('9:3') }, styleIdForText: { guid: guid('9:1') } },
      ],
    },
  };
  const file = fileOf([bodyBold, labelPrimary, systemRed, runs]);
  const view = textView(file, file.node('2:11')!, true)!;
  assert.equal(view.baseStyle!['color'], '#000000');
  const styled = view.runs!.find((r) => r.styleID === 4)!;
  assert.equal(styled.style!['color'], '#FF3B30');
  assert.equal(styled.style!['fontSize'], 17);
  assert.equal(styled.style!['font'], 'SF Pro Text Semibold');
  const named = styled.style!['styles'] as Record<string, Record<string, unknown>>;
  assert.equal(named['fill']!['name'], 'SystemRed');
  assert.equal(named['text']!['name'], 'Body/Bold');
});

test('fig_instance shows an override\'s live style value and names the style', () => {
  // The selected-day circle: a cached white fill beside a reference to the red style.
  const circle = overrideFields(idx, { guidPath: { guids: [guid('2:5')] }, fillPaints: [WHITE], styleIdForFill: { guid: guid('9:3') } });
  assert.deepEqual(circle.fields['fills'], [{ type: 'SOLID', color: '#FF3B30' }]);
  assert.deepEqual(circle.fields['styles'], { fill: { name: 'SystemRed', guid: '9:3' } });
  assert.equal(circle.otherFields.includes('styleIdForFill'), false, 'a translated field is not "other"');

  // The digit on it: references only, nothing cached.
  const digit = overrideFields(idx, { styleIdForFill: { guid: guid('9:4') }, styleIdForText: { guid: guid('9:1') } });
  assert.deepEqual(digit.fields['fills'], [{ type: 'SOLID', color: '#FFFFFF' }]);
  const text = digit.fields['text'] as Record<string, unknown>;
  assert.equal(text['fontSize'], 17);
  assert.equal(text['font'], 'SF Pro Text Semibold');

  // A cleared fill with no style stays a cleared fill.
  assert.equal(overrideFields(idx, { fillPaints: [] }).fields['fillsCleared'], true);
});
