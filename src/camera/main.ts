// Raspa Buzu, camera mode: swipe left to rip the 13 sticker off the windshield, swipe right
// to let the bus go, and get a shareable video of the round.

import {
  BUS_CAPACITY, ENTER_MS, EXIT_MS, GAME_MS, RETIDOS, UNLOCK_MS, busSpec, randomSeed, type BusSpec,
} from '../sim.ts';
import { DECOYS, EVENTS, PARIS_AFTER, PARIS_BEFORE, clockMinutes, clockText, rankFor } from '../content.ts';
import { HandTracker, type Pt } from './hands.ts';
import { Sfx } from './audio.ts';
import { CanvasRecorder } from './recorder.ts';
import { drawBusFront, stickerCenter, stickerRadius, type Rect } from './bus-art.ts';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const cv = $<HTMLCanvasElement>('#cv');
const ctx = cv.getContext('2d')!;
const W = cv.width, H = cv.height;
const RENDER_CAP = 30;              // leaves GPU time for the detector (see spike results)
const END_CARD_MS = 2500;
const SHARE_URL = location.origin;
// Test aids: ?mouse=1 lets the pointer play the fingertip; with it, ?speed=N fast-forwards the clock.
const QS = new URLSearchParams(location.search);
const MOUSE = QS.has('mouse');
const SPEED = MOUSE ? Math.max(1, Number(QS.get('speed')) || 1) : 1;

const tracker = new HandTracker('/mediapipe/wasm', '/mediapipe/hand_landmarker.task');
const video = document.createElement('video');
video.playsInline = true; video.muted = true;
let sfx: Sfx | null = null;
const recorder = new CanvasRecorder();

type Mode = 'intro' | 'waiting' | 'countdown' | 'play' | 'endcard' | 'end';
let mode: Mode = 'intro';

// ---------- run state (bus sequence and timings from sim.ts) ----------
interface BusState { spec: BusSpec; hp: number; enterAt: number; readyAt: number; releaseAt: number | null; how: string }
let seed = randomSeed();
let elapsed = 0;
let bus: BusState;
let score = 0, scraped = 0, passed = 0, forced = 0, blocked = 0, penalties = 0;
let voters = 300;
let eventIdx = 0, unlocked = false, arrested = false;

function newBus(i: number, enterAt: number): BusState {
  const spec = busSpec(seed, i);
  return { spec, hp: spec.hp, enterAt, readyAt: enterAt + ENTER_MS, releaseAt: null, how: '' };
}

function resetRun() {
  seed = randomSeed();
  elapsed = 0;
  score = scraped = passed = forced = blocked = penalties = 0;
  voters = 300; eventIdx = 0; unlocked = false; arrested = false;
  paris = { text: '', until: 0, next: 7000, i: 0, j: 0 };
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

// ---------- hand input: broad horizontal swipes of the palm ----------
// Calibrated on a Galaxy A17 (6-9 detections/s): swipes took 280-590 ms over 3-5 detections
// and covered 23-52% of the width. The fingertip scrape and the wave were unreliable there.
const SWIPE_MIN = 0.3;           // share of the canvas width
const SWIPE_WINDOW_MS = 800;
const SWIPE_COOLDOWN_MS = 500;
const RETURN_IGNORE_MS = 900;    // the hand coming back is not a new swipe
type Sample = Pt & { t: number };
const hist: Sample[] = [];
let swipeCooldown = 0;
let lastSwipe: { dir: 'L' | 'R'; t: number } | null = null;
let handSince = 0;
let lastPalm: Sample | null = null;
let vel = { x: 0, y: 0 };
let flash: { dir: 'L' | 'R'; until: number } | null = null;

/** Palm centre: wrist plus the four finger bases. Steadier than a fingertip. */
function palm(lm: Pt[]) {
  const ids = [0, 5, 9, 13, 17];
  let x = 0, y = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; }
  return toCanvas({ x: x / ids.length, y: y / ids.length });
}

