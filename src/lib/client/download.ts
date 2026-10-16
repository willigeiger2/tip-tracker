/**
 * Trigger a browser download of a blob. The anchor is never attached to the document, so its
 * synthetic click doesn't bubble to page-level click handlers (which would otherwise collapse
 * the controls panel). The object URL is kept alive briefly so large files finish starting.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** Trigger a browser download of `text` as a JSON file. */
export function downloadJson(text: string, filename: string): void {
  downloadBlob(new Blob([text], { type: 'application/json' }), filename);
}
