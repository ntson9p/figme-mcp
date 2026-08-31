# SOLUTION: How to read a local Figma `.fig` file — correctly and fully

> **Audience**: an AI agent (or engineer) implementing a `.fig` reader from scratch, with no prior
> context. Follow this document top to bottom. Every byte-level claim here has been verified on
> `figma-input/sample.fig` (38,860,863 bytes, format version 106, 116,142 nodes) and
> cross-validated field-by-field against the official `kiwi-schema` package with **zero
> differences**. A known-good, dependency-free reference implementation of Steps 1–8 exists at
> [`tools/fig2json.mjs`](../tools/fig2json.mjs) — when in doubt, diff your behavior against it.
>
> Naming: Figma's "Save local copy…" produces files with the `.fig` extension. This document
> treats ".figma file" and ".fig file" as the same thing. Everything below is **pure local byte
> reading** — no Figma API, service, or network access is used or needed.

---

## 0. Mental model (read this first)

A `.fig` file is a **self-describing** container. Reading it is a fixed 4-stage pipeline:

```
.fig bytes
  └─ Stage A: container      → ZIP? unwrap to get `canvas.fig` stream (+ images, meta, thumbnail)
  └─ Stage B: chunk framing  → "fig-kiwi" magic, version, length-prefixed chunks
  └─ Stage C: decompression  → per-chunk codec sniffed by magic bytes (zstd / deflate / stored)
  └─ Stage D: Kiwi decode    → chunk[0] = binary SCHEMA, chunk[1] = DATA decoded USING that schema
```

The single most important rule: **the schema ships inside the file** (chunk 0). Decode it first,
then decode the data with it. Never hardcode field IDs or a schema snapshot — that is what makes
readers survive Figma's unannounced format changes (fields are added constantly; the mechanism is
stable). Kiwi is the serialization format published by Figma's co-founder Evan Wallace:
https://github.com/evanw/kiwi.

The decoded result is one `Message` object: a **flat array** of `nodeChanges` (every layer in the
document) plus a `blobs` array (bulky binary payloads). You then rebuild the layer tree from
parent references (Stage E, §8).

---

## 1. Stage A — Container detection and ZIP unwrapping

Sniff the **first 4 bytes**. Never trust the file extension.

| First bytes | Meaning |
|---|---|
| `50 4B 03 04` (`PK\x03\x04`) | ZIP archive (the modern default) |
| `66 69 67 2D 6B 69 77 69` (`fig-kiwi`) | bare stream — skip to §2 |
| anything else | not a readable `.fig`; fail loudly, include a hex dump of the first 16 bytes |

### ZIP layout (verified)

```
canvas.fig            REQUIRED — the fig-kiwi stream (Stage B input)
meta.json             file_name, exported_at, thumbnail size, background color
thumbnail.png         document preview bitmap
images/<40-hex-chars> one file per bitmap used by image fills; filename = SHA-1 hex of content
```

### ZIP reading rules (these bite people)

1. **Read via the central directory, not local headers.** Figma writes entries with the
   data-descriptor flag (general-purpose bit 3): local headers contain **zeros** for CRC and
   sizes. The real sizes live in the central directory at the end of the file.
2. Algorithm: scan the last ≤65,558 bytes backwards for the end-of-central-directory signature
   `50 4B 05 06`; read entry count (u16 at EOCD+10) and central-directory offset (u32 at
   EOCD+16); walk entries (signature `50 4B 01 02`), taking per entry: compression method
   (u16 @+10), compressed size (u32 @+20), name length (u16 @+28), extra length (u16 @+30),
   comment length (u16 @+32), local-header offset (u32 @+42), name (bytes @+46). To find the
   data: go to the local header and skip `30 + itsNameLen(u16 @+26) + itsExtraLen(u16 @+28)`
   bytes — **use the local header's own name/extra lengths**, they can differ from the central
   ones (the extra fields do differ in practice).
