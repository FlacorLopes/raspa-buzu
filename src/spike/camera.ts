// Camera spike: can a phone track a hand fast enough to scrape a sticker and record the result?
// Detection runs in a worker (hand-worker.ts); this thread draws, tracks gestures and records.

import type { FromWorker, ToWorker } from './hand-worker.ts';

type Pt = { x: number; y: number };

const params = new URLSearchParams(location.search);
const MODEL_URLS: Record<string, string> = {
  local: '/mediapipe/hand_landmarker.task',
  google: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
/** ?m=local (default) | google picks where the model is downloaded from. */
const MODEL_SRC = params.get('m') === 'google' ? 'google' : 'local';
/** ?d=gpu | cpu | auto (default) picks the inference delegate. */
const DELEGATE_PREF = (['gpu', 'cpu'].includes(params.get('d') ?? '') ? params.get('d') : 'auto') as 'auto' | 'gpu' | 'cpu';
declare const __BUILD__: string;

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const cv = $<HTMLCanvasElement>('#cv');
const ctx = cv.getContext('2d')!;
const hud = $<HTMLDivElement>('#hud');
const msg = $<HTMLDivElement>('#msg');
const startBtn = $<HTMLButtonElement>('#start');
const resSel = $<HTMLSelectElement>('#res');
const recordBtn = $<HTMLButtonElement>('#record');
const W = cv.width, H = cv.height;

const video = document.createElement('video');
video.playsInline = true;
video.muted = true;

let stream: MediaStream | null = null;
let lastError = '';

// ---------- worker ----------
const worker = new Worker(new URL('./hand-worker.ts', import.meta.url));
const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
let ready = false, modelMs = 0, gpuError = '';
let delegates: ('GPU' | 'CPU')[] = [];
/** Current detection setup; the benchmark tries the combinations and keeps the best. */
const cfg = { delegate: 'GPU' as 'GPU' | 'CPU', input: 0, renderCap: 30 };
let stage = 'iniciando worker', stageStart = performance.now();
let stageLog: string[] = [];
let dl = { bytes: 0, total: 0, start: 0, end: 0 };
let busy = false;

worker.addEventListener('message', (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  if (m.type === 'stage') { stage = m.name; stageStart = performance.now(); }
  else if (m.type === 'progress') {
    if (!dl.start) dl.start = performance.now();
    dl.bytes = m.bytes; dl.total = m.total;
    if (m.done) dl.end = performance.now();
  }
  else if (m.type === 'ready') { ready = true; delegates = m.delegates; cfg.delegate = m.delegates[0]; modelMs = m.ms; gpuError = m.gpuError; stageLog = m.log; benchBtn.disabled = !stream; }
  else if (m.type === 'error') { lastError = 'modelo: ' + m.message; }
  else if (m.type === 'result') { busy = false; onResult(m.landmarks, m.ms); }
});
worker.addEventListener('error', (e) => { lastError = 'worker: ' + (e.message || 'falhou ao iniciar'); });
send({
  type: 'init',
  wasmBase: new URL('/mediapipe/wasm', location.href).href,
  modelUrl: new URL(MODEL_URLS[MODEL_SRC], location.href).href,
  delegate: DELEGATE_PREF,
});

// Hand a frame to the worker only when it is idle, so frames never queue up.
async function pump() {
  if (!ready || busy || video.readyState < 2) return;
  busy = true;
  try {
    const opts: ImageBitmapOptions | undefined = cfg.input
      ? { resizeWidth: cfg.input, resizeHeight: Math.round((cfg.input * video.videoHeight) / video.videoWidth), resizeQuality: 'low' }
      : undefined;
    const bitmap = await createImageBitmap(video, opts);
    send({ type: 'frame', bitmap, t: performance.now(), delegate: cfg.delegate }, [bitmap]);
  } catch (e) {
    busy = false;
  }
}

// ---------- stats ----------
const inferTimes: number[] = [];
const inferStamps: number[] = [];
const renderStamps: number[] = [];
let frames = 0, framesWithHand = 0;
function resetStats() { inferTimes.length = 0; inferStamps.length = 0; renderStamps.length = 0; frames = 0; framesWithHand = 0; }
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
/** Last detected fingertip (canvas px). */
let tip: (Pt & { t: number }) | null = null;
/** Fingertip as drawn: eases toward `tip` every frame, so the cursor moves at render rate. */
let cursor: Pt | null = null;
let pathAcc = 0;
const wristHist: { x: number; t: number }[] = [];
let waveCooldown = 0;
let msgUntil = 0;
let lastLandmarks: Pt[] | null = null;

function respawnSticker() {
  sticker.x = W * (0.2 + Math.random() * 0.6);
  sticker.y = H * (0.5 + Math.random() * 0.25);
  sticker.hp = 3;
}
function say(text: string) { msg.textContent = text; msgUntil = performance.now() + 700; }

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy || 1;
  const k = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  return Math.hypot(px - (ax + k * vx), py - (ay + k * vy));
}

