import { describe, expect, it, vi } from 'vitest';
import { Emitter } from './events';

describe('Emitter', () => {
  it('delivers payloads to subscribers until they unsubscribe', () => {
    const emitter = new Emitter<{ status: string; tick: void }>();
    const onStatus = vi.fn();
    const onTick = vi.fn();
    const off = emitter.on('status', onStatus);
    emitter.on('tick', onTick);

    emitter.emit('status', 'Running');
    emitter.emit('tick');
    off();
    emitter.emit('status', 'Ignored');

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith('Running');
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('tolerates handlers unsubscribing during emit', () => {
    const emitter = new Emitter<{ ping: number }>();
    const calls: number[] = [];
    const off = emitter.on('ping', (n) => {
      calls.push(n);
      off();
    });
    emitter.on('ping', (n) => calls.push(n * 10));
    emitter.emit('ping', 1);
    emitter.emit('ping', 2);
    expect(calls).toEqual([1, 10, 20]);
  });
});
