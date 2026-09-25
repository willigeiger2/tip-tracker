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

function fallbackOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
}

function fallbackHref(): string {
  return typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
}

export function isCrossOriginUrl(
  url: string,
  currentOrigin = fallbackOrigin(),
  currentHref = fallbackHref()
): boolean {
  try {
    return new URL(url, currentHref).origin !== currentOrigin;
  } catch {
    return false;
  }
}

async function hasCorsAccess(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      mode: 'cors',
      cache: 'no-store',
    });

    // Some origins don't support HEAD but do include ACAO. In that case, keep the error generic.
    if (response.status === 405) return true;
    return response.ok;
  } catch {
    return false;
  }
}

function isNotAllowedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'NotAllowedError'
  );
}

function isNotSupportedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'NotSupportedError'
  );
}

async function waitForVideoLoad(video: HTMLVideoElement, timeoutMs = 10000): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return;

  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => cleanup(resolve);
    const onError = () => {
      const code = video.error?.code;
      cleanup(() =>
        reject(new UnsupportedVideoSourceError(`Video failed to load (media error code ${code ?? 'unknown'})`))
      );
    };
    const onTimeout = () =>
      cleanup(() => reject(new UnsupportedVideoSourceError('Timed out while loading video metadata')));

    const cleanup = (done: () => void) => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('canplay', onLoaded);
      video.removeEventListener('error', onError);
      clearTimeout(timeoutId);
      done();
    };

    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('canplay', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    const timeoutId = window.setTimeout(onTimeout, timeoutMs);
  });
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

    const isCrossOrigin = isCrossOriginUrl(this.url);

    this.detach();

    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.srcObject = null;
    video.src = this.url;
    video.load();

    // iOS often needs metadata to land before controls and playback state are reliable.
    await waitForVideoLoad(video);

    this.video = video;

    try {
      await video.play();
    } catch (error) {
      // iOS/Safari can block autoplay despite muted playback. In that case the source is loaded;
      // user can tap Play in native controls.
      if (isNotAllowedError(error)) {
        return;
      }

      if (isCrossOrigin && isNotSupportedError(error)) {
        const corsOk = await hasCorsAccess(this.url);
        if (!corsOk) {
          throw new UnsupportedVideoSourceError(
            'This video URL likely blocks cross-origin access (missing Access-Control-Allow-Origin). ' +
              'Tip Track needs CORS-enabled video for inference. Use a Stream URL or enable CORS on the MP4 origin.'
          );
        }
      }

      throw error;
    }
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