function isOpenPalm(lm: Pt[]) {
  const w = lm[0];
  const d = (a: Pt) => Math.hypot(a.x - w.x, a.y - w.y);
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
const toCanvas = (p: Pt) => ({ x: map.ox + (1 - p.x) * map.dw, y: map.oy + p.y * map.dh });

// ---------- camera ----------
async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  const h = Number(resSel.value);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', height: { ideal: h }, width: { ideal: Math.round(h * 16 / 9) }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) {
    lastError = 'câmera: ' + (e instanceof Error ? e.message : String(e));
    return;
  }
  video.srcObject = stream;
  await video.play();
  computeMap();
  recordBtn.disabled = false;
  benchBtn.disabled = !ready;
  startBtn.textContent = 'Reiniciar câmera';
}
startBtn.addEventListener('click', startCamera);
resSel.addEventListener('change', () => { if (stream) startCamera(); });

function reloadWith(key: string, value: string) {
  const u = new URL(location.href);
  u.searchParams.set(key, value);
  location.href = u.toString();
}
const modelSel = $<HTMLSelectElement>('#modelSrc');
modelSel.value = MODEL_SRC;
modelSel.addEventListener('change', () => reloadWith('m', modelSel.value));
const delegateSel = $<HTMLSelectElement>('#delegate');
delegateSel.value = DELEGATE_PREF;
delegateSel.addEventListener('change', () => reloadWith('d', delegateSel.value));

// ---------- detection results ----------
function onResult(landmarks: Pt[] | null, ms: number) {
  const now = performance.now();
  pushWindow(inferTimes, ms);
  pushWindow(inferStamps, now);
  frames++;
  lastLandmarks = landmarks;
  if (!landmarks) { tip = null; fx.reset(); fy.reset(); return; }
  framesWithHand++;
  track(landmarks, now);
}

function track(lm: Pt[], now: number) {
  const raw = toCanvas(lm[8]);
  const p = { x: fx.filter(raw.x, now), y: fy.filter(raw.y, now), t: now };

  // Scrape: fingertip path between two detections crossing the sticker fast enough.
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
  if (!cursor) cursor = { x: p.x, y: p.y };

  // Wave: open palm moving sideways fast.
  const wrist = toCanvas(lm[0]);
  wristHist.push({ x: wrist.x, t: now });
  while (wristHist.length && now - wristHist[0].t > 400) wristHist.shift();
  if (now > waveCooldown && isOpenPalm(lm) && wristHist.length > 2) {
    const dx = wristHist[wristHist.length - 1].x - wristHist[0].x;
    if (Math.abs(dx) > W * 0.28) { waves++; waveCooldown = now + 900; say('TCHAU! 👋'); wristHist.length = 0; }
  }
}

// ---------- render loop (never waits for detection) ----------
const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
let lastFrameT = performance.now();
let lastDraw = 0;

function loop() {
  const now = performance.now();
  pump();
  benchTick(now);
  // Capping the draw rate leaves GPU time for the detector running in the worker.
  if (now - lastDraw < 1000 / cfg.renderCap - 2) { requestAnimationFrame(loop); return; }
  const dt = Math.min(0.1, (now - lastFrameT) / 1000); lastFrameT = now;
  lastDraw = now;
  pushWindow(renderStamps, now);

  if (tip && cursor) {
    // Exponential ease toward the latest detection; ~90% of the way in 100 ms.
    const k = 1 - Math.exp(-dt * 23);
    cursor.x += (tip.x - cursor.x) * k;
    cursor.y += (tip.y - cursor.y) * k;
  } else if (!tip) cursor = null;

  draw(now);
  requestAnimationFrame(loop);
}

function draw(now: number) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (video.readyState >= 2) {
    computeMap();
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, W - map.ox - map.dw, map.oy, map.dw, map.dh);
    ctx.restore();
  }
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
    ctx.strokeStyle = 'rgba(31,157,85,.6)'; ctx.lineWidth = 3;
    for (const [a, b] of CONNECTIONS) { ctx.beginPath(); ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); ctx.stroke(); }
  }
  if (cursor) {
    ctx.fillStyle = '#f5c518'; ctx.beginPath(); ctx.arc(cursor.x, cursor.y, 18, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, H - 90, W, 90);
  ctx.fillStyle = '#f5c518'; ctx.font = '900 44px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(`RASPA BUZU · ${scraped}`, 24, H - 32);

  if (now > msgUntil) msg.textContent = '';
  hud.textContent = hudText();
}

