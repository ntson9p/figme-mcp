# figme

An [MCP](https://modelcontextprotocol.io) server that lets your AI agent read Figma `.fig`
files — offline, with no Figma account or API token.

[![npm](https://img.shields.io/npm/v/figme-mcp)](https://www.npmjs.com/package/figme-mcp)
[![Node.js](https://img.shields.io/node/v/figme-mcp)](https://nodejs.org)
[![License: MIT](https://img.shields.io/npm/l/figme-mcp)](LICENSE)

Save a design from Figma as a `.fig` file, and your agent can read everything in it: layers and
layout, colours, text, components, design tokens and images. figme can also draw any frame as a
picture, so the agent can compare what it built with the design.

```
you: "what does the tab component in design.fig look like?"

fig_overview  → 10 pages, 2,046 components, 273 variables, 212 images
fig_find      → "lv2/tab/large" is 2:1337, on page "Page 1"
fig_style     → display:flex, direction:row, gap:8, padding:"8px 16px",
                cornerRadius:4, stroke #FFFFFF bound to variable "tab/large/underline"
                (active #FFFFFF / inactive #333333)
```

## Why figme

- **No account, token or network.** figme reads the file on your disk and never contacts
  figma.com.
- **Everything in the file.** Layers and geometry, auto-layout, fills, strokes, effects, text with
  mixed styles, components and instances, variables, prototype links and images. Layout comes
  back as CSS flexbox, colours as hex, and colours bound to variables keep their token names.
- **What Figma shows, not just what it stores.** The layers inside a component instance come
  back with the instance's overrides applied, under the ids Figma itself gives them, and a
  shared style reports its live value rather than the stale copy cached beside it.
- **Pictures as well as numbers.** `fig_render` draws any layer as a PNG or SVG.
- **Small responses.** Even on a 116,000-node file, a response stays around 20 KB. Results are
  shallow by default, filterable and paged.
- **Robust to Figma updates.** Every `.fig` carries the schema that describes it, and figme decodes
  the file with that schema, so fields Figma adds later don't break it.

## Quick start

You need [Node.js](https://nodejs.org) 22.15 or newer.

**1. Save the design as a `.fig` file.** In Figma, choose **File → Save local copy…** If it's a
Community file, click **Open in Figma** first.

**2. Add figme to your agent.** In Claude Code:

```bash
claude mcp add figme -- npx -y figme-mcp
```

For Cursor, VS Code, Windsurf and other clients, see [Set up your client](#set-up-your-client).

**3. Ask.** Give the full path to the file, and paste a Figma link if you have one:

> Using figme, read /Users/me/Desktop/App.fig and build this frame as a React component:
> https://www.figma.com/design/AbC123/App?node-id=3017-121

The agent picks the tools from there. A few more things to try:

- *"List the pages and the most-used components in /Users/me/Desktop/App.fig."*
- *"Turn the colour variables in /Users/me/Desktop/App.fig into CSS custom properties."*
- *"Render the sign-in screen in /Users/me/Desktop/App.fig to /Users/me/Desktop/sign-in.png."*

## Set up your client

Every client runs the same command, `npx -y figme-mcp`. Only the place you put it changes.

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add figme -- npx -y figme-mcp           # this project
claude mcp add -s user figme -- npx -y figme-mcp   # every project
```

To share the server with everyone who works on a repository, commit a `.mcp.json` at its root:

```json
{
  "mcpServers": {
    "figme": { "command": "npx", "args": ["-y", "figme-mcp"] }
  }
}
```

The Claude Code extensions for VS Code and JetBrains use this same configuration. They don't read
the editor's own MCP settings.

</details>

<details>
<summary><b>Cursor</b></summary>

Add this to `~/.cursor/mcp.json` for every project, or to `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "figme": { "command": "npx", "args": ["-y", "figme-mcp"] }
  }
}
```

</details>

<details>
<summary><b>VS Code (GitHub Copilot)</b></summary>

From a terminal:

```bash
code --add-mcp '{"name":"figme","command":"npx","args":["-y","figme-mcp"]}'
```

Or add this to `.vscode/mcp.json`. VS Code uses the key `servers`, not `mcpServers`:

```json
{
  "servers": {
    "figme": { "type": "stdio", "command": "npx", "args": ["-y", "figme-mcp"] }
  }
}
```

Then switch the Chat view to **Agent** mode.

</details>

<details>
<summary><b>Windsurf</b></summary>

Add this to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "figme": { "command": "npx", "args": ["-y", "figme-mcp"] }
  }
}
```

</details>

<details>
<summary><b>Other clients</b></summary>

Any client that can start a local (stdio) MCP server works. Give it:

```json
{ "command": "npx", "args": ["-y", "figme-mcp"] }
```

Config file locations change between client releases. If a path above doesn't match what you
see, check your client's MCP documentation.

</details>

**On Windows**, some clients can't find `npx` by themselves. If the server doesn't start, run it
through `cmd`:

```json
{ "command": "cmd", "args": ["/c", "npx", "-y", "figme-mcp"] }
```

## Tips

- **Always give the full path to the file, even with a link.** A Figma link can't tell figme which
  file on your disk it belongs to, and a relative path is resolved from wherever your client
  started the server.
- **Don't let the agent open the Figma link.** The page needs a login, so the agent gets nothing
  useful back, and it may then invent a design from the words in the URL. figme tells agents not
  to; if yours tries anyway, stop it.
- **"Node not found"** usually means the saved file isn't the one the link points to. Compare the
  document name that `fig_overview` reports with the name in the link, or ask the agent to find
  the layer by name instead.
- **Big files need memory.** A 39 MB `.fig` takes about 900 MB of RAM once parsed, and figme keeps
  up to 4 parsed files. On a smaller machine, keep just one:

  ```json
  { "command": "npx", "args": ["-y", "figme-mcp", "--max-files", "1"] }
  ```

## Tools

Your agent picks these on its own; you don't need to name them.

| Tool | What it gives the agent |
|---|---|
| `fig_overview` | The pages, node counts, and how many components, variables and images the file has |
| `fig_tree` | The layer tree under a node, a few levels at a time, instances opened |
| `fig_node` | One layer in detail: size, position, corner radii, auto-layout, children |
| `fig_find` | Layers whose name or text contains a string |
| `fig_text` | All the text, with fonts and mixed styles |
| `fig_style` | Fills, strokes, effects and typography, with auto-layout as CSS flexbox |
| `fig_components` | The components, their properties, and how often each is used |
| `fig_instance` | What an instance changes from its component |
| `fig_variables` | Design tokens: every collection, mode and value |
| `fig_image` | Embedded images, and the file's thumbnail |
| `fig_blob` | Raw vector data, for anything the other tools don't decode |
| `fig_render` | A PNG or SVG picture of any layer or page |

Parameters and example responses for each are in [docs/tools.md](docs/tools.md).

## Limitations

- **Read-only.** figme never changes your `.fig`. It writes a file only when you ask `fig_image`
  or `fig_render` to save one.
- **A snapshot, not a live link.** A `.fig` holds the design as it was when you saved it. When the
  design changes, save it again; figme picks up the new file.
- **Rendering is close, not pixel-perfect.** `fig_render` approximates a few effects, such as
  background blur and angular gradients, and skips a few things, such as emoji. Every render
  lists what it approximated or skipped. See [docs/rendering.md](docs/rendering.md).
- **Libraries from other files aren't included.** Styles, variables and components published from
  another file show up as references, without their values.
- **Vector paths aren't decoded.** `fig_blob` returns their raw bytes.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to build
from source and run the tests, and how the parser works.

## License

[MIT](LICENSE)
