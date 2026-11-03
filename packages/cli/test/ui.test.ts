/**
 * `retake ui` from the built entry point (`pnpm build` first; skipped without dist): `--no-open --json` prints one JSON
 * line and nothing on stderr, serves the app and `/v1` on 127.0.0.1, writes `.retake/ui.json` (0600); a second
 * `retake ui` reuses the running server with a fresh one-time link and exits 0 (warning when --port names another
 * port); SIGTERM stops the first and removes the file; an unwritable state folder is a refusal with a fix (exit 1); a
 * folder that is not a workspace is a usage error naming --root. L4.2 (critique B5): its PATH is sanitised like
 * `retake mcp`'s — an `ffmpeg` an agent wrote in the workspace (`bin/`, `node_modules/.bin/`) is never what the
 * thumbnails run.
 * L5.2: `--supervised` (the desktop shell's child) prints the line with `v` and the player origin, stops when its stdin
 * closes — also when the parent holding the pipe is killed, after or during the start (critique M3) — says why on
 * stderr without any URL, and attaches (`reused`, with the player origin) to a running server without touching it; a
 * folder that is no workspace answers `{"type":"error","code":"no_workspace"}` on stdout (exit 2), which the desktop
 * shell tells from another usage error (review B L4).
 * L5.2b: the supervised line says `v` 2 (`--json` keeps 1); after it, an owned server writes `pending` snapshots (a
 * running job written in its workspace shows in the next one) and nothing else on stdout — stdin is still read and
 * discarded; a reused server writes nothing after its line.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selfIdentity } from '@retake/engine';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { BLOCKS_YAML, capture, writeRun } from '../../engine/test/synthetic-runs.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');
const built = existsSync(BIN) && existsSync(join(dirname(BIN), '..', '..', 'ui', 'dist', 'index.js'));

let base: string;
let ws: string;
const children: ChildProcess[] = [];

interface Started {
  child: ChildProcess;
  line: Promise<string>;
  /** stdout so far. */
  out: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>;
}

function retake(args: string[], cwd = base, env: NodeJS.ProcessEnv = {}, stdin: 'ignore' | 'pipe' = 'ignore'): Started {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, RETAKE_HOME: join(base, 'home'), RETAKE_ROOT: '', ...env }, stdio: [stdin, 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  let gotLine: (l: string) => void = () => undefined;
  const line = new Promise<string>((r) => (gotLine = r));
  child.stdout!.on('data', (c: Buffer) => {
    out += c.toString('utf8');
    if (out.includes('\n')) gotLine(out.split('\n')[0]);
  });
  child.stderr!.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>((r) => child.on('exit', (code, signal) => r({ code, signal, out, err })));
  return { child, line, exit, out: () => out };
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'studio-ui-cli-'));
  ws = join(base, 'ws');
  await mkdir(ws, { recursive: true });
  await fixtureWorkspace(ws);
});

afterAll(async () => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  if (base) await rm(base, { recursive: true, force: true });
});

