/**
 * The command's link read while it changes (app-setup.ts cliLinkState): a link removed, or replaced by a file, between
 * the lstat and the readlink answers what is there now — never a throw (the supervised server reads it on every
 * window focus of the desktop app). readlinkSync is made to fail as the race would.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const fail = vi.hoisted(() => ({ code: null as string | null, then: null as null | (() => void) }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    readlinkSync: (...a: Parameters<typeof real.readlinkSync>) => {
      if (fail.code) {
        fail.then?.();
        throw Object.assign(new Error(`${fail.code}: readlink`), { code: fail.code });
      }
      return real.readlinkSync(...a);
    },
  };
});

const { cliLinkState } = await import('../src/integrations/app-setup.js');
const dir = mkdtempSync(join(tmpdir(), 'cli-link-race-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the command link read during a change', () => {
  it('a link gone or no longer a link between lstat and readlink: absent, or what is there now; any other error still throws', () => {
    const link = join(dir, 'retake');
    symlinkSync('/nowhere/retake', link);
    fail.code = 'ENOENT';
    fail.then = () => rmSync(link);
    expect(cliLinkState(link, '/app/bin/retake')).toEqual({ state: 'absent' });
    symlinkSync('/nowhere/retake', link);
    fail.code = 'EINVAL';
    fail.then = () => {
      rmSync(link);
      writeFileSync(link, '#!/bin/sh\n');
    };
    expect(cliLinkState(link, '/app/bin/retake')).toEqual({ state: 'foreign', what: 'file' });
    rmSync(link);
    symlinkSync('/nowhere/retake', link);
    fail.code = 'EACCES';
    fail.then = null;
    expect(() => cliLinkState(link, '/app/bin/retake')).toThrow(/EACCES/);
    fail.code = null;
    expect(cliLinkState(link, '/app/bin/retake')).toMatchObject({ state: 'foreign', what: 'link' });
  });
});
