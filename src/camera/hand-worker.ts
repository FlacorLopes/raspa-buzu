// Hand detection off the main thread. Must run as a classic worker: MediaPipe loads its
// WASM loader with importScripts when it detects a worker. GPU first; CPU only if GPU fails
// (the spike measured GPU ~40% faster on a mid-range Android).

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';

export type Pt = { x: number; y: number };

export type ToWorker =
  | { type: 'init'; wasmBase: string; modelUrl: string }
  | { type: 'frame'; frame: ImageBitmap | VideoFrame; t: number };

export type FromWorker =
  | { type: 'progress'; bytes: number; total: number }
  | { type: 'ready'; delegate: 'GPU' | 'CPU'; ms: number }
  | { type: 'error'; message: string }
  | { type: 'result'; t: number; ms: number; landmarks: Pt[] | null; error?: string };

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

async function init(msg: Extract<ToWorker, { type: 'init' }>) {
  const t0 = performance.now();
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase);

  const res = await fetch(msg.modelUrl);
  if (!res.ok || !res.body) throw new Error(`modelo: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); bytes += value.length;
    post({ type: 'progress', bytes, total });
  }
  const model = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) { model.set(c, off); off += c.length; }

  const create = (delegate: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: model, delegate },
    runningMode: 'VIDEO', numHands: 1,
  });
  let delegate: 'GPU' | 'CPU' = 'GPU';
  try {
    landmarker = await Promise.race([
      create('GPU'),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('GPU timeout')), GPU_TIMEOUT_MS)),
    ]);
  } catch {
    landmarker = await create('CPU');
    delegate = 'CPU';
  }
  post({ type: 'ready', delegate, ms: Math.round(performance.now() - t0) });
}

scope.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg).catch((err) => post({ type: 'error', message: describe(err) }));
    return;
  }
  if (msg.type === 'frame') {
    if (!landmarker) { msg.frame.close(); post({ type: 'result', t: msg.t, ms: 0, landmarks: null }); return; }
    const t0 = performance.now();
    let landmarks: Pt[] | null = null;
    let error: string | undefined;
    try {
      const r = landmarker.detectForVideo(msg.frame, msg.t);
      landmarks = r.landmarks[0]?.map((p) => ({ x: p.x, y: p.y })) ?? null;
    } catch (e) {
      error = describe(e);
    } finally {
      msg.frame.close();
    }
    post({ type: 'result', t: msg.t, ms: performance.now() - t0, landmarks, error });
  }
});
