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
