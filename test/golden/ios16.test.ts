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
import { resolveScene, sceneOf } from '../../dist/model/scene.js';
import { applyStyles } from '../../dist/model/styles.js';
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

describe('iOS 16 UI Kit — component instances are walked into (F17, F18)', { skip }, () => {
  it('fig_text finds every string the DatePicker instance shows', async () => {
    // Before, only the 2 text layers stored in the component's own frames came back.
    const r = await harness.call('fig_text', { file, scope: '1319-26210' });
    assert.equal(r.json['totalTextNodes'], 45);
    const texts = r.json['texts'] as Record<string, any>[];
    const days = Array.from({ length: 31 }, (_, i) => String(i + 1));
    assert.deepEqual(
      texts.filter((t) => !t['hidden']).map((t) => t['characters']),
      ['June 2022', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', ...days, 'Time', '9:41 AM'],
    );
    // June 2022 starts on a Wednesday: three blank cells before the 1st, one after the 31st.
    assert.equal(texts.filter((t) => t['hidden']).length, 4);
    const six = texts.find((t) => t['characters'] === '6')!;
    assert.equal(six['guid'], 'I1319:26210;55:2890;55:3914');
    assert.deepEqual(six['style'], { font: 'SF Pro Display Semibold', size: 20, lineHeight: '25px', color: '#FFFFFF' });
  });

  it('fig_tree lists the layers an instance shows, and instances:false only the stored ones', async () => {
    const r = await harness.call('fig_tree', { file, root: '1319:26210', depth: 3, format: 'outline' });
    assert.match(r.text, /\[INSTANCE\] 357x370 "DatePicker" \(1319:26210\) x8/);
    assert.match(r.text, /\n {4}\[FRAME\] 40x40 "Digit" \(I1319:26210;55:2890;55:7351\) x1/);
    assert.match(r.text, /\n {6}\[TEXT\] 40x25 "✏️ Date" \(I1319:26210;55:2889;55:2861\) hidden/);
    const stored = await harness.call('fig_tree', { file, root: '1319:26210', depth: 3, instances: false });
    assert.deepEqual((stored.json['nodes'] as { guid: string }[]).map((n) => n.guid), ['1319:26210']);
  });

  it('every layer an instance shows has an id that resolves back to that layer', () => {
    let checked = 0;
    const wrong: string[] = [];
    for (const t of index.tree.ordered) {
      if (t.node['type'] !== 'INSTANCE') continue;
      const stack = [...sceneOf(index, t).children];
      while (stack.length) {
        const s = stack.pop()!;
        checked++;
        const back = resolveScene(index, s.key);
        const same =
          back !== undefined &&
          back.source === s.source &&
          back.node['visible'] === s.node['visible'] &&
          JSON.stringify(back.node['textData']) === JSON.stringify(s.node['textData']);
        if (!same) wrong.push(s.key);
        stack.push(...s.children);
      }
    }
    assert.ok(checked > 10_000, `${checked} layers checked`);
    assert.deepEqual(wrong.slice(0, 5), []);
  });

  it('fig_node, fig_style and fig_render take a sublayer id, also as a link spells it', async () => {
    const link = 'https://www.figma.com/design/k/n?node-id=I1319-26210%3B55-2890%3B55-7351';
    const node = await harness.call('fig_node', { file, guid: link, includeChildren: false });
    const n = node.json['node'] as Record<string, any>;
    assert.equal(n['guid'], 'I1319:26210;55:2890;55:7351');
    assert.equal(n['parent'], 'I1319:26210;55:2890');
    assert.deepEqual(n['fills'], [{ type: 'SOLID', color: '#FF3B30' }]);
    assert.equal(n['styles'].fill.name, 'Default/SystemRed/Light');
    assert.deepEqual([n['geometry'].absoluteX, n['geometry'].absoluteY], [49, 437]);

    const style = await harness.call('fig_style', { file, guid: 'I1319:26210;55:2890;55:3914' });
    assert.equal((style.json['style'] as Record<string, any>)['typography'].color, '#FFFFFF');
    assert.equal((style.json['text'] as Record<string, any>)['characters'], '6');

    const render = await harness.call('fig_render', { file, guid: 'I1319:26210;55:2890', format: 'svg' });
    assert.equal(render.isError, false, render.text.slice(0, 200));
    assert.match(render.text, /^<svg [^>]*width="325" height="40"/);
    assert.match(render.text, /fill="#ff3b30"/, 'the selected day is drawn in this row');
  });

  it('fig_instance explains a nested instance, with what the enclosing instance changes in it', async () => {
    const r = await harness.call('fig_instance', { file, guid: 'I1340:17094;1147:11418' });
    const instance = r.json['instance'] as Record<string, any>;
    assert.equal(instance['guid'], 'I1340:17094;1147:11418');
    assert.equal(instance['name'], '_TableView-cell (last)');
    const inherited = (r.json['overrides'] as Record<string, any>[]).filter((o) => o['inherited']);
    assert.equal(inherited.length, 4);
    assert.ok(inherited.some((o) => o['fields'].text?.characters === 'Action'));
  });

  it('fig_find searches the layers instances show only when asked', async () => {
    const stored = await harness.call('fig_find', { file, query: '9:41', scope: '1319:26210' });
    assert.equal(stored.json['totalMatches'], 0);
    const shown = await harness.call('fig_find', { file, query: '9:41', scope: '1319:26210', instances: true });
    const hits = shown.json['results'] as Record<string, any>[];
    assert.deepEqual(hits.map((h) => [h['guid'], h['matchedOn']]), [['I1319:26210;55:4825;839:10598', 'text']]);
  });

  it('a depth-6 walk through instances paginates to the end without repeating a layer', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await harness.call('fig_tree', { file, root: '1002:6666', depth: 6, cursor });
      assert.ok(r.size < 20_000, `page ${pages} was ${r.size} chars`);
      for (const n of r.json['nodes'] as { guid: string }[]) {
        assert.equal(seen.has(n.guid), false, `${n.guid} was returned twice`);
        seen.add(n.guid);
      }
      cursor = r.json['nextCursor'] as string | undefined;
      pages++;
    } while (cursor && pages < 100);
    assert.equal(cursor, undefined, 'the walk finishes');
    assert.ok(seen.size > 1_000);
  });
});

