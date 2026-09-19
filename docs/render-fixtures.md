# Making render fixtures

A **fixture** is one Figma design plus Figma's own exports of some of its frames. The exports
are the oracle: they are what `npm run visual` measures our renderer against. Without fixtures
the tester still runs levels 1 and 2 (is the SVG sane, does the render agree with itself), but
nothing is ever *proven* — the coverage table will say `0/N features proven` and it will be
right to.

This guide is for the person with the Figma account. Nothing here needs the codebase.

---

## 1. The layout

```
fixtures/<design>/
  design.fig                  saved from Figma in the same sitting as the exports
  exports/
    2_39.png  2_39@2x.png  2_39.svg      (guid form — what the plugin in §3 produces)
    Tab.png   Tab@2x.png   Tab.svg       (layer-name form — manual export)
  manifest.json               written by the plugin; optional, but it removes all ambiguity
  expect.json                 written by `npm run visual:update`; commit it
```

`<design>` is any directory name. Several fixtures can coexist; the tester walks them all.

A guid contains a colon, which is illegal in a Windows file name, so `2:1339` becomes `2_39`.

---

## 2. What to export, and how

For every frame you want as an oracle, export from Figma **in the same sitting** as you save the
`.fig` (File → Save local copy). Any edit between the two invalidates the fixture: the tester
would be comparing a render of one version against an export of another, and every difference it
reported would be your edit rather than our bug.

Export three things per frame:

| what | settings |
|---|---|
| PNG at 1× | the truth, at the size Figma thinks the frame is |
| PNG at 2× | the same, where anti-aliasing has somewhere to go |
| SVG | **Outline text ON** (mandatory), *Include "id" attribute* off, *Simplify stroke* off |

**Outline text is not optional.** With it off, Figma writes `<text>` elements that need the font
installed on whatever machine runs the tester; the geometry comparison is then measuring font
availability, not our code. The tester detects this and skips level 3 with the note
`figma-svg-has-text`, so nothing breaks — you just get no geometry check.

**Prefer frames to bare text nodes.** Figma crops a text export to its ink, while we render it
at its layout box, so the two sizes disagree and the frame is reported as a size mismatch. The
plugin below passes `useAbsoluteBounds: true`, which avoids this.

---

## 3. The fixture-exporter plugin (recommended)

Manual export names files after layers, so two layers called "Tab" produce one file and the
tester has to guess which node it belongs to. This plugin names files by guid and writes the
manifest, which removes the guessing entirely.

Make a folder with three files, then in the Figma **desktop** app: Plugins → Development →
Import plugin from manifest. Select the frames you want (or nothing, to take the whole page) and
run it. Move everything it downloads into `fixtures/<design>/exports/`, and move
`manifest.json` one level up into `fixtures/<design>/`.

`manifest.json` (the plugin's own manifest, not the fixture's)

```json
{ "name": "figme fixture exporter", "id": "figme-fixture-exporter", "api": "1.0.0",
  "main": "code.js", "ui": "ui.html", "editorType": ["figma"] }
```

`code.js`

```js
figma.showUI(__html__, { width: 380, height: 420 });

async function run() {
  const selection = figma.currentPage.selection;
  const nodes = selection.length ? selection : figma.currentPage.children;
  const frames = [];
  for (const node of nodes) {
    if (!('exportAsync' in node)) continue;
    const base = node.id.replace(':', '_');
    const common = { useAbsoluteBounds: true };
    const png = await node.exportAsync({ ...common, format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
    const png2x = await node.exportAsync({ ...common, format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
    const svg = await node.exportAsync({
      ...common,
      format: 'SVG',
      svgOutlineText: true,
      svgIdAttribute: false,
      svgSimplifyStroke: false,
    });
    figma.ui.postMessage({ type: 'file', name: base + '.png', bytes: png });
    figma.ui.postMessage({ type: 'file', name: base + '@2x.png', bytes: png2x });
    figma.ui.postMessage({ type: 'file', name: base + '.svg', bytes: svg });
    frames.push({
      guid: node.id, name: node.name, type: node.type,
      width: node.width, height: node.height,
      png: base + '.png', png2x: base + '@2x.png', svg: base + '.svg',
    });
  }
  const manifest = {
    figmaFile: figma.root.name,
    page: figma.currentPage.name,
    exportedAt: new Date().toISOString(),
    frames,
  };
  figma.ui.postMessage({ type: 'text', name: 'manifest.json', text: JSON.stringify(manifest, null, 2) });
  figma.ui.postMessage({ type: 'done', count: frames.length });
}

run().catch((e) => figma.ui.postMessage({ type: 'error', message: String(e) }));
```

`ui.html`

```html
<body style="font: 12px sans-serif; padding: 8px">
<div id="status">exporting…</div>
<button id="all" hidden>Download all</button>
<ul id="list"></ul>
<script>
const files = [];
const download = (f) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f.blob);
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
};
onmessage = (e) => {
  const m = e.data.pluginMessage;
  if (m.type === 'file') files.push({ name: m.name, blob: new Blob([m.bytes]) });
  if (m.type === 'text') files.push({ name: m.name, blob: new Blob([m.text], { type: 'application/json' }) });
  if (m.type === 'error') { status.textContent = m.message; return; }
  if (m.type === 'done') {
    status.textContent = files.length + ' files for ' + m.count + ' frames';
    for (const f of files) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = f.name;
      b.onclick = () => download(f);
      li.appendChild(b);
      list.appendChild(li);
    }
    all.hidden = false;
    all.onclick = async () => {
      for (const f of files) { download(f); await new Promise((r) => setTimeout(r, 300)); }
    };
  }
};
</script></body>
```

