// Structural checks on a generated SVG, shared by the golden tests and the visual tester's
// level 1. Not a test file.

/**
 * Base64 image payloads are arbitrary text: "NaN" and "undefined" occur inside them by chance
 * roughly once every few hundred kilobytes, so any scan for those words has to strip data URIs
 * first or it reports a defect on nearly every frame that carries an image.
 */
export function withoutDataUris(svg: string): string {
  return svg.replace(/data:[a-zA-Z0-9/+.-]+;base64,[A-Za-z0-9+/=]+/g, 'data:embedded');
}

/** Every structural problem found in `svg`; an empty array means it is well-formed and sane. */
export function svgProblems(svg: string): string[] {
  const notes: string[] = [];
  if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) {
    notes.push('not a complete <svg> document');
  }

  const opens = (svg.match(/<g[ >]/g) ?? []).length;
  const closes = (svg.match(/<\/g>/g) ?? []).length;
  if (opens !== closes) notes.push(`${opens} <g> vs ${closes} </g>`);

  const text = withoutDataUris(svg);
  for (const bad of ['NaN', 'Infinity', 'undefined']) {
    if (text.includes(bad)) notes.push(`contains "${bad}"`);
  }

  const ids = new Set([...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!));
  for (const ref of text.matchAll(/url\(#([^)]+)\)/g)) {
    if (!ids.has(ref[1]!)) notes.push(`url(#${ref[1]}) has no matching id`);
  }

  return notes;
}
