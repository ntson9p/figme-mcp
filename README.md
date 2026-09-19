# figme — read local Figma `.fig` files from an AI agent

`figme` is an [MCP](https://modelcontextprotocol.io) server that lets an AI agent read
**everything inside a local `.fig` / `.figma` file** — document structure, geometry, fills,
strokes, effects, auto-layout, text (including mixed-format runs), components and instances,
variables, prototype links and embedded bitmaps.

It is **fully offline**. No Figma account, no access token, no REST API, no network at runtime.
It parses the file's own bytes, using the Kiwi schema that Figma ships *inside* every `.fig`.

It is also **token-aware**: the reference file used to develop it holds 116,142 nodes, and no
tool response ever exceeds ~20 KB. Everything is shallow by default, filterable, and paginated
with cursors.

```
you: "what does the tab component in design.fig look like?"

fig_overview  → 10 pages, 2,046 components, 273 variables, 212 images
fig_find      → "lv2/tab/large" is 2:1337, on page "Page 1"
fig_style     → display:flex, direction:row, gap:8, padding:"8px 16px",
                cornerRadius:4, stroke #FFFFFF bound to variable "tab/large/underline"
                (active #FFFFFF / inactive #333333)
```

---

## Non-goals

These are deliberate, permanent limits — not missing features:

- **Rendering is best-effort, not pixel-perfect.** A `.fig` contains no rendered pixels of your
  frames, but it does contain everything needed to draw them again: Figma bakes outlined
  strokes, combined booleans, per-glyph outlines and per-instance geometry into the file at save
  time. `fig_render` uses that to produce a real picture offline — see
  [Rendering](#rendering-fig_render) for exactly what is exact and what is approximated. It is
  not a screenshot of Figma and never will be: read the report before trusting fine detail.
- **No writing.** Nothing is ever written back into a `.fig`. The only write paths in the whole
  server are `fig_image { savePath }` and `fig_render { savePath }`, which write to a path you
  name.
- **No Figma API and no network.** Nothing here talks to figma.com. Library assets published
  from *other* files (styles, variables, components) cannot be resolved offline; they come back
  as their opaque `assetRef` so you can see that they exist and where they point.
- **No vector-network decoding (v1).** Vector geometry lives in a separate binary blob format.
  `fig_node` reports the blob indices and `fig_blob` hands you the raw bytes, but this server
  does not interpret them.
- **Not a diffing or version-history tool.** A saved `.fig` is a full snapshot, not a delta.

## Requirements

- **Node.js ≥ 22.15** (needs `zlib.zstdDecompressSync`; developed on Node 24).
- Runtime dependencies: `@modelcontextprotocol/sdk` and `zod`. The parser itself uses only
  Node built-ins.

## Install

`figme` is published on npm, so there is nothing to clone and nothing to build — your MCP
client downloads it on first start with `npx`.

You need two things:

- **Node.js >= 22.15** (see Requirements above).
- **A `.fig` file on disk.** This server reads a local file and never contacts figma.com, so
  there is no account, token or sign-in — but there is also nothing to read until you save
  one. In Figma: `File -> Save local copy...`.

### The part every client shares

Nearly every MCP client spawns a stdio server from the same two fields:

```json
{ "command": "npx", "args": ["-y", "figme-mcp"] }
```

On **Windows**, some clients cannot resolve `npx` on their own. If the server fails to start,
route it through `cmd`:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "figme-mcp"] }
```

### Claude Code

```bash
claude mcp add figme -- npx -y figme-mcp           # this project
claude mcp add -s user figme -- npx -y figme-mcp   # every project
```

Or commit a `.mcp.json` at the repository root so collaborators get it too:

```json
{
  "mcpServers": {
    "figme": {
      "command": "npx",
      "args": ["-y", "figme-mcp"]
    }
  }
}
```

The Claude Code **extensions for VS Code and JetBrains** run Claude Code underneath and share
its configuration: register the server once with the command above and the extension sees it.
They do not read the editor's own MCP settings.

### Cursor

`~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for a single one:

```json
{
  "mcpServers": {
    "figme": {
      "command": "npx",
      "args": ["-y", "figme-mcp"]
    }
  }
}
```

### VS Code — GitHub Copilot agent mode

