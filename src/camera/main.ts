// Raspa Buzu, camera mode: scrape the 13 sticker off the windshield with your finger,
// thumbs-up the bus out, and get a shareable video of the round.

import {
  AUTO_RELEASE_MS, BUS_CAPACITY, ENTER_MS, EV, EXIT_MS, MIN_SCRAPE_GAP_MS, RETIDOS,
  busSpec, randomSeed, type BusSpec, type RunEvent,
} from '../sim.ts';
import { ACCESS_TOAST, CLEAN_BUS_TOASTS, DECOYS, EVENTS, PARIS_AFTER, PARIS_BEFORE, baratinoLevel, clockMinutes, clockText, rankFor } from '../content.ts';
import { HandTracker, OneEuro, isThumbUp, type Pt } from './hands.ts';
import { ThumbGate } from './thumb-gate.ts';
import { Sfx } from './audio.ts';
import { CanvasRecorder } from './recorder.ts';
import { accessCenter, drawBusFront, stickerCenter, stickerRadius, type Rect } from './bus-art.ts';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const cv = $<HTMLCanvasElement>('#cv');
const ctx = cv.getContext('2d')!;
/** Game coordinates are 720x1280; the canvas is smaller (cheaper to draw and to encode). */
const W = 720, H = 1280;
const S = cv.width / W;
const RENDER_CAP = 30;              // leaves GPU time for the detector (see spike results)
// The recording (round + end card) must fit a 60 s story/status clip: 56 s + 2.5 s = 58.5 s.
const ROUND_MS = 56_000;
const END_CARD_MS = 2500;
const SHARE_URL = location.origin;
const DEBUG = new URLSearchParams(location.search).has('debug');
/** ?rec=0 turns recording off, to measure what it costs on a given phone. */
const RECORD = new URLSearchParams(location.search).get('rec') !== '0';
// Test aids: ?mouse=1 lets the pointer play the fingertip; with it, ?speed=N fast-forwards the clock.
const QS = new URLSearchParams(location.search);
const MOUSE = QS.has('mouse');
const SPEED = MOUSE ? Math.max(1, Number(QS.get('speed')) || 1) : 1;

// ?gr=0 falls back to the plain landmarker (thumbs-up from a pose heuristic) for comparison.
const GESTURE_MODEL = new URLSearchParams(location.search).get('gr') !== '0';
const tracker = GESTURE_MODEL
  ? new HandTracker('/mediapipe/wasm', '/mediapipe/gesture_recognizer.task', 'gesture')
  : new HandTracker('/mediapipe/wasm', '/mediapipe/hand_landmarker.task', 'landmarker');
const THUMB_MIN_SCORE = 0.55;
const video = document.createElement('video');
video.playsInline = true; video.muted = true;
let sfx: Sfx | null = null;
const recorder = new CanvasRecorder();

type Mode = 'intro' | 'waiting' | 'countdown' | 'play' | 'endcard' | 'end';
let mode: Mode = 'intro';

// ---------- run state (mirrors the rules in sim.ts) ----------
interface BusState { spec: BusSpec; hp: number; enterAt: number; readyAt: number; releaseAt: number | null; how: string; firstScrapeAt: number | null }
let seed = randomSeed();
let elapsed = 0;
let bus: BusState;
let events: RunEvent[] = [];
// score = buses sent out. It only ever goes up: penalties cost time (the bus is held), not buses.
let score = 0, scraped = 0, passed = 0, forced = 0, blocked = 0, penalties = 0;
/** How long each sticker took from the first scrape to coming off, in ms. */
let ripMs: number[] = [];
let voters = 300;
let eventIdx = 0, unlocked = false, arrested = false;
let lastScrapeT = -Infinity, penaltyCooldown = 0;
/** Game time until which the current bus is held after a penalty. */
let holdUntil = 0;
const PENALTY_HOLD_MS = 1000;

function newBus(i: number, enterAt: number): BusState {
  const spec = busSpec(seed, i);
  return { spec, hp: spec.hp, enterAt, readyAt: enterAt + ENTER_MS, releaseAt: null, how: '', firstScrapeAt: null };
}

function resetRun() {
  seed = randomSeed();
  elapsed = 0; events = [];
  score = scraped = passed = forced = blocked = penalties = 0;
  ripMs = [];
  releaseTimes = []; mayorCooldown = 0; mayorShownAt = 0;
  voters = 300; eventIdx = 0; unlocked = false; arrested = false;
  lastScrapeT = -Infinity; penaltyCooldown = 0; holdUntil = 0;
  paris = { text: '', until: 0, next: PARIS_FIRST_MS, before: shuffle(PARIS_BEFORE), after: shuffle(PARIS_AFTER) };
  barataFlash = 0;
  banner = { text: '', until: 0 };
  bus = newBus(0, 0);
}
resetRun();

