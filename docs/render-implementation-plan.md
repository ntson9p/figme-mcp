# PLAN: `fig_render` — rendered images of any node in a `.fig`, plus a visual test pipeline

> **Audience**: the AI agent implementing this feature, including small models. Execute the
> milestones **in order** (R0 → R8); each has acceptance criteria — run them before moving on.
> **Prerequisite**: the server from [`mcp-implementation-plan.md`](mcp-implementation-plan.md) is
> built and green (`npm test` → 102 passing). This plan adds to it; it never rewrites it.
> Every fact in §1 was **measured** on `figma-input/sample.fig` (exported 2026-08-31, stream
> version 106). Do not re-research them. Where a Figma behaviour could not be measured on that
> file, the plan says so explicitly and names the fixture (Appendix B) that settles it.

---

## 0. Ground rules

1. **Layer 1 stays untouched.** Do not edit anything in `src/fig/`. The new code lives in
   `src/render/`, `src/mcp/tools/render.ts`, `scripts/`, and `test/`.
2. **Runtime dependencies stay `@modelcontextprotocol/sdk` and `zod`.** The rasterizer
   `@resvg/resvg-wasm` is an **optional** dependency, loaded with a dynamic `import()` inside
   `try/catch`. The server, all existing tools and the SVG output must work when it is absent.
   Development-only packages: `pixelmatch`, `pngjs`. The rasterizer is **already installed and
   pinned** to `2.6.2`; its measured behaviour is **Appendix E**, which is normative.
3. **No network at runtime. Nothing is ever written into a `.fig`.** The only file writes are
   `savePath` (the tool), the CLI output file, and `reports/` (the tester).
4. **Keep everything green.** The 102 existing tests, `npm run smoke`, `npm run crosscheck`, and
   `node tools/fig2json.mjs` must keep working after every milestone.
5. **TypeScript constraints** (from `tsconfig.json`): `strict`, `noUncheckedIndexedAccess`,
   `verbatimModuleSyntax`, `erasableSyntaxOnly` (no `enum`, no `namespace`, no constructor
   parameter properties), ESM with `.js` extensions on relative imports, `node:` prefix on
   built-ins. Tests import compiled code from `dist/` exactly like the existing tests do.
6. **Rendering degrades, it does not crash.** A node the exporter cannot draw is skipped and
   recorded in the report (§4.12). Only bad arguments (unknown guid, oversize subtree) produce a
   tool error. Never let one corrupt blob abort a whole render.
7. **Token rules still apply** (plan §5 of the original): text blocks ≤ 20 000 characters,
   inline PNG ≤ 2 MB, otherwise `savePath`.
8. **Absent fields have defaults.** The Kiwi decoder omits unset fields. Apply exactly these
   defaults everywhere: `visible → true`, `opacity → 1`, `blendMode → PASS_THROUGH`,
   `maskType → ALPHA`, `windingRule → NONZERO`, `imageScaleMode → STRETCH`,
   `frameMaskDisabled → false`, `resizeToFit → false`, `paint.opacity → 1`,
   `paint.visible → true`, `effect.visible → true`, `spread → 0`, `showShadowBehindNode → false`.
9. **Windows.** Use `path.resolve` for every user path; `:` is illegal in file names, so a guid
   `2:1339` becomes `2_39` in fixture and output names; scripts import compiled modules through
   `pathToFileURL(...).href`.

### 0.1 How to check your own work visually

The Read tool displays PNG files. After each milestone, render the reference nodes of
Appendix A and **look at them**:

```
npm run build
node scripts/render.mjs figma-input/sample.fig 2:1339 "<scratchpad>/2_39.png" --scale 2
```

then Read `<scratchpad>/2_39.png`. Appendix A says in words what each reference node must look
like. If the optional rasterizer is not installed the CLI writes SVG instead, which you cannot
view; `@resvg/resvg-wasm@2.6.2` is already in this repo, so a plain `npm install` is enough.

### 0.2 Vocabulary

| Term | Meaning here |
|---|---|
| exporter | `src/render/export.ts`: turns a node subtree into an SVG string. The hard part. |
| rasterizer | resvg (via `@resvg/resvg-wasm`): turns SVG into pixels. A commodity. |
| report | the JSON describing what was drawn, approximated, skipped (§4.12) |
| oracle | a reference image from Figma itself (PNG export = truth, SVG export = geometry check) |
| fixture | `fixtures/<design>/` = one `.fig` + Figma exports of some of its frames |
| level 1–4 | the four tester checks, from "SVG is sane" to "matches Figma's PNG" (§9) |
| ceiling | how well Figma's own SVG export matches Figma's PNG through resvg — the best score the SVG route can reach |
| ratchet | stored best score per frame; tests fail only on regression |

---

## 1. Verified facts (measured on `figma-input/sample.fig`)

Use these as given. Each is the basis of a specific piece of code below.

**F1 — Transforms.** `NodeChange.transform` is a `Matrix { m00 m01 m02 m10 m11 m12 }` mapping
node-local coordinates to the **parent's** local coordinates:
`X = m00·x + m01·y + m02`, `Y = m10·x + m11·y + m12`. Node-local space has the node's top-left
at (0,0) and `size {x,y}` as width/height. Existing code: `absoluteOrigin()` in
`src/model/summarize.ts` composes exactly this.

**F2 — Paint order.** `TreeNode.children` (from `buildTree`) is sorted by the `position`
string; index 0 is the **bottom-most** layer and is drawn first. DFS order = paint order.

**F3 — Derived geometry.** `fillGeometry: Path[]` and `strokeGeometry: Path[]` with
`Path { windingRule: NONZERO|ODD, commandsBlob: uint, styleID: uint }`. `commandsBlob` indexes
`fig.blobs`. Coordinates are **node-local pixels** (an 18×14 rectangle decodes to a path inside
0..18 × 0..14). Strokes are already outlined into fill regions (weight, caps and joins are baked
in) — but **alignment is NOT**, see F16. `BOOLEAN_OPERATION` nodes carry the **combined** result; their children
are operands and **must not be drawn**. In the sample every visible stroke has `strokeGeometry`,
every boolean with a fill has `fillGeometry`, and the only vectors lacking geometry are boolean
operands (11 007) or paint-less (3). 307 `fillGeometry` entries have `styleID ≠ 0`.

**F4 — Command blob encoding.** A sequence of commands, each one opcode byte followed by
little-endian `float32` coordinates: `0` = close (0 floats), `1` = moveTo (x y), `2` = lineTo
(x y), `3` = quadTo (cx cy x y), `4` = cubicTo (c1x c1y c2x c2y x y). Verified on all 7 292
non-empty fill, stroke and glyph blobs; the single empty blob (0 bytes) belongs to zero-height
lines and means "no fill area". Golden: blob #390 (node `2:1558`, 146 bytes) decodes to
`M0,2 C0,0.9,0.9,0,2,0 L16,0 C17.1,0,18,0.9,18,2 L18,12 C18,13.1,17.1,14,16,14 L2,14 C0.9,14,0,13.1,0,12 L0,2 Z`
(values rounded to 1 decimal; first 64 bytes:
`0100000000ffffff3f0400000000ed3a653ff03a653f0000000000000040000000000200008041000000000429d688410000000000009041f13a653f00009041`).

**F5 — Text.** `derivedTextData` exists on 16 854 of 16 894 TEXT nodes (39 have no
`derivedTextData` at all and 1 has zero glyphs; all are text-style definition nodes named after
their font, e.g. "Meiryo/Regular/16"). Fields:
`layoutSize {x,y}`, `baselines[]`, `glyphs[]`, `decorations[] { rects: Rect[], styleID }`.
`Glyph { commandsBlob, position {x,y}, styleID, fontSize, firstCharacter, advance,
emojiCodePoints[], emojiImageSet, rotation }`. The outline blob uses the **same encoding as F4
in em units, y-up**, and **begins with a redundant `close`**: 4 287 of the 4 288 glyph blobs
start with opcode 0, while none of the 4 617 fill/stroke blobs do. SVG requires path data to
begin with a moveto, so `toPathData` drops any command before the first `M` — emitted verbatim
that leading `Z` invalidates the path and resvg discards it in silence, so **every piece of text
renders blank with no error anywhere**. (verified: the flat base bar of the digit "2" lies at y = 0 spanning the
full glyph width; its top arc is at y = 0.75). `position` is the pen position on the baseline in
**node-local pixels**, kerning already applied (use it directly; ignore `advance`). Pixel
transform of a glyph point (gx, gy): `X = position.x + gx·fontSize`, `Y = position.y − gy·fontSize`.
`styleID` selects an entry of `textData.styleOverrideTable[]` (partial NodeChange records
carrying `styleID` and the fields that differ, e.g. `fillPaints`); `styleID 0` and missing
entries mean the node's own `fillPaints`. Decoration rects are node-local pixels. Emoji glyphs
have `emojiCodePoints` and no usable outline (27 in the sample).

