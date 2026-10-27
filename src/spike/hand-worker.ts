// Hand detection off the main thread, so drawing and recording stay smooth while the
// model takes ~60-70 ms per frame on mid-range phones. Must run as a classic worker:
// MediaPipe loads its WASM loader with importScripts when it detects a worker.

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

export type ToWorker =
  | { type: 'init'; wasmBase: string; modelUrl: string; delegate: 'auto' | 'gpu' | 'cpu' }
  | { type: 'frame'; bitmap: ImageBitmap; t: number };

export type FromWorker =
  | { type: 'stage'; name: string }
  | { type: 'progress'; bytes: number; total: number; done: boolean }
  | { type: 'ready'; delegate: 'GPU' | 'CPU'; ms: number; gpuError: string; log: string[] }
  | { type: 'error'; message: string }
  | { type: 'result'; t: number; ms: number; landmarks: { x: number; y: number }[] | null };

const scope = self as unknown as {
  postMessage(m: FromWorker): void;
  addEventListener(type: 'message', fn: (e: MessageEvent<ToWorker>) => void): void;
};
const post = (m: FromWorker) => scope.postMessage(m);

const GPU_TIMEOUT_MS = 12_000;
let landmarker: HandLandmarker | null = null;

function describe(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string) {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} travou (> ${ms / 1000}s)`)), ms))]);
}

async function init(msg: Extract<ToWorker, { type: 'init' }>) {
  const t0 = performance.now();
  const log: string[] = [];
  let mark = performance.now();
  const done = (label: string) => { log.push(`${label} ${((performance.now() - mark) / 1000).toFixed(1)}s`); mark = performance.now(); };

  post({ type: 'stage', name: 'baixando motor wasm' });
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase);
  done('motor');

  post({ type: 'stage', name: 'baixando modelo' });
  const res = await fetch(msg.modelUrl, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`modelo: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done: end, value } = await reader.read();
    if (end) break;
    chunks.push(value); bytes += value.length;
    post({ type: 'progress', bytes, total, done: false });
  }
  post({ type: 'progress', bytes, total, done: true });
  const model = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) { model.set(c, off); off += c.length; }
  done(`modelo ${(bytes / 1e6).toFixed(1)}MB`);

  const create = (d: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: model, delegate: d },
    runningMode: 'VIDEO', numHands: 1,
  });

  let delegate: 'GPU' | 'CPU' = 'GPU';
  let gpuError = '';
  if (msg.delegate !== 'cpu') {
    post({ type: 'stage', name: 'iniciando GPU' });
    try { landmarker = await withTimeout(create('GPU'), GPU_TIMEOUT_MS, 'GPU'); done('GPU'); }
    catch (e) {
      gpuError = describe(e);
      if (msg.delegate === 'gpu') throw new Error(`GPU: ${gpuError}`);
    }
  }
  if (!landmarker) {
    post({ type: 'stage', name: 'iniciando CPU' });
    landmarker = await create('CPU');
    delegate = 'CPU';
    done('CPU');
  }
  post({ type: 'ready', delegate, ms: Math.round(performance.now() - t0), gpuError, log });
}

scope.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg).catch((err) => post({ type: 'error', message: describe(err) }));
    return;
  }
  if (msg.type === 'frame') {
    if (!landmarker) { msg.bitmap.close(); post({ type: 'result', t: msg.t, ms: 0, landmarks: null }); return; }
    const t0 = performance.now();
    let landmarks: { x: number; y: number }[] | null = null;
    try {
      const r = landmarker.detectForVideo(msg.bitmap, msg.t);
      landmarks = r.landmarks[0]?.map((p) => ({ x: p.x, y: p.y })) ?? null;
    } finally {
      msg.bitmap.close();
    }
    post({ type: 'result', t: msg.t, ms: performance.now() - t0, landmarks });
  }
});
