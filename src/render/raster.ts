/**
 * Optional rasterizer wrapper (plan §5) around `@resvg/resvg-wasm`.
 *
 * The package is an OPTIONAL dependency: `rasterizer()` resolves to `undefined` when it is not
 * installed and never throws, so the server, every existing tool and the SVG output keep
 * working without it.
 *
 * Behaviour here is measured, not assumed — see Appendix E of the plan.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface RenderedImage {
  asPng(): Uint8Array;
  readonly width: number;
  readonly height: number;
  free(): void;
}

interface ResvgInstance {
  render(): RenderedImage;
  free(): void;
}

interface ResvgModule {
  initWasm(input: Uint8Array): Promise<void>;
  Resvg: new (svg: string, opts?: Record<string, unknown>) => ResvgInstance;
}

let loading: Promise<ResvgModule | undefined> | undefined;

/** Resolves to `undefined` when the optional package is not installed. Never throws. */
export function rasterizer(): Promise<ResvgModule | undefined> {
  if (!loading) {
    loading = (async (): Promise<ResvgModule | undefined> => {
      let mod: ResvgModule;
      try {
        // A variable keeps tsc from resolving the module at build time, so the project still
        // compiles when the optional dependency is absent.
        const name = '@resvg/resvg-wasm';
        mod = (await import(name)) as ResvgModule;
      } catch {
        return undefined; // not installed — the only genuinely absent case
      }
      try {
        const wasm = fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
        await mod.initWasm(wasm);
      } catch (err) {
        // initWasm() throws "Already initialized. The initWasm() function can be used only
        // once." when another copy of this module has already run it (two dist copies, a test
        // harness, a second server in-process). That is success, not failure.
        const message = err instanceof Error ? err.message : String(err);
        if (!/already initialized/i.test(message)) return undefined;
      }
      return mod;
    })();
  }
  return loading;
}

export interface RasterResult {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * `undefined` means "no rasterizer installed". A malformed SVG throws a plain Error from resvg
 * ("SVG data parsing failed …"); callers report that as `svg-rejected` rather than crashing.
 *
 * There is deliberately no `pixels` field: resvg's pixel buffer is PREMULTIPLIED (Appendix E,
 * R5), so comparing it against `pngjs` output would be silently wrong. Always decode `png`.
 */
export async function rasterize(
  svg: string,
  scale: number,
  background?: string,
): Promise<RasterResult | undefined> {
  const mod = await rasterizer();
  if (!mod) return undefined;
  const resvg = new mod.Resvg(svg, {
    fitTo: { mode: 'zoom', value: scale },
    background,
    font: { loadSystemFonts: false },
  });
  const img = resvg.render();
  try {
    return { png: img.asPng(), width: img.width, height: img.height };
  } finally {
    img.free();
    resvg.free();
  }
}
