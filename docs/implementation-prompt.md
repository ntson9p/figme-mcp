# Prompt: implement the `figfile` MCP server

Copy everything inside the fence into a brand-new AI agent session started in the repo root
(`d:\code\figme`).

```text
Implement the MCP server planned in this repository, working autonomously to completion.

CONTEXT
- This repo already contains a fully verified investigation of Figma's local .fig file format.
  Do NOT re-research the format and do NOT redesign the plan — both are done and authoritative:
  1. docs/fig-reading-solution.md  — the exact byte-level reading procedure. Read it fully
     first and follow it precisely; every claim in it was verified on the test file.
  2. docs/mcp-implementation-plan.md — the plan you are executing: stack, architecture, module
     layout, token-efficiency rules, the 11 MCP tool specs, milestones M0–M6 with acceptance
     criteria, and Appendix A golden values.
  3. docs/fig-file-format.md — background evidence; skim only.
- Known-good reference parser: tools/fig2json.mjs (dependency-free; validated byte-for-byte
  against the official kiwi-schema package on the test file). Port from it for Layer 1; keep it
  runnable and unchanged.
- Test asset: figma-input/sample.fig. All Appendix A golden values were measured on this exact
  file — treat any mismatch as a bug in YOUR code until proven otherwise.
- Environment: Windows 11, Node.js 24 available (node:zlib includes zstdDecompressSync).

EXECUTION RULES
- Execute milestones M0 → M6 strictly in order. After each milestone, run its acceptance
  checks (tests) and do not proceed until they pass.
- Runtime dependencies: ONLY @modelcontextprotocol/sdk and zod. kiwi-schema is allowed as a
  devDependency used solely by scripts/crosscheck.mjs. The parser itself must use only Node
  built-ins. Consult the SDK's own README for its current registration API instead of assuming.
- Never call Figma APIs or any network service at runtime; network use is limited to npm
  install.
- Every MCP tool response must obey the plan's token-efficiency rules (section 5): response
  budgets, ≤300 nodes, shallow-by-default trees, cursors, truncation flags. Never dump the
  whole 116k-node document.
- Use the built-in node:test runner. Golden tests must skip with a clear message (not fail) if
  the test asset is missing.
- Beware the documented pitfalls (solution doc §11), especially: return plain Uint8Array for
  byte[] (Buffer#toJSON corrupts JSON output), never JSON.stringify the whole decoded message,
  sort siblings by raw code-unit comparison of position strings, and treat float32 noise as
  correct.

DEFINITION OF DONE (from the plan, section 10)
- All milestone acceptance criteria pass and `node --test` is fully green.
- `npm run crosscheck` reports zero field differences vs kiwi-schema (or a documented offline
  skip).
- The server starts over stdio and answers the manual smoke script (plan section 9).
- README.md documents purpose, explicit non-goals (no rendering/screenshots, no writing, no
  Figma API), every tool with an example, and registration via .mcp.json and
  `claude mcp add figfile -- node <abs-path>/dist/mcp/server.js`.
- tools/fig2json.mjs still runs: `node tools/fig2json.mjs figma-input/sample.fig <tmpdir>`.

FINAL REPORT
When finished, report: what was built (tree of src/), verbatim test-run output, the smoke-test
results, any deviation from the plan with justification, and anything you discovered about the
format that the docs should record.
```
