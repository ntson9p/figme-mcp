/** `fig_blob` — raw access to `message.blobs`, the escape hatch for vector payloads. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fileArg, handler, load, type ToolContext } from './context.js';
import { jsonResult } from '../respond.js';
import { bytes as byteField } from '../../model/access.js';

export const NAME = 'fig_blob';

export const DESCRIPTION = [
  'Return the raw bytes of one entry in the file\'s blob table. Vector geometry, glyph outlines',
  'and similar bulk payloads are stored there and referenced by index from fields such as',
  '`vectorData.vectorNetworkBlob` and `Path.commandsBlob` (fig_node reports these as',
  '`vector.networkBlob` / `vector.fillBlobs`). This server does not decode the vector-network',
  'format — you get the bytes, base64 or hex, truncated to maxBytes with a flag when longer.',
].join(' ');

const DEFAULT_MAX_BYTES = 65_536;

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Raw blob bytes',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        index: z.number().int().min(0).describe('Blob index, as reported by fig_node `vector.*`.'),
        encoding: z.enum(['base64', 'hex']).optional().describe('Default "base64".'),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(262_144)
          .optional()
          .describe(`Bytes to return before truncating (default ${DEFAULT_MAX_BYTES}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args: { file: string; index: number; encoding?: 'base64' | 'hex'; maxBytes?: number }) => {
      const { fig } = load(ctx, args.file);
      const blob = fig.blobs[args.index];
      if (!blob) {
        throw new Error(
          `blob index ${args.index} is out of range; this file has ${fig.blobs.length} blobs (0..${
            fig.blobs.length - 1
          })`,
        );
      }
      const raw = byteField(blob, 'bytes');
      if (!raw) throw new Error(`blob ${args.index} carries no bytes field`);

      const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
      const encoding = args.encoding ?? 'base64';
      const truncated = raw.length > maxBytes;
      const slice = Buffer.from(truncated ? raw.subarray(0, maxBytes) : raw);

      return jsonResult({
        index: args.index,
        byteLength: raw.length,
        returnedBytes: slice.length,
        encoding,
        data: slice.toString(encoding),
        truncated: truncated || undefined,
        hint: truncated ? `raise maxBytes to read past ${maxBytes} bytes` : undefined,
        blobCount: fig.blobs.length,
      });
    }),
  );
}
