/**
 * The orphan watch (src/proc.ts orphanWatch): a process group outlives no host that died hard — once the host is gone
 * the group gets SIGINT (a recording finishes its file), SIGKILL 15 s later if it is still there; a watch ended first
 * does nothing.
 */
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { orphanWatch } from '../src/proc.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return ok();
}

/** A process group of its own (as the recorder is: detached). */
function group(): number {
  const c = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  c.unref();
  return c.pid!;
}

describe('the orphan watch', () => {
  it('the host gone (killed hard), the watched group is stopped', async () => {
    const host = group();
    const watched = group();
    orphanWatch(watched, host);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(watched)).toBe(true);
    process.kill(host, 'SIGKILL');
    expect(await until(() => !alive(watched), 6000)).toBe(true);
  });

  it('a watch ended before the host goes does nothing', async () => {
    const host = group();
    const watched = group();
    const end = orphanWatch(watched, host);
    await new Promise((r) => setTimeout(r, 300));
    end();
    await new Promise((r) => setTimeout(r, 300));
    process.kill(host, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 2500));
    expect(alive(watched)).toBe(true);
    process.kill(-watched, 'SIGKILL');
  });
});