VS Code uses its own key, `servers` rather than `mcpServers`, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "figme": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "figme-mcp"]
    }
  }
}
```

The same entry works in your user `settings.json` under `"mcp"`. From a terminal:

```bash
code --add-mcp '{"name":"figme","command":"npx","args":["-y","figme-mcp"]}'
```

Then pick **Agent** mode in the Chat view.

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "figme": {
      "command": "npx",
      "args": ["-y", "figme-mcp"]
    }
  }
}
```

### Anything else

Spawn `npx -y figme-mcp` and talk MCP over stdio.

> Client UIs and config paths move between releases. The `command` and `args` pair above is the
> stable part; if a path here does not match what you see, check that client's own MCP
> documentation.

### Two things to know before the first call

**Use absolute paths.** A `file` argument may be relative, but it resolves against the server's
working directory — whichever directory your client happened to launch it from. An absolute
path removes the guesswork:

> Using figme, run `fig_overview` on /Users/me/Desktop/design.fig

**Watch memory.** `--max-files N` (default 4) caps how many parsed files stay cached. A 39 MB
`.fig` decodes to roughly 900 MB of live objects, so lower it on a small machine and raise it
only with memory to spare:

```json
{ "command": "npx", "args": ["-y", "figme-mcp", "--max-files", "1"] }
```

## From a Figma link

The usual job: *implement this component from our design*, starting from a link someone pasted
into a ticket.

### 1. Save the file locally

This server reads a `.fig` on your disk and never contacts figma.com, so a link by itself is not
enough. Open it in Figma and use `File -> Save local copy...`. For a Community file, click
**Open in Figma** first — that duplicates it into your drafts, which is what makes the copy
possible.

### 2. Take the node id from the link

```
https://www.figma.com/design/<file key>/<slug>?node-id=3017-121&t=<share token>
                             ~~~~~~~~~~                ~~~~~~~~
                             which file                which node
```

Figma writes node ids with a **dash** in links; the `.fig` format uses a **colon**, so
`node-id=3017-121` is guid `3017:121`. You do not have to convert it yourself — every guid
argument accepts all of these:

| You pass | Server reads |
|---|---|
| `3017:121` | `3017:121` |
| `3017-121` | `3017:121` |
| `3017%3A121` | `3017:121` |
| `node-id=3017-121` | `3017:121` |
| the whole `https://www.figma.com/design/...?node-id=3017-121` | `3017:121` |

Anything else is passed through untouched, so a typo still fails loudly rather than being
guessed at.

The file key is a cloud identifier with no counterpart in the saved file, so nothing can work
out which local `.fig` a link refers to. Always give the path yourself.

### 3. Ask for the component

> Using figme, read `/abs/path/UX Case Study Template.fig` and implement node `3017:121` as a
> React component.

A good agent then works roughly in this order:

1. **`fig_render`** — see it. The fastest orientation there is; check the `approximated` and
   `unsupported` lists before trusting fine detail.
2. **`fig_node`** — size, corner radii, auto-layout, constraints, children.
3. **`fig_style`** — resolved fills, strokes, effects and typography, already shaped for code.
4. **`fig_text`** — the exact copy, including per-run styling.
5. **`fig_instance`** — if the node is an INSTANCE, what it came from and what is overridden.
   This is what decides *reusable component* against *one-off*.
6. **`fig_variables`** — token names, so the code references your theme instead of raw hex.
7. **`fig_render` again**, and compare it against a screenshot of what you built.

That last step is why the renderer exists: you get a pixel oracle, not just a description.

### If the guid does not resolve

Node ids are intrinsic to the document, so the id in the link should be the id in the saved
file. If it is reported missing anyway you are most likely in the wrong file — compare
`fig_overview`'s document name with the link's slug — or find the layer by name with `fig_find`,
or browse the page with `fig_tree`.

### Do not let an agent fetch the link

A Figma URL is auth-gated and rendered by JavaScript, so fetching it yields nothing useful.
Worse, the slug reads like a description, which is enough for a model to invent a plausible
component and present it with confidence. The server says as much to every agent at connect
time; if yours reaches for the web regardless, tell it not to.


## From source

For development, or to run a revision that is not published yet:

```bash
git clone https://github.com/ntson9p/figme-mcp.git
cd figme-mcp
npm install
npm run build      # tsc -> dist/
npm test           # builds, then runs the full node:test suite
```

Register `node /abs/path/to/figme-mcp/dist/mcp/server.js` in place of `npx -y figme-mcp`. This
repository ships a `.mcp.json` that already does so for Claude Code.

---

## Tools

