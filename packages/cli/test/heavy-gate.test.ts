/**
 * L5.14a captures first in the terminal: a heavy command waits to start while a take of this user films (one line on
 * stderr, stdout untouched), starts within a poll once it ends, then yields (background priority) during a later take;
 * `--no-wait` skips both; nothing filming costs nothing; a take's own hooks never wait for it; Ctrl-C while waiting exits
 * interrupted with nothing written (the built CLI). L5.14a fixes (review B H2 / L6): every heavy command waits —
 * render, still, export, review, export-capture (and run --raw: cli e2e.test.ts) —, `latest` is the one named before the
 * wait, a marker of the CLI's own parent (a take's hook) does not hold it, and `--no-wait` / Ctrl-C are checked by what
 * they wrote.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '@retake/core';
import { FilmingMarker, capturesDir, processStart, selfIdentity, workspaceCaptureId } from '@retake/engine';
import type { ProcessIdentity } from '@retake/engine';
import { heavyGate } from '../src/heavy-gate.js';
import { memoryIo } from '../src/index.js';
import { Ui } from '../src/ui.js';
import { synthTimeline } from '@retake/test-support/timeline';
import { TEMPLATES, hasTool } from '@retake/test-support/repo';
import { linkSharedCache, makeColourCapture, syntheticRunRecord } from '@retake/test-support/render';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(REPO, 'packages/cli/dist/bin.js');
const REAL_RUN = '20260101-120000-held';

/** A whole capture of `held` in `dir` — its record, the head of its timeline, its film: what `latest` takes (L7.6a). */
function wholeCapture(dir: string, id: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'run.json'), JSON.stringify(syntheticRunRecord(dir, { id, scenario: 'held', project: 'latest' })));
  writeFileSync(join(dir, 'timeline.json'), JSON.stringify({ version: 1, run_id: id, project: 'latest', scenario: 'held', mode: 'capture', capture: { file: 'capture.mp4' } }));
  writeFileSync(join(dir, 'capture.mp4'), 'never read');
}
const canEncode = hasTool('ffmpeg') && hasTool('ffprobe');

let ws: string;
let me: ProcessIdentity;
const children: ChildProcess[] = [];

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-heavy-gate-'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  const runDir = join(ws, 'projects', 'demo', 'runs', '20260101-120000-held');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(ws, 'projects', 'demo', 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\n');
  await writeFile(join(runDir, 'run.json'), '{}');
  me = await selfIdentity();
  // A project with a real (synthetic) capture: what export-capture and still can work on.
  const real = join(ws, 'projects', 'real', 'runs', REAL_RUN);
  await mkdir(real, { recursive: true });
  await writeFile(join(ws, 'projects', 'real', 'project.yaml'), 'name: Real\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  const t = synthTimeline({
    duration: 4,
    entries: [{ id: 'a', t_start: 0.5, t_end: 4, caption: { text: 'A scene.' } }],
    video: { title: { text: 'Synthetic' }, intro: false, outro: false, frame: 'card', template: 'editorial' },
  });
  t.run_id = REAL_RUN;
  t.project = 'real';
  t.scenario = 'held';
  await writeFile(join(real, 'timeline.json'), JSON.stringify(t));
  await writeFile(join(real, 'run.json'), JSON.stringify(syntheticRunRecord(real, { id: REAL_RUN, scenario: 'held', project: 'real' })));
  if (canEncode) makeColourCapture(join(real, 'capture.mp4'), 4);
  await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  await linkSharedCache(ws);
  // "latest" before the wait: a run and a render that a newer one joins while the command waits.
  const latest = join(ws, 'projects', 'latest');
  await mkdir(join(latest, 'runs', '20260101-120000-held'), { recursive: true });
  await writeFile(join(latest, 'project.yaml'), 'name: Latest\nenvironments:\n  local: {app: "http://app.test"}\n');
  wholeCapture(join(latest, 'runs', '20260101-120000-held'), '20260101-120000-held');
  await mkdir(join(latest, 'renders'), { recursive: true });
  await writeFile(join(latest, 'renders', 'held-v1.json'), JSON.stringify({ version: 1, id: 'held-v1', status: 'succeeded', scenario: 'held', created_at: '2026-01-01T12:00:00.000Z', plan: {} }));
});

afterAll(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  if (ws) await rm(ws, { recursive: true, force: true });
});

const ui = () => {
  const io = memoryIo();
  return { io, ui: new Ui(io) };
};

