// URL Video Source
// Plays an HLS or MP4 URL in the existing <video> element.

import type { VideoSource } from './source';

const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

export class UnsupportedVideoSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedVideoSourceError';
  }
}

export function isHlsUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('.m3u8') || lower.includes('application/vnd.apple.mpegurl');
}

export function canPlayNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType(HLS_MIME_TYPE) !== '';
}

export class UrlSource implements VideoSource {
  readonly kind = 'video' as const;
  readonly mirrored = false;
  readonly fit = 'contain' as const;

  private video: HTMLVideoElement | null = null;
  private url = '';

  setUrl(url: string): void {
    this.url = url.trim();
  }

  getUrl(): string {
    return this.url;
  }

  async attach(video: HTMLVideoElement): Promise<void> {
    if (!this.url) {
      throw new UnsupportedVideoSourceError('Paste a video URL first');
    }

    if (isHlsUrl(this.url) && !canPlayNativeHls(video)) {
      throw new UnsupportedVideoSourceError(
        'This browser does not support native HLS playback. Use Chrome or Safari for .m3u8.'
      );
    }

    this.detach();

    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.srcObject = null;
    video.src = this.url;

    await video.play();
    this.video = video;
  }

  detach(): void {
    if (!this.video) return;

    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video = null;
  }

  isAttached(): boolean {
    return this.video !== null;
  }

  isPlaying(): boolean {
    if (!this.video) return false;

    return (
      !this.video.paused &&
      !this.video.ended &&
      !this.video.seeking &&
      this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    );
  }
}