function hudText() {
  const handPct = frames ? Math.round((framesWithHand / frames) * 100) : 0;
  const elapsed = (performance.now() - stageStart) / 1000;
  const speed = dl.start ? (dl.bytes / 1e6) / Math.max(0.001, ((dl.end || performance.now()) - dl.start) / 1000) : 0;
  return [
    `versão ${__BUILD__} · worker · modo ${DELEGATE_PREF} · modelo de ${MODEL_SRC}`,
    ready
      ? `modelo ok (${delegates.join('+')}, ${modelMs} ms) · usando ${cfg.delegate} · entrada ${cfg.input || 'inteira'} · tela máx ${cfg.renderCap}${gpuError ? ` · GPU falhou: ${gpuError}` : ''}`
      : lastError ? 'modelo falhou' : `${stage}… ${elapsed.toFixed(0)}s${elapsed > 15 ? ' (TRAVOU AQUI?)' : ''}`,
    dl.bytes ? `download: ${(dl.bytes / 1e6).toFixed(2)}${dl.total ? ` / ${(dl.total / 1e6).toFixed(2)}` : ''} MB · ${speed.toFixed(2)} MB/s` : '',
    stageLog.length ? `etapas: ${stageLog.join(' · ')}` : '',
    `detecção: ${rate(inferStamps).toFixed(1)} fps · ${median(inferTimes).toFixed(1)} ms/quadro (mediana)`,
    `tela: ${rate(renderStamps).toFixed(0)} fps · câmera ${video.videoWidth}×${video.videoHeight}`,
    `mão visível: ${handPct}% · raspadas: ${scrapeHits} · adesivos: ${scraped} · tchaus: ${waves}`,
    benchRows.length ? 'TESTE AUTOMÁTICO:\n' + benchRows.join('\n') : '',
    lastError ? `ERRO: ${lastError}` : '',
  ].filter(Boolean).join('\n');
}

// ---------- automatic benchmark ----------
// Runs each setup for BENCH_MS with the user's hand in view, then keeps the best one.
const BENCH_MS = 10_000, WARMUP_MS = 2_000;
const benchBtn = $<HTMLButtonElement>('#bench');
const benchRows: string[] = [];
let bench: { queue: { delegate: 'GPU' | 'CPU'; input: number }[]; i: number; start: number; measured: boolean; results: { label: string; det: number; ms: number; hand: number; tela: number; c: { delegate: 'GPU' | 'CPU'; input: number } }[] } | null = null;

benchBtn.addEventListener('click', () => {
  const queue: { delegate: 'GPU' | 'CPU'; input: number }[] = [];
  for (const d of delegates) for (const input of [0, 256]) queue.push({ delegate: d, input });
  bench = { queue, i: -1, start: 0, measured: false, results: [] };
  benchRows.length = 0;
  benchBtn.disabled = true;
  nextBench(performance.now());
});

function nextBench(now: number) {
  if (!bench) return;
  bench.i++;
  if (bench.i >= bench.queue.length) return finishBench();
  Object.assign(cfg, bench.queue[bench.i], { renderCap: 30 });
  bench.start = now; bench.measured = false;
  resetStats();
}

function benchTick(now: number) {
  if (!bench) return;
  const c = bench.queue[bench.i];
  const left = Math.ceil((bench.start + BENCH_MS - now) / 1000);
  msg.textContent = `${bench.i + 1}/${bench.queue.length} · ${c.delegate} · ${c.input || 'inteira'} · mexa a mão · ${left}s`;
  msgUntil = now + 200;
  if (!bench.measured && now - bench.start > WARMUP_MS) { resetStats(); bench.measured = true; }
  if (now - bench.start < BENCH_MS) return;
  const hand = frames ? Math.round((framesWithHand / frames) * 100) : 0;
  const r = { label: `${c.delegate} ${c.input || 'inteira'}`, det: rate(inferStamps), ms: median(inferTimes), hand, tela: rate(renderStamps), c };
  bench.results.push(r);
  benchRows.push(`${r.label.padEnd(12)} det ${r.det.toFixed(1)} fps · ${r.ms.toFixed(0)} ms · mão ${r.hand}% · tela ${r.tela.toFixed(0)}`);
  nextBench(now);
}

function finishBench() {
  if (!bench) return;
  // Detection rate matters most; a setup that rarely sees the hand is penalised.
  const score = (r: { det: number; hand: number }) => r.det * (r.hand >= 60 ? 1 : 0.5);
  const best = [...bench.results].sort((a, b) => score(b) - score(a))[0];
  if (best) { Object.assign(cfg, best.c); benchRows.push(`melhor: ${best.label} (em uso agora)`); }
  bench = null;
  benchBtn.disabled = false;
  resetStats();
  say('teste pronto');
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
  catch (e) { recResult += ' · share falhou: ' + (e instanceof Error ? e.name : String(e)); }
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
    `gravação: ${recResult}`,
  ].join('\n');
  try { await navigator.clipboard.writeText(text); say('copiado'); }
  catch { hud.textContent = text; }
});

requestAnimationFrame(loop);
