// Camera Source
// Live webcam via getUserMedia. Mirrored (selfie view) and cover-fit, as the app has always been.

import type { VideoSource } from './source';

export const DEFAULT_CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    facingMode: 'user',
  },
  audio: false,
};

export class CameraSource implements VideoSource {
  readonly kind = 'camera' as const;
  readonly mirrored = true;
  readonly fit = 'cover' as const;

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;

  constructor(private readonly constraints: MediaStreamConstraints = DEFAULT_CAMERA_CONSTRAINTS) {}

  async attach(video: HTMLVideoElement): Promise<void> {
    if (this.stream) return;

    const stream = await navigator.mediaDevices.getUserMedia(this.constraints);
    video.srcObject = stream;
    await video.play();

    this.stream = stream;
    this.video = video;
  }

  detach(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }
    if (this.video) {
      this.video.srcObject = null;
    }
    this.stream = null;
    this.video = null;
  }

  isAttached(): boolean {
    return this.stream !== null;
  }

  /** A live stream has no pause/seek; it is "playing" once the element has current frame data. */
  isPlaying(): boolean {
    return this.video !== null && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }
}
