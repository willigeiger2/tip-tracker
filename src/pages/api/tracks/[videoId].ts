import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
  InvalidTrackSetError,
  MAX_TRACK_SET_BYTES,
  getTrackSet,
  putTrackSet,
} from '../../../lib/recorded/kv-repository';

export const prerender = false;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function requestTooLarge(request: Request): boolean {
  const header = request.headers.get('content-length');
  if (!header) return false;
  const parsed = Number.parseInt(header, 10);
  return Number.isFinite(parsed) && parsed > MAX_TRACK_SET_BYTES;
}

function parseVideoId(params: { videoId?: string }): string | null {
  const raw = params.videoId?.trim();
  if (!raw) return null;
  return raw;
}

export const GET: APIRoute = async ({ params }) => {
  if (!env.TRACKS) {
    return json({ ok: false, error: 'missing_binding', message: 'TRACKS binding is not configured.' }, 500);
  }

  const videoId = parseVideoId(params);
  if (!videoId) {
    return json({ ok: false, error: 'invalid_video_id', message: 'Missing videoId path parameter.' }, 400);
  }

  try {
    const trackSet = await getTrackSet(env.TRACKS, videoId);
    if (!trackSet) {
      return json({ ok: false, error: 'not_found', message: `No track set found for ${videoId}.` }, 404);
    }
    return json({ ok: true, trackSet });
  } catch (error) {
    return json(
      {
        ok: false,
        error: 'read_failed',
        message: error instanceof Error ? error.message : 'Failed to read track set.',
      },
      500
    );
  }
};

export const PUT: APIRoute = async ({ request, params }) => {
  if (!env.TRACKS) {
    return json({ ok: false, error: 'missing_binding', message: 'TRACKS binding is not configured.' }, 500);
  }

  const videoId = parseVideoId(params);
  if (!videoId) {
    return json({ ok: false, error: 'invalid_video_id', message: 'Missing videoId path parameter.' }, 400);
  }

  if (requestTooLarge(request)) {
    return json({ ok: false, error: 'payload_too_large', message: 'Payload exceeds 1 MB limit.' }, 413);
  }

  const bodyText = await request.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_TRACK_SET_BYTES) {
    return json({ ok: false, error: 'payload_too_large', message: 'Payload exceeds 1 MB limit.' }, 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return json({ ok: false, error: 'invalid_json', message: 'Request body must be valid JSON.' }, 400);
  }

  try {
    const { trackSet, summary } = await putTrackSet(env.TRACKS, videoId, payload);
    return json({ ok: true, trackSet, summary });
  } catch (error) {
    if (error instanceof InvalidTrackSetError) {
      return json({ ok: false, error: 'invalid_payload', message: error.message }, 400);
    }

    return json(
      {
        ok: false,
        error: 'write_failed',
        message: error instanceof Error ? error.message : 'Failed to write track set.',
      },
      500
    );
  }
};
