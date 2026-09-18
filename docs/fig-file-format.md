# Reading local `.fig` files — format spec, evidence, and change-resilience strategy

Status: **proven working** on `figma-input/sample.fig` (38.8 MB, exported 2026-08-31, header
version 106) with the dependency-free reference parser [`tools/fig2json.mjs`](../tools/fig2json.mjs)
(Node ≥ 22.15, uses only `node:zlib`, `node:fs`). No Figma API, service, or network access involved —
the parse is pure local bytes.

---

## 1. The key insight: `.fig` is self-describing

A `.fig` file is **not** an opaque blob. It contains, in order:

1. a container (ZIP or bare stream),
2. a **Kiwi binary schema** — the complete field-by-field description of the data,
3. the document data, encoded per **that embedded schema**.

Kiwi (https://github.com/evanw/kiwi) is a Protocol-Buffers-like serialization format published
by Evan Wallace, Figma's co-founder; it is the same encoding Figma uses for its multiplayer
wire protocol. Because every file ships its own schema, a correct reader never hardcodes field
IDs — it decodes the schema first, then decodes the data with it. Figma adding/renaming fields
does not break such a reader.

## 2. Byte-level format (as verified on the test file)

### 2.1 Container

```
if first 4 bytes == 50 4B 03 04 ("PK\x03\x04"):   # ZIP archive (the modern default)
    canvas.fig        -> the fig-kiwi stream (stored uncompressed in our sample)
    meta.json         -> {"client_meta":{...}, "file_name":"...", "exported_at":"..."}
    thumbnail.png     -> file preview
    images/<40-hex>   -> one file per image fill, filename = SHA-1 hex of content
else:                                              # older exports: bare stream
    the file itself is the fig-kiwi stream
```

Verified: our sample ZIP holds `canvas.fig`, `meta.json`, `thumbnail.png`, and 252 files under
`images/`. All 212 image hashes referenced by paints in the document resolved to
`images/<hash-hex>` entries — a 212/212 match.

### 2.2 The `fig-kiwi` stream

```
offset 0   : magic "fig-kiwi" (8 bytes, ASCII)
offset 8   : u32 LE writer version        (106 in our sample)
offset 12  : repeated chunks until EOF:
               u32 LE chunkByteLength
               chunk bytes
chunk[0]   : Kiwi binary schema, compressed
chunk[1]   : Kiwi-encoded `Message`, compressed
```

Verified: chunk framing consumed the sample's 6,997,936-byte stream **exactly** (no gap, no
overrun).

### 2.3 Per-chunk compression — sniff, don't assume

| magic | codec |
|---|---|
| `28 B5 2F FD` (u32 LE `0xFD2FB528`) | Zstandard |
| otherwise | try raw deflate (`wbits=-15`), then zlib, then treat as stored |

Verified: in our sample **chunk 0 is raw-deflate** (29,408 → 73,430 bytes) while **chunk 1 is
zstd** (6,968,508 → 63,385,564 bytes). Older files use deflate for both — this codec change is
the one format break Figma has already shipped, and byte-sniffing absorbs it. Node ≥ 22.15/23.8
has `zlib.zstdDecompressSync` built in.

### 2.4 Kiwi binary schema (chunk 0, decompressed)

```
varuint definitionCount                     # 638 in our sample
repeat:
  string  name                              # UTF-8, NUL-terminated
  byte    kind                              # 0=ENUM 1=STRUCT 2=MESSAGE
  varuint fieldCount
  repeat:
    string  fieldName
    varint  type                            # >=0: index into definitions; <0: builtin via ~type:
                                            #   0 bool, 1 byte, 2 int, 3 uint, 4 float,
                                            #   5 string, 6 int64, 7 uint64
    byte    isArrayFlag                     # bit 0
    varuint value                           # field id (MESSAGE) / enum value (ENUM)
```

### 2.5 Kiwi data encoding (chunk 1, decompressed; root type = `Message`)

