/**
 * Hotfix v0.2.2 — the steps of a long command (`retake sandbox up --build`): a live line on a terminal, time-stamped
 * lines otherwise, and the time of each step at the end.
 */
import { describe, expect, it } from 'vitest';
import { STARTING_LINE } from '../../sandbox/src/compose.js';
import { StepDisplay } from '../src/steps.js';
import { Ui } from '../src/ui.js';

function display(interactive: boolean) {
  const err: string[] = [];
  let t = Date.UTC(2026, 0, 1, 10, 0, 0);
  const ui = new Ui({ out: () => undefined, err: (s) => err.push(s), interactive, canPrompt: false, color: false });
  const steps = new StepDisplay(
    ui,
    () => t,
    () => 60,
  );
  return { err, steps, wait: (ms: number) => (t += ms) };
}

describe('StepDisplay', () => {
  it('not a terminal: a time-stamped line when each step starts and ends; notes are not printed; the summary times each step', () => {
    const { err, steps, wait } = display(false);
    steps.step('build', 'docker compose build');
    steps.note('#12 [api 5/9] RUN pnpm install');
    wait(182_000);
    steps.step('start', 'every service running and healthy, up to 120 s');
    wait(41_000);
    steps.close();
    const lines = err.join('').split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^ {2}\d\d:\d\d:\d\d {2}build — docker compose build$/);
    expect(lines[1]).toMatch(/^ {2}\d\d:\d\d:\d\d {2}build done \(3 m 02 s\)$/);
    expect(lines[3]).toMatch(/start done \(41\.0 s\)$/);
    expect(err.join('')).not.toContain('pnpm install');
    expect(steps.summary()).toBe('build 3 m 02 s · start 41.0 s');
    expect(steps.times()).toEqual([
      { name: 'build', ms: 182_000 },
      { name: 'start', ms: 41_000 },
    ]);
  });

  it('a terminal: one live line (the step, its time, the last note, cut to the width), replaced by a ✓ line; a failed step gets ✗', () => {
    const { err, steps, wait } = display(true);
    steps.step('build', 'docker compose build');
    expect(err.join('')).toMatch(/[⠋-⠿] build · 0 ms · docker compose build/);
    steps.note(`#12 [api 5/9] RUN pnpm install ${'x'.repeat(200)}`);
    wait(5_000);
    steps.step('start');
    const out = err.join('');
    expect(out).toContain('\r\x1b[2K');
    expect(out).toContain('  ✓ build  5.0 s\n');
    for (const line of out.split(/\n|\r\x1b\[2K/)) expect(line.length).toBeLessThanOrEqual(60);
    steps.close(false);
    expect(err.join('')).toContain('  ✗ start  0 ms\n');
    expect(steps.summary()).toBe('build 5.0 s · start 0 ms');
  });
});

describe('docker compose up --build: where the build ends', () => {
  it('a network, volume or container line starts the start step; image and BuildKit lines do not', () => {
    for (const l of [
      ' Container shop-sandbox-api-1 Creating ',
      ' Network shop-sandbox_default Created',
      ' Container shop-sandbox-db-1 Healthy ',
      ' ✔ Container shop-api-1  Started',
      ' Volume shop_pgdata Creating',
    ]) {
      expect(STARTING_LINE.test(l), l).toBe(true);
    }
    for (const l of [' Image shop-sandbox-api:1 Building ', '#12 [api 5/9] RUN pnpm install', ' Image shop-sandbox-api:1 Built ', '#3 [api internal] load build definition from Dockerfile', '']) {
      expect(STARTING_LINE.test(l), l).toBe(false);
    }
  });
});