3. Entry compression: method 0 = stored (use bytes as-is), method 8 = raw DEFLATE
   (`inflateRaw` / `wbits=-15`). In the sample, `canvas.fig`, `thumbnail.png` and all images are
   stored; `meta.json` is deflated.
4. All integers little-endian. Any standard ZIP library also works (Python `zipfile`, etc.).

## 2. Stage B — The `fig-kiwi` stream

```
offset 0   magic   8 bytes  ASCII "fig-kiwi"        (hard-fail if absent)
offset 8   version u32 LE                            (106 in the sample; log it, don't gate on it)
offset 12  chunks  repeat until EOF:
             u32 LE  byteLength
             bytes[byteLength]
```

Validate: the chunk walk must land **exactly** on EOF — no trailing garbage, no overrun
(verified: 6,997,936 bytes consumed exactly). Require ≥ 2 chunks:

- `chunk[0]` — the Kiwi **binary schema** (compressed)
- `chunk[1]` — the Kiwi-encoded **`Message`** (compressed)
- further chunks may exist in other files; preserve/ignore them, don't fail.

## 3. Stage C — Per-chunk decompression (sniff, never assume)

Apply to each chunk independently — codecs **differ between chunks in the same file**:

```
if bytes[0..4] == 28 B5 2F FD  → Zstandard          (u32 LE 0xFD2FB528)
else try raw DEFLATE (wbits = -15)
else try zlib      (wbits = 15)
else                            → treat as stored (uncompressed)
```

Verified on the sample: chunk 0 is raw-deflate (29,408 → 73,430 bytes); chunk 1 is **zstd**
(6,968,508 → 63,385,564 bytes). Older files use deflate for both — the deflate→zstd move is a
format change Figma already shipped, silently; sniffing absorbs it. If all branches fail, fail
loudly **with the first 4 bytes hex** so a future new codec is a one-line diagnosis.

Node.js note: `node:zlib` has `zstdDecompressSync` since v22.15/v23.8 — no dependency needed.
Python needs the `zstandard` package (or stdlib `compression.zstd` on 3.14+).

## 4. Stage D part 1 — Kiwi primitive decoders

Implement a byte reader with a cursor and these primitives. **Get these exactly right; every
later step depends on them.** (Reference: `tools/fig2json.mjs`, class `BB`.)

```js
byte()      // u8, advance 1
bytes(n)    // raw n bytes, advance n

varUint()   // unsigned LEB128, low 7 bits per byte, continuation bit 0x80, max 5 bytes:
            //   value=0; shift=0;
            //   do { b=byte(); value |= (b & 127) << shift; shift += 7; } while (b & 128 && shift < 35)
            //   return value >>> 0   (unsigned 32-bit)

varInt()    // zigzag over varUint:
            //   v = varUint() as int32;  return (v & 1) ? ~(v >>> 1) : (v >>> 1)

varUint64() // like varUint but up to 9 bytes; the 9th byte (shift 56) contributes ALL 8 bits:
            //   value=0n; shift=0n;
            //   loop { b=byte();
            //          if (shift == 56n) { value |= BigInt(b) << 56n; break; }
            //          value |= BigInt(b & 127) << shift;
            //          if (!(b & 128)) break;  shift += 7n; }

varInt64()  // zigzag over varUint64: (v & 1n) ? ~(v >> 1n) : (v >> 1n)

varFloat()  // Kiwi's float32 encoding:
            //   first = byte(); if (first == 0) return 0.0;      // 0.0 is a single 0x00 byte
            //   read 3 more bytes; bits = first | b2<<8 | b3<<16 | b4<<24   (little-endian)
            //   bits = (bits << 23) | (bits >>> 9)               // rotate exponent back in place
            //   reinterpret bits as IEEE-754 float32 (little-endian)

string()    // UTF-8 bytes up to (not including) the next 0x00; advance past the NUL
```

Notes: values decode as **float32** (expect `0.20000000298023224`-style values — that IS
correct); `varFloat`'s rotation exists because Figma stores the exponent byte first for better
compression. All of this matches `github.com/evanw/kiwi` exactly.

