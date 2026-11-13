/**
 * The golden files of the characterization and snapshot tests (a fixture JSON a test compares its output with, byte for
 * byte or key by key). `RETAKE_WRITE_SNAPSHOTS=1` records the output as the new fixture — and then fails the test when
 * that changed the file, so that a shell which exports it can never turn a golden green whatever the code does: the
 * diff is reviewed and the test rerun without it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { REPO } from './repo.js';

/**
 * Under RETAKE_WRITE_SNAPSHOTS=1: writes `data` (a text, or the bytes of an image golden) to `file`, its folder made,
 * and throws when that changed it. Otherwise does nothing. The one switch of every golden of the tests.
 */
export function recordGolden(file: string, data: string | Buffer, env: NodeJS.ProcessEnv = process.env): void {
  if (env.RETAKE_WRITE_SNAPSHOTS !== '1') return;
  const before = existsSync(file) ? readFileSync(file) : undefined;
  if (before?.equals(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  throw new Error(`recorded ${relative(REPO, file)}${before === undefined ? ' (new)' : ''}: review the diff and rerun without RETAKE_WRITE_SNAPSHOTS`);
}
