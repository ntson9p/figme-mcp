/**
 * Golden tests against figma-input/sample.fig.
 *
 * Deliberately ONE file: a full parse holds ~900 MB of decoded JS objects, and `node --test`
 * runs test *files* in parallel processes. Keeping every asset-dependent assertion here means
 * exactly one parse for the whole suite. Sections mirror the plan's milestones.
 *
 * Every expected value comes from Appendix A of docs/mcp-implementation-plan.md.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ASSET_EXISTS, ASSET_PATH, SKIP_MESSAGE, readAsset } from '../fixtures/asset.ts';
import { parseFig } from '../../dist/fig/parse.js';
import type { ParsedFig } from '../../dist/fig/parse.js';
import { FileIndex, nodeImageHashes } from '../../dist/model/index.js';
import { connect, type Harness } from '../fixtures/mcp.ts';
import { textView } from '../../dist/model/text.js';

const skip = ASSET_EXISTS ? false : SKIP_MESSAGE;

let fig: ParsedFig;
before(() => {
  if (ASSET_EXISTS) fig = parseFig(readAsset());
});

describe('M1 — container, chunks, schema and message', { skip }, () => {
  it('the asset is the exact file the golden values were measured on', () => {
    assert.equal(fs.statSync(ASSET_PATH).size, 38_860_863);
  });

  it('unwraps the ZIP container via the central directory', () => {
    assert.equal(fig.container, 'zip');
    const zip = fig.zip!;
    assert.equal(zip.entry('canvas.fig')?.method, 0, 'canvas.fig is stored');
    assert.equal(zip.entry('meta.json')?.method, 8, 'meta.json is deflated');
    assert.ok(zip.has('thumbnail.png'));
    assert.equal(zip.names().filter((n) => /^images\/.+/.test(n)).length, 252);
    assert.equal(zip.size, 256, '252 images + images/ dir + canvas.fig + meta.json + thumbnail');
  });

  it('reads meta.json', () => {
    assert.equal(fig.meta?.file_name, 'Sample Design');
    assert.match(String(fig.meta?.exported_at), /^\d{4}-\d{2}-\d{2}T/);
  });

  it('reads the fig-kiwi header version', () => {
    assert.equal(fig.version, 106);
  });

  it('sniffs a different codec for each chunk', () => {
    assert.equal(fig.chunks.length, 2);
    assert.deepEqual(fig.chunks[0], {
      index: 0,
      compressedSize: 29_408,
      size: 73_430,
      codec: 'deflate-raw',
    });
    assert.deepEqual(fig.chunks[1], {
      index: 1,
      compressedSize: 6_968_508,
      size: 63_385_564,
      codec: 'zstd',
    });
  });

  it('decodes the embedded binary schema exactly', () => {
    assert.equal(fig.schema.length, 638);
    const kinds = { ENUM: 0, STRUCT: 0, MESSAGE: 0 };
    for (const d of fig.schema) kinds[d.kind]++;
    assert.deepEqual(kinds, { MESSAGE: 398, STRUCT: 30, ENUM: 210 });
  });

  it('decodes the data chunk as Message, consuming every byte', () => {
    // parseFig throws on trailing bytes, so reaching here already proves exact consumption.
    assert.equal(fig.message['type'], 'NODE_CHANGES');
    assert.deepEqual(Object.keys(fig.message), [
      'type',
      'sessionID',
      'ackID',
      'originFileKey',
      'nodeChangeOrder',
      'nodeChanges',
      'blobs',
    ]);
    assert.equal(fig.nodeChanges.length, 116_142);
    assert.equal(fig.blobs.length, 9_651);
  });

  it('passes every §7 invariant with no warnings', () => {
    assert.deepEqual(fig.warnings, []);
  });

  it('parses well inside the 15 s budget', () => {
    assert.ok(fig.parseMs < 15_000, `parse took ${Math.round(fig.parseMs)} ms`);
  });
});

describe('M2 — tree, index and the exploration tools', { skip }, () => {
  let index: FileIndex;
  let harness: Harness;

  before(async () => {
    index = new FileIndex(fig);
    harness = await connect();
  });
  after(async () => {
    await harness?.close();
  });

  it('rebuilds the layer tree with one DOCUMENT root and no orphans', () => {
    assert.equal(index.root?.key, '0:0');
    assert.equal(index.tree.orphans.length, 0);
    assert.equal(index.nodeCount, 116_142);
  });

  it('finds the 10 pages in document order', () => {
    assert.deepEqual(
      index.pages.map((p) => p.node['name']),
      [
        'Page 1',
        'Page 2',
        'Page 3',
        'Page 4',
        'Page 5',
        'Page 6',
        'Page 7',
        '---',
        'Page 9',
        'Page 10',
      ],
    );
  });

  it('counts node types exactly as Appendix A', () => {
    assert.deepEqual(index.typeCounts, {
      INSTANCE: 38_164,
      FRAME: 32_160,
      TEXT: 16_894,
      VECTOR: 15_770,
      ROUNDED_RECTANGLE: 5_566,
      BOOLEAN_OPERATION: 2_946,
      SYMBOL: 2_046,
      ELLIPSE: 1_189,
      LINE: 389,
      RECTANGLE: 384,
      VARIABLE: 273,
      WIDGET: 115,
      SECTION: 89,
      SHAPE_WITH_TEXT: 80,
      VARIABLE_SET: 27,
      BRUSH: 25,
      CONNECTOR: 14,
      CANVAS: 10,
      DOCUMENT: 1,
    });
  });

  it('fig_overview reports the file, pages and counts', async () => {
    const r = await harness.call('fig_overview', { file: ASSET_PATH });
    assert.equal(r.isError, false);
    assert.equal(r.json['name'], 'Sample Design');
    assert.equal(r.json['formatVersion'], 106);
    assert.equal(r.json['nodes'], 116_142);
    assert.equal(r.json['images'], 212);
    assert.equal(r.json['components'], 2_046);
    assert.equal((r.json['pages'] as unknown[]).length, 10);
    assert.ok(r.size < 20_000, `overview was ${r.size} chars`);
  });

  it('serves the second call from cache instead of re-parsing', async () => {
    const before = { ...harness.ctx.cache.stats };
    await harness.call('fig_overview', { file: ASSET_PATH });
    assert.equal(harness.ctx.cache.stats.parses, before.parses, 'must not re-parse');
    assert.equal(harness.ctx.cache.stats.hits, before.hits + 1);
  });

  it('fig_tree at depth 2 from the DOCUMENT stays under 20 KB and paginates', async () => {
    const r = await harness.call('fig_tree', { file: ASSET_PATH, depth: 2 });
    assert.ok(r.size < 20_000, `tree response was ${r.size} chars`);
    const nodes = r.json['nodes'] as { guid: string; depth: number }[];
    assert.ok(nodes.length <= 300, 'never more than 300 nodes');
    assert.equal(nodes[0]!.guid, '0:0');
    assert.equal(r.json['truncated'], true, 'a 116k-node document must truncate at depth 2');
    const cursor = r.json['nextCursor'] as string;
    assert.ok(cursor);
    const page2 = await harness.call('fig_tree', { file: ASSET_PATH, depth: 2, cursor });
    const nodes2 = page2.json['nodes'] as { guid: string }[];
    assert.ok(nodes2.length > 0);
    assert.equal(
      nodes.some((n) => n.guid === nodes2[0]!.guid),
      false,
      'the cursor must not repeat nodes',
    );
  });

  it('fig_tree outline format is denser and readable', async () => {
    const r = await harness.call('fig_tree', {
      file: ASSET_PATH,
      root: '2:1339',
      depth: 3,
      format: 'outline',
    });
    assert.match(r.text, /\[FRAME\] 134x40 "Frame 39" \(2:1339\) x4/);
    assert.match(r.text, /\n {2}\[TEXT\] 64x24 "text" \(2:1341\)/);
  });

  it('fig_node summary and full match Appendix A for 2:1339', async () => {
    const s = await harness.call('fig_node', { file: ASSET_PATH, guid: '2:1339', detail: 'summary' });
    assert.deepEqual(s.json['node'], {
      guid: '2:1339',
      type: 'FRAME',
      name: 'Frame 39',
      size: '134x40',
      children: 4,
      page: 'Page 1',
    });

    const f = await harness.call('fig_node', { file: ASSET_PATH, guid: '2:1339' });
    const node = f.json['node'] as Record<string, any>;
    assert.equal(node['type'], 'FRAME');
    assert.deepEqual(node['geometry'], {
      width: 134,
      height: 40,
      x: 0,
      y: 0,
      absoluteX: 0,
      absoluteY: 0,
    });
    assert.equal(node['cornerRadius'], 4);
    assert.equal(node['strokeWeight'], 1);
    assert.deepEqual(node['autoLayout'], {
      mode: 'HORIZONTAL',
      spacing: 8,
      padding: { top: 8, right: 16, bottom: 8, left: 16 },
      primaryAlign: 'CENTER',
      counterAlign: 'CENTER',
      primarySizing: 'FIXED',
    });
    assert.equal(node['strokes'][0].type, 'SOLID');
    assert.equal(node['strokes'][0].color, '#FFFFFF');
    assert.equal(
      node['strokes'][0].colorVar.assetRef,
      '0dc9ea8b757859cd04ebcfa4be474a66418c1e50@833:1318',
    );
    assert.equal(node['childrenCount'], 4);
    assert.ok(f.size < 20_000);
  });

  it('fig_node full matches Appendix A for the text node 2:1341', async () => {
    const r = await harness.call('fig_node', { file: ASSET_PATH, guid: '2:1341' });
    const node = r.json['node'] as Record<string, any>;
    assert.equal(node['type'], 'TEXT');
    assert.equal(node['geometry'].width, 64);
    assert.equal(node['geometry'].height, 24);
    assert.equal(node['geometry'].x, 40, 'transform.m02');
    assert.equal(node['geometry'].y, 8, 'transform.m12');
    assert.equal(node['text'].characters, 'Text');
    assert.equal(node['text'].font, 'Meiryo Regular');
    assert.equal(node['text'].fontSize, 16);
    assert.equal(node['text'].lineHeight, '1.5');
    assert.equal(node['text'].align, 'CENTER');
  });

  it('fig_node raw exposes the decoded record verbatim, one node only', async () => {
    const r = await harness.call('fig_node', {
      file: ASSET_PATH,
      guid: '2:1339',
      detail: 'raw',
      includeChildren: false,
    });
    const node = r.json['node'] as Record<string, unknown>;
    assert.equal(node['guid'], '2:1339');
    assert.equal(node['phase'], 'CREATED');
    assert.equal(node['stackHorizontalPadding'], 16);
    assert.equal(node['rectangleCornerRadiiIndependent'], true);
    assert.equal(r.json['children'], undefined);
  });

  it('fig_node reports a clear error for an unknown guid', async () => {
    const r = await harness.call('fig_node', { file: ASSET_PATH, guid: '99999:1' });
    assert.equal(r.isError, true);
    assert.match(r.text, /no node with guid "99999:1"/);
  });

  it('fig_find matches names and text, with page and breadcrumb', async () => {
    const r = await harness.call('fig_find', { file: ASSET_PATH, query: 'sample', types: ['TEXT'] });
    const results = r.json['results'] as Record<string, string>[];
    assert.ok(results.length > 0);
    assert.ok((r.json['totalMatches'] as number) > results.length);
    for (const hit of results) {
      assert.equal(hit['type'], 'TEXT');
      assert.ok(hit['page'], 'every hit names its page');
      assert.ok(hit['path'], 'every hit carries a breadcrumb');
      assert.ok(['name', 'text'].includes(hit['matchedOn']!));
    }
    assert.ok(r.size < 20_000);
  });

  it('fig_find honours scope and requires a query or a type filter', async () => {
    const scoped = await harness.call('fig_find', {
      file: ASSET_PATH,
      query: 'text',
      scope: '2:1339',
    });
    const results = scoped.json['results'] as { guid: string }[];
    assert.deepEqual(
      results.map((x) => x.guid),
      ['2:1341'],
    );
    const bad = await harness.call('fig_find', { file: ASSET_PATH });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /needs at least a .query. or a .types. filter/);
  });
});

describe('M3 — text runs and resolved style', { skip }, () => {
  let index: FileIndex;
  let harness: Harness;

  before(async () => {
    index = new FileIndex(fig);
    harness = await connect();
  });
  after(async () => {
    await harness?.close();
  });

  it('resolves the styled runs of 2:7099 from characterStyleIDs', () => {
    const t = index.node('2:7099')!;
    const ids = (t.node['textData'] as Record<string, unknown>)['characterStyleIDs'];
    assert.deepEqual(ids, [12, 12, 12, 12, 12, 12, 12, 12, 12, 10, 9, 10, 10, 10]);

    const view = textView(index, t, true)!;
    assert.equal(view.characters, 'Yesterday 9:41');
    assert.equal(view.characterCount, 14, 'one id per UTF-16 code unit');
    assert.equal(view.hasStyledRuns, true);
    assert.deepEqual(
      view.runs!.map((r) => [r.start, r.end, r.text, r.styleID]),
      [
        [0, 9, 'Yesterday', 12],
        [9, 10, ' ', 10],
        [10, 11, '9', 9],
        [11, 14, ':41', 10],
      ],
    );
    // The override table entries carry styleIdForText refs, which resolve inside this file.
    assert.deepEqual(new Set(view.runs!.map((r) => r.styleID)), new Set([12, 10, 9]));
    for (const run of view.runs!) {
      const styles = run.style!['styles'] as Record<string, Record<string, string>>;
      assert.ok(styles['text']!['assetRef'], `run ${run.styleID} carries a text style ref`);
    }
    assert.equal(
      (view.runs![0]!.style!['styles'] as Record<string, Record<string, string>>)['text']!['name'],
      'Caption2/Medium',
    );
  });

  it('a run of unstyled text collapses to a single base-style run', () => {
    const view = textView(index, index.node('2:1341')!, true)!;
    assert.equal(view.characters, 'Text');
    assert.equal(view.hasStyledRuns, false);
    assert.deepEqual(view.runs, [{ start: 0, end: 4, text: 'Text', styleID: 0 }]);
    assert.equal(view.baseStyle!['font'], 'Meiryo Regular');
    assert.equal(view.baseStyle!['fontSize'], 16);
  });

  it('fig_style translates auto-layout into flexbox terms for 2:1339', async () => {
    const r = await harness.call('fig_style', { file: ASSET_PATH, guid: '2:1339' });
    const style = r.json['style'] as Record<string, any>;
    assert.equal(style['cornerRadius'], 4);
    assert.deepEqual(style['layout'], {
      display: 'flex',
      direction: 'row',
      gap: 8,
      padding: '8px 16px',
      paddingBox: { top: 8, right: 16, bottom: 8, left: 16 },
      justifyContent: 'center',
      alignItems: 'center',
      primarySizing: 'fixed',
    });
    assert.deepEqual(style['inParentLayout'], { flexGrow: 1, alignSelf: 'stretch' });
    assert.equal(style['strokes'][0].color, '#FFFFFF');
    assert.equal(style['strokes'][0].colorVar.variable, 'tab/large/underline');
    assert.equal(
      style['strokes'][0].colorVar.assetRef,
      '0dc9ea8b757859cd04ebcfa4be474a66418c1e50@833:1318',
    );
    assert.ok(r.size < 20_000);
  });

  it('fig_style reports typography and resolves local shared styles for 2:1341', async () => {
    const r = await harness.call('fig_style', { file: ASSET_PATH, guid: '2:1341' });
    const style = r.json['style'] as Record<string, any>;
    assert.equal(style['typography'].font, 'Meiryo Regular');
    assert.equal(style['typography'].fontSize, 16);
    assert.equal(style['typography'].lineHeight, '1.5');
    assert.equal(style['typography'].color, '#333333');
    assert.equal(style['styles'].text.name, 'Meiryo/Regular/16');
    assert.equal(style['styles'].text.defines.fontSize, 16);
    assert.equal((r.json['text'] as Record<string, unknown>)['characters'], 'Text');
  });

  it('fig_text inventories copy with a compact style, and paginates', async () => {
    const r = await harness.call('fig_text', { file: ASSET_PATH });
    assert.equal(r.json['totalTextNodes'], 16_894);
    const texts = r.json['texts'] as Record<string, any>[];
    assert.ok(texts.length > 0 && texts.length <= 300);
    assert.equal(r.json['truncated'], true);
    assert.ok(r.size < 20_000, `fig_text was ${r.size} chars`);
    for (const item of texts) {
      assert.ok(typeof item['characters'] === 'string');
      assert.ok(item['page']);
      assert.deepEqual(Object.keys(item['style'] ?? {}).sort().length >= 1, true);
    }
    const next = await harness.call('fig_text', {
      file: ASSET_PATH,
      cursor: r.json['nextCursor'],
    });
    assert.notEqual((next.json['texts'] as { guid: string }[])[0]!.guid, texts[0]!['guid']);
  });

  it('fig_text scoped with runs returns the resolved spans', async () => {
    const r = await harness.call('fig_text', {
      file: ASSET_PATH,
      scope: '2:7098',
      includeRuns: true,
    });
    const texts = r.json['texts'] as Record<string, any>[];
    const time = texts.find((t) => t['guid'] === '2:7099')!;
    assert.equal(time['characters'], 'Yesterday 9:41');
    assert.equal(time['hasStyledRuns'], true);
    assert.equal((time['runs'] as unknown[]).length, 4);
  });
});

describe('M4 — components, instances and variables', { skip }, () => {
  let harness: Harness;

  before(async () => {
    harness = await connect();
  });
  after(async () => {
    await harness?.close();
  });

  it('fig_components lists the 2,046 SYMBOLs, most-instantiated first', async () => {
    const r = await harness.call('fig_components', { file: ASSET_PATH, limit: 5 });
    assert.equal(r.json['totalComponents'], 2_046);
    const list = r.json['components'] as Record<string, any>[];
    assert.equal(list.length, 5);
    for (let i = 1; i < list.length; i++) {
      assert.ok(
        (list[i - 1]!['instances'] as number) >= (list[i]!['instances'] as number),
        'components come back most-used first',
      );
    }
    assert.ok(list[0]!['variantOf'], 'the busiest component is a variant of a component set');
    assert.ok(r.size < 20_000);
  });

  it('fig_components resolves variant property names from the component set', async () => {
    const r = await harness.call('fig_components', { file: ASSET_PATH, query: 'lv2/tab/large' });
    const list = r.json['components'] as Record<string, any>[];
    const tab = list.find((c) => c['guid'] === '2:1337')!;
    assert.equal(tab['name'], 'lv2/tab/large');
    assert.equal(tab['instances'], 599);
    const names = (tab['propDefs'] as { name: string }[]).map((p) => p.name);
    assert.ok(names.includes('show badge(🔴)'));
    assert.ok(names.includes('icon'));
  });

  it('fig_instance resolves 2:1329 to symbol 2:1325 and lists its override', async () => {
    const r = await harness.call('fig_instance', { file: ASSET_PATH, guid: '2:1329' });
    const instance = r.json['instance'] as Record<string, any>;
    assert.equal(instance['guid'], '2:1329');
    assert.equal(instance['symbol'].guid, '2:1325');
    assert.equal(instance['symbol'].name, 'lv1/color/GL/#FFFFFF');
    assert.equal(instance['symbol'].inFile, true);
    assert.equal(r.json['overrideCount'], 1);
    const override = (r.json['overrides'] as Record<string, any>[])[0]!;
    // guidPath addresses component descendants by overrideKey, not by guid.
    assert.deepEqual(override['path'], ['0:2528']);
    assert.equal(override['targetGuid'], '2:1325');
    assert.equal(override['fields'].size, '22x22');
    assert.equal(override['fields'].fillsCleared, true);
  });

  it('fig_instance resolves guid-addressed and nested override paths to their targets', async () => {
    // A component created in this file has no overrideKey on its children: the path IS the guid.
    const card = await harness.call('fig_instance', { file: ASSET_PATH, guid: '863:171090' });
    const text = (card.json['overrides'] as Record<string, any>[])[0]!;
    assert.deepEqual(text['path'], ['2:251114']);
    assert.equal(text['targetGuid'], '2:251114');
    assert.equal(text['targetType'], 'TEXT');
    assert.equal(text['fields'].text.characters, 'Alpha | Beta | Gamma');

    // A two-segment path walks into the nested instance's symbol for its second segment.
    const panel = await harness.call('fig_instance', { file: ASSET_PATH, guid: '863:171102' });
    const nested = (panel.json['overrides'] as Record<string, any>[]).find(
      (o) => o['path'].length === 2,
    )!;
    assert.deepEqual(nested['path'], ['0:5668', '0:9389']);
    assert.equal(nested['targetGuid'], '2:2610');
    assert.equal(nested['targetName'], 'Rectangle 10');
  });

  it('fig_instance resolves component-property assignments to their names', async () => {
    const r = await harness.call('fig_instance', { file: ASSET_PATH, guid: '8917:139972' });
    const props = (r.json['instance'] as Record<string, any>)['propAssignments'] as Record<
      string,
      any
    >[];
    const byName = new Map(props.map((p) => [p['name'], p['value']]));
    assert.equal(byName.get('text'), 'Back');
    assert.equal(byName.get('show text'), false);
    assert.deepEqual(byName.get('icon'), { guid: '2:2307', name: 'direction=left' });
  });

  it('fig_instance refuses a non-instance guid with a useful message', async () => {
    const r = await harness.call('fig_instance', { file: ASSET_PATH, guid: '2:1339' });
    assert.equal(r.isError, true);
    assert.match(r.text, /is a FRAME, not an INSTANCE/);
  });

  it('fig_variables reports 273 variables across 27 collections', async () => {
    const r = await harness.call('fig_variables', { file: ASSET_PATH, limit: 5 });
    assert.equal(r.json['totalVariables'], 273);
    assert.equal(r.json['totalSets'], 27);
    const sets = r.json['sets'] as { name: string; modes: unknown[]; variableCount: number }[];
    assert.equal(sets.length, 27);
    assert.equal(
      sets.reduce((a, s) => a + s.variableCount, 0),
      273,
      'every variable is attributed to exactly one collection',
    );
    assert.ok(r.size < 20_000);
  });

  it('a colour variable renders its per-mode values as hex', async () => {
    const r = await harness.call('fig_variables', {
      file: ASSET_PATH,
      query: 'tab/large/bg',
      includeSets: false,
    });
    const v = (r.json['variables'] as Record<string, any>[])[0]!;
    assert.equal(v['name'], 'tab/large/bg');
    assert.equal(v['type'], 'COLOR');
    assert.equal(v['set'], 'active/inactive');
    assert.deepEqual(v['values'], { active: '#FFFFFF', inactive: '#EEEEEE' });
  });

  it('an alias chain resolves through to the concrete colour', async () => {
    const r = await harness.call('fig_variables', {
      file: ASSET_PATH,
      query: 'tab/large/underline',
      includeSets: false,
    });
    const v = (r.json['variables'] as Record<string, any>[])[0]!;
    assert.equal(v['guid'], '2:1319');
    // 2:1319 aliases GL/FFFFFF and GL/333333; both are local, so hex comes back, not a ref.
    assert.deepEqual(v['values'], { active: '#FFFFFF', inactive: '#333333' });
  });
});

describe('M5 — images and blobs', { skip }, () => {
  let index: FileIndex;
  let harness: Harness;
  const SAMPLE_HASH = '01ef2f8cd2d276901473acb9ddd7afb2421198e3';
  let tmpDir: string;

  before(async () => {
    index = new FileIndex(fig);
    harness = await connect();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figme-test-'));
  });
  after(async () => {
    await harness?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('every one of the 212 referenced image hashes resolves to a ZIP entry', () => {
    assert.equal(index.imageHashes.size, 212);
    const missing = [...index.imageHashes].filter((h) => !fig.zip!.has(`images/${h}`));
    assert.deepEqual(missing, []);
  });

  it('fig_image returns image content with the sniffed mime type', async () => {
    const r = await harness.call('fig_image', { file: ASSET_PATH, hash: SAMPLE_HASH });
    const [img, meta] = r.content as [
      { type: string; mimeType: string; data: string },
      { type: string; text: string },
    ];
    assert.equal(img.type, 'image');
    assert.equal(img.mimeType, 'image/png');
    assert.equal(Buffer.from(img.data, 'base64').length, 4_553);
    const parsed = JSON.parse(meta.text) as Record<string, unknown>;
    assert.equal(parsed['byteLength'], 4_553);
    assert.equal(parsed['width'], 88);
    assert.equal(parsed['height'], 84);
    assert.equal(parsed['inlined'], true);
  });

  it('fig_image serves the document thumbnail', async () => {
    const r = await harness.call('fig_image', { file: ASSET_PATH, hash: 'thumbnail' });
    const meta = JSON.parse((r.content[1] as { text: string }).text) as Record<string, unknown>;
    assert.equal(meta['entry'], 'thumbnail.png');
    assert.equal(meta['mime'], 'image/png');
    assert.equal(meta['width'], 400, 'matches meta.json thumbnail_size');
    assert.equal(meta['height'], 219);
  });

  it('fig_image savePath writes bytes identical to the ZIP entry', async () => {
    const target = path.join(tmpDir, 'nested', 'out.png');
    const r = await harness.call('fig_image', {
      file: ASSET_PATH,
      hash: SAMPLE_HASH,
      savePath: target,
    });
    assert.equal(r.json['bytesWritten'], 4_553);
    assert.deepEqual(fs.readFileSync(target), fig.zip!.read(`images/${SAMPLE_HASH}`));
  });

  it('fig_image resolves images through a node guid, and reports unknown hashes clearly', async () => {
    const owner = index.tree.ordered.find((t) => nodeImageHashes(t.node).length === 1)!;
    const r = await harness.call('fig_image', { file: ASSET_PATH, guid: owner.key });
    assert.equal((r.content[0] as { type: string }).type, 'image');

    const bad = await harness.call('fig_image', { file: ASSET_PATH, hash: 'deadbeef' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /no image "deadbeef"/);
    assert.match(bad.text, /212 hashes are referenced/);

    const noImages = await harness.call('fig_image', { file: ASSET_PATH, guid: '2:1339' });
    assert.equal(noImages.isError, true);
    assert.match(noImages.text, /has no image fills/);
  });

  it('fig_blob returns base64 bytes of the right length', async () => {
    const r = await harness.call('fig_blob', { file: ASSET_PATH, index: 0 });
    assert.equal(r.json['blobCount'], 9_651);
    assert.equal(r.json['encoding'], 'base64');
    const data = Buffer.from(r.json['data'] as string, 'base64');
    assert.equal(data.length, r.json['byteLength']);
    assert.equal(data.length, r.json['returnedBytes']);
    assert.equal(r.json['truncated'], undefined);
  });

  it('fig_blob truncates oversized blobs with a flag, and rejects a bad index', async () => {
    const r = await harness.call('fig_blob', {
      file: ASSET_PATH,
      index: 16,
      maxBytes: 8,
      encoding: 'hex',
    });
    assert.equal(r.json['returnedBytes'], 8);
    assert.equal(r.json['truncated'], true);
    assert.equal((r.json['data'] as string).length, 16, 'hex is 2 chars per byte');
    assert.ok((r.json['byteLength'] as number) > 8);
    assert.match(r.json['hint'] as string, /raise maxBytes/);

    const oob = await harness.call('fig_blob', { file: ASSET_PATH, index: 999_999 });
    assert.equal(oob.isError, true);
    assert.match(oob.text, /out of range; this file has 9651 blobs/);
  });
});

describe('M6 — response budgets and hardening', { skip }, () => {
  let harness: Harness;

  before(async () => {
    harness = await connect();
  });
  after(async () => {
    await harness?.close();
  });

  it('registers exactly the 12 tools, each with a description', async () => {
    const tools = await harness.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        'fig_blob',
        'fig_components',
        'fig_find',
        'fig_image',
        'fig_instance',
        'fig_node',
        'fig_overview',
        'fig_render',
        'fig_style',
        'fig_text',
        'fig_tree',
        'fig_variables',
      ],
    );
    for (const t of tools) assert.ok((t.description ?? '').length > 40, `${t.name} needs a description`);
  });

  it('a depth-6 tree of the busiest page truncates, flags it, and hands back a cursor', async () => {
    const r = await harness.call('fig_tree', { file: ASSET_PATH, root: '0:2', depth: 6 });
    assert.ok(r.size < 20_000, `depth-6 response was ${r.size} chars`);
    assert.equal(r.json['truncated'], true);
    assert.ok(r.json['nextCursor'], 'a truncated tree must offer a cursor');
    assert.match(r.json['hint'] as string, /nextCursor/);
    const nodes = r.json['nodes'] as { guid: string }[];
    assert.ok(nodes.length <= 300);

    // The cursor must make progress and never repeat what was already returned.
    const seen = new Set(nodes.map((n) => n.guid));
    let cursor = r.json['nextCursor'] as string | undefined;
    for (let page = 0; page < 3 && cursor; page++) {
      const next = await harness.call('fig_tree', {
        file: ASSET_PATH,
        root: '0:2',
        depth: 6,
        cursor,
      });
      const batch = next.json['nodes'] as { guid: string }[];
      assert.ok(batch.length > 0, 'each page makes progress');
      for (const n of batch) {
        assert.equal(seen.has(n.guid), false, `${n.guid} was returned twice`);
        seen.add(n.guid);
      }
      assert.ok(next.size < 20_000);
      cursor = next.json['nextCursor'] as string | undefined;
    }
  });

  it('a depth-6 outline of the same page also stays inside the budget', async () => {
    const r = await harness.call('fig_tree', {
      file: ASSET_PATH,
      root: '0:2',
      depth: 6,
      format: 'outline',
    });
    assert.ok(r.size < 20_000, `outline response was ${r.size} chars`);
    assert.match(r.text, /truncated after \d+ nodes\. nextCursor: /);
  });

  it('no tool exceeds the hard cap, even when asked for the maximum', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['fig_overview', {}],
      ['fig_tree', { depth: 6, limit: 300 }],
      ['fig_node', { guid: '0:2' }],
      ['fig_node', { guid: '2:1337', detail: 'raw' }],
      ['fig_find', { types: ['TEXT'], limit: 300 }],
      ['fig_text', { includeRuns: true, includePath: true }],
      ['fig_style', { guid: '2:1339' }],
      ['fig_components', { limit: 300 }],
      ['fig_instance', { guid: '8917:139972' }],
      ['fig_variables', { limit: 300 }],
      ['fig_blob', { index: 0, maxBytes: 262_144 }],
    ];
    for (const [name, args] of calls) {
      const r = await harness.call(name, { file: ASSET_PATH, ...args });
      assert.equal(r.isError, false, `${name} errored: ${r.text.slice(0, 200)}`);
      assert.ok(r.size <= 50_000, `${name} returned ${r.size} chars, over the 50k hard cap`);
    }
  });

  it('an invalid cursor is reported rather than silently ignored', async () => {
    const r = await harness.call('fig_tree', { file: ASSET_PATH, cursor: 'not-a-cursor' });
    assert.equal(r.isError, true);
    assert.match(r.text, /invalid cursor/);
  });

  it('a missing file produces a clear error, not a crash', async () => {
    const r = await harness.call('fig_overview', { file: 'does-not-exist.fig' });
    assert.equal(r.isError, true);
    assert.match(r.text, /file not found/);
  });

  it('a non-.fig file reports what bytes it saw', async () => {
    const notFig = path.join(os.tmpdir(), `figme-notfig-${process.pid}.fig`);
    fs.writeFileSync(notFig, Buffer.from('this is not a figma file at all'));
    try {
      const r = await harness.call('fig_overview', { file: notFig });
      assert.equal(r.isError, true);
      assert.match(r.text, /not a readable \.fig/);
      assert.match(r.text, /74 68 69 73/, 'the error carries the observed magic bytes');
    } finally {
      fs.rmSync(notFig, { force: true });
    }
  });
});
