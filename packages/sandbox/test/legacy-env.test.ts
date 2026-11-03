/**
 * old-name: this whole file (the guard test allows it).
 *
 * L5.13 (critique H2): a sandbox's process services get RETAKE_SANDBOX and, for a product's server that still switches
 * its mailer, payments or database on the name from before the rename, DEMO_STUDIO_SANDBOX — written, never read.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoadedProject, LoadedSandbox } from '@retake/core';
import { serviceEnv } from '../src/index.js';

describe('a process service under both names', () => {
  it('gets RETAKE_SANDBOX under both names, the same value', async () => {
    const tmp = tmpdir();
    const project = { slug: 'p', dir: tmp, file: join(tmp, 'project.yaml'), config: { name: 'p', environments: { sandbox: { app: 'http://localhost:4603' } } } } as unknown as LoadedProject;
    const sandbox = { env: 'sandbox', dir: tmp } as unknown as LoadedSandbox;
    const env = await serviceEnv({ project, sandbox }, { command: 'node server.mjs' } as never, { PATH: '/usr/bin', DEMO_STUDIO_SANDBOX: 'stale' });
    expect(env.RETAKE_SANDBOX).toBe('sandbox');
    expect(env.DEMO_STUDIO_SANDBOX).toBe('sandbox');
  });
});
