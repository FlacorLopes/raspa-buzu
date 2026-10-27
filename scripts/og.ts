// Draws the 1200x630 link-preview card (og:image) with the game's own bus art.
import { drawBusFront } from '../src/camera/bus-art.ts';
import type { BusSpec } from '../src/sim.ts';

const cv = document.getElementById('og') as HTMLCanvasElement;
const g = cv.getContext('2d')!;
const W = cv.width, H = cv.height;

const bus: BusSpec = {
  index: 0, kind: '13', hp: 2, decoy: 0, wu: 0.74, wv: 0.38, rot: -0.15, livery: 'amarelo',
  line: { code: '0205', led: 'T. FRANÇA / MASSARANDUBA', livery: 'amarelo' }, fleet: 30929, plate: 'PKX4E21',
};

function stripes(y: number) {
  for (let x = -40; x < W + 40; x += 48) {
    g.fillStyle = '#f5c518';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + 24, y); g.lineTo(x - 10, y + 30); g.lineTo(x - 34, y + 30); g.fill();
  }
}

async function draw() {
  await Promise.all(['400 100px Bungee', '800 40px Archivo', '600 40px Archivo', '400 40px VT323'].map((f) => document.fonts.load(f)));
  g.fillStyle = '#16191a'; g.fillRect(0, 0, W, H);
  stripes(0); stripes(H - 30);

  const bw = 400, bh = bw / 0.82;
  drawBusFront(g, { x: W - bw - 70, y: H - bh - 40, w: bw, h: bh }, { spec: bus, hp: 2 });

  g.textAlign = 'left';
  g.fillStyle = '#ffae1a'; g.font = '400 36px VT323'; g.fillText('SALVADOR · 2º TURNO', 60, 100);
  g.fillStyle = '#f5c518'; g.font = '400 128px Bungee'; g.fillText('RASPA', 52, 230);
  g.fillStyle = '#f3f1ea'; g.fillText('BUZU', 52, 350);
  g.fillStyle = '#f3f1ea'; g.font = '800 44px Archivo'; g.fillText('944 ônibus parados.', 60, 430);
  g.fillText('A desculpa: um adesivo.', 60, 484);
  g.fillStyle = '#9ba5a4'; g.font = '600 32px Archivo'; g.fillText('Tire com a mão. 1 minuto. Sátira.', 60, 550);
  document.title = 'ready';
}
draw();