## 5. Stage D part 2 — Decode the binary schema (chunk 0, decompressed)

```
varuint definitionCount                      // sample: 638
repeat definitionCount times:
  string  name                               // e.g. "NodeChange", "NodeType", "Paint"
  byte    kind                               // 0 = ENUM, 1 = STRUCT, 2 = MESSAGE
  varuint fieldCount
  repeat fieldCount times:
    string  fieldName
    varint  type          // >= 0  → index into the definitions array (forward refs are normal)
                          // <  0  → builtin, index = ~type (bitwise NOT):
                          //   0 bool, 1 byte, 2 int, 3 uint, 4 float, 5 string, 6 int64, 7 uint64
    byte    isArrayFlag   // bit 0 set → field is an array of `type`
    varuint value         // MESSAGE: the field id (wire tag). ENUM: the enum's numeric value.
                          // STRUCT: ignore.
```

Validate: cursor lands exactly at end of buffer. Build two lookups: definitions by index, and
per-definition a map `fieldId → field`. The sample yields 398 messages, 30 structs, 210 enums.

## 6. Stage D part 3 — Decode the data (chunk 1, decompressed)

Decode the buffer as the definition named **`Message`** (kind MESSAGE). Recursive rules:

- **MESSAGE**: loop — `tag = varUint()`; `tag == 0` → done, return object; else look up the
  field with `value == tag` in this definition and decode its value into `obj[fieldName]`.
  Unknown tag = corrupt decode → throw (cannot happen with the same-file schema; if it happens,
  your primitives are wrong).
- **STRUCT**: decode **every** field, in schema order, no tags, no terminator.
- **ENUM**: `varUint()`, map through the enum definition's `value → name`. Tolerate unknown
  values by returning the raw number (do not throw).
- **Field value by type**: builtin → the §4 primitive; definition-typed → recurse.
- **Arrays**: `count = varUint()` then `count` elements — **EXCEPT `byte[]`**, which is
  `byteLength = varUint()` followed by that many **raw bytes** (return as a byte buffer; in JS
  prefer plain `Uint8Array`, see §11 pitfall 1).

Validate: the cursor must land **exactly** at the end of the decoded buffer (verified: all
63,385,564 bytes consumed). That single check is a near-proof of a correct implementation — a
wrong primitive desynchronizes the stream within a few fields.

## 7. Validation invariants (assert all of these after every parse)

1. Chunk framing consumes the stream exactly (§2). Schema decode consumes chunk 0 exactly (§5).
   Data decode consumes chunk 1 exactly (§6).
2. `message.type === "NODE_CHANGES"`.
3. Exactly one node with `type === "DOCUMENT"`; after tree-build (§8), zero orphans.
4. Every `paint.image.hash` (hex-encoded) resolves to an `images/<hex>` ZIP entry
   (sample: 212/212).
