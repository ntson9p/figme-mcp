/**
 * Shared plumbing for tool modules: the file cache handle, argument helpers and uniform error
 * reporting. Tool handlers stay small and never touch bytes directly.
 */
import { z } from 'zod';
import type { FileCache, CacheEntry } from '../../cache.js';
import type { FileIndex } from '../../model/index.js';
import { canonicalGuid, guidNotFound, type TreeNode } from '../../model/tree.js';
import { resolveScene, sceneOf, type SceneNode } from '../../model/scene.js';
import { errorResult, type CallToolResult } from '../respond.js';

export interface ToolContext {
  readonly cache: FileCache;
}

export const fileArg = z
  .string()
  .describe('Path to the .fig / .figma file (absolute, or relative to the server CWD).');

export const cursorArg = z
  .string()
  .optional()
  .describe('Opaque nextCursor from a previous truncated response; resumes where it stopped.');

export function load(ctx: ToolContext, file: string): CacheEntry {
  return ctx.cache.get(file);
}

export function requireNode(index: FileIndex, guid: string): TreeNode {
  const key = canonicalGuid(guid);
  const t = index.node(key);
  if (!t) throw new Error(guidNotFound(guid, key));
  return t;
}

/** Resolve an optional scope argument to a subtree root, defaulting to the DOCUMENT. */
export function resolveRoot(index: FileIndex, guid: string | undefined): TreeNode {
  if (guid) return requireNode(index, guid);
  const root = index.root;
  if (!root) throw new Error('this file has no DOCUMENT node');
  return root;
}

/**
 * A stored node, or a layer inside a component instance (`I<instance>;<layer>…`), as Figma shows
 * it: instances expand into their layers (model/scene.ts).
 */
export function requireScene(index: FileIndex, guid: string): SceneNode {
  const key = canonicalGuid(guid);
  const s = resolveScene(index, key);
  if (!s) throw new Error(guidNotFound(guid, key));
  return s;
}

/** `requireScene` for an optional scope argument, defaulting to the DOCUMENT. */
export function resolveSceneRoot(index: FileIndex, guid: string | undefined): SceneNode {
  if (guid) return requireScene(index, guid);
  const root = index.root;
  if (!root) throw new Error('this file has no DOCUMENT node');
  return sceneOf(index, root);
}

/** Shared description of the `instances` argument of the traversing tools. */
export const instancesArg = (fallback: string) =>
  z
    .boolean()
    .optional()
    .describe(
      'Walk into component instances and list the layers they show, with their overrides ' +
        `applied (ids like "I2:1329;0:2528"). ${fallback}`,
    );

/**
 * Uniform handler wrapper: turns thrown errors into an MCP error result instead of crashing the
 * server, and keeps the message actionable (the thrown text is already user-facing).
 */
export function handler<A>(
  fn: (args: A) => CallToolResult | Promise<CallToolResult>,
): (args: A, extra: unknown) => Promise<CallToolResult> {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  };
}
