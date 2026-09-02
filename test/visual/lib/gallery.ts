// The HTML gallery and JSON report (render-implementation-plan.md §9.8). Not a test file.
//
// Plain HTML with relative <img> paths and no scripts: it has to open from the filesystem.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Coverage } from './coverage.ts';
import type { FixtureRun, FrameResult, LevelResult } from './cli.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function badge(level: LevelResult, label: string): string {
  if (level.skipped) return `<span class="b skip" title="${esc(level.skipped)}">${label} –</span>`;
  const cls = level.pass ? 'ok' : 'bad';
  const detail = level.diffRatio === undefined ? '' : ` ${(level.diffRatio * 100).toFixed(2)}%`;
  const title = level.notes.length ? ` title="${esc(level.notes.join('; '))}"` : '';
  return `<span class="b ${cls}"${title}>${label}${detail}</span>`;
}

function frameRow(frame: FrameResult): string {
  const img = (src: string | undefined, alt: string): string =>
    src ? `<figure><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"><figcaption>${alt}</figcaption></figure>` : '';

  const report = frame.report;
  const lists = report
    ? [
        report.unsupported.length
          ? `<div class="tags u">${report.unsupported.map((u) => `<span>${esc(u.feature)} ×${u.count}</span>`).join('')}</div>`
          : '',
        report.approximated.length
          ? `<div class="tags a">${report.approximated.map((u) => `<span>${esc(u.feature)} ×${u.count}</span>`).join('')}</div>`
          : '',
      ].join('')
    : '';

  const attributions = frame.attributions.length
    ? `<details><summary>${frame.attributions.length} difference cluster(s)</summary><ol>` +
      frame.attributions
        .map(
          (a) =>
            `<li><code>${esc(a.guid)}</code> ${esc(a.name ?? '')} <em>${esc(a.type)}</em> — ` +
            `${a.blocks} blocks at ${a.clusterBox.x.toFixed(0)},${a.clusterBox.y.toFixed(0)}</li>`,
        )
        .join('') +
      '</ol></details>'
    : '';

  const ceiling =
    frame.ceiling === undefined
      ? ''
      : `<span class="b ceil" title="Figma's own SVG vs Figma's own PNG — the best this route can do">ceiling ${(frame.ceiling * 100).toFixed(2)}%</span>`;

  return `<tr>
    <td class="meta">
      <div class="guid">${esc(frame.guid)}</div>
      <div class="name">${esc(frame.name ?? '')}</div>
      <div class="badges">${badge(frame.level1, 'L1')}${badge(frame.level2, 'L2')}${badge(frame.level3, 'L3')}${badge(frame.level4, 'L4')}${ceiling}</div>
      <div class="stats">${report ? `${report.nodesDrawn}/${report.nodesVisited} nodes · ${report.width}×${report.height} · ${report.renderMs} ms` : ''}</div>
      ${lists}
      ${attributions}
      ${frame.error ? `<div class="err">${esc(frame.error)}</div>` : ''}
    </td>
    <td class="imgs">${img(frame.images.theirs, 'Figma')}${img(frame.images.ours, 'ours')}${img(frame.images.diff, 'diff')}</td>
  </tr>`;
}

const STYLE = `
body { font: 13px/1.45 system-ui, sans-serif; margin: 24px; color: #1a1a1a; }
h1 { font-size: 20px; margin: 0 0 4px; }
.sub { color: #666; margin-bottom: 20px; }
table { border-collapse: collapse; width: 100%; margin-bottom: 32px; }
td, th { border-top: 1px solid #e4e4e4; padding: 10px 8px; vertical-align: top; text-align: left; }
th { background: #fafafa; font-weight: 600; }
.meta { width: 340px; }
.guid { font-family: ui-monospace, monospace; font-weight: 600; }
.name { color: #666; }
.stats { color: #888; font-size: 12px; margin-top: 4px; }
.badges { margin: 6px 0; display: flex; gap: 4px; flex-wrap: wrap; }
.b { border-radius: 3px; padding: 1px 6px; font-size: 11px; font-weight: 600; }
.b.ok { background: #e3f5e6; color: #1b6b2a; }
.b.bad { background: #fde8e8; color: #99201b; }
.b.skip { background: #eee; color: #888; }
.b.ceil { background: #eef2ff; color: #38489c; }
.tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
.tags span { font-size: 11px; border-radius: 3px; padding: 1px 5px; }
.tags.u span { background: #fde8e8; color: #99201b; }
.tags.a span { background: #fff5e0; color: #8a5a00; }
.imgs { display: flex; gap: 12px; flex-wrap: wrap; }
figure { margin: 0; }
figure img { max-width: 260px; max-height: 260px; border: 1px solid #ddd;
  background: repeating-conic-gradient(#f4f4f4 0 25%, #fff 0 50%) 0 0/16px 16px; }
figcaption { font-size: 11px; color: #888; text-align: center; }
.err { color: #99201b; font-size: 12px; margin-top: 6px; }
.cov td:first-child { font-family: ui-monospace, monospace; }
.cov .no { color: #99201b; font-weight: 600; }
.cov .yes { color: #1b6b2a; }
.score { font-size: 15px; font-weight: 600; }
details { margin-top: 6px; } summary { cursor: pointer; color: #555; font-size: 12px; }
ol { margin: 4px 0 0 18px; padding: 0; font-size: 12px; }
`;

