import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_RELEASE_MS, ENTER_MS, EV, EXIT_MS, GAME_MS, MIN_SCRAPE_GAP_MS, UNLOCK_MS,
  busSpec, replay, type RunEvent,
} from '../src/sim.ts';

/** Plays a perfect-ish run the way the browser would, returning the log. */
function botRun(seed: number, opts: { gap?: number; react?: number; forceAfterUnlock?: boolean } = {}) {
  const gap = opts.gap ?? 80, react = opts.react ?? 200;
  const log: RunEvent[] = [];
  let t = ENTER_MS, i = 0;
  while (true) {
    const spec = busSpec(seed, i);
    t += react;
    if (t > GAME_MS) break;
    if (spec.kind === '13' && !(opts.forceAfterUnlock && t >= UNLOCK_MS)) {
      let last = -Infinity;
      for (let k = 0; k < spec.hp; k++) {
        t = Math.max(t, last + gap);
        if (t > GAME_MS) return log;
        log.push([t, EV.SCRAPE]); last = t;
      }
      t += AUTO_RELEASE_MS;
    } else {
      log.push([t, EV.RELEASE]);
    }
    t += EXIT_MS + ENTER_MS;
    i++;
  }
  return log;
}

test('busSpec is deterministic and keeps the first buses stickered', () => {
  assert.deepEqual(busSpec(42, 7), busSpec(42, 7));
  assert.notDeepEqual(busSpec(42, 7), busSpec(43, 7));
  for (const seed of [1, 2, 3, 99999]) {
    assert.equal(busSpec(seed, 0).kind, '13');
    assert.equal(busSpec(seed, 1).kind, '13');
  }
});

test('about 70% of buses carry a 13 sticker', () => {
  let n = 0, total = 0;
  for (let i = 2; i < 5000; i++) { total++; if (busSpec(7, i).kind === '13') n++; }
  assert.ok(Math.abs(n / total - 0.7) < 0.03, `share ${n / total}`);
});

test('a clean run replays to the expected score', () => {
  const seed = 123456;
  const log = botRun(seed);
  const r = replay(seed, log);
  assert.equal(r.ok, true, r.reason ?? '');
  assert.equal(r.score, log.filter((e) => e[1] === EV.SCRAPE).length > 0 ? r.scraped : 0);
  assert.ok(r.score > 10 && r.score < 55, `score ${r.score}`);
});

test('the same log does not fit another seed', () => {
  const log = botRun(1);
  const bad = [2, 3, 4, 5].map((s) => replay(s, log)).filter((r) => !r.ok);
  assert.ok(bad.length >= 3);
});

test('rejects inhuman scrape rates, early events and late events', () => {
  assert.equal(replay(5, [[ENTER_MS, EV.SCRAPE], [ENTER_MS + MIN_SCRAPE_GAP_MS - 20, EV.SCRAPE]]).ok, false);
  assert.equal(replay(5, [[10, EV.SCRAPE]]).ok, false);
  assert.equal(replay(5, [[GAME_MS + 500, EV.RELEASE]]).ok, false);
  assert.equal(replay(5, [[900, EV.SCRAPE], [800, EV.SCRAPE]]).ok, false);
  assert.equal(replay(5, 'nope').ok, false);
});

test('releasing a stickered bus is blocked before 12h20 and forced after', () => {
  const before = replay(9, [[ENTER_MS + 100, EV.RELEASE]]);
  assert.equal(before.ok, true);
  assert.equal(before.blocked, 1);
  assert.equal(before.buses, 0);
  const log = botRun(9, { forceAfterUnlock: true });
  const r = replay(9, log);
  assert.equal(r.ok, true, r.reason ?? '');
  assert.ok(r.forced > 0);
});

test('a bot at the browser limit stays under a sane ceiling', () => {
  const r = replay(77, botRun(77, { gap: MIN_SCRAPE_GAP_MS, react: 0 }));
  assert.equal(r.ok, true, r.reason ?? '');
  assert.ok(r.score < 70, `score ${r.score}`);
});