Every tool takes `file` (path to the `.fig`). Node references are **guid strings** of the form
`"sessionID:localID"`, e.g. `"2:1339"`. Responses that were cut set `truncated: true` and return
an opaque `nextCursor` you can pass back.

The intended workflow: **`fig_overview` → `fig_tree` a page → `fig_node` / `fig_style` a guid**,
with `fig_find` to jump straight to something by name or copy, and `fig_render` whenever seeing
the thing is faster than reading it.

### 1. `fig_overview` — orient yourself

Document name, export date, format version, node counts by type, the page list, and how many
components / variables / images the file holds.

```jsonc
// → fig_overview { "file": "figma-input/sample.fig" }
{
  "name": "Sample Design", "formatVersion": 106, "nodes": 116142,
  "pages": [ { "guid": "0:2", "name": "Page 1", "children": 1137 }, /* … */ ],
  "nodeTypes": { "INSTANCE": 38164, "FRAME": 32160, "TEXT": 16894, /* … */ },
  "components": 2046, "variables": 273, "images": 212, "blobs": 9651
}
```

### 2. `fig_tree` — explore structure

`root` (default DOCUMENT), `depth` (default 2, max 6), `types` filter, `format`, `cursor`.
Returns a **flat list in document order**; each entry has `depth` (relative to the root) and
`parent`, so the hierarchy is reconstructable, plus `children` (a count) so you can see where
it is worth going deeper.

```
// → fig_tree { "file": "…", "root": "2:1339", "depth": 3, "format": "outline" }
root 2:1339 "Frame 39" depth<=3
[FRAME] 134x40 "Frame 39" (2:1339) x4
  [INSTANCE] 16x16 "lv1/ic/setting" (2:1340)
  [TEXT] 64x24 "text" (2:1341)
  [INSTANCE] 6x6 "lv1/ic/arrow-down" (2:1342)
  [FRAME] 28x24 "Frame 6" (2:1343) x1
    [INSTANCE] 28x22 "lv2/notification" (2:1344)
```

`format: "outline"` is roughly 4× denser than JSON and is the best way to browse.

### 3. `fig_node` — inspect one node

`detail` is `summary`, `full` (default) or `raw`.

```jsonc
// → fig_node { "file": "…", "guid": "2:1339" }
{
  "guid": "2:1339", "type": "FRAME", "name": "Frame 39",
  "page": "Page 1", "path": "Page 1 / lv2/tab/large",
  "geometry": { "width": 134, "height": 40, "x": 0, "y": 0, "absoluteX": 0, "absoluteY": 0 },
  "cornerRadius": 4, "strokeWeight": 1,
  "strokes": [ { "type": "SOLID", "color": "#FFFFFF",
                 "colorVar": { "variable": "tab/large/underline", "guid": "2:1319",
                               "values": { "active": "#FFFFFF", "inactive": "#333333" } } } ],
  "autoLayout": { "mode": "HORIZONTAL", "spacing": 8,
                  "padding": { "top": 8, "right": 16, "bottom": 8, "left": 16 },
                  "primaryAlign": "CENTER", "counterAlign": "CENTER" },
  "children": [ { "guid": "2:1340", "type": "INSTANCE", "name": "lv1/ic/setting", "size": "16x16" } ]
}
```

`detail: "raw"` returns the decoded Figma record verbatim (bytes as hex, int64 as strings). It
is the forward-compatibility escape hatch: anything the mappers do not understand yet is still
reachable there. Limited to one node per call.

### 4. `fig_find` — search names and copy

`query` (case-insensitive substring, matched against layer names **and** text content), plus
optional `types`, `scope`, `limit`, `cursor`. Omit `query` to list all nodes of some types.

```jsonc
// → fig_find { "file": "…", "query": "sample", "types": ["TEXT"], "limit": 3 }
{ "totalMatches": 1428, "returned": 3, "results": [
  { "guid": "8917:139951", "type": "TEXT", "name": "#number1", "size": "224x24",
    "matchedOn": "text", "page": "Page 1",
    "path": "Page 1 / Popup/Variant 7 / Frame 2608806 / …",
    "text": "Sample notification text" } ] }
```

### 5. `fig_text` — copy inventory

All text in the file or in one `scope`, in document order, with a compact style block.
`includeRuns: true` adds the **styled runs** — the mixed-format spans Figma stores per UTF-16
code unit — each showing only the fields it overrides.

