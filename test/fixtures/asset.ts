// Shared helper for asset-dependent (golden) tests. Not a test file itself.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');
export const ASSET_PATH = path.join(REPO_ROOT, 'figma-input', 'sample.fig');

export const ASSET_EXISTS = fs.existsSync(ASSET_PATH);

/** Message shown when golden tests skip, so a missing asset never reads as a failure. */
export const SKIP_MESSAGE =
  `golden test asset not found at ${ASSET_PATH} — ` +
  'place the sample .fig there to run asset-dependent tests';

export function readAsset(): Buffer {
  return fs.readFileSync(ASSET_PATH);
}
