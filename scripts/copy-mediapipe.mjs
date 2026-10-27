// Copies the MediaPipe WASM runtime into public/ so the app serves it itself (no CDN at runtime).
import { cpSync, mkdirSync } from 'node:fs';
const from = 'node_modules/@mediapipe/tasks-vision/wasm';
const to = 'public/mediapipe/wasm';
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`mediapipe wasm -> ${to}`);
