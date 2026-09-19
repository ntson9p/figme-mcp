/**
 * Server factory, kept separate from the stdio entry point so tests (and any other transport)
 * can build a fully-registered server without connecting to a process's stdin/stdout.
 */
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
export const SERVER_VERSION = '1.0.0';

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
  'Node guids are "sessionID:localID" strings such as "2:1339". Responses are budgeted: when one',
  'is cut you get truncated:true plus an opaque nextCursor to pass back.',
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
