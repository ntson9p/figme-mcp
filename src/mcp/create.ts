/**
 * Server factory, kept separate from the stdio entry point so tests (and any other transport)
 * can build a fully-registered server without connecting to a process's stdin/stdout.
 */
import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FileCache } from '../cache.js';
import type { ToolContext } from './tools/context.js';

import * as overview from './tools/overview.js';
import * as tree from './tools/tree.js';
import * as node from './tools/node.js';
import * as find from './tools/find.js';
import * as text from './tools/text.js';
import * as style from './tools/style.js';
import * as components from './tools/components.js';
import * as instance from './tools/instance.js';
import * as variables from './tools/variables.js';
import * as image from './tools/image.js';
import * as blob from './tools/blob.js';
import * as render from './tools/render.js';

export const SERVER_NAME = 'figme';
/** Read from package.json so the reported version can never drift from the published one. */
function packageVersion(): string {
  try {
    const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const v: unknown = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const SERVER_VERSION = packageVersion();

export const INSTRUCTIONS = [
  'Read-only access to local Figma .fig / .figma files. No Figma account, API or network is',
  'used, and nothing is ever written back to the file.',
  '',
  'Workflow: fig_overview (counts + pages) -> fig_tree on a page (format:"outline" is densest)',
  '-> fig_node / fig_style on interesting guids. fig_find jumps to a name or a string of copy.',
  'fig_text extracts copy, fig_components / fig_instance cover the design system, fig_variables',
  'lists tokens, fig_image returns bitmaps, fig_blob exposes raw vector payloads.',
  '',
  'fig_render returns a picture of any node - the fastest way to understand a frame. Always',
  'check its approximated/unsupported lists before trusting fine visual detail.',
  '',
  'Node guids are "sessionID:localID" strings such as "2:1339". A Figma link spells the same',
  'id with a dash - node-id=3017-121 is guid "3017:121" - and every guid argument also accepts',
  'that form, the percent-encoded form, or the whole link, so pass along whatever the user had.',
  '',
  'These tools read a .fig saved on disk and cannot open a figma.com URL. Given a link but no',
  'file path, ask the user for the path. Never fetch the link, and never infer the design from',
  'the words in it - the slug is a file name, not a specification.',
  '',
  'To implement a component: fig_render it first to see it, then fig_node for layout and size,',
  'fig_style for resolved fills, strokes and type, fig_text for the exact copy, fig_instance if',
  'it is an INSTANCE (it tells you whether to build something reusable), and fig_variables so',
  'the code uses token names instead of literal values. Render again at the end and compare.',
  '',
  'Responses are budgeted: when one is cut you get truncated:true plus an opaque nextCursor to',
  'pass back.',
].join('\n');

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const tools = [
    overview, tree, node, find, text, style, components, instance, variables, image, blob, render,
  ];
  for (const mod of tools) {
    mod.register(server, ctx);
  }
  return server;
}

export function createContext(maxFiles = 4): ToolContext {
  return { cache: new FileCache(maxFiles) };
}
