// Hand detection off the main thread. Must run as a classic worker: MediaPipe loads its
// WASM loader with importScripts when it detects a worker. GPU first; CPU only if GPU fails
// (the spike measured GPU ~40% faster on a mid-range Android).
// Two models: the gesture recognizer (landmarks + trained Thumb_Up etc.) or the plain landmarker.

import { FilesetResolver, GestureRecognizer, HandLandmarker } from '@mediapipe/tasks-vision';

export type Pt = { x: number; y: number };
export type ModelKind = 'gesture' | 'landmarker';
export type Gesture = { name: string; score: number };

export type ToWorker =
  | { type: 'init'; wasmBases: string[]; modelUrls: string[]; kind: ModelKind }
  | { type: 'frame'; frame: ImageBitmap | VideoFrame; t: number };

export type FromWorker =
  | { type: 'progress'; bytes: number; total: number }
  | { type: 'ready'; delegate: 'GPU' | 'CPU'; ms: number; wasmFrom: string; modelFrom: string }
  | { type: 'error'; message: string }
  | { type: 'result'; t: number; ms: number; landmarks: Pt[] | null; gesture: Gesture | null; error?: string };

const scope = self as unknown as {
  postMessage(m: FromWorker): void;
  addEventListener(type: 'message', fn: (e: MessageEvent<ToWorker>) => void): void;
};
const post = (m: FromWorker) => scope.postMessage(m);

const GPU_TIMEOUT_MS = 12_000;
let landmarker: HandLandmarker | null = null;
let recognizer: GestureRecognizer | null = null;

function describe(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Downloads the model from the first source that answers, reporting progress. */
async function fetchModel(urls: string[]): Promise<{ model: Uint8Array; from: string }> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
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
      return { model, from: url };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`modelo: ${describe(lastError)}`);
}

async function init(msg: Extract<ToWorker, { type: 'init' }>) {
  const t0 = performance.now();
  const { model, from: modelFrom } = await fetchModel(msg.modelUrls);

  const create = async (fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>, delegate: 'GPU' | 'CPU') => {
    const options = { baseOptions: { modelAssetBuffer: model, delegate }, runningMode: 'VIDEO' as const, numHands: 1 };
    if (msg.kind === 'gesture') recognizer = await GestureRecognizer.createFromOptions(fileset, options);
    else landmarker = await HandLandmarker.createFromOptions(fileset, options);
  };

  // The WASM runtime is fetched when the task is created, so a dead CDN shows up here:
  // try each source in order, GPU first and CPU as a fallback for each.
  let lastError: unknown;
  for (const base of msg.wasmBases) {
    const fileset = await FilesetResolver.forVisionTasks(base);
    try {
      let delegate: 'GPU' | 'CPU' = 'GPU';
      try {
        await Promise.race([
          create(fileset, 'GPU'),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('GPU timeout')), GPU_TIMEOUT_MS)),
        ]);
      } catch {
        await create(fileset, 'CPU');
        delegate = 'CPU';
      }
      post({ type: 'ready', delegate, ms: Math.round(performance.now() - t0), wasmFrom: base, modelFrom });
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`motor: ${describe(lastError)}`);
}

scope.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    init(msg).catch((err) => post({ type: 'error', message: describe(err) }));
    return;
  }
  if (msg.type === 'frame') {
    if (!landmarker && !recognizer) { msg.frame.close(); post({ type: 'result', t: msg.t, ms: 0, landmarks: null, gesture: null }); return; }
    const t0 = performance.now();
    let landmarks: Pt[] | null = null;
    let gesture: Gesture | null = null;
    let error: string | undefined;
    try {
      if (recognizer) {
        const r = recognizer.recognizeForVideo(msg.frame, msg.t);
        landmarks = r.landmarks[0]?.map((p) => ({ x: p.x, y: p.y })) ?? null;
        const top = r.gestures[0]?.[0];
        if (top) gesture = { name: top.categoryName, score: top.score };
      } else if (landmarker) {
        const r = landmarker.detectForVideo(msg.frame, msg.t);
        landmarks = r.landmarks[0]?.map((p) => ({ x: p.x, y: p.y })) ?? null;
      }
    } catch (e) {
      error = describe(e);
    } finally {
      msg.frame.close();
    }
    post({ type: 'result', t: msg.t, ms: performance.now() - t0, landmarks, gesture, error });
  }
});
