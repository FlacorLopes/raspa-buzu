// Main-thread side of hand tracking: feeds camera frames to the worker (only when it is idle,
// so nothing queues) and hands results back in camera-normalised coordinates.

import type { FromWorker, Pt, ToWorker } from './hand-worker.ts';

export type { Pt };

export class HandTracker {
  ready = false;
  delegate = '';
  error = '';
  loadMs = 0;
  progress = { bytes: 0, total: 0 };
  /** Called with the 21 landmarks (0..1, camera space, not mirrored) or null when no hand. */
  onResult: (landmarks: Pt[] | null, at: number) => void = () => {};

  private worker: Worker;
  private busy = false;
  private stamps: number[] = [];

  constructor(wasmBase: string, modelUrl: string) {
    this.worker = new Worker(new URL('./hand-worker.ts', import.meta.url));
    this.worker.addEventListener('message', (e: MessageEvent<FromWorker>) => this.handle(e.data));
    this.worker.addEventListener('error', (e) => { this.error = e.message || 'o detector de mão não iniciou'; });
    this.send({ type: 'init', wasmBase: new URL(wasmBase, location.href).href, modelUrl: new URL(modelUrl, location.href).href });
  }

  private send(m: ToWorker, transfer: Transferable[] = []) { this.worker.postMessage(m, transfer); }

  private handle(m: FromWorker) {
    if (m.type === 'progress') this.progress = { bytes: m.bytes, total: m.total };
    else if (m.type === 'ready') { this.ready = true; this.delegate = m.delegate; this.loadMs = m.ms; }
    else if (m.type === 'error') this.error = m.message;
    else if (m.type === 'result') {
      this.busy = false;
      const now = performance.now();
      this.stamps.push(now);
      if (this.stamps.length > 30) this.stamps.shift();
      this.onResult(m.landmarks, now);
    }
  }

  /** Call every animation frame; sends a frame only when the worker is free. */
  async pump(video: HTMLVideoElement) {
    if (!this.ready || this.busy || video.readyState < 2) return;
    this.busy = true;
    try {
      const bitmap = await createImageBitmap(video);
      this.send({ type: 'frame', bitmap, t: performance.now() }, [bitmap]);
    } catch {
      this.busy = false;
    }
  }

  /** Detections per second over the last ~30 results. */
  fps() {
    const s = this.stamps;
    return s.length < 2 ? 0 : ((s.length - 1) * 1000) / (s[s.length - 1] - s[0]);
  }
}

/** One Euro filter: smooths a jittery signal without adding much lag on fast moves. */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(private minCutoff = 1.2, private beta = 0.02, private dCutoff = 1) {}
  private alpha(cutoff: number, dt: number) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v: number, tMs: number) {
    if (this.x === null) { this.x = v; this.t = tMs; return v; }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const dv = (v - this.x) / dt;
    this.dx += this.alpha(this.dCutoff, dt) * (dv - this.dx);
    this.x += this.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt) * (v - this.x);
    return this.x;
  }
  reset() { this.x = null; }
}

/** Open palm: at least four fingertips clearly farther from the wrist than their middle joints. */
export function isOpenPalm(lm: Pt[]) {
  const w = lm[0];
  const d = (a: Pt) => Math.hypot(a.x - w.x, a.y - w.y);
  let open = 0;
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) if (d(lm[tip]) > d(lm[pip]) * 1.15) open++;
  return open >= 4;
}
