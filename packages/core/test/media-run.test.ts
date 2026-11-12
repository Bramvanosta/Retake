/**
 * The one module that starts the media tools (core io/media-run.ts, L7.31, finding X3): runs to their end, synchronous
 * runs and started processes, their time limits, cancels, signals, stderr and their one error type — on small shell
 * scripts standing in for ffmpeg / ffprobe.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MediaToolError, runMediaTool, runMediaToolSync, startMediaTool, stderrLines } from '@retake/core/io';

const dir = mkdtempSync(join(tmpdir(), 'retake-media-run-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in tool: a shell script. */
function tool(name: string, body: string): string {
  const f = join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

const ok = tool('ok', 'printf "out:%s" "$1"; printf "warn\\n" >&2; exit 0');
const fails = tool('fails', 'printf "one\\ntwo\\nthree\\nfour\\n" >&2; exit 3');
const slow = tool('slow', 'printf "started\\n" >&2; exec sleep 5'); // exec: a kill reaches the sleep itself (no child left holding the pipes)
const echo = tool('echo', 'cat');
const loud = tool('loud', 'head -c 5000 /dev/zero');
const missing = join(dir, 'not-there');

describe('runMediaTool: a run to its end', () => {
  it('answers the exit status, the output and no error when it exits 0', async () => {
    expect(await runMediaTool(ok, ['a b'])).toEqual({ code: 0, stdout: 'out:a b', stderr: 'warn\n', error: null });
    const bytes = await runMediaTool(ok, ['x'], { encoding: 'buffer' });
    expect(Buffer.isBuffer(bytes.stdout) && bytes.stdout.toString()).toBe('out:x');
  });

  it('a failed run answers its status and a MediaToolError with execFile\'s message and the stderr (never rejects)', async () => {
    const r = await runMediaTool(fails, []);
    expect(r.code).toBe(3);
    expect(r.error).toBeInstanceOf(MediaToolError);
    expect(r.error).toMatchObject({ reason: 'exit', code: 3, program: fails, stderr: 'one\ntwo\nthree\nfour\n', errorKind: 'internal' });
    expect(r.error!.message).toMatch(/^Command failed: /);
    expect(stderrLines(r.stderr, 2)).toBe('three | four');
    expect(stderrLines(r.stderr, 1, 'first')).toBe('one');
    expect(stderrLines('', 3)).toBe('');
  });

  it('a tool that cannot start: no status, reason `start`, the system\'s code', async () => {
    const r = await runMediaTool(missing, []);
    expect(r.code).toBeNull();
    expect(r.error).toMatchObject({ reason: 'start', errno: 'ENOENT', code: null });
  });

  it('its time limit kills it with the signal asked (default SIGTERM); a cancel sends SIGTERM', async () => {
    const t0 = Date.now();
    const r = await runMediaTool(slow, [], { timeoutMs: 200 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.error).toMatchObject({ reason: 'timeout', code: null, signal: 'SIGTERM' });
    expect((await runMediaTool(slow, [], { timeoutMs: 200, killSignal: 'SIGKILL' })).error).toMatchObject({ reason: 'timeout', signal: 'SIGKILL' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    expect((await runMediaTool(slow, [], { signal: ac.signal })).error).toMatchObject({ reason: 'cancelled', signal: 'SIGTERM' });
  });

  it('writes `input` to its stdin; more output than maxBuffer is `output`', async () => {
    expect((await runMediaTool(echo, [], { input: 'frames' })).stdout).toBe('frames');
    expect((await runMediaTool(echo, [], { input: Buffer.from([1, 2, 3]), encoding: 'buffer' })).stdout).toEqual(Buffer.from([1, 2, 3]));
    expect((await runMediaTool(loud, [], { maxBuffer: 1000 })).error).toMatchObject({ reason: 'output', code: null });
  });
});

describe('runMediaToolSync', () => {
  it('answers stdout; a failure throws MediaToolError with execFileSync\'s message, not copying the stderr', () => {
    expect(runMediaToolSync(ok, ['s'])).toBe('out:s');
    expect(runMediaToolSync(ok, ['s'], { encoding: 'buffer' })).toEqual(Buffer.from('out:s'));
    let e: unknown;
    try {
      runMediaToolSync(fails, ['-v', 'error']);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(MediaToolError);
    expect(e).toMatchObject({ reason: 'exit', code: 3, message: `Command failed: ${fails} -v error\none\ntwo\nthree\nfour\n` });
    expect(() => runMediaToolSync(missing, [])).toThrow(expect.objectContaining({ reason: 'start', errno: 'ENOENT' }));
    expect(() => runMediaToolSync(loud, [], { maxBuffer: 1000 })).toThrow(expect.objectContaining({ reason: 'output' }));
  });
});

describe('startMediaTool: a process to stream through', () => {
  it('keeps the head or the tail of stderr, settles once with the exit', async () => {
    const head = startMediaTool(fails, [], { stdio: ['ignore', 'ignore', 'pipe'], stderr: { keep: 'head', max: 3 } });
    expect(await head.exited).toEqual({ code: 3, signal: null, error: null });
    expect(head.stderr).toBe('one\ntwo\nthree\nfour\n'); // one chunk: a head keeps whole chunks while under its max
    const tail = startMediaTool(fails, [], { stdio: ['ignore', 'ignore', 'pipe'], stderr: { keep: 'tail', max: 5 } });
    await tail.exited;
    expect(tail.stderr).toBe('four\n');
    const none = startMediaTool(fails, [], { stdio: ['ignore', 'ignore', 'pipe'] });
    await none.exited;
    expect(none.stderr).toBe('');
  });

  it('a tool that cannot start settles with its error', async () => {
    const p = startMediaTool(missing, [], { stdio: 'ignore' });
    const end = await p.exited;
    expect(end.code).toBeNull();
    expect(end.error?.code).toBe('ENOENT');
  });

  it('its time limit (default SIGKILL) and its cancel (default SIGTERM) kill it and say why', async () => {
    const t = startMediaTool(slow, [], { stdio: 'ignore', timeoutMs: 150 });
    expect(await t.exited).toMatchObject({ code: null, signal: 'SIGKILL', killed: 'timeout' });
    expect(t.killed).toBe('timeout');
    const ac = new AbortController();
    const c = startMediaTool(slow, [], { stdio: 'ignore', signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    expect(await c.exited).toMatchObject({ signal: 'SIGTERM', killed: 'cancelled' });
    const k = startMediaTool(slow, [], { stdio: 'ignore', signal: new AbortController().signal, cancelSignal: 'SIGKILL' });
    k.kill('cancelled');
    expect(await k.exited).toMatchObject({ signal: 'SIGKILL', killed: 'cancelled' });
  });

  it('a signal aborted before the start kills it at once, or leaves it to run (`abortedAtStart: run`)', async () => {
    const gone = new AbortController();
    gone.abort();
    expect(await startMediaTool(slow, [], { stdio: 'ignore', signal: gone.signal }).exited).toMatchObject({ killed: 'cancelled' });
    const runs = startMediaTool(ok, [], { stdio: 'ignore', signal: gone.signal, abortedAtStart: 'run' });
    expect(await runs.exited).toEqual({ code: 0, signal: null, error: null });
  });

  it('settles on `exit` when asked (a pipe still held elsewhere does not hold it)', async () => {
    // The child's child keeps stderr open for 3 s after the tool itself ended.
    const holder = tool('holder', '(sleep 3) & exit 0');
    const t0 = Date.now();
    expect(await startMediaTool(holder, [], { stdio: ['ignore', 'ignore', 'pipe'], settle: 'exit' }).exited).toMatchObject({ code: 0 });
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});
