// Two-way binding between form controls and the app state store, driven by data attributes
// rendered by RangeControl.astro and SelectControl.astro.

import type { AppState } from '../app/state';
import { appState } from './app';
import { queryAll } from './dom';

export type NumericStateKey = {
  [K in keyof AppState]: AppState[K] extends number ? K : never;
}[keyof AppState];

export type StringStateKey = {
  [K in keyof AppState]: AppState[K] extends string ? K : never;
}[keyof AppState];

/** Bind every `input[type=range][data-state-key]`: slider value = state value * data-scale. */
export function bindRangeControls(root: ParentNode = document): void {
  for (const input of queryAll<HTMLInputElement>('input[type="range"][data-state-key]', root)) {
    const key = input.dataset.stateKey as NumericStateKey;
    const scale = Number(input.dataset.scale ?? '1') || 1;
    const decimals = Number(input.dataset.decimals ?? '0');
    const output = input.dataset.valueTarget ? document.getElementById(input.dataset.valueTarget) : null;

    const show = (sliderValue: number) => {
      if (output) output.textContent = sliderValue.toFixed(decimals);
    };
    const render = (stateValue: number) => {
      const sliderValue = Math.round(stateValue * scale * 1e6) / 1e6;
      input.value = String(sliderValue);
      show(sliderValue);
    };

    render(appState.get()[key]);
    input.addEventListener('input', () => {
      const sliderValue = Number.parseFloat(input.value);
      if (!Number.isFinite(sliderValue)) return;
      show(sliderValue);
      appState.update({ [key]: sliderValue / scale } as Partial<AppState>);
    });
    appState.on(key, (value) => render(value as number));
  }
}

/** Bind every `select[data-state-key]` to a string state value. */
export function bindSelectControls(root: ParentNode = document): void {
  for (const select of queryAll<HTMLSelectElement>('select[data-state-key]', root)) {
    const key = select.dataset.stateKey as StringStateKey;
    select.value = String(appState.get()[key]);
    select.addEventListener('change', () => {
      appState.update({ [key]: select.value } as Partial<AppState>);
    });
    appState.on(key, (value) => {
      select.value = String(value);
    });
  }
}
