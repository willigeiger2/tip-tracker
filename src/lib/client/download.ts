/**
 * Trigger a browser download of `text` as a JSON file. The anchor is never attached to the
 * document, so its synthetic click doesn't bubble to page-level click handlers (which would
 * otherwise collapse the controls panel).
 */
export function downloadJson(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
