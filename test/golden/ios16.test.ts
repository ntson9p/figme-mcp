/**
 * Golden tests against the iOS 16 UI Kit for Figma, a public Figma Community file.
 *
 * Open the community file in Figma, save a local copy (File → Save local copy…) as
 * `figma-input/ios-16-ui-kit.fig`, or point `FIGME_IOS16_FIG` at a copy anywhere. The suite skips
 * when the file is absent. Values were measured on a copy saved on 2026-10-29 (8 267 nodes,
 * fig-kiwi version 106); the assertions check Figma's own layout data where they can, so they
 * hold for any later save that leaves these components untouched.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { REPO_ROOT } from '../fixtures/asset.ts';
import { parseFig } from '../../dist/fig/parse.js';
import { FileIndex } from '../../dist/model/index.js';
import { styleBlock } from '../../dist/model/summarize.js';
import { textView } from '../../dist/model/text.js';
import { connect, type Harness } from '../fixtures/mcp.ts';

const IOS16_PATH = process.env['FIGME_IOS16_FIG'] ?? path.join(REPO_ROOT, 'figma-input', 'ios-16-ui-kit.fig');
const exists = fs.existsSync(IOS16_PATH);
const skip = exists
  ? false
  : `iOS 16 UI Kit not found at ${IOS16_PATH} — save the Figma Community file there, or set FIGME_IOS16_FIG, to run these tests`;

let index: FileIndex;
let harness: Harness;
const file = IOS16_PATH;

before(async () => {
  if (!exists) return;
  index = new FileIndex(parseFig(fs.readFileSync(IOS16_PATH)));
  harness = await connect();
});
after(async () => {
  await harness?.close();
});

describe('iOS 16 UI Kit — shared styles are live (F19, F22)', { skip }, () => {
  it('is the community file these values were measured on', () => {
    assert.equal(index.fig.meta?.file_name, 'iOS 16 UI Kit for Figma (Community)');
    assert.equal(index.node('1319:26210')?.node['name'], 'DatePicker');
  });

  it('every single-style text node reports the font and size Figma laid it out with', () => {
    // derivedTextData is Figma's own layout: the reported typography must agree with it. Before
    // F22, 52 of these nodes reported the stale typography cached beside their text style.
    let checked = 0;
    const wrong: string[] = [];
    for (const t of index.tree.ordered) {
      if (t.node['type'] !== 'TEXT') continue;
      const textData = t.node['textData'] as { characterStyleIDs?: number[] } | undefined;
      if ((textData?.characterStyleIDs ?? []).some((id) => id !== 0)) continue;
      const derived = t.node['derivedTextData'] as
        | { glyphs?: { fontSize?: number }[]; fontMetaData?: { key: { family: string; style: string } }[] }
        | undefined;
      const glyph = derived?.glyphs?.find((g) => typeof g.fontSize === 'number');
      const font = derived?.fontMetaData?.[0]?.key;
      if (!glyph || !font) continue;
      checked++;
      const base = textView(index, t, false)!.baseStyle!;
      if (base['fontSize'] !== glyph.fontSize || base['font'] !== `${font.family} ${font.style}`) {
        wrong.push(`${t.key}: ${base['font']} ${base['fontSize']} vs ${font.family} ${font.style} ${glyph.fontSize}`);
      }
    }
    assert.ok(checked > 1_500, `checked ${checked} nodes`);
    assert.deepEqual(wrong, []);
  });

  it('the DatePicker header reports its text style, not the copy cached beside it', async () => {
    const r = await harness.call('fig_text', { file, scope: '55:4649' });
    const [text] = r.json['texts'] as Record<string, any>[];
    assert.equal(text!['characters'], 'June 2022');
    assert.deepEqual(text!['style'], {
      font: 'SF Pro Text Semibold',
      size: 17,
      lineHeight: '22px',
      color: '#000000',
    });
  });

  it('fig_style names styles referenced by guid and reports their live values', async () => {
    const r = await harness.call('fig_style', { file, guid: '55:4649' });
    const style = r.json['style'] as Record<string, any>;
    assert.deepEqual(style['fills'], [{ type: 'SOLID', color: '#000000' }]);
    assert.equal(style['typography'].letterSpacing, '-0.41px');
    assert.equal(style['styles'].fill.name, 'Label Color/Light/Primary');
    assert.equal(style['styles'].text.name, 'Body/Bold');
    assert.equal(style['styles'].text.defines.fontSize, 17);
    assert.equal(style['styles'].text.defines.color, undefined, 'a text style defines no colour');
  });

  it('fig_instance shows the live value of a style an override names', async () => {
    const r = await harness.call('fig_instance', { file, guid: '55:2890' });
    const overrides = r.json['overrides'] as Record<string, any>[];
    // The selected-day circle: white cached beside the SystemRed style, which Figma draws.
    const circle = overrides.find((o) => o['targetGuid'] === '55:7351')!;
    assert.deepEqual(circle['fields'].fills, [{ type: 'SOLID', color: '#FF3B30' }]);
    assert.equal(circle['fields'].styles.fill.name, 'Default/SystemRed/Light');
    // The digit on it carries only style references.
    const digit = overrides.find((o) => o['targetGuid'] === '55:3914')!;
    assert.deepEqual(digit['fields'].fills, [{ type: 'SOLID', color: '#FFFFFF' }]);
    assert.equal(digit['fields'].text.characters, '6');
    assert.equal(digit['fields'].text.fontSize, 20);
    assert.equal(digit['fields'].text.font, 'SF Pro Display Semibold');
    assert.equal((digit['otherFields'] ?? []).includes('styleIdForFill'), false);
  });
});

describe('iOS 16 UI Kit — auto-layout spacing', { skip }, () => {
  it('every reported gap is the gap Figma laid the children out with', () => {
    // Children of an auto-layout frame carry the transforms Figma's layout produced. Before the
    // fix, 88 frames with "Auto" spacing reported a stored gap their children do not have.
    let fixed = 0;
    let auto = 0;
    const wrong: string[] = [];
    for (const t of index.tree.ordered) {
      const mode = t.node['stackMode'];
      if (mode !== 'HORIZONTAL' && mode !== 'VERTICAL') continue;
      const kids = t.children.filter(
        (c) => c.node['visible'] !== false && c.node['stackPositioning'] !== 'ABSOLUTE',
      );
      if (kids.length < 2) continue;
      const span = (c: (typeof kids)[number]): [number, number] => {
        const m = c.node['transform'] as Record<string, number>;
        const s = c.node['size'] as Record<string, number>;
        return mode === 'HORIZONTAL' ? [m['m02']!, m['m02']! + s['x']!] : [m['m12']!, m['m12']! + s['y']!];
      };
      const gaps = kids.slice(1).map((c, i) => span(c)[0] - span(kids[i]!)[1]);
      const layout = styleBlock(index, t)['layout'] as Record<string, unknown>;
      if (layout['justifyContent'] === 'space-between' && layout['gap'] === undefined) {
        auto++;
        if (gaps.some((g) => Math.abs(g - gaps[0]!) > 0.02)) wrong.push(`${t.key}: uneven auto gaps ${gaps}`);
        continue;
      }
      fixed++;
      const gap = (layout['gap'] as number | undefined) ?? 0;
      if (gaps.some((g) => Math.abs(g - gap) > 0.02)) wrong.push(`${t.key}: reported ${gap}, laid out ${gaps}`);
    }
    assert.ok(fixed > 1_000, `${fixed} fixed-gap frames`);
    assert.ok(auto >= 90, `${auto} auto-spacing frames`);
    assert.deepEqual(wrong, []);
  });

  it('the DatePicker month header has auto spacing, not its stored 141 px', async () => {
    const node = await harness.call('fig_node', { file, guid: '55:4647', includeChildren: false });
    const autoLayout = (node.json['node'] as Record<string, any>)['autoLayout'];
    assert.equal(autoLayout.spacing, 'auto');
    assert.equal(autoLayout.primaryAlign, 'SPACE_BETWEEN');
    const style = await harness.call('fig_style', { file, guid: '55:4647' });
    const layout = (style.json['style'] as Record<string, any>)['layout'];
    assert.equal(layout.gap, undefined);
    assert.equal(layout.justifyContent, 'space-between');
  });
});
