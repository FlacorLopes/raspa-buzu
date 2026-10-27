// Puts the MediaPipe runtime and the hand model in public/ so the app serves both itself.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const MODELS = {
  'public/mediapipe/hand_landmarker.task': 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  // Same hand landmarks plus a trained gesture classifier (Thumb_Up, Open_Palm, ...).
  'public/mediapipe/gesture_recognizer.task': 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
};

mkdirSync('public/mediapipe/wasm', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/mediapipe/wasm', { recursive: true });
console.log('mediapipe wasm -> public/mediapipe/wasm');

for (const [path, url] of Object.entries(MODELS)) {
  if (existsSync(path)) continue;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed: ${res.status} ${url}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  console.log(`model -> ${path}`);
}
