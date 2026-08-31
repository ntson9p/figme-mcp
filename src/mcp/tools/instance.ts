/** `fig_instance` — what one INSTANCE changes relative to its component. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fileArg, handler, load, requireNode, type ToolContext } from './context.js';
import { jsonResult } from '../respond.js';
import { instanceView } from '../../model/components.js';
import { str } from '../../model/access.js';

export const NAME = 'fig_instance';

export const DESCRIPTION = [
  'Explain one component INSTANCE: which SYMBOL it points at, its component-property',
  'assignments with the property names resolved, and every override it applies — each with the',
  'path down into the component, the node that path addresses, and the fields it changes.',
  'Use it to see how an instance differs from its component without diffing two subtrees.',
].join(' ');

const MAX_OVERRIDES = 60;

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Instance overrides',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        guid: z.string().describe('Guid of an INSTANCE node, e.g. "2:1329".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args: { file: string; guid: string }) => {
      const { index } = load(ctx, args.file);
      const t = requireNode(index, args.guid);
      const type = str(t.node, 'type');
      if (type !== 'INSTANCE') {
        throw new Error(
          `node ${args.guid} is a ${type}, not an INSTANCE — ` +
            'use fig_node for other node types, or fig_components to list SYMBOLs',
        );
      }
      const { overrides = [], ...instance } = instanceView(index, t);
      const truncated = overrides.length > MAX_OVERRIDES;
      return jsonResult(
        {
          instance,
          overrideCount: overrides.length,
          overrides: truncated ? overrides.slice(0, MAX_OVERRIDES) : overrides,
          truncated: truncated || undefined,
          hint: truncated
            ? `showing the first ${MAX_OVERRIDES} of ${overrides.length} overrides; ` +
              'use fig_node detail:"raw" on this guid for the complete record'
            : undefined,
        },
        { listKey: 'overrides' },
      );
    }),
  );
}
