// Where the hand-tracking runtime and model come from. CDNs first so a viral spike does not burn
// the app's own bandwidth (~22 MB per new player); the copies served by the app are the fallback.

/** Must match the installed @mediapipe/tasks-vision version (checked by tests/assets.test.ts). */
export const MEDIAPIPE_VERSION = '1.1.1';

export const WASM_BASES = [
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
  '/mediapipe/wasm',
];

export const GESTURE_MODEL_URLS = [
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
  '/mediapipe/gesture_recognizer.task',
];

export const LANDMARKER_MODEL_URLS = [
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  '/mediapipe/hand_landmarker.task',
];
