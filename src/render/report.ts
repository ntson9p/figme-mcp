/**
 * The render report (plan §4.12) — what was drawn, what was approximated, what was skipped.
 *
 * This is not a courtesy log. `featuresPresent` is the join key between the exporter, the
 * coverage matrix and the gallery of the visual tester, so the vocabulary (Appendix D) is
 * fixed: never invent a feature string at a call site, add it to `FEATURES` first.
 */
import type { Box } from './matrix.js';

export interface FeatureEntry {
  readonly feature: string;
  readonly count: number;
  readonly examples: string[];
}

export interface RenderReport {
  root: { guid: string; name?: string; type: string };
  nodesVisited: number;
  nodesDrawn: number;
  bounds: Box;
  width: number;
  height: number;
  scale: number;
  /** Not drawn at all. */
  unsupported: FeatureEntry[];
  /** Drawn, but not exactly the way Figma would. */
  approximated: FeatureEntry[];
  /** Every vocabulary key seen in the subtree, drawn or not — used by the coverage matrix. */
  featuresPresent: string[];
  svgBytes: number;
  renderMs: number;
  rasterMs?: number;
  note?: string;
}

/**
 * Appendix D. Parameterised keys are formed with the helpers below so a typo cannot silently
 * create a new feature that the coverage matrix will never recognise.
 */
export const FEATURES = [
  'image-missing',
  'image-crop',
  'image-rotation',
  'image-filters',
  'gradient-singular',
  'emoji',
  'glyph-rotation',
  'text-without-outlines',
  'text-stroke',
  'text-decoration',
  'stroke-dashed',
  'stroke-without-geometry',
  'vector-without-geometry',
  'geometry:corrupt',
  'geometry:synthesised',
  'mask-hidden',
  'oversize',
  'svg-rejected',
] as const;

export const feat = {
  nodeType: (type: string): string => `node-type:${type}`,
  paint: (type: string): string => `paint:${type}`,
  effect: (type: string): string => `effect:${type}`,
  blend: (mode: string): string => `blend:${mode}`,
  mask: (type: string): string => `mask:${type}`,
  strokeAlign: (align: string): string => `stroke-align:${align}`,
  imageMode: (mode: string): string => `image-mode:${mode}`,
  imageFormat: (mime: string): string => `image-format:${mime}`,
};

const MAX_EXAMPLES = 5;

interface Bucket {
  count: number;
  examples: string[];
}

export class ReportBuilder {
  nodesVisited = 0;
  nodesDrawn = 0;
  private readonly unsupportedBuckets = new Map<string, Bucket>();
  private readonly approximatedBuckets = new Map<string, Bucket>();
  private readonly present = new Set<string>();

  private static bump(map: Map<string, Bucket>, feature: string, guid?: string): void {
    let bucket = map.get(feature);
    if (!bucket) {
      bucket = { count: 0, examples: [] };
      map.set(feature, bucket);
    }
    bucket.count += 1;
    if (guid && bucket.examples.length < MAX_EXAMPLES && !bucket.examples.includes(guid)) {
      bucket.examples.push(guid);
    }
  }

  /** Not drawn at all. Always also record it as present. */
  unsupported(feature: string, guid?: string): void {
    ReportBuilder.bump(this.unsupportedBuckets, feature, guid);
    this.present.add(feature);
  }

  /** Drawn, but not exactly like Figma. */
  approximated(feature: string, guid?: string): void {
    ReportBuilder.bump(this.approximatedBuckets, feature, guid);
    this.present.add(feature);
  }

  /** Record a feature as occurring in the subtree, whether or not it was drawn exactly. */
  seen(feature: string): void {
    this.present.add(feature);
  }

  private static entries(map: Map<string, Bucket>): FeatureEntry[] {
    return [...map.entries()]
      .map(([feature, b]) => ({ feature, count: b.count, examples: b.examples }))
      .sort((a, b) => b.count - a.count || a.feature.localeCompare(b.feature));
  }

  finish(base: Omit<RenderReport, 'unsupported' | 'approximated' | 'featuresPresent' | 'nodesVisited' | 'nodesDrawn'>): RenderReport {
    return {
      ...base,
      nodesVisited: this.nodesVisited,
      nodesDrawn: this.nodesDrawn,
      unsupported: ReportBuilder.entries(this.unsupportedBuckets),
      approximated: ReportBuilder.entries(this.approximatedBuckets),
      featuresPresent: [...this.present].sort(),
    };
  }
}
