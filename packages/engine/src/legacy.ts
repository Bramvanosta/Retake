/**
 * old-name: this whole file (the guard test allows it; the names themselves are core legacy.ts's).
 *
 * L5.13 (critique M4): a Studio or a jobs worker of the build from before the rename may still run on the workspace
 * while the new one starts — it holds `<workspace>/.demo-studio/ui.json` or `workers/worker.lock`, the new code claims
 * `.retake/`. Two servers, two queues and two workers would then run side by side, with take locks in two folders (two
 * takes could reset the same sandbox). So `retake ui`, `retake mcp`, a worker and `retake sandbox up / reset` refuse to
 * start while such a holder is alive — checked where the worker lock or a take lock is taken, so `run --sandbox`,
 * `env reset` and `record` refuse too. The one read of an old tool folder: a bounded JSON read of those two files for
 * the pid and start time of their holder — a linked folder or file and anything but a regular file are skipped,
 * nothing is written. The folder is agent-writable (core legacy.ts, critique H1), so a record counts only as lock.ts
 * counts one (review A #7, L5.13a review A M1): with a start time that `ps` gives for that pid — a record naming a pid
 * alone could name any process of the person (the editor, Claude), and block every start for good.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { OLD_DIR, OLD_PRODUCT_NAME } from '@retake/core';
import { EngineError } from './errors.js';
import { isAlive, processStart } from './jobs/proc.js';

/** The largest holder file read (a real one is a few hundred bytes). */
export const OLD_HOLDER_MAX_BYTES = 64 * 1024;

export interface OldHolder {
  what: 'ui' | 'worker';
  pid: number;
  file: string;
}

/** A real folder at `dir` (lstat: a link to a folder is not one). */
function realFolder(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The pid and start time a holder file names, or null (no file, a link — the file or a folder between `root` and it —,
 * not a regular file, too large, not JSON, no start time).
 */
function readHolder(root: string, rel: readonly string[]): { pid: number; started_at: string } | null {
  let dir = root;
  for (const part of rel.slice(0, -1)) {
    dir = join(dir, part);
    if (!realFolder(dir)) return null;
  }
  const file = join(dir, rel[rel.length - 1]);
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > OLD_HOLDER_MAX_BYTES) return null;
    const buf = Buffer.alloc(Math.min(st.size, OLD_HOLDER_MAX_BYTES));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const v = JSON.parse(buf.subarray(0, n).toString('utf8')) as { pid?: unknown; started_at?: unknown } | null;
    if (!v || !Number.isInteger(v.pid) || (v.pid as number) <= 0) return null;
    if (typeof v.started_at !== 'string' || !Number.isFinite(Date.parse(v.started_at))) return null;
    return { pid: v.pid as number, started_at: v.started_at };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A Studio or a worker of before L5.13 still alive on the workspace `root`, or null. `start`: a pid's start time from
 * ps (a test gives one that cannot tell).
 */
export async function oldLiveHolder(root: string, start: (pid: number) => Promise<number | null> = processStart): Promise<OldHolder | null> {
  for (const [what, rel] of [
    ['ui', [OLD_DIR, 'ui.json']],
    ['worker', [OLD_DIR, 'workers', 'worker.lock']],
  ] as const) {
    const held = readHolder(root, rel);
    // The pid must run AND have the recorded start time (isAlive compares it); ps must know it (else the pid alone
    // would decide, which a written record could abuse).
    if (held && held.pid !== process.pid && (await start(held.pid)) !== null && (await isAlive(held))) return { what, pid: held.pid, file: join(root, ...rel) };
  }
  return null;
}

/** The refusal while an old holder runs: `doing` is what would start ("the Studio", "a jobs worker"…). */
export async function refuseBesideOldHolder(root: string, doing: string): Promise<void> {
  const h = await oldLiveHolder(root);
  if (!h) return;
  const who = h.what === 'ui' ? 'a Studio' : 'a jobs worker';
  throw new EngineError('refused', `${h.file}: ${who} from before the rename (${OLD_PRODUCT_NAME}, pid ${h.pid}) still runs on this workspace — ${doing} would run beside it (two job queues, take locks in two folders)`, {
    fix: `${h.what === 'ui' ? `quit the ${OLD_PRODUCT_NAME} app, or stop that Studio (Ctrl-C in its terminal)` : 'let its job finish and stop that worker'}, then try again — or remove ${h.file} if no old Studio or worker runs`,
  });
}
