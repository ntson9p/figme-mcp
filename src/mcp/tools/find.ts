/** `fig_find` — full-text search over layer names and text content. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  cursorArg,
  fileArg,
  handler,
  instancesArg,
  load,
  requireNode,
  resolveSceneRoot,
  type ToolContext,
} from './context.js';
import { Packer, decodeCursor, encodeCursor, jsonResult, measure } from '../respond.js';
import { summarize } from '../../model/summarize.js';
import { breadcrumb, type TreeNode } from '../../model/tree.js';
import { obj, str } from '../../model/access.js';
import type { FileIndex } from '../../model/index.js';

export const NAME = 'fig_find';

export const DESCRIPTION = [
  'Search a file for nodes by name and by text content (case-insensitive substring), optionally',
  'restricted to node types and/or a subtree. Each hit comes back with the page it lives on, a',
  'breadcrumb of ancestor names, and which field matched — so you can jump straight to a guid',
  'and then call fig_node / fig_style. Omit `query` to list every node of the given types.',
  'instances:true also searches the layers component instances show, with their overrides.',
].join(' ');

const DEFAULT_LIMIT = 50;
const TEXT_PREVIEW = 160;

interface Candidate {
  readonly t: TreeNode;
  readonly nameLower: string;
  readonly textLower: string | undefined;
}

/** The prebuilt search index over the stored nodes, restricted to a stored subtree. */
function* storedCandidates(index: FileIndex, scope: TreeNode | undefined): Generator<Candidate> {
  const range = scope ? index.subtreeRange(scope) : { start: 0, end: index.nodeCount };
  const entries = index.search();
  for (let i = range.start; i < range.end; i++) yield entries[i]!;
}

/** Every layer under `root` as Figma shows it, instances opened, depth-first and pre-order. */
function* sceneCandidates(root: TreeNode): Generator<Candidate> {
  const stack: TreeNode[] = [root];
  while (stack.length) {
    const t = stack.pop()!;
    const characters = str(obj(t.node, 'textData'), 'characters');
    yield {
      t,
      nameLower: (str(t.node, 'name') ?? '').toLowerCase(),
      textLower: characters?.toLowerCase(),
    };
    const kids = t.children;
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
}

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Search layers and text',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring matched against layer names AND text content.'),
        types: z.array(z.string()).optional().describe('Restrict to node types, e.g. ["TEXT"].'),
        scope: z.string().optional().describe('Only search inside this guid subtree. A Figma node-id or link works too.'),
        limit: z.number().int().min(1).max(300).optional().describe(`Default ${DEFAULT_LIMIT}.`),
        instances: instancesArg(
          'Default false: the search covers the layers stored in the file. Best with a `scope`.',
        ),
        cursor: cursorArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(
      (args: {
        file: string;
        query?: string;
        types?: string[];
        scope?: string;
        limit?: number;
        instances?: boolean;
        cursor?: string;
      }) => {
        const { index } = load(ctx, args.file);
        if (!args.query && !args.types?.length) {
          throw new Error('fig_find needs at least a `query` or a `types` filter');
        }
        const needle = args.query?.toLowerCase();
        const typeFilter = args.types?.length ? new Set(args.types) : undefined;
        const expand = args.instances === true;
        const scope = args.scope
          ? expand
            ? resolveSceneRoot(index, args.scope)
            : requireNode(index, args.scope)
          : undefined;
        const candidates = expand
          ? sceneCandidates(scope ?? resolveSceneRoot(index, undefined))
          : storedCandidates(index, scope);
        const { after } = decodeCursor(args.cursor);

        const packer = new Packer<unknown>({ limit: args.limit ?? DEFAULT_LIMIT });
        let skipping = after !== undefined;
        let lastGuid: string | undefined;
        let totalMatches = 0;

        for (const e of candidates) {
          if (typeFilter && !typeFilter.has(str(e.t.node, 'type') ?? '')) continue;
          let matchedOn: 'name' | 'text' | 'type' | undefined;
          if (!needle) matchedOn = 'type';
          else if (e.nameLower.includes(needle)) matchedOn = 'name';
          else if (e.textLower?.includes(needle)) matchedOn = 'text';
          if (!matchedOn) continue;

          totalMatches++;
          if (skipping) {
            if (e.t.key === after) skipping = false;
            continue;
          }
          // Keep scanning after the packer fills so `totalMatches` stays exact.
          if (packer.full) continue;

          const characters = matchedOn === 'text' ? str(obj(e.t.node, 'textData'), 'characters') : undefined;
          const item = {
            ...summarize(e.t),
            matchedOn,
            page: e.t.page ? str(e.t.page.node, 'name') : undefined,
            path: breadcrumb(e.t) || undefined,
            text:
              characters && characters.length > TEXT_PREVIEW
                ? `${characters.slice(0, TEXT_PREVIEW)}...`
                : characters,
          };
          if (packer.add(item, measure(item))) lastGuid = e.t.key;
        }

        const truncated = packer.truncated;
        return jsonResult(
          {
            query: args.query,
            types: args.types,
            scope: scope?.key,
            totalMatches,
            returned: packer.items.length,
            results: packer.items,
            truncated: truncated || undefined,
            nextCursor: truncated && lastGuid ? encodeCursor({ after: lastGuid }) : undefined,
            hint: truncated
              ? 'more matches available: pass nextCursor, or narrow with types/scope'
              : undefined,
          },
          { listKey: 'results' },
        );
      },
    ),
  );
}
