// Puts the MediaPipe runtime and the hand model in public/ so the app serves both itself.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const MODEL_PATH = 'public/mediapipe/hand_landmarker.task';

mkdirSync('public/mediapipe/wasm', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe/wasm', { recursive: true });
console.log('mediapipe wasm -> public/mediapipe/wasm');

if (!existsSync(MODEL_PATH)) {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  writeFileSync(MODEL_PATH, Buffer.from(await res.arrayBuffer()));
  console.log(`hand model -> ${MODEL_PATH}`);
}
