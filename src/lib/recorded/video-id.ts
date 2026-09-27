// Video ID
// Derives a stable id for persisted track sets.
// Prefer a Cloudflare Stream UID in the URL; otherwise hash the URL string.

const STREAM_UID_RE = /\b([0-9a-f]{32})\b/i;

export function extractStreamUid(url: string): string | null {
  const match = STREAM_UID_RE.exec(url);
  return match ? match[1].toLowerCase() : null;
}

/** 32-bit FNV-1a hash, returned as zero-padded 8-char hex. */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function deriveVideoId(url: string): string {
  const trimmed = url.trim();
  const uid = extractStreamUid(trimmed);
  if (uid) return uid;
  return `url-${hashString(trimmed)}`;
}
