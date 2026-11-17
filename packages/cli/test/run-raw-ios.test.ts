/**
 * `retake run --raw --cursor layer` on an iOS environment: refused before the take (a device's touches are drawn by
 * its runner, there is no cursor layer to export) — no run folder made, the other cursor modes named. Its app is a
 * build that is not there: were the refusal gone, the take would stop at the app's check, never reaching a simulator.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT, main, memoryIo } from '../src/index.js';

const root = mkdtempSync(join(tmpdir(), 'retake-run-raw-ios-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('retake run --raw on an iOS environment', () => {
  it('--cursor layer is refused before anything runs', async () => {
    const dir = join(root, 'projects', 'buyer');
    mkdirSync(join(dir, 'scenarios'), { recursive: true });
    writeFileSync(join(root, 'retake.yaml'), 'projects_dir: projects\n');
    writeFileSync(join(dir, 'project.yaml'), 'name: Buyer\nenvironments:\n  simulator:\n    ios: {app: build/Buyer.app, device: iPhone 17 Pro, schemes: [northfield]}\n');
    writeFileSync(join(dir, 'scenarios', 'quote.yaml'), 'version: 1\nvideo: quote\nscenes:\n  - id: a\n    open: "northfield://quote"\n    steps:\n      - wait: 0.2\n');
    const io = memoryIo();
    const code = await main(['node', 'retake', '--root', root, 'run', 'buyer', 'quote', '--raw', '--cursor', 'layer'], io);
    expect(code).toBe(EXIT.failure);
    expect(io.stderr()).toContain('--raw --cursor layer: environment simulator films the iOS Simulator, whose touches have no cursor layer');
    expect(io.stderr()).toContain('--cursor baked');
    expect(existsSync(join(dir, 'runs'))).toBe(false);
  });
});
