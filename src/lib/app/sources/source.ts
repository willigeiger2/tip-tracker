// Video Source
// Abstraction over "where the pixels come from". The main loop and the renderers only talk to
// this interface; the camera and (from step 2) URL/HLS playback implement it.

export type SourceKind = 'camera' | 'video';

/** How the video fills the viewport. Determines CSS object-fit and coordinate mapping. */
export type FitMode = 'cover' | 'contain';

export interface VideoSource {
  readonly kind: SourceKind;

  /**
   * Selfie view: the video and overlay are flipped horizontally so the user sees a mirror.
   * Recorded footage must not be mirrored.
   */
  readonly mirrored: boolean;

  /** Camera fills the viewport (cover); recorded video shows the whole frame (contain). */
  readonly fit: FitMode;

  /** Bind the source to the video element and start playback. Rejects on failure. */
  attach(video: HTMLVideoElement): Promise<void>;

  /** Stop playback and release the source. Safe to call when not attached. */
  detach(): void;

  isAttached(): boolean;

  /**
   * True when frames are advancing and inference should run on the current frame.
   * Sources that can pause or seek return false while paused/seeking.
   */
  isPlaying(): boolean;
}
