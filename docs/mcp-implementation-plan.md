# PLAN: `figme` — an MCP server that lets AI agents read local `.fig` files

> **Audience**: the AI agent implementing this server. Execute milestones **in order** (M0→M6);
> each has acceptance criteria — run them before moving on. The byte-level reading procedure is
> **not** designed here: follow [`fig-reading-solution.md`](fig-reading-solution.md) exactly.
> Known-good reference parser: [`tools/fig2json.mjs`](../tools/fig2json.mjs) (keep it working).
> Golden test asset: `figma-input/sample.fig`; expected values in Appendix A were measured on it.

## 1. Goal and non-goals

**Goal**: an MCP server (stdio transport) exposing tools with which an AI agent can read
*everything* in a local `.fig`/`.figma` file — document structure, geometry, styling,
auto-layout, text (incl. styled runs), components/instances, variables, prototypes, embedded
images — **fully offline**, correct (validated against golden values), and **token-efficient**
(a 116k-node file must be explorable without ever flooding the agent's context).

**Non-goals (state these in the README)**:
- No rendering/screenshots of frames (a `.fig` contains no rendered pixels beyond
  `thumbnail.png` and image fills; rendering would require reimplementing Figma's engine).
- No writing/modifying `.fig` files. No Figma REST API, no network at runtime.
- No blob-internal vector-network decoding in v1 (raw blob bytes are exposed; see M6 stretch).

## 2. Stack and dependencies

- **Runtime**: Node ≥ 22.15 (needs `zlib.zstdDecompressSync`; dev machine has v24). TypeScript,
  ES modules, compiled with `tsc` to `dist/`.
- **Runtime dependencies — exactly two**: `@modelcontextprotocol/sdk` (server + stdio
  transport) and `zod` (tool input schemas; the SDK uses it). The parser itself must remain
  **dependency-free** (node:zlib only).
- **Dev dependencies**: `typescript`, `@types/node`, and `kiwi-schema` (cross-check script
  only — never imported by runtime code).
- Tests: built-in `node:test` runner (`node --test`). No test framework dependency.
- Consult the `@modelcontextprotocol/sdk` README for current registration API (e.g.
  `McpServer` + `registerTool`); do not assume a memorized API shape.

## 3. Architecture

```
src/
  fig/                      # LAYER 1 — mechanical decode (generic, format-stable)
    bytebuffer.ts           #   Kiwi primitives (§4 of solution doc)
    zip.ts                  #   central-directory ZIP reader (§1)
    kiwi.ts                 #   binary-schema decode + schema-driven data decode (§5–6)
    container.ts            #   sniffing, chunk framing, decompression (§1–3)
    parse.ts                #   parseFig(buffer) → { version, schema, message, files, warnings }
    invariants.ts           #   §7 checks; returns warnings list, throws on hard failures
  model/                    # LAYER 2 — semantic mapping (Figma-specific, versioned)
    tree.ts                 #   guid keys "S:L", tree build + fractional-index sort (§8)
    index.ts                #   FileIndex: byGuid, children, byType, byName, text index,
                            #   symbols, variables, imageHash→zipEntry
    summarize.ts            #   NodeSummary / NodeDetail / style block builders (token-lean)
    text.ts                 #   characters + styled-run resolution (§9.6)
    components.ts           #   symbol defs, instance override resolution (§9.7)
    variables.ts            #   sets, modes, values, local alias resolution (§9.8)
  mcp/
    server.ts               # entry point: registers tools, stdio transport
    tools/*.ts              # one file per tool (schemas + handlers)
    respond.ts              # response budgeting: caps, pagination cursors, truncation flags
  cache.ts                  # parsed-file cache
test/
  unit/  golden/  fixtures/
tools/fig2json.mjs          # existing reference CLI — untouched, reused for debugging
scripts/crosscheck.mjs      # dev-only: deep-compare our decode vs kiwi-schema npm
```

**Layer rule**: `mcp/` and `model/` never touch bytes; `fig/` never knows Figma semantics.
Layer 1 should be a direct TypeScript port of `tools/fig2json.mjs` (already validated).

## 4. Data model decisions

- **guid strings** everywhere at the API boundary: `"2:1339"` (`sessionID:localID`).
- **Detail levels** for nodes:
  - `summary` (default): `{ guid, type, name, size?, childrenCount, page? }` — one line of JSON.
  - `full`: summary + geometry, paints, strokes, effects, corner radii, auto-layout, text
    basics, component/variable links — with **noise reduction**: floats rounded to 2 decimals,
    colors as `#RRGGBB` / `#RRGGBBAA`, omitted-if-unset, byte fields as hex.
  - `raw`: the decoded NodeChange verbatim (JSON-safe: BigInt→string, bytes→hex). The
    forward-compat escape hatch — anything the mappers don't understand is still reachable.
- **File cache**: key = absolute path; entry = `{ mtimeMs, size, parsed, indexes }`; re-parse on
  mtime/size change; LRU cap 4 files (a 39MB file decodes to ~500MB of JS objects — document
  a `--max-files` flag). Parse lazily on first tool call touching a path.
- **Warnings, not failures**: unknown enum numbers, unresolvable image hashes, unknown fields
  in mappers → collect into `warnings[]` on responses; only structural corruption throws.

## 5. Token-efficiency rules (every tool must obey; centralize in `respond.ts`)

1. Default response budget ~20,000 characters; hard cap 50,000. When exceeded: truncate
   deterministically, set `"truncated": true`, and include `nextCursor` (opaque) and/or a hint
   (`"use depth/filter/cursor"`).
2. Never return more than 300 nodes per response. Never return `raw` for more than 1 node per
   call.
3. Trees are returned **shallow by default** (depth 2) with `childrenCount` on every node so
   the agent can decide where to deepen.
4. Pagination: stable order (tree order / fractional index), opaque cursor = `{ afterGuid }`
   base64.
5. Outline format option (`format: "outline"`) returning indented text lines
   (`[FRAME] 134x40 "Frame 39" (2:1339) ×3 children`) — ~4× denser than JSON for browsing.
6. Images: return MCP image content only when ≤ 2MB decoded; otherwise return metadata +
   `savePath` instruction (tool can write the file to a caller-given path).

## 6. MCP tool surface (v1)

Common input on every tool: `file` (string, path to `.fig`; relative paths resolved from CWD).
All outputs are JSON in a text content block unless stated. All node references accept/return
guid strings.

| # | Tool | Purpose / key inputs / output |
|---|---|---|
| 1 | `fig_overview` | Parse (or hit cache) and orient. In: `file`. Out: file name (from meta.json), exported_at, header version, counts by node type, warnings, and the page list `[{guid,name,childrenCount}]`, component/variable/image counts. |
| 2 | `fig_tree` | Explore structure. In: `file`, `root` (guid, default DOCUMENT), `depth` (default 2, max 6), `types?` filter, `format` (`json`\|`outline`), `cursor?`. Out: subtree of summaries, honoring §5. |
| 3 | `fig_node` | Inspect one node. In: `file`, `guid`, `detail` (`summary`\|`full`\|`raw`, default `full`), `includeChildren` (bool, default true → child summaries). Out: node at requested detail. |
| 4 | `fig_find` | Search. In: `file`, `query?` (matched case-insensitively against name AND text content), `types?`, `scope?` (guid), `limit` (default 50), `cursor?`. Out: matches as summaries + matched-on field + page + parent chain names (breadcrumb string). |
| 5 | `fig_text` | Copy inventory. In: `file`, `scope?`, `includeRuns` (default false), `cursor?`. Out: `[{guid, name, characters, page, style?{font,size,lineHeight,color}, runs?}]` where runs come from `model/text.ts` (§9.6 resolution). |
| 6 | `fig_style` | Code-gen oriented resolved style of one node. In: `file`, `guid`. Out: flat style block: fills/strokes/effects (hex colors), cornerRadius, typography, and auto-layout translated to CSS-flexbox-like terms (`direction, gap, padding, alignItems, justifyContent, sizing`), plus variable/style refs by name when locally resolvable. |
| 7 | `fig_components` | In: `file`, `query?`, `cursor?`. Out: SYMBOL list `{guid,name,description?,propDefs,instanceCount}`. |
| 8 | `fig_instance` | In: `file`, `guid` (INSTANCE). Out: `{ symbol: {guid,name}, propAssignments (names resolved via defID), overrides: [{targetPath, overriddenFields}] }`. |
| 9 | `fig_variables` | In: `file`. Out: variable sets with modes, variables with per-mode values; alias chains resolved when the target is local; `assetRef` passed through otherwise. |
| 10 | `fig_image` | In: `file`, `hash?` or `guid?` (node using an image fill; if node, list its image hashes when >1), `savePath?`. Out: MCP **image content** (base64, sniffed mime) when small enough (§5.6), else/also metadata `{hash, byteLength, mime, width/height if cheaply known}`; when `savePath` given, write file and return the path. Also accepts `hash:"thumbnail"` for `thumbnail.png`. |
| 11 | `fig_blob` | Escape hatch. In: `file`, `index`, `encoding` (`base64`\|`hex`), `maxBytes` (default 65536). Out: blob bytes (truncated + flagged if larger). |

Design notes:
- Tool descriptions (in registration) must teach the *workflow*: "start with `fig_overview`,
  then `fig_tree` on a page, then `fig_node`/`fig_style` on interesting guids; use `fig_find`
  to jump; everything supports cursors."
- `fig_find` full-text search covers node names + `textData.characters` via the prebuilt index.
- Do not add a "dump everything" tool.

## 7. Milestones

### M0 — Scaffold
`package.json` (type module, scripts: `build`, `test`, `start`, `crosscheck`), `tsconfig.json`
(strict), install deps (§2), CI-less. **Accept**: `npm run build` clean; `node --test` runs (0
tests ok); `node dist/mcp/server.js` starts and lists tools via a trivial stdio handshake
(manual or scripted).

### M1 — Layer 1 port + golden parse
Port `tools/fig2json.mjs` into `src/fig/*` as typed modules; add `invariants.ts`.
**Accept** (golden test `test/golden/parse.test.ts` against `figma-input/sample.fig`, values
from Appendix A): header version, chunk codecs+sizes, 638 defs, 116,142 nodes, 9,651 blobs,
exact-consumption asserts, `NODE_CHANGES` type. Unit tests for varint/zigzag/varfloat
(incl. `00`→0.0, round-trips) and the ZIP reader (data-descriptor entries). Plus
`npm run crosscheck` → **0 field differences** vs `kiwi-schema` (dev-only script; requires
network once for `npm i`; skip gracefully if offline).

### M2 — Tree, index, first tools
`model/tree.ts`, `model/index.ts`, `cache.ts`, `respond.ts`; tools `fig_overview`, `fig_tree`,
`fig_node`, `fig_find`. **Accept**: golden: 10 pages, page names include "Page 1"
and "Page 7"; 0 orphans; node `2:1339` summary+full match Appendix A; `fig_tree` at depth 2 from
DOCUMENT is < 20KB; `fig_find query:"sample"` returns results with breadcrumbs; every response
under budget; second `fig_overview` call served from cache (assert via timing or counter).

### M3 — Text & style
`model/text.ts` (runs per §9.6), `model/summarize.ts` style blocks; tools `fig_text`,
`fig_style`. **Accept**: golden: node `2:1341` → characters `"Text"`, Meiryo 16; node
`2:7099` → 14 characterStyleIDs resolving to overrides `{9,10,12}` with `styleIdForText`
refs; `fig_style` of `2:1339` reports direction=row, gap=8, padding 16/8, cornerRadius 4, and
the stroke's variable alias surfaced.

### M4 — Components & variables
`model/components.ts`, `model/variables.ts`; tools `fig_components`, `fig_instance`,
`fig_variables`. **Accept**: golden: 2,046 SYMBOLs; instance `2:1329` resolves to symbol `2:1325`
with its override listed; variables: 273 VARIABLE nodes across 27 VARIABLE_SETs; a color
variable's per-mode values render as hex.

### M5 — Images & blobs
`fig_image`, `fig_blob`. **Accept**: golden: 212 referenced hashes all resolve;
`fig_image` on a known hash returns image content with correct mime (sniff PNG/JPEG magics);
`savePath` writes bytes identical to the ZIP entry; `fig_blob index:0` returns base64 with
correct length; oversized blob truncates with flag.

### M6 — Hardening & docs
Budget enforcement tests (craft a depth-6 tree call; assert truncation+cursor); corrupt-input
tests (truncated file, bad magic, unknown codec → error messages contain hex context);
`README.md`: what it is, non-goals, tool reference with examples, registration snippet for
`.mcp.json` and `claude mcp add figme -- node <abs>/dist/mcp/server.js`; keep
`docs/*` links accurate. **Stretch (optional)**: vector-network blob decoding following
fig2sketch's `vector_network.py`. **Accept**: full `node --test` suite green; manual smoke: from
a Claude Code session with the server registered, run the demo script in §9.

## 8. Testing strategy summary

- **Unit** (fast, no asset): Kiwi primitives, ZIP reader on a synthetic in-memory zip,
  fractional-index sort, respond.ts budgeter.
- **Golden** (asset-dependent): every Appendix A value; skip cleanly with a clear message if
  `figma-input/sample.fig` is absent.
- **Cross-check** (dev): `scripts/crosscheck.mjs` — official `kiwi-schema` deep-compare.
- **Negative**: corruption cases (M6). Assert error messages carry magic-byte hex.

## 9. Manual smoke script (run after M6)

1. `fig_overview {file:"figma-input/sample.fig"}` → 10 pages, counts as in Appendix A.
2. `fig_tree {root:"<Page 7 page guid>", depth:2, format:"outline"}` → readable outline.
3. `fig_find {query:"sample", types:["TEXT"]}` → hits with breadcrumbs.
4. `fig_node {guid:"2:1339"}` then `fig_style {guid:"2:1339"}` → auto-layout as flexbox terms.
5. `fig_text {scope:"<a small frame guid>", includeRuns:true}` → runs resolved.
6. `fig_image {hash:"01ef2f8cd2d276901473acb9ddd7afb2421198e3"}` → image renders.
7. `fig_variables {}` → sets/modes/values listed.

## 10. Definition of done

- [ ] All milestone acceptance criteria pass; `node --test` fully green.
- [ ] `npm run crosscheck` reports 0 differences (or documented offline skip).
- [ ] Every tool obeys §5 (budget test proves it).
- [ ] README complete (incl. non-goals + registration); server registers and answers §9 smoke
      queries in a real MCP client.
- [ ] `tools/fig2json.mjs` still runs unchanged.
- [ ] No runtime network access anywhere; runtime deps = SDK + zod only.

## Appendix A — Golden values for `figma-input/sample.fig`

| Fact | Value |
|---|---|
| File size / container | 38,860,863 bytes; ZIP (`canvas.fig` stored, `meta.json` deflated, `thumbnail.png`, 252 files under `images/`) |
| meta.json | `file_name: "Sample Design"` |
| Header version | 106 |
| Chunk 0 | 29,408 → 73,430 bytes, raw-deflate (Kiwi schema) |
| Chunk 1 | 6,968,508 → 63,385,564 bytes, zstd (`Message`) |
| Schema | 638 definitions = 398 messages + 30 structs + 210 enums |
| Message | `type: NODE_CHANGES`; keys: type, sessionID, ackID, originFileKey, nodeChangeOrder, nodeChanges, blobs |
| Nodes / blobs / orphans | 116,142 / 9,651 / 0 |
| Type counts | INSTANCE 38,164 · FRAME 32,160 · TEXT 16,894 · VECTOR 15,770 · ROUNDED_RECTANGLE 5,566 · BOOLEAN_OPERATION 2,946 · SYMBOL 2,046 · ELLIPSE 1,189 · LINE 389 · RECTANGLE 384 · VARIABLE 273 · WIDGET 115 · SECTION 89 · SHAPE_WITH_TEXT 80 · VARIABLE_SET 27 · BRUSH 25 · CONNECTOR 14 · CANVAS 10 · DOCUMENT 1 |
| Pages (10, in order) | "Page 1", "Page 2", "Page 3", "Page 4", "Page 5", "Page 6", "Page 7", "---", "Page 9", "Page 10" |
| Node `2:1339` "Frame 39" | FRAME 134×40; stackMode HORIZONTAL, stackSpacing 8, stackHorizontalPadding 16, stackVerticalPadding 8, stackPrimary/CounterAlignItems CENTER, cornerRadius 4, strokeWeight 1, stroke SOLID #FFFFFF bound to color variable alias (`assetRef.key: 0dc9ea8b757859cd04ebcfa4be474a66418c1e50`) |
| Node `2:1341` "text" | TEXT 64×24; characters "Text"; Meiryo Regular 16; lineHeight 1.5 RAW; align CENTER; transform m02=40, m12=8 |
| Node `2:7099` "✏️  Time" | characters "Yesterday 9:41" (14 UTF-16 units); characterStyleIDs `12,12,12,12,12,12,12,12,12,10,9,10,10,10`; styleOverrideTable ids {9,10,12} carrying `styleIdForText`/`styleIdForFill` assetRefs |
| Instance link | INSTANCE `2:1329` → `symbolData.symbolID` = `2:1325` |
| Images | 212 unique hashes referenced by paints; **all 212** present as `images/<hex>`; sample hash `01ef2f8cd2d276901473acb9ddd7afb2421198e3` (4,553 bytes) |
| Parse budget | full parse+decode+tree of this file completes in seconds (≤15s acceptable) on Node 24 |