tracker.onResult = (lm, now) => {
  if (!lm) {
    checkSwipe(now);                 // a swipe that ends off-screen still counts
    hist.length = 0; lastPalm = null; handSince = 0;
    return;
  }
  if (!handSince) handSince = now;
  feedPalm(palm(lm), now);
};

function feedPalm(p: Pt, now: number) {
  const s = { x: p.x, y: p.y, t: now };
  if (lastPalm) {
    const dt = Math.max(1, now - lastPalm.t);
    vel = { x: (s.x - lastPalm.x) / dt, y: (s.y - lastPalm.y) / dt };
  }
  lastPalm = s;
  hist.push(s);
  while (hist.length && now - hist[0].t > SWIPE_WINDOW_MS) hist.shift();
  checkSwipe(now);
}

function checkSwipe(now: number) {
  if (now < swipeCooldown || hist.length < 2) return;
  const last = hist[hist.length - 1];
  for (let i = 0; i < hist.length - 1; i++) {
    const a = hist[i];
    const dx = last.x - a.x, dy = last.y - a.y;
    if (last.t - a.t > SWIPE_WINDOW_MS) continue;
    if (Math.abs(dx) < W * SWIPE_MIN || Math.abs(dy) > Math.abs(dx) * 0.7) continue;
    const dir = dx < 0 ? 'L' : 'R';
    hist.length = 0;
    if (lastSwipe && lastSwipe.dir !== dir && now - lastSwipe.t < RETURN_IGNORE_MS) return;
    lastSwipe = { dir, t: now };
    swipeCooldown = now + SWIPE_COOLDOWN_MS;
    onSwipe(dir);
    return;
  }
}

/** Palm cursor, projected along its last velocity until the next detection (hides the lag). */
function cursorPos(now: number) {
  if (!lastPalm) return null;
  const ahead = Math.min(now - lastPalm.t, 120);
  return { x: lastPalm.x + vel.x * ahead, y: lastPalm.y + vel.y * ahead };
}

function onSwipe(dir: 'L' | 'R') {
  flash = { dir, until: performance.now() + 450 };
  if (!interactive()) return;
  const t = Math.round(elapsed);
  if (dir === 'L') ripSticker(t); else letGo(t);
}

function ripSticker(t: number) {
  if (bus.spec.kind === '13' && bus.hp > 0) {
    const r = busRect(), c = stickerCenter(r, bus.spec), sr = stickerRadius(r);
    bus.hp = 0;
    score++; scraped++;
    sfx?.scrape(); sfx?.pop();
    flying.push({ x: c.x, y: c.y, vx: -1500, vy: -260, rot: bus.spec.rot, vr: -9, r: sr, life: 0.8 });
    chips(c.x, c.y, 16, '#d4251c'); chips(c.x, c.y, 6, '#ffffff');
    floaters.push({ x: c.x, y: c.y - sr, text: '+1', life: 0.9, color: '#f5c518' });
    leave(t + 250, 'scraped');
    return;
  }
  penalty(bus.spec.kind === 'decoy' ? DECOYS[bus.spec.decoy].toast : 'Esse buzu nem tem adesivo do 13.');
}

function letGo(t: number) {
  if (bus.spec.kind === '13' && bus.hp > 0) {
    if (t < UNLOCK_MS) { blocked++; sfx?.bad(); toast('Com adesivo do 13 não sai. Arranca pra esquerda!'); return; }
    forced++; leave(t, 'forced'); return;
  }
  passed++; leave(t, 'pass');
}

function penalty(text: string) {
  score = Math.max(0, score - 1); penalties++;
  sfx?.bad();
  toast(`${text} (−1)`);
}

function leave(at: number, how: string) {
  bus.releaseAt = at; bus.how = how;
  voters = Math.max(0, voters - BUS_CAPACITY);
  setTimeout(() => sfx?.horn(), Math.max(0, at - elapsed));
}