**F6 — Paints.** `Paint { type, color {r,g,b,a} 0..1, opacity, visible, blendMode, stops:
ColorStop[] { color, position }, transform: Matrix, image: Image { hash: byte[20], name,
dataBlob }, imageScaleMode, rotation, scale, paintFilter, filterColorAdjust, … }`.
`fillPaints[0]` is the bottom-most paint. Image bytes: ZIP entry `images/<40-hex of hash>`;
if absent and `image.dataBlob` is set, `fig.blobs[dataBlob].bytes`. Sample: 247 PNG, 5 JPEG,
1 unidentified. Scale modes: `FILL` = cover the box, centred, cropped; `FIT` = contain,
centred; `STRETCH` = fill the box non-uniformly (all 396 in the sample have the identity
`transform`; a non-identity transform is Figma's "crop" — see §4.7.3); `TILE` = repeat at
`scale × intrinsic size` from the node's top-left.

**F7 — Gradient transform convention.** `paint.transform` maps the node's **normalized box**
(u = x/width, v = y/height, both 0..1) **to gradient space**, where a linear gradient runs from
(0, 0.5) to (1, 0.5) and a radial gradient is centred at (0.5, 0.5) with radius 0.5. Verified:
Figma's default top-to-bottom gradient is stored as `m00≈0 m01=1 m02=0 m10=−1 m11≈0 m12=1`,
whose inverse maps (0, 0.5) → (0.5, 0) (top centre) and (1, 0.5) → (0.5, 1) (bottom centre).

**F8 — Effects.** `Effect { type, offset {x,y}, radius, visible, blendMode, spread,
showShadowBehindNode, color {r,g,b,a} }`. Figma's blur `radius` corresponds to a Gaussian
`stdDeviation = radius / 2` (this is what Figma's own SVG export emits). Types in the sample:
DROP_SHADOW 827, BACKGROUND_BLUR 99, INNER_SHADOW 16, FOREGROUND_BLUR 5, GLASS 4.

**F9 — Enum values.** `WindingRule { NONZERO=0, ODD=1 }` (ODD = SVG `evenodd`).
`MaskType { ALPHA=0, OUTLINE=1, LUMINANCE=2 }`. `BlendMode { PASS_THROUGH=0, NORMAL=1, DARKEN,
MULTIPLY, LINEAR_BURN, COLOR_BURN, LIGHTEN, SCREEN, LINEAR_DODGE, COLOR_DODGE, OVERLAY,
SOFT_LIGHT, HARD_LIGHT, DIFFERENCE, EXCLUSION, HUE, SATURATION, COLOR, LUMINOSITY }`.
`ImageScaleMode { STRETCH=0, FIT, FILL, TILE }`. `EffectType { INNER_SHADOW, DROP_SHADOW,
FOREGROUND_BLUR, BACKGROUND_BLUR, REPEAT, SYMMETRY, GRAIN, NOISE, GLASS, CUSTOM }`.
`PaintType { SOLID, GRADIENT_LINEAR, GRADIENT_RADIAL, GRADIENT_ANGULAR, GRADIENT_DIAMOND,
IMAGE, EMOJI, VIDEO, PATTERN, NOISE, CUSTOM }`. `NodeType` has 65 values; the sample uses 19.

**F10 — Clipping.** A container clips its children iff `type ∈ {FRAME, SYMBOL, INSTANCE}`
**and** `frameMaskDisabled !== true` **and** `resizeToFit !== true`. Groups are stored as
`FRAME` with `resizeToFit: true` (2 567 in the sample, all with `frameMaskDisabled: false`, so
the `resizeToFit` test is mandatory). `SECTION` never clips (all 89 have
`frameMaskDisabled: true`). The clip shape is the container's `fillGeometry` (it includes corner
radius), falling back to the rectangle `0 0 width height`.

**F11 — Masks.** A child with `mask: true` masks the siblings **above** it (later indices)
within the same parent, up to the next sibling that is itself a mask or the end of the list.
The mask layer itself is not painted. `maskType` selects how its coverage is computed (§4.10).
379 masks in the sample: 339 OUTLINE, 36 ALPHA (default), 4 LUMINANCE. Whether a second mask
ends the first one's run could not be measured — fixture `cf-mask-two-in-one-parent` decides.

**F12 — Draw order inside a node.** Own fills → children (clipped if F10) → own strokes.
Frame strokes are drawn **above** the children (an inside border stays visible over a
full-bleed child). Effects apply to the whole result; layer `opacity` applies after effects.

**F13 — Page background.** `CANVAS.backgroundColor {r,g,b,a}` with `backgroundEnabled`;
`meta.client_meta.background_color` mirrors it. Sample page "Page 7": rgb(30,30,30).

**F14 — Sizes.** The document has 116 142 nodes; page `0:2` "Page 1" holds
hidden copies of library components used by instances — its nodes render like any others. The
whole render region of the file is 25 134 × 13 792 px, so whole-page renders must downscale.

**F16 — Stroke alignment is not baked in** (measured during R1; corrects F3). `strokeGeometry`
for `strokeAlign: INSIDE` or `OUTSIDE` is a band of **double** the stroke weight straddling the
shape edge; Figma clips it at render time. Measured overshoot beyond the node box, over the
whole sample: exactly **1.00 × weight** for INSIDE (8 930 nodes) and OUTSIDE (125), and
**0.50 × weight** for CENTER (2 737) — CENTER geometry is therefore already final.
`StrokeAlign { CENTER=0, INSIDE=1, OUTSIDE=2, OFFSET=3 }`, so an absent field means CENTER, the
alignment that needs no clip. Every INSIDE/OUTSIDE node with a visible stroke in the sample has
`fillGeometry` to clip against; the 1 256 stroked nodes without it are all CENTER `LINE`s.
Consequences, both implemented in §4.4: the exporter must clip INSIDE strokes to the fill shape
and OUTSIDE strokes to its complement, and `contentBounds` must not count the raw INSIDE band —
otherwise the 134×40 frame `2:1339` exports as 134×41 and every bordered frame gains a
half-stroke of bleed.

**F17 — Instances are empty; the symbol is the content** (measured during R1; the plan's §4.4
did not cover this and an exporter without it renders almost nothing). **All 38 164 INSTANCE
nodes in the sample have zero children**, and all 38 164 resolve to a SYMBOL that is present in
the file. On a real page — `0:1` — INSTANCE is the most common type by far: 7 104 of 14 912
nodes. Two record sets on the instance supply the rest, both addressed by `guidPath.guids`,
a path of **override identities** — a node's `overrideKey` when it has one, else its guid
(corrected 2026-09-18: the first version of this fact said "overrideKeys, not guids", and the
exporter built on it dropped 30 061 records; see pitfall 21):

* `symbolData.symbolOverrides` — what the user changed. 76 947 records; the commonest fields are
  `size` (34 505), `fillPaints` (26 472), auto-layout fields, `textData`, `fontSize`, `visible`.
* `derivedSymbolData` — what Figma recomputed as a result: 226 886 records carrying resolved
  `size` (154 856), `fillGeometry` (118 219), `strokeGeometry` (41 591), `derivedTextData`
  (32 079) and `transform` (50 295). Present on 37 878 of the instances.

`guidPath` counts **instance-nesting levels, not node depth**: a one-segment path (69 748 of
76 947) addresses a node anywhere inside this instance's own symbol, and `[a, b]` addresses the
node with identity `b` inside the nested instance with identity `a`. 1 232 of 2 046
symbols contain nested instances, so the nesting case is normal, not exotic. The symbol's own
root has an identity too, and the record at that path is the instance's own appearance.

Consequences, implemented in §4.4: an INSTANCE draws the symbol's children with
`mergeNode(symbolNode, record)` applied per descendant (derived wins over user overrides, and an
enclosing instance wins over a nested one); a recursion guard is needed; and — critically —
**`contentBounds` of an INSTANCE must NOT descend into the symbol**, because the symbol's own
children are the symbol's size, not the instance's. Instance `2:1340` is 16×16 and points at a
22×22 symbol; descending renders it at 22×22 with the icon in the corner.

**F18 — Component properties are evaluated, never materialised** (measured 2026-09-18 on frame
`863:171055` "SCREEN-A" against Figma's own export of it; F18–F21 all come from that comparison).
An instance carries `componentPropAssignments[] { defID, value: { textValue | boolValue |
guidValue } }`; a symbol descendant bound to a property carries `componentPropRefs[] { defID,
componentPropNodeField: VISIBLE | TEXT_DATA | OVERRIDDEN_SYMBOL_ID }` (the newer
`parameterConsumptionMap` says the same thing on the same 2 178 nodes). 14 373 of 38 164
instances assign something: 35 578 BOOLEAN, 14 051 TEXT, 2 029 INSTANCE_SWAP values; bound nodes
are VISIBLE 1 461, TEXT_DATA 573, OVERRIDDEN_SYMBOL_ID 414. **Not one of the 29 877 BOOLEAN=false
assignments is mirrored by a `visible:false` record**, so an icon a property switches off is only
off if the assignment is evaluated. Without an assignment the symbol's own state already is the
default (108 of the 108 bindings whose default is recorded agree). A record may reassign a
nested instance's properties (`componentPropAssignments` inside a record, 2 591 of them) and
1 251 of those lists are partial, so assignments merge per `defID`. A text assignment comes
with a derived record carrying the new glyphs (11 907 of 12 584 direct bindings; the rest are
nested and served by the enclosing instance's records); without one the node is reported as
`text-property-without-outlines` rather than drawn with the symbol's glyphs. A swap names the
symbol by `guidValue` (2 027 of 2 029 are local) or, in a record, by `overriddenSymbolID`
(1 677). No PROP_REF chains occur in the sample. Implemented in `src/model/instance.ts`,
shared by the exporter and `fig_instance`.

**F19 — A referenced style is the live source of its paints.** `styleIdForFill`,
`styleIdForStrokeFill` and `styleIdForEffect` appear on nodes, on override records and on
`styleOverrideTable` entries, and the `fillPaints`/`strokePaints`/`effects` cached beside them
are only what the node looked like when it was last touched: 1 779 nodes and 1 064 records
disagree with their style, and 3 905 records plus 265 text-run entries carry the reference with
no paints at all. Figma draws the style — pixel-measured: the SCREEN-A card icon is #333333 in the
export, the "Black" style, while the override's cached paint says #F18D00 — and the time slots'
orange border exists only as a stroke-style reference. Styles not in the file (4 487 records)
and the detached-style sentinel `4294967295:4294967295` cannot be followed and keep the cache.
An instance whose root fill was detached carries its own paints and no reference (133 of them,
all a different colour from the style), so paints and reference travel as one unit.

**F20 — The enclosing instance sizes nested instances, and only painted nodes get new
geometry.** 25 266 of the 40 855 nested instances with a derived `size` are resized by the
instance that contains them, 23 547 of those with no derived `fillGeometry` for the box. Figma
re-derives geometry only for nodes that paint something: of 22 097 resized painted nodes, 18
lack it. Two consequences: a record that resizes a node without geometry leaves the OLD outline
behind, which is dropped so the box is rebuilt from `size` and the corner radii; and bounds,
mask regions and clips must be measured on the effective node, memoised per (instance scope,
node). SCREEN-A's panel `863:171102` is a 1052×503 instance of a 1240×180 symbol; measured on the
raw tree its `<mask>` came out 1240×180 and the panel stopped at row 180.

**F21 — Text truncation and run styles.** `derivedTextData.truncationStartIndex` indexes the
GLYPH array, not the characters: the glyphs from that index on are the cut tail, and the glyph
just before it — the one without `firstCharacter` — is the ellipsis Figma inserted (920 of 920
truncated texts). A glyph's `styleID` is never set for a styled run (12 576 of 12 576 styled
glyphs); the run is `textData.characterStyleIDs[firstCharacter]`, one entry per character with
an implicit 0 past the end of the array (413 texts have a full array, 101 a shorter one, none a
longer one).

**F15 — Existing APIs to reuse** (do not duplicate): `FileCache.get(file): CacheEntry
{ fig, index }`, `FileIndex.node(guid)`, `FileIndex.subtreeRange(root)`, `TreeNode
{ key, node, children, parent }`, accessors `str/num/bool/obj/arr/objArr/bytes/hex` in
`src/model/access.ts`, `sniffImage()` in `src/fig/imagemeta.ts`, `ZipArchive.read(name)`,
`handler()/load()/requireNode()` in `src/mcp/tools/context.ts` (`handler` accepts async
functions), `jsonResult/textResult/errorResult` in `src/mcp/respond.ts`, and the in-memory test
harness `connect()` in `test/fixtures/mcp.ts`.

---

## 2. Architecture

```
src/render/                      Layer 2½ — rendering. Reads model/ and fig/, never writes.
  matrix.ts        2×3 affine helpers in SVG order (a b c d e f), Figma→SVG conversion, inverse
  path.ts          command blob → PathCommand[] → SVG path data, bounds
  svg.ts           SvgWriter: escaping, number formatting, <defs> registry with de-duplication
  color.ts         Color → "#rrggbb" + alpha, page background
  bounds.ts        contentBounds / renderBounds / effectMargins (memoised per node)
  paint.ts         SOLID / GRADIENT_* / IMAGE paints → fill attributes + defs
  text.ts          glyph outlines + decorations → paths
  effects.ts       Effect[] → <filter> definition
  report.ts        RenderReport accumulator + feature vocabulary (Appendix D)
  export.ts        the exporter: traversal, clipping, masks, opacity, blend, node groups
  raster.ts        optional resvg-wasm wrapper (dynamic import, one-time init)
  index.ts         renderNode(entry, guid, options) → { svg, png?, width, height, report }
src/mcp/tools/render.ts          fig_render tool
scripts/render.mjs               CLI: file + guid → PNG/SVG on disk + report on stdout
scripts/visual.mjs               tester CLI: runs levels 1–4 over fixtures/, writes reports/visual/
test/unit/{matrix,path,svg,paint,effects,bounds}.test.ts
test/golden/render.test.ts       asset-based checks (skips without the asset)
test/visual/visual.test.ts       fixture-based checks (skips without fixtures/)
test/visual/lib/{fixtures,png,compare,attribute,coverage,ratchet,gallery,cli}.ts
fixtures/<design>/               user-provided: design.fig + exports/ + manifest.json + expect.json
docs/render-fixtures.md          Appendix B of this plan, copied verbatim for the person making fixtures
```

Dependency direction: `render/` → `model/`, `fig/`. `mcp/tools/render.ts` → `render/index.ts`.
`test/visual/lib` → `dist/render/*`, `dist/cache.js`, `pixelmatch`, `pngjs`. Nothing in `src/`
imports the dev packages.

---

## 3. Dependencies and configuration changes

`package.json`:

```json
"optionalDependencies": { "@resvg/resvg-wasm": "2.6.2" },
"devDependencies": { "...existing...": "", "pixelmatch": "^7.2.0", "pngjs": "^7.0.0", "@types/pngjs": "^6.0.5" },
"scripts": {
  "render": "node scripts/render.mjs",
  "visual": "node scripts/visual.mjs",
  "visual:update": "node scripts/visual.mjs --update"
}
```

**`@resvg/resvg-wasm@2.6.2` is already installed** (approved and added on 2026-09-02) and its
behaviour has been measured — see **Appendix E**, which is normative. Do not re-research it and
do not change the version: the version is pinned **exactly** (no `^`) because a minor bump can
change anti-aliasing, which would shift every stored ratchet score in §9.7 for reasons that have
nothing to do with your code. The package publishes `index.mjs` (ESM), `index.js` (CJS),
`index.d.ts` and `index_bg.wasm` (2.42 MB); its `exports` map exposes `.` and `./index_bg.wasm`;
it has no dependencies of its own and contains no native binary.
`pixelmatch` 7 is ESM (`import pixelmatch from 'pixelmatch'`) and returns the number of
mismatched pixels. `pngjs` 7: `import { PNG } from 'pngjs'`; `PNG.sync.read(buf)` →
`{ width, height, data }` (RGBA), `PNG.sync.write(png)` → Buffer.

`.gitignore`: add `reports/`. Fixtures are the user's choice; recommend committing small
conformance fixtures and ignoring large real designs by path.

`README.md`: replace the "No rendering and no screenshots" non-goal with a "Rendering is
best-effort" section (§6.5) and document `fig_render` like the other tools.

---

## 4. The exporter — detailed specification

### 4.1 Coordinates (`matrix.ts`)

Use SVG's parameter order everywhere: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.

```ts
import type { KiwiObject } from '../fig/kiwi.js';
import { num } from '../model/access.js';

export interface Mat { readonly a: number; readonly b: number; readonly c: number; readonly d: number; readonly e: number; readonly f: number }
export interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Figma Matrix → SVG matrix. m00→a, m10→b, m01→c, m11→d, m02→e, m12→f. */
export function fromFigma(m: KiwiObject | undefined): Mat {
  if (!m) return IDENTITY;
  return { a: num(m, 'm00') ?? 1, b: num(m, 'm10') ?? 0, c: num(m, 'm01') ?? 0, d: num(m, 'm11') ?? 1, e: num(m, 'm02') ?? 0, f: num(m, 'm12') ?? 0 };
}
/** multiply(p, q): apply q first, then p. */
export function multiply(p: Mat, q: Mat): Mat {
  return { a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b, c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d, e: p.a * q.e + p.c * q.f + p.e, f: p.b * q.e + p.d * q.f + p.f };
}
export function invert(m: Mat): Mat | undefined {
  const det = m.a * m.d - m.c * m.b;
  if (Math.abs(det) < 1e-12) return undefined;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det };
}
export function apply(m: Mat, x: number, y: number): [number, number] { return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]; }
export function scale(sx: number, sy: number): Mat { return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }; }
export function translate(tx: number, ty: number): Mat { return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }; }
export function isIdentity(m: Mat): boolean { return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0; }
/** Bounding box of the 4 transformed corners. */
export function transformBox(m: Mat, b: Box): Box { /* apply to the 4 corners, take min/max */ }
export function unionBox(a: Box | undefined, b: Box | undefined): Box | undefined { /* … */ }
export function expandBox(b: Box, l: number, t: number, r: number, bt: number): Box { /* … */ }
```

Unit tests (`test/unit/matrix.test.ts`): `multiply` against a hand-computed product,
`invert` round-trips (`multiply(m, invert(m)) ≈ IDENTITY`), `fromFigma` field mapping,
`transformBox` on a 90° rotation, and the F7 gradient check: with
`T = fromFigma({m00:0,m01:1,m02:0,m10:-1,m11:0,m12:1})` and `G = multiply(scale(100,100), invert(T))`,
`apply(G, 0, 0.5)` must be `[50, 0]` and `apply(G, 1, 0.5)` must be `[50, 100]`.

### 4.2 Path decoding (`path.ts`)

```ts
export interface PathCommand { readonly op: 'Z' | 'M' | 'L' | 'Q' | 'C'; readonly args: readonly number[] }
const ARG_COUNT: Record<number, number> = { 0: 0, 1: 2, 2: 2, 3: 4, 4: 6 };
const OPS = ['Z', 'M', 'L', 'Q', 'C'] as const;

export function decodeCommands(bytes: Uint8Array): PathCommand[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); // bytes may be a view
  const out: PathCommand[] = [];
  let i = 0;
  while (i < bytes.length) {
    const op = bytes[i]!;
    const n = ARG_COUNT[op];
    if (n === undefined) throw new Error(`unknown path opcode ${op} at byte ${i}`);
    if (i + 1 + 4 * n > bytes.length) throw new Error(`truncated path command at byte ${i}`);
    const args: number[] = [];
    for (let k = 0; k < n; k++) args.push(dv.getFloat32(i + 1 + 4 * k, true));
    out.push({ op: OPS[op]!, args });
    i += 1 + 4 * n;
  }
  return out;
}
/** SVG `d` string. `m` (optional) is applied to every coordinate pair before formatting. */
export function toPathData(cmds: readonly PathCommand[], m?: Mat): string { /* 'M x y', 'L x y', 'Q c x y', 'C c1 c2 x y', 'Z' joined by spaces, numbers through fmt() */ }
/** Conservative bounds: includes control points. undefined for an empty path. */
export function pathBounds(cmds: readonly PathCommand[], m?: Mat): Box | undefined { /* … */ }
```

Rules: an empty byte array is a valid empty path (emit no element). A decode error inside the
exporter is caught per node and reported as `geometry:corrupt` (§4.12); it never propagates.

Unit tests (`test/unit/path.test.ts`): encode the golden commands of F4 with a small test
writer (opcode byte + `DataView.setFloat32(…, true)`), decode, and compare; empty input → `[]`;
unknown opcode throws with the byte offset; truncated command throws; `toPathData` with a
transform `{a:2,b:0,c:0,d:-2,e:10,f:20}` maps `(1,1)` to `(12,18)`.

### 4.3 SVG writer (`svg.ts`)

```ts
export type Attrs = Record<string, string | number | undefined>;
export function esc(s: string): string;          // & < > " '
export function fmt(n: number): string;          // 3 decimals, trailing zeros stripped, "-0" → "0", throws on NaN/Infinity
export class SvgWriter {
  open(tag: string, attrs?: Attrs): void;        // undefined attrs are omitted; numbers go through fmt()
  close(tag: string): void;                      // throws if it does not match the open tag (guarantees well-formedness)
  element(tag: string, attrs?: Attrs, inner?: string): void;
  /** Registers a <defs> entry once per key; returns its id. build receives the id to use. */
  def(key: string, build: (id: string) => string): string;
  finish(view: Box, opts: { background?: string; width: number; height: number }): string;
}
```

`finish` produces:

```xml
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="{width}" height="{height}" viewBox="{view.x} {view.y} {view.w} {view.h}">
  <defs>…registered defs, in registration order…</defs>
  [<rect x y width height fill="{background}"/>]
  …body…
</svg>
```

Use `xlink:href` for images and `<use>` (SVG 1.1 form; supported by resvg, Chromium, Inkscape).
Ids are `p1`, `p2`, … from a counter; never derive ids from layer names.

### 4.4 Traversal (`export.ts`)

Classification of `node.type`:

| Class | Types | Drawn as |
|---|---|---|
| container | FRAME, SYMBOL, INSTANCE, SECTION, GROUP, CANVAS (root only) | fills, clipped children, strokes |
| shape | RECTANGLE, ROUNDED_RECTANGLE, ELLIPSE, LINE, VECTOR, STAR, REGULAR_POLYGON, BOOLEAN_OPERATION | fills, strokes; **BOOLEAN_OPERATION: children never drawn** |
| text | TEXT | glyph paths + decoration rects (§4.8) |
| skip | everything else (WIDGET, SHAPE_WITH_TEXT, CONNECTOR, STICKY, TABLE, SLIDE, VARIABLE, BRUSH, …) | nothing; report `node-type:<TYPE>` |

`DOCUMENT` as root is refused with an error ("render a page or a node"). A `CANVAS` root is
allowed (whole page).

The exporter is a class holding: the `CacheEntry`, the `SvgWriter`, the `RenderReport`, the
bounds memo, an image data-URI cache, the render mode (`'normal' | 'outline-white'`, §4.10),
the active instance frame — the enclosing instance's records and property assignments, through
which every node is seen (`effective(t)`, F17–F19) — and a visited counter checked against
`maxNodes`.

Skeleton (pseudocode; every branch is normative):

```
emitNode(t):
  n = t.node
  if bool(n,'visible') === false: return
  opacity = num(n,'opacity') ?? 1;  if opacity <= 0: return
  cls = classify(n.type);  if cls == skip: report.unsupported('node-type:'+type, t.key); return
  report.nodesDrawn++
  filterId = effectsFilter(t)                      // §4.9; undefined when no drawable effect
  out.open('g', { transform: matrixAttr(t),        // omitted for the ROOT node (rendered in its own local space)
                  opacity: opacity < 1 ? opacity : undefined,
                  style: blendStyle(n, cls == container),   // §4.11
                  filter: filterId ? `url(#${filterId})` : undefined })
  if cls == text: emitText(t) else emitPaths(t, 'fillGeometry', objArr(n,'fillPaints'))
  if cls == container:
     clipId = clipPathFor(t)                        // §4.6; undefined when F10 says "no clip"
     if clipId: out.open('g', { 'clip-path': `url(#${clipId})` })
     emitChildren(t)
     if clipId: out.close('g')
  if cls != text: emitPaths(t, 'strokeGeometry', objArr(n,'strokePaints'))
  out.close('g')

emitChildren(t):                                     // mask runs, F11
  kids = t.children; i = 0
  while i < kids.length:
     k = kids[i]
     if isMask(k):                                   // bool(k.node,'mask') === true
        if bool(k.node,'visible') === false: report.approximated('mask-hidden', k.key); i++; continue
        j = index of next mask in kids after i, or kids.length
        maskId = defineMask(k, kids.slice(i+1, j))   // §4.10
        out.open('g', { mask: `url(#${maskId})` })
        for m in i+1 .. j-1: emitNode(kids[m])
        out.close('g')
        i = j
     else: emitNode(k); i++

emitPaths(t, field, paints):                         // one <path> per (geometry, visible paint)
  for path in objArr(n, field):
     cmds = decode(path)                              // catch → report 'geometry:corrupt', continue
     if cmds is empty: continue
     d = toPathData(cmds); rule = str(path,'windingRule') == 'ODD' ? 'evenodd' : 'nonzero'
     ps = path.styleID ? runPaints(t, path.styleID, field) ?? paints : paints   // §4.7.5
     for paint in ps (index 0 first):
        attrs = paintAttrs(paint, box(t), t)          // §4.7; undefined → invisible or unsupported (already reported)
        if attrs: out.element('path', { d, 'fill-rule': rule, ...attrs })
```

`matrixAttr(t)` = `toAttr(fromFigma(obj(t.node,'transform')))`, omitted when identity. For
the render root the group has **no** transform: the root is drawn in its own local space and
the `viewBox` is `renderBounds(root)` (§4.5). For a CANVAS root the children's transforms are
already page-space, so the same rule works.

### 4.5 Bounds (`bounds.ts`)

Two memoised functions per `TreeNode`, in node-local coordinates:

* `contentBounds(t)`: union of `{0,0,size.x,size.y}` (text: `layoutSize` if present), the
  `pathBounds` of every `fillGeometry`/`strokeGeometry` path, and — **only if the node does not
  clip (F10)** — `transformBox(childMatrix, renderBounds(child))` for every visible child.
  For BOOLEAN_OPERATION children are ignored. For a CANVAS root the own box is empty and only
  visible children count.
* `renderBounds(t)` = `contentBounds(t)` expanded by `effectMargins(t)`.
* `effectMargins(t)` per side, from visible effects: for each DROP_SHADOW,
  `left = max(0, radius + spread − dx)`, `right = max(0, radius + spread + dx)`,
  `top = max(0, radius + spread − dy)`, `bottom = max(0, radius + spread + dy)`; for
  FOREGROUND_BLUR all sides `radius`; take the maximum per side over effects. Other effect
  types add nothing. This is the initial rule; fixture `cf-effect-drop-shadow` calibrates it
  against Figma's export size (one function to change, one golden value to update).

Memoise per (instance scope, node), not per `TreeNode` alone, and measure the **effective** node
(the tree node merged with the enclosing instance's records): the same symbol node has a
different size under each instance that expands it (F20). A page subtree is still computed once
per render.

### 4.6 Clipping (`export.ts`)

```
clipPathFor(t):
  n = t.node
  if !(type in FRAME|SYMBOL|INSTANCE) or bool(n,'frameMaskDisabled') === true or bool(n,'resizeToFit') === true: return undefined
  paths = fillGeometry paths that decode to non-empty commands
  key = 'clip:' + t.key
  return out.def(key, id => `<clipPath id="${id}" clipPathUnits="userSpaceOnUse">` + (paths.length ? paths.map(p => `<path d="…" clip-rule="…"/>`) : `<rect x="0" y="0" width="${w}" height="${h}"/>`) + `</clipPath>`)
```

> **Use `clip-rule`, never `fill-rule`, on a path inside `<clipPath>`.** Measured (Appendix E,
> R11): resvg **silently ignores** `fill-rule` there, so an ODD-winding clip shape loses its
> holes with no error. `clip-rule="evenodd"` and `style="clip-rule:evenodd"` both work.
> Elsewhere — ordinary paths and `<mask>` children — it is `fill-rule` as usual.

The clip group wraps **only the children** (F12): the container's own strokes are emitted
after the clip group closes.

### 4.7 Paints (`paint.ts`)

`paintAttrs(paint, box, t): Attrs | undefined` where `box` is the node-local box
`{0,0,size.x,size.y}` (the "normalized box" of F7). Returns `undefined` and reports when the
paint is invisible or unsupported. Also handles `paint.blendMode` (§4.11).

**4.7.1 SOLID.** `fill = "#rrggbb"` from `color` (`Math.round(c*255)`),
`fill-opacity = color.a × paint.opacity` (omit when 1).

**4.7.2 GRADIENT_LINEAR / GRADIENT_RADIAL.** `T = fromFigma(paint.transform)`;
`inv = invert(T)`; if `inv` is undefined → report `gradient-singular`, fall back to a SOLID
made from the first stop. `G = multiply(scale(box.w, box.h), inv)`; register a def keyed by
`'grad:' + JSON of (type, stops, G rounded to 4 decimals)`:

```xml
<linearGradient id="…" gradientUnits="userSpaceOnUse" x1="0" y1="0.5" x2="1" y2="0.5" gradientTransform="matrix(a b c d e f)">
  <stop offset="{position}" stop-color="#rrggbb" stop-opacity="{color.a × paint.opacity}"/> …
</linearGradient>
<radialGradient id="…" gradientUnits="userSpaceOnUse" cx="0.5" cy="0.5" r="0.5" gradientTransform="matrix(…)">…</radialGradient>
```

Stops sorted by `position` (clamped 0..1). Return `{ fill: 'url(#id)' }`.
GRADIENT_ANGULAR and GRADIENT_DIAMOND: report `paint:GRADIENT_ANGULAR` / `paint:GRADIENT_DIAMOND`
as **approximated** and draw a SOLID of the stop-average colour (so the shape is not invisible).

**4.7.3 IMAGE.** *(measured correction: the schema has NO `imageTransform` field — the crop
matrix is `paint.transform`, the same field gradients use, and `originalImageWidth/Height` give
the intrinsic size directly, so `sniffImage` is only needed for the mime type. All 212 distinct
image hashes in the sample are ZIP entries; none need `dataBlob`.)* Resolve bytes (F6); `sniffImage` → mime; only `image/png`, `image/jpeg`,
`image/gif` are embedded (resvg decodes these); anything else → report `image-format:<mime>`,
draw nothing. Missing bytes → `image-missing`. Build the data URI once per hash (cache).
Register a `<pattern>` def keyed by `(hash, mode, box.w, box.h, rotation, transform)`:

| Mode | Pattern content (`patternUnits="userSpaceOnUse" x="0" y="0" width="{box.w}" height="{box.h}"`) |
|---|---|
| FILL | `<image width="{box.w}" height="{box.h}" preserveAspectRatio="xMidYMid slice" xlink:href="data:…"/>` |
| FIT | same with `preserveAspectRatio="xMidYMid meet"` |
| STRETCH, identity `transform` | same with `preserveAspectRatio="none"` |
| STRETCH, other transform (Figma "crop") | `<image width="{iw}" height="{ih}" preserveAspectRatio="none" transform="matrix(M)"/>` with `M = multiply(multiply(scale(box.w, box.h), invert(fromFigma(transform))), scale(1/iw, 1/ih))` — **candidate A**. Report `image-crop` as approximated until fixture `cf-image-crop` confirms; if the crop comes out wrong, use candidate B: `M = multiply(multiply(scale(box.w, box.h), fromFigma(transform)), scale(1/iw, 1/ih))` |
| TILE | pattern `width="{iw×scale}" height="{ih×scale}"` containing `<image width="{iw×scale}" height="{ih×scale}" preserveAspectRatio="none" …/>`; `scale = num(paint,'scale') ?? 1` |

`iw, ih` come from `sniffImage`. `paint.rotation` (degrees, multiples of 90): wrap the
`<image>` in `<g transform="translate(w/2 h/2) rotate(r) translate(-w'/2 -h'/2)">` where
`(w', h')` is `(box.h, box.w)` for 90/270 and the image is sized to `(w', h')`; report
`image-rotation` as approximated. Paint opacity → `opacity` attribute on the `<image>`.
Any `paintFilter` / `filterColorAdjust` present → report `image-filters` (approximated), ignore.
Return `{ fill: 'url(#patternId)' }`.

**4.7.4 Other paint types.** VIDEO: draw its `image` (poster) if present, else nothing; report
`paint:VIDEO`. EMOJI, PATTERN, NOISE, CUSTOM: report `paint:<TYPE>` as unsupported, draw nothing.

**4.7.5 Per-region styles.** `runPaints(index, t, styleID, field)` (`style.ts`): search
`vectorData.styleOverrideTable[]` (for TEXT: `textData.styleOverrideTable[]`) for an entry
whose `styleID` equals the path's. If the entry names a local colour style
(`styleIdForFill` / `styleIdForStrokeFill`) return that style's paints (F19 — 265 of the
sample's 817 text-run entries carry only the reference); else return the entry's `fillPaints`
(for `fillGeometry`) or `strokePaints` (for `strokeGeometry`) if it has the field; otherwise
`undefined` (caller uses the node's paints). The node's own paints have already been through
`applyStyles` (F19) by the time they reach here.

### 4.8 Text (`text.ts`)

```
emitText(t):
  dtd = obj(n,'derivedTextData'); glyphs = objArr(dtd,'glyphs')
  if !dtd or glyphs.length == 0: if textData.characters is non-empty: report 'text-without-outlines'; return
  cut = num(dtd,'truncationStartIndex')         // F21: an index into `glyphs`, -1 when nothing is cut
  runs = arr(textData,'characterStyleIDs') ?? []  // F21: one entry per character, 0 past the end
  groups = Map<styleID, string[]>              // path data per style, node-local px (transform baked in, F5)
  for (i, g) in glyphs:
     if cut >= 0 and i >= cut: break            // the tail; glyphs[cut-1] is the ellipsis, and IS drawn
     if arr(g,'emojiCodePoints')?.length: report.approximated('emoji', t.key); continue
     if (num(g,'rotation') ?? 0) != 0: report.approximated('glyph-rotation', t.key)   // still drawn, unrotated
     fs = num(g,'fontSize'); p = obj(g,'position'); m = { a: fs, b: 0, c: 0, d: -fs, e: p.x, f: p.y }
     cmds = decode(blob(g.commandsBlob)); if empty: continue
     styleID = runs[g.firstCharacter] ?? g.styleID ?? 0   // never g.styleID first: it is unset on styled runs
     groups.get(styleID).push(toPathData(cmds, m))
  for (styleID, ds) in groups:
     paints = runPaints(index, t, styleID, 'fillPaints') ?? objArr(n,'fillPaints')
     for paint in paints: attrs = paintAttrs(paint, box(t), t); if attrs: out.element('path', { d: ds.join(' '), 'fill-rule': 'nonzero', ...attrs })
  for dec in objArr(dtd,'decorations'):
     paints = as above for dec.styleID
     for r in objArr(dec,'rects'): for paint in paints: attrs…; out.element('rect', { x, y, width: r.w, height: r.h, ...attrs })
```

Text strokes (`strokePaints` on TEXT, 0 in the sample) → report `text-stroke`, ignore.
Because glyph coordinates are baked into node-local pixels, gradient and image fills on text
work through the same `paintAttrs` with the text box.

### 4.9 Effects (`effects.ts`)

`effectsFilter(t): string | undefined` registers one `<filter>` per node that has at least one
visible DROP_SHADOW, INNER_SHADOW or FOREGROUND_BLUR and returns its id; other effect types
only produce report entries: BACKGROUND_BLUR → approximated `effect:BACKGROUND_BLUR` (the fill
is drawn flat); GLASS, REPEAT, SYMMETRY, GRAIN, NOISE, CUSTOM → unsupported `effect:<TYPE>`.

Filter element (region = `renderBounds(t)` of §4.5, in node-local units):

```xml
<filter id="…" filterUnits="userSpaceOnUse" x="{rb.x}" y="{rb.y}" width="{rb.w}" height="{rb.h}" color-interpolation-filters="sRGB">
  …primitives…
</filter>
```

Primitive chain, built in this exact order (`σ = radius / 2`; skip `feGaussianBlur` when
`σ = 0`; `R G B` are 0..1 floats, `A = color.a`):

```
<feFlood flood-opacity="0" result="bg"/>                                   prev = "bg"
for each visible DROP_SHADOW k (array order, first drawn lowest):
  <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 127 0" result="ha{k}"/>   cur = ha{k}
  spread > 0: <feMorphology in="{cur}" operator="dilate" radius="{spread}" result="sp{k}"/>   cur = sp{k}
  spread < 0: <feMorphology in="{cur}" operator="erode"  radius="{-spread}" result="sp{k}"/>  cur = sp{k}
  <feOffset in="{cur}" dx="{offset.x}" dy="{offset.y}" result="of{k}"/>                      cur = of{k}
  <feGaussianBlur in="{cur}" stdDeviation="{σ}" result="bl{k}"/>                             cur = bl{k}
  showShadowBehindNode false: <feComposite in="{cur}" in2="ha{k}" operator="out" result="ko{k}"/>   cur = ko{k}
  <feColorMatrix in="{cur}" type="matrix" values="0 0 0 0 {R}  0 0 0 0 {G}  0 0 0 0 {B}  0 0 0 {A} 0" result="co{k}"/>
  <feBlend in="co{k}" in2="{prev}" mode="normal" result="ds{k}"/>                           prev = ds{k}
<feBlend in="SourceGraphic" in2="{prev}" mode="normal" result="shape"/>                     prev = "shape"
for each visible INNER_SHADOW k:
  <feColorMatrix in="SourceAlpha" type="matrix" values="… 127 0" result="ia{k}"/>            cur = ia{k}
  spread > 0: <feMorphology in="{cur}" operator="erode" radius="{spread}" result="isp{k}"/>  cur = isp{k}
  <feOffset in="{cur}" dx="{offset.x}" dy="{offset.y}" result="io{k}"/>                      cur = io{k}
  <feGaussianBlur in="{cur}" stdDeviation="{σ}" result="ib{k}"/>                             cur = ib{k}
  <feComposite in="{cur}" in2="ia{k}" operator="arithmetic" k2="-1" k3="1" result="ii{k}"/>
  <feColorMatrix in="ii{k}" type="matrix" values="0 0 0 0 {R}  0 0 0 0 {G}  0 0 0 0 {B}  0 0 0 {A} 0" result="ic{k}"/>
  <feBlend in="ic{k}" in2="{prev}" mode="normal" result="is{k}"/>                           prev = is{k}
if a visible FOREGROUND_BLUR exists: <feGaussianBlur in="{prev}" stdDeviation="{σ}"/>
```

These are the recipes Figma's own SVG export uses, so resvg and Chromium both render them.
The `127` alpha multiplier turns any non-zero alpha into a hard silhouette; `operator="out"`
implements "do not show the shadow behind the node"; `arithmetic k2=-1 k3=1` yields the
inner-shadow region (silhouette minus the offset, blurred silhouette).

Unit test (`test/unit/effects.test.ts`): the Dynamic Island effect of Appendix A
(offset 0/4, radius 8, spread 0, colour rgba(0,0,0,0.4), `showShadowBehindNode: false`) must
produce a filter whose primitives contain `stdDeviation="4"`, `dy="4"`, `operator="out"`, and
the colour matrix ending in `0 0 0 0.4 0`.

### 4.10 Masks (`export.ts`)

`defineMask(maskNode, maskedSiblings)` registers a **luminance** mask in the **parent's**
coordinate space (the siblings are positioned there):

```xml
<mask id="…" maskUnits="userSpaceOnUse" x="{r.x}" y="{r.y}" width="{r.w}" height="{r.h}" color-interpolation="sRGB">
  …the mask node emitted with emitNode() in a render mode chosen by maskType…
</mask>
```

`r` = union of `transformBox(childMatrix, renderBounds(child))` over the mask node and the
masked siblings (never use an unbounded region; the rasterizer allocates it).

Coverage by `maskType` (default ALPHA):

| maskType | How the mask content is emitted |
|---|---|
| OUTLINE | render mode `outline-white`: every paint is replaced by opaque `#ffffff`, images and gradients become white, node/paint opacity forced to 1, effects skipped. Luminance of white = full coverage exactly where the geometry is. |
| ALPHA | normal render, wrapped in `<g filter="url(#a2w)">` where `a2w` is `<filter><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0"/></filter>` (RGB forced to 1, alpha kept). Luminance × alpha = alpha. |
| LUMINANCE | normal render as-is. |

Using luminance masks for all three types avoids depending on the `mask-type` property.
The mask node itself is never painted as content.

Measured (Appendix E, R7–R8): resvg computes mask luminance in **sRGB** — a `#808080` mask
gives coverage 128, not the ~55 that linearRGB would give — and it **ignores the
`color-interpolation` attribute** entirely, so all three values behave the same. Keep emitting
`color-interpolation="sRGB"` anyway: it is a no-op in resvg but makes browsers and Inkscape
agree with it. Both the ALPHA trick and nested masks were verified to work, and a `<mask>` child
does honour `fill-rule` (unlike a `<clipPath>` child).

### 4.11 Opacity and blend modes

`opacity < 1` → `opacity` attribute on the node group (children composite first, then fade —
Figma's layer opacity semantics). `blendStyle(n, isContainer)`:

| Figma | CSS `mix-blend-mode` | Note |
|---|---|---|
| PASS_THROUGH (default) | none | for containers: no isolation |
| NORMAL | none | for containers add `isolation:isolate` (the group composites as a unit) |
| DARKEN, MULTIPLY, COLOR_BURN, LIGHTEN, SCREEN, COLOR_DODGE, OVERLAY, SOFT_LIGHT, HARD_LIGHT, DIFFERENCE, EXCLUSION, HUE, SATURATION, COLOR, LUMINOSITY | the same name in kebab-case | exact |
| LINEAR_DODGE | `screen` | approximated; report `blend:LINEAR_DODGE` |
| LINEAR_BURN | `multiply` | approximated; report `blend:LINEAR_BURN` |

Emit as `style="mix-blend-mode:multiply"` (plus `;isolation:isolate` when applicable).
Paint-level `blendMode` other than NORMAL/PASS_THROUGH: the same style on that paint's
`<path>`/`<rect>`.

### 4.12 The report (`report.ts`)

```ts
export interface FeatureEntry { feature: string; count: number; examples: string[] }   // ≤ 5 example guids
export interface RenderReport {
  root: { guid: string; name: string; type: string };
  nodesVisited: number; nodesDrawn: number;
  bounds: Box; width: number; height: number; scale: number;
  unsupported: FeatureEntry[];   // not drawn at all
  approximated: FeatureEntry[];  // drawn, but not exactly like Figma
  featuresPresent: string[];     // every vocabulary key seen in the subtree, drawn or not (used by the coverage matrix)
  svgBytes: number; renderMs: number; rasterMs?: number;
}
```

The vocabulary of `feature` strings is fixed (Appendix D). `featuresPresent` is filled by a
scan of every visited node: node types, paint types, effect types, blend modes, mask types,
image scale modes, `dashPattern` presence, text decorations, emoji.

### 4.13 Caps and numbers

* `maxNodes` (default 20 000, hard maximum 60 000): compare against
  `index.subtreeRange(root)` **before** exporting; refuse with a hint to pick a smaller root.
* Output pixel size: the longest edge of `renderBounds × scale` is reduced to `maxSize`
  (default 1568, hard maximum 4096) by lowering the effective scale; report the effective scale.
* `MAX_SVG_BYTES = 64 MB`: if the SVG string exceeds it, fail with `oversize` and a hint
  (fewer nodes, or the biggest images are duplicated too often). Optional optimisation for
  later, now **verified to work in resvg** (Appendix E, R12): one `<image id>` per hash in
  `<defs>` referenced through `<use>`, either inside a nested `<svg viewBox preserveAspectRatio>`
  or under a `<g transform>`. Note that resvg's `imagesToResolve()`/`resolveImage()` pair — which
  would let us keep bytes out of the SVG entirely — reports **only `http`/`https` hrefs**, so it
  cannot help here and data URIs stay mandatory. Never emit an `http(s)` href: it would need
  network access we do not do, and resvg draws nothing for it.
* All numbers through `fmt()` (3 decimals). Build the SVG as an array of strings joined once.

### 4.14 Fallbacks when derived data is missing

Older files and files written by other tools may lack derived data. Implement these cheap
fallbacks and report the rest:

* RECTANGLE / ROUNDED_RECTANGLE / FRAME-like without `fillGeometry` but with visible fills:
  synthesise a rounded rectangle path from `size` and `cornerRadius` (use `rectangleCornerRadii`
  if the file has per-corner values); report `geometry:synthesised`.
* ELLIPSE without geometry: four cubic arcs (kappa 0.5523); LINE without `strokeGeometry`:
  nothing (report `stroke-without-geometry`).
* Any node with visible strokes and no `strokeGeometry`: report `stroke-without-geometry`.
* VECTOR / STAR / REGULAR_POLYGON without geometry: report `vector-without-geometry`
  (decoding `vectorNetworkBlob` is out of scope for v1).
* TEXT without outlines: report `text-without-outlines` (font-based rendering is out of scope).

---

## 5. The rasterizer wrapper (`raster.ts`)

```ts
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

interface RenderedImage { asPng(): Uint8Array; readonly width: number; readonly height: number; free(): void }
interface ResvgModule {
  initWasm(input: Uint8Array): Promise<void>;
  Resvg: new (svg: string, opts?: Record<string, unknown>) => { render(): RenderedImage; free(): void };
}
let loading: Promise<ResvgModule | undefined> | undefined;

/** Resolves to undefined when the optional package is not installed. Never throws. */
export function rasterizer(): Promise<ResvgModule | undefined> {
  if (!loading) loading = (async () => {
    let mod: ResvgModule;
    try {
      const name = '@resvg/resvg-wasm';                 // variable: keeps tsc from resolving the module at build time
      mod = (await import(name)) as ResvgModule;
    } catch { return undefined; }                       // not installed — the only "absent" case
    try {
      const wasm = fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
      await mod.initWasm(wasm);
    } catch (e) {
      // initWasm() throws "Already initialized. The `initWasm()` function can be used only once."
      // if some other copy of this module already ran it (two dist copies, a test harness, a
      // second server in-process). That is success, not failure — the module is usable.
      if (!/already initialized/i.test(String((e as Error)?.message))) return undefined;
    }
    return mod;
  })();
  return loading;
}

export interface RasterResult { png: Uint8Array; width: number; height: number }
/** undefined = no rasterizer. Throws only if resvg rejects the SVG (caller reports it). */
export async function rasterize(svg: string, scale: number, background?: string): Promise<RasterResult | undefined> {
  const mod = await rasterizer(); if (!mod) return undefined;
  const r = new mod.Resvg(svg, { fitTo: { mode: 'zoom', value: scale }, background, font: { loadSystemFonts: false } });
  const img = r.render();
  try { return { png: img.asPng(), width: img.width, height: img.height }; }
  finally { img.free(); r.free(); }
}
```

Everything above is measured, not assumed — see **Appendix E**. Four points the code depends on:

* **`RasterResult` deliberately does not expose `pixels`.** resvg's `pixels` buffer is
  **premultiplied** (measured: 50 %-alpha red comes back as `128,0,0,128`, not `255,0,0,128`),
  so comparing it against `pngjs` output would be silently wrong everywhere. Decoding `png` with
  `pngjs` gives straight alpha on both sides of every comparison. Do not add `pixels` back.
* **`logLevel` is not an option** of this package (it exists on `@resvg/resvg-js`). Unknown keys
  are ignored rather than rejected, so passing it does no harm and no good — leave it out.
* **`new Resvg(...)` throws a plain `Error` on malformed SVG** ("SVG data parsing failed …").
  `rasterize` lets it propagate; the tool and the CLI catch it and report `svg-rejected`.
* **Sizing**: the SVG carries `width`/`height` at 1×, and `fitTo: zoom` produces
  `round(w × scale) × round(h × scale)` — verified on fractional cases (18×14 at 1.1 → 20×15;
  14.25 at 2 → 29). `free()` is hygiene, not a leak fix; memory is bounded either way.

---

## 6. The `fig_render` tool (`src/mcp/tools/render.ts`)

### 6.1 Input schema

```ts
file: fileArg,
guid: z.string().describe('Node to render, e.g. "2:1339". A page guid renders the whole page, downscaled to fit maxSize.'),
format: z.enum(['png', 'svg']).optional().describe('Default "png". Falls back to SVG text when the optional rasterizer is not installed.'),
scale: z.number().min(0.1).max(4).optional().describe('Device scale factor. Default 2. Lowered automatically to respect maxSize.'),
maxSize: z.number().int().min(64).max(4096).optional().describe('Longest edge in pixels. Default 1568.'),
background: z.enum(['transparent', 'page']).optional().describe('Default "transparent". "page" fills with the page background colour.'),
savePath: z.string().optional().describe('Write the PNG/SVG to this path (directories are created) instead of inlining it. Required when the PNG exceeds 2 MB or the SVG exceeds 50 000 characters.'),
maxNodes: z.number().int().min(1).max(60000).optional().describe('Refuse subtrees larger than this. Default 20000.'),
```

`annotations: { readOnlyHint: false }` (because of `savePath`), title "Render a node to an
image".

### 6.2 Behaviour

1. `load(ctx, file)`, `requireNode(index, guid)`; DOCUMENT → error "render a page or a node".
2. `renderNode(entry, guid, opts)` (§4, `src/render/index.ts`) → `{ svg, report }`, applying
   `maxNodes`, `maxSize`, effective scale, `background` (page colour from F13 or transparent).
3. `format: 'svg'` (or PNG requested but rasterizer unavailable): with `savePath` write the
   SVG and return the report (adding `savedTo`); otherwise return the SVG as a text block if
   `svg.length ≤ HARD_CAP`, else an error telling the caller to pass `savePath`. When the PNG
   fallback happened, the report gets `note: "rasterizer unavailable — npm install @resvg/resvg-wasm"`.
4. `format: 'png'`: `rasterize(svg, effectiveScale, background)`. With `savePath` write the
   bytes and return the report. Otherwise, if `png.length ≤ 2 MB` return
   `content: [{ type: 'image', data: base64, mimeType: 'image/png' }, { type: 'text', text: JSON report }]`;
   above 2 MB return the report with a hint to lower `maxSize`/`scale` or use `savePath`.
5. The JSON text block must stay under `DEFAULT_BUDGET`: cap `unsupported` and `approximated`
   at 20 entries each and `examples` at 5 guids; `featuresPresent` is omitted from the tool
   response (it is for the tester).

### 6.3 Response example

```
// → fig_render { "file": "…/sample.fig", "guid": "2:1339" }
// [image content, 268×80 PNG]
// { "guid": "2:1339", "name": "…", "type": "FRAME", "format": "png", "width": 268, "height": 80,
//   "scale": 2, "bounds": { "x": 0, "y": 0, "w": 134, "h": 40 }, "nodesDrawn": 4,
//   "unsupported": [], "approximated": [], "renderMs": 9, "rasterMs": 31 }
```

### 6.4 Description text (verbatim, keep it short)

> Render a node — frame, component, instance, group, shape, text, or a whole page — to a PNG
> the model can look at, or to SVG. Fully offline: geometry, text outlines and images all come
> from the file. Rendering is best-effort: read `approximated` and `unsupported` in the report
> before trusting fine details; exact values remain available from fig_node / fig_style /
> fig_text. Default output is PNG at 2×, capped to 1568 px on the longest edge; use `savePath`
> to write a file instead of inlining it.

### 6.5 Registration and docs

Add `import * as render from './tools/render.js'` to `src/mcp/create.ts` and register it with
the others (tool count becomes 12; update the `tools/list` assertion in `scripts/smoke.mjs`
and the golden test). Append to `INSTRUCTIONS`: "fig_render returns a picture of any node —
the fastest way to understand a frame. Always check its `approximated`/`unsupported` lists."
In `README.md` replace the rendering non-goal with a "Rendering is best-effort" paragraph
listing what is exact (solid fills, gradients, images, strokes, booleans, text, clipping,
opacity, most blend modes, drop/inner shadows, layer blur, masks) and what is approximated or
skipped (background blur drawn flat, plus-lighter/darker blends approximated, emoji and
FigJam-style nodes skipped, angular gradients averaged), and document the tool with the §6.3
example.

---

## 7. The CLI (`scripts/render.mjs`)

```
node scripts/render.mjs <file.fig> <guid> <out.png|out.svg> [--scale N] [--max-size N] [--background page] [--max-nodes N]
```

Loads `dist/cache.js` (`new FileCache(1).get(file)`) and `dist/render/index.js`, writes the
file (`.svg` extension → SVG; otherwise PNG, or SVG with a warning when the rasterizer is
missing), prints the report as JSON. Exit code 1 on error. This is the tool you use in §0.1.

---

## 8. Tests for R0–R6

Unit tests need no asset. Golden tests use `figma-input/sample.fig` and follow the existing
skip pattern (`test/fixtures/asset.ts`); PNG-based assertions additionally skip with the
message "rasterizer not installed" when `rasterizer()` resolves to undefined.

`test/golden/render.test.ts` (one file, one parse, `describe` per milestone):

| Milestone | Assertion |
|---|---|
| R0 | blob #390 of node `2:1558` decodes to the F4 golden string (1-decimal rounding). |
| R1 | `2:1558` → SVG contains one `<path` with `fill="#`; PNG at scale 1 is 18×14; pixel (9,7) alpha 255; pixel (0,0) alpha < 128 (rounded corner). |
| R1 | `2:1339` → PNG at scale 2 is 268×80; report has no `unsupported`; SVG contains one `<clipPath` (the frame clips). |
| R2 | `2:1336` (the digit "2", 8×18) → at scale 1 every row containing ink lies within rows 3..13 and rows 14..17 have no ink (proves the y-up glyph axis; if the ink is in rows 13..17 the sign is wrong). |
| R2 | `2:7099` ("Yesterday 9:41", 267×13) → ink columns start ≥ 90 and end ≤ 180 at scale 1 (first glyph pen x = 94.06). |
| R3 | `2:7082` (12×12 top-to-bottom gradient) → SVG has a `<linearGradient` whose transform maps (0,0.5)→(6,0) and (1,0.5)→(6,12) within 0.01 (parse the six numbers). |
| R3 | `2:2050` (96×96 ellipse with a FILL image) → SVG has one `<pattern` with `preserveAspectRatio="xMidYMid slice"`; PNG pixel (48,48) opaque, pixel (2,2) transparent. |
| R3 | `9:61907` (TILE) → pattern width = intrinsic width × 0.5. |
| R4 | `2:7389` (373×200, drop shadow 0/4 r8) → PNG at scale 1 is 389×216 (§4.5 margins); some pixel in the bottom margin row 210 has alpha > 0. |
| R4 | `2:1327` (parent of an OUTLINE mask) → SVG has one `<mask` and the mask node's own guid is not emitted as content outside it; `550:1552` (LUMINANCE) and `2:7384` (ALPHA) render without error, ALPHA's mask contains `filter="url(#`. |
| R4 | `2:7386` → `approximated` contains `effect:BACKGROUND_BLUR` (2:3417 is hidden); `550:1438` → `approximated` contains `blend:LINEAR_BURN`; `2:7093` → `approximated` contains `emoji`. |
| R5 | via the harness: `fig_render {guid:'2:1339'}` → `content[0].type === 'image'`, decoded PNG 268×80, `content[1]` parses as JSON with `width: 268`; text block ≤ 20 000 chars. `format:'svg'` → text starts with `<svg`. `savePath` → file exists, response has `savedTo`. Unknown guid → `isError`. Page `0:1` with `maxSize: 512` → both dimensions ≤ 512 and `scale < 1`. `maxNodes: 10` on `0:1` → `isError` with a hint mentioning `maxNodes`. |
| R6 | a NodeChange with a deliberately corrupt blob (built in memory) renders with `unsupported` containing `geometry:corrupt` instead of throwing; rendering a 300-node frame takes < 500 ms after the parse. |

Pixel helpers for tests live in `test/visual/lib/png.ts` (decode PNG with `pngjs`, read a
pixel, ink rows/columns = pixels with alpha > 32).

---

## 9. The visual tester (R7–R8)

### 9.1 Fixture layout

```
fixtures/<design>/
  design.fig                  saved from Figma in the same sitting as the exports
  exports/
    2_39.png  2_39@2x.png  2_39.svg          (guid form, from the plugin of Appendix B)
    Tab.png   Tab@2x.png   Tab.svg           (layer-name form, from manual export)
  manifest.json               optional; required for ambiguous layer names (§9.2)
  expect.json                 ratchet scores, committed (§9.7)
```

`manifest.json`:

```json
{ "exportedAt": "2026-09-02T10:00:00Z", "frames": [
  { "guid": "2:1339", "png": "Tab.png", "png2x": "Tab@2x.png", "svg": "Tab.svg" } ] }
```

### 9.2 Matching exports to nodes (`fixtures.ts`)

For every `exports/*.png|*.svg` not named in the manifest: parse `<base>[@<n>x].<ext>`. If
`<base>` looks like `<sessionID>_<localID>` use that guid directly. Otherwise collect nodes
whose `name === <base>`; for each candidate compute the expected export size
`round(renderBounds(node).w × n) × round(renderBounds(node).h × n)` and keep those within
±2 px of the PNG's size; exactly one → matched; zero or several → listed under
`unmatched` in the report with the candidates' guids so the user can add a manifest entry.
Text nodes exported without absolute bounds are cropped by Figma and will not match — prefer
frames as fixtures.

### 9.3 Comparing two images (`compare.ts`)

Inputs: two RGBA buffers with sizes. Steps:

1. Composite both onto the same opaque background (white by default) with straight alpha:
   `out = src × α + bg × (1 − α)`.
2. If sizes differ by ≤ 2 px on each axis, crop both to the common size anchored top-left;
   otherwise return `{ status: 'size-mismatch', ours, theirs }` and stop.
3. If the scale is ≥ 2, downscale both by 2 with a 2×2 box filter (this removes most
   anti-aliasing noise).
4. `pixelmatch(a, b, diff, w, h, { threshold: 0.1, includeAA: false })` → `diffPixels`.
5. Metrics: `diffRatio = diffPixels / (w × h)`; `badBlocks` = number of 8×8 blocks in which
   more than half the pixels differ; `diff` image (write as PNG for the gallery).

Return `{ status: 'ok', diffRatio, badBlocks, width, height, diffPng }`.

### 9.4 The four levels and the ceiling (`cli.ts`)

For each matched frame, render ours with `renderNode` at the fixture scale (2 when a `@2x`
export exists, else 1):

| Level | Check | Pass rule (initial; calibrate in R8) |
|---|---|---|
| 1 sanity | SVG produced; `SvgWriter` balanced; no `NaN`/`Infinity`/`undefined` substrings; every `url(#id)` has a matching `id="…"`; rasterizer accepts it | all true |
| 2 self-consistency | output size = `round(renderBounds × scale)`; if the node has an opaque fill covering its box, the opaque pixel bbox equals the node box (offset by the bounds origin); hidden root → empty image; 1× render downscaled ≈ 2× render (`diffRatio < 0.02`) | all true |
| 3 geometry | `compare(rasterize(ourSvg), rasterize(figmaSvg))` at the same scale | `diffRatio ≤ 0.01` |
| 4 truth | `compare(rasterize(ourSvg), figmaPng)` | `diffRatio ≤ max(0.03, ceiling + 0.01)` |
| ceiling | `compare(rasterize(figmaSvg), figmaPng)` | informational; printed next to level 4 |

Level 3 is skipped with the note `figma-svg-has-text` when Figma's SVG contains `<text`
(exported without "Outline text"), and annotated `figma-svg-has-foreignObject` when it
contains `<foreignObject` (Figma's background blur; resvg ignores it, which lowers the ceiling).

### 9.5 Attributing differences to layers (`attribute.ts`)

Input: the diff mask from level 3 or 4 and the render's node boxes. During export, when
`collectBoxes: true` is passed, the exporter records `{ guid, type, name, box }` for every
drawn node with `box` = its `renderBounds` transformed into **root-local** coordinates
(compose the matrices from the node up to, but excluding, the root).

1. Downsample the diff mask to an 8×8-pixel block grid (a block is "bad" if > 25 % of its
   pixels differ).
2. Connected components of bad blocks (4-neighbour BFS); keep components of ≥ 2 blocks.
3. For each component: pixel bbox → root-local bbox (`/ scale`, then `+ bounds origin`).
4. Choose the drawn node with the **smallest area** whose box covers ≥ 80 % of the cluster's
   bbox area; fall back to the root.
5. Report the top 10 clusters as `{ guid, name, type, clusterBox, blocks }`.

### 9.6 Coverage matrix (`coverage.ts`)

For every fixture frame, `report.featuresPresent` (Appendix D vocabulary) says which features
occur in its subtree. For every feature: the frames containing it, and the best level-3 and
level-4 status among them. A feature is **proven** when at least one containing frame passes
level 4. Output as a table in `report.json` and the gallery, sorted with unproven features
first. This is the "how good is our code" number: proven features / features present in the corpus.

### 9.7 Ratchet (`ratchet.ts`)

`expect.json` per fixture: `{ "<guid>": { "level3": 0.0071, "level4": 0.0224 } }` = best
`diffRatio` achieved so far. A test fails if the new ratio exceeds the stored one by more
than 0.002. `npm run visual:update` writes improvements only (never a worse value) and adds
entries for new frames. A frame with no entry passes with a warning on its first run.

### 9.8 Gallery and report (`gallery.ts`)

`reports/visual/report.json` (everything above) and `reports/visual/index.html`: one row per
frame with three images (Figma PNG, ours, diff), the metrics, the level results, the top
attributed layers, and the frame's `unsupported`/`approximated` lists; a coverage table at the
top. Plain HTML, relative `<img>` paths, no scripts needed.

### 9.9 CLI and test integration

```
node scripts/visual.mjs [--fixtures <dir>] [--only <design>[/<guid>]] [--update] [--scale 1|2]
```

`test/visual/visual.test.ts`: discovers `fixtures/*/design.fig`; skips the whole file with a
clear message when none exist; one `it` per frame and level; levels 3–4 are skipped per frame
when the corresponding export is missing; ratchet applied. Heavy fixtures make `npm test`
slower — acceptable; `VISUAL=0 npm test` skips them.

---

## 10. Milestones

### R0 — Geometry primitives
`matrix.ts`, `path.ts`, `svg.ts` (`fmt`, `esc`, writer), unit tests for all three, and the
R0 golden decode of blob #390.
**Accept**: `npm test` green (existing 102 + new); `toPathData` of blob #390 equals the F4 string.

### R1 — Rasterizer, CLI, exporter core
`raster.ts`, `bounds.ts`, `color.ts`, `report.ts`, `export.ts` with containers, shapes,
SOLID paints, clipping, opacity, transforms; `index.ts`; `scripts/render.mjs`;
the rasterizer is already in `optionalDependencies` and installed — nothing to add there.
**Accept**: R1 golden rows; render `2:1339` and `2:1558` and **look** at the PNGs (Appendix A);
the server still starts and the 11 existing tools are unchanged.

### R1.5 — Instances
`instance.ts` (override-record maps, `mergeNode`, `descend`, `instanceShapeNode`) and the
INSTANCE branch of the traversal, per F17. Added after R1 because F17 was only discovered once
real frames were rendered, and placed **before** text because instance text arrives as
`derivedSymbolData[].derivedTextData` and would otherwise have to be done twice.
**Accept**: `2:1340` renders the gear at the instance's 16×16, not the symbol's 22×22; `2:1401`
renders a bordered pill containing the nested icon; no `instance-unresolved` or
`instance-recursive` entries on the sample.

### R2 — Text
`text.ts` with glyph outlines, style colours, decorations, emoji reporting.
**Accept**: R2 golden rows; view `2:1336`, `2:7099`, `2:6971` (underlined Japanese text).

### R3 — Paints
Gradients, images (four modes, de-duplicated patterns, data-URI cache), paint opacity and
visibility, per-region `styleID`, unsupported paint reporting.
**Accept**: R3 golden rows; view `2:2050` (a face photo clipped to an ellipse) and `9:61907`.

### R4 — Effects, masks, blend modes
`effects.ts`, mask runs and the three mask types, `blendStyle`, isolation.
**Accept**: R4 golden rows; view `2:7389` (soft shadow below the island), `2:1327`, `2:7384`.

### R5 — The tool
`render.ts`, registration, `INSTRUCTIONS`, README, smoke script updated (12 tools).
**Accept**: R5 golden rows; `npm run smoke` passes; `npm test` green.

### R6 — Hardening
Caps (§4.13), fallbacks (§4.14), per-node error isolation, timing, the Appendix D vocabulary
frozen in `report.ts`, and a docs addendum to `fig-file-format.md` §7 recording F4, F5, F7.
**Accept**: R6 golden rows; rendering page `0:1` at `maxSize 1024` completes in < 10 s after
parse and reports every skipped feature.

### R7 — Tester without Figma exports
`test/visual/lib/{png,compare,attribute,coverage,gallery,fixtures,cli}.ts`, `scripts/visual.mjs`,
levels 1–2, the coverage scan, the gallery; `test/visual/visual.test.ts` skipping cleanly.
**Accept**: `npm run visual` over a fixture made from the sample file (`fixtures/sample/design.fig`
copied or symlinked, no exports) produces `reports/visual/index.html` with level 1–2 results
and the coverage table for a hand-picked list of 10 frames; `npm test` still green with no
fixtures present.

### R8 — Oracles
`docs/render-fixtures.md` (Appendix B), levels 3–4, ceiling, attribution, ratchet,
`--update`. Then calibrate with the first real fixtures the user provides: the drop-shadow
margin rule (§4.5), the image-crop direction (§4.7.3), mask-run semantics (F11), luminance
colour space (§4.10), and the pass thresholds (§9.4).
**Accept**: with at least one fixture that has PNG and SVG exports, the gallery shows all four
levels and the ceiling; `expect.json` is written; a deliberate regression (e.g. comment out
stroke drawing) makes `npm test` fail on level 3.

**Status (2026-09-02).** The machinery is built and proven; the calibration is not, and cannot
be from inside this repository — it needs Figma exports, which need a Figma account. What was
done instead: `test/visual/visual.test.ts` runs the whole oracle path against a **self-oracle**,
exports produced by our own renderer. That proves matching, rasterizing an external SVG, the
comparison, the ceiling, attribution and the ratchet all work end to end — levels 3 and 4 run
and score 0, a defaced oracle is caught, and the difference is attributed to the right layer. It
proves nothing about fidelity to Figma.

One thing the self-oracle taught us, which is worth keeping: deface only the PNG and level 4
still passes, because Figma's own SVG no longer matches Figma's own PNG either and the ceiling
rises with the difference. That is the ceiling doing exactly its job — refusing to blame the
renderer for something the route cannot reach — and it is now a test in its own right.

**Still open, each waiting on one fixture** (§4.1 of `docs/render-fixtures.md` names them):
the drop-shadow margin rule (§4.5), the image-crop direction (§4.7.3 — six paints on the
sample's main page take that branch, all reported as `image-crop`), mask-run termination (F11),
LUMINANCE colour space (§4.10), and the level-3/4 thresholds (§9.4), which are currently the
plan's initial guesses.

**Status (2026-09-18).** The first real oracle arrived: a Figma PNG export of frame
`863:171055` "SCREEN-A" (1440×3026, an appointment form built almost entirely from component
instances). Compared against it, the R1.5 renderer was wrong in every instance-heavy region —
the same text on every card, hidden icons drawn, placeholder text visible, an icon in orange
that Figma draws in #333333, a panel cut off at a third of its height. The causes are F17
(corrected), F18, F19, F20 and F21 above, each measured file-wide before being fixed, and each
now has golden tests against that frame (`R9` in `test/golden/render.test.ts`). Pixels differing
from the export went from 0.97 % to 0.18 %, which is anti-aliasing. The export ships as
`fixtures/sample/exports/863_171055.png`, so `npm run visual` now runs level 4 on one frame
with a real Figma oracle (no SVG export, so level 3 and the ceiling still wait). Variable modes
were checked and ruled out for this frame: all 170 variable-bound paints under it cache their
default-mode value, though 6 929 nodes in the file do set `variableModeBySetMap`, so a frame
that switches modes remains an open question for a fixture.

---

## 11. Definition of done

- [ ] `npm test` fully green: the original 102 tests, the new unit tests, the golden render
      tests, and the visual tests (skipping cleanly without fixtures or rasterizer).
- [ ] `npm run smoke` passes with 12 tools; `npm run crosscheck` unchanged; `tools/fig2json.mjs` unchanged.
- [ ] `fig_render` answers for `2:1339` with an image block and a report under budget; SVG
      fallback works with the optional package removed (`npm uninstall @resvg/resvg-wasm`, run
      the harness, reinstall).
- [ ] The CLI renders any guid of the sample file to disk.
- [ ] README documents the tool, the best-effort rule and the optional dependency;
      `docs/fig-file-format.md` §7 records F4, F5 and F7; `docs/render-fixtures.md` exists.
- [ ] `npm run visual` produces the gallery; the ratchet and coverage matrix work on at least
      one fixture with exports.
- [ ] No runtime network use; no new runtime dependency besides the optional rasterizer.

---

## Appendix A — Reference nodes in `figma-input/sample.fig`

All on page `0:2` "Page 1" unless noted. Sizes in px. "Expect" describes what
you must see when you Read the rendered PNG.

| Guid | Type | Size | Feature | Expect |
|---|---|---|---|---|
| `2:1558` | ROUNDED_RECTANGLE | 18×14, r 2 | path decoding (blob #390) | a small rounded rectangle filled edge to edge |
| `2:1339` | FRAME | 134×40 | 1 px inside stroke, clips, no fill, children | a bordered pill/tab with text inside |
| `2:1336` | TEXT "2" | 8×18 | glyph axis | a digit 2 sitting on the baseline, not upside down |
| `2:7098` / `2:7099` | FRAME / TEXT | 267×81 / 267×13 | 4 styled runs | "Yesterday 9:41" small, right of centre |
| `2:6971` | TEXT | 417×168 | underline decorations (2 rects, styleID 5) | Japanese text with two underlines |
| `2:7082` | INSTANCE | 12×12 | linear gradient, default vertical transform | pink, lighter at the top (241,159,180 → 238,123,149) |
| `2:2050` | ELLIPSE "face" | 96×96 | IMAGE FILL, hash `41a2bb3840cdd686ec2cfd85641d7475764932ab` | a photo cropped to a circle |
| `9:61907` | — | 610×137 | IMAGE TILE, scale 0.5 | a repeating texture |
| `2:7389` | FRAME "Dynamic Island" | 373×200 | drop shadow offset (0,4) r 8 rgba(0,0,0,0.4), knock-out | a soft shadow below; output 389×216 at 1× |
| `2:1345` | ROUNDED_RECTANGLE | 134×1 | inner shadow offset (1,0) r 0 | a 1-px line |
| `2:7386` | VECTOR "Blur" | 373×234 | layer blur r 32 | a blurred blob |
| `2:3417` | ROUNDED_RECTANGLE | 100×100 | BACKGROUND_BLUR r 20 | **`visible: false`** — renders empty. Use `2:7386` / `2:7384` for the background-blur report instead |
| `2:1327` → mask `2:1328` | parent / VECTOR | 22×12.4 | OUTLINE mask, 1 masked sibling | only the masked shape's overlap with the mask outline |
| `2:7384` → mask `2:7385` | parent / VECTOR 393×222 | ALPHA mask (default) | content limited to the mask shape |
| `550:1552` → mask `550:1553` | parent / INSTANCE 200×200 | LUMINANCE mask | content faded by the mask's brightness |
| `2:1307` | BOOLEAN_OPERATION XOR | 22×22 | combined geometry, children not drawn | an icon with a hole |
| `2:1575` | VECTOR | 22×12.4 | 90° rotation matrix | the shape rotated |
| `2:3205` | FRAME "Group" | 96×38 | opacity 0.65 | semi-transparent group |
| `2:1398` | FRAME | 1398×920 | dashed stroke 10/5 | dashes visible if baked into `strokeGeometry` (else fixture `cf-stroke-dashed`) |
| `2:7093` | TEXT | 29×29 | emoji glyph 🌻 | blank where the emoji is; `approximated: emoji` |
| `550:1438` | TEXT | 36×44 | LINEAR_BURN | drawn with `multiply`; `approximated: blend:LINEAR_BURN` |
| `0:1` | CANVAS "Page 7" | page | whole-page render | a downscaled map of the page; background rgb(30,30,30) with `background:"page"` |

---

## Appendix B — Fixture guide (copy to `docs/render-fixtures.md`)

### B.1 What to export, and how

For every frame you want as an oracle, export from Figma **in the same sitting** as the
`.fig` (File → Save local copy). Any edit between the two invalidates the fixture.

* PNG at 1× and 2× — the truth.
* SVG with **Outline text ON** (mandatory: no fonts needed on any machine), *Include "id"
  attribute* off, *Simplify stroke* off.
* Prefer frames over bare text nodes (Figma crops text exports to the ink).

Manual export names files after layers (`Tab.png`, `Tab@2x.png`); the tester matches them by
name and size (§9.2). The plugin below names files by guid and writes the manifest, which
removes all ambiguity.

### B.2 The fixture-exporter plugin

Create a folder with three files, then in the Figma desktop app: Plugins → Development →
Import plugin from manifest. Select the frames (or nothing for the whole page) and run it;
the UI offers one download per file and a "Download all" button. Move the files into
`fixtures/<design>/exports/`.

`manifest.json`
```json
{ "name": "figfile fixture exporter", "id": "figfile-fixture-exporter", "api": "1.0.0",
  "main": "code.js", "ui": "ui.html", "editorType": ["figma"] }
```

`code.js`
```js
figma.showUI(__html__, { width: 380, height: 420 });
async function run() {
  const nodes = figma.currentPage.selection.length ? figma.currentPage.selection : figma.currentPage.children;
  const frames = [];
  for (const node of nodes) {
    if (!('exportAsync' in node)) continue;
    const base = node.id.replace(':', '_');
    const png = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 }, useAbsoluteBounds: true });
    const png2x = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 }, useAbsoluteBounds: true });
    const svg = await node.exportAsync({ format: 'SVG', svgOutlineText: true, svgIdAttribute: false, svgSimplifyStroke: false, useAbsoluteBounds: true });
    figma.ui.postMessage({ type: 'file', name: base + '.png', bytes: png });
    figma.ui.postMessage({ type: 'file', name: base + '@2x.png', bytes: png2x });
    figma.ui.postMessage({ type: 'file', name: base + '.svg', bytes: svg });
    frames.push({ guid: node.id, name: node.name, type: node.type, width: node.width, height: node.height,
                  png: base + '.png', png2x: base + '@2x.png', svg: base + '.svg' });
  }
  const manifest = { figmaFile: figma.root.name, page: figma.currentPage.name, exportedAt: new Date().toISOString(), frames };
  figma.ui.postMessage({ type: 'text', name: 'manifest.json', text: JSON.stringify(manifest, null, 2) });
  figma.ui.postMessage({ type: 'done', count: frames.length });
}
run().catch((e) => figma.ui.postMessage({ type: 'error', message: String(e) }));
```

`ui.html`
```html
<body style="font: 12px sans-serif; padding: 8px">
<div id="status">exporting…</div><button id="all" hidden>Download all</button><ul id="list"></ul>
<script>
const files = [];
const download = (f) => { const a = document.createElement('a'); a.href = URL.createObjectURL(f.blob); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); };
onmessage = (e) => {
  const m = e.data.pluginMessage;
  if (m.type === 'file') files.push({ name: m.name, blob: new Blob([m.bytes]) });
  if (m.type === 'text') files.push({ name: m.name, blob: new Blob([m.text], { type: 'application/json' }) });
  if (m.type === 'error') { status.textContent = m.message; return; }
  if (m.type === 'done') {
    status.textContent = files.length + ' files for ' + m.count + ' frames';
    for (const f of files) { const li = document.createElement('li'); const b = document.createElement('button'); b.textContent = f.name; b.onclick = () => download(f); li.appendChild(b); list.appendChild(li); }
    all.hidden = false; all.onclick = async () => { for (const f of files) { download(f); await new Promise((r) => setTimeout(r, 300)); } };
  }
};
</script></body>
```

`useAbsoluteBounds: true` keeps text nodes at their box size; the plugin's guids are the
same `sessionID:localID` values the `.fig` stores.

### B.3 The conformance file

Build one Figma file with one small frame per feature, named `cf-<feature>`, so that a
failure isolates one feature. Suggested list (add any feature the coverage matrix reports as
present but unproven):

`cf-rect-radius`, `cf-ellipse`, `cf-line`, `cf-star`, `cf-polygon`, `cf-vector-curves`,
`cf-boolean-union`, `cf-boolean-subtract`, `cf-boolean-xor`, `cf-stroke-inside`,
`cf-stroke-outside`, `cf-stroke-center`, `cf-stroke-dashed`, `cf-stroke-caps`,
`cf-fill-solid-alpha`, `cf-gradient-linear-rotated`, `cf-gradient-radial`,
`cf-gradient-angular`, `cf-gradient-diamond`, `cf-image-fill`, `cf-image-fit`,
`cf-image-stretch`, `cf-image-crop`, `cf-image-tile`, `cf-image-rotate`,
`cf-text-plain`, `cf-text-mixed-styles`, `cf-text-underline-strike`, `cf-text-emoji`,
`cf-text-truncated`, `cf-text-vertical-align`, `cf-frame-clip`, `cf-frame-noclip`,
`cf-frame-stroke-over-children`, `cf-group-opacity`, `cf-blend-each` (one small square per
blend mode, labelled), `cf-mask-outline`, `cf-mask-alpha`, `cf-mask-luminance`,
`cf-mask-two-in-one-parent`, `cf-effect-drop-shadow`, `cf-effect-drop-shadow-spread`,
`cf-effect-inner-shadow`, `cf-effect-layer-blur`, `cf-effect-background-blur`,
`cf-instance-overrides`, `cf-nested-instances`, `cf-rotated-frame`, `cf-section`.

Export them all at once (select all frames → the plugin), save the `.fig`, and put both under
`fixtures/conformance/`. Community files can be duplicated to drafts for real-design
fixtures; check each file's licence before committing it.

---

## Appendix C — Pitfalls

1. **Groups clip nothing** even though `frameMaskDisabled` is false on them: test
   `resizeToFit` first (F10).
2. **Boolean operands must not be drawn**; if you recurse into BOOLEAN_OPERATION children the
   icons become solid blobs.
3. **Glyph outlines are y-up em units**; forgetting the sign flip draws text mirrored below
   the baseline (the `2:1336` golden catches it).
4. **The root has no transform** in the output; forgetting this shifts the whole image out of
   the viewBox.
5. **Never use an unbounded mask or filter region**; the rasterizer allocates it.
6. **`color-interpolation-filters="sRGB"`** on every filter, or shadows come out too light.
7. **`fmt()` everything, and make `fmt()` throw on `NaN`/`Infinity`.** Measured: resvg does
   **not** reject a `NaN` attribute — it silently drops that element and renders everything
   else, so a whole shape disappears with no error anywhere. Your own guard is the only
   detection. (Malformed *markup*, by contrast, does throw.)
8. **Absent fields mean defaults** (§0 rule 8); `imageScaleMode` absent is STRETCH, not FILL.
9. **Paint order**: `fillPaints[0]` is the bottom paint; children index 0 is the bottom layer.
10. **Effects on containers use the group's alpha** (fills + children + strokes), which is
    what the filter on the `<g>` gives you; do not apply the filter to the fill path only.
11. **Data URIs bloat**: de-duplicate patterns by key and watch `MAX_SVG_BYTES`.
12. **Do not read `advance`** to place glyphs; `position` already includes kerning.
13. **Windows file names**: `2:1339` → `2_39`.
14. **Tests import from `dist/`**: run `npm run build` before `node --test`; `npm test` does both.
15. **`clip-rule`, not `fill-rule`, inside `<clipPath>`** — `fill-rule` there is ignored in
    silence and ODD-winding clips lose their holes (§4.6, Appendix E R11).
16. **Never touch resvg's `pixels`** — it is premultiplied. Decode `png` with `pngjs` (§5).
17. **A wrong `renderBounds` crops effects rather than shifting them**: the `<filter>` region
    clips its own output, so a shadow that looks cut off on one side means the §4.5 margin rule
    is too small, not that the filter chain is wrong.
18. **Stroke alignment still needs a clip** (F16): `strokeGeometry` for INSIDE/OUTSIDE is a
    DOUBLE-width band straddling the edge. Drawn raw it paints a double-width border that
    bleeds outside the node, and it inflates the render bounds by the stroke weight.
19. **An INSTANCE has no children** (F17): its content is the SYMBOL it points at. Never let
    contentBounds descend into that symbol — the symbol is the symbol's size, not the
    instance's, and the render comes out too large with the content in one corner.
20. **Glyph blobs start with a close command** (F5): drop every command before the first
    moveto or the path is invalid and the rasterizer drops it without a word.
21. **A record path segment is `overrideKey ?? guid`** (F17). Components created in the file
    itself have no `overrideKey` on their children; look those records up by key alone and
    every override of every native component vanishes, with nothing in the report to say so.
22. **Hidden-by-property is invisible in the records** (F18). No `visible:false` record ever
    mirrors a BOOLEAN=false assignment; evaluate `componentPropRefs` against the assignments or
    every switched-off icon is drawn.
23. **The cached paint beside a style reference lies** (F19). Resolve `styleIdFor*` to the
    local style's paints on nodes, on records and on text-run entries; keep the cache only for
    remote styles and the detached sentinel.
24. **Measure inside instances on the effective node** (F20). Bounds, mask regions and clips
    computed on the raw symbol tree are the symbol's size; memoise per instance scope, and drop
    geometry a resizing record did not re-derive.
25. **`truncationStartIndex` counts glyphs, and glyph `styleID` is a decoy** (F21). Cut the
    glyph array at that index (the ellipsis is the glyph before it), and take the run style
    from `characterStyleIDs[firstCharacter]`.

---

## Appendix D — Feature vocabulary (report keys)

`node-type:<TYPE>` · `paint:<TYPE>` · `effect:<TYPE>` · `blend:<MODE>` · `mask:<TYPE>` ·
`image-mode:<MODE>` · `image-missing` · `image-format:<mime>` · `image-crop` ·
`image-rotation` · `image-filters` · `gradient-singular` · `emoji` · `glyph-rotation` ·
`text-without-outlines` · `text-property-without-outlines` · `text-stroke` · `text-decoration` ·
`text-truncation` · `stroke-dashed` · `stroke-align:<ALIGN>` ·
`stroke-without-geometry` · `vector-without-geometry` · `geometry:corrupt` ·
`geometry:synthesised` · `mask-hidden` · `oversize` · `svg-rejected` ·
`instance-unresolved` · `instance-recursive` · `instance-property` · `instance-swap` ·
`node-failed`.

The list is frozen in `src/render/report.ts` (`FEATURES` plus `FEATURE_PREFIXES`), and
`isKnownFeature()` guards it: a golden test renders six subtrees and fails if any reported key
is outside the vocabulary, so a typo cannot silently create a feature the coverage matrix will
never recognise.

`featuresPresent` uses the same keys for what exists in a subtree (e.g. `paint:SOLID`,
`effect:DROP_SHADOW`, `blend:MULTIPLY`, `mask:OUTLINE`, `image-mode:FILL`,
`text-decoration`, `stroke-dashed`), whether or not the exporter drew it exactly.

---

## Appendix E — Verified rasterizer contract (`@resvg/resvg-wasm@2.6.2`)

Every row was **measured** on 2026-09-02 against the installed package on this machine
(Node 24.3.0, Windows). These are facts, not expectations: do not re-research them, and treat a
disagreement between your code and this table as a bug in your code. Where a row corrects an
earlier assumption the affected section is named.

| # | Behaviour | Measured result |
|---|---|---|
| R1 | `initWasm(buffer)` accepts a Node `Buffer` | works; `index_bg.wasm` resolves through the package `exports` map |
| R2 | `initWasm()` called a second time | **throws** `Already initialized. The initWasm() function can be used only once.` — §5 treats this as success |
| R3 | `fitTo: { mode: 'zoom', value: s }` | output is `round(w × s) × round(h × s)`: 18×14 @2 → 36×28, @2.5 → 45×35, @1.1 → **20×15**, 14.25 @2 → **29** |
| R4 | no `fitTo` | renders at the SVG's own `width`/`height` |
| R5 | `pixels` | **premultiplied** — 50 %-alpha red reads `128,0,0,128`. Never compare it with `pngjs` output (§5) |
| R6 | `asPng()` / `pixels` buffers | plain JS copies, not views into WASM memory; safe to keep after `free()` |
| R7 | `<mask>` luminance | computed in **sRGB**: `#808080` → coverage 128 (linearRGB would be ~55) |
| R8 | `color-interpolation` on `<mask>` | **ignored** — sRGB, linearRGB and absent all give 128 (§4.10) |
| R9 | ALPHA-mask trick (`feColorMatrix` RGB→1, alpha kept) | gives exactly the alpha as coverage (50 % → 128) ✓ §4.10 |
| R10 | nested `<mask>` elements | intersect correctly |
| R11 | `fill-rule` on a `<clipPath>` child | **silently ignored** — use `clip-rule` (or `style="clip-rule:…"`). On ordinary paths and on `<mask>` children `fill-rule` works normally (§4.6) |
| R12 | `<use>` of a `<defs><image>` | works both inside a nested `<svg viewBox preserveAspectRatio>` and under a `<g transform>` — the §4.13 de-duplication is viable |
| R13 | `imagesToResolve()` / `resolveImage()` | lists **only `http`/`https`** hrefs; relative names, bare ids and custom schemes return `[]`. Data URIs stay mandatory (§4.13) |
| R14 | `<image>` href form | `xlink:href` and plain `href` both work; `data:image/png;base64,…` decodes |
| R15 | `<pattern patternUnits="userSpaceOnUse">` + `preserveAspectRatio` | `none`, `xMidYMid meet` (letterboxes) and `xMidYMid slice` (covers) all behave per spec; tiling repeats ✓ §4.7.3 |
| R16 | `mix-blend-mode:multiply` in `style` | honoured (red under blue → black) ✓ §4.11 |
| R17 | `isolation:isolate` on a `<g>` | honoured (the same pair stays blue) ✓ §4.11 |
| R18 | group `opacity` | composites the group first, then fades — overlapping children do not darken ✓ §4.11 |
| R19 | the §4.9 drop-shadow chain verbatim | renders: shadow below the shape, shape on top, empty outside. `feFlood`, `feColorMatrix` ×127, `feMorphology`, `feOffset`, `feGaussianBlur`, `feComposite operator="out"`, `feBlend` all supported |
| R20 | the §4.9 inner-shadow chain verbatim | renders; `feComposite operator="arithmetic" k2="-1" k3="1"` supported |
| R21 | `<filter>` region | **clips its own output** — content outside `x/y/width/height` is cut. A too-small §4.5 margin crops shadows (Pitfall 17) |
| R22 | `filter` + `mask` + `opacity` + `mix-blend-mode` on nested groups | combine correctly in one render |
| R23 | `viewBox` with a negative origin | applied correctly |
| R24 | `NaN` in an attribute | **no error** — the element is silently dropped (Pitfall 7) |
| R25 | malformed markup | throws a plain `Error`, e.g. `SVG data parsing failed cause invalid attribute at 1:5` |
| R26 | an SVG with no drawable content | renders an empty image of the declared size (no error) |
| R27 | unknown option keys (e.g. `logLevel`) | accepted and ignored |
| R28 | `getBBox()` | returns the exact geometry bbox (a 30×40 rect at (10,20) → `10,20,30,40`) — usable as an independent check on §4.5 in tester level 2 |
| R29 | `stroke-dasharray` | honoured (only needed by the §4.14 fallbacks) |
| R30 | performance | 4096×4096 flat fill in 98 ms; 20 000 `<path>` elements (886 KB of SVG) at 2× in 139 ms. **Rasterization is not the bottleneck — the exporter is.** |
| R31 | memory | 300 renders: RSS 74→98 MB with `free()`, 98→103 MB without. Bounded either way; `free()` is hygiene |

Two consequences worth stating plainly:

1. **Every SVG construct this plan relies on is supported.** There is no feature in §4 that
   resvg cannot draw, so a level-3 failure means our SVG is wrong — never that the renderer
   fell short. The one exception is Figma's `<foreignObject>` background blur, which resvg
   ignores; that is why §9.4 annotates the ceiling rather than counting it against us.
2. **Two of resvg's failure modes are silent** (R11 `fill-rule` in a clip, R24 `NaN`). Both are
   caught by construction: emit `clip-rule`, and make `fmt()` throw.

### E.1 Reproducing this table

The probe scripts are not part of the repository. To re-measure after a version bump, render
small SVGs and inspect pixels directly:

```js
const mod = await import('@resvg/resvg-wasm');
await mod.initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
const img = new mod.Resvg(svgString, { fitTo: { mode: 'zoom', value: 2 } }).render();
// img.pixels is PREMULTIPLIED RGBA; index a pixel as (y * img.width + x) * 4
```

A 2×2 test PNG for image cases can be built with `node:zlib` alone (IHDR + deflated scanlines
+ IEND, colour type 6); no image library is needed.
