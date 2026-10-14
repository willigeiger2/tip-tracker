// Keyboard shortcuts for video mode: transport (space, arrows, Home/End) and keyframe editing.

import { appState, isVideoSource } from './app';
import { deleteActiveKeyframeAtCurrentFrame, isEditorActive, jumpNeighborKeyframe } from './recorded';
import { seekSeconds, seekToEnd, seekToStart, stepFrames, togglePlay } from './transport';

function shouldIgnore(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase();
    return type !== 'range' && type !== 'button' && type !== 'checkbox' && type !== 'radio';
  }
  return target.getAttribute('contenteditable') === 'true';
}

export function installShortcuts(): void {
  document.addEventListener('keydown', (e) => {
    if (!isVideoSource()) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (shouldIgnore(e.target)) return;

    if (appState.get().trackingMode === 'recorded') {
      if (e.key === '[' || e.key === ',' || e.key === 'PageUp') {
        e.preventDefault();
        jumpNeighborKeyframe(-1);
        return;
      }
      if (e.key === ']' || e.key === '.' || e.key === 'PageDown') {
        e.preventDefault();
        jumpNeighborKeyframe(1);
        return;
      }
    }

    if (isEditorActive() && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      deleteActiveKeyframeAtCurrentFrame();
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        void togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) seekSeconds(-1);
        else stepFrames(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) seekSeconds(1);
        else stepFrames(1);
        break;
      case 'Home':
        e.preventDefault();
        seekToStart();
        break;
      case 'End':
        if (seekToEnd()) e.preventDefault();
        break;
      default:
        break;
    }
  });
}
