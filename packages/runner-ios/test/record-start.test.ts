/**
 * The screen recording's start and stop (src/record-video.ts) with a fake `xcrun simctl io … recordVideo`: capture time
 * 0 is the moment its "Recording started" line is read — never before it, stamped as its chunk is read —, a recorder
 * that stays silent or ends first fails the take, SIGINT finishes it (its moment kept) and one that does not finish in
 * time is killed; the recorder is watched (it outlives no host that died hard) until stopped; how late the start stamp
 * was, from the movie's duration (start stamp → SIGINT, both on the host).
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Exec, ProcHandle, ProcResult } from '../src/proc.js';
import { procExec } from '../src/proc.js';
import { MAX_LATENESS_S, ScreenRecording, recordArgs, recordingLateness } from '../src/record-video.js';

const dir = mkdtempSync(join(tmpdir(), 'retake-record-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake xcrun: `mode` says how it behaves; it writes when it said "Recording started" (epoch ms) to `<dir>/said`. */
function fake(mode: 'ok' | 'silent' | 'dies' | 'stubborn'): string {
  const file = join(dir, `xcrun-${mode}`);
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
process.stderr.write('Note: No display specified. Defaulting to display: Internal\\n');
if (mode === 'dies') { process.stderr.write('Error: device not booted\\n'); process.exit(3); }
process.on('SIGINT', () => { if (mode === 'stubborn') return; process.stderr.write('Recording completed. Writing to disk.\\n'); process.exit(0); });
if (mode !== 'silent') setTimeout(() => { fs.writeFileSync(${JSON.stringify(join(dir, 'said'))}, String(Date.now())); process.stderr.write('Recording started\\n'); }, 300);
setInterval(() => {}, 1000);
`,
  );
  chmodSync(file, 0o755);
  return file;
}

describe('the screen recording', () => {
  it('its arguments: h264, the mask ignored, the file forced', () => {
    expect(recordArgs('UDID', '/r/.ios/capture.mov')).toEqual(['simctl', 'io', 'UDID', 'recordVideo', '--codec', 'h264', '--mask', 'ignored', '--force', '/r/.ios/capture.mov']);
  });

  it('capture time 0 is when the "Recording started" line is read, not before; SIGINT finishes it', async () => {
    const t0 = Date.now();
    let started = 0;
    let startedNs = 0n;
    const rec = await ScreenRecording.start({
      exec: procExec,
      xcrun: fake('ok'),
      udid: 'U',
      mov: join(dir, 'a.mov'),
      onStarted: () => {
        started = Date.now();
        startedNs = process.hrtime.bigint();
      },
    });
    expect(rec.startedNs).toBeLessThanOrEqual(startedNs);
    expect(rec.stopNs).toBeNull();
    const said = Number(readFileSync(join(dir, 'said'), 'utf8'));
    expect(started).toBeGreaterThanOrEqual(said);
    expect(started - said).toBeLessThan(200);
    expect(started - t0).toBeGreaterThanOrEqual(250);
    const beforeStop = process.hrtime.bigint();
    await rec.stop();
    expect(rec.stopNs).not.toBeNull();
    expect(rec.stopNs!).toBeGreaterThanOrEqual(beforeStop);
  });

  it("the start stamp is the time its line's chunk was read (the stream's own stamp); the recorder is watched until stopped", async () => {
    const READ_AT = 123_456_789n;
    let exit!: (r: ProcResult) => void;
    const handle: ProcHandle = { pid: 4242, exited: new Promise((r) => (exit = r)), done: false, signal: () => exit({ code: 0, signal: null, stdout: '', stderr: '' }) };
    const watched: number[] = [];
    let unwatched = 0;
    const exec: Exec = {
      run: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }),
      start: (_p, _a, o) => {
        setTimeout(() => o?.onLine?.('Recording started', 'stderr', READ_AT), 20);
        return handle;
      },
      watch: (pid) => {
        watched.push(pid);
        return () => void unwatched++;
      },
    };
    const rec = await ScreenRecording.start({ exec, xcrun: 'xcrun', udid: 'U', mov: join(dir, 'e.mov'), onStarted: () => undefined });
    expect(rec.startedNs).toBe(READ_AT);
    // A host that dies hard leaves no recording running (orphanWatch): watched from its start to its stop.
    expect(watched).toEqual([4242]);
    expect(unwatched).toBe(0);
    await rec.stop();
    expect(unwatched).toBe(1);
  });

  it("the start stamp's lateness: the movie's duration less the span from the stamp to the SIGINT; nothing believable, none", () => {
    const s = 1_000_000_000n;
    expect(recordingLateness({ startedNs: s, stopNs: s + 2_000_000_000n, movieS: 2.0412 })).toBeCloseTo(0.0412, 4);
    // Never negative (rounding of the movie's 1/600 s ticks).
    expect(recordingLateness({ startedNs: s, stopNs: s + 2_000_000_000n, movieS: 1.999 })).toBe(0);
    expect(recordingLateness({ startedNs: s, stopNs: s + 2_000_000_000n, movieS: 2 + MAX_LATENESS_S + 0.1 })).toBeNull();
    expect(recordingLateness({ startedNs: s, stopNs: null, movieS: 2 })).toBeNull();
    expect(recordingLateness({ startedNs: s, stopNs: s + 1n, movieS: null })).toBeNull();
  });

  it('a recorder that stays silent or ends before it starts fails the take; one that does not finish is killed', async () => {
    let calls = 0;
    await expect(ScreenRecording.start({ exec: procExec, xcrun: fake('silent'), udid: 'U', mov: join(dir, 'b.mov'), onStarted: () => calls++, startMs: 800 })).rejects.toThrow(
      /did not start within 0.8 s/,
    );
    await expect(ScreenRecording.start({ exec: procExec, xcrun: fake('dies'), udid: 'U', mov: join(dir, 'c.mov'), onStarted: () => calls++ })).rejects.toThrow(
      /ended before it started \(exit 3: Error: device not booted\)/,
    );
    expect(calls).toBe(0);
    const rec = await ScreenRecording.start({ exec: procExec, xcrun: fake('stubborn'), udid: 'U', mov: join(dir, 'd.mov'), onStarted: () => calls++ });
    expect(calls).toBe(1);
    await expect(rec.stop(500)).rejects.toThrow(/did not finish its file within 0.5 s/);
  });
});
