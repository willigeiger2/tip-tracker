// MediaPipe runtime configuration shared by the pose and hand detectors.

/**
 * Base path of the self-hosted MediaPipe Tasks Vision WASM runtime.
 * Populated from node_modules by scripts/copy-mediapipe-wasm.mjs so the WASM
 * always matches the installed @mediapipe/tasks-vision JS version.
 */
export const MEDIAPIPE_WASM_PATH = '/mediapipe/wasm';
