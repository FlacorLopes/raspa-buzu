import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isThumbUp, type Pt } from '../src/camera/hands.ts';

// 21 MediaPipe hand landmarks in image space (y grows downward):
// 0 wrist; 1-4 thumb (cmc, mcp, ip, tip); 5-8 index; 9-12 middle; 13-16 ring; 17-20 pinky (mcp, pip, dip, tip).
function hand(opts: { thumbUp: boolean; fingersOpen: boolean }): Pt[] {
  const lm: Pt[] = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  lm[0] = { x: 0.5, y: 0.75 };
  const thumbTipY = opts.thumbUp ? 0.38 : 0.6;
  lm[1] = { x: 0.43, y: 0.68 }; lm[2] = { x: 0.41, y: 0.6 };
  lm[3] = { x: 0.41, y: opts.thumbUp ? 0.48 : 0.6 }; lm[4] = { x: opts.thumbUp ? 0.41 : 0.45, y: thumbTipY };
  [0.45, 0.5, 0.55, 0.6].forEach((x, f) => {
    const base = 5 + f * 4;
    lm[base] = { x, y: 0.58 };                                     // mcp
    lm[base + 1] = { x, y: opts.fingersOpen ? 0.48 : 0.52 };       // pip
    lm[base + 2] = { x, y: opts.fingersOpen ? 0.41 : 0.57 };       // dip
    lm[base + 3] = { x, y: opts.fingersOpen ? 0.35 : 0.62 };       // tip curled back toward the palm
  });
  return lm;
}

test('recognises a thumbs-up', () => {
  assert.equal(isThumbUp(hand({ thumbUp: true, fingersOpen: false })), true);
});

test('an open palm is not a thumbs-up', () => {
  assert.equal(isThumbUp(hand({ thumbUp: true, fingersOpen: true })), false);
});

test('a closed fist is not a thumbs-up', () => {
  assert.equal(isThumbUp(hand({ thumbUp: false, fingersOpen: false })), false);
});
