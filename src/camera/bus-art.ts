// Integra bus front (Caio Apache Vip as run by Plataforma/yellow and OT Trans/green),
// drawn with a see-through windshield so the player's hand shows up "behind the glass".

import { ACCESS_STICKER, type BusSpec } from '../sim.ts';
import { DECOYS } from '../content.ts';

export interface Rect { x: number; y: number; w: number; h: number }

const LIVERY = {
  amarelo: { body: '#f4c300', shade: '#d9a900', fleet: '#111111' },
  verde: { body: '#0f9b6c', shade: '#0b7d57', fleet: '#ffffff' },
} as const;

/** Windshield box relative to the bus front (shared by drawing and hit tests). */
export const WS = { x: 0.07, y: 0.17, w: 0.86, h: 0.42 };

export function windshield(r: Rect): Rect {
  return { x: r.x + WS.x * r.w, y: r.y + WS.y * r.h, w: WS.w * r.w, h: WS.h * r.h };
}

/** Sticker radius in px for a bus drawn at `r`. */
export const stickerRadius = (r: Rect) => r.w * 0.085;

export function stickerCenter(r: Rect, spec: Pick<BusSpec, 'wu' | 'wv'>) {
  const w = windshield(r);
  return { x: w.x + spec.wu * w.w, y: w.y + spec.wv * w.h };
}

export function accessCenter(r: Rect) {
  return stickerCenter(r, ACCESS_STICKER);
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rad: number | number[]) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, rad);
  else ctx.rect(x, y, w, h);
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rad = i % 2 ? r : R;
    ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  ctx.closePath();
}

export interface BusDrawState {
  spec: BusSpec;
  /** Remaining scrapes on the 13 sticker; 0 = scraped off. */
  hp: number;
}

