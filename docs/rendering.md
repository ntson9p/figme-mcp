# Rendering (`fig_render`)

A `.fig` contains no rendered pixels of your frames, but it does contain everything needed to
draw them again: Figma bakes outlined strokes, combined booleans, per-glyph outlines and
per-instance resolved geometry into the file at save time. `fig_render` consumes what Figma
already computed, so nothing is fetched and no font is needed.

The result is best-effort, not pixel-perfect. It is not a screenshot of Figma and never will be:
read the report before trusting fine detail.

The SVG it builds is rasterized by [`@resvg/resvg-wasm`](https://github.com/yisibl/resvg-js), an
**optional** dependency — with it uninstalled, everything still works and `fig_render` returns
SVG instead of PNG.

## What is exact

Solid fills, linear and radial gradients, image fills in all four scale modes, strokes including
inside/outside alignment, boolean operations, text (glyph outlines, per-run colours, underline
and strikethrough, truncation with an ellipsis), component instances with their overrides, their
component properties (text, visibility, instance swap) and the sizes the enclosing instance gives
them, colour and effect styles resolved to their live definition, frame clipping, layer opacity,
the fifteen shared blend modes, drop and inner shadows, layer blur, and all three mask types.

## Approximated, and always reported

Background blur (drawn flat — a backdrop filter cannot see behind an isolated subtree),
`LINEAR_DODGE` and `LINEAR_BURN` (drawn as `screen` and `multiply`), angular and diamond
gradients (drawn as their average colour), image crop and image rotation.

## Skipped, and always reported

Emoji glyphs, FigJam-style nodes (`WIDGET`, `CONNECTOR`, `SHAPE_WITH_TEXT`), text without stored
outlines (including a text property whose words have no outlines in the file), and strokes on
text.

## The report

Every response carries `unsupported` and `approximated` lists naming the feature and up to five
example guids. An empty pair means the renderer believes it drew the node exactly. Exact values
always remain available from `fig_node`, `fig_style` and `fig_text`.

## How close it gets

Fidelity was measured against a Figma export of a 1440×3026 form built from component
instances: 0.18 % of pixels differ, all anti-aliasing. That export came from a design that
is not public, so it is not distributed here — `npm run visual` runs levels 1-2 until you
supply your own export. [render-fixtures.md](render-fixtures.md) explains how to make one.

## From the command line

A clone of this repository also has a CLI for the same thing:

```bash
npm run build
node scripts/render.mjs figma-input/sample.fig 2:1339 out.png --scale 2 --background page
```
