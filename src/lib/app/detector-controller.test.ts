import { describe, expect, it, vi } from 'vitest';
import { DetectorController, numTargetsFor, DETECTION_CONFIDENCE } from './detector-controller';

function setup(options: { failInit?: boolean; attached?: boolean } = {}) {
  const init = vi.fn(async () => {
    if (options.failInit) throw new Error('boom');
  });
  const reset = vi.fn(async () => {});
  const onStatus = vi.fn();
  const onSwitchStart = vi.fn();
  const controller = new DetectorController({
    backend: { init, reset },
    onStatus,
    isSourceAttached: () => options.attached ?? false,
    onSwitchStart,
  });
  return { controller, init, reset, onStatus, onSwitchStart };
}

describe('numTargetsFor', () => {
  it('all live modes track up to two targets', () => {
    expect(numTargetsFor('pose')).toBe(2);
    expect(numTargetsFor('hand')).toBe(2);
    expect(numTargetsFor('fencers')).toBe(2);
  });
});

describe('DetectorController.load', () => {
  it('initializes the backend with the pre-refactor options and becomes ready', async () => {
    const { controller, init, onStatus } = setup({ attached: true });
    expect(controller.isReady()).toBe(false);

    await controller.load('hand');

    expect(init).toHaveBeenCalledWith('hand', {
      numTargets: 2,
      minDetectionConfidence: DETECTION_CONFIDENCE,
      minPresenceConfidence: DETECTION_CONFIDENCE,
      minTrackingConfidence: DETECTION_CONFIDENCE,
    });
    expect(controller.isReady()).toBe(true);
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(['Loading hand model...', 'Running']);
  });

  it('reports "Ready - start camera" when no source is attached', async () => {
    const { controller, onStatus } = setup({ attached: false });
    await controller.load('pose');
    expect(onStatus).toHaveBeenLastCalledWith('Ready - start camera');
  });

  it('reports failure and stays not ready if the model fails to load', async () => {
    const { controller, onStatus } = setup({ failInit: true });
    await controller.load('hand');
    expect(controller.isReady()).toBe(false);
    expect(onStatus).toHaveBeenLastCalledWith('Model failed to load');
  });

  it('recorded mode skips detector init and becomes ready immediately', async () => {
    const { controller, init, onStatus } = setup({ attached: true });
    await controller.load('recorded');
    expect(init).not.toHaveBeenCalled();
    expect(controller.isReady()).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith('Recorded mode');
  });
});

describe('DetectorController.switchTo', () => {
  it('resets, notifies, reloads, and clears the switching flag', async () => {
    const { controller, init, reset, onSwitchStart } = setup();
    await controller.load('hand');

    const p = controller.switchTo('pose');
    expect(controller.isSwitching()).toBe(true);
    expect(controller.isReady()).toBe(false);
    await p;

    expect(reset).toHaveBeenCalledTimes(1);
    expect(onSwitchStart).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenLastCalledWith('pose', expect.objectContaining({ numTargets: 2 }));
    expect(controller.isSwitching()).toBe(false);
    expect(controller.isReady()).toBe(true);
  });

  it('orders reset before onSwitchStart before init', async () => {
    const order: string[] = [];
    const controller = new DetectorController({
      backend: {
        init: async () => { order.push('init'); },
        reset: async () => { order.push('reset'); },
      },
      onStatus: () => {},
      isSourceAttached: () => true,
      onSwitchStart: () => { order.push('switchStart'); },
    });
    await controller.switchTo('pose');
    expect(order).toEqual(['reset', 'switchStart', 'init']);
  });
});