describe.skipIf(!built)('retake ui (built CLI)', () => {
  it('serves, prints one JSON line, reuses the running server, stops on SIGTERM and removes ui.json', async () => {
    const first = retake(['--root', ws, 'ui', '--no-open', '--json']);
    const info = JSON.parse(await first.line) as { type: string; url: string; port: number; pid: number; reused: boolean; player: string };
    expect(info).toMatchObject({ type: 'ui', v: 1, reused: false, pid: first.child.pid });
    expect(info.player).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(info.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${info.port}/#c=[A-Za-z0-9_-]{43}$`));
    const file = join(ws, '.retake', 'ui.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const origin = `http://127.0.0.1:${info.port}`;
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const code = info.url.split('#c=')[1];
    const session = await fetch(`${origin}/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect(session.status).toBe(200);
    const { token } = (await session.json()) as { token: string };
    const list = await fetch(`${origin}/v1/call/project_list`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    expect(((await list.json()) as { data: { projects: Array<{ slug: string }> } }).data.projects.map((p) => p.slug)).toEqual(['northfield-fixture']);

    const second = await retake(['--root', ws, 'ui', '--no-open', '--json']).exit;
    expect(second.code, second.err).toBe(0);
    expect(second.err).toBe('');
    const again = JSON.parse(second.out.trim()) as { url: string; port: number; pid: number; reused: boolean };
    expect(again).toMatchObject({ reused: true, port: info.port, pid: first.child.pid, player: info.player });
    expect(again.url).not.toBe(info.url);

    first.child.kill('SIGTERM');
    const done = await first.exit;
    expect(done.code).toBe(0);
    expect(done.err).toBe('');
    expect(done.out.trim().split('\n')).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
    await expect(fetch(`${origin}/`)).rejects.toThrow();
  });

  it('--port naming another port than the running server: reused, with a warning on stderr (review B L4)', async () => {
    const first = retake(['--root', ws, 'ui', '--no-open', '--json']);
    const info = JSON.parse(await first.line) as { port: number };
    const other = info.port === 65000 ? 65001 : 65000;
    const second = await retake(['--root', ws, 'ui', '--no-open', '--json', '--port', String(other)]).exit;
    expect(second.code, second.err).toBe(0);
    expect(JSON.parse(second.out.trim())).toMatchObject({ reused: true, port: info.port });
    expect(second.err).toContain(`already serves this workspace on port ${info.port}: --port ${other} is not used`);
    // The same port, or none: no warning.
    const same = await retake(['--root', ws, 'ui', '--no-open', '--json', '--port', String(info.port)]).exit;
    expect(same.err).toBe('');
    first.child.kill('SIGTERM');
    expect((await first.exit).code).toBe(0);
  });

  it('a state folder it cannot write: exit 1 with what to do, no stack (review B L3)', async () => {
    const dir = join(base, 'ro');
    await mkdir(join(dir, 'projects'), { recursive: true });
    await writeFile(join(dir, 'retake.yaml'), 'projects_dir: projects\n');
    await mkdir(join(dir, '.retake'), { mode: 0o500 });
    await chmod(join(dir, '.retake'), 0o500);
    try {
      const r = await retake(['--root', dir, 'ui', '--no-open', '--json']).exit;
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toContain('.retake is not writable (EACCES)');
      expect(r.err).toContain('fix: make it writable for you');
      expect(r.err).not.toMatch(/unexpected error|\n\s+at /);
    } finally {
      await chmod(join(dir, '.retake'), 0o700);
    }
  });

  it('a folder that is not a workspace: exit 2 with the --root hint', async () => {
    const r = await retake(['ui', '--no-open', '--json'], base).exit;
    expect(r.code).toBe(2);
    expect(r.err).toContain('--root');
    expect(r.out).toBe('');
  });
  it('its PATH is sanitised like retake mcp’s: an ffmpeg written in the workspace is never run (the thumbnails use the real one)', async () => {
    const dir = join(base, 'ws-path');
    await mkdir(dir, { recursive: true });
    await fixtureWorkspace(dir);
    const project = join(dir, 'projects', 'northfield-fixture');
    await writeFile(join(project, 'scenarios', 'blocks.yaml'), BLOCKS_YAML);
    const run = await writeRun(project, capture('20261020-100000-blocks'));
    // The video path: no kept frames.
    await rm(join(run, 'frames'), { recursive: true, force: true });
    await rm(join(run, 'frames.jsonl'), { force: true });
    const marker = join(base, 'fake-ffmpeg-ran');
    for (const bin of [join(dir, 'bin'), join(dir, 'node_modules', '.bin')]) {
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'ffmpeg'), `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\nexit 1\n`, { mode: 0o755 });
    }
    const first = retake(['--root', dir, 'ui', '--no-open', '--json'], base, { PATH: [join(dir, 'bin'), join(dir, 'node_modules', '.bin'), process.env.PATH ?? ''].join(delimiter) });
    const info = JSON.parse(await first.line) as { port: number };
    const { token } = JSON.parse(await readFile(join(dir, '.retake', 'ui.json'), 'utf8')) as { token: string };
    const r = await fetch(`http://127.0.0.1:${info.port}/v1/call/run_thumbs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ project: 'northfield-fixture', run: '20261020-100000-blocks', keys: ['one.0', 'two.1'] }),
    });
    const body = (await r.json()) as { data: { thumbs: Array<{ key: string; from: string }> } };
    expect(r.status).toBe(200);
    expect(body.data.thumbs.map((t) => [t.key, t.from])).toEqual([
      ['one.0', 'video'],
      ['two.1', 'video'],
    ]);
    expect(existsSync(marker), 'the workspace’s ffmpeg ran').toBe(false);
    first.child.kill('SIGTERM');
    expect((await first.exit).code).toBe(0);
  });

  describe('--supervised (L5.2)', () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const gone = async (pid: number, file: string, ms = 5000) => {
      const end = Date.now() + ms;
      while (Date.now() < end && (alive(pid) || existsSync(file))) await new Promise((r) => setTimeout(r, 50));
      return !alive(pid) && !existsSync(file);
    };
    const ui = () => join(ws, '.retake', 'ui.json');

    it('one line with v 2 and the player origin, then pending snapshots only (a running job shows); closing stdin stops it (exit 0, ui.json removed, the reason on stderr, no URL)', async () => {
      const s = retake(['--root', ws, 'ui', '--supervised'], base, {}, 'pipe');
      const info = JSON.parse(await s.line) as { type: string; v: number; url: string; port: number; reused: boolean; player: string };
      expect(info).toMatchObject({ type: 'ui', v: 2, reused: false });
      expect(info.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${info.port}/#c=[A-Za-z0-9_-]{43}$`));
      expect(info.player).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(info.player).not.toBe(`http://127.0.0.1:${info.port}`);
      expect(existsSync(ui())).toBe(true);
      const lines = () => s.out().split('\n').filter(Boolean).slice(1).map((l) => JSON.parse(l) as Record<string, unknown>);
      const until = async (f: () => boolean, ms = 8000) => {
        const end = Date.now() + ms;
        while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
        return f();
      };
      expect(await until(() => lines().length >= 1)).toBe(true);
      expect(lines()[0]).toEqual({ type: 'pending', jobs: [], jobs_total: 0, unsaved: [], unsaved_total: 0 });
      // A job running in the workspace (its worker: this process) shows in the next snapshot, within the 1 s poll.
      const id = `j_${'0'.repeat(25)}1`;
      await mkdir(join(ws, '.retake', 'jobs', id), { recursive: true });
      const input = { version: 1, kind: 'run', project: 'northfield-fixture', scenario: 'quote', scenario_sha256: '0'.repeat(64), mode: 'capture', run_id: '20261029-120000-quote', submitted_by: 'test' };
      await writeFile(join(ws, '.retake', 'jobs', id, 'job.json'), JSON.stringify({ version: 1, id, kind: 'run', input, state: 'running', created_at: new Date().toISOString(), worker: { ...(await selfIdentity()), host: 'test' } }));
      expect(await until(() => lines().some((l) => l.jobs_total === 1))).toBe(true);
      expect(lines().at(-1)).toEqual({ type: 'pending', jobs: [{ kind: 'capture', state: 'running', project: 'northfield-fixture', scenario: 'quote' }], jobs_total: 1, unsaved: [], unsaved_total: 0 });
      // Bytes on stdin are read and discarded: still serving.
      s.child.stdin!.write('anything\n');
      await new Promise((r) => setTimeout(r, 200));
      expect((await fetch(`http://127.0.0.1:${info.port}/`)).status).toBe(200);
      s.child.stdin!.end();
      const done = await s.exit;
      await rm(join(ws, '.retake', 'jobs', id), { recursive: true, force: true });
      expect(done.code).toBe(0);
      expect(done.err).toBe('stopped: stdin closed\n');
      for (const l of lines()) expect(l.type).toBe('pending');
      expect(existsSync(ui())).toBe(false);
    });

    it('SIGTERM: stopped: SIGTERM on stderr', async () => {
      const s = retake(['--root', ws, 'ui', '--supervised'], base, {}, 'pipe');
      await s.line;
      s.child.kill('SIGTERM');
      const done = await s.exit;
      expect(done.code).toBe(0);
      expect(done.err).toBe('stopped: SIGTERM\n');
      expect(existsSync(ui())).toBe(false);
    });

    const parentScript = `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, [process.argv[1], '--root', process.argv[2], 'ui', '--supervised'], { stdio: ['pipe', 'pipe', 'pipe'] });
process.stdout.write('P' + c.pid + '\\n');
c.stdout.on('data', (d) => process.stdout.write('L' + d));
setInterval(() => undefined, 1000);`;
    const parent = () => {
      const p = spawn(process.execPath, ['-e', parentScript, BIN, ws], { env: { ...process.env, RETAKE_HOME: join(base, 'home'), RETAKE_ROOT: '' }, stdio: ['ignore', 'pipe', 'ignore'] });
      children.push(p);
      let out = '';
      const seen = (re: RegExp) =>
        new Promise<RegExpExecArray>((r) => {
          const check = () => {
            const m = re.exec(out);
            if (m) r(m);
          };
          p.stdout!.on('data', (c: Buffer) => ((out += c.toString('utf8')), check()));
          check();
        });
      return { p, seen };
    };

    it('the parent killed (SIGKILL) while it serves: no orphan — the server stops, ui.json removed', async () => {
      const { p, seen } = parent();
      const pid = Number((await seen(/P(\d+)\n/))[1]);
      await seen(/L\{/);
      expect(alive(pid) && existsSync(ui())).toBe(true);
      p.kill('SIGKILL');
      expect(await gone(pid, ui()), 'the supervised server outlived its parent').toBe(true);
    });

    it('the parent killed 50 ms after spawning it (during the start, critique M3): no listener and no ui.json left', async () => {
      const { p, seen } = parent();
      const pid = Number((await seen(/P(\d+)\n/))[1]);
      await new Promise((r) => setTimeout(r, 50));
      p.kill('SIGKILL');
      expect(await gone(pid, ui(), 8000), 'the supervised server outlived its parent').toBe(true);
    });

    it('a folder that is no workspace: the no_workspace line on stdout, exit 2; an unknown option: exit 2 with no line', async () => {
      const empty = join(base, 'not-a-workspace');
      await mkdir(empty, { recursive: true });
      const s = retake(['--root', empty, 'ui', '--supervised'], base, {}, 'pipe');
      const done = await s.exit;
      expect(done.code).toBe(2);
      expect(done.out).toBe('{"type":"error","v":2,"code":"no_workspace"}\n');
      expect(done.err).toContain('no workspace here');
      // What an older CLI does with a flag it does not know: a usage error, nothing on stdout.
      const old = retake(['--root', ws, 'ui', '--no-such-flag'], base, {}, 'pipe');
      const o = await old.exit;
      expect([o.code, o.out]).toEqual([2, '']);
    });

    it('a server already runs: reused with the player origin, exit 0, the first server untouched', async () => {
      const first = retake(['--root', ws, 'ui', '--no-open', '--json']);
      const info = JSON.parse(await first.line) as { port: number; pid: number; player: string };
      const s = retake(['--root', ws, 'ui', '--supervised'], base, {}, 'pipe');
      const done = await s.exit;
      expect(done.code, done.err).toBe(0);
      expect(done.err).toBe('');
      expect(done.out.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(done.out.trim())).toMatchObject({ type: 'ui', v: 2, reused: true, port: info.port, pid: info.pid, player: info.player });
      expect(alive(info.pid)).toBe(true);
      expect((await fetch(`http://127.0.0.1:${info.port}/`)).status).toBe(200);
      first.child.kill('SIGTERM');
      expect((await first.exit).code).toBe(0);
    });
  });
});
