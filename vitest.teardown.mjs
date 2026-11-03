/**
 * vitest globalSetup (L5.13a reviews A L5 / B L4): at the end of a run, remove the temp RETAKE_HOME vitest.config.ts
 * made (RETAKE_TEST_HOME_MADE) — only a `retake-test-home-*` folder directly in the temp folder, never a home the shell
 * named.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export default function setup() {
  return () => {
    const made = process.env.RETAKE_TEST_HOME_MADE;
    if (!made || process.env.RETAKE_HOME !== made) return;
    if (resolve(dirname(made)) !== resolve(tmpdir()) || !basename(made).startsWith('retake-test-home-')) return;
    rmSync(made, { recursive: true, force: true });
  };
}