5. Log (don't gate): header version, schema definition count, node count.

## 8. Stage E — Rebuild the layer tree

`message.nodeChanges` is flat. Each node has:

- `guid: { sessionID: uint, localID: uint }` — identity. Use the string `"S:L"` as map key.
- `parentIndex: { guid: <parent GUID>, position: string }` — parent link + sibling order.

Algorithm: index all nodes by guid-key → attach each node to its parent's child list → the node
with `type === "DOCUMENT"` (no resolvable parent) is the root → sort every child list by
**plain lexicographic (code-unit) comparison of `position`** (it's a fractional-index string;
do NOT compare numerically, do NOT locale-compare). Hierarchy: DOCUMENT → CANVAS (= pages) →
frames/layers.

## 9. Semantic reference — where each kind of design information lives

Everything below was verified against the sample's schema dump and decoded data unless marked
*(community interpretation)*. Field names come from the file's own schema; dump yours with the
reference parser (`schema.kiwi.txt`) whenever you need a field this list doesn't cover — the
schema is the authoritative, always-current documentation.

### 9.1 Top level: `Message`

Keys observed: `type` (`NODE_CHANGES`), `sessionID`, `ackID`, `originFileKey`,
`nodeChangeOrder`, `nodeChanges: NodeChange[]`, `blobs: Blob[]` (`Blob = { bytes: byte[] }`).
A saved file is a full snapshot, not a delta.

### 9.2 `NodeChange` essentials (field ids in parentheses)

`guid`(1), `phase`(2, `CREATED`), `parentIndex`(3), `type`(4), `name`(5), plus ~300 optional
fields — only set fields appear. Node `type` values observed in the sample: DOCUMENT, CANVAS,
FRAME, GROUP, VECTOR, TEXT, RECTANGLE, ROUNDED_RECTANGLE, ELLIPSE, LINE, BOOLEAN_OPERATION,
SYMBOL (component definition), INSTANCE (component instance), SECTION, WIDGET, SHAPE_WITH_TEXT,
CONNECTOR, BRUSH, VARIABLE, VARIABLE_SET. Also in the enum: STAR, GROUP, STICKY, TABLE, etc.

### 9.3 Geometry

- `size: { x, y }` — width/height.
- `transform: { m00, m01, m02, m10, m11, m12 }` — 2×3 affine matrix **relative to the parent**;
  translation is `m02` (x), `m12` (y). Absolute position = compose transforms down the tree.
- `visible`, `opacity`, `locked`, `mask`, `cornerRadius`, per-corner
  `rectangleTopLeftCornerRadius` etc., `horizontalConstraint`/`verticalConstraint`.

### 9.4 Fills, strokes, effects

- `fillPaints: Paint[]`, `strokePaints: Paint[]`. `Paint` fields (verified): `type`
  (SOLID/GRADIENT_LINEAR/GRADIENT_RADIAL/…/IMAGE), `color {r,g,b,a}` (floats 0–1), `opacity`,
  `visible`, `blendMode`, `stops: ColorStop[]`, `transform` (gradient geometry), `image`
  (`{ hash: byte[20], name }` — hex of hash = filename under `images/`), `imageScaleMode`,
  `scale`, `rotation`, `originalImageWidth/Height`, and variable bindings `colorVar`,
  `opacityVar`, `imageVar` (see 9.8).
- `strokeWeight`, `strokeAlign`, `strokeCap`, `strokeJoin`, `dashPattern`.
- `effects: Effect[]` (verified fields): `type` (EffectType: shadows/blurs), `color`, `offset
  {x,y}`, `radius`, `spread`, `visible`, `blendMode`, `showShadowBehindNode`, plus `*Var`
  variable bindings.
- Shared styles: nodes reference library styles via `styleIdForFill`, `styleIdForText`, … each
  `{ assetRef: { key, version } }` (opaque catalog keys; expose as-is).

### 9.5 Auto-layout (verified field names)

On the container: `stackMode` (HORIZONTAL/VERTICAL), `stackSpacing`,
`stackHorizontalPadding`, `stackVerticalPadding` (asymmetric right/bottom live in
`stackPaddingRight`/`stackPaddingBottom` when present), `stackPrimaryAlignItems`,
`stackCounterAlignItems`, `stackJustify`, `stackAlign`, `stackWrap`(323),
`stackPrimarySizing`(229, hug/fixed).
On children: `stackChildPrimaryGrow`(232), `stackChildAlignSelf`(236),
`stackChildMarginTop/Right/Bottom/Left`(606–609), `stackPositioning` (absolute-in-auto-layout).

### 9.6 Text — content and rich-text runs (empirically verified)

- Plain content: `textData.characters` (UTF-8 string).
- Node-level typography: `fontName { family, style, postscript }`, `fontSize`, `lineHeight
  { value, units }`, `letterSpacing`, `paragraphSpacing`, `textAlignHorizontal/Vertical`,
  `textCase`, `textDecoration`, `fillPaints` (text color).
- **Styled runs**: `textData.characterStyleIDs: uint[]` has one entry **per UTF-16 code unit**
  of `characters` (verified: "Yesterday 9:41" → 14 units → 14 ids `12,12,…,10,9,10,10,10`).
  Each id selects an entry in `textData.styleOverrideTable: NodeChange[]`, where each entry is a
  **partial NodeChange** carrying `styleID`(49) plus only the overridden fields (`fontSize`,
  `fontName`, `fillPaints`, `styleIdForText`, …). Characters whose id is 0, or beyond the end of
  a shorter `characterStyleIDs` array, use the node's base style *(community interpretation for
  the 0/absent case; the table mechanism itself is verified)*.
