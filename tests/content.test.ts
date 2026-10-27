import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baratinoLevel, shareCaption } from '../src/content.ts';

test('baratinômetro levels follow the Bahian scale', () => {
  assert.equal(baratinoLevel(0), '');
  assert.equal(baratinoLevel(1), 'Migué');
  assert.equal(baratinoLevel(3), 'Migué');
  assert.equal(baratinoLevel(4), 'Quatchá quatchá');
  assert.equal(baratinoLevel(6), 'Quatchá quatchá');
  assert.equal(baratinoLevel(7), 'Baratino master');
  assert.equal(baratinoLevel(30), 'Baratino master');
});

/** Twitter's weighted length: links count 23, Latin text 1, everything else (emoji included) 2. */
function tweetLength(text: string) {
  let n = 0;
  for (const part of text.split(/(https?:\/\/\S+)/)) {
    if (/^https?:\/\//.test(part)) { n += 23; continue; }
    for (const ch of part) n += (ch.codePointAt(0)! <= 0x10ff ? 1 : 2);
  }
  return n;
}

test('share caption fits a tweet', () => {
  const url = 'https://raspa-buzu.vercel.app';
  const worst = shareCaption({ score: 999, passed: 999, paceMin: 1234.5, retidos: 75, url });
  assert.ok(tweetLength(worst) <= 280, `${tweetLength(worst)} > 280`);
  assert.ok(worst.split('\n')[0].length <= 125, 'first line must show before "mais" on Instagram');
  assert.ok(worst.includes(url));
  assert.ok(!shareCaption({ score: 0, passed: 0, paceMin: null, retidos: 75, url }).includes('undefined'));
});
