// Camera spike: can a phone track a hand fast enough to scrape a sticker and record the result?
// Measures inference/render FPS, tries the scrape and wave gestures, and records a 5s clip.

import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';

const MODEL_URL = '/mediapipe/hand_landmarker.task';
const WASM_BASE = '/mediapipe/wasm';
declare const __BUILD__: string;
/** ?d=gpu | cpu | auto (default) picks the inference delegate. */
const DELEGATE_PREF = (new URLSearchParams(location.search).get('d') ?? 'auto').toLowerCase();
const GPU_TIMEOUT_MS = 12_000;

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const cv = $<HTMLCanvasElement>('#cv');
const ctx = cv.getContext('2d')!;
const hud = $<HTMLDivElement>('#hud');
const msg = $<HTMLDivElement>('#msg');
const startBtn = $<HTMLButtonElement>('#start');
const resSel = $<HTMLSelectElement>('#res');
const everySel = $<HTMLSelectElement>('#every');
const recordBtn = $<HTMLButtonElement>('#record');
const W = cv.width, H = cv.height;

const video = document.createElement('video');
video.playsInline = true;
video.muted = true;

let landmarker: HandLandmarker | null = null;
let delegate: 'GPU' | 'CPU' = 'GPU';
let modelMs = 0;
let stream: MediaStream | null = null;
let lastError = '';

// ---------- stats ----------
const inferTimes: number[] = [];
const inferStamps: number[] = [];
const renderStamps: number[] = [];
let frames = 0, framesWithHand = 0;
function pushWindow(arr: number[], v: number, max = 90) { arr.push(v); if (arr.length > max) arr.shift(); }
function rate(stamps: number[]) {
  if (stamps.length < 2) return 0;
  return ((stamps.length - 1) * 1000) / (stamps[stamps.length - 1] - stamps[0]);
}
function median(arr: number[]) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ---------- One Euro filter (smooths the fingertip without adding much lag) ----------
class OneEuro {
  private x: number | null = null; private dx = 0; private t = 0;
  constructor(private minCutoff = 1.2, private beta = 0.02, private dCutoff = 1) {}
  private alpha(cutoff: number, dt: number) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v: number, tMs: number) {
    if (this.x === null) { this.x = v; this.t = tMs; return v; }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000); this.t = tMs;
    const dv = (v - this.x) / dt;
    this.dx += this.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
  reset() { this.x = null; }
}
const fx = new OneEuro(), fy = new OneEuro();

// ---------- game-ish state ----------
const sticker = { x: W * 0.35, y: H * 0.62, r: W * 0.075, hp: 3 };
let scraped = 0, scrapeHits = 0, waves = 0;
let tip: { x: number; y: number; t: number } | null = null;
let pathAcc = 0;
const wristHist: { x: number; t: number }[] = [];
let waveCooldown = 0;
let msgUntil = 0;

function respawnSticker() {
  sticker.x = W * (0.2 + Math.random() * 0.6);
  sticker.y = H * (0.5 + Math.random() * 0.25);
  sticker.hp = 3;
}

function say(text: string) { msg.textContent = text; msgUntil = performance.now() + 700; }

// Distance from point to segment.
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy || 1;
  const k = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + k * vx), py - (ay + k * vy));
}

function isOpenPalm(lm: NormalizedLandmark[]) {
  const w = lm[0];
  const d = (a: NormalizedLandmark) => Math.hypot(a.x - w.x, a.y - w.y);
  let open = 0;
  for (const [tipI, pipI] of [[8, 6], [12, 10], [16, 14], [20, 18]]) if (d(lm[tipI]) > d(lm[pipI]) * 1.15) open++;
  return open >= 4;
}

// ---------- video → canvas mapping (cover + mirror) ----------
let map = { ox: 0, oy: 0, dw: W, dh: H };
function computeMap() {
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const s = Math.max(W / vw, H / vh);
  map = { dw: vw * s, dh: vh * s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2 };
}
const toCanvas = (p: NormalizedLandmark) => ({ x: map.ox + (1 - p.x) * map.dw, y: map.oy + p.y * map.dh });

// ---------- setup ----------
// MediaPipe sometimes rejects with plain strings or events; make every failure readable.
function describe(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  if (e instanceof Event) return `evento ${e.type}` + (e.target instanceof HTMLScriptElement ? ` (${e.target.src})` : '');
  try { return JSON.stringify(e); } catch { return String(e); }
}

let gpuError = '';
// Loading happens in stages so a stall on the phone shows where it stopped.
let stage = 'iniciando';
let stageStart = performance.now();
const stageLog: string[] = [];
function enter(name: string) { stage = name; stageStart = performance.now(); }
function done(label: string) { stageLog.push(`${label} ${((performance.now() - stageStart) / 1000).toFixed(1)}s`); }

