// Swipe spike: can a broad horizontal hand swipe be detected reliably at ~9 detections/s?
// Left = remove the sticker, right = let the bus go. Also compares cursor modes for lag.

import { HandTracker, type Pt } from '../camera/hands.ts';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const cv = $<HTMLCanvasElement>('#cv');
const ctx = cv.getContext('2d')!;
const W = cv.width, H = cv.height;
const hud = $<HTMLDivElement>('#hud');
const distSel = $<HTMLSelectElement>('#dist');
const cursorSel = $<HTMLSelectElement>('#cursorMode');
declare const __BUILD__: string;

const tracker = new HandTracker('/mediapipe/wasm', '/mediapipe/hand_landmarker.task');
const video = document.createElement('video');
video.playsInline = true; video.muted = true;

// ---------- mapping ----------
let map = { ox: 0, oy: 0, dw: W, dh: H };
function computeMap() {
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const s = Math.max(W / vw, H / vh);
  map = { dw: vw * s, dh: vh * s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2 };
}
const toCanvas = (p: Pt) => ({ x: map.ox + (1 - p.x) * map.dw, y: map.oy + p.y * map.dh });

/** Palm centre: wrist plus the four finger bases. Steadier than a fingertip. */
function palm(lm: Pt[]) {
  const ids = [0, 5, 9, 13, 17];
  let x = 0, y = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; }
  return toCanvas({ x: x / ids.length, y: y / ids.length });
}

// ---------- swipe detection ----------
const WINDOW_MS = 600;
const COOLDOWN_MS = 500;
/** After a swipe, the hand coming back the other way is not a new swipe. */
const RETURN_IGNORE_MS = 900;
let lastSwipe: { dir: 'L' | 'R'; t: number } | null = null;
let ignored = 0;
type Sample = { x: number; y: number; t: number };
const hist: Sample[] = [];
let cooldownUntil = 0;
let left = 0, right = 0;
const log: string[] = [];
let flash: { dir: 'L' | 'R'; until: number } | null = null;

function checkSwipe(now: number, reason: string) {
  if (now < cooldownUntil || hist.length < 2) return;
  const minDx = W * Number(distSel.value);
  // Compare the newest sample with every older one in the window: catches swipes of any length.
  const last = hist[hist.length - 1];
  for (let i = 0; i < hist.length - 1; i++) {
    const a = hist[i];
    const dx = last.x - a.x, dy = last.y - a.y, dt = last.t - a.t;
    if (dt > WINDOW_MS) continue;
    if (Math.abs(dx) >= minDx && Math.abs(dy) < Math.abs(dx) * 0.7) {
      const dir = dx < 0 ? 'L' : 'R';
      if (lastSwipe && lastSwipe.dir !== dir && now - lastSwipe.t < RETURN_IGNORE_MS) {
        ignored++; hist.length = 0; return;
      }
      lastSwipe = { dir, t: now };
      if (dir === 'L') left++; else right++;
      flash = { dir, until: now + 700 };
      log.unshift(`${dir === 'L' ? '←' : '→'} ${Math.round((Math.abs(dx) / W) * 100)}% da tela em ${Math.round(dt)} ms · ${hist.length - i} quadros · ${reason}`);
      log.length = Math.min(log.length, 8);
      cooldownUntil = now + COOLDOWN_MS;
      hist.length = 0;
      return;
    }
  }
}

// ---------- cursor ----------
let lastPalm: Sample | null = null;
let vel = { x: 0, y: 0 };
let smooth: { x: number; y: number } | null = null;

tracker.onResult = (lm, now) => {
  if (!lm) {
    // Hand left the frame: judge the movement seen so far, then forget it.
    checkSwipe(now, 'saiu da tela');
    hist.length = 0; lastPalm = null; smooth = null;
    return;
  }
  const p = palm(lm);
  const s = { x: p.x, y: p.y, t: now };
  if (lastPalm) {
    const dt = Math.max(1, now - lastPalm.t);
    vel = { x: (s.x - lastPalm.x) / dt, y: (s.y - lastPalm.y) / dt };
  }
  lastPalm = s;
  hist.push(s);
  while (hist.length && now - hist[0].t > WINDOW_MS) hist.shift();
  checkSwipe(now, 'em quadro');
};