export function drawBusFront(ctx: CanvasRenderingContext2D, r: Rect, s: BusDrawState) {
  const { x, y, w, h } = r;
  const c = LIVERY[s.spec.livery];

  // mirrors on stalks
  ctx.strokeStyle = c.shade; ctx.lineWidth = w * 0.02; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x + w * 0.04, y + h * 0.12); ctx.quadraticCurveTo(x - w * 0.08, y + h * 0.1, x - w * 0.08, y + h * 0.2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + w * 0.96, y + h * 0.12); ctx.quadraticCurveTo(x + w * 1.08, y + h * 0.1, x + w * 1.08, y + h * 0.2); ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = c.body;
  rr(ctx, x - w * 0.11, y + h * 0.19, w * 0.06, h * 0.13, 6); ctx.fill();
  rr(ctx, x + w * 1.05, y + h * 0.19, w * 0.06, h * 0.13, 6); ctx.fill();

  // wheels under the bumper
  ctx.fillStyle = '#111';
  rr(ctx, x + w * 0.06, y + h * 0.92, w * 0.15, h * 0.08, 6); ctx.fill();
  rr(ctx, x + w * 0.79, y + h * 0.92, w * 0.15, h * 0.08, 6); ctx.fill();

  // body: the whole front is painted in the basin colour
  const body = new Path2D();
  if ((body as unknown as { roundRect?: unknown }).roundRect) body.roundRect(x, y, w, h * 0.95, [w * 0.1, w * 0.1, w * 0.05, w * 0.05]);
  else body.rect(x, y, w, h * 0.95);
  const win = windshield(r);
  const glass = new Path2D();
  if ((glass as unknown as { roundRect?: unknown }).roundRect) glass.roundRect(win.x, win.y, win.w, win.h, w * 0.035);
  else glass.rect(win.x, win.y, win.w, win.h);
  ctx.save();
  // paint the body around the windshield hole, so the camera shows through the glass
  const shell = new Path2D(); shell.addPath(body); shell.addPath(glass);
  ctx.fillStyle = c.body; ctx.fill(shell, 'evenodd');
  ctx.restore();

  // black header with the LED destination sign
  ctx.fillStyle = '#121414';
  rr(ctx, x + w * 0.05, y + h * 0.02, w * 0.9, h * 0.12, [w * 0.07, w * 0.07, 6, 6]); ctx.fill();
  const lh = h * 0.07, lx = x + w * 0.09, ly = y + h * 0.045, lw = w * 0.82;
  ctx.fillStyle = '#ffd36b';
  ctx.font = `400 ${lh * 1.05}px VT323, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(`${s.spec.line.code} ${s.spec.line.led}`, lx + lw / 2, ly + lh / 2 + 2, lw);
  ctx.textBaseline = 'alphabetic';

  // windshield: thin tint + black frame, centre pillar, wipers
  ctx.fillStyle = 'rgba(20,40,48,0.22)'; ctx.fill(glass);
  ctx.strokeStyle = '#121414'; ctx.lineWidth = w * 0.025; ctx.stroke(glass);
  ctx.fillStyle = '#121414'; ctx.fillRect(win.x + win.w * 0.495, win.y, win.w * 0.012, win.h);
  ctx.strokeStyle = '#121414'; ctx.lineWidth = w * 0.012; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(win.x + win.w * 0.12, win.y + win.h * 0.98); ctx.lineTo(win.x + win.w * 0.36, win.y + win.h * 0.42); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(win.x + win.w * 0.56, win.y + win.h * 0.98); ctx.lineTo(win.x + win.w * 0.8, win.y + win.h * 0.42); ctx.stroke();
  ctx.lineCap = 'butt';
  // small route display at the bottom-left of the glass
  ctx.fillStyle = 'rgba(10,12,12,0.85)';
  rr(ctx, win.x + win.w * 0.04, win.y + win.h * 0.8, win.w * 0.26, win.h * 0.13, 4); ctx.fill();
  ctx.fillStyle = '#ffd36b'; ctx.font = `400 ${win.h * 0.11}px VT323, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(s.spec.line.code, win.x + win.w * 0.17, win.y + win.h * 0.87);
  ctx.textBaseline = 'alphabetic';

  // grille, headlights, fleet number
  ctx.fillStyle = '#121414';
  rr(ctx, x + w * 0.22, y + h * 0.66, w * 0.56, h * 0.1, 10); ctx.fill();
  ctx.strokeStyle = c.shade; ctx.lineWidth = 3;
  for (let i = 1; i < 4; i++) { const gy = y + h * (0.66 + i * 0.025); ctx.beginPath(); ctx.moveTo(x + w * 0.25, gy); ctx.lineTo(x + w * 0.75, gy); ctx.stroke(); }
  ctx.fillStyle = '#e9eef0';
  ctx.beginPath(); ctx.moveTo(x + w * 0.04, y + h * 0.7); ctx.lineTo(x + w * 0.19, y + h * 0.72); ctx.lineTo(x + w * 0.17, y + h * 0.77); ctx.lineTo(x + w * 0.05, y + h * 0.76); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x + w * 0.96, y + h * 0.7); ctx.lineTo(x + w * 0.81, y + h * 0.72); ctx.lineTo(x + w * 0.83, y + h * 0.77); ctx.lineTo(x + w * 0.95, y + h * 0.76); ctx.closePath(); ctx.fill();
  ctx.fillStyle = c.fleet; ctx.font = `800 ${h * 0.045}px Archivo, sans-serif`; ctx.textAlign = 'left';
  ctx.fillText(String(s.spec.fleet), x + w * 0.06, y + h * 0.65);
  // bumper and Mercosul plate
  ctx.fillStyle = c.shade; rr(ctx, x + w * 0.03, y + h * 0.82, w * 0.94, h * 0.1, 10); ctx.fill();
  ctx.fillStyle = '#121414'; ctx.fillRect(x + w * 0.3, y + h * 0.84, w * 0.08, h * 0.03); ctx.fillRect(x + w * 0.62, y + h * 0.84, w * 0.08, h * 0.03);
  const pw = w * 0.22, ph = h * 0.05, px = x + w / 2 - pw / 2, py = y + h * 0.86;
  ctx.fillStyle = '#fff'; rr(ctx, px, py, pw, ph, 4); ctx.fill();
  ctx.fillStyle = '#1f3fa0'; ctx.fillRect(px, py, pw, ph * 0.25);
  ctx.fillStyle = '#111'; ctx.font = `700 ${ph * 0.6}px Archivo, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(s.spec.plate, px + pw / 2, py + ph * 0.62, pw - 6);
  ctx.textBaseline = 'alphabetic';

  // stickers on the glass
  drawAccessSticker(ctx, r);
  if (s.spec.kind === 'decoy') drawDecoy(ctx, r, s.spec);
  if (s.spec.kind === '13' && s.hp > 0) draw13(ctx, r, s.spec, s.hp);
}

function drawAccessSticker(ctx: CanvasRenderingContext2D, r: Rect) {
  const c = accessCenter(r), size = stickerRadius(r) * 1.5;
  ctx.fillStyle = '#1d6fd6'; ctx.fillRect(c.x - size / 2, c.y - size / 2, size, size);
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = size * 0.08;
  ctx.beginPath(); ctx.arc(c.x - size * 0.04, c.y - size * 0.28, size * 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(c.x - size * 0.06, c.y - size * 0.16); ctx.lineTo(c.x - size * 0.06, c.y + size * 0.06); ctx.lineTo(c.x + size * 0.16, c.y + size * 0.06); ctx.lineTo(c.x + size * 0.24, c.y + size * 0.28); ctx.stroke();
  ctx.beginPath(); ctx.arc(c.x - size * 0.06, c.y + size * 0.14, size * 0.2, Math.PI * 0.6, Math.PI * 1.9); ctx.stroke();
}

function drawDecoy(ctx: CanvasRenderingContext2D, r: Rect, spec: BusSpec) {
  const d = DECOYS[spec.decoy], c = stickerCenter(r, spec), sr = stickerRadius(r);
  const w = sr * 2.9, h = sr * 1.2;
  ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(spec.rot);
  ctx.fillStyle = d.bg; rr(ctx, -w / 2, -h / 2, w, h, 6); ctx.fill();
  ctx.strokeStyle = d.edge; ctx.lineWidth = 3; rr(ctx, -w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 4); ctx.stroke();
  ctx.fillStyle = d.fg; ctx.font = `400 ${h * 0.34}px Bungee, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(d.text, 0, 2, w - 14); ctx.textBaseline = 'alphabetic';
  ctx.restore();
}