```jsonc
// → fig_text { "file": "…", "scope": "2:7098", "includeRuns": true }
{ "totalTextNodes": 2, "texts": [
  { "guid": "2:7099", "name": "✏️  Time", "characters": "Yesterday 9:41",
    "page": "Page 1", "hasStyledRuns": true,
    "style": { "font": "SF Pro Text Regular", "size": 11, "lineHeight": "13px", "color": "#3C3C43" },
    "runs": [ { "start": 0, "end": 9,  "text": "Yesterday", "styleID": 12,
                "style": { "styles": { "text": { "name": "Caption2/Medium" } } } },
              { "start": 9, "end": 10, "text": " ",  "styleID": 10, /* … */ },
              { "start": 10, "end": 11, "text": "9", "styleID": 9,  /* … */ },
              { "start": 11, "end": 14, "text": ":41", "styleID": 10 } ] } ] }
```

### 6. `fig_style` — resolved style, shaped for code

Auto-layout translated into CSS flexbox terms, paints as hex, typography flattened, plus how
the node behaves inside its parent's layout.

```jsonc
// → fig_style { "file": "…", "guid": "2:1339" }
{ "style": {
  "guid": "2:1339", "type": "FRAME", "width": 134, "height": 40, "cornerRadius": 4,
  "strokes": [ { "type": "SOLID", "color": "#FFFFFF", "colorVar": { "variable": "tab/large/underline" } } ],
  "strokeWeight": 1, "strokeAlign": "INSIDE",
  "layout": { "display": "flex", "direction": "row", "gap": 8, "padding": "8px 16px",
              "justifyContent": "center", "alignItems": "center", "primarySizing": "fixed" },
  "inParentLayout": { "flexGrow": 1, "alignSelf": "stretch" } } }
```

For TEXT nodes it also returns `typography` and resolves shared text/fill styles to the values
they define (`styles.text.defines`).

### 7. `fig_components` — the component catalogue

SYMBOL nodes with their component set, property definitions and defaults, and instance counts —
most-used first, so the load-bearing parts of the design system come back first.

```jsonc
// → fig_components { "file": "…", "query": "lv2/tab/large" }
{ "totalComponents": 2046, "components": [
  { "guid": "2:1337", "name": "lv2/tab/large", "page": "Page 1",
    "size": "134x40", "instances": 599,
    "propDefs": [ { "name": "show badge(🔴)", "type": "BOOL", "default": false },
                  { "name": "icon", "type": "INSTANCE_SWAP" } ] } ] }
```

### 8. `fig_instance` — how an instance differs from its component

```jsonc
// → fig_instance { "file": "…", "guid": "2:1329" }
{ "instance": { "guid": "2:1329", "name": "lv1/color/GL/#FFFFFF",
                "page": "Page 1",
                "symbol": { "guid": "2:1325", "name": "lv1/color/GL/#FFFFFF", "inFile": true } },
  "overrideCount": 1,
  "overrides": [ { "path": ["0:2528"], "targetGuid": "2:1325", "targetName": "lv1/color/GL/#FFFFFF",
                   "fields": { "size": "22x22", "fillsCleared": true } } ] }
```

An instance that sets component properties reports them with the names resolved, e.g.
`propAssignments: [ { "defID": "108:1543", "name": "text", "type": "TEXT", "value": "Back" } ]`.
A path segment is the target's `overrideKey` when it has one and its guid otherwise, and a
nested path is walked through swapped instances exactly as the renderer expands them.

### 9. `fig_variables` — design tokens

Every collection with its modes, and every variable with a value per mode. Alias chains are
followed when the target lives in the same file.

```jsonc
// → fig_variables { "file": "…", "query": "tab/large" }
{ "totalSets": 27, "totalVariables": 273,
  "sets": [ { "guid": "2:1312", "name": "active/inactive",
              "modes": [ { "id": "509:1300", "name": "active" }, { "id": "509:1301", "name": "inactive" } ],
              "variableCount": 38 } ],
  "variables": [ { "guid": "2:1313", "name": "tab/large/bg", "type": "COLOR", "set": "active/inactive",
                   "values": { "active": "#FFFFFF", "inactive": "#EEEEEE" } } ] }
```

### 10. `fig_image` — embedded bitmaps

Pass `hash` (the 40-hex id that `fig_node` / `fig_style` report on image paints), or `guid` to
use the images on a node, or `hash: "thumbnail"` for the document preview. Images ≤ 2 MB come
back as viewable image content; larger ones return metadata, and `savePath` writes the exact
bytes to disk.