describe('heavyGate (L5.14a)', () => {
  it('nothing filming: no line, no delay', async () => {
    const { io, ui: u } = ui();
    const t0 = Date.now();
    const gate = await heavyGate(u, { root: ws, what: 'rendering', pollMs: 50 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(gate.waited).toBe(false);
    expect(io.stderr()).toBe('');
    await gate.dispose();
  });

  it('waits with one line on stderr while a take films, starts once it ends; stdout untouched', async () => {
    const take = FilmingMarker.open({ root: ws, source: 'job', owner: me })!;
    const { io, ui: u } = ui();
    setTimeout(() => take.closeSync(), 600);
    const t0 = Date.now();
    const gate = await heavyGate(u, { root: ws, what: 'rendering', pollMs: 50 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect(gate.waited).toBe(true);
    expect(io.stderr()).toBe('waiting for a take to finish (in this workspace) before rendering — Ctrl-C to quit, --no-wait to start now\n');
    expect(io.stdout()).toBe('');
    await gate.dispose();
  });

  it('L5.14b: a take past the cap (RETAKE_CAPTURE_HOLD_MAX_MIN) holds no more, and that is said: the command starts', async () => {
    const take = FilmingMarker.open({ root: ws, source: 'job', owner: me })!;
    try {
      const { io, ui: u } = ui();
      const t0 = Date.now();
      const gate = await heavyGate(u, { root: ws, what: 'rendering', pollMs: 50, env: { ...process.env, RETAKE_CAPTURE_HOLD_MAX_MIN: '0.01' } });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
      expect(gate.waited).toBe(true);
      expect(io.stderr()).toBe(
        'waiting for a take to finish (in this workspace) before rendering — Ctrl-C to quit, --no-wait to start now\n! a take has held heavy work for over 0.01 min: rendering starts now\n',
      );
      await gate.dispose();
    } finally {
      take.closeSync();
    }
  });

  it('--no-wait: neither waits nor yields', async () => {
    const take = FilmingMarker.open({ root: join(ws, 'elsewhere'), source: 'job', owner: me })!;
    const { io, ui: u } = ui();
    const calls: string[] = [];
    const qos = { held: false, hold: async () => void calls.push('hold'), release: async () => void calls.push('release') };
    const gate = await heavyGate(u, { root: ws, what: 'rendering', noWait: true, pollMs: 50, qos });
    expect(gate.waited).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toEqual([]);
    expect(io.stderr()).toBe('');
    take.closeSync();
    await gate.dispose();
  });

  it('then yields during a later take (background priority), back after it; dispose releases', async () => {
    const { ui: u } = ui();
    const calls: string[] = [];
    const qos = {
      held: false,
      async hold() {
        if (!this.held) calls.push('hold');
        this.held = true;
      },
      async release() {
        calls.push('release');
        this.held = false;
      },
    };
    const gate = await heavyGate(u, { root: ws, what: 'rendering', pollMs: 50, qos });
    const take = FilmingMarker.open({ root: join(ws, 'elsewhere'), source: 'cli', owner: me })!;
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual(['hold']);
    take.closeSync();
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual(['hold', 'release']);
    const again = FilmingMarker.open({ root: ws, source: 'cli', owner: me })!;
    await new Promise((r) => setTimeout(r, 400));
    await gate.dispose();
    again.closeSync();
    expect(calls).toEqual(['hold', 'release', 'hold', 'release']);
  });
});

describe.skipIf(!existsSync(BIN))('the built CLI waits for a take (L5.14a)', () => {
  /** A take of another process (not an ancestor of the CLI): a sleeping sibling owns the marker. */
  async function siblingTake(): Promise<{ name: string; stop: () => void }> {
    const sib = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(sib);
    const start = await processStart(sib.pid!);
    const { dir } = capturesDir();
    const name = `k_${ulid()}.json`;
    const file = join(dir!, name);
    const write = () =>
      writeFileSync(file, JSON.stringify({ v: 1, pid: sib.pid, started_at: new Date(start!).toISOString(), ws: workspaceCaptureId(join(ws, 'other')), source: 'cli' }), { mode: 0o600 });
    write();
    const beat = setInterval(write, 1000); // its heartbeat, from this process
    return {
      name,
      stop: () => {
        clearInterval(beat);
        sib.kill('SIGKILL');
      },
    };
  }

  function cli(...args: string[]): { child: ChildProcess; err: () => string; out: () => string; exited: Promise<number | null> } {
    const child = spawn(process.execPath, [BIN, '-C', ws, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let err = '';
    let out = '';
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    return { child, err: () => err, out: () => out, exited: new Promise((r) => child.on('exit', (c) => r(c))) };
  }

  it('export-capture waits with its line ("elsewhere on this Mac"); Ctrl-C exits 130, nothing written', async () => {
    const take = await siblingTake();
    try {
      const c = cli('export-capture', 'demo', '20260101-120000-held');
      const deadline = Date.now() + 30_000;
      while (!c.err().includes('waiting for a take') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(c.err()).toContain('waiting for a take to finish (elsewhere on this Mac) before exporting');
      c.child.kill('SIGINT');
      expect(await c.exited).toBe(130);
      expect(c.err()).toContain('interrupted while waiting for a take to finish');
      expect(c.out()).toBe('');
      expect(existsSync(join(ws, 'projects', 'demo', 'exports'))).toBe(false);
    } finally {
      take.stop();
    }
  });

  /** Wait for the waiting line of a command. */
  async function waiting(c: ReturnType<typeof cli>): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (!c.err().includes('waiting for a take') && c.child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(c.err()).toContain('waiting for a take to finish (elsewhere on this Mac)');
  }

  it.skipIf(!canEncode)(
    'review B L6: Ctrl-C while waiting writes nothing; --no-wait starts at once and writes the package (exit 0)',
    async () => {
      const take = await siblingTake();
      const exports = join(ws, 'projects', 'real', 'exports');
      try {
        const c = cli('export-capture', 'real', REAL_RUN);
        await waiting(c);
        c.child.kill('SIGINT');
        expect(await c.exited).toBe(130);
        expect(existsSync(exports)).toBe(false);
        const t0 = Date.now();
        const now = cli('export-capture', 'real', REAL_RUN, '--no-wait');
        expect(await now.exited, now.err()).toBe(0);
        expect(now.err()).not.toContain('waiting for a take');
        expect(Date.now() - t0).toBeLessThan(60_000);
        expect(readdirSync(exports).length).toBe(1);
      } finally {
        take.stop();
      }
    },
    120_000,
  );

  it('review B H2: render, export and review wait too, and run on the "latest" named before the wait (critique M10)', async () => {
    const latest = join(ws, 'projects', 'latest');
    for (const [args, line, newer] of [
      [
        ['render', 'latest', 'held'],
        'rendering run 20260101-120000-held',
        () => {
          wholeCapture(join(latest, 'runs', '20260202-120000-held'), '20260202-120000-held');
        },
      ],
      [
        ['export', 'latest', 'latest', '--scenario', 'held'],
        'exporting render held-v1',
        () =>
          writeFileSync(
            join(latest, 'renders', 'held-v2.json'),
            JSON.stringify({ version: 1, id: 'held-v2', status: 'succeeded', scenario: 'held', created_at: '2026-02-02T12:00:00.000Z', plan: {} }),
          ),
      ],
      // held-v2 is the latest once the export's case has run.
      [
        ['review', 'latest', 'latest', '--scenario', 'held'],
        'reviewing render held-v2',
        () =>
          writeFileSync(
            join(latest, 'renders', 'held-v3.json'),
            JSON.stringify({ version: 1, id: 'held-v3', status: 'succeeded', scenario: 'held', created_at: '2026-03-03T12:00:00.000Z', plan: {} }),
          ),
      ],
    ] as const) {
      const take = await siblingTake();
      try {
        const c = cli(...args);
        await waiting(c);
        newer(); // a newer run / render while it waits: not the one it works on
        take.stop();
        await c.exited;
        expect(c.err(), args.join(' ')).toContain(line);
      } finally {
        take.stop();
      }
    }
  }, 180_000);

  it('still waits too (Ctrl-C: nothing rendered)', async () => {
    const take = await siblingTake();
    try {
      const c = cli('still', 'real', 'held', '--frame', '5');
      await waiting(c);
      c.child.kill('SIGINT');
      expect(await c.exited).toBe(130);
      expect(c.err()).toContain('nothing was rendered');
      expect(existsSync(join(ws, 'projects', 'real', 'renders', 'stills'))).toBe(false);
    } finally {
      take.stop();
    }
  }, 120_000);

  it("a take's own hook: a marker of the CLI's parent does not hold it (no wait)", async () => {
    // The parent owns a marker (as a `retake run` whose setup hook runs a heavy command), then runs the CLI and reports.
    const mod = join(REPO, 'packages/engine/src/jobs/captures.ts');
    const proc = join(REPO, 'packages/engine/src/jobs/proc.ts');
    const script = `const { FilmingMarker } = await import(${JSON.stringify(mod)}); const { selfIdentity } = await import(${JSON.stringify(proc)});
      const { spawn } = await import('node:child_process');
      const m = FilmingMarker.open({ root: ${JSON.stringify(join(ws, 'other'))}, source: 'cli', owner: await selfIdentity(), beatMs: 200 });
      if (!m) { process.stdout.write('{"error":"no marker"}'); process.exit(1); }
      const c = spawn(process.execPath, [${JSON.stringify(BIN)}, '-C', ${JSON.stringify(ws)}, 'export-capture', 'demo', '20260101-120000-held'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => (err += d));
      const t = setTimeout(() => c.kill('SIGINT'), 20000);
      c.on('exit', (code) => { clearTimeout(t); m.closeSync(); process.stdout.write(JSON.stringify({ code, err })); });`;
    const parent = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', '--input-type=module', '-e', script], { cwd: REPO, env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(parent);
    let out = '';
    parent.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    await new Promise((r) => parent.on('exit', r));
    const r = JSON.parse(out) as { code: number; err: string };
    expect(r.err).not.toContain('waiting for a take');
    expect(r.code).not.toBe(130);
  }, 60_000);
});
