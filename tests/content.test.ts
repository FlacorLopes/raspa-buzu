import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baratinoLevel } from '../src/content.ts';

test('baratinômetro levels follow the Bahian scale', () => {
  assert.equal(baratinoLevel(0), '');
  assert.equal(baratinoLevel(1), 'Migué');
  assert.equal(baratinoLevel(3), 'Migué');
  assert.equal(baratinoLevel(4), 'Quatchá quatchá');
  assert.equal(baratinoLevel(6), 'Quatchá quatchá');
  assert.equal(baratinoLevel(7), 'Baratino master');
  assert.equal(baratinoLevel(30), 'Baratino master');
});
