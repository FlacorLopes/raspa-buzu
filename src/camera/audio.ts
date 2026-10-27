// Game sounds, routed both to the speakers and to a stream the recorder mixes into the video.

export class Sfx {
  readonly ctx: AudioContext;
  readonly stream: MediaStream;
  private out: GainNode;
  private noise: AudioBuffer;

  constructor() {
    this.ctx = new AudioContext();
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.9;
    const rec = this.ctx.createMediaStreamDestination();
    this.out.connect(this.ctx.destination);
    this.out.connect(rec);
    this.stream = rec.stream;
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.2, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  resume() { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.06, slideTo?: number, when = 0) {
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out); o.start(t); o.stop(t + dur + 0.02);
  }

  scrape() {
    const s = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain(), t = this.ctx.currentTime;
    s.buffer = this.noise; f.type = 'bandpass'; f.frequency.value = 2200 + Math.random() * 1500; f.Q.value = 1.2;
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    s.connect(f).connect(g).connect(this.out); s.start(t); s.stop(t + 0.1);
  }
  pop() { this.tone(520, 0.09, 'triangle', 0.09, 1300); }
  bad() { this.tone(150, 0.18, 'square', 0.05, 90); }
  ping() { this.tone(880, 0.08, 'sine', 0.05); this.tone(1320, 0.12, 'sine', 0.05, undefined, 0.09); }
  beep(high = false) { this.tone(high ? 1046 : 660, 0.15, 'square', 0.04); }
  horn() {
    this.tone(233, 0.22, 'sawtooth', 0.035); this.tone(294, 0.22, 'sawtooth', 0.03);
    this.tone(233, 0.16, 'sawtooth', 0.035, undefined, 0.26); this.tone(294, 0.16, 'sawtooth', 0.03, undefined, 0.26);
  }
}
