// Records the game canvas plus game audio into a shareable file (mp4 where the browser can).

const TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

/** Hard cap so a clip always fits a 60 s story/status, whatever the game timing does. */
export const MAX_RECORD_MS = 59_500;

export class CanvasRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stopped: Promise<void> | null = null;
  private capTimer = 0;
  readonly mime = pickMime();

  get supported() { return Boolean(this.mime); }

  start(canvas: HTMLCanvasElement, audio?: MediaStream) {
    if (!this.mime) return;
    const stream = canvas.captureStream(24);
    audio?.getAudioTracks().forEach((t) => stream.addTrack(t));
    this.chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: this.mime, videoBitsPerSecond: 2_000_000 });
    rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.stopped = new Promise((resolve) => { rec.onstop = () => resolve(); });
    rec.start(500);
    this.rec = rec;
    clearTimeout(this.capTimer);
    this.capTimer = window.setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, MAX_RECORD_MS);
  }

  /** Stops (if the cap has not already) and returns the clip. */
  async stop(name: string): Promise<File | null> {
    const rec = this.rec;
    if (!rec || !this.stopped) return null;
    clearTimeout(this.capTimer);
    if (rec.state !== 'inactive') rec.stop();
    await this.stopped;
    this.rec = null;
    const type = this.mime.split(';')[0];
    const ext = type === 'video/mp4' ? 'mp4' : 'webm';
    return new File(this.chunks, `${name}.${ext}`, { type });
  }
}