function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} travou (> ${ms / 1000}s)`)), ms))]);
}

async function loadModel() {
  const t0 = performance.now();
  enter('baixando motor wasm');
  let fileset;
  try { fileset = await FilesetResolver.forVisionTasks(WASM_BASE); }
  catch (e) { throw new Error(`motor wasm: ${describe(e)}`); }
  done('motor');

  enter('baixando modelo');
  let model: Uint8Array;
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    model = new Uint8Array(await res.arrayBuffer());
  } catch (e) { throw new Error(`modelo: ${describe(e)}`); }
  done(`modelo ${(model.length / 1e6).toFixed(1)}MB`);

  const create = (d: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: model, delegate: d },
    runningMode: 'VIDEO', numHands: 1,
  });

  if (DELEGATE_PREF !== 'cpu') {
    enter('iniciando GPU');
    try {
      landmarker = await withTimeout(create('GPU'), GPU_TIMEOUT_MS, 'GPU');
      delegate = 'GPU';
      done('GPU');
    } catch (e) {
      gpuError = describe(e);
      if (DELEGATE_PREF === 'gpu') throw new Error(`GPU: ${gpuError}`);
    }
  }
  if (!landmarker) {
    enter('iniciando CPU');
    try { landmarker = await create('CPU'); }
    catch (e) { throw new Error(`CPU: ${describe(e)}${gpuError ? ` | GPU: ${gpuError}` : ''}`); }
    delegate = 'CPU';
    done('CPU');
  }
  stage = 'pronto';
  modelMs = Math.round(performance.now() - t0);
}

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const h = Number(resSel.value);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', height: { ideal: h }, width: { ideal: Math.round(h * 16 / 9) }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) {
    lastError = 'câmera: ' + describe(e);
    return;
  }
  video.srcObject = stream;
  await video.play();
  computeMap();
  recordBtn.disabled = false;
  startBtn.textContent = 'Reiniciar câmera';
}

startBtn.addEventListener('click', startCamera);
const delegateSel = $<HTMLSelectElement>('#delegate');
delegateSel.value = ['gpu', 'cpu'].includes(DELEGATE_PREF) ? DELEGATE_PREF : 'auto';
delegateSel.addEventListener('change', () => {
  const u = new URL(location.href);
  u.searchParams.set('d', delegateSel.value);
  location.href = u.toString();
});
resSel.addEventListener('change', () => { if (stream) startCamera(); });

// ---------- loop ----------
let frameNo = 0;
let lastVideoTime = -1;
let lastLandmarks: NormalizedLandmark[] | null = null;

function loop() {
  const now = performance.now();
  pushWindow(renderStamps, now);

  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    frameNo++;
    if (frameNo % Number(everySel.value) === 0) {
      const t0 = performance.now();
      const res = landmarker.detectForVideo(video, t0);
      pushWindow(inferTimes, performance.now() - t0);
      pushWindow(inferStamps, t0);
      frames++;
      lastLandmarks = res.landmarks[0] ?? null;
      if (lastLandmarks) { framesWithHand++; track(lastLandmarks, now); } else { tip = null; fx.reset(); fy.reset(); }
    }
  }
  draw(now);
  requestAnimationFrame(loop);
}

function track(lm: NormalizedLandmark[], now: number) {
  const raw = toCanvas(lm[8]);
  const p = { x: fx.filter(raw.x, now), y: fy.filter(raw.y, now), t: now };

  // Scrape: fingertip path crossing the sticker fast enough.
  if (tip) {
    const dist = Math.hypot(p.x - tip.x, p.y - tip.y);
    const speed = dist / Math.max(1, p.t - tip.t); // px per ms
    const near = segDist(sticker.x, sticker.y, tip.x, tip.y, p.x, p.y) < sticker.r * 1.25;
    if (near && speed > 0.35) {
      pathAcc += dist;
      while (pathAcc > sticker.r * 1.4 && sticker.hp > 0) {
        pathAcc -= sticker.r * 1.4;
        sticker.hp--; scrapeHits++;
        if (sticker.hp === 0) { scraped++; say('+1'); respawnSticker(); pathAcc = 0; }
      }
    }
  }
  tip = p;

  // Wave: open palm moving sideways fast.
  const wrist = toCanvas(lm[0]);
  wristHist.push({ x: wrist.x, t: now });
  while (wristHist.length && now - wristHist[0].t > 350) wristHist.shift();
  if (now > waveCooldown && isOpenPalm(lm) && wristHist.length > 2) {
    const dx = wristHist[wristHist.length - 1].x - wristHist[0].x;
    if (Math.abs(dx) > W * 0.28) { waves++; waveCooldown = now + 900; say('TCHAU! 👋'); wristHist.length = 0; }
  }
}

const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

function draw(now: number) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (video.readyState >= 2) {
    if (!map.dw || video.videoWidth) computeMap();
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, W - map.ox - map.dw, map.oy, map.dw, map.dh);
    ctx.restore();
  }
  // windshield frame + sticker target
  ctx.strokeStyle = 'rgba(245,197,24,.8)'; ctx.lineWidth = 6;
  ctx.strokeRect(W * 0.08, H * 0.42, W * 0.84, H * 0.42);
  ctx.save(); ctx.translate(sticker.x, sticker.y);
  ctx.fillStyle = '#d4251c'; ctx.beginPath(); ctx.arc(0, 0, sticker.r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `900 ${sticker.r * 0.8}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('13', 0, 2);
  for (let i = 0; i < 3 - sticker.hp; i++) { ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-sticker.r * .8, -sticker.r * .4 + i * 14); ctx.lineTo(sticker.r * .7, sticker.r * .1 + i * 14); ctx.stroke(); }
  ctx.restore();

  if (lastLandmarks) {
    const pts = lastLandmarks.map(toCanvas);
    ctx.strokeStyle = 'rgba(31,157,85,.9)'; ctx.lineWidth = 4;
    for (const [a, b] of CONNECTIONS) { ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke(); }
    ctx.fillStyle = '#fff'; for (const p of pts) { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); }
  }
  if (tip) {
    ctx.fillStyle = '#f5c518'; ctx.beginPath(); ctx.arc(tip.x, tip.y, 16, 0, Math.PI * 2); ctx.fill();
  }
  // burn-in score for the recording test
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, H - 90, W, 90);
  ctx.fillStyle = '#f5c518'; ctx.font = '900 44px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(`RASPA BUZU · ${scraped}`, 24, H - 32);

  if (now > msgUntil) msg.textContent = '';
  hud.textContent = hudText();
}

