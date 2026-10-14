import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { listTrackSummaries } from '../../../lib/recorded/kv-repository';

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

export const GET: APIRoute = async () => {
  if (!env.TRACKS) {
    return json({ ok: false, error: 'missing_binding', message: 'TRACKS binding is not configured.' }, 500);
  }

  try {
    const summaries = await listTrackSummaries(env.TRACKS);
    return json({ ok: true, summaries });
  } catch (error) {
    return json(
      {
        ok: false,
        error: 'list_failed',
        message: error instanceof Error ? error.message : 'Failed to list track summaries.',
      },
      500
    );
  }
};
