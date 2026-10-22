# Contributing to figme

Issues and pull requests are welcome. This page covers building from source, the tests, and how
the code is laid out. To use figme, see the [README](README.md).

## Build from source

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

- **Node.js ≥ 22.15** (needs `zlib.zstdDecompressSync`; developed on Node 24).
- Runtime dependencies: `@modelcontextprotocol/sdk` and `zod`. The parser itself uses only
  Node built-ins.

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
  public. Page, component, variable and layer names in the README, in `docs/` and in the
  golden tests were replaced with neutral stand-ins, and node guids were renumbered. The
  structure and the measured numbers are real; the names are not, so the string assertions
  will not match your own `.fig` until you update them.
- **Cross-check** decodes the same buffers with Evan Wallace's official `kiwi-schema` package and
  deep-compares every field: currently **0 differences across 17,353,242 compared values**. It
  skips cleanly if `kiwi-schema` is not installed.

`fig_render` has its own visual tester, `npm run visual`; [docs/rendering.md](docs/rendering.md)
and [docs/render-fixtures.md](docs/render-fixtures.md) cover it.

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

## Reading a field figme does not map yet

`tools/fig2json.mjs` is the original dependency-free reference CLI that Layer 1 was ported from.
It is kept working as a debugging aid:

```bash
node tools/fig2json.mjs figma-input/sample.fig /tmp/out
# writes schema.kiwi.txt, nodes.ndjson, tree-outline.txt, meta.json
```

Dumping `schema.kiwi.txt` is the fastest way to look up a field this server does not map yet;
then read it with `fig_node detail:"raw"`.

## Design documents

- [`docs/fig-reading-solution.md`](docs/fig-reading-solution.md) — the byte-level reading
  procedure, verified end to end.
- [`docs/mcp-implementation-plan.md`](docs/mcp-implementation-plan.md) — the plan this server
  implements, including the golden values in Appendix A.
- [`docs/render-implementation-plan.md`](docs/render-implementation-plan.md) — the plan
  `fig_render` implements, milestones R0–R8.
- [`docs/fig-file-format.md`](docs/fig-file-format.md) — the measurement log and evidence.
