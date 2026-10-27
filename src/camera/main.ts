// Raspa Buzu, camera mode: scrape the 13 sticker off the windshield with your finger,
// thumbs-up the bus out, and get a shareable video of the round.

import {
  AUTO_RELEASE_MS, BUS_CAPACITY, ENTER_MS, EV, EXIT_MS, GAME_MS, MIN_SCRAPE_GAP_MS, RETIDOS,
  UNLOCK_MS, busSpec, randomSeed, type BusSpec, type RunEvent,
} from '../sim.ts';
import { ACCESS_TOAST, CLEAN_BUS_TOASTS, DECOYS, EVENTS, PARIS_AFTER, PARIS_BEFORE, clockMinutes, clockText, rankFor } from '../content.ts';
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
// score = buses sent out minus penalties: the headline number is buses on the street, not stickers.
let score = 0, scraped = 0, passed = 0, forced = 0, blocked = 0, penalties = 0;
/** How long each sticker took from the first scrape to coming off, in ms. */
let ripMs: number[] = [];
let voters = 300;
let eventIdx = 0, unlocked = false, arrested = false;
let lastScrapeT = -Infinity, penaltyCooldown = 0;

function newBus(i: number, enterAt: number): BusState {
  const spec = busSpec(seed, i);
  return { spec, hp: spec.hp, enterAt, readyAt: enterAt + ENTER_MS, releaseAt: null, how: '', firstScrapeAt: null };
}

function resetRun() {
  seed = randomSeed();
  elapsed = 0; events = [];
  score = scraped = passed = forced = blocked = penalties = 0;
  ripMs = [];
  voters = 300; eventIdx = 0; unlocked = false; arrested = false;
  lastScrapeT = -Infinity; penaltyCooldown = 0;
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
const interactive = () => mode === 'play' && elapsed >= bus.readyAt && bus.releaseAt === null;

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

  // Penalty stickers: accessibility (always there) and non-candidate decoys.
  if (t > penaltyCooldown) {
    const ac = accessCenter(r);
    if (segDist(ac.x, ac.y, a, b) < sr * 0.9) { penalty(EV.ACCESS, ACCESS_TOAST, t); return; }
    if (bus.spec.kind === 'decoy') {
      const dc = stickerCenter(r, bus.spec);
      if (segDist(dc.x, dc.y, a, b) < sr * 1.2) { penalty(EV.DECOY, DECOYS[bus.spec.decoy].toast, t); return; }
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
    toast(`Adesivo fora em ${fmt1(Math.max(0.1, ripMs[ripMs.length - 1] / 1000))} s. A Semob levou das 9h30 às 12h20.`);
    sfx?.pop();
    chips(c.x, c.y, 16, '#d4251c'); chips(c.x, c.y, 6, '#ffffff');
    floaters.push({ x: c.x, y: c.y - sr, text: '+1', life: 0.9, color: '#f5c518' });
    leave(t + AUTO_RELEASE_MS, 'scraped');
  }
}

function penalty(code: typeof EV.ACCESS | typeof EV.DECOY, text: string, t: number) {
  events.push([t, code]);
  score = Math.max(0, score - 1); penalties++;
  penaltyCooldown = t + 1200;
  sfx?.bad();
  toast(`${text} (−1)`);
}

function tryRelease() {
  const t = Math.round(elapsed);
  events.push([t, EV.RELEASE]);
  if (bus.spec.kind === '13' && bus.hp > 0) {
    if (t < UNLOCK_MS) { blocked++; sfx?.bad(); toast('Regra da Semob: com adesivo do 13 não sai. Raspa!'); return; }
    forced++; leave(t, 'forced'); return;
  }
  // A bus with no 13 sticker: it could have left all along. Feeds the baratinômetro.
  passed++;
  barataFlash = performance.now() + 700;
  toast(CLEAN_BUS_TOASTS[(passed - 1) % CLEAN_BUS_TOASTS.length]);
  leave(t, 'pass');
}

function leave(at: number, how: string) {
  bus.releaseAt = at; bus.how = how;
  score++;
  voters = Math.max(0, voters - BUS_CAPACITY);
  setTimeout(() => sfx?.horn(), Math.max(0, at - elapsed));
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
    const m = clockMinutes(elapsed, GAME_MS);
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
    if (elapsed >= GAME_MS) { elapsed = GAME_MS; mode = 'endcard'; endcardStart = now; sfx?.horn(); }
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
  }
  for (const p of particles) { ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5)); ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.s, p.s * 0.6); }
  ctx.globalAlpha = 1;
  for (const f of floaters) {
    ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.5));
    ctx.fillStyle = f.color; ctx.font = '400 56px Bungee, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
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
    ['RELÓGIO', clockText(clockMinutes(elapsed, GAME_MS))],
    ['NA RUA', String(score)],
    ['NO PONTO', Math.round(voters).toLocaleString('pt-BR')],
    ['BARATINÔMETRO', String(passed)],
  ];
  const lit = performance.now() < barataFlash;
  cols.forEach(([label, value], i) => {
    const x = 24 + i * 176;
    ctx.fillStyle = i === 3 && lit ? '#7CFC9A' : '#9ba5a4'; ctx.font = '700 20px Archivo, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(label, x, 40, i === 3 ? 160 : 170);
    ctx.fillStyle = i === 2 ? '#f3f1ea' : i === 3 ? (lit ? '#7CFC9A' : '#4ade80') : '#ffae1a';
    ctx.font = '400 58px VT323, monospace'; ctx.fillText(value, x, 94);
  });
  // Baratinômetro gauge: one notch per clean bus that could have left all along.
  const gx = 24 + 3 * 176 + 54, gw = 100, notches = 10, filled = Math.min(notches, passed);
  for (let n = 0; n < notches; n++) {
    ctx.fillStyle = n < filled ? (lit ? '#7CFC9A' : '#4ade80') : 'rgba(255,255,255,0.15)';
    ctx.fillRect(gx + n * (gw / notches), 68, gw / notches - 3, 26);
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
  const k = Math.min(1, elapsed / GAME_MS);
  ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(0, H - 14, W, 14);
  ctx.fillStyle = k > 0.85 ? '#d4251c' : '#f5c518'; ctx.fillRect(0, H - 14, W * (1 - k), 14);
}

