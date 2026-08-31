/** `fig_style` — the resolved, code-generation-oriented style of one node. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fileArg, handler, load, requireNode, type ToolContext } from './context.js';
import { jsonResult } from '../respond.js';
import { styleBlock } from '../../model/summarize.js';
import { textView } from '../../model/text.js';
import { str } from '../../model/access.js';

export const NAME = 'fig_style';

export const DESCRIPTION = [
  'The flattened style of one node, shaped for writing code: hex fills / strokes / effects,',
  'corner radii, typography, and auto-layout translated into CSS flexbox terms',
  '(display, direction, gap, padding, justifyContent, alignItems, sizing) plus how the node',
  'behaves inside its parent layout (flexGrow, alignSelf, margin).',
  'Shared styles and variable bindings are named whenever they resolve inside this file.',
].join(' ');

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Resolved style of a node',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        guid: z.string().describe('Node guid, e.g. "2:1339".'),
        includeRuns: z
          .boolean()
          .optional()
          .describe('For TEXT nodes, also return styled runs (default false).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args: { file: string; guid: string; includeRuns?: boolean }) => {
      const { index } = load(ctx, args.file);
      const t = requireNode(index, args.guid);
      const style = styleBlock(index, t);
      const text =
        str(t.node, 'type') === 'TEXT' ? textView(index, t, args.includeRuns === true) : undefined;
      return jsonResult({
        style,
        text: text ? { characters: text.characters, runs: text.runs } : undefined,
      });
    }),
  );
}
