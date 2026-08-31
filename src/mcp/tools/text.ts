/** `fig_text` — copy inventory, optionally with per-character styled runs. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { cursorArg, fileArg, handler, load, requireNode, type ToolContext } from './context.js';
import { Packer, decodeCursor, encodeCursor, jsonResult, measure } from '../respond.js';
import { compactStyle, textView } from '../../model/text.js';
import { breadcrumb } from '../../model/tree.js';
import { str } from '../../model/access.js';

export const NAME = 'fig_text';

export const DESCRIPTION = [
  'Extract every string of copy in the file (or in one subtree via `scope`), in document order:',
  'guid, layer name, the characters, the page, and the base typography (font, size, line-height,',
  'colour). With includeRuns:true each node also carries its styled runs — the mixed-format',
  'spans Figma stores per UTF-16 code unit — with only the fields each run overrides.',
  'Use this for copy audits and translation passes rather than walking the tree.',
].join(' ');

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Text inventory',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        scope: z.string().optional().describe('Only collect text inside this guid subtree.'),
        includeRuns: z
          .boolean()
          .optional()
          .describe('Include per-run style overrides (default false; costs many more tokens).'),
        includeStyle: z
          .boolean()
          .optional()
          .describe('Include font / size / line-height / colour per node (default true).'),
        includePath: z
          .boolean()
          .optional()
          .describe('Include the ancestor breadcrumb per node (default false; costs tokens).'),
        cursor: cursorArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(
      (args: {
        file: string;
        scope?: string;
        includeRuns?: boolean;
        includeStyle?: boolean;
        includePath?: boolean;
        cursor?: string;
      }) => {
        const { index } = load(ctx, args.file);
        const scope = args.scope ? requireNode(index, args.scope) : undefined;
        const range = scope ? index.subtreeRange(scope) : { start: 0, end: index.nodeCount };
        const includeRuns = args.includeRuns === true;
        const includeStyle = args.includeStyle !== false;
        const { after } = decodeCursor(args.cursor);

        const packer = new Packer<unknown>();
        let skipping = after !== undefined;
        let lastGuid: string | undefined;
        let totalTextNodes = 0;

        for (let i = range.start; i < range.end; i++) {
          const t = index.tree.ordered[i]!;
          if (str(t.node, 'type') !== 'TEXT') continue;
          const view = textView(index, t, includeRuns);
          if (!view) continue;
          totalTextNodes++;
          if (skipping) {
            if (t.key === after) skipping = false;
            continue;
          }
          if (packer.full) continue;

          const item = {
            guid: t.key,
            name: str(t.node, 'name'),
            characters: view.characters,
            page: t.page ? str(t.page.node, 'name') : undefined,
            path: args.includePath === true ? breadcrumb(t) || undefined : undefined,
            style: includeStyle ? compactStyle(view.baseStyle) : undefined,
            hasStyledRuns: view.hasStyledRuns || undefined,
            runs: includeRuns ? view.runs : undefined,
          };
          if (packer.add(item, measure(item))) lastGuid = t.key;
        }

        const truncated = packer.truncated;
        return jsonResult(
          {
            scope: scope?.key,
            totalTextNodes,
            returned: packer.items.length,
            texts: packer.items,
            truncated: truncated || undefined,
            nextCursor: truncated && lastGuid ? encodeCursor({ after: lastGuid }) : undefined,
            hint: truncated
              ? 'pass nextCursor to continue, or narrow with scope / includeRuns:false'
              : undefined,
          },
          { listKey: 'texts' },
        );
      },
    ),
  );
}