function drawEndCard() {
  ctx.fillStyle = 'rgba(16,19,20,0.92)'; ctx.fillRect(0, 0, W, H);
  for (let x = -40; x < W + 40; x += 48) {
    ctx.fillStyle = '#f5c518'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 24, 0); ctx.lineTo(x - 10, 34); ctx.lineTo(x - 34, 34); ctx.fill();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffae1a'; ctx.font = '400 40px VT323, monospace'; ctx.fillText('SALVADOR · 25/10 · 2º TURNO', W / 2, 150);
  ctx.fillStyle = '#f5c518'; ctx.font = '400 110px Bungee, sans-serif'; ctx.fillText('RASPA', W / 2, 290);
  ctx.fillStyle = '#f3f1ea'; ctx.fillText('BUZU', W / 2, 400);
  ctx.fillStyle = '#f5c518'; ctx.font = '400 260px Bungee, sans-serif'; ctx.fillText(String(score), W / 2, 700);
  ctx.fillStyle = '#f3f1ea'; ctx.font = '800 40px Archivo, sans-serif'; ctx.fillText('ônibus na rua em 60 segundos', W / 2, 770);
  ctx.font = '400 44px Bungee, sans-serif'; ctx.fillText(rankFor(score).toUpperCase(), W / 2, 860, W - 60);
  const m = paceMinutes(), rip = ripAvgSec();
  ctx.fillStyle = '#ffae1a'; ctx.font = '400 46px VT323, monospace';
  const lines = [
    `Baratinômetro: ${passed} sem adesivo, parados à toa.`,
    rip !== null ? `Tirar o adesivo: ${fmt1(rip)} s.` : '',
    m !== null ? `No meu ritmo: 75 ônibus em ${fmt1(m)} min.` : '',
    'Procon-BA: 944 ônibus parados.',
  ].filter(Boolean);
  lines.forEach((l, i) => ctx.fillText(l, W / 2, 950 + i * 54, W - 60));
  ctx.fillStyle = '#9ba5a4'; ctx.font = '600 30px Archivo, sans-serif'; ctx.fillText(`Sátira · ${SHARE_URL.replace(/^https?:\/\//, '')}`, W / 2, 1180);
}

