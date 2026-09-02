// The coverage matrix (render-implementation-plan.md §9.6). Not a test file.
//
// This is the "how good is our code" number, and it is deliberately not a pass rate: a pass rate
// depends on which frames happen to be in the corpus. Coverage says which FEATURES the corpus
// exercises and which of those a passing level-4 comparison has actually proven.
export interface FrameFeatures {
  readonly design: string;
  readonly guid: string;
  readonly name?: string;
  readonly features: readonly string[];
  /** Undefined when the level did not run (no oracle for this frame). */
  readonly level3?: boolean;
  readonly level4?: boolean;
}

export interface CoverageRow {
  readonly feature: string;
  readonly frames: number;
  /** Proven = at least one frame containing it passed level 4 against Figma's own PNG. */
  readonly proven: boolean;
  /** Checked = at least one containing frame passed the geometry comparison. */
  readonly geometryChecked: boolean;
  readonly examples: string[];
}

export interface Coverage {
  readonly rows: CoverageRow[];
  readonly featuresPresent: number;
  readonly featuresProven: number;
  /** proven / present, or 0 when the corpus exercises nothing. */
  readonly score: number;
}

export function buildCoverage(frames: readonly FrameFeatures[]): Coverage {
  const byFeature = new Map<string, { frames: number; proven: boolean; geometry: boolean; examples: string[] }>();

  for (const frame of frames) {
    for (const feature of frame.features) {
      const row = byFeature.get(feature) ?? { frames: 0, proven: false, geometry: false, examples: [] };
      row.frames += 1;
      if (frame.level4 === true) row.proven = true;
      if (frame.level3 === true) row.geometry = true;
      if (row.examples.length < 3) row.examples.push(`${frame.design}/${frame.guid}`);
      byFeature.set(feature, row);
    }
  }

  const rows: CoverageRow[] = [...byFeature.entries()]
    .map(([feature, r]) => ({
      feature,
      frames: r.frames,
      proven: r.proven,
      geometryChecked: r.geometry,
      examples: r.examples,
    }))
    // Unproven first: that list is the to-do for the next fixture.
    .sort((a, b) => Number(a.proven) - Number(b.proven) || a.feature.localeCompare(b.feature));

  const featuresProven = rows.filter((r) => r.proven).length;
  return {
    rows,
    featuresPresent: rows.length,
    featuresProven,
    score: rows.length === 0 ? 0 : featuresProven / rows.length,
  };
}
