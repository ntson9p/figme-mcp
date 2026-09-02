import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCommands,
  pathBounds,
  roundCommands,
  toPathData,
  type PathCommand,
} from '../../dist/render/path.js';

const OPCODE: Record<string, number> = { Z: 0, M: 1, L: 2, Q: 3, C: 4 };

/** Encode commands the way a .fig blob stores them (F4): opcode byte + LE float32 args. */
function encode(cmds: readonly PathCommand[]): Uint8Array {
  let size = 0;
  for (const c of cmds) size += 1 + 4 * c.args.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let i = 0;
  for (const c of cmds) {
    out[i] = OPCODE[c.op]!;
    for (let k = 0; k < c.args.length; k++) dv.setFloat32(i + 1 + 4 * k, c.args[k]!, true);
    i += 1 + 4 * c.args.length;
  }
  return out;
}

/** The rounded-rectangle geometry of node 2:1558, blob #390 (plan fact F4). */
const GOLDEN: PathCommand[] = [
  { op: 'M', args: [0, 2] },
  { op: 'C', args: [0, 0.9, 0.9, 0, 2, 0] },
  { op: 'L', args: [16, 0] },
  { op: 'C', args: [17.1, 0, 18, 0.9, 18, 2] },
  { op: 'L', args: [18, 12] },
  { op: 'C', args: [18, 13.1, 17.1, 14, 16, 14] },
  { op: 'L', args: [2, 14] },
  { op: 'C', args: [0.9, 14, 0, 13.1, 0, 12] },
  { op: 'L', args: [0, 2] },
  { op: 'Z', args: [] },
];

const GOLDEN_D =
  'M0,2 C0,0.9,0.9,0,2,0 L16,0 C17.1,0,18,0.9,18,2 L18,12 C18,13.1,17.1,14,16,14 ' +
  'L2,14 C0.9,14,0,13.1,0,12 L0,2 Z';

test('round-trips the F4 golden command sequence', () => {
  const decoded = roundCommands(decodeCommands(encode(GOLDEN)), 1);
  assert.deepEqual(decoded, GOLDEN);
  assert.equal(toPathData(decoded), GOLDEN_D);
});

test('an empty blob is a valid empty path', () => {
  assert.deepEqual(decodeCommands(new Uint8Array(0)), []);
  assert.equal(toPathData([]), '');
});

test('decoding respects byteOffset when the blob is a view into a larger buffer', () => {
  const encoded = encode(GOLDEN);
  const padded = new Uint8Array(encoded.length + 8);
  padded.set(encoded, 5);
  const view = padded.subarray(5, 5 + encoded.length);
  assert.equal(toPathData(roundCommands(decodeCommands(view), 1)), GOLDEN_D);
});

test('an unknown opcode throws and names the byte offset', () => {
  const bad = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
  assert.throws(() => decodeCommands(bad), /unknown path opcode 9 at byte 9/);
});

test('a truncated command throws', () => {
  assert.throws(() => decodeCommands(new Uint8Array([1, 0, 0, 0])), /truncated path command 1/);
});

test('toPathData applies a transform to every coordinate pair', () => {
  const cmds: PathCommand[] = [{ op: 'M', args: [1, 1] }];
  assert.equal(toPathData(cmds, { a: 2, b: 0, c: 0, d: -2, e: 10, f: 20 }), 'M12,18');
});

test('toPathData emits Z with no arguments and joins commands with spaces', () => {
  assert.equal(
    toPathData([
      { op: 'M', args: [0, 0] },
      { op: 'Q', args: [1, 2, 3, 4] },
      { op: 'Z', args: [] },
    ]),
    'M0,0 Q1,2,3,4 Z',
  );
});

test('pathBounds includes control points and is undefined for an empty path', () => {
  assert.deepEqual(pathBounds(GOLDEN), { x: 0, y: 0, w: 18, h: 14 });
  assert.equal(pathBounds([]), undefined);
  assert.deepEqual(pathBounds([{ op: 'M', args: [1, 1] }], { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }), {
    x: 2,
    y: 2,
    w: 0,
    h: 0,
  });
});

test('commands before the first moveto are dropped', () => {
  // 4287 of the 4288 glyph outline blobs in the sample begin with a close command. SVG requires
  // path data to start with a moveto, and resvg silently discards a path that does not.
  const cmds: PathCommand[] = [
    { op: 'Z', args: [] },
    { op: 'M', args: [1, 2] },
    { op: 'L', args: [3, 4] },
    { op: 'Z', args: [] },
  ];
  assert.equal(toPathData(cmds), 'M1,2 L3,4 Z');
  assert.equal(decodeCommands(encode(cmds)).length, 4, 'the decoder stays faithful to the bytes');
  assert.equal(toPathData([{ op: 'Z', args: [] }]), '', 'a path with no moveto emits nothing');
});