// ---------- layout ----------
const BUS: Rect = { x: 70, w: 580, h: 580 / 0.82, y: 0 };
BUS.y = H - BUS.h - 46;

function busRect(now = elapsed): Rect & { a: number } {
  let s = 1, a = 1, x = BUS.x;
  if (now < bus.readyAt) { const k = easeOut(Math.max(0, (now - bus.enterAt) / ENTER_MS)); s = 0.6 + 0.4 * k; a = k; }
  if (bus.releaseAt !== null && now >= bus.releaseAt) { const k = easeIn(Math.min(1, (now - bus.releaseAt) / EXIT_MS)); x = BUS.x + (W - BUS.x + 60) * k; }
  const w = BUS.w * s, h = BUS.h * s;
  return { x: x + (BUS.w - w) / 2, y: BUS.y + (BUS.h - h), w, h, a };
}
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
const easeIn = (k: number) => k * k * k;
const interactive = () => mode === 'play' && elapsed >= bus.readyAt && bus.releaseAt === null && elapsed >= holdUntil;

// ---------- camera ----------
let map = { ox: 0, oy: 0, dw: W, dh: H };
function computeMap() {
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const s = Math.max(W / vw, H / vh);
  map = { dw: vw * s, dh: vh * s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2 };
}
const toCanvas = (p: Pt) => ({ x: map.ox + (1 - p.x) * map.dw, y: map.oy + p.y * map.dh });

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', height: { ideal: 720 }, width: { ideal: 1280 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  computeMap();
}

// ---------- hand input ----------
// Hit tests use the raw fingertip: smoothing it costs ~100-150 ms at 6-9 detections/s.
// Only the drawn cursor is smoothed, and it is projected ahead to hide the detection gap.
const fx = new OneEuro(2.5, 0.05), fy = new OneEuro(2.5, 0.05);
let tip: (Pt & { t: number }) | null = null;
let vel = { x: 0, y: 0 };
let handSince = 0;
const THUMB_FRAMES = 2;          // consecutive detections showing 👍 (~0.25 s on the A17)
const THUMB_GRACE_MS = 400;      // a bus must be parked this long before a 👍 can release it
const thumbGate = new ThumbGate(THUMB_FRAMES);
const thumbReady = () => interactive() && elapsed >= bus.readyAt + THUMB_GRACE_MS;

tracker.onResult = (lm, now, gesture) => {
  if (!lm) { tip = null; fx.reset(); fy.reset(); handSince = 0; thumbGate.lost(); return; }
  if (!handSince) handSince = now;
  const p = { ...toCanvas(lm[8]), t: now };
  if (tip) {
    const dt = Math.max(1, now - tip.t);
    vel = { x: (p.x - tip.x) / dt, y: (p.y - tip.y) / dt };
    if (interactive()) scrapeAlong(tip, p);
  }
  tip = p;

  const thumbs = tracker.kind === 'gesture'
    ? gesture?.name === 'Thumb_Up' && gesture.score >= THUMB_MIN_SCORE
    : isThumbUp(lm);
  // One release per thumbs-up: the gate stays shut until the thumb drops.
  if (thumbGate.update(thumbs, thumbReady())) tryRelease();
};

/** Drawn cursor: last fingertip projected along its velocity for up to one detection gap. */
function cursorPos(now: number) {
  if (!tip) return null;
  const ahead = Math.min(now - tip.t, 120);
  return { x: fx.filter(tip.x + vel.x * ahead, now), y: fy.filter(tip.y + vel.y * ahead, now) };
}

function segDist(px: number, py: number, a: Pt, b: Pt) {
  const vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy || 1;
  const k = Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / len2));
  return Math.hypot(px - (a.x + k * vx), py - (a.y + k * vy));
}

/** Every detection whose movement crosses the sticker counts as one scrape. */
function scrapeAlong(a: Pt & { t: number }, b: Pt & { t: number }) {
  const r = busRect(), sr = stickerRadius(r);
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  if (dist / Math.max(1, b.t - a.t) < 0.15) return;   // px/ms: the finger has to be moving
  const t = Math.round(elapsed);

  // Penalty stickers: accessibility (always there) and non-candidate decoys. Only when the
  // fingertip lands on them, not when a scraping stroke merely passes across.
  if (t > penaltyCooldown) {
    const ac = accessCenter(r);
    if (Math.hypot(b.x - ac.x, b.y - ac.y) < sr * 0.8) { penalty(EV.ACCESS, ACCESS_TOAST, t); return; }
    if (bus.spec.kind === 'decoy') {
      const dc = stickerCenter(r, bus.spec);
      if (Math.hypot(b.x - dc.x, b.y - dc.y) < sr * 1.1) { penalty(EV.DECOY, DECOYS[bus.spec.decoy].toast, t); return; }
    }
  }

  if (bus.spec.kind !== '13' || bus.hp <= 0) return;
  const c = stickerCenter(r, bus.spec);
  if (segDist(c.x, c.y, a, b) > sr * 1.6) return;
  if (t - lastScrapeT < MIN_SCRAPE_GAP_MS) return;
  lastScrapeT = t;
  if (bus.firstScrapeAt === null) bus.firstScrapeAt = t;
  bus.hp--;
  events.push([t, EV.SCRAPE]);
  sfx?.scrape();
  chips(c.x, c.y, 5, '#d4251c');
  if (bus.hp === 0) {
    scraped++;
    ripMs.push(t - bus.firstScrapeAt);
    sfx?.pop();
    chips(c.x, c.y, 16, '#d4251c'); chips(c.x, c.y, 6, '#ffffff');
    floaters.push({ x: c.x, y: c.y - sr, text: '+1', life: 0.9, color: '#f5c518' });
    leave(t + AUTO_RELEASE_MS, 'scraped');
  }
}

