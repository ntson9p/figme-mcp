// Fixture discovery and export matching (render-implementation-plan.md §9.1, §9.2).
// Not a test file.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
export const REPORTS_DIR = path.join(REPO_ROOT, 'reports', 'visual');

export interface ManifestFrame {
  guid: string;
  name?: string;
  png?: string;
  png2x?: string;
  svg?: string;
}

export interface Manifest {
  exportedAt?: string;
  frames?: ManifestFrame[];
}

export interface FixtureFrame {
  readonly guid: string;
  readonly name?: string;
  /** Absolute paths, when the fixture ships them. */
  readonly png?: string;
  readonly png2x?: string;
  readonly svg?: string;
  /** 1 when only a 1x export exists, 2 when a @2x one does. */
  readonly scale: number;
  /** How the export was matched to a node: useful when a name match was ambiguous. */
  readonly matchedBy: 'manifest' | 'guid' | 'name' | 'listed';
}

export interface Fixture {
  readonly name: string;
  readonly dir: string;
  readonly file: string;
  readonly frames: FixtureFrame[];
  /** Export basenames that could not be matched to exactly one node. */
  readonly unmatched: { readonly base: string; readonly reason: string }[];
  readonly expectPath: string;
}

/** A guid is written `2_39` in a file name, because `:` is illegal on Windows (ground rule 9). */
export function guidToFileName(guid: string): string {
  return guid.replace(/:/g, '_');
}

export function fileNameToGuid(base: string): string | undefined {
  return /^\d+_\d+$/.test(base) ? base.replace('_', ':') : undefined;
}

function readManifest(dir: string): Manifest | undefined {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

/**
 * Every fixture directory holding a `design.fig`. Frames come from `manifest.json` when it
 * exists, and otherwise from the export file names (§9.2). A fixture with no exports at all is
 * still returned: levels 1 and 2 and the coverage scan need no oracle.
 */
export function discoverFixtures(root = FIXTURES_DIR): Fixture[] {
  if (!fs.existsSync(root)) return [];
  const out: Fixture[] = [];

  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const file = path.join(dir, 'design.fig');
    if (!fs.existsSync(file)) continue;

    const exportsDir = path.join(dir, 'exports');
    const files = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).sort() : [];
    const manifest = readManifest(dir);
    const frames: FixtureFrame[] = [];
    const unmatched: { base: string; reason: string }[] = [];
    const claimed = new Set<string>();

    const abs = (f: string | undefined): string | undefined => {
      if (!f) return undefined;
      const p = path.join(exportsDir, f);
      return fs.existsSync(p) ? p : undefined;
    };

    for (const frame of manifest?.frames ?? []) {
      if (!frame.guid) continue;
      for (const f of [frame.png, frame.png2x, frame.svg]) if (f) claimed.add(f);
      const png2x = abs(frame.png2x);
      frames.push({
        guid: frame.guid,
        name: frame.name,
        png: abs(frame.png),
        png2x,
        svg: abs(frame.svg),
        scale: png2x ? 2 : 1,
        matchedBy: 'manifest',
      });
    }

    // Anything not named by the manifest: group by base name, then resolve the guid.
    const groups = new Map<string, { png?: string; png2x?: string; svg?: string }>();
    for (const f of files) {
      if (claimed.has(f)) continue;
      const m = /^(.+?)(@(\d+)x)?\.(png|svg)$/i.exec(f);
      if (!m) continue;
      const [, base, , scaleText, ext] = m as unknown as [string, string, string, string, string];
      const group = groups.get(base) ?? {};
      if (ext.toLowerCase() === 'svg') group.svg = f;
      else if (scaleText === '2') group.png2x = f;
      else group.png = f;
      groups.set(base, group);
    }

    for (const [base, group] of groups) {
      const guid = fileNameToGuid(base);
      if (guid) {
        frames.push({
          guid,
          name: base,
          png: abs(group.png),
          png2x: abs(group.png2x),
          svg: abs(group.svg),
          scale: group.png2x ? 2 : 1,
          matchedBy: 'guid',
        });
      } else {
        // A layer-name export. Resolving it needs the parsed file, which the caller does with
        // matchByName below; record it for now.
        frames.push({
          guid: '',
          name: base,
          png: abs(group.png),
          png2x: abs(group.png2x),
          svg: abs(group.svg),
          scale: group.png2x ? 2 : 1,
          matchedBy: 'name',
        });
      }
    }

    out.push({
      name,
      dir,
      file,
      frames,
      unmatched,
      expectPath: path.join(dir, 'expect.json'),
    });
  }
  return out;
}

export interface NameCandidate {
  readonly guid: string;
  readonly width: number;
  readonly height: number;
}

/**
 * §9.2 — resolve a layer-name export to one node: collect nodes with that exact name, keep the
 * ones whose expected export size matches the PNG to within 2 px, and require exactly one.
 */
export function matchByName(
  candidates: readonly NameCandidate[],
  pngWidth: number,
  pngHeight: number,
  scale: number,
): { guid?: string; reason?: string } {
  if (candidates.length === 0) return { reason: 'no node has that name' };
  const fits = candidates.filter(
    (c) =>
      Math.abs(Math.round(c.width * scale) - pngWidth) <= 2 &&
      Math.abs(Math.round(c.height * scale) - pngHeight) <= 2,
  );
  if (fits.length === 1) return { guid: fits[0]!.guid };
  if (fits.length === 0) {
    return {
      reason:
        `${candidates.length} node(s) share that name but none is ${pngWidth}x${pngHeight} ` +
        `at ${scale}x (${candidates.map((c) => `${c.guid} ${c.width}x${c.height}`).join(', ')})`,
    };
  }
  return {
    reason: `ambiguous: ${fits.map((c) => c.guid).join(', ')} — add a manifest.json entry`,
  };
}

export interface Expectations {
  [guid: string]: { level3?: number; level4?: number };
}

export function readExpectations(fixture: Fixture): Expectations {
  if (!fs.existsSync(fixture.expectPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(fixture.expectPath, 'utf8')) as Expectations;
  } catch {
    return {};
  }
}

export function writeExpectations(fixture: Fixture, expectations: Expectations): void {
  fs.writeFileSync(fixture.expectPath, `${JSON.stringify(expectations, null, 2)}\n`, 'utf8');
}
