/** m:ss.s for media times. */
export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  const sec = (safe % 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${sec}`;
}

/** hh:mm:ss wall-clock time (save times, library entries). */
export function formatClockTime(timestamp = Date.now()): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