function penalty(code: typeof EV.ACCESS | typeof EV.DECOY, text: string, t: number) {
  events.push([t, code]);
  penalties++;
  holdUntil = t + PENALTY_HOLD_MS;
  penaltyCooldown = t + 1200;
  sfx?.bad();
  toast(`${text} (perdeu 1 s)`);
}

function tryRelease() {
  const t = Math.round(elapsed);
  events.push([t, EV.RELEASE]);
  if (bus.spec.kind === '13' && bus.hp > 0) {
    if (!unlocked) { blocked++; sfx?.bad(); toast('Regra da Semob: com adesivo do 13 não sai. Raspa!'); return; }
    forced++; leave(t, 'forced'); return;
  }
  // A bus with no 13 sticker: it could have left all along. Feeds the baratinômetro
  // ("baratino": Bahian slang for a flimsy excuse).
  const levelBefore = baratinoLevel(passed);
  passed++;
  barataFlash = performance.now() + 700;
  const levelNow = baratinoLevel(passed);
  toast(levelNow !== levelBefore ? `Baratinômetro: ${levelNow}!` : CLEAN_BUS_TOASTS[(passed - 1) % CLEAN_BUS_TOASTS.length]);
  leave(t, 'pass');
}

function leave(at: number, how: string) {
  bus.releaseAt = at; bus.how = how;
  score++;
  voters = Math.max(0, voters - BUS_CAPACITY);
  setTimeout(() => sfx?.horn(), Math.max(0, at - elapsed));
  checkMayor(at);
}

// ---------- easter egg: releasing buses too fast brings the mayor in ----------
// Satire cameo (fictional line, cartoon of the mayor) drawn into the canvas, so it is in the video.
const MAYOR_IMG = new Image();
MAYOR_IMG.src = '/easter/prefeito.png';
const MAYOR_BURST = 3;               // buses released...
const MAYOR_WINDOW_MS = 5000;        // ...within this much game time
const MAYOR_COOLDOWN_MS = 15000;     // game time before he can show up again
const MAYOR_SHOW_MS = 2600;          // real time on screen
const MAYOR_SLIDE_MS = 260;
let releaseTimes: number[] = [];
let mayorCooldown = 0;
let mayorShownAt = 0;

function checkMayor(at: number) {
  releaseTimes.push(at);
  while (releaseTimes.length && at - releaseTimes[0] > MAYOR_WINDOW_MS) releaseTimes.shift();
  if (releaseTimes.length >= MAYOR_BURST && at >= mayorCooldown) {
    mayorShownAt = performance.now();
    mayorCooldown = at + MAYOR_COOLDOWN_MS;
    releaseTimes = [];
    sfx?.bad();
  }
}

function drawMayor(now: number) {
  const t = now - mayorShownAt;
  if (!mayorShownAt || t > MAYOR_SHOW_MS || !MAYOR_IMG.complete || !MAYOR_IMG.naturalWidth) return;
  const h = 560, w = h * (MAYOR_IMG.naturalWidth / MAYOR_IMG.naturalHeight);
  const slideIn = Math.min(1, t / MAYOR_SLIDE_MS), slideOut = Math.min(1, (MAYOR_SHOW_MS - t) / MAYOR_SLIDE_MS);
  const k = easeOut(Math.min(slideIn, slideOut));
  const x = -w + (w - 10) * k, y = H - h - 20;
  ctx.drawImage(MAYOR_IMG, x, y, w, h);

  // speech bubble to the right of his face, tail pointing at the mouth
  const bx = x + w * 0.72, by = y - 10, bw = 400, bh = 150;
  ctx.globalAlpha = k;
  ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#16191a'; ctx.lineWidth = 6;
  ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 28); else ctx.rect(bx, by, bw, bh);
  ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bx + 40, by + bh - 4); ctx.lineTo(x + w * 0.62, y + h * 0.2); ctx.lineTo(bx + 100, by + bh - 4);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ffffff'; ctx.fillRect(bx + 44, by + bh - 9, 52, 10);
  ctx.fillStyle = '#16191a'; ctx.font = '400 40px Bungee, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('DÁ UMA', bx + bw / 2, by + 50, bw - 30);
  ctx.fillText('SEGURADA AÍ!', bx + bw / 2, by + 100, bw - 30);
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = 1;
}

