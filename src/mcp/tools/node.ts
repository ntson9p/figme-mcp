/** `fig_node` — inspect exactly one node at a chosen detail level. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fileArg, handler, load, requireNode, type ToolContext } from './context.js';
import { jsonResult } from '../respond.js';
import { nodeDetail, nodeRaw, summarize } from '../../model/summarize.js';

export const NAME = 'fig_node';

export const DESCRIPTION = [
  'Inspect one node by guid (e.g. "2:1339").',
  'detail:"full" (default) gives geometry, fills/strokes/effects as hex colours, corner radii,',
  'auto-layout, text basics, component and variable links, plus child summaries.',
  'detail:"raw" returns the decoded Figma record verbatim — the escape hatch for fields this',
  'server does not map yet; it is limited to one node per call and can be large.',
].join(' ');

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Inspect a node',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        guid: z.string().describe('Node guid, "sessionID:localID", e.g. "2:1339". A Figma node-id or link works too.'),
        detail: z.enum(['summary', 'full', 'raw']).optional().describe('Default "full".'),
        includeChildren: z
          .boolean()
          .optional()
          .describe('Include summaries of direct children (default true).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(
      (args: {
        file: string;
        guid: string;
        detail?: 'summary' | 'full' | 'raw';
        includeChildren?: boolean;
      }) => {
        const { index } = load(ctx, args.file);
        const t = requireNode(index, args.guid);
        const detail = args.detail ?? 'full';
        const includeChildren = args.includeChildren !== false;

        if (detail === 'summary') {
          return jsonResult({ detail, node: summarize(t, { page: true }) });
        }
        if (detail === 'raw') {
          // §5.2: never more than one raw node per call.
          return jsonResult({
            detail,
            node: nodeRaw(t),
            children: includeChildren ? t.children.map((c) => summarize(c)) : undefined,
            note: 'raw = the decoded NodeChange as stored in the file; bytes are hex, int64 are strings',
          });
        }
        return jsonResult({
          detail,
          node: nodeDetail(index, t, { children: includeChildren }),
        });
      },
    ),
  );
}