const wrapCache = new Map<string, string[]>();
function wrap(text: string, max: number) {
  const key = `${ctx.font}|${max}|${text}`;
  const hit = wrapCache.get(key);
  if (hit) return hit;
  const lines = wrapUncached(text, max);
  if (wrapCache.size > 64) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}
function wrapUncached(text: string, max: number) {
  const words = text.split(' '), lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > max && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

const fmt1 = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
// Stickers removed per minute (the run mixes in clean buses, so this undersells the player).
const paceMinutes = () => (scraped > 0 ? (RETIDOS * GAME_MS) / scraped / 60_000 : null);
const ripAvgSec = () => (ripMs.length ? ripMs.reduce((a, b) => a + b, 0) / ripMs.length / 1000 : null);
const buses = (n: number) => `${n} ônibus`;

// ---------- end screen ----------
let lastFile: File | null = null;

async function finish() {
  mode = 'end';
  const file = await recorder.stop(`raspa-buzu-${score}-onibus`);
  lastFile = file;
  const endEl = $<HTMLElement>('#end');
  $<HTMLElement>('#eScore').textContent = String(score);
  $<HTMLElement>('#eRank').textContent = rankFor(score);
  const m = paceMinutes(), rip = ripAvgSec();
  const parts: string[] = [];
  if (passed > 0) parts.push(`Baratinômetro: ${buses(passed)} ${passed === 1 ? 'nem tinha' : 'nem tinham'} adesivo do 13 e ${passed === 1 ? 'saiu' : 'saíram'} num joinha. Por que ${passed === 1 ? 'estava parado' : 'estavam parados'}?`);
  if (rip !== null) parts.push(`Tirar cada adesivo levou ${fmt1(rip)} s em média.`);
  if (m !== null) parts.push(`No seu ritmo, os ${RETIDOS} ônibus que a prefeitura admite estariam na rua em ${fmt1(m)} minutos.`);
  parts.push('O Procon-BA contou 944 ônibus parados em 9 garagens, e às 15h30 ainda havia garagem lotada.');
  $<HTMLElement>('#eLine').textContent = parts.join(' ');
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
  endEl.hidden = false;
}

function shareText() {
  const m = paceMinutes();
  const rip = ripAvgSec();
  const ripText = rip !== null ? ` Tirar o adesivo levou ${fmt1(rip)} s.` : '';
  const pace = m !== null ? ` No meu ritmo, os ${RETIDOS} ônibus retidos em Salvador estariam na rua em ${fmt1(m)} minutos.` : '';
  const clean = passed > 0 ? ` ${buses(passed)} nem tinham adesivo.` : '';
  return `🚌 Botei ${buses(score)} na rua em 60 segundos no Raspa Buzu.${clean}${ripText}${pace} O Procon contou 944 ônibus parados. Duvido você. ${SHARE_URL}/camera/`;
}

$<HTMLButtonElement>('#eShare').addEventListener('click', async () => {
  if (!lastFile) return;
  try { await navigator.share({ files: [lastFile], text: shareText() }); }
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
  window.addEventListener('keydown', (e) => { if (e.key === 'w' || e.key === ' ') thumbsUp(); });
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
