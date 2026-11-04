/**
 * vitest globalSetup (L5.13a reviews A L5 / B L4): at the end of a run, remove the temp RETAKE_HOME vitest.config.ts
 * made (RETAKE_TEST_HOME_MADE) — only a `retake-test-home-*` folder directly in the temp folder, never a home the shell
 * named. L5.16c fixes: likewise the scratch CFFIXED_USER_HOME it made (RETAKE_TEST_CFHOME_MADE, `retake-test-cfhome-*`).
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export default function setup() {
  return () => {
    const drop = (made, current, prefix) => {
      if (!made || current !== made) return;
      if (resolve(dirname(made)) !== resolve(tmpdir()) || !basename(made).startsWith(prefix)) return;
      rmSync(made, { recursive: true, force: true });
    };
    drop(process.env.RETAKE_TEST_HOME_MADE, process.env.RETAKE_HOME, 'retake-test-home-');
    drop(process.env.RETAKE_TEST_CFHOME_MADE, process.env.CFFIXED_USER_HOME, 'retake-test-cfhome-');
  };
}