```jsonc
// → fig_image { "file": "…", "hash": "01ef2f8cd2d276901473acb9ddd7afb2421198e3" }
// [image content] + { "mime": "image/png", "byteLength": 4553, "width": 88, "height": 84 }
```

### 11. `fig_blob` — raw payload bytes

`index` into the file's blob table (`fig_node` reports these as `vector.networkBlob` /
`vector.fillBlobs`), `encoding` (`base64` | `hex`), `maxBytes` (default 65536).

```jsonc
// → fig_blob { "file": "…", "index": 16, "maxBytes": 8, "encoding": "hex" }
{ "index": 16, "byteLength": 96, "returnedBytes": 8, "data": "0100000000020080",
  "truncated": true, "blobCount": 9651 }
```

### 12. `fig_render` — a picture of a node

`guid` (any node, or a page), `format` (`png` | `svg`, default `png`), `scale` (default 2),
`maxSize` (longest edge, default 1568), `background` (`transparent` | `page`), `savePath`,
`maxNodes` (default 20000, counted in layers).

```jsonc
// → fig_render { "file": "…", "guid": "2:1339" }
// [image content, 268x80 PNG]
{ "root": { "guid": "2:1339", "name": "Frame 39", "type": "FRAME" },
  "bounds": { "x": 0, "y": 0, "w": 134, "h": 40 }, "width": 268, "height": 80, "scale": 2,
  "nodesVisited": 9, "nodesDrawn": 8, "svgBytes": 4757, "renderMs": 4.6, "rasterMs": 55.3,
  "unsupported": [], "approximated": [], "format": "png" }
```

---

## Rendering (`fig_render`)

