// In-memory MCP client/server pair, so tool tests exercise real registration, argument
// validation and serialization rather than calling handlers directly. Not a test file itself.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createContext, createServer } from '../../dist/mcp/create.js';
import type { ToolContext } from '../../dist/mcp/tools/context.js';

export interface ToolCall {
  /** Raw text of the first content block. */
  text: string;
  /** Parsed JSON of `text` (throws for outline/text responses — use `text` there). */
  json: Record<string, unknown>;
  isError: boolean;
  /** Character length of the response text — what the budget rules are measured against. */
  size: number;
  content: unknown[];
}

export interface Harness {
  call(name: string, args: Record<string, unknown>): Promise<ToolCall>;
  listTools(): Promise<{ name: string; description?: string }[]>;
  ctx: ToolContext;
  close(): Promise<void>;
}

export async function connect(maxFiles = 4): Promise<Harness> {
  const ctx = createContext(maxFiles);
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'figfile-tests', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    ctx,
    async listTools() {
      const res = await client.listTools();
      return res.tools.map((t) => ({ name: t.name, description: t.description }));
    },
    async call(name, args) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
      const first = res.content?.[0];
      const text = first && first.type === 'text' ? (first.text ?? '') : '';
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* outline / plain-text responses */
      }
      return { text, json, isError: res.isError === true, size: text.length, content: res.content };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
