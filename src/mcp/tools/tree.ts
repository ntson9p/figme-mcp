/** `fig_tree` — shallow-by-default structural exploration of a subtree. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { cursorArg, fileArg, handler, load, resolveRoot, type ToolContext } from './context.js';
import { Packer, decodeCursor, encodeCursor, jsonResult, measure, textResult } from '../respond.js';
import { outlineLine, summarize } from '../../model/summarize.js';
import { str } from '../../model/access.js';

export const NAME = 'fig_tree';

export const DESCRIPTION = [
  'List the layers under a node, breadth-limited by depth (default 2, max 6).',
  'Returns a FLAT list in document order; each entry carries `depth` (relative to the requested',
  'root) and `parent`, so the hierarchy is reconstructable, and `children` (count) so you can',
  'see where to deepen. format:"outline" returns indented text lines instead of JSON and is',
  'roughly 4x denser for browsing. Large subtrees are truncated with truncated:true and a',
  'nextCursor you can pass back to continue.',
].join(' ');

const MAX_DEPTH = 6;

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Explore the layer tree',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        root: z
          .string()
          .optional()
          .describe('Guid to start from, e.g. "2:1339"; a Figma node-id or link works too. Defaults to the DOCUMENT node.'),
        depth: z
          .number()
          .int()
          .min(0)
          .max(MAX_DEPTH)
          .optional()
          .describe(`Levels below the root to include (default 2, max ${MAX_DEPTH}).`),
        types: z
          .array(z.string())
          .optional()
          .describe('Only include these node types, e.g. ["FRAME","TEXT"]. Depth still applies.'),
        format: z.enum(['json', 'outline']).optional().describe('Default "json".'),
        cursor: cursorArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(
      (args: {
        file: string;
        root?: string;
        depth?: number;
        types?: string[];
        format?: 'json' | 'outline';
        cursor?: string;
      }) => {
        const { index } = load(ctx, args.file);
        const rootNode = resolveRoot(index, args.root);
        const depth = args.depth ?? 2;
        const format = args.format ?? 'json';
        const typeFilter = args.types?.length ? new Set(args.types) : undefined;
        const { after } = decodeCursor(args.cursor);
        const { start, end } = index.subtreeRange(rootNode);

        const packer = new Packer<unknown>();
        let skipping = after !== undefined;
        let lastGuid: string | undefined;
        let matched = 0;

        for (let i = start; i < end; i++) {
          const t = index.tree.ordered[i]!;
          const relDepth = t.depth - rootNode.depth;
          if (relDepth > depth) continue;
          if (typeFilter && !typeFilter.has(str(t.node, 'type') ?? '')) continue;
          if (skipping) {
            if (t.key === after) skipping = false;
            continue;
          }
          matched++;
          const item =
            format === 'outline'
              ? outlineLine(t, relDepth)
              : { ...summarize(t), depth: relDepth, parent: t.parent?.key };
          if (!packer.add(item, measure(item))) {
            matched--;
            break;
          }
          lastGuid = t.key;
        }

        const truncated = packer.truncated;
        const nextCursor = truncated && lastGuid ? encodeCursor({ after: lastGuid }) : undefined;
        const hint = truncated
          ? 'response budget reached: pass nextCursor to continue, or lower depth / add a types filter'
          : undefined;

        if (format === 'outline') {
          const header = [
            `root ${rootNode.key} ${JSON.stringify(str(rootNode.node, 'name') ?? '')} depth<=${depth}`,
            ...(packer.items as string[]),
          ];
          if (truncated) {
            header.push('', `... truncated after ${matched} nodes. nextCursor: ${nextCursor}`);
          }
          return textResult(header.join('\n'));
        }

        return jsonResult(
          {
            root: summarize(rootNode),
            depth,
            count: matched,
            nodes: packer.items,
            truncated: truncated || undefined,
            nextCursor,
            hint,
          },
          { listKey: 'nodes' },
        );
      },
    ),
  );
}