The guids the plugin writes are the same `sessionID:localID` values the `.fig` stores, so the
tester matches them without a heuristic.

---

## 4. The conformance file — the most valuable fixture you can make

Real designs mix twenty features per frame. When one differs, the tester can tell you *where* on
the image it differs and which layer owns it, but not *which feature* is wrong. A conformance
file fixes that: one small frame per feature, named `cf-<feature>`, so a failure names the
feature in the file name.

Build one Figma file with a frame for each of these, export them all at once with the plugin,
save the `.fig`, and put both under `fixtures/conformance/`:

`cf-rect-radius`, `cf-ellipse`, `cf-line`, `cf-star`, `cf-polygon`, `cf-vector-curves`,
`cf-boolean-union`, `cf-boolean-subtract`, `cf-boolean-xor`,
`cf-stroke-inside`, `cf-stroke-outside`, `cf-stroke-center`, `cf-stroke-dashed`,
`cf-stroke-caps`, `cf-stroke-per-side-weights`,
`cf-fill-solid-alpha`, `cf-gradient-linear-rotated`, `cf-gradient-radial`,
`cf-gradient-angular`, `cf-gradient-diamond`,
`cf-image-fill`, `cf-image-fit`, `cf-image-stretch`, `cf-image-crop`, `cf-image-tile`,
`cf-image-rotate`,
`cf-text-plain`, `cf-text-mixed-styles`, `cf-text-underline-strike`, `cf-text-emoji`,
`cf-text-truncated`, `cf-text-vertical-align`,
`cf-frame-clip`, `cf-frame-noclip`, `cf-frame-stroke-over-children`, `cf-group-opacity`,
`cf-blend-each` (one small square per blend mode, labelled),
`cf-mask-outline`, `cf-mask-alpha`, `cf-mask-luminance`, `cf-mask-two-in-one-parent`,
`cf-effect-drop-shadow`, `cf-effect-drop-shadow-spread`, `cf-effect-inner-shadow`,
`cf-effect-layer-blur`, `cf-effect-background-blur`,
`cf-instance-overrides`, `cf-nested-instances`, `cf-rotated-frame`, `cf-section`.

Add a frame for anything the coverage table reports as *present but unproven*: that list is
exactly the set of features the corpus exercises but has never checked against Figma.

### 4.1 Five frames that settle open questions

These are worth making first, because each one decides a behaviour the code currently guesses at
and marks with a report entry. Each has one function to change.

| frame | what it decides | why it is open |
|---|---|---|
| `cf-effect-drop-shadow` and `cf-effect-drop-shadow-spread` | the margin a shadow adds to the export size (`effectMargins` in `src/render/bounds.ts`) | our rule `radius + spread ± offset` predicts 389×216 for the sample's Dynamic Island, but only Figma's own export size can confirm the rule rather than one instance of it |
| `cf-image-crop` | which direction the crop matrix goes (`imageAttrs` in `src/render/paint.ts`) | `paint.transform` is applied as candidate A; if the crop comes out inverted, candidate B is the same expression without `invert()`. Six paints on the sample's main page use it |
| `cf-mask-two-in-one-parent` | whether a second mask ends the first one's run (`emitChildren` in `src/render/export.ts`) | the sample has no parent with two masks, so the rule is assumed |
| `cf-mask-luminance` | whether Figma's LUMINANCE coverage is sRGB or linear | resvg computes it in sRGB; whether Figma agrees is unverified |
| `cf-blend-each` | how far `LINEAR_DODGE` and `LINEAR_BURN` really are from `screen` and `multiply` | they are approximated and reported; the frame says whether that is close enough to keep |

Make `cf-effect-drop-shadow` deliberately asymmetric — a large offset in one direction, a spread,
and a visible colour — so a wrong margin shows as a crop on one side rather than a subtle blur.

---

## 5. Running it

```bash
npm run build
npm run visual                 # levels 1-4 over every fixture, writes reports/visual/index.html
npm run visual -- --only conformance/cf-mask-alpha
npm run visual:update          # record the current scores as the new best (improvements only)
```

Open `reports/visual/index.html`. Each frame shows Figma's export, our render and the diff side
by side, with the levels it passed, the features it exercises, and — when it differs — the
layers the difference was attributed to.

The sample fixture was developed against one real export: a 1× PNG of frame "SCREEN-A", a
1440×3026 form built almost entirely from component instances. It is the export that
exposed the instance defects fixed in September 2026 (plan facts F17–F21). It came from a
design that is not public, so the PNG is not distributed here: level 4 has no oracle until
you add your own export to `fixtures/sample/exports/`, and level 3 and the ceiling still
wait for an SVG export.

### The ceiling

Level 4 compares our render against Figma's PNG, and some of that difference is not ours: font
rasterization, blur maths and resvg's own antialiasing all differ from Figma's engine. The
**ceiling** is Figma's own SVG export rasterized by the same rasterizer and compared against
Figma's own PNG. It is the best score anything on this route can achieve, and it is printed next
to level 4 so an unreachable difference is never mistaken for a bug. Level 4's pass threshold is
`max(3%, ceiling + 1%)` for exactly that reason.

### The ratchet

`expect.json` holds the best `diffRatio` each frame has ever achieved. A test fails when a frame
gets worse by more than 0.2 %, not when it fails to be perfect — so the suite is useful from the
first fixture instead of being red for months. `npm run visual:update` records improvements and
never records a regression. Commit `expect.json`.

---

## 6. Licensing

Community files can be duplicated to your drafts and exported like any other file, but check
each file's licence before committing it to this repository. `fixtures/*/design.fig` is
gitignored by default for that reason; commit a fixture's `.fig` deliberately, and only when you
are sure you may.