describe('iOS 16 UI Kit — typography as Figma lays it out', { skip }, () => {
  it('every auto line height is laid out at the font\'s natural height, and reads as auto', () => {
    // Figma lays an auto line height out at the font's natural height, rounded up to a whole
    // pixel by newer text layout versions (28.64 -> 29). The live value is the text style's when
    // the node has one (F22): a stale 100 PERCENT beside a 24 px style is laid out at 24 px.
    let checked = 0;
    const wrong: string[] = [];
    for (const t of index.tree.ordered) {
      if (t.node['type'] !== 'TEXT') continue;
      const live = applyStyles(index, t.node, { text: true });
      const lineHeight = live['lineHeight'] as { value?: number; units?: string } | undefined;
      if (lineHeight?.units !== 'PERCENT' || lineHeight.value !== 100) continue;
      const derived = t.node['derivedTextData'] as
        | { baselines?: { lineHeight: number }[]; fontMetaData?: { fontLineHeight: number }[] }
        | undefined;
      const laidOut = derived?.baselines?.[0]?.lineHeight;
      const natural = derived?.fontMetaData?.[0]?.fontLineHeight;
      if (laidOut === undefined || natural === undefined) continue;
      checked++;
      const exact = natural * (live['fontSize'] as number);
      const reported = textView(index, t, false)!.baseStyle!['lineHeight'];
      if (laidOut < exact - 0.01 || laidOut > Math.ceil(exact) + 0.01 || reported !== 'auto') {
        wrong.push(`${t.key}: laid out ${laidOut}, natural ${exact}, reported ${reported}`);
      }
    }
    assert.ok(checked >= 50, `${checked} auto line heights checked`);
    assert.deepEqual(wrong, []);
  });

  it('a translucent label keeps its alpha in fig_text', async () => {
    // "Label Color/Light/Tertiary" is #3C3C43 at 30 %: the weekday labels of the DatePicker.
    const r = await harness.call('fig_text', { file, scope: 'I1319:26210;55:4468' });
    const sun = (r.json['texts'] as Record<string, any>[])[0]!;
    assert.equal(sun['characters'], 'SUN');
    assert.equal(sun['style'].color, '#3C3C434D');
  });

  it('the lock screen clock has no single colour: its fills come back', async () => {
    const r = await harness.call('fig_style', { file, guid: '1324:20951' });
    const typography = (r.json['style'] as Record<string, any>)['typography'];
    assert.equal(typography.color, undefined);
    assert.deepEqual(
      (typography.fills as { type: string; blendMode?: string }[]).map((p) => [p.type, p.blendMode]),
      [['SOLID', 'OVERLAY'], ['SOLID', 'SOFT_LIGHT'], ['GRADIENT_LINEAR', 'OVERLAY']],
    );
  });
});

describe('iOS 16 UI Kit — strokes', { skip }, () => {
  it('only a node with a visible stroke reports a stroke weight', () => {
    // Figma writes strokeWeight 1 on almost every node: 5 842 of them here have no stroke at all.
    const wrong: string[] = [];
    let stroked = 0;
    for (const t of index.tree.ordered) {
      const style = styleBlock(index, t);
      const shows = ((style['strokes'] as { visible?: boolean }[] | undefined) ?? []).some((p) => p.visible !== false);
      if (shows) stroked++;
      if (!shows && (style['strokeWeight'] !== undefined || style['strokeWeights'] !== undefined)) wrong.push(t.key);
    }
    assert.ok(stroked > 500, `${stroked} stroked nodes`);
    assert.deepEqual(wrong.slice(0, 5), []);
  });

  it('a hairline on one side reports that side alone', async () => {
    const nav = await harness.call('fig_style', { file, guid: '1340:17036' });
    assert.deepEqual((nav.json['style'] as Record<string, any>)['strokeWeights'], { top: 0, right: 0, bottom: 0.5, left: 0 });
    const tabs = await harness.call('fig_node', { file, guid: '1340:17061', includeChildren: false });
    assert.deepEqual((tabs.json['node'] as Record<string, any>)['strokeWeights'], { top: 0.5, right: 0, bottom: 0, left: 0 });
  });
});
