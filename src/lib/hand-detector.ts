// MediaPipe Hand Detector Module
// Handles hand detection and index finger tip extraction

import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import type { Landmark, TipPosition, DetectionResult } from '../types/fencing';

let handLandmarker: HandLandmarker | null = null;
let isInitializing = false;

// MediaPipe hand landmark indices
export const HAND_LANDMARKS = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_FINGER_MCP: 5,
  INDEX_FINGER_PIP: 6,
  INDEX_FINGER_DIP: 7,
  INDEX_FINGER_TIP: 8,  // <-- SWORD TIP
  MIDDLE_FINGER_MCP: 9,
  MIDDLE_FINGER_PIP: 10,
  MIDDLE_FINGER_DIP: 11,
  MIDDLE_FINGER_TIP: 12,
  RING_FINGER_MCP: 13,
  RING_FINGER_PIP: 14,
  RING_FINGER_DIP: 15,
  RING_FINGER_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

// Hand skeleton connections for debug rendering
export const HAND_CONNECTIONS: [number, number][] = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index finger
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle finger
  [0, 9], [9, 10], [10, 11], [11, 12],
  // Ring finger
  [0, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // Palm
  [5, 9], [9, 13], [13, 17],
];

/**
 * Initialize the MediaPipe Hand Landmarker
 * Loads models from CDN (~4MB first time, cached subsequently)
 */
export async function initHandDetector(
  numHands: number = 2,
  minHandDetectionConfidence: number = 0.5,
  minHandPresenceConfidence: number = 0.5,
  minTrackingConfidence: number = 0.5
): Promise<HandLandmarker> {
  if (handLandmarker) {
    return handLandmarker;
  }

  if (isInitializing) {
    // Wait for initialization to complete
    while (isInitializing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (handLandmarker) {
      return handLandmarker;
    }
  }

  isInitializing = true;

  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
    );

    // Firefox has compatibility issues with MediaPipe's GPU delegate;
    // fall back to CPU to avoid hangs and "slow script" warnings.
    const isFirefox = typeof navigator !== 'undefined' &&
      navigator.userAgent.toLowerCase().includes('firefox');

    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: isFirefox ? 'CPU' : 'GPU'
      },
      runningMode: 'VIDEO',
      numHands: numHands,
      minHandDetectionConfidence: minHandDetectionConfidence,
      minHandPresenceConfidence: minHandPresenceConfidence,
      minTrackingConfidence: minTrackingConfidence,
    });

    console.log('MediaPipe Hand Landmarker initialized');
    return handLandmarker;
  } catch (error) {
    console.error('Failed to initialize MediaPipe Hand Landmarker:', error);
    throw error;
  } finally {
    isInitializing = false;
  }
}

/**
 * Detect hands in a video frame
 * Returns array of DetectionResult with index finger tips
 */
export async function detectHands(
  video: HTMLVideoElement,
  timestamp: number = performance.now()
): Promise<DetectionResult[]> {
  if (!handLandmarker) {
    throw new Error('Hand detector not initialized. Call initHandDetector() first.');
  }

  try {
    const results = handLandmarker.detectForVideo(video, timestamp);
    
    if (!results.landmarks || results.landmarks.length === 0) {
      return [];
    }

    // Sort hands by x-position (left to right)
    const handData = results.landmarks.map((landmarks, index) => ({
      landmarks: landmarks.map(convertToLandmark),
      handedness: results.handedness[index]?.[0]?.categoryName as 'Left' | 'Right' | undefined,
      score: results.handedness[index]?.[0]?.score ?? 0,
    }));

    // Sort by wrist x-position
    handData.sort((a, b) => {
      const aX = a.landmarks[HAND_LANDMARKS.WRIST].x;
      const bX = b.landmarks[HAND_LANDMARKS.WRIST].x;
      return aX - bX;
    });

    // Create DetectionResults
    return handData.map((hand, sortedIndex) => {
      const id = sortedIndex === 0 ? 'A' : 'B';
      const side = sortedIndex === 0 ? 'left' : 'right';
      const tipLandmark = hand.landmarks[HAND_LANDMARKS.INDEX_FINGER_TIP];
      
      const tip: TipPosition = {
        x: tipLandmark.x,
        y: tipLandmark.y,
        z: tipLandmark.z,
        confidence: tipLandmark.visibility,
        timestamp,
        side,
      };

      return {
        id,
        side,
        tip,
        landmarks: hand.landmarks,
        handedness: hand.handedness,
      };
    });
  } catch (error) {
    console.error('Hand detection failed:', error);
    return [];
  }
}

/**
 * Convert MediaPipe landmark to our Landmark interface
 * Hands don't have visibility, so we set it to 1 (fully visible)
 */
function convertToLandmark(lm: any): Landmark {
  return {
    x: lm.x ?? 0,
    y: lm.y ?? 0,
    z: lm.z ?? 0,
    // MediaPipe Hands returns visibility: 0 for all landmarks, so treat 0 as "no visibility data"
    visibility: (lm.visibility && lm.visibility > 0) ? lm.visibility : 1,
  };
}

/**
 * Check if detector is ready
 */
export function isHandDetectorReady(): boolean {
  return handLandmarker !== null;
}

/**
 * Reset/detach the detector
 */
export function resetHandDetector(): void {
  handLandmarker = null;
}

/**
 * Get hand landmarks for a specific hand from detection results
 * Useful for debug rendering
 */
export function getHandLandmarks(results: DetectionResult[], handId: string): Landmark[] | null {
  const hand = results.find(r => r.id === handId);
  return hand?.landmarks ?? null;
}

/**
 * Get wrist and index finger MCP for vector rendering (debug mode)
 */
export function getHandVectorPoints(landmarks: Landmark[]): { wrist: Landmark; indexMcp: Landmark; tip: Landmark } | null {
  if (!landmarks || landmarks.length < 9) return null;
  
  return {
    wrist: landmarks[HAND_LANDMARKS.WRIST],
    indexMcp: landmarks[HAND_LANDMARKS.INDEX_FINGER_MCP],
    tip: landmarks[HAND_LANDMARKS.INDEX_FINGER_TIP],
  };
}
