/** `fig_text` — copy inventory, optionally with per-character styled runs. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  cursorArg,
  fileArg,
  handler,
  instancesArg,
  load,
  resolveSceneRoot,
  type ToolContext,
} from './context.js';
import { Packer, decodeCursor, encodeCursor, jsonResult, measure } from '../respond.js';
import { compactStyle, textView } from '../../model/text.js';
import { breadcrumb, type TreeNode } from '../../model/tree.js';
import { isHidden } from '../../model/scene.js';
import { str } from '../../model/access.js';
import type { FileIndex } from '../../model/index.js';

export const NAME = 'fig_text';

export const DESCRIPTION = [
  'Extract every string of copy in the file (or in one subtree via `scope`), in document order:',
  'guid, layer name, the characters, the page, and the base typography (font, size, line-height,',
  'colour). With includeRuns:true each node also carries its styled runs — the mixed-format',
  'spans Figma stores per UTF-16 code unit — with only the fields each run overrides. With a',
  '`scope`, the text inside component instances is included as those instances show it.',
  'Use this for copy audits and translation passes rather than walking the tree.',
].join(' ');

/** Every node under `root`, depth-first and pre-order; instances are opened only when asked. */
function* walk(root: TreeNode, expand: boolean): Generator<TreeNode> {
  const stack: TreeNode[] = [root];
  while (stack.length) {
    const t = stack.pop()!;
    yield t;
    if (!expand && str(t.node, 'type') === 'INSTANCE') continue;
    const kids = t.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
}

/** The stored nodes in DFS order — the whole-file inventory, without walking any instance. */
function* stored(index: FileIndex): Generator<TreeNode> {
  for (const t of index.tree.ordered) yield t;
}

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Text inventory',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        scope: z.string().optional().describe('Only collect text inside this guid subtree. A Figma node-id or link works too.'),
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
        instances: instancesArg(
          'Default true with a `scope`; for the whole file the default lists the text layers ' +
            'stored in it (component definitions included) without walking every instance.',
        ),
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
        instances?: boolean;
        cursor?: string;
      }) => {
        const { index } = load(ctx, args.file);
        const expand = args.instances ?? args.scope !== undefined;
        const scope = args.scope ? resolveSceneRoot(index, args.scope) : undefined;
        const nodes =
          scope || expand ? walk(scope ?? resolveSceneRoot(index, undefined), expand) : stored(index);
        const includeRuns = args.includeRuns === true;
        const includeStyle = args.includeStyle !== false;
        const { after } = decodeCursor(args.cursor);

        const packer = new Packer<unknown>();
        let skipping = after !== undefined;
        let lastGuid: string | undefined;
        let totalTextNodes = 0;

        for (const t of nodes) {
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
            hidden: isHidden(t) || undefined,
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
