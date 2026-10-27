// Serves the built site (dist/) over HTTPS on the LAN so a phone can open the camera.
// Uses Node's own https server: Vite 8's dev server crashes on websocket upgrades over
// HTTPS under Node 22.21. Run `pnpm build` first. The self-signed cert lives in .cert/.
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = 'dist';
const PORT = Number(process.env.PORT || 5174);
const CERT_DIR = '.cert';
const key = join(CERT_DIR, 'key.pem'), cert = join(CERT_DIR, 'cert.pem');
if (!existsSync(key)) {
  mkdirSync(CERT_DIR, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-subj', '/CN=raspa-buzu-dev', '-keyout', key, '-out', cert], { stdio: 'ignore' });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.task': 'application/octet-stream',
};

const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const url = new URL(req.url ?? '/', 'https://x');
  let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'index.html');
  if (!existsSync(path)) { res.writeHead(404).end('not found'); log(req, 404, 0, 0); return; }
  const body = readFileSync(path);
  const t0 = Date.now();
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
  // 'finish' = all bytes handed to the OS; 'close' without finish = client dropped mid-transfer.
  let finished = false;
  res.on('finish', () => { finished = true; log(req, 200, body.length, Date.now() - t0); });
  res.on('close', () => { if (!finished) log(req, 'ABORTED', res.socket?.bytesWritten ?? 0, Date.now() - t0); });
});

function log(req, status, bytes, ms) {
  const who = req.socket.remoteAddress?.replace('::ffff:', '');
  console.log(`${new Date().toISOString().slice(11, 19)} ${who} ${req.method} ${req.url} ${status} ${(bytes / 1e6).toFixed(2)}MB ${ms}ms`);
}
server.on('upgrade', (_req, socket) => socket.destroy());
server.listen(PORT, '0.0.0.0', () => {
  for (const nets of Object.values(networkInterfaces())) for (const n of nets ?? [])
    if (n.family === 'IPv4' && !n.internal) console.log(`https://${n.address}:${PORT}/spike/camera.html`);
});