// ---------- effects ----------
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; s: number }
let particles: Particle[] = [];
let floaters: { x: number; y: number; text: string; life: number; color: string }[] = [];
let toastMsg = { text: '', until: 0 };
let banner = { text: '', until: 0 };
// The absent secretary texts often: every 4.5-6.5 s, and every 3-4.5 s once the arrest warrant is out.
const PARIS_FIRST_MS = 4000;
const PARIS_SHOW_MS = 3200;
let paris = { text: '', until: 0, next: PARIS_FIRST_MS, before: [] as string[], after: [] as string[] };
let barataFlash = 0;
function shuffle<T>(arr: readonly T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function chips(x: number, y: number, n: number, color: string) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = 80 + Math.random() * 260;
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 140, life: 0.7 + Math.random() * 0.4, color, s: 4 + Math.random() * 7 });
  }
}
function toast(text: string) { toastMsg = { text, until: performance.now() + 1500 }; }

// ---------- game flow ----------
let countdownStart = 0;
let endcardStart = 0;

function update(dt: number, now: number) {
  if (mode === 'waiting' && (tracker.ready || MOUSE) && handSince && now - handSince > 600) {
    mode = 'countdown'; countdownStart = now; sfx?.beep();
  }
  if (mode === 'countdown') {
    const n = 3 - Math.floor((now - countdownStart) / 800);
    if (n !== lastCount) { lastCount = n; if (n > 0) sfx?.beep(); }
    if (now - countdownStart >= 2400) startRound();
  }
  if (mode === 'play') {
    elapsed += dt * 1000 * SPEED;
    voters += (35 + (elapsed / 1000) * 1.6) * dt;
    const m = clockMinutes(elapsed, ROUND_MS);
    while (eventIdx < EVENTS.length && m >= EVENTS[eventIdx].at) {
      const ev = EVENTS[eventIdx++];
      banner = { text: ev.text, until: now + 3200 }; sfx?.ping();
      if (ev.unlock) unlocked = true;
      if (ev.arrest) { arrested = true; paris.next = Math.min(paris.next, elapsed + 1500); }
    }
    if (elapsed >= paris.next) {
      const pool = arrested ? paris.after : paris.before;
      if (!pool.length) pool.push(...shuffle(arrested ? PARIS_AFTER : PARIS_BEFORE));
      paris.text = pool.shift()!;
      paris.until = now + PARIS_SHOW_MS; sfx?.ping();
      paris.next = elapsed + (arrested ? 3000 + Math.random() * 1500 : 4500 + Math.random() * 2000);
    }
    if (bus.releaseAt !== null && elapsed >= bus.releaseAt + EXIT_MS) {
      bus = newBus(bus.spec.index + 1, bus.releaseAt + EXIT_MS);
      thumbGate.newBus();
    }
    if (elapsed >= ROUND_MS) { elapsed = ROUND_MS; mode = 'endcard'; endcardStart = now; sfx?.horn(); }
  }
  if (mode === 'endcard' && now - endcardStart > END_CARD_MS) finish();

  for (const p of particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 800 * dt; }
  particles = particles.filter((p) => p.life > 0);
  for (const f of floaters) { f.life -= dt; f.y -= 60 * dt; }
  floaters = floaters.filter((f) => f.life > 0);
}
let lastCount = 4;

function startRound() {
  // The run was reset when waiting began, so the bus shown in the countdown is bus 0.
  mode = 'play';
  if (RECORD) recorder.start(cv, sfx?.stream);
  sfx?.horn();
}

// ---------- drawing ----------
function draw(now: number) {
  ctx.setTransform(S, 0, 0, S, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (video.readyState >= 2) {
    computeMap();
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, W - map.ox - map.dw, map.oy, map.dw, map.dh);
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, 0, W, H);
  }

  if (mode === 'play' || mode === 'countdown' || mode === 'waiting') {
    const r = busRect(mode === 'play' ? elapsed : bus.readyAt);
    ctx.globalAlpha = r.a;
    drawBusSprite(r);
    ctx.globalAlpha = 1;
    if (bus.releaseAt !== null && elapsed >= bus.releaseAt) stamp(r, bus.how === 'forced' ? 'SAIU ADESIVADO' : 'LIBERADO', bus.how === 'forced' ? '#d4251c' : '#1f9d55');
    else if (mode === 'play' && elapsed < holdUntil) stamp(r, 'TRAVADO', '#d4251c');
  }
  for (const p of particles) { ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5)); ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.s, p.s * 0.6); }
  ctx.globalAlpha = 1;
  for (const f of floaters) {
    ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.5));
    ctx.fillStyle = f.color; ctx.font = '400 56px Bungee, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
  if (mode === 'play') drawMayor(now);
  const cur = cursorPos(now);
  if (cur && mode !== 'endcard') drawScraper(cur);

  drawHud();
  if (now < banner.until) drawBanner(banner.text);
  if (now < paris.until) drawParis(paris.text);
  if (now < toastMsg.until) drawToast(toastMsg.text);
  if (mode === 'waiting') drawCenter(tracker.ready ? 'Mostre a mão pra câmera' : `Carregando o detector… ${loadPct()}`);
  if (mode === 'countdown') drawCenter(String(Math.max(1, 3 - Math.floor((now - countdownStart) / 800))), 200);
  if (mode === 'play') drawTimeBar();
  if (mode === 'endcard') drawEndCard();
  if (DEBUG) drawDebug();
}

