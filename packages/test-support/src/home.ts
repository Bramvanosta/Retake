/**
 * A test's own RETAKE_HOME, put back afterwards. vitest.config.ts gives the whole run one scratch home (never the
 * person's ~/.retake) and every test file starts on it; a test that needs a home of its own — its workspace's `.home`,
 * a folder it removes, a link — points RETAKE_HOME there with this helper, which saves the value it found and puts it
 * back on `restore()` (unset again when it was unset). The helper makes no folder and chooses no path: the test's
 * isolation is the path it names, as before; the helper only owns the save and the restore.
 */

/** RETAKE_HOME (and the other variables named) as found when it was made; `use` points the home elsewhere. */
export interface ScratchHome {
  /** Points RETAKE_HOME at `dir` and answers `dir`. */
  use(dir: string): string;
  /** Puts back every variable as it was when the helper was made (deleted when it was unset). */
  restore(): void;
}

/**
 * Saves RETAKE_HOME — and `others`, variables a test changes beside it (RETAKE_AUTHOR, TMPDIR…) — now. Made where a
 * test file used to keep `const savedHome = process.env.RETAKE_HOME` (at the top of the file or of a case), restored
 * where it used to put it back (an afterAll, an afterEach, a `finally`).
 */
export function scratchHome(...others: string[]): ScratchHome {
  const names = ['RETAKE_HOME', ...others.filter((n) => n !== 'RETAKE_HOME')];
  const saved = new Map(names.map((n) => [n, process.env[n]] as const));
  return {
    use(dir) {
      process.env.RETAKE_HOME = dir;
      return dir;
    },
    restore() {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

/** Runs `fn` with RETAKE_HOME at `dir` and puts the home back after it, also when it throws. */
export async function withHome<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const home = scratchHome();
  home.use(dir);
  try {
    return await fn();
  } finally {
    home.restore();
  }
}
