/**
 * `studio ui` from the built entry point (`pnpm build` first; skipped without dist): `--no-open --json` prints one JSON
 * line and nothing on stderr, serves the app and `/v1` on 127.0.0.1, writes `.demo-studio/ui.json` (0600); a second
 * `studio ui` reuses the running server with a fresh one-time link and exits 0 (warning when --port names another
 * port); SIGTERM stops the first and removes the file; an unwritable state folder is a refusal with a fix (exit 1); a
 * folder that is not a workspace is a usage error naming --root.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureWorkspace } from '../../engine/test/helpers.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');
const built = existsSync(BIN) && existsSync(join(dirname(BIN), '..', '..', 'ui', 'dist', 'index.js'));

let base: string;
let ws: string;
const children: ChildProcess[] = [];

interface Started {
  child: ChildProcess;
  line: Promise<string>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }>;
}

function studio(args: string[], cwd = base): Started {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, DEMO_STUDIO_HOME: join(base, 'home'), DEMO_STUDIO_ROOT: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { child, line, exit };
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

describe.skipIf(!built)('studio ui (built CLI)', () => {
  it('serves, prints one JSON line, reuses the running server, stops on SIGTERM and removes ui.json', async () => {
    const first = studio(['--root', ws, 'ui', '--no-open', '--json']);
    const info = JSON.parse(await first.line) as { type: string; url: string; port: number; pid: number; reused: boolean };
    expect(info).toMatchObject({ type: 'ui', reused: false, pid: first.child.pid });
    expect(info.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${info.port}/#c=[A-Za-z0-9_-]{43}$`));
    const file = join(ws, '.demo-studio', 'ui.json');
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

    const second = await studio(['--root', ws, 'ui', '--no-open', '--json']).exit;
    expect(second.code, second.err).toBe(0);
    expect(second.err).toBe('');
    const again = JSON.parse(second.out.trim()) as { url: string; port: number; pid: number; reused: boolean };
    expect(again).toMatchObject({ reused: true, port: info.port, pid: first.child.pid });
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
    const first = studio(['--root', ws, 'ui', '--no-open', '--json']);
    const info = JSON.parse(await first.line) as { port: number };
    const other = info.port === 65000 ? 65001 : 65000;
    const second = await studio(['--root', ws, 'ui', '--no-open', '--json', '--port', String(other)]).exit;
    expect(second.code, second.err).toBe(0);
    expect(JSON.parse(second.out.trim())).toMatchObject({ reused: true, port: info.port });
    expect(second.err).toContain(`already serves this workspace on port ${info.port}: --port ${other} is not used`);
    // The same port, or none: no warning.
    const same = await studio(['--root', ws, 'ui', '--no-open', '--json', '--port', String(info.port)]).exit;
    expect(same.err).toBe('');
    first.child.kill('SIGTERM');
    expect((await first.exit).code).toBe(0);
  });

  it('a state folder it cannot write: exit 1 with what to do, no stack (review B L3)', async () => {
    const dir = join(base, 'ro');
    await mkdir(join(dir, 'projects'), { recursive: true });
    await writeFile(join(dir, 'studio.yaml'), 'projects_dir: projects\n');
    await mkdir(join(dir, '.demo-studio'), { mode: 0o500 });
    await chmod(join(dir, '.demo-studio'), 0o500);
    try {
      const r = await studio(['--root', dir, 'ui', '--no-open', '--json']).exit;
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toContain('.demo-studio is not writable (EACCES)');
      expect(r.err).toContain('fix: make it writable for you');
      expect(r.err).not.toMatch(/unexpected error|\n\s+at /);
    } finally {
      await chmod(join(dir, '.demo-studio'), 0o700);
    }
  });

  it('a folder that is not a workspace: exit 2 with the --root hint', async () => {
    const r = await studio(['ui', '--no-open', '--json'], base).exit;
    expect(r.code).toBe(2);
    expect(r.err).toContain('--root');
    expect(r.out).toBe('');
  });
});