function cursorPos(now: number, dt: number) {
  if (!lastPalm) return null;
  const mode = cursorSel.value;
  if (mode === 'raw') return lastPalm;
  if (mode === 'predict') {
    // Project along the last velocity for up to one detection interval.
    const ahead = Math.min(now - lastPalm.t, 120);
    return { x: lastPalm.x + vel.x * ahead, y: lastPalm.y + vel.y * ahead };
  }
  if (!smooth) smooth = { x: lastPalm.x, y: lastPalm.y };
  const k = 1 - Math.exp(-dt * 23);
  smooth.x += (lastPalm.x - smooth.x) * k; smooth.y += (lastPalm.y - smooth.y) * k;
  return smooth;
}

// ---------- loop ----------
const renderStamps: number[] = [];
let lastT = performance.now(), lastDraw = 0;

function loop() {
  const now = performance.now();
  tracker.pump(video);
  if (now - lastDraw >= 1000 / 30 - 2) {
    const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now; lastDraw = now;
    renderStamps.push(now); if (renderStamps.length > 30) renderStamps.shift();
    draw(now, dt);
  }
  requestAnimationFrame(loop);
}

function draw(now: number, dt: number) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (video.readyState >= 2) {
    computeMap();
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, W - map.ox - map.dw, map.oy, map.dw, map.dh);
    ctx.restore();
  }
  // threshold guide
  const minDx = W * Number(distSel.value);
  ctx.strokeStyle = 'rgba(245,197,24,.5)'; ctx.lineWidth = 4; ctx.setLineDash([16, 12]);
  ctx.beginPath(); ctx.moveTo(W / 2 - minDx / 2, H * 0.5); ctx.lineTo(W / 2 + minDx / 2, H * 0.5); ctx.stroke(); ctx.setLineDash([]);
  // trail
  ctx.strokeStyle = 'rgba(31,157,85,.9)'; ctx.lineWidth = 8; ctx.lineCap = 'round';
  ctx.beginPath(); hist.forEach((s, i) => (i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y))); ctx.stroke();
  const c = cursorPos(now, dt);
  if (c) { ctx.fillStyle = '#f5c518'; ctx.beginPath(); ctx.arc(c.x, c.y, 26, 0, Math.PI * 2); ctx.fill(); }
  // swipe feedback
  if (flash && now < flash.until) {
    ctx.fillStyle = flash.dir === 'L' ? 'rgba(212,37,28,.85)' : 'rgba(31,157,85,.85)';
    ctx.fillRect(0, H * 0.38, W, 160);
    ctx.fillStyle = '#fff'; ctx.font = '900 64px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(flash.dir === 'L' ? '← REMOVER' : 'DEIXAR IR →', W / 2, H * 0.38 + 80);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, H - 110, W, 110);
  ctx.font = '900 56px system-ui'; ctx.textAlign = 'left'; ctx.fillStyle = '#ff6b5e'; ctx.fillText(`← ${left}`, 40, H - 38);
  ctx.textAlign = 'right'; ctx.fillStyle = '#4ade80'; ctx.fillText(`${right} →`, W - 40, H - 38);
  hud.textContent = hudText();
}

function hudText() {
  const r = renderStamps.length > 1 ? ((renderStamps.length - 1) * 1000) / (renderStamps[renderStamps.length - 1] - renderStamps[0]) : 0;
  return [
    `versão ${__BUILD__} · deslize mínimo ${Math.round(Number(distSel.value) * 100)}% · cursor ${cursorSel.value}`,
    tracker.error ? `ERRO: ${tracker.error}` : tracker.ready ? `detector ${tracker.delegate} · ${tracker.fps().toFixed(1)} det/s · tela ${r.toFixed(0)} fps` : 'carregando detector…',
    `← ${left} · → ${right} · retornos ignorados ${ignored}`,
    ...log,
  ].join('\n');
}

// ---------- controls ----------
$<HTMLButtonElement>('#start').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', height: { ideal: 720 }, width: { ideal: 1280 } }, audio: false });
    video.srcObject = stream; await video.play(); computeMap();
  } catch (e) { hud.textContent = 'câmera: ' + (e instanceof Error ? e.message : String(e)); }
});
$<HTMLButtonElement>('#reset').addEventListener('click', () => { left = right = ignored = 0; log.length = 0; });
$<HTMLButtonElement>('#report').addEventListener('click', async () => {
  const text = ['Raspa Buzu · teste de deslize', location.href, navigator.userAgent, hudText()].join('\n');
  try { await navigator.clipboard.writeText(text); } catch { hud.textContent = text; }
});

requestAnimationFrame(loop);
