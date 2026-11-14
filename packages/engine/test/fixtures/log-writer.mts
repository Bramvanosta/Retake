/**
 * A separate process writing a workspace's line logs (append-log.test.ts). Usage:
 * - `log-writer.mts append <workspace> <tag> <count>`: waits for `go` on stdin, then appends `count` lines to the journal
 *   and to the history (journal paths `p/<tag>-<i>`, history jobs `<tag>-<i>`), one after the other;
 * - `log-writer.mts torn <workspace> <journal.jsonl|history.jsonl>`: takes the log's lock, writes the first half of a
 *   line (no line break) and is killed (SIGKILL) holding it — a crash mid-append;
 * - `log-writer.mts slow <workspace> <journal.jsonl|history.jsonl> <ms>`: takes the log's lock, writes the first half of
 *   a line, prints `locked`, waits `ms`, writes the rest with its line break, releases the lock and exits.
 * The half-written lines are `{"v":1,"at":"2026-01-01T00:00:00.000Z","by":…` shaped for both logs (`slow` writes a
 * whole entry of the log it is given).
 */
import { createInterface } from 'node:readline';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { appendHistory, appendJournal, systemClock } from '../../src/index.js';
import { EngineError } from '../../src/errors.js';
import { takeProjectLock } from '../../src/project-lock.js';

const [mode, root, a, b] = process.argv.slice(2) as [string, string, string, string];
const by = { client: 'test', channel: 'cli', trust: 'author' } as const;

/** The whole line `slow` writes to a log (an entry each log's reader keeps). */
function slowLine(file: string): string {
  return file === 'journal.jsonl'
    ? `${JSON.stringify({ v: 1, at: '2026-01-01T00:00:00.000Z', by, op: 'write', what: 'scenario', path: 'p/slow', outcome: 'ok' })}\n`
    : `${JSON.stringify({ v: 1, at: '2026-01-01T00:00:00.000Z', job: 'slow', kind: 'render', submitted_by: 'test', state: 'succeeded', counted: { captures: 0, dry_runs: 0, renders: 1 } })}\n`;
}

async function lockOf(file: string) {
  return takeProjectLock(root, file.replace(/\.jsonl$/, '.lock'), { command: `log-writer ${mode}`, what: file, waitMs: 5_000, busy: (ref) => new EngineError('busy', `${ref} is held`) });
}

if (mode === 'append') {
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim() === 'go') break;
  }
  for (let i = 0; i < Number(b); i++) {
    await appendJournal(root, { by, op: 'write', what: 'scenario', path: `p/${a}-${i}`, outcome: 'ok' }, systemClock);
    await appendHistory(root, { job: `${a}-${i}`, kind: 'render', submitted_by: 'test', state: 'succeeded', counted: { captures: 0, dry_runs: 0, renders: 1 } }, systemClock);
  }
  process.exit(0);
} else if (mode === 'torn' || mode === 'slow') {
  const line = slowLine(a);
  const half = Math.floor(line.length / 2);
  await lockOf(a);
  const fh = await open(join(root, '.retake', a), 'a');
  await fh.write(line.slice(0, half));
  await fh.sync();
  if (mode === 'torn') process.kill(process.pid, 'SIGKILL');
  process.stdout.write('locked\n');
  await new Promise((r) => setTimeout(r, Number(b)));
  await fh.write(line.slice(half));
  await fh.sync();
  await fh.close();
  // The lock is released at exit (TakeLock's exit handler), as a writer that returns releases it.
  process.exit(0);
}
