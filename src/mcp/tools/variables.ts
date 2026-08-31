/** `fig_variables` — variable collections, their modes, and per-mode values. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { cursorArg, fileArg, handler, load, type ToolContext } from './context.js';
import { Packer, decodeCursor, encodeCursor, jsonResult, measure } from '../respond.js';
import { variableSetOf, variableSetView, variableView } from '../../model/variables.js';
import { str } from '../../model/access.js';

export const NAME = 'fig_variables';

export const DESCRIPTION = [
  'List the design tokens in the file: every variable collection (VARIABLE_SET) with its modes,',
  'and every variable with its value per mode — colours as hex, numbers and strings verbatim.',
  'Aliases are followed when the target variable lives in this file; a variable published from',
  'another library is returned as its opaque assetRef instead. Filter with `set` (collection',
  'name or guid) or `query` (substring of the variable name).',
].join(' ');

const DEFAULT_LIMIT = 100;

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Variables and modes',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        set: z.string().optional().describe('Only variables from this collection (name or guid).'),
        query: z.string().optional().describe('Case-insensitive substring of the variable name.'),
        includeSets: z
          .boolean()
          .optional()
          .describe('Include the collection list with their modes (default true).'),
        limit: z.number().int().min(1).max(300).optional().describe(`Default ${DEFAULT_LIMIT}.`),
        cursor: cursorArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(
      (args: {
        file: string;
        set?: string;
        query?: string;
        includeSets?: boolean;
        limit?: number;
        cursor?: string;
      }) => {
        const { index } = load(ctx, args.file);
        const needle = args.query?.toLowerCase();
        const setFilter = args.set?.toLowerCase();

        const matches = index.variables.filter((v) => {
          if (needle && !(str(v.node, 'name') ?? '').toLowerCase().includes(needle)) return false;
          if (!setFilter) return true;
          const set = variableSetOf(index, v);
          if (!set) return false;
          return (
            set.key.toLowerCase() === setFilter ||
            (str(set.node, 'name') ?? '').toLowerCase() === setFilter
          );
        });

        const { offset = 0 } = decodeCursor(args.cursor);
        const packer = new Packer<unknown>({ limit: args.limit ?? DEFAULT_LIMIT });
        let i = offset;
        for (; i < matches.length; i++) {
          const item = variableView(index, matches[i]!);
          if (!packer.add(item, measure(item))) break;
        }
        const truncated = packer.truncated && i < matches.length;

        return jsonResult(
          {
            totalSets: index.variableSets.length,
            totalVariables: index.variables.length,
            matching: matches.length,
            returned: packer.items.length,
            sets:
              args.includeSets === false || offset > 0
                ? undefined
                : index.variableSets.map((s) => variableSetView(index, s)),
            variables: packer.items,
            truncated: truncated || undefined,
            nextCursor: truncated ? encodeCursor({ offset: i }) : undefined,
            hint: truncated
              ? 'pass nextCursor to continue, or narrow with set / query'
              : undefined,
          },
          { listKey: 'variables' },
        );
      },
    ),
  );
}