// The bus front is vector art with text; drawing it once per bus/sticker state and blitting
// the bitmap keeps per-frame work small. Padding leaves room for the side mirrors.
const SPRITE_PAD = 0.15;
let sprite: { key: string; canvas: HTMLCanvasElement } | null = null;
function drawBusSprite(r: Rect) {
  const key = `${seed}:${bus.spec.index}:${bus.hp}`;
  if (!sprite || sprite.key !== key) {
    const c = sprite?.canvas ?? document.createElement('canvas');
    c.width = Math.round(BUS.w * (1 + 2 * SPRITE_PAD) * S);
    c.height = Math.round(BUS.h * S);
    const g = c.getContext('2d')!;
    g.setTransform(S, 0, 0, S, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    drawBusFront(g, { x: BUS.w * SPRITE_PAD, y: 0, w: BUS.w, h: BUS.h }, bus);
    sprite = { key, canvas: c };
  }
  const k = r.w / BUS.w;
  ctx.drawImage(sprite.canvas, r.x - BUS.w * SPRITE_PAD * k, r.y, BUS.w * (1 + 2 * SPRITE_PAD) * k, r.h);
}

const drawTimes: number[] = [];
function drawDebug() {
  const t = tracker.timings();
  const avg = drawTimes.length ? drawTimes.reduce((a, b) => a + b, 0) / drawTimes.length : 0;
  const lines = [
    `det ${tracker.fps().toFixed(1)}/s · inferência ${t.inferMs.toFixed(0)} ms · atraso ${t.latencyMs.toFixed(0)} ms`,
    `desenho ${avg.toFixed(1)} ms · ${tracker.delegate} · ${tracker.source} · gravação ${RECORD ? 'on' : 'off'} · tela ${cv.width}x${cv.height}`,
    `modelo ${tracker.kind} · gesto ${tracker.lastGesture ? `${tracker.lastGesture.name} ${(tracker.lastGesture.score * 100).toFixed(0)}%` : '-'} · joinhas seguidos ${thumbGate.streak} (${thumbGate.isArmed ? 'armado' : 'solte o polegar'})`,
  ];
  ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, H - 120, W, 100);
  ctx.fillStyle = '#7CFC9A'; ctx.font = '400 26px VT323, monospace'; ctx.textAlign = 'left';
  lines.forEach((l, i) => ctx.fillText(l, 12, H - 92 + i * 28));
}

function loadPct() {
  const { bytes, total } = tracker.progress;
  return total ? `${Math.round((bytes / total) * 100)}%` : '';
}

function drawScraper(p: Pt) {
  ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(-0.5);
  ctx.fillStyle = '#c9ced1'; ctx.strokeStyle = '#3b4244'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(-34, -6); ctx.lineTo(34, -6); ctx.lineTo(26, 18); ctx.lineTo(-26, 18); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#f5c518'; ctx.fillRect(-10, 18, 20, 46); ctx.strokeRect(-10, 18, 20, 46);
  ctx.restore();
}

function stamp(r: Rect, label: string, color: string) {
  ctx.save(); ctx.translate(r.x + r.w / 2, r.y + r.h * 0.38); ctx.rotate(-0.12);
  ctx.font = '400 54px Bungee, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(-tw / 2 - 18, -42, tw + 36, 84);
  ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.strokeRect(-tw / 2 - 18, -42, tw + 36, 84);
  ctx.fillStyle = color; ctx.fillText(label, 0, 4);
  ctx.restore(); ctx.textBaseline = 'alphabetic';
}