- Derived layout (`textData.lines`, glyphs, baselines) may reference blobs; treat as optional
  derived data — content + styles above are sufficient for reading.

### 9.7 Components (SYMBOL) and instances (INSTANCE)

- SYMBOL = the component definition; normal children; `symbolDescription`(144),
  `componentPropDefs`(266): `{ id: GUID, name, type, initialValue, sortPosition }`.
- INSTANCE: `symbolData.symbolID: GUID` → the SYMBOL node. `symbolData.symbolOverrides[]`:
  each `{ guidPath: { guids: GUID[] }, ...overridden fields }` — the guidPath addresses the
  descendant **inside the component** being overridden (nested instances → multiple guids).
  `componentPropAssignments`(268): `{ defID: GUID, value | varValue }`.
  `derivedSymbolData`(125): precomputed effective children *(useful shortcut; can be treated as
  a cache of override application)*.
- Component sets: SYMBOLs whose parent is a `FRAME` with `isStateGroup`; variant properties are
  encoded in symbol names (`prop=value, prop=value`) *(community interpretation)*.

### 9.8 Variables (Figma Variables, verified)

- `VARIABLE_SET` nodes: the collection; `variableSetModes` / `VariableSetMode
  { id: GUID, name, sortPosition }`.
- `VARIABLE` nodes: `variableData { value: VariableAnyValue, dataType, resolvedDataType }`,
  per-mode values in `variableDataValues` keyed by mode GUID.
- Consumption sites: `*Var` fields (`colorVar`, `radiusVar`, …) with
  `{ value: { alias: <variable ref> }, dataType: "ALIAS", resolvedDataType }`. Aliases may point
  at library variables via `assetRef { key, version }` (not resolvable offline — expose the ref).

### 9.9 Prototyping

`prototypeStartNodeID`(140), `prototypeInteractions[]`(226) (triggers/actions/transitions),
`transitionNodeID`, `overlay*` fields. Decode and expose raw; semantics follow Figma's
prototype model.

### 9.10 Vector geometry and blobs

`vectorData { vectorNetworkBlob: uint, normalizedSize, styleOverrideTable }` — the uint is an
**index into `message.blobs`**; the blob bytes encode the vector network (vertices, segments,
regions). Same pattern for `Path.commandsBlob`, glyph outlines, etc. Blob-internal layouts are a
separate decoding layer — a working open-source reference is
`src/figformat/vector_network.py` in https://github.com/sketch-hq/fig2sketch. For "read the
design" purposes you rarely need them; expose blob bytes on demand.

### 9.11 Bitmap images

`paint.image.hash` (20 bytes) → lowercase hex → ZIP entry `images/<hex>` (verified 212/212).
Bytes are the original PNG/JPEG/GIF/WebP — sniff content type by magic bytes. `.fig` files
contain **no rendered screenshots** of frames; only image fills and `thumbnail.png` exist.
Bare-stream files may carry image bytes elsewhere (e.g. appended chunks) — if a hash doesn't
resolve, report it as unavailable rather than failing.

## 10. Correctness checklist for a new implementation

1. §4 primitives byte-identical to kiwi (test `varFloat` on: `00` → 0.0; a known float32
   round-trip; negative values through `varInt` zigzag).
