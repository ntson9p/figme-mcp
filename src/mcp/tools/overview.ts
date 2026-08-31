/** `fig_overview` — parse (or hit the cache) and orient: counts, pages, warnings. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fileArg, handler, load, type ToolContext } from './context.js';
import { jsonResult } from '../respond.js';
import { str } from '../../model/access.js';

export const NAME = 'fig_overview';

export const DESCRIPTION = [
  'Open a local Figma .fig file and summarise it: document name, export date, node counts by',
  'type, the page list, and how many components / variables / images it holds.',
  'START HERE. Then fig_tree a page, then fig_node / fig_style on interesting guids;',
  'fig_find jumps straight to a name or a piece of text. Everything is read-only and offline.',
].join(' ');

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Figma file overview',
      description: DESCRIPTION,
      inputSchema: { file: fileArg },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(({ file }: { file: string }) => {
      const { fig, index, path } = load(ctx, file);
      const counts = Object.fromEntries(
        Object.entries(index.typeCounts).sort((a, b) => b[1] - a[1]),
      );
      return jsonResult({
        file: path,
        name: fig.meta?.file_name,
        exportedAt: fig.meta?.exported_at,
        container: fig.container,
        formatVersion: fig.version,
        nodes: index.nodeCount,
        pages: index.pages.map((p) => ({
          guid: p.key,
          name: str(p.node, 'name'),
          children: p.children.length,
        })),
        nodeTypes: counts,
        components: index.symbols.length,
        variables: index.variables.length,
        variableSets: index.variableSets.length,
        images: index.imageHashes.size,
        blobs: fig.blobs.length,
        textNodes: index.textNodeCount,
        orphans: index.tree.orphans.length,
        warnings: fig.warnings.length ? fig.warnings : undefined,
        parseMs: Math.round(fig.parseMs),
        nextSteps: 'fig_tree { root: <page guid>, format: "outline" } to explore a page',
      });
    }),
  );
}