function drawHud() {
  ctx.fillStyle = 'rgba(10,12,12,0.82)'; ctx.fillRect(0, 0, W, 118);
  const cols = [
    ['RELÓGIO', clockText(clockMinutes(elapsed, ROUND_MS))],
    ['NA RUA', String(score)],
    ['PASSAGEIROS\nESPERANDO', Math.round(voters).toLocaleString('pt-BR')],
    ['BARATINÔMETRO', String(passed)],
  ];
  const lit = performance.now() < barataFlash;
  cols.forEach(([label, value], i) => {
    const x = 24 + i * 176;
    ctx.fillStyle = i === 3 && lit ? '#ff6b5e' : '#9ba5a4'; ctx.textAlign = 'left';
    const parts = label.split('\n');
    if (parts.length > 1) {
      ctx.font = '700 16px Archivo, sans-serif';
      parts.forEach((p, j) => ctx.fillText(p, x, 26 + j * 18, 170));
    } else {
      ctx.font = '700 20px Archivo, sans-serif';
      ctx.fillText(label, x, 40, i === 3 ? 160 : 170);
    }
    if (i === 3) return;   // the baratinômetro draws its own gauge below
    ctx.fillStyle = i === 2 ? '#f3f1ea' : '#ffae1a';
    ctx.font = '400 58px VT323, monospace'; ctx.fillText(value, x, 94);
  });
  // Baratinômetro: how flimsy the Semob's sticker excuse looks. One notch per clean bus,
  // yellow to red, with the Bahian level name (migué, quatchá quatchá, baratino master) below.
  const gx = 24 + 3 * 176, gw = 160, notches = 10, filled = Math.min(notches, passed);
  for (let n = 0; n < notches; n++) {
    const hue = 50 - (n / (notches - 1)) * 50;           // 50 = yellow, 0 = red
    ctx.fillStyle = n < filled ? `hsl(${hue} 95% ${lit ? 62 : 52}%)` : 'rgba(255,255,255,0.15)';
    ctx.fillRect(gx + n * (gw / notches), 50, gw / notches - 3, 22);
  }
  const level = baratinoLevel(passed);
  if (level) {
    ctx.fillStyle = lit ? '#ff6b5e' : passed >= 7 ? '#ff8d84' : '#f5c518';
    ctx.font = '400 22px Bungee, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(level.toUpperCase(), gx, 102, gw);
  }
}

function drawBanner(text: string) {
  ctx.font = '400 36px VT323, monospace';
  const lines = wrap(text, W - 80);
  const h = 22 + lines.length * 36;
  ctx.fillStyle = 'rgba(8,10,10,0.88)'; ctx.fillRect(24, 132, W - 48, h);
  ctx.fillStyle = '#ffae1a'; ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, 132 + 40 + i * 36));
}

function drawParis(text: string) {
  const x = 30, y = 250, w = W - 60;
  ctx.font = '500 30px Archivo, sans-serif';
  const lines = wrap(text, w - 40);
  const h = 70 + lines.length * 36;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, 22); else ctx.rect(x, y, w, h); ctx.fill();
  ctx.fillStyle = '#1f3fa0'; ctx.fillRect(x + 20, y + 20, 14, 20); ctx.fillStyle = '#fff'; ctx.fillRect(x + 34, y + 20, 14, 20); ctx.fillStyle = '#d4251c'; ctx.fillRect(x + 48, y + 20, 14, 20);
  ctx.fillStyle = '#15191a'; ctx.font = '800 24px Archivo, sans-serif'; ctx.textAlign = 'left'; ctx.fillText('Secretário (em Paris)', x + 74, y + 38);
  ctx.fillStyle = '#6b7273'; ctx.textAlign = 'right'; ctx.fillText('agora', x + w - 20, y + 38);
  ctx.fillStyle = '#15191a'; ctx.font = '500 30px Archivo, sans-serif'; ctx.textAlign = 'left';
  lines.forEach((l, i) => ctx.fillText(l, x + 20, y + 84 + i * 36));
}

function drawToast(text: string) {
  ctx.font = '800 30px Archivo, sans-serif';
  const lines = wrap(text, W - 100);
  const h = 24 + lines.length * 36, y = BUS.y - h - 20;
  ctx.fillStyle = '#f5c518'; ctx.fillRect(40, y, W - 80, h);
  ctx.fillStyle = '#16191a'; ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y + 42 + i * 36));
}