2. §5 schema decode of the sample yields exactly 638 definitions and consumes 73,430 bytes.
3. §6 data decode consumes 63,385,564 bytes exactly; 116,142 nodeChanges; 9,651 blobs.
4. Tree build: 10 pages; 0 orphans; page 1 named "Page 1".
5. Node `2:1339` ("Frame 39"): `stackMode:"HORIZONTAL"`, `stackSpacing:8`,
   `stackHorizontalPadding:16`, `cornerRadius:4`, size 134×40.
6. Node `2:1341` ("text"): characters `"Text"`, fontSize 16, Meiryo Regular,
   `transform.m02 = 40`, `m12 = 8`.
7. All referenced image hashes resolve into `images/` (212 unique in the sample).
8. Optional gold-standard: decode the same buffers with the `kiwi-schema` npm package
   (`compileSchema(decodeBinarySchema(schemaBuf)).decodeMessage(dataBuf)`) and deep-compare —
   the reference parser achieves **zero** differences across all nodes.

## 11. Pitfalls (each of these caused a real bug or is a known trap)

1. **Node.js `Buffer#toJSON`**: if `byte[]` decodes to `Buffer`, `JSON.stringify` converts it to
   `{type:"Buffer",data:[…]}` **before** your replacer runs. Return plain `Uint8Array`.
2. **Giant JSON**: `JSON.stringify` of the whole decoded message exceeds V8's max string length
   (~512MB) on real files. Serialize per-node (NDJSON) or stream.
3. **float32 noise**: `0.2` decodes as `0.20000000298023224`. Round only at presentation time.
4. **Sibling order**: `position` strings compare by raw code units. Numeric or locale-aware
   comparison scrambles layer order.
5. **UTF-16 vs code points**: `characterStyleIDs` aligns with UTF-16 units (JS `string.length`),
   not grapheme clusters or code points.
6. **Zero sizes in ZIP local headers** (§1) — use the central directory.
7. **Per-chunk codecs differ** (§3) — never decompress chunk 1 with chunk 0's codec.
8. **Optional fields**: MESSAGE-kind objects only contain fields that were set. `undefined`
   means "not set / inherit default", not zero.
9. **Unknown enum values**: return the raw number; new enum members appear over time.
10. **int64/uint64** decode to BigInt — JSON-serialize as strings.
11. **Version number**: informational only. Do not refuse to parse newer versions; the embedded
    schema is the compatibility mechanism (this doc's pipeline decodes version-106 files even
    though older community parsers claimed support only up to ~70).

## 12. Handling future format changes (policy)

- Change likelihood, lowest→highest: Kiwi wire format (stable since 2016) < chunk framing <
  compression codec (already changed once: deflate→zstd) < container (already changed once:
  bare→ZIP) < schema contents (changes constantly — **absorbed automatically** by §5/§6).
- Every sniff point must fail loudly with the observed magic bytes; that converts a future break
  into a 5-minute diagnosis.
- Keep mechanical decoding (Stages A–D, generic) strictly separate from semantic mapping (§9,
  Figma-specific); expose raw decoded nodes as an escape hatch so consumers degrade gracefully.
- Keep golden `.fig` files from multiple eras in the test suite; log header version + definition
  count on every parse to spot drift early.

## 13. External references (verified)

- Kiwi format + canonical implementation: https://github.com/evanw/kiwi (npm: `kiwi-schema`)
- Evan Wallace's own in-browser `.fig` parser: https://madebyevan.com/figma/fig-file-parser/
- Sketch's official importer (Python, MIT, same mechanics incl. zstd magic & `wbits=-15`):
  https://github.com/sketch-hq/fig2sketch — see `src/figformat/kiwi.py`,
  `src/figformat/decodefig.py`, `src/figformat/vector_network.py`
- Independent parsers: https://github.com/sunyui/figma-parser,
  https://github.com/Muggleee/fig-file-parser, https://github.com/OpenFig-org/openfig-core
- Evidence/measurement log for this repo: [`fig-file-format.md`](fig-file-format.md)
