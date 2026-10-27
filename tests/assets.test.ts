import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MEDIAPIPE_VERSION } from '../src/camera/assets.ts';

test('CDN runtime version matches the installed MediaPipe package', () => {
  const pkg = JSON.parse(readFileSync('node_modules/@mediapipe/tasks-vision/package.json', 'utf8'));
  assert.equal(MEDIAPIPE_VERSION, pkg.version);
});