function drawCenter(text: string, size = 52) {
  ctx.font = `400 ${size}px Bungee, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  for (const [i, l] of wrap(text, W - 80).entries()) { const y = H * 0.3 + i * size * 1.1; ctx.strokeText(l, W / 2, y); ctx.fillStyle = '#f5c518'; ctx.fillText(l, W / 2, y); }
  ctx.textBaseline = 'alphabetic';
}

function drawTimeBar() {
  const k = Math.min(1, elapsed / ROUND_MS);
  ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(0, H - 14, W, 14);
  ctx.fillStyle = k > 0.85 ? '#d4251c' : '#f5c518'; ctx.fillRect(0, H - 14, W * (1 - k), 14);
}

/** End-of-round card, in 720x1280 game units. Drawn into the video and into the shareable image. */
function drawEndCard(g: CanvasRenderingContext2D = ctx) {
  g.fillStyle = '#101314'; g.fillRect(0, 0, W, H);
  for (let x = -40; x < W + 40; x += 48) {
    g.fillStyle = '#f5c518'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 24, 0); g.lineTo(x - 10, 34); g.lineTo(x - 34, 34); g.fill();
  }
  g.textAlign = 'center';
  g.fillStyle = '#ffae1a'; g.font = '400 40px VT323, monospace'; g.fillText('SALVADOR · 25/10 · 2º TURNO', W / 2, 150);
  g.fillStyle = '#f5c518'; g.font = '400 110px Bungee, sans-serif'; g.fillText('RASPA', W / 2, 290);
  g.fillStyle = '#f3f1ea'; g.fillText('BUZU', W / 2, 400);
  g.fillStyle = '#f5c518'; g.font = '400 260px Bungee, sans-serif'; g.fillText(String(score), W / 2, 700);
  g.fillStyle = '#f3f1ea'; g.font = '800 40px Archivo, sans-serif'; g.fillText('ônibus na rua em 1 minuto', W / 2, 770);
  const level = baratinoLevel(passed);
  g.fillStyle = level ? '#ff8d84' : '#f3f1ea'; g.font = '400 36px Bungee, sans-serif';
  g.fillText(level ? `NÍVEL DE BARATINO: ${level.toUpperCase()}` : rankFor(score).toUpperCase(), W / 2, 845, W - 50);
  g.fillStyle = '#ffae1a'; g.font = '400 34px VT323, monospace';
  wrap(summaryText('meu'), W - 80, g).forEach((l, i) => g.fillText(l, W / 2, 905 + i * 37));
  g.fillStyle = '#9ba5a4'; g.font = '600 28px Archivo, sans-serif'; g.fillText(`Sátira · ${SHARE_URL.replace(/^https?:\/\//, '')}`, W / 2, 1245);
}

const wrapCache = new Map<string, string[]>();
function wrap(text: string, max: number, g: CanvasRenderingContext2D = ctx) {
  const key = `${g.font}|${max}|${text}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  const lines = wrapUncached(text, max, g);
  if (wrapCache.size > 64) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}
function wrapUncached(text: string, max: number, g: CanvasRenderingContext2D) {
  const words = text.split(' '), lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > max && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

const fmt1 = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
// Stickers removed per minute (the run mixes in clean buses, so this undersells the player).
const paceMinutes = () => (scraped > 0 ? (RETIDOS * ROUND_MS) / scraped / 60_000 : null);
const ripAvgSec = () => (ripMs.length ? ripMs.reduce((a, b) => a + b, 0) / ripMs.length / 1000 : null);
const buses = (n: number) => `${n} ônibus`;

/** End-of-round summary (user's wording), shared by the end screen ("seu") and the video card ("meu"). */
function summaryText(who: 'seu' | 'meu') {
  const m = paceMinutes(), rip = ripAvgSec();
  const parts: string[] = [];
  if (passed > 0) parts.push(`${buses(passed)} ${passed === 1 ? 'nem tinha adesivo e mesmo assim demorou de sair' : 'nem tinham adesivo e mesmo assim demoraram de sair'}. Que desculpa era essa?`);
  if (rip !== null) parts.push(`Tirar cada adesivo aqui no jogo levou ${fmt1(rip)} s em média.`);
  if (m !== null) parts.push(`No ${who} ritmo, os ${RETIDOS} ônibus que a prefeitura admite estariam na rua em ${fmt1(m)} minutos.`);
  parts.push('O Procon-BA contou 944 ônibus parados em 9 garagens, e às 15h30 ainda havia garagem lotada.');
  return parts.join(' ');
}

// ---------- end screen ----------
let lastFile: File | null = null;
/** The end card as a story-sized image, for players who do not want to show up on video. */
let cardFile: File | null = null;

function renderCardImage(): Promise<File | null> {
  const c = document.createElement('canvas');
  c.width = 1080; c.height = 1920;
  const g = c.getContext('2d');
  if (!g) return Promise.resolve(null);
  g.setTransform(c.width / W, 0, 0, c.height / H, 0, 0);
  drawEndCard(g);
  return new Promise((resolve) => c.toBlob(
    (blob) => resolve(blob ? new File([blob], `raspa-buzu-${score}-onibus.png`, { type: 'image/png' }) : null),
    'image/png',
  ));
}

async function finish() {
  mode = 'end';
  const [file, card] = await Promise.all([recorder.stop(`raspa-buzu-${score}-onibus`), renderCardImage()]);
  lastFile = file;
  cardFile = card;
  const endEl = $<HTMLElement>('#end');
  $<HTMLElement>('#eScore').textContent = String(score);
  $<HTMLElement>('#eRank').textContent = rankFor(score);
  const eLine = $<HTMLElement>('#eLine');
  const level = baratinoLevel(passed);
  if (level) {
    const head = document.createElement('strong');
    head.textContent = `Nível de baratino: ${level}`;
    eLine.replaceChildren(head, document.createElement('br'), summaryText('seu'));
  } else {
    eLine.replaceChildren(summaryText('seu'));
  }
  const vid = $<HTMLVideoElement>('#eVideo');
  const share = $<HTMLButtonElement>('#eShare');
  const dl = $<HTMLAnchorElement>('#eDownload');
  if (file) {
    const url = URL.createObjectURL(file);
    vid.src = url; vid.hidden = false;
    dl.href = url; dl.download = file.name; dl.hidden = false;
    share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  } else {
    vid.hidden = true; dl.hidden = true; share.hidden = true;
  }
  const shareCard = $<HTMLButtonElement>('#eShareCard');
  const dlCard = $<HTMLAnchorElement>('#eCardDownload');
  if (card) {
    const url = URL.createObjectURL(card);
    dlCard.href = url; dlCard.download = card.name; dlCard.hidden = false;
    shareCard.hidden = !(navigator.canShare && navigator.canShare({ files: [card] }));
  } else {
    shareCard.hidden = true; dlCard.hidden = true;
  }
  endEl.hidden = false;
}

function shareText() {
  const m = paceMinutes();
  const rip = ripAvgSec();
  const ripText = rip !== null ? ` Tirar o adesivo levou ${fmt1(rip)} s.` : '';
  const pace = m !== null ? ` No meu ritmo, os ${RETIDOS} ônibus retidos em Salvador estariam na rua em ${fmt1(m)} minutos.` : '';
  const clean = passed > 0 ? ` ${buses(passed)} nem tinham adesivo: baratinômetro no ${baratinoLevel(passed)}.` : '';
  return `🚌 Botei ${buses(score)} na rua em 1 minuto no Raspa Buzu.${clean}${ripText}${pace} O Procon contou 944 ônibus parados. Duvido você. ${SHARE_URL}/camera/`;
}

$<HTMLButtonElement>('#eShare').addEventListener('click', async () => {
  if (!lastFile) return;
  try { await navigator.share({ files: [lastFile], text: shareText() }); }
  catch { /* user closed the share sheet */ }
});
$<HTMLButtonElement>('#eShareCard').addEventListener('click', async () => {
  if (!cardFile) return;
  try { await navigator.share({ files: [cardFile], text: shareText() }); }
  catch { /* user closed the share sheet */ }
});
$<HTMLButtonElement>('#eAgain').addEventListener('click', () => {
  $<HTMLElement>('#end').hidden = true;
  mode = 'waiting'; handSince = 0; resetRun();
});

// ---------- mouse stand-in (?mouse=1): desktop testing without a camera ----------
// The pointer plays the fingertip, a click is a scrape stroke, the W key or a right click waves.

if (MOUSE) {
  const pos = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H, t: performance.now() };
  };
  cv.addEventListener('pointermove', (e) => {
    const p = pos(e);
    if (!handSince) handSince = p.t;
    if (tip && interactive() && e.buttons) scrapeAlong(tip, p);
    tip = p; vel = { x: 0, y: 0 };
  });
  const thumbsUp = () => { if (interactive()) tryRelease(); };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'w' || e.key === ' ') thumbsUp();
    if (e.key === 'p') mayorShownAt = performance.now();   // preview the mayor cameo
    if (e.key === 'e' && mode === 'play') elapsed = ROUND_MS; // jump to the end card
  });
  cv.addEventListener('contextmenu', (e) => { e.preventDefault(); thumbsUp(); });
}

// ---------- start ----------
$<HTMLButtonElement>('#startBtn').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('#startBtn');
  btn.disabled = true;
  sfx = new Sfx(); sfx.resume();
  try {
    if (!MOUSE) await startCamera();
  } catch (e) {
    btn.disabled = false;
    $<HTMLElement>('#startErr').textContent = 'Não deu pra abrir a câmera. Libere o acesso nas permissões do navegador e tente de novo.';
    return;
  }
  try { await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request('screen'); } catch { /* optional */ }
  $<HTMLElement>('#intro').hidden = true;
  resetRun();
  mode = 'waiting';
});

function introStatus() {
  const el = $<HTMLElement>('#loadStatus');
  if (tracker.error) el.textContent = `O detector de mão falhou: ${tracker.error}`;
  else if (tracker.ready) el.textContent = 'Detector pronto.';
  else el.textContent = `Carregando o detector de mão… ${loadPct()}`;
}

// ---------- loop ----------
let lastT = performance.now(), lastDraw = 0;
function loop() {
  const now = performance.now();
  tracker.pump(video);
  if (now - lastDraw >= 1000 / RENDER_CAP - 2) {
    const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now; lastDraw = now;
    update(dt, now);
    const t0 = performance.now();
    draw(now);
    if (DEBUG) { drawTimes.push(performance.now() - t0); if (drawTimes.length > 30) drawTimes.shift(); }
    if (mode === 'intro') introStatus();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