Nothing is fetched and no font is needed: Figma stores outlined strokes, combined booleans,
per-glyph outlines and per-instance resolved geometry in the file, so the renderer consumes
what Figma already computed. The SVG it builds is rasterized by
[`@resvg/resvg-wasm`](https://github.com/yisibl/resvg-js), an **optional** dependency — with it
uninstalled, everything still works and `fig_render` returns SVG instead of PNG.

**Exact**: solid fills, linear and radial gradients, image fills in all four scale modes,
strokes including inside/outside alignment, boolean operations, text (glyph outlines, per-run
colours, underline and strikethrough, truncation with an ellipsis), component instances with
their overrides, their component properties (text, visibility, instance swap) and the sizes the
enclosing instance gives them, colour and effect styles resolved to their live definition, frame
clipping, layer opacity, the fifteen shared blend modes, drop and inner shadows, layer blur,
and all three mask types.

**Approximated, and always reported**: background blur (drawn flat — a backdrop filter cannot
see behind an isolated subtree), `LINEAR_DODGE` and `LINEAR_BURN` (drawn as `screen` and
`multiply`), angular and diamond gradients (drawn as their average colour), image crop and
image rotation.

**Skipped, and always reported**: emoji glyphs, FigJam-style nodes (`WIDGET`, `CONNECTOR`,
`SHAPE_WITH_TEXT`), text without stored outlines (including a text property whose words have
no outlines in the file), and strokes on text.

Fidelity was measured against a Figma export of a 1440×3026 form built from component
instances: 0.18 % of pixels differ, all anti-aliasing. That export came from a design that
is not public, so it is not distributed here — `npm run visual` runs levels 1-2 until you
supply your own export.

Every response carries `unsupported` and `approximated` lists naming the feature and up to five
example guids. An empty pair means the renderer believes it drew the node exactly. Exact values
always remain available from `fig_node`, `fig_style` and `fig_text`.

There is also a CLI for the same thing:

```bash
npm run build
node scripts/render.mjs figma-input/sample.fig 2:1339 out.png --scale 2 --background page
```

---

## How it stays inside a context window

- Default response budget **20,000 characters**, hard cap **50,000**.
- Never more than **300 nodes** per response, and never more than **one** `raw` node per call.
- Trees are **shallow by default** (depth 2) and every entry carries a child count, so the agent
  chooses where to spend tokens.
- Unset fields are omitted, floats are rounded to 2 decimals, colours become `#RRGGBB`, and
  sizes collapse to `"134x40"`.
- Anything cut sets `truncated: true` and returns an opaque `nextCursor`; paging is stable
  because it follows document order.
- There is deliberately **no "dump everything" tool**.

## How it works

```
.fig bytes
  ├─ Stage A  container   ZIP? unwrap canvas.fig (+ meta.json, thumbnail.png, images/<sha1>)
  ├─ Stage B  framing     "fig-kiwi" magic, u32 version, length-prefixed chunks
  ├─ Stage C  codec       sniffed per chunk: zstd / raw deflate / zlib / stored
  ├─ Stage D  Kiwi        chunk[0] = the binary SCHEMA, chunk[1] = the data decoded WITH it
  └─ Stage E  tree        rebuild the layer tree from parentIndex + fractional-index order
```

The decisive detail is Stage D: **the schema ships inside the file**. Nothing here hardcodes a
field id, so Figma's constant schema additions do not break the reader.

```
src/
  fig/            LAYER 1 — mechanical decode, knows bytes, knows nothing about design
    bytebuffer.ts   Kiwi primitives (varuint, zigzag, the rotated float32, NUL strings)
    zip.ts          central-directory ZIP reader (Figma zeroes the local-header sizes)
    container.ts    container sniffing, chunk framing, per-chunk decompression
    kiwi.ts         binary-schema decode + schema-driven data decode
    imagemeta.ts    image magic-byte + dimension sniffing
    invariants.ts   post-parse checks; warnings, not failures
    parse.ts        the whole pipeline in one call
  model/          LAYER 2 — Figma semantics, never touches bytes
    tree.ts         guid keys, tree build, fractional-index sibling order
    index.ts        FileIndex: by-guid, by-type, by-asset-key, override keys, prop defs, search
    access.ts       typed accessors over open records + presentation helpers
    summarize.ts    node summary / full detail / style block builders
    text.ts         characters + styled-run resolution
    instance.ts     what an instance looks like: identity paths, records, property assignments
    components.ts   symbols, instances, the fig_instance view
    variables.ts    collections, modes, alias chains
  render/         LAYER 2½ — fig_render: node subtree → SVG → (optional) PNG
    export.ts       the traversal; instance.ts / style.ts / bounds.ts / text.ts / paint.ts /
                    effects.ts each own one concern; report.ts the frozen feature vocabulary
  mcp/            LAYER 3 — protocol
    create.ts       server factory (used by the entry point and by tests)
    server.ts       stdio entry point
    respond.ts      budgets, cursors, truncation
    tools/*.ts      one file per tool
  cache.ts        LRU of parsed files, invalidated on mtime/size change
```

`mcp/` and `model/` never touch bytes; `fig/` knows nothing about Figma semantics.

## Testing

```bash
npm test              # build + full node:test suite (unit + golden)
npm run typecheck     # type-checks src, test and scripts
npm run smoke         # spawns the built server and walks the demo script over real stdio
npm run crosscheck    # deep-compares our decode against the official kiwi-schema package
```

- **Unit tests** need no asset: Kiwi primitives against a transcribed reference encoder, a
  synthetic ZIP with data-descriptor entries, fractional-index ordering, the response budgeter,
  image sniffing, and corrupt-input handling.
- **Golden tests** run against `figma-input/sample.fig` and assert measured values (116,142
  nodes, 638 schema definitions, 10 pages, specific node geometry, …). They **skip with a clear
  message** if the asset is absent.
- **Fixture identifiers are placeholders.** The design this was developed against is not
  public. Page, component, variable and layer names in this README, in `docs/` and in the
  golden tests were replaced with neutral stand-ins, and node guids were renumbered. The
  structure and the measured numbers are real; the names are not, so the string assertions
  will not match your own `.fig` until you update them.
- **Cross-check** decodes the same buffers with Evan Wallace's official `kiwi-schema` package and
  deep-compares every field: currently **0 differences across 17,353,242 compared values**. It
  skips cleanly if `kiwi-schema` is not installed.

`tools/fig2json.mjs` is the original dependency-free reference CLI that Layer 1 was ported from.
It is kept working as a debugging aid:

```bash
node tools/fig2json.mjs figma-input/sample.fig /tmp/out
# writes schema.kiwi.txt, nodes.ndjson, tree-outline.txt, meta.json
```

Dumping `schema.kiwi.txt` is the fastest way to look up a field this server does not map yet;
then read it with `fig_node detail:"raw"`.

## Documentation

- [`docs/fig-reading-solution.md`](docs/fig-reading-solution.md) — the byte-level reading
  procedure, verified end to end.
- [`docs/mcp-implementation-plan.md`](docs/mcp-implementation-plan.md) — the plan this server
  implements, including the golden values in Appendix A.
- [`docs/fig-file-format.md`](docs/fig-file-format.md) — the measurement log and evidence.

## License

MIT.
