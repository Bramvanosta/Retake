/**
 * vitest globalSetup (L5.13a reviews A L5 / B L4): at the end of a run, remove the temp RETAKE_HOME vitest.config.ts
 * made (RETAKE_TEST_HOME_MADE) — only a `retake-test-home-*` folder directly in the temp folder, never a home the shell
 * named. L5.16c fixes: likewise the scratch CFFIXED_USER_HOME it made (RETAKE_TEST_CFHOME_MADE, `retake-test-cfhome-*`);
 * L5.14: and the parent of the test files' filming-marker folders (RETAKE_TEST_CAPTURES_MADE, `retake-test-captures-*`).
 *
 * L5.16 Library hygiene: tests leave the account's ~/Library as found. Two files there are what a Chromium of ours
 * writes when a child misses the scratch CFFIXED_USER_HOME, or writes anyway: the crash reporter's settings.dat
 * (rewritten at every launch of Playwright's full Chromium; CFFIXED_USER_HOME moves it) and
 * ~/Library/Preferences/org.chromium.Chromium.plist (Chromium records the path of the Chromium.app it runs from through
 * cfprefsd, which CFFIXED_USER_HOME does not move; the file changes only when a Chromium.app at another path ran since).
 * Their modification times are taken here before the run and compared after it: a change is reported loudly — a
 * warning, not a failure, because another project's Playwright, or the person's own Chromium, writes the same files
 * and a run cannot tell those writes from its own (`RETAKE_TEST_LIBRARY=strict` makes it fail the run).
 */
import { rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** The files of the account's ~/Library a run of ours must not change (by the account's home: Chromium ignores HOME). */
export function libraryFiles(home = userInfo().homedir) {
  return [join(home, 'Library', 'Application Support', 'Chromium', 'Crashpad', 'settings.dat'), join(home, 'Library', 'Preferences', 'org.chromium.Chromium.plist')];
}

/** Modification time in ms of each file, null when it does not exist. */
export function libraryStamps(files = libraryFiles()) {
  return files.map((f) => {
    try {
      return statSync(f).mtimeMs;
    } catch {
      return null;
    }
  });
}

/** The lines of the warning for the files whose stamp changed between `before` and `after` (none: []). */
export function libraryChanges(files, before, after) {
  const when = (ms) => (ms === null ? 'absent' : new Date(ms).toISOString());
  return files.flatMap((f, i) => (before[i] === after[i] ? [] : [`  ${f}: ${when(before[i])} → ${when(after[i])}`]));
}

export default function setup() {
  const files = libraryFiles();
  const before = libraryStamps(files);
  return () => {
    const drop = (made, current, prefix) => {
      if (!made || current !== made) return;
      if (resolve(dirname(made)) !== resolve(tmpdir()) || !basename(made).startsWith(prefix)) return;
      rmSync(made, { recursive: true, force: true });
    };
    drop(process.env.RETAKE_TEST_HOME_MADE, process.env.RETAKE_HOME, 'retake-test-home-');
    drop(process.env.RETAKE_TEST_CFHOME_MADE, process.env.CFFIXED_USER_HOME, 'retake-test-cfhome-');
    drop(process.env.RETAKE_TEST_CAPTURES_MADE, process.env.RETAKE_TEST_CAPTURES, 'retake-test-captures-');
    const changed = libraryChanges(files, before, libraryStamps(files));
    if (!changed.length) return;
    const text = [
      '',
      '!!! ~/Library changed during this test run (L5.16 Library hygiene):',
      ...changed,
      '!!! A child that starts Chromium without CFFIXED_USER_HOME writes settings.dat; the plist changes when Chromium.apps',
      '!!! at two paths ran. Another project\'s Playwright, or your own Chromium, may have written them during the run too.',
      '',
    ].join('\n');
    if (process.env.RETAKE_TEST_LIBRARY === 'strict') throw new Error(text);
    process.stderr.write(`${text}\n`);
  };
}