function draw13(ctx: CanvasRenderingContext2D, r: Rect, spec: BusSpec, hp: number) {
  const c = stickerCenter(r, spec), sr = stickerRadius(r);
  const dmg = 1 - hp / spec.hp;
  ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(spec.rot); ctx.scale(1 - dmg * 0.15, 1 - dmg * 0.15);
  if (spec.hp > 2) {
    ctx.strokeStyle = '#f5c518'; ctx.lineWidth = spec.hp === 4 ? 7 : 4;
    ctx.beginPath(); ctx.arc(0, 0, sr + 5, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = '#d4251c'; ctx.beginPath(); ctx.arc(0, 0, sr, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = sr * 0.09; ctx.beginPath(); ctx.arc(0, 0, sr * 0.86, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#fff'; star(ctx, 0, sr * 0.02, sr * 0.68, sr * 0.29); ctx.fill();
  ctx.fillStyle = '#d4251c'; ctx.font = `400 ${sr * 0.48}px Bungee, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('13', 0, sr * 0.1); ctx.textBaseline = 'alphabetic';
  if (dmg > 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath(); ctx.moveTo(sr * 0.2, sr); ctx.lineTo(sr, sr * 0.2); ctx.lineTo(sr * 0.35, sr * 0.35); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 3;
    const n = Math.round(dmg * 6);
    for (let i = 0; i < n; i++) { const o = (i - n / 2) * sr * 0.22; ctx.beginPath(); ctx.moveTo(-sr * 0.8, o - sr * 0.3); ctx.lineTo(sr * 0.6, o + sr * 0.3); ctx.stroke(); }
  }
  ctx.restore();
}
