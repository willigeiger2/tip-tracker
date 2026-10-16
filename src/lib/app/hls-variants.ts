// HLS master-manifest variant parsing: pick the highest-resolution rendition (used by MP4 export,
// which needs native resolution regardless of the player's adaptive bitrate choice).

export interface HlsVariant {
  uri: string;
  width: number;
  height: number;
  bandwidth: number;
}

/** Parse `#EXT-X-STREAM-INF` entries (attributes + following URI line), resolving relative URIs. */
export function parseHlsVariants(manifestText: string, manifestUrl: string): HlsVariant[] {
  const lines = manifestText.split(/\r?\n/).map((l) => l.trim());
  const variants: HlsVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = lines[i].slice('#EXT-X-STREAM-INF:'.length);
    const resolution = /(?:^|,)RESOLUTION=(\d+)x(\d+)/i.exec(attrs);
    const bandwidth = /(?:^|,)BANDWIDTH=(\d+)/i.exec(attrs);
    let j = i + 1;
    while (j < lines.length && (lines[j] === '' || lines[j].startsWith('#'))) j++;
    if (j >= lines.length) break;
    let uri: string;
    try {
      uri = new URL(lines[j], manifestUrl).toString();
    } catch {
      continue;
    }
    variants.push({
      uri,
      width: resolution ? Number(resolution[1]) : 0,
      height: resolution ? Number(resolution[2]) : 0,
      bandwidth: bandwidth ? Number(bandwidth[1]) : 0,
    });
    i = j;
  }
  return variants;
}

/** Highest resolution first, then highest bandwidth. */
export function bestHlsVariant(variants: readonly HlsVariant[]): HlsVariant | null {
  return (
    [...variants].sort((a, b) => b.width * b.height - a.width * a.height || b.bandwidth - a.bandwidth)[0] ?? null
  );
}
