import { describe, expect, it, vi } from 'vitest';
import { Store, createAppState, DEFAULT_APP_STATE, detectionIntervalMs } from './state';

describe('Store', () => {
  it('starts with a copy of the initial state', () => {
    const initial = { a: 1, b: 'x' };
    const store = new Store(initial);
    expect(store.get()).toEqual(initial);
    expect(store.get()).not.toBe(initial);
  });

  it('notifies subscribers with the set of changed keys', () => {
    const store = new Store({ a: 1, b: 'x', c: true });
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ a: 2, c: true }); // c unchanged

    expect(listener).toHaveBeenCalledTimes(1);
    const [state, changed] = listener.mock.calls[0];
    expect(state).toEqual({ a: 2, b: 'x', c: true });
    expect([...changed]).toEqual(['a']);
  });

  it('does not notify when nothing changed', () => {
    const store = new Store({ a: 1 });
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ a: 1 });
    store.update({});

    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe stops notifications', () => {
    const store = new Store({ a: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.update({ a: 2 });
    unsubscribe();
    store.update({ a: 3 });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('on(key) fires only for that key, with the new value', () => {
    const store = new Store({ a: 1, b: 'x' });
    const onA = vi.fn();
    const onB = vi.fn();
    store.on('a', onA);
    store.on('b', onB);

    store.update({ a: 5 });
    store.update({ b: 'y' });
    store.update({ a: 6, b: 'z' });

    expect(onA).toHaveBeenCalledTimes(2);
    expect(onA).toHaveBeenLastCalledWith(6, { a: 6, b: 'z' });
    expect(onB).toHaveBeenCalledTimes(2);
    expect(onB).toHaveBeenLastCalledWith('z', { a: 6, b: 'z' });
  });
});

describe('createAppState', () => {
  it('uses the defaults that match the pre-refactor UI initial values', () => {
    const state = createAppState().get();
    expect(state).toEqual(DEFAULT_APP_STATE);
    expect(state.trackingMode).toBe('hand');
    expect(state.debugMode).toBe('none');
    expect(state.inferenceFps).toBe(15);
    expect(state.trailLength).toBe(30);
    expect(state.poseTipExtension).toBe(3.0);
  });

  it('accepts overrides', () => {
    expect(createAppState({ trackingMode: 'pose' }).get().trackingMode).toBe('pose');
  });
});

describe('detectionIntervalMs', () => {
  it('converts fps to a millisecond interval', () => {
    expect(detectionIntervalMs(15)).toBeCloseTo(66.667, 3);
    expect(detectionIntervalMs(30)).toBeCloseTo(33.333, 3);
    expect(detectionIntervalMs(5)).toBe(200);
  });
});