function hudText() {
  const handPct = frames ? Math.round((framesWithHand / frames) * 100) : 0;
  return [
    `versão ${__BUILD__} · modo ${DELEGATE_PREF}`,
    landmarker
      ? `modelo ok (${delegate}, ${modelMs} ms)${gpuError ? ` · GPU falhou: ${gpuError}` : ''}`
      : lastError ? 'modelo falhou' : `${stage}… ${((performance.now() - stageStart) / 1000).toFixed(0)}s${performance.now() - stageStart > 15000 ? ' (TRAVOU AQUI?)' : ''}`,
    stageLog.length ? `etapas: ${stageLog.join(' · ')}` : '',
    `detecção: ${rate(inferStamps).toFixed(1)} fps · ${median(inferTimes).toFixed(1)} ms/quadro (mediana)`,
    `tela: ${rate(renderStamps).toFixed(0)} fps · câmera ${video.videoWidth}×${video.videoHeight}`,
    `mão visível: ${handPct}% · raspadas: ${scrapeHits} · adesivos: ${scraped} · tchaus: ${waves}`,
    lastError ? `ERRO: ${lastError}` : '',
  ].filter(Boolean).join('\n');
}

// ---------- recording test ----------
const recBox = $<HTMLDivElement>('#rec');
const recVideo = $<HTMLVideoElement>('#recVideo');
const recInfo = $<HTMLElement>('#recInfo');
const recShare = $<HTMLButtonElement>('#recShare');
const recDownload = $<HTMLAnchorElement>('#recDownload');
let recResult = 'não testado';
let recFile: File | null = null;

function pickMime() {
  const types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) ?? '';
}

recordBtn.addEventListener('click', () => {
  const mime = pickMime();
  if (!mime) { recResult = 'MediaRecorder sem formato suportado'; lastError = recResult; return; }
  const out = cv.captureStream(30);
  const rec = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const t0 = performance.now();
  rec.onstop = () => {
    const type = mime.split(';')[0];
    const ext = type === 'video/mp4' ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    recFile = new File([blob], `raspa-buzu-teste.${ext}`, { type });
    const url = URL.createObjectURL(blob);
    recVideo.src = url;
    recDownload.href = url;
    recDownload.download = recFile.name;
    recResult = `${mime} · ${(blob.size / 1e6).toFixed(2)} MB · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    recInfo.textContent = `Gravado: ${recResult}`;
    recShare.disabled = !(navigator.canShare && navigator.canShare({ files: [recFile] }));
    recBox.hidden = false;
    recordBtn.disabled = false; recordBtn.textContent = 'Gravar 5s';
  };
  rec.start(250);
  recordBtn.disabled = true; recordBtn.textContent = 'Gravando…';
  setTimeout(() => rec.stop(), 5000);
});
recShare.addEventListener('click', async () => {
  if (!recFile) return;
  try { await navigator.share({ files: [recFile], title: 'Raspa Buzu', text: 'Teste do modo câmera' }); recResult += ' · share ok'; }
  catch (e) { recResult += ' · share falhou: ' + (e as Error).name; }
  recInfo.textContent = `Gravado: ${recResult}`;
});
$<HTMLButtonElement>('#recClose').addEventListener('click', () => { recBox.hidden = true; });

// ---------- report ----------
$<HTMLButtonElement>('#report').addEventListener('click', async () => {
  const text = [
    'Raspa Buzu · relatório do teste de câmera',
    location.href,
    navigator.userAgent,
    `tela ${screen.width}×${screen.height} @${devicePixelRatio}`,
    hudText(),
    `detectar a cada: ${everySel.value} · gravação: ${recResult}`,
  ].join('\n');
  try { await navigator.clipboard.writeText(text); say('copiado'); }
  catch { hud.textContent = text; }
});

loadModel().catch((e) => { lastError = 'modelo: ' + describe(e); });
requestAnimationFrame(loop);
