import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThumbGate } from '../src/camera/thumb-gate.ts';

test('needs two consecutive thumb detections', () => {
  const g = new ThumbGate(2);
  assert.equal(g.update(true, true), false);
  assert.equal(g.update(true, true), true);
});

test('holding the thumb releases only one bus', () => {
  const g = new ThumbGate(2);
  const fired = Array.from({ length: 12 }, () => g.update(true, true)).filter(Boolean).length;
  assert.equal(fired, 1);
});

test('the thumb has to drop before the next release', () => {
  const g = new ThumbGate(2);
  g.update(true, true); g.update(true, true);          // release 1
  g.update(true, true); g.update(true, true);          // still held: nothing
  assert.equal(g.update(false, true), false);          // dropped
  g.update(true, true);
  assert.equal(g.update(true, true), true);            // release 2
});

test('a thumb still up when the next bus arrives does not count', () => {
  const g = new ThumbGate(2);
  g.update(true, true); g.update(true, true);          // release 1, thumb still up
  g.newBus();
  assert.equal(g.update(true, true), false);
  assert.equal(g.update(true, true), false);
  g.update(false, true);                               // drops
  g.update(true, true);
  assert.equal(g.update(true, true), true);
});

test('a new bus keeps the gate open when the thumb was already down', () => {
  const g = new ThumbGate(2);
  g.update(true, true); g.update(true, true);
  g.update(false, true);                               // thumb down before the bus change
  g.newBus();
  g.update(true, true);
  assert.equal(g.update(true, true), true);
});

test('detections while the bus is not ready accumulate and fire when it is', () => {
  const g = new ThumbGate(2);
  assert.equal(g.update(true, false), false);
  assert.equal(g.update(true, false), false);
  assert.equal(g.update(true, true), true);
});

test('losing the hand re-arms the gate', () => {
  const g = new ThumbGate(2);
  g.update(true, true); g.update(true, true);
  g.lost();
  g.update(true, true);
  assert.equal(g.update(true, true), true);
});