- **MESSAGE**: repeated `(varuint fieldId, value)` pairs, terminated by fieldId `0`.
- **STRUCT**: all fields, in schema order, no ids, no terminator.
- **ENUM**: varuint, mapped through the enum definition's values.
- Scalars: `bool`/`byte` = 1 byte; `uint` = varuint (LEB128, ≤5 bytes); `int` = zigzag varuint;
  `uint64`/`int64` = ≤9-byte variant (9th byte carries 8 bits); `string` = UTF-8 + NUL;
  `float` = 1 byte `0x00` for 0.0, else 4 bytes with the float32 bits rotated
  (`bits = (raw << 23) | (raw >>> 9)`) so the exponent leads.
- Arrays: varuint count + elements — **except `byte[]`**, which is varuint byteLength + raw bytes.

Verified: decoding the sample's 63,385,564-byte data chunk against the embedded schema consumed
it **to the exact last byte**, and a field-by-field structural comparison against the official
`kiwi-schema` npm package (Evan Wallace's own implementation) found **zero differences across
all 116,142 nodes**.

## 3. Semantic model (what the decoded `Message` means)

Top-level keys observed: `type`, `sessionID`, `ackID`, `originFileKey`, `nodeChangeOrder`,
`nodeChanges`, `blobs`. A saved file is one `NODE_CHANGES` message: the full scene graph as a
**flat list** of `NodeChange` records plus a `blobs` array.

- **Identity**: `guid = {sessionID, localID}`.
- **Tree**: each node's `parentIndex = {guid, position}`; rebuild by grouping on parent guid and
  sorting siblings by plain lexicographic compare of the `position` string (fractional indexing).
  Root is the single `type: "DOCUMENT"` node; its children are `CANVAS` nodes (= pages).
  Verified: 116,142 nodes → 0 orphans, 10 pages.
- **Node types observed**: DOCUMENT, CANVAS, FRAME, GROUP, VECTOR, TEXT, RECTANGLE,
  ROUNDED_RECTANGLE, ELLIPSE, LINE, BOOLEAN_OPERATION, SYMBOL (= component),
  INSTANCE (= component instance), SECTION, WIDGET, SHAPE_WITH_TEXT, CONNECTOR, BRUSH,
  VARIABLE, VARIABLE_SET (= Figma Variables).
- **Geometry**: `size {x,y}`, `transform {m00,m01,m02,m10,m11,m12}` (2×3 matrix, translation in
  m02/m12, relative to parent).
- **Styling**: `fillPaints[]`, `strokePaints[]` (`SOLID` color rgba / `IMAGE` with `image.hash`
  bytes / gradients), `strokeWeight`, `cornerRadius`, `effects[]`, `opacity`, `blendMode`;
  variable bindings appear as `colorVar.value.alias`.
- **Auto-layout**: `stackMode` (HORIZONTAL/VERTICAL), `stackSpacing`,
  `stackHorizontalPadding`/`stackVerticalPadding`, `stackPrimaryAlignItems`,
  `stackCounterAlignItems`, sizing modes.
- **Text**: `textData.characters` (plain string), `fontName {family, style, postscript}`,
  `fontSize`, `lineHeight`, `textAlignHorizontal/Vertical`; rich-text runs via
  `textData.characterStyleIDs` + `textData.styleOverrideTable`.
- **Components**: `INSTANCE.symbolData.symbolID` points at the SYMBOL's guid;
  `symbolOverrides[]` carry per-descendant overrides addressed by `guidPath`.
- **Images**: `paint.image.hash` (20 bytes) → hex → `images/<hex>` in the ZIP.
- **Blobs**: `message.blobs[i].bytes` hold bulky payloads (vector networks, style tables);
  node fields reference them by index (e.g. `vectorData.vectorNetworkBlob`). Decoding blob
  internals is a separate layer — see `src/figformat/vector_network.py` in
  https://github.com/sketch-hq/fig2sketch for a working reference.

`tools/fig2json.mjs` emits: `schema.kiwi.txt` (the file's own schema, readable),
`nodes.ndjson` (every node, one JSON per line), `tree-outline.txt` (indented page/layer
hierarchy), `meta.json`.

## 4. Evidence trail (external, independently verified)

1. **Kiwi format** — https://github.com/evanw/kiwi: "a schema-based binary format for
   efficiently encoding trees of data… inspired by Google's Protocol Buffer format". Author
   Evan Wallace (https://madebyevan.com: "I'm one of the cofounders of Figma"). npm package:
   `kiwi-schema`.
2. **Evan Wallace's own public .fig parser** — https://madebyevan.com/figma/fig-file-parser/
   (drag-and-drop a `.fig`, parsed in the browser). His caveat, verbatim: the format is "an
   unstable internal implementation detail of Figma, so this parser may stop working at some
   point for new Figma files if Figma changes their file format."
3. **Sketch's official importer** — https://github.com/sketch-hq/fig2sketch (MIT): reads `.fig`
   directly, no API. Its `src/figformat/kiwi.py` contains the same mechanics proven here:
   `ZSTD_MAGIC_NUMBER = b"\x28\xb5\x2f\xfd"`, `zlib.decompress(compressedSchema, wbits=-15)`,
   header version at bytes 8–12, `KiwiDecoder(schema, …).decode(data, "Message")`.
4. **Independent parsers** — https://github.com/sunyui/figma-parser (checks the literal
   `'fig-kiwi'` prelude; falls back to `fzstd` for newer data chunks),
   https://github.com/Muggleee/fig-file-parser (uses `kiwi-schema`),
   https://github.com/OpenFig-org/openfig-core (documents the layout
   `[prelude 8B][version u32 LE][len+chunk…]`).
5. **No official spec exists.** Figma's help pages list `.fig` as importable but never document
   the format; the strongest statement on stability is Evan Wallace's caveat above.

## 5. Dealing with future format changes

The format has already changed at least twice without notice (bare stream → ZIP container;
deflate → zstd data chunk; header version 15→52→70→106 across the ecosystem's samples). The
strategy that survives this:

1. **Never hardcode the schema.** Always decode chunk 0 from the file at hand and drive the data
   decode from it. New/renamed/reordered fields then cost nothing. (This is why our parser
   decodes a version-106 file even though fig2sketch's pure-Python path only claims ≤70: the
   mechanism, not a field table, is the contract.)
2. **Sniff every layer by magic bytes**, never by extension or version: `PK\x03\x04` → ZIP;
   `fig-kiwi` → stream; `28 B5 2F FD` → zstd; else deflate-raw → zlib → stored. A new codec
   (the realistic future break) then fails *loudly at one small function* with the unknown
   magic in the error — a one-line fix, not an architecture change.
3. **Split mechanical decode from semantic mapping.** Layer 1 (container→chunks→schema→raw
   message) is generic Kiwi and near-immune to change. Layer 2 (what `stackSpacing` *means*)
   is community knowledge; keep it a thin, versioned mapping over the raw decode, and always
   expose the raw decoded node as a fallback so the MCP degrades gracefully instead of lying.
4. **Assert the invariants that catch silent drift**: exact chunk framing to EOF, exact
   consumption of the decoded data buffer, `type === "NODE_CHANGES"`, single DOCUMENT root,
   zero orphans, image hashes resolving into `images/`. Log the header version and schema
   definition count on every parse.
5. **Golden-file regression suite**: keep `.fig` samples from different eras (this repo's
   sample is a version-106 file; add older ones as encountered) and re-export a fresh file
   periodically; CI parses all of them.
6. **Economic backstop**: Figma's own desktop/web clients must open every old `.fig`, and
   third parties (Sketch, and Figma's own `.fig` import) depend on the format — wholesale
   incompatible rewrites are strongly disincentivized; changes have historically been additive
   (new fields, new codec) and the self-describing design absorbed them.

## 6. Implications for the MCP server

- Parse once per file (this 38 MB / 116k-node file decodes in a few seconds), cache the tree,
  serve queries: `get_pages`, `get_node_tree(guid, depth)`, `get_node(guid)` (full raw fields),
  `find_nodes(type/name/text)`, `get_text_content`, `get_images(node)` (bytes from ZIP),
  `get_components/get_instances`, `get_variables`.
- Return **shallow trees with guids + on-demand deepening** — 116k nodes will not fit an agent
  context; fractional-index-sorted children with counts do.
- TypeScript/Node is the natural stack (canonical Kiwi implementation, zstd in stdlib); either
  vendor `tools/fig2json.mjs`'s decoder or depend on `kiwi-schema` (both proven equivalent here).

## 7. Addendum — measured while building the MCP server (2026-08-31)

Four addressing details that the sections above do not cover. All were verified on
`figma-input/sample.fig` and are exercised by the golden tests in `test/golden/`.

### 7.1 Shared styles are ordinary nodes carrying a publishable `key`

A style definition is **not** a separate record type. It is a normal, hidden node parked on a
canvas whose `key` field holds the 40-hex asset key that `styleIdFor*.assetRef.key` points at:

- a **text style** is a `TEXT` node holding the typography (e.g. `2:1322` "Meiryo/Regular/16"),
- a **fill / colour style** is a `ROUNDED_RECTANGLE` node holding the paint
  (e.g. `2:7073` "Label Color/Light/Secondary").

Keyed nodes in the sample: 414 total — `VARIABLE` 272, `ROUNDED_RECTANGLE` 103, `TEXT` 51,
`VARIABLE_SET` 26, `BRUSH` 25. So a style used from the *same* file resolves to a real node and
therefore to real values; only styles published from another library stay opaque.

### 7.2 Instance override paths address descendants by override identity: `overrideKey`, else `guid`

`symbolData.symbolOverrides[].guidPath.guids` (and the same field on `derivedSymbolData`) holds
a node's **`overrideKey`** when the node has one, and its plain **`guid`** otherwise. A node
created by copying a component — a library import, a duplicate — keeps the original's key in
`overrideKey`; a node created in place carries no such field. In the sample 8,893 of 10,480
symbol descendants have an explicit key and 30,061 of the 303,833 records address a node by
guid. (The first version of this note, written 2026-08-31, said the guid case did not exist; a
renderer built on it silently dropped every override of every component created in the file
itself. Corrected 2026-09-18.) Keys are not unique: every duplicate of a component repeats its
component's keys (10,786 nodes, 7,860 distinct keys), so resolution must prefer the candidate
that lies inside the symbol the instance actually points at; a guid is unique by construction.

Examples: instance `2:1329` → symbol `2:1325`, path `["0:2528"]` → the node whose `overrideKey` is
`0:2528` **within** `2:1325`'s subtree, i.e. `2:1325` itself. Instance `863:171090` → symbol
`2:251108`, path `["2:251114"]` → the TEXT node `2:251114`, which has no `overrideKey`.

A multi-segment path is walked one instance level at a time, and a segment that lands on a
nested INSTANCE continues inside the symbol that instance *resolves to* — after the enclosing
level's records and property assignments, which may have swapped it (§8.6). Walking the
original symbol instead leaves 15,858 records unresolved; walking the swapped one leaves 74.

### 7.3 Component-set properties live on the set, not on the variants

A component set is a `FRAME` with `isStateGroup: true`, and it carries the named
`componentPropDefs` (including the `VARIANT` properties). Each variant member `SYMBOL` repeats
the same property **ids** with no `name` and no `type`. In the sample: 1,044 named definitions
(188 on SYMBOLs, 856 on state-group FRAMEs) versus 3,745 unnamed placeholder entries. Resolving
`componentPropAssignments[].defID` therefore needs a file-wide map in which named entries win.

### 7.4 Variables link to their collection by `assetRef`, not by parent

`VARIABLE.variableSetID` is a `{ guid, assetRef }` pair, and in practice only the `assetRef.key`
is populated; it must be matched against a `VARIABLE_SET` node's own `key`. The tree parent is
no help: in the sample every `VARIABLE` and `VARIABLE_SET` node hangs off the same container
(`0:2`), not off its collection. Grouping the sample's 273 variables this way partitions them
exactly across the 27 collections.

Per-mode values live in `variableDataValues.entries[] = { modeID, variableData }`, where
`modeID` matches a `variableSetModes[].id` on the collection. Alias values
(`variableData.value.alias`) may chain through several local variables before reaching a
concrete one, so resolution needs a depth guard.

---

## 8. Addendum — the render data (measured 2026-09-02, while building `fig_render`)

Everything needed to draw a `.fig` is already in the file: Figma flattens its scene graph at
save time. These are the encodings that matters, all verified on `figma-input/sample.fig` and
exercised by `test/golden/render.test.ts`.

### 8.1 Path command blobs

`Path { windingRule, commandsBlob, styleID }` — `commandsBlob` indexes `message.blobs`, whose
`bytes` hold a flat command list: one opcode byte, then little-endian `float32` arguments.

| opcode | command | floats |
|---|---|---|
| 0 | close | 0 |
| 1 | moveTo | 2 (x y) |
| 2 | lineTo | 2 (x y) |
| 3 | quadTo | 4 (cx cy x y) |
| 4 | cubicTo | 6 (c1x c1y c2x c2y x y) |

Coordinates are **node-local pixels**. Verified on all 7 292 non-empty blobs referenced by
`fillGeometry`, `strokeGeometry` or glyph outlines: zero failures, one empty blob (a zero-height
line, meaning "no fill area"). `vectorData.vectorNetworkBlob` is a **different** format and does
not decode under this grammar — 605 of the 607 referenced network blobs fail immediately, as
expected.

### 8.2 Stroke geometry is outlined but NOT clipped to its alignment

`strokeGeometry` bakes in weight, caps and joins — but not `strokeAlign`. For `INSIDE` and
`OUTSIDE` the stored path is a band of **double** the stroke weight straddling the shape edge,
which Figma clips at render time; only `CENTER` geometry is final. Measured over every node with
a single uniform-weight stroke, the overshoot beyond the node box is exactly:

| strokeAlign | overshoot / weight | nodes |
|---|---|---|
| INSIDE | 1.00 | 8 930 |
| OUTSIDE | 1.00 | 125 |
| CENTER | 0.50 | 2 737 |

`StrokeAlign { CENTER=0, INSIDE=1, OUTSIDE=2, OFFSET=3 }`, so an absent field means CENTER.
A renderer must intersect an INSIDE band with the fill shape and subtract the fill shape from an
OUTSIDE one; drawing the band raw paints a double-width border that bleeds outside the node.

### 8.3 Glyph outlines: em units, y-up, and a leading `close`

`derivedTextData.glyphs[]` gives every text node its own outlines, so no font file is needed.
The blob uses the §8.1 grammar but in **em units with y pointing up**, while `Glyph.position` is
the pen point on the baseline in node-local pixels with kerning already applied (`advance` must
not be used for placement). A glyph point (gx, gy) lands at:

```
X = position.x + gx · fontSize
Y = position.y − gy · fontSize
```

**4 287 of the 4 288 glyph blobs begin with opcode 0 (close)**, while none of the 4 617 fill or
stroke blobs do. SVG requires path data to start with a moveto, so that leading command must be
dropped; emitted verbatim it invalidates the path and a renderer discards it silently.

`decorations[] { rects: Rect[], styleID }` carries underlines and strikethroughs as node-local
pixel rectangles (`Rect { x, y, w, h }`).

### 8.4 Gradient transforms map the node box *to* gradient space

`Paint.transform` maps the node's normalized box (u = x/width, v = y/height) **to** gradient
space, where a linear gradient runs from (0, 0.5) to (1, 0.5) and a radial one is centred at
(0.5, 0.5) with radius 0.5. A renderer therefore needs the **inverse**, composed with
`scale(width, height)`. Figma's default top-to-bottom gradient is stored as
`m00≈0 m01=1 m02=0 m10=−1 m11≈0 m12=1`, whose inverse maps (0, 0.5) to the top centre and
(1, 0.5) to the bottom centre.

The same `transform` field is the image "crop" matrix on an `IMAGE` paint — there is no separate
`imageTransform` field. `originalImageWidth` / `originalImageHeight` give the intrinsic pixel
size directly.

### 8.5 Instances are empty; `derivedSymbolData` holds the resolved geometry

**All 38 164 INSTANCE nodes in the sample have zero children.** An instance's content is the
SYMBOL named by `symbolData.symbolID`, and two record sets on the instance supply the rest:

- `symbolData.symbolOverrides[]` — what the user changed (76 947 records; mostly `size`,
  `fillPaints`, auto-layout fields, `textData`, `fontSize`, `visible`).
- `derivedSymbolData[]` — what Figma recomputed as a result (226 886 records carrying resolved
  `size`, `transform`, `fillGeometry`, `strokeGeometry` and `derivedTextData`).

Both are addressed by `guidPath.guids`, a path of **override identities** (`overrideKey`, else
`guid`; see §7.2) that counts **instance-nesting levels, not node depth**: one segment addresses
a node anywhere inside this instance's own symbol (69 748 of the records), and `[a, b]`
addresses identity `b` inside the nested instance `a`. 1 232 of the 2 046 symbols contain
nested instances.

Consequence for any consumer: an instance's `size` is authoritative and usually differs from its
symbol's. Instance `2:1340` is 16×16 and points at a 22×22 symbol, so measuring an instance by
walking its symbol's children gives the wrong answer.

### 8.6 Component properties are assignments to evaluate, not records to read

An instance stores `componentPropAssignments[] { defID, value: { textValue | boolValue |
guidValue } }`; the symbol's descendants store `componentPropRefs[] { defID,
componentPropNodeField: VISIBLE | TEXT_DATA | OVERRIDDEN_SYMBOL_ID }` (2 178 nodes; the newer
`parameterConsumptionMap` repeats the same bindings on the same nodes). In the sample 14 373 of
38 164 instances assign something — 35 578 BOOLEAN, 14 051 TEXT and 2 029 INSTANCE_SWAP values.
**None of the 29 877 BOOLEAN=false assignments is mirrored by a `visible:false` record**: the
only way to know an icon is switched off is to find its `VISIBLE` binding and look the
assignment up. Without an assignment the symbol's own state is the default. A record may carry
`componentPropAssignments` for a nested instance (2 591 records), and 1 251 of those lists are
partial, so assignments must be merged per `defID`. A text assignment normally comes with a
derived record holding the new glyphs (11 907 of 12 584 direct bindings; the rest are nested
and served by the enclosing instance). A swap names the symbol by `guidValue`, or in a record by
`overriddenSymbolID` (1 677 records); 2 027 of the 2 029 swap targets are local symbols.

### 8.7 A style reference is live; the paints cached beside it are not

`styleIdForFill`, `styleIdForStrokeFill` and `styleIdForEffect` occur on nodes, on override
records and on `styleOverrideTable` entries, always next to a cached copy of the style's
value. The copy is what the node looked like when last touched: on 1 779 nodes and 1 064
records it disagrees with the local style it references (the version on the reference matches
the style's current version in 956 of the node cases, so this is not a stale library link), and
3 905 records plus 265 text-run entries carry the reference with no paints at all. Figma draws
the style. Measured on frame `863:171055`: the card icon is #333333 in Figma's export — the
"Black" style — while the override record caches #F18D00 with a variable alias; the time slots'
orange border exists only as `styleIdForStrokeFill` on the instance whose `strokePaints` still
say #D7D7D7. A detached style is written as the sentinel `{ guid: 4294967295:4294967295 }`, and
an instance whose root fill was detached carries its own paints with no reference at all (133).

### 8.8 The enclosing instance sizes nested instances; unpainted nodes get no new geometry

25 266 of the 40 855 nested instances with a derived `size` are resized by the instance that
contains them, 23 547 of them without a derived `fillGeometry`. Figma re-derives geometry only
for nodes that paint something: of 22 097 resized nodes with a visible fill or stroke, 18 lack
it. So a record that changes `size` without geometry leaves the base node's outline describing
the old size, and anything measured on the raw symbol tree — a mask region, a clip, a render
box — is the symbol's size. Frame `863:171055`'s grey panel `863:171102` is a 1052×503 instance
of a 1240×180 symbol whose colour swatch is a nested instance of a 32×32 symbol; every box on
the way is resized by a record.

### 8.9 Text truncation counts glyphs, and run styles live on the characters

`derivedTextData.truncationStartIndex` is an index into `glyphs`, not into `characters`: the
glyphs from that index on are the cut tail, and the glyph just before it — the only one with
no `firstCharacter` — is the ellipsis Figma inserted (920 of 920 truncated texts in the sample;
`truncatedHeight` is the height of what remains). A glyph's `styleID` is never set for a styled
run (12 576 of 12 576 such glyphs); the run of a glyph is `textData.characterStyleIDs[
firstCharacter]`, one entry per character with an implicit 0 past the end of the array (413
texts store a full array, 101 a shorter one, none a longer one).
