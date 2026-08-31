#!/usr/bin/env node
/**
 * figfile — an MCP server that reads local Figma `.fig` files, fully offline.
 *
 * Transport: stdio. Nothing here touches the network, and nothing writes to a .fig file;
 * the only write path is `fig_image { savePath }`, which the caller asks for explicitly.
 *
 * Usage: node dist/mcp/server.js [--max-files N]
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createContext, createServer } from './create.js';

function parseMaxFiles(argv: readonly string[]): number {
  const i = argv.findIndex((a) => a === '--max-files' || a.startsWith('--max-files='));
  if (i < 0) return 4;
  const flag = argv[i]!;
  const raw = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : argv[i + 1];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

const server = createServer(createContext(parseMaxFiles(process.argv.slice(2))));
await server.connect(new StdioServerTransport());
