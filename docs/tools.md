# Tool reference

Your agent normally picks these tools on its own, guided by the instructions figme sends when it
connects. This page is for when you want to know exactly what each one takes and returns. To
install figme, see the [README](../README.md).

## Conventions

Every tool takes `file` (path to the `.fig` or `.figma`). Node references are **guid strings**
of the form `"sessionID:localID"`, e.g. `"2:1339"`. Responses that were cut set
`truncated: true` and return an opaque `nextCursor` you can pass back.

### Node ids from Figma links

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

### Layers inside component instances

An instance stores none of its layers: they are its component's, changed by the instance's
overrides and component-property values. figme shows them anyway, as Figma does, and gives each
the id Figma itself uses — the instance's guid, then one `;`-separated segment per level of
instance nesting:

| Id | Names |
|---|---|
| `1319:26210` | a DatePicker instance (iOS 16 UI Kit) |
| `I1319:26210;55:4649` | its month label, as that instance shows it |
| `I1319:26210;55:2890;55:3914` | the "6" in a day-row instance nested inside it |

`fig_tree` lists these ids, and every tool that takes a guid accepts them, also spelled the way
a link writes them (`node-id=I1319-26210%3B55-4649`). They describe the layer as the instance
shows it: overrides, property values and shared styles applied.

## Workflow

The intended workflow: **`fig_overview` → `fig_tree` a page → `fig_node` / `fig_style` a guid**,
with `fig_find` to jump straight to something by name or copy, and `fig_render` whenever seeing
the thing is faster than reading it.

### Implementing a component

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

## The tools

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

`root` (default DOCUMENT), `depth` (default 2, max 6), `types` filter, `format`, `instances`,
`cursor`. Returns a **flat list in document order**; each entry has `depth` (relative to the
root) and `parent`, so the hierarchy is reconstructable, plus `children` (a count) so you can
see where it is worth going deeper. A hidden layer — hidden directly or by a component property
— is marked `hidden`.

Component instances are walked into: their layers come back as the instance shows them, with
the ids described under [Layers inside component instances](#layers-inside-component-instances).
`instances: false` lists only the layers stored in the file.

```
// → fig_tree { "file": "…/ios-16-ui-kit.fig", "root": "1319:26210", "depth": 2, "format": "outline" }
root 1319:26210 "DatePicker" depth<=2
[INSTANCE] 357x370 "DatePicker" (1319:26210) x8
  [FRAME] 325x44 "Month Picker" (I1319:26210;55:4647) x2
    [FRAME] 100.69x22 "Month + Year" (I1319:26210;55:4648) x2
    [FRAME] 51x17.32 "Arrows" (I1319:26210;55:4651) x2
  [INSTANCE] 325x18 "_DatePicker-dayRow" (I1319:26210;55:4468) x7
    [TEXT] 32x18 "✏️ Day" (I1319:26210;55:4468;55:4105)
    …
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

Auto-layout uses the names of Figma's plugin and REST APIs. A frame with "Auto" spacing — stored
as `SPACE_EVENLY` — reports `"primaryAlign": "SPACE_BETWEEN", "spacing": "auto"`: Figma spreads
the children across the box and ignores the stored gap, so no number is reported for it.
Likewise `counterSpacing`, the gap between wrapped lines, appears only on a layout that wraps.

### 4. `fig_find` — search names and copy

`query` (case-insensitive substring, matched against layer names **and** text content), plus
optional `types`, `scope`, `limit`, `instances`, `cursor`. Omit `query` to list all nodes of
some types. The search covers the layers stored in the file; `instances: true` also searches
the layers component instances show, with their overrides — best combined with a `scope`.

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

With a `scope`, the text that component instances show is included, as they show it — a
DatePicker instance yields its 45 strings, not the 2 stored in its component's own frames. For
the whole file the inventory lists the text layers stored in it (component definitions
included) unless `instances: true` is passed. A text that is hidden, or sits inside a hidden
layer, carries `hidden: true`.

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

Every paint, effect and typography value that comes from a shared style is the style's **live**
value, the one Figma draws and lays the text out with — not the copy cached on the node beside
the reference, which can be stale. `fig_node`, `fig_text` and `fig_instance` report the same live
values, and name the style whether it was published (`assetRef`) or not (`guid`).

A frame with Figma's "Auto" spacing comes back as `justifyContent: "space-between"` with no
`gap`: Figma ignores the stored gap there, and as a CSS `gap` it would become a minimum that
overflows a narrower box. `rowGap` appears only on a layout that wraps.

Typography is reported the way CSS reads it. `color` is the one fill that shows, with its
opacity folded into the alpha — iOS's secondary label is `#3C3C4399`, not an opaque `#3C3C43`;
text painted with several fills, or a gradient, has no single colour and reports `fills`
instead. Figma's "Auto" line height reads as `"auto"` (CSS `normal`, the font's natural line
height) rather than `"100%"`, and a percent letter spacing as `em`. `fig_text` and `fig_node`
use the same values.

Stroke weight, alignment, caps and dashes come back only for a node with a stroke that shows.
When the sides of a stroke are set independently, `strokeWeights` gives each side, e.g.
`{ "top": 0, "right": 0, "bottom": 0.5, "left": 0 }` for a hairline under a navigation bar —
`border-bottom: 0.5px solid` — and is then what Figma draws, whatever `strokeWeight` says.

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

An instance nested in another one can be explained by its sublayer id, e.g.
`I1340:17094;1147:11418`. Its own overrides are followed by the ones the enclosing instance
applies inside it, re-addressed from the nested instance and marked `"inherited": true`.

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

Library assets published from *other* files (styles, variables, components) cannot be resolved
offline; they come back as their opaque `assetRef` so you can see that they exist and where they
point.

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

Vector geometry lives in a separate binary blob format. `fig_node` reports the blob indices and
`fig_blob` hands you the raw bytes, but this server does not interpret them.

### 12. `fig_render` — a picture of a node

`guid` (any node, or a page), `format` (`png` | `svg`, default `png`), `scale` (default 2),
`maxSize` (longest edge, default 1568), `background` (`transparent` | `page`), `savePath`,
`maxNodes` (default 20000, counted in layers). A layer inside an instance (a sublayer id such
as `I1319:26210;55:2890`) is drawn as that instance shows it.

```jsonc
// → fig_render { "file": "…", "guid": "2:1339" }
// [image content, 268x80 PNG]
{ "root": { "guid": "2:1339", "name": "Frame 39", "type": "FRAME" },
  "bounds": { "x": 0, "y": 0, "w": 134, "h": 40 }, "width": 268, "height": 80, "scale": 2,
  "nodesVisited": 9, "nodesDrawn": 8, "svgBytes": 4757, "renderMs": 4.6, "rasterMs": 55.3,
  "unsupported": [], "approximated": [], "format": "png" }
```

What is drawn exactly, what is approximated and what is skipped: [rendering.md](rendering.md).

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
