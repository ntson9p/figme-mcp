/** `fig_components` — the component (SYMBOL) catalogue. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { cursorArg, fileArg, handler, load, type ToolContext } from './context.js';
import { Packer, decodeCursor, encodeCursor, jsonResult, measure } from '../respond.js';
import { componentView } from '../../model/components.js';
import { str } from '../../model/access.js';

export const NAME = 'fig_components';

export const DESCRIPTION = [
  'List the components (SYMBOL nodes) defined in the file: guid, name, description, the',
  'component-set it belongs to when it is a variant, its property definitions with defaults, and',
  'how many instances of it exist. Filter with `query` (case-insensitive substring of the name).',
  'Sorted by instance count, most-used first, so the load-bearing parts of the design system',
  'come back before one-off symbols. Follow up with fig_instance on a specific INSTANCE guid.',
].join(' ');

const DEFAULT_LIMIT = 50;

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Component catalogue',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        query: z.string().optional().describe('Case-insensitive substring of the component name.'),
        limit: z.number().int().min(1).max(300).optional().describe(`Default ${DEFAULT_LIMIT}.`),
        cursor: cursorArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args: { file: string; query?: string; limit?: number; cursor?: string }) => {
      const { index } = load(ctx, args.file);
      const needle = args.query?.toLowerCase();
      const matches = index.symbols.filter(
        (s) => !needle || (str(s.node, 'name') ?? '').toLowerCase().includes(needle),
      );
      // Stable order: most-instantiated first, guid as the tiebreak so cursors never drift.
      const sorted = [...matches].sort((a, b) => {
        const d = (index.instanceCounts.get(b.key) ?? 0) - (index.instanceCounts.get(a.key) ?? 0);
        return d !== 0 ? d : a.key < b.key ? -1 : 1;
      });

      const { offset = 0 } = decodeCursor(args.cursor);
      const packer = new Packer<unknown>({ limit: args.limit ?? DEFAULT_LIMIT });
      let i = offset;
      for (; i < sorted.length; i++) {
        const item = componentView(index, sorted[i]!);
        if (!packer.add(item, measure(item))) break;
      }
      const truncated = packer.truncated && i < sorted.length;

      return jsonResult(
        {
          totalComponents: index.symbols.length,
          matching: sorted.length,
          returned: packer.items.length,
          components: packer.items,
          truncated: truncated || undefined,
          nextCursor: truncated ? encodeCursor({ offset: i }) : undefined,
          hint: truncated ? 'pass nextCursor to continue, or narrow with query' : undefined,
        },
        { listKey: 'components' },
      );
    }),
  );
}