// ---------- effects ----------
interface Particle { x: number; y: number; vx: number; vy: number; life: number; color: string; s: number }
let particles: Particle[] = [];
/** Ripped stickers flying off to the left. */
let flying: { x: number; y: number; vx: number; vy: number; rot: number; vr: number; r: number; life: number }[] = [];
let floaters: { x: number; y: number; text: string; life: number; color: string }[] = [];
let toastMsg = { text: '', until: 0 };
let banner = { text: '', until: 0 };
let paris = { text: '', until: 0, next: 7000, i: 0, j: 0 };

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
      paris.text = arrested ? PARIS_AFTER[paris.j++ % PARIS_AFTER.length] : PARIS_BEFORE[paris.i++ % PARIS_BEFORE.length];
      paris.until = now + 4200; sfx?.ping();
      paris.next = elapsed + (arrested ? 6000 + Math.random() * 3000 : 9000 + Math.random() * 4000);
    }
    if (bus.releaseAt !== null && elapsed >= bus.releaseAt + EXIT_MS) bus = newBus(bus.spec.index + 1, bus.releaseAt + EXIT_MS);
    if (elapsed >= GAME_MS) { elapsed = GAME_MS; mode = 'endcard'; endcardStart = now; sfx?.horn(); }
  }
  if (mode === 'endcard' && now - endcardStart > END_CARD_MS) finish();

  for (const p of particles) { p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 800 * dt; }
  particles = particles.filter((p) => p.life > 0);
  for (const f of floaters) { f.life -= dt; f.y -= 60 * dt; }
  floaters = floaters.filter((f) => f.life > 0);
  for (const f of flying) { f.life -= dt; f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 900 * dt; f.rot += f.vr * dt; }
  flying = flying.filter((f) => f.life > 0);
}
let lastCount = 4;

function startRound() {
  // The run was reset when waiting began, so the bus shown in the countdown is bus 0.
  mode = 'play';
  recorder.start(cv, sfx?.stream);
  sfx?.horn();
}

// ---------- drawing ----------
function draw(now: number) {
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
    drawBusFront(ctx, r, bus);
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
  for (const f of flying) drawFlyingSticker(f);
  const c = cursorPos(now);
  if (c && mode !== 'endcard') drawPalmCursor(c);
  if (mode === 'play') drawHints(now);

  drawHud();
  if (now < banner.until) drawBanner(banner.text);
  if (now < paris.until) drawParis(paris.text);
  if (now < toastMsg.until) drawToast(toastMsg.text);
  if (mode === 'waiting') drawCenter(tracker.ready ? 'Mostre a mão pra câmera' : `Carregando o detector… ${loadPct()}`);
  if (mode === 'countdown') drawCenter(String(Math.max(1, 3 - Math.floor((now - countdownStart) / 800))), 200);
  if (mode === 'play') drawTimeBar();
  if (mode === 'endcard') drawEndCard();
}

function loadPct() {
  const { bytes, total } = tracker.progress;
  return total ? `${Math.round((bytes / total) * 100)}%` : '';
}

