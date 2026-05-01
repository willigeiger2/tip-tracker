// MediaPipe Pose Detector Module
// Handles initialization and pose detection using MediaPipe Tasks Vision

import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import type { Pose, Landmark } from '../types/fencing';

let poseLandmarker: PoseLandmarker | null = null;
let isInitializing = false;

// MediaPipe landmark indices
export const LANDMARKS = {
  NOSE: 0,
  LEFT_EYE: 2,
  RIGHT_EYE: 5,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
} as const;

// Pose skeleton connections for debug rendering
// Based on MediaPipe Pose topology: https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
export const POSE_CONNECTIONS: [number, number][] = [
  // Face (simplified - just key connections)
  [0, 1], [0, 4], [1, 2], [2, 3], [3, 7], [4, 5], [5, 6], [6, 8],
  [9, 10], // mouth
  // Torso
  [11, 12], // shoulders
  [11, 23], // left shoulder to left hip
  [12, 24], // right shoulder to right hip
  [23, 24], // hips
  // Arms
  [11, 13], [13, 15], // left arm
  [12, 14], [14, 16], // right arm
  // Hands
  [15, 17], [15, 19], [15, 21], // left hand
  [16, 18], [16, 20], [16, 22], // right hand
  // Legs
  [23, 25], [25, 27], [27, 29], [29, 31], // left leg
  [24, 26], [26, 28], [28, 30], [30, 32], // right leg
];

/**
 * Initialize the MediaPipe Pose Landmarker
 * Loads models from CDN (~8MB first time, cached subsequently)
 */
export async function initPoseDetector(
  numPoses: number = 2,
  minPoseDetectionConfidence: number = 0.5,
  minPosePresenceConfidence: number = 0.5,
  minTrackingConfidence: number = 0.5
): Promise<PoseLandmarker> {
  if (poseLandmarker) {
    return poseLandmarker;
  }

  if (isInitializing) {
    // Wait for initialization to complete
    while (isInitializing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (poseLandmarker) {
      return poseLandmarker;
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

    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
        delegate: isFirefox ? 'CPU' : 'GPU'
      },
      runningMode: 'VIDEO',
      numPoses: numPoses,
      minPoseDetectionConfidence: minPoseDetectionConfidence,
      minPosePresenceConfidence: minPosePresenceConfidence,
      minTrackingConfidence: minTrackingConfidence,
    });

    console.log('MediaPipe Pose Landmarker initialized');
    return poseLandmarker;
  } catch (error) {
    console.error('Failed to initialize MediaPipe Pose Landmarker:', error);
    throw error;
  } finally {
    isInitializing = false;
  }
}

/**
 * Detect poses in a video frame
 * Returns array of poses with landmarks
 */
export async function detectPose(
  video: HTMLVideoElement,
  timestamp: number = performance.now()
): Promise<Pose[]> {
  if (!poseLandmarker) {
    throw new Error('Pose detector not initialized. Call initPoseDetector() first.');
  }

  try {
    const results = poseLandmarker.detectForVideo(video, timestamp);
    
    if (!results.landmarks || results.landmarks.length === 0) {
      return [];
    }

    return results.landmarks.map((landmarks, index) => {
      const worldLandmarks = results.worldLandmarks?.[index] || landmarks;
      
      return {
        landmarks: landmarks.map(convertToLandmark),
        worldLandmarks: worldLandmarks.map(convertToLandmark),
        score: calculatePoseScore(landmarks),
      };
    });
  } catch (error) {
    console.error('Pose detection failed:', error);
    return [];
  }
}

/**
 * Convert MediaPipe landmark to our Landmark interface
 */
function convertToLandmark(lm: any): Landmark {
  return {
    x: lm.x ?? 0,
    y: lm.y ?? 0,
    z: lm.z ?? 0,
    visibility: lm.visibility ?? 1, // Default to visible if not provided
  };
}

/**
 * Calculate overall pose confidence score
 */
function calculatePoseScore(landmarks: any[]): number {
  if (!landmarks || landmarks.length === 0) return 0;
  
  const sum = landmarks.reduce((acc, lm) => acc + (lm.visibility ?? 0), 0);
  return sum / landmarks.length;
}

/**
 * Check if detector is ready
 */
export function isDetectorReady(): boolean {
  return poseLandmarker !== null;
}

/**
 * Reset/detach the detector
 */
export function resetDetector(): void {
  poseLandmarker = null;
}
