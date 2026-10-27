// Records the game canvas plus game audio into a shareable file (mp4 where the browser can).

const TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
}

export class CanvasRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  readonly mime = pickMime();

  get supported() { return Boolean(this.mime); }

  start(canvas: HTMLCanvasElement, audio?: MediaStream) {
    if (!this.mime) return;
    const stream = canvas.captureStream(24);
    audio?.getAudioTracks().forEach((t) => stream.addTrack(t));
    this.chunks = [];
    this.rec = new MediaRecorder(stream, { mimeType: this.mime, videoBitsPerSecond: 2_000_000 });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(500);
  }

  stop(name: string): Promise<File | null> {
    const rec = this.rec;
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        const type = this.mime.split(';')[0];
        const ext = type === 'video/mp4' ? 'mp4' : 'webm';
        resolve(new File(this.chunks, `${name}.${ext}`, { type }));
      };
      rec.stop();
    });
  }
}
