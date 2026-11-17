/**
 * The live screen of an iOS take (src/app/shoot/live-controls.tsx, ShootLive.tsx): Pause is disabled with its reason
 * (an iOS take runs to its end; Stop still stops it) and there is no live picture to switch on.
 */
import { describe, expect, it } from 'vitest';
import { pauseBlocker } from '../src/app/shoot/live-controls.js';
import { DEVICE_PICTURE_NOTE, deviceRun } from '../src/app/shoot/ShootLive.js';

describe('the live screen of an iOS take', () => {
  it("the run's environment is an iOS one when the project says so", () => {
    const envs = [{ name: 'web' }, { name: 'simulator', ios: { device: 'iPhone 17 Pro' } }];
    expect(deviceRun(envs, 'simulator')).toBe(true);
    expect(deviceRun(envs, 'web')).toBe(false);
    expect(deviceRun(envs, undefined)).toBe(false);
    expect(deviceRun(null, 'simulator')).toBe(false);
  });

  it('Pause is blocked with its reason; a web run that runs can pause', () => {
    expect(pauseBlocker({ terminal: false, jobState: 'running', stopping: false, device: true })).toMatch(/An iOS take cannot pause/);
    expect(pauseBlocker({ terminal: false, jobState: 'running', stopping: false, device: false })).toBeNull();
    expect(pauseBlocker({ terminal: false, jobState: 'queued', stopping: false, device: false })).toMatch(/once it runs/);
    expect(pauseBlocker({ terminal: true, jobState: undefined, stopping: false, device: true })).toMatch(/terminal/);
    expect(DEVICE_PICTURE_NOTE).toMatch(/No live picture of an iOS take/);
  });
});
