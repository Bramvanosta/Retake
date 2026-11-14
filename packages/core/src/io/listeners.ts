/**
 * Who listens on a TCP port of this machine (an OS utility of core's io side; L7.25: from @retake/sandbox's ports.ts,
 * which re-exports it): a connection probe on 127.0.0.1 and ::1, and lsof's listeners (program and pid).
 */
import { execFile } from 'node:child_process';
import { connect } from 'node:net';

/** Does something accept a TCP connection on this port, on 127.0.0.1 or ::1? */
export async function probePort(port: number, timeoutMs = 400): Promise<boolean> {
  const one = (host: string) =>
    new Promise<boolean>((resolve) => {
      const s = connect({ host, port });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(timeoutMs, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  const [v4, v6] = await Promise.all([one('127.0.0.1'), one('::1')]);
  return v4 || v6;
}

export interface Listener {
  pid: number;
  pgid: number;
  command: string;
  port: number;
}

/** `lsof -F pgcn` output → the listeners of each port (a process listening on several addresses counts once per port). */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = [];
  let cur: { pid: number; pgid: number; command: string } | null = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const v = line.slice(1);
    if (tag === 'p') cur = { pid: Number(v), pgid: Number.NaN, command: '' };
    else if (cur && tag === 'g') cur.pgid = Number(v);
    else if (cur && tag === 'c') cur.command = v;
    else if (cur && tag === 'n') {
      const m = /:(\d+)$/.exec(v);
      if (!m) continue;
      const port = Number(m[1]);
      if (!out.some((l) => l.pid === cur!.pid && l.port === port)) out.push({ ...cur, port });
    }
  }
  return out;
}

/**
 * The programs listening on these ports (TCP, any address) — null when lsof is not available. lsof lists the current
 * user's processes; a port held by another user's program shows no listener but still accepts connections (probePort).
 */
export function listeners(ports: readonly number[]): Promise<Listener[] | null> {
  if (!ports.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${ports.join(',')}`, '-sTCP:LISTEN', '-Fpgcn'], { timeout: 10_000 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
      // Exit status 1 with no output: nothing listens.
      resolve(parseLsof(String(stdout ?? '')));
    });
  });
}

/** "node, pid 81234" / "node, pid 81234 and python3, pid 81300". */
export function describeListeners(ls: readonly Listener[]): string {
  return ls.map((l) => `${l.command || '?'}, pid ${l.pid}`).join(' and ');
}
