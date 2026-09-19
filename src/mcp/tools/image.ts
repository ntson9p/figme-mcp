/** `fig_image` — the bitmaps embedded in the file (image fills and the document thumbnail). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fileArg, handler, load, requireNode, type ToolContext } from './context.js';
import { jsonResult, type CallToolResult } from '../respond.js';
import { sniffImage } from '../../fig/imagemeta.js';
import { nodeImageHashes } from '../../model/index.js';
import { str } from '../../model/access.js';

export const NAME = 'fig_image';

export const DESCRIPTION = [
  'Fetch a bitmap stored inside the .fig: pass `hash` (the 40-hex image id reported by',
  'fig_node / fig_style on an image paint), or `guid` to take the image(s) used by that node, or',
  'hash:"thumbnail" for the document preview. Small images come back as viewable image content;',
  'larger ones come back as metadata (mime, byte size, pixel dimensions) — give `savePath` to',
  'write the exact bytes to disk instead. NOTE: a .fig contains no rendered pictures of frames,',
  'only the bitmaps placed in image fills plus thumbnail.png, so this cannot screenshot a design.',
].join(' ');

/** Above this, base64 inlining is more harm than help; the caller gets metadata + savePath. */
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Embedded image',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        hash: z
          .string()
          .optional()
          .describe('40-hex image hash, or the literal "thumbnail" for thumbnail.png.'),
        guid: z.string().optional().describe('Node guid; uses the image fills on that node. A Figma node-id or link works too.'),
        savePath: z
          .string()
          .optional()
          .describe('Write the bytes to this path (parent directories are created) instead of inlining.'),
      },
      // Not read-only: savePath writes a file. Nothing is ever written back into the .fig.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handler((args: { file: string; hash?: string; guid?: string; savePath?: string }): CallToolResult => {
      const { fig, index } = load(ctx, args.file);
      const zip = fig.zip;
      if (!zip) {
        throw new Error('this .fig is a bare fig-kiwi stream and carries no embedded image entries');
      }

      let hash = args.hash;
      if (!hash && args.guid) {
        const t = requireNode(index, args.guid);
        const hashes = nodeImageHashes(t.node);
        if (hashes.length === 0) {
          throw new Error(
            `node ${args.guid} (${str(t.node, 'type') ?? '?'}) has no image fills — ` +
              'fig_node shows an `images` array on nodes that do',
          );
        }
        if (hashes.length > 1) {
          return jsonResult({
            guid: t.key,
            name: str(t.node, 'name'),
            images: hashes,
            hint: 'this node uses several images; call again with one of these `hash` values',
          });
        }
        hash = hashes[0]!;
      }
      if (!hash) throw new Error('fig_image needs either `hash` or `guid`');

      const entry = hash === 'thumbnail' ? 'thumbnail.png' : `images/${hash}`;
      const bytes = zip.read(entry);
      if (!bytes) {
        throw new Error(
          `no image "${hash}" in this file (${index.imageHashes.size} hashes are referenced by ` +
            'paints; use fig_node on a node with an image fill to get one, or hash:"thumbnail")',
        );
      }

      const meta = sniffImage(bytes);
      const payload: Record<string, unknown> = {
        hash,
        entry,
        mime: meta.mime,
        byteLength: meta.byteLength,
        width: meta.width,
        height: meta.height,
      };

      if (args.savePath) {
        const abs = path.resolve(args.savePath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, bytes);
        return jsonResult({ ...payload, savedTo: abs, bytesWritten: bytes.length });
      }

      if (bytes.length > MAX_INLINE_BYTES) {
        return jsonResult({
          ...payload,
          inlined: false,
          hint: `image is larger than ${MAX_INLINE_BYTES} bytes; call again with savePath to write it to disk`,
        });
      }

      return {
        content: [
          { type: 'image', data: bytes.toString('base64'), mimeType: meta.mime },
          { type: 'text', text: JSON.stringify({ ...payload, inlined: true }) },
        ],
      };
    }),
  );
}
