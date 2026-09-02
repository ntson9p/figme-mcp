/** `fig_render` — a picture of any node, rendered entirely from the file's own data. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fileArg, handler, load, type ToolContext } from './context.js';
import { jsonResult, textResult, HARD_CAP, type CallToolResult } from '../respond.js';
import {
  DEFAULT_MAX_SIZE,
  DEFAULT_SCALE,
  HARD_MAX_SIZE,
  renderNode,
  type RenderReport,
} from '../../render/index.js';
import { HARD_MAX_NODES } from '../../render/export.js';

export const NAME = 'fig_render';

export const DESCRIPTION = [
  'Render a node — frame, component, instance, group, shape, text, or a whole page — to a PNG',
  'the model can look at, or to SVG. Fully offline: geometry, text outlines and images all come',
  'from the file. Rendering is best-effort: read `approximated` and `unsupported` in the report',
  'before trusting fine details; exact values remain available from fig_node / fig_style /',
  'fig_text. Default output is PNG at 2x, capped to 1568 px on the longest edge; use `savePath`',
  'to write a file instead of inlining it.',
].join(' ');

/** Above this, base64 inlining costs the caller more than it is worth. */
const MAX_INLINE_PNG = 2 * 1024 * 1024;
/** An SVG longer than this must go to disk rather than into the conversation. */
const MAX_INLINE_SVG = 50_000;
/** Keep the JSON block well inside the response budget. */
const MAX_FEATURE_ENTRIES = 20;

interface RenderArgs {
  file: string;
  guid: string;
  format?: 'png' | 'svg';
  scale?: number;
  maxSize?: number;
  background?: 'transparent' | 'page';
  savePath?: string;
  maxNodes?: number;
}

/** The report as the tool returns it: capped, and without the tester-only feature list. */
function toolReport(report: RenderReport, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { featuresPresent: _ignored, ...rest } = report;
  return {
    ...rest,
    unsupported: report.unsupported.slice(0, MAX_FEATURE_ENTRIES),
    approximated: report.approximated.slice(0, MAX_FEATURE_ENTRIES),
    ...extra,
  };
}

function write(savePath: string, data: Uint8Array | string): string {
  const abs = path.resolve(savePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof data === 'string' ? data : Buffer.from(data));
  return abs;
}

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    NAME,
    {
      title: 'Render a node to an image',
      description: DESCRIPTION,
      inputSchema: {
        file: fileArg,
        guid: z
          .string()
          .describe('Node to render, e.g. "2:1339". A page guid renders the whole page, downscaled to fit maxSize.'),
        format: z
          .enum(['png', 'svg'])
          .optional()
          .describe('Default "png". Falls back to SVG text when the optional rasterizer is not installed.'),
        scale: z
          .number()
          .min(0.1)
          .max(4)
          .optional()
          .describe(`Device scale factor. Default ${DEFAULT_SCALE}. Lowered automatically to respect maxSize.`),
        maxSize: z
          .number()
          .int()
          .min(64)
          .max(HARD_MAX_SIZE)
          .optional()
          .describe(`Longest edge in pixels. Default ${DEFAULT_MAX_SIZE}.`),
        background: z
          .enum(['transparent', 'page'])
          .optional()
          .describe('Default "transparent". "page" fills with the page background colour.'),
        savePath: z
          .string()
          .optional()
          .describe(
            'Write the PNG/SVG to this path (directories are created) instead of inlining it. ' +
              `Required when the PNG exceeds ${MAX_INLINE_PNG} bytes or the SVG exceeds ${MAX_INLINE_SVG} characters.`,
          ),
        maxNodes: z
          .number()
          .int()
          .min(1)
          .max(HARD_MAX_NODES)
          .optional()
          .describe('Refuse subtrees larger than this. Default 20000.'),
      },
      // Not read-only: savePath writes a file. Nothing is ever written back into the .fig.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    handler(async (args: RenderArgs): Promise<CallToolResult> => {
      const entry = load(ctx, args.file);
      const result = await renderNode(entry, args.guid, {
        scale: args.scale,
        maxSize: args.maxSize,
        background: args.background,
        maxNodes: args.maxNodes,
        format: args.format ?? 'png',
      });

      const wantSvg = args.format === 'svg' || result.rasterizerMissing || !result.png;

      if (wantSvg) {
        if (args.savePath) {
          const savedTo = write(args.savePath, result.svg);
          return jsonResult(toolReport(result.report, { format: 'svg', savedTo, bytesWritten: result.svg.length }));
        }
        if (result.svg.length > Math.min(MAX_INLINE_SVG, HARD_CAP)) {
          return jsonResult(
            toolReport(result.report, {
              format: 'svg',
              inlined: false,
              hint: `the SVG is ${result.svg.length} characters; call again with savePath to write it to disk`,
            }),
          );
        }
        return textResult(result.svg);
      }

      const png = result.png!;
      if (args.savePath) {
        const savedTo = write(args.savePath, png);
        return jsonResult(toolReport(result.report, { format: 'png', savedTo, bytesWritten: png.length }));
      }
      if (png.length > MAX_INLINE_PNG) {
        return jsonResult(
          toolReport(result.report, {
            format: 'png',
            inlined: false,
            hint: `the PNG is ${png.length} bytes; lower scale or maxSize, or call again with savePath`,
          }),
        );
      }
      return {
        content: [
          { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(toolReport(result.report, { format: 'png' })) },
        ],
      };
    }),
  );
}