function drawPalmCursor(p: Pt) {
  ctx.strokeStyle = 'rgba(245,197,24,0.95)'; ctx.lineWidth = 8;
  ctx.beginPath(); ctx.arc(p.x, p.y, 38, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = 'rgba(245,197,24,0.35)';
  ctx.beginPath(); ctx.arc(p.x, p.y, 30, 0, Math.PI * 2); ctx.fill();
}

function drawFlyingSticker(f: { x: number; y: number; rot: number; r: number }) {
  ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(f.rot);
  ctx.fillStyle = '#d4251c'; ctx.beginPath(); ctx.arc(0, 0, f.r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = f.r * 0.09; ctx.beginPath(); ctx.arc(0, 0, f.r * 0.86, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = `400 ${f.r * 0.7}px Bungee, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('13', 0, 2); ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

/** Permanent reminders of the two gestures, lit up when one is detected. */
function drawHints(now: number) {
  const y = BUS.y - 54, h = 46;
  const lit = flash && now < flash.until ? flash.dir : null;
  const pill = (x: number, w: number, label: string, color: string, on: boolean) => {
    ctx.fillStyle = on ? color : 'rgba(10,12,12,0.7)';
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, 23); else ctx.rect(x, y, w, h); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '400 24px Bungee, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 1); ctx.textBaseline = 'alphabetic';
  };
  pill(24, 300, '← ARRANCA O 13', '#d4251c', lit === 'L');
  pill(W - 324, 300, 'DEIXA IR →', '#1f9d55', lit === 'R');
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
    ['ADESIVOS', String(score)],
    ['BUZUS', String(scraped + passed + forced)],
    ['NO PONTO', Math.round(voters).toLocaleString('pt-BR')],
  ];
  cols.forEach(([label, value], i) => {
    const x = 24 + i * 176;
    ctx.fillStyle = '#9ba5a4'; ctx.font = '700 20px Archivo, sans-serif'; ctx.textAlign = 'left'; ctx.fillText(label, x, 40);
    ctx.fillStyle = i === 3 ? '#f3f1ea' : '#ffae1a'; ctx.font = '400 58px VT323, monospace'; ctx.fillText(value, x, 94);
  });
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
  ctx.fillStyle = '#f3f1ea'; ctx.font = '800 40px Archivo, sans-serif'; ctx.fillText('adesivos arrancados com a mão', W / 2, 770);
  ctx.font = '400 44px Bungee, sans-serif'; ctx.fillText(rankFor(score).toUpperCase(), W / 2, 860, W - 60);
  const m = paceMinutes();
  ctx.fillStyle = '#ffae1a'; ctx.font = '400 46px VT323, monospace';
  ctx.fillText(m !== null ? `No meu ritmo: 75 ônibus em ${fmt1(m)} min.` : 'Nenhum adesivo. Igual a domingo.', W / 2, 970, W - 60);
  ctx.fillText('A prefeitura: das 9h30 às 12h20.', W / 2, 1025, W - 60);
  ctx.fillStyle = '#9ba5a4'; ctx.font = '600 30px Archivo, sans-serif'; ctx.fillText(`Sátira · ${SHARE_URL.replace(/^https?:\/\//, '')}`, W / 2, 1180);
}

function wrap(text: string, max: number) {
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
const paceMinutes = () => (score > 0 ? (RETIDOS * GAME_MS) / score / 60_000 : null);

// ---------- end screen ----------
let lastFile: File | null = null;

async function finish() {
  mode = 'end';
  const file = await recorder.stop(`raspa-buzu-${score}-adesivos`);
  lastFile = file;
  const endEl = $<HTMLElement>('#end');
  $<HTMLElement>('#eScore').textContent = String(score);
  $<HTMLElement>('#eRank').textContent = rankFor(score);
  const m = paceMinutes();
  $<HTMLElement>('#eLine').textContent = m !== null
    ? `No seu ritmo, os ${RETIDOS} ônibus retidos estariam na rua em ${fmt1(m)} minutos. A prefeitura levou umas 3 horas.`
    : 'Nenhum adesivo arrancado. Você igualou a manhã de domingo.';
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
  const pace = m !== null ? ` No meu ritmo, os ${RETIDOS} ônibus retidos em Salvador estariam na rua em ${fmt1(m)} minutos.` : '';
  return `🚌✋ Arranquei ${score} adesivos do 13 com a mão em 60 segundos no Raspa Buzu.${pace} Duvido você. ${SHARE_URL}/camera/`;
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
// Dragging plays the palm (a fast horizontal drag is a swipe); the arrow keys swipe directly.
if (MOUSE) {
  const pos = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  cv.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (!handSince) handSince = now;
    if (e.buttons) feedPalm(pos(e), now);
    else { lastPalm = { ...pos(e), t: now }; vel = { x: 0, y: 0 }; }
  });
  cv.addEventListener('pointerup', () => { hist.length = 0; });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') onSwipe('L');
    if (e.key === 'ArrowRight') onSwipe('R');
  });
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
    draw(now);
    if (mode === 'intro') introStatus();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
