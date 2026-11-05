/**
 * Who holds the port `retake mcp --http` could not take (L5.18, SEC-18). The port is fixed (47820) so a registration
 * survives restarts; while the server is down, any local program may listen there first — another account's included
 * — and receive the bearer token a client sends to it. So when the port is taken, the server looks the listener up
 * before giving its usual "port busy" answer: only a listener that belongs to this account AND is a Retake MCP server
 * (`… bin.js|retake … mcp … --http`) keeps that answer; any other one, one the lookup cannot see (on macOS a non-root
 * `lsof` lists this account's processes only: another account's listener is invisible), or a lookup that fails or
 * times out, is refused with the advice to stop it and to rotate the token — a client may already have sent it there.
 *
 * Only the start is checked: a listener that takes the port while this server is down, after a client has seen the
 * real one, is not detected here, and a client does not check the server it reaches (BACKLOG BL-162). Programs run
 * by absolute path with a fixed environment: the workspace's PATH never picks the tool.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/** A process listening on the port. */
export interface PortListener {
  pid: number;
  uid: number;
  /** Its command line (`ps -o args=`). */
  args: string;
}

/**
 * The lookup seam: the processes listening on 127.0.0.1-reachable TCP `port` that this account can see ([] when none
 * is visible); throws when it cannot look (no lsof, a timeout).
 */
export type PortListenerLookup = (port: number) => Promise<PortListener[]>;

export const PORT_LOOKUP_TIMEOUT_MS = 2000;

const TOOL_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' };

function tool(candidates: readonly string[]): string {
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`${candidates[0]} not found`);
  return found;
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: TOOL_ENV, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true }, (e, stdout) => {
      if (e && (e as { killed?: boolean }).killed) return reject(new Error(`${file} timed out after ${timeoutMs} ms`));
      if (e && typeof (e as { code?: unknown }).code !== 'number') return reject(e);
      resolve({ code: e ? Number((e as { code: number }).code) : 0, out: String(stdout) });
    });
  });
}

/** The lookup through `lsof` (listening sockets on the port, pid and uid) and `ps` (each one's command line). */
export async function lsofPortListeners(port: number, timeoutMs = PORT_LOOKUP_TIMEOUT_MS): Promise<PortListener[]> {
  const lsof = tool(['/usr/sbin/lsof', '/usr/bin/lsof']);
  const r = await run(lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpu'], timeoutMs);
  // Exit 1 with no output: nothing this account can see listens there.
  if (r.code !== 0 && r.out.trim() === '') return [];
  if (r.code !== 0) throw new Error(`lsof exited with ${r.code}`);
  const found = new Map<number, number>();
  let pid: number | undefined;
  for (const line of r.out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('u') && pid !== undefined) found.set(pid, Number(line.slice(1)));
  }
  const ps = tool(['/bin/ps', '/usr/bin/ps']);
  const out: PortListener[] = [];
  for (const [p, uid] of found) {
    if (!Number.isInteger(p) || p <= 0 || !Number.isInteger(uid)) throw new Error('lsof printed an unreadable line');
    const a = await run(ps, ['-o', 'args=', '-p', String(p)], timeoutMs);
    // Gone since lsof saw it: unidentified, not ours.
    out.push({ pid: p, uid, args: a.code === 0 ? a.out.trim() : '' });
  }
  return out;
}

/** A Retake MCP server over HTTP: the CLI entry point (bin.js, or a `retake` command), then `mcp`, then `--http`. */
const RETAKE_MCP_HTTP = /(?:^|[\s/])(?:bin\.js|retake)\s(?:.*\s)?mcp\s(?:.*\s)?--http(?:\s|$)/;

/** True only when there is a listener and every one is this account's and a Retake MCP server over HTTP. */
export function listenersAreOurs(listeners: readonly PortListener[], uid: number): boolean {
  return listeners.length > 0 && listeners.every((l) => l.uid === uid && RETAKE_MCP_HTTP.test(l.args));
}

export type PortHolderVerdict = { ours: true } | { ours: false; why: string };

/** Who holds `port`: ours, or why not (the seam failing counts as not ours). */
export async function portHolder(port: number, lookup: PortListenerLookup = lsofPortListeners, uid = process.getuid?.() ?? -1): Promise<PortHolderVerdict> {
  let listeners: PortListener[];
  try {
    listeners = await lookup(port);
  } catch (e) {
    return { ours: false, why: `the program holding it cannot be identified (${e instanceof Error ? e.message : 'lookup failed'})` };
  }
  if (listenersAreOurs(listeners, uid)) return { ours: true };
  if (listeners.length === 0) return { ours: false, why: "it is held by a program this account cannot see (another account's, or one that cannot be identified)" };
  const other = listeners.find((l) => l.uid !== uid);
  if (other) return { ours: false, why: `it is held by a program of another account (pid ${other.pid})` };
  return { ours: false, why: `it is held by a program of this account that is not a Retake MCP server (pid ${listeners.find((l) => !RETAKE_MCP_HTTP.test(l.args))?.pid ?? listeners[0].pid})` };
}