export interface GalleryInput {
  readonly runs: readonly FixtureRun[];
  readonly coverage: Coverage;
  readonly generatedAt: string;
}

export function renderGallery(input: GalleryInput): string {
  const frames = input.runs.flatMap((r) => r.frames);
  const counts = (pick: (f: FrameResult) => LevelResult): string => {
    const ran = frames.filter((f) => !pick(f).skipped);
    const passed = ran.filter((f) => pick(f).pass).length;
    return ran.length === 0 ? 'not run' : `${passed}/${ran.length}`;
  };

  const coverageRows = input.coverage.rows
    .map(
      (r) =>
        `<tr><td>${esc(r.feature)}</td><td>${r.frames}</td>` +
        `<td class="${r.geometryChecked ? 'yes' : 'no'}">${r.geometryChecked ? 'yes' : 'no'}</td>` +
        `<td class="${r.proven ? 'yes' : 'no'}">${r.proven ? 'yes' : 'no'}</td>` +
        `<td>${esc(r.examples.join(', '))}</td></tr>`,
    )
    .join('');

  const unmatched = input.runs.flatMap((r) =>
    r.unmatched.map((u) => `<li><code>${esc(u.base)}</code> — ${esc(u.reason)}</li>`),
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>figfile render report</title>
<style>${STYLE}</style></head><body>
<h1>figfile — visual render report</h1>
<div class="sub">${esc(input.generatedAt)} · ${frames.length} frame(s) across ${input.runs.length} fixture(s)
 · L1 ${counts((f) => f.level1)} · L2 ${counts((f) => f.level2)} · L3 ${counts((f) => f.level3)} · L4 ${counts((f) => f.level4)}</div>

<h2>Coverage</h2>
<p class="score">${input.coverage.featuresProven} of ${input.coverage.featuresPresent} features proven
 (${(input.coverage.score * 100).toFixed(0)}%)</p>
<p class="sub">A feature is <em>proven</em> when at least one frame containing it matched Figma's own
PNG. Unproven features are listed first: each one is a fixture worth making.</p>
<table class="cov"><thead><tr><th>feature</th><th>frames</th><th>geometry checked</th><th>proven</th><th>examples</th></tr></thead>
<tbody>${coverageRows || '<tr><td colspan="5">no frames</td></tr>'}</tbody></table>

${unmatched.length ? `<h2>Unmatched exports</h2><ul>${unmatched.join('')}</ul>` : ''}

<h2>Frames</h2>
<table><thead><tr><th>frame</th><th>Figma · ours · diff</th></tr></thead>
<tbody>${frames.map(frameRow).join('') || '<tr><td colspan="2">no frames</td></tr>'}</tbody></table>
</body></html>`;
}

export function writeReport(outDir: string, input: GalleryInput): { html: string; json: string } {
  fs.mkdirSync(outDir, { recursive: true });
  const html = path.join(outDir, 'index.html');
  const json = path.join(outDir, 'report.json');
  fs.writeFileSync(html, renderGallery(input), 'utf8');
  fs.writeFileSync(
    json,
    JSON.stringify(
      {
        generatedAt: input.generatedAt,
        coverage: input.coverage,
        fixtures: input.runs.map((r) => ({
          name: r.fixture.name,
          file: r.fixture.file,
          unmatched: r.unmatched,
          frames: r.frames,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
  return { html, json };
}
