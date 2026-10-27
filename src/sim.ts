// Deterministic game rules shared by the browser and the API.
// The browser plays a run from a server-issued seed and records a compact event log;
// the API replays that log with the same rules to compute the score it stores.

import { GREEN_LINES, YELLOW_LINES, type Line, type Livery } from './lines.ts';

export const GAME_MS = 60_000;
export const ENTER_MS = 350;
export const EXIT_MS = 350;
/** Delay between the last scrape and the bus leaving on its own. */
export const AUTO_RELEASE_MS = 140;
/** 12h20 on the in-game clock (06h00 to 17h00 squeezed into GAME_MS). */
export const UNLOCK_MS = Math.round(((12 * 60 + 20 - 6 * 60) / (11 * 60)) * GAME_MS);
/** The browser never registers two scrapes closer than this. */
export const MIN_SCRAPE_GAP_MS = 45;
/**
 * Most buses had no candidate sticker. The game does not buy the Semob's "about 70% of the fleet"
 * claim: 30% carry the 13, 10% a harmless non-candidate sticker, 60% nothing at all.
 */
export const STICKERED_SHARE = 0.3;
export const DECOY_SHARE = 0.1;
export const YELLOW_SHARE = 0.8;
export const BUS_CAPACITY = 90;
export const RETIDOS = 75;
export const MAX_EVENTS = 4000;
/** Timing slack between client frames and the rules, in ms. */
const TOL = 40;

export type StickerKind = '13' | 'decoy' | 'none';

export interface BusSpec {
  index: number;
  kind: StickerKind;
  /** Scrapes needed (13 sticker only). */
  hp: number;
  /** Index into the decoy catalogue (decoy only). */
  decoy: number;
  /** Sticker centre, relative to the windshield box (0..1). */
  wu: number;
  wv: number;
  rot: number;
  livery: Livery;
  line: Line;
  fleet: number;
  plate: string;
}

export const DECOY_COUNT = 4;

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(seed: number, i: number) {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');

/** Bus number `i` of the run with `seed`. Independent of every other bus. */
export function busSpec(seed: number, i: number): BusSpec {
  const r = mulberry32(mix(seed, i));
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)];

  const roll = r();
  // The first bus always has a sticker, so the round opens by teaching the scrape.
  const kind: StickerKind = i < 1 ? '13' : roll < STICKERED_SHARE ? '13' : roll < STICKERED_SHARE + DECOY_SHARE ? 'decoy' : 'none';
  const hp = i < 1 ? 2 : 2 + Math.floor(r() * 3);
  const decoy = Math.floor(r() * DECOY_COUNT);

  // Keep the sticker inside one pane of the windshield, clear of the centre pillar and wipers.
  const left = r() < 0.5;
  const span = kind === 'decoy' ? [0.24, 0.35] : [0.11, 0.39];
  let wu = span[0] + r() * (span[1] - span[0]);
  if (!left) wu = 1 - wu;
  // Bottom of the windshield holds the small route display and the accessibility sticker.
  const wv = 0.18 + r() * 0.32;
  const rot = (r() - 0.5) * (kind === 'decoy' ? 0.2 : 0.5);

  const livery: Livery = r() < YELLOW_SHARE ? 'amarelo' : 'verde';
  const line = pick(livery === 'amarelo' ? YELLOW_LINES : GREEN_LINES);
  // Fleet numbers seen on the real buses: Plataforma 3xxxx, OT Trans 2xxxx.
  const fleet = (livery === 'amarelo' ? 30000 : 20000) + Math.floor(r() * 9000);
  const plate = 'PK' + pick(LETTERS) + Math.floor(r() * 10) + pick(LETTERS) + String(Math.floor(r() * 100)).padStart(2, '0');

  return { index: i, kind, hp, decoy, wu, wv, rot, livery, line, fleet, plate };
}

export function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/** Event codes in the run log. */
export const EV = { SCRAPE: 0, DECOY: 1, RELEASE: 2, ACCESS: 3 } as const;
/** Every bus has the (mandatory) accessibility sticker at this spot of the windshield. */
export const ACCESS_STICKER = { wu: 0.6, wv: 0.84 } as const;
export type EvCode = (typeof EV)[keyof typeof EV];
/** [time in ms since the run started, event code] */
export type RunEvent = [number, EvCode];

export interface RunResult {
  ok: boolean;
  reason?: string;
  score: number;
  scraped: number;
  passed: number;
  forced: number;
  decoyHits: number;
  accessHits: number;
  blocked: number;
  buses: number;
}

/** Replays a run log against the rules. Used by the API to score a run. */
export function replay(seed: number, events: unknown): RunResult {
  const res: RunResult = { ok: false, score: 0, scraped: 0, passed: 0, forced: 0, decoyHits: 0, accessHits: 0, blocked: 0, buses: 0 };
  const fail = (reason: string) => ({ ...res, ok: false, reason });
  if (!Array.isArray(events)) return fail('log inválido');
  if (events.length > MAX_EVENTS) return fail('log grande demais');

  let i = 0;
  let spec = busSpec(seed, 0);
  let hp = spec.hp;
  let readyAt = ENTER_MS;
  let lastT = -Infinity;
  let lastScrape = -Infinity;

  const next = (leaveAt: number) => {
    i++;
    spec = busSpec(seed, i);
    hp = spec.hp;
    readyAt = leaveAt + EXIT_MS + ENTER_MS;
  };

  for (const ev of events) {
    if (!Array.isArray(ev) || ev.length !== 2) return fail('evento inválido');
    const [t, code] = ev as [unknown, unknown];
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 0) return fail('tempo inválido');
    if (t < lastT) return fail('fora de ordem');
    if (t > GAME_MS + TOL) return fail('depois do fim');
    if (t < readyAt - TOL) return fail('antes do ônibus chegar');
    lastT = t;

    if (code === EV.SCRAPE) {
      if (spec.kind !== '13' || hp <= 0) return fail('raspou o nada');
      if (t - lastScrape < MIN_SCRAPE_GAP_MS - 5) return fail('rápido demais');
      lastScrape = t;
      hp--;
      if (hp === 0) {
        res.score++; res.scraped++;
        next(t + AUTO_RELEASE_MS);
      }
    } else if (code === EV.DECOY) {
      if (spec.kind !== 'decoy') return fail('isca inexistente');
      res.score = Math.max(0, res.score - 1);
      res.decoyHits++;
    } else if (code === EV.ACCESS) {
      res.score = Math.max(0, res.score - 1);
      res.accessHits++;
    } else if (code === EV.RELEASE) {
      if (spec.kind === '13' && hp > 0) {
        if (t < UNLOCK_MS - TOL) { res.blocked++; continue; }
        res.forced++;
      } else {
        res.passed++;
      }
      next(t);
    } else {
      return fail('código inválido');
    }
  }
  res.buses = res.scraped + res.passed + res.forced;
  res.ok = true;
  return res;
}
