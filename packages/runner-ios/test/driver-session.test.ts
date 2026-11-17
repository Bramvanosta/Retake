/**
 * The driver's session (src/driver-session.ts) with a fake xcodebuild and a fake driver on 127.0.0.1: the driver is
 * told its idle limit (it quits by itself when the host is gone), the host pings a driver it sends nothing to, and the
 * stop of a cancelled run still cleans up — the `quit` sent and the runner and the app terminated, none of it under
 * the run's cancel.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { NONCE_HEADER, statusProof } from '../src/driver-client.js';
import { DRIVER_RUNNER_BUNDLE_ID } from '../src/driver-build.js';
import { DriverSession } from '../src/driver-session.js';
import type { Exec, ProcHandle, ProcResult, RunOpts } from '../src/proc.js';
import { Simctl } from '../src/simctl.js';

const dir = mkdtempSync(join(tmpdir(), 'retake-session-'));
let server: Server;
let port: number;
let token = '';
const ops: string[] = [];

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (body: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/status') return send({ ok: true, proof: statusProof(token, String(req.headers[NONCE_HEADER] ?? '')) });
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw) as { op: string };
  ops.push(body.op);
  if (body.op === 'quit') exit?.();
  send({ ok: true, t_begin: 1, t_end: 2 });
}

let exit: (() => void) | null = null;

/** A fake xcodebuild that ends once the driver is told to quit; every simctl call with the signal it had. */
function fakeExec() {
  const runs: Array<{ args: string; signal: AbortSignal | undefined }> = [];
  let env: NodeJS.ProcessEnv = {};
  const exec: Exec = {
    run: async (_p: string, args: readonly string[], o?: RunOpts): Promise<ProcResult> => {
      runs.push({ args: args.join(' '), signal: o?.signal });
      return { code: o?.signal?.aborted ? null : 0, signal: null, stdout: '', stderr: '', ...(o?.signal?.aborted ? { error: 'cancelled' as const } : {}) };
    },
    start: (_p, _args, o) => {
      env = o?.env ?? {};
      token = String(env.TEST_RUNNER_RETAKE_DRIVER_TOKEN);
      let done = false;
      const exited = new Promise<ProcResult>((r) => {
        exit = () => {
          done = true;
          r({ code: 0, signal: null, stdout: '', stderr: '' });
        };
      });
      const h: ProcHandle = {
        pid: undefined,
        exited,
        get done() {
          return done;
        },
        signal: () => exit?.(),
      };
      return h;
    },
  };
  return { exec, runs, env: () => env };
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => {
  ops.length = 0;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function start(f: ReturnType<typeof fakeExec>, signal: AbortSignal, o: { idleS?: number; keepaliveMs?: number } = {}) {
  return DriverSession.start({
    exec: f.exec,
    simctl: new Simctl(f.exec, 'xcrun'),
    xcrun: 'xcrun',
    xctestrun: '/x.xctestrun',
    derivedData: '/dd',
    udid: 'UDID',
    dir,
    redact: (l) => l,
    log: () => undefined,
    signal,
    port: async () => port,
    ...o,
  });
}

describe("the driver's session", () => {
  it("a cancelled run's stop still quits the driver and terminates the runner and the app, without the run's cancel", async () => {
    const f = fakeExec();
    const abort = new AbortController();
    const s = await start(f, abort.signal);
    abort.abort();
    await s.stop('com.example.buyer');
    expect(ops).toContain('quit');
    const terminates = f.runs.filter((r) => r.args.startsWith('simctl terminate'));
    expect(terminates.map((r) => r.args)).toEqual([`simctl terminate UDID ${DRIVER_RUNNER_BUNDLE_ID}`, 'simctl terminate UDID com.example.buyer']);
    for (const r of terminates) expect(r.signal?.aborted ?? false, r.args).toBe(false);
  });

  it('the driver is told its idle limit; a driver sent nothing is pinged, none after the stop', async () => {
    const f = fakeExec();
    const s = await start(f, new AbortController().signal, { idleS: 7, keepaliveMs: 150 });
    expect(f.env().TEST_RUNNER_RETAKE_DRIVER_IDLE_S).toBe('7');
    await new Promise((r) => setTimeout(r, 500));
    expect(ops.filter((o) => o === 'ping').length).toBeGreaterThanOrEqual(1);
    await s.stop();
    const after = ops.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(ops.length).toBe(after);
  });
});
