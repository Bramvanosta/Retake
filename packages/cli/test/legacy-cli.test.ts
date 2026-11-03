/**
 * old-name: this whole file (the guard test allows it).
 *
 * L5.13 — the CLI and an installation from before the rename:
 * - doctor's "Before Retake" lines (D7, critique M5 / L9 / H3): the old home (four cases, the swap when the tool
 *   recreated ~/.retake), the old variables, the old workspace file (a FAIL line, never a crash), the old tool folders
 *   with their pending rollback journals — each with its command; nothing when nothing is old; stats and listings only,
 *   none under the old home when RETAKE_HOME is set;
 * - the old-home line at CLI start, on stderr only: the built CLI's `--version` and `ui --supervised` keep stdout to
 *   their own output (critique H3 / L10); the old variables set without their new twin, by name (reviews A M4 / B M4);
 * - a project's .gitignore naming only the old folder (review B M1);
 * - `env reset` and `record` refuse beside an old Studio, with the fix line (review A L3, B M2).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkspaceConfig } from '@retake/core';
import { processStart } from '@retake/sandbox';
import { main, memoryIo } from '../src/index.js';
import { beforeRetakeChecks, doctorCommand } from '../src/commands/doctor.js';
import type { DoctorCheck, DoctorProbes } from '../src/commands/doctor.js';
import { Ui } from '../src/ui.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');
const built = existsSync(BIN) && existsSync(join(dirname(BIN), '..', '..', 'ui', 'dist', 'index.js'));

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'retake-legacy-cli-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const H = '/scratch/home';
const W: WorkspaceConfig = { root: '/scratch/ws', projectsDir: '/scratch/ws/projects', templatesDir: '/scratch/ws/templates', componentsDir: '/scratch/ws/components' };

/** Probes over a listed tree, recording every path looked at. */
function probes(env: Record<string, string | undefined>, paths: string[], lists: Record<string, string[]> = {}, files: Record<string, string> = {}): DoctorProbes & { seen: string[] } {
  const seen: string[] = [];
  const has = (p: string) => paths.some((x) => p === x || x.startsWith(`${p}/`));
  return {
    seen,
    platform: 'darwin',
    nodeVersion: '22.12.0',
    env,
    which: () => null,
    exec: async () => null,
    exists: (p) => (seen.push(p), has(p)),
    list: (dir) => (seen.push(dir), lists[dir] ?? null),
    read: (file) => (seen.push(file), files[file] ?? null),
    chromium: async () => ({ path: null, source: 'playwright', exists: false, launched: false }),
    head: async () => ({ status: 200, ms: 1 }),
  };
}

const lines = (c: DoctorCheck[]) => c.map((x) => `${x.status} ${x.name}: ${x.detail} → ${x.hint}`);

describe('doctor: Before Retake', () => {
  it('nothing old: no line', () => {
    expect(beforeRetakeChecks(probes({ HOME: H }, [`${W.root}/retake.yaml`]), W)).toEqual([]);
  });

  it('the old home: the move; the swap when the tool recreated ~/.retake; both holding sign-ins; no sign-ins', () => {
    expect(lines(beforeRetakeChecks(probes({ HOME: H }, [`${H}/.demo-studio/profiles/p/local/buyer`]), W))).toEqual([
      'warn Before Retake: home: ~/.demo-studio holds the sign-ins from before the rename and is not read → stop the Studio, the desktop app, MCP clients and the worker first, then: mv ~/.demo-studio ~/.retake',
    ]);
    expect(lines(beforeRetakeChecks(probes({ HOME: H }, [`${H}/.demo-studio/sessions/p`, `${H}/.retake/approvals.key`]), W))).toEqual([
      'warn Before Retake: home: ~/.demo-studio holds the sign-ins from before the rename and is not read; ~/.retake holds only files the tool recreated by itself (approvals.key, mcp-http.token, desktop.json) → stop the Studio, the desktop app, MCP clients and the worker first, then: mv ~/.retake ~/.retake.after-upgrade && mv ~/.demo-studio ~/.retake',
    ]);
    expect(beforeRetakeChecks(probes({ HOME: H }, [`${H}/.demo-studio/profiles`, `${H}/.retake/sessions`]), W)[0].detail).toBe('~/.demo-studio and ~/.retake both hold sign-ins: only ~/.retake is read');
    expect(beforeRetakeChecks(probes({ HOME: H }, [`${H}/.demo-studio/approvals.key`]), W)[0].detail).toBe('~/.demo-studio (from before the rename) is not read; it holds no sign-ins');
  });

  it('the old home variable set: the folder it names is the old home — named with the variable, set RETAKE_HOME to it or move it; the old default home not looked at (L5.13a leftover)', () => {
    const out = '/Volumes/disk/old home';
    const p = probes({ HOME: H, DEMO_STUDIO_HOME: out }, [`${out}/profiles/p/local/buyer`, `${H}/.demo-studio/profiles`]);
    expect(lines(beforeRetakeChecks(p, W))[0]).toBe(
      "warn Before Retake: home: /Volumes/disk/old home (set by DEMO_STUDIO_HOME) holds the sign-ins from before the rename and is not read → set RETAKE_HOME to '/Volumes/disk/old home' where DEMO_STUDIO_HOME is set, or move it: stop the Studio, the desktop app, MCP clients and the worker first, then: mv '/Volumes/disk/old home' ~/.retake",
    );
    expect(p.seen.filter((x) => x.startsWith(`${H}/.demo-studio`))).toEqual([]);
    // Under the home: shown with ~/; the variable's folder without sign-ins says so; the plain case is unchanged above.
    expect(beforeRetakeChecks(probes({ HOME: H, DEMO_STUDIO_HOME: '~/dsh' }, [`${H}/dsh/approvals.key`]), W)[0].detail).toBe('~/dsh (set by DEMO_STUDIO_HOME, from before the rename) is not read; it holds no sign-ins');
    // RETAKE_HOME set: neither is looked at.
    const set = probes({ HOME: H, DEMO_STUDIO_HOME: out, RETAKE_HOME: '/scratch/h' }, [`${out}/profiles`]);
    expect(beforeRetakeChecks(set, W).filter((c) => c.name.endsWith('home'))).toEqual([]);
    expect(set.seen.filter((x) => x.startsWith(out) || x.startsWith(H))).toEqual([]);
  });

  it('RETAKE_HOME set, or no HOME in the probes: the old home is not even looked at', () => {
    for (const env of [{ HOME: H, RETAKE_HOME: '/scratch/h' }, {}]) {
      const p = probes(env, [`${H}/.demo-studio/profiles`]);
      expect(beforeRetakeChecks(p, W)).toEqual([]);
      expect(p.seen.filter((s) => s.startsWith(H))).toEqual([]);
    }
  });

  it('the old variables, by name; the old workspace file next to retake.yaml', async () => {
    const ws = join(tmp, 'both');
    await mkdir(join(ws, 'projects'), { recursive: true });
    await writeFile(join(ws, 'retake.yaml'), 'version: 1\n');
    await writeFile(join(ws, 'studio.yaml'), 'version: 1\n');
    const cfg = { ...W, root: ws, projectsDir: join(ws, 'projects') };
    expect(lines(beforeRetakeChecks(probes({ DEMO_STUDIO_HOME: '/h', DEMO_STUDIO_ROOT: '/w', RETAKE_ROOT: '/w' }, [join(ws, 'retake.yaml')]), cfg))).toEqual([
      'warn Before Retake: variables: DEMO_STUDIO_HOME, DEMO_STUDIO_ROOT set: not read any more → rename them RETAKE_* (DEMO_STUDIO_HOME → RETAKE_HOME…) where they are set: your shell profile, the env of an MCP registration',
      `warn Before Retake: workspace file: ${join(ws, 'studio.yaml')} (from before the rename) lies next to retake.yaml: not read → copy what it still holds into retake.yaml, then remove it`,
    ]);
  });

  it('the old tool folders of the workspace and its projects, with their pending journals; next to .retake/, by hand', () => {
    const p = probes({}, [`${W.root}/.demo-studio/jobs`, `${W.projectsDir}/acme/.demo-studio/journals/hooks-local.json`, `${W.projectsDir}/beta/.demo-studio/sandbox`, `${W.projectsDir}/beta/.retake/sandbox`], {
      [W.projectsDir]: ['beta', 'acme', 'plain'],
      [`${W.projectsDir}/acme/.demo-studio/journals`]: ['hooks-local.json', 'env-reset.json', 'notes.txt'],
    });
    expect(lines(beforeRetakeChecks(p, W))).toEqual([
      'warn Before Retake: workspace folder: /scratch/ws/.demo-studio (the tool\'s folder from before the rename) is not read → stop the Studio, the worker and the project\'s sandboxes, then: mv /scratch/ws/.demo-studio /scratch/ws/.retake',
      'warn Before Retake: project acme: /scratch/ws/projects/acme/.demo-studio (the tool\'s folder from before the rename) is not read · 2 pending rollback journals (retake env reset finds them only once moved) → stop the Studio, the worker and the project\'s sandboxes, then: mv /scratch/ws/projects/acme/.demo-studio /scratch/ws/projects/acme/.retake',
      'warn Before Retake: project beta: /scratch/ws/projects/beta/.demo-studio (the tool\'s folder from before the rename) is not read, next to .retake/ → move what you still need from it (journals/, records/…) into /scratch/ws/projects/beta/.retake by hand, then remove it',
    ]);
  });

  it('a .gitignore of the workspace or a project that ignores the old folder and not .retake/: the line to add (review B M1)', () => {
    const p = probes({}, [], { [W.projectsDir]: ['acme', 'beta', 'gamma'] }, {
      [`${W.projectsDir}/acme/.gitignore`]: 'runs/\nrenders/\n.demo-studio/\n',
      [`${W.projectsDir}/beta/.gitignore`]: 'runs/\n.demo-studio/\n.retake/\n',
      [`${W.root}/.gitignore`]: 'node_modules/\n/.demo-studio\n',
    });
    expect(lines(beforeRetakeChecks(p, W))).toEqual([
      "warn Before Retake: workspace .gitignore: /scratch/ws/.gitignore ignores .demo-studio/ but not .retake/ (the tool's state of this machine) → add it: printf '.retake/\\n' >> /scratch/ws/.gitignore",
      "warn Before Retake: project acme .gitignore: /scratch/ws/projects/acme/.gitignore ignores .demo-studio/ but not .retake/ (the tool's state of this machine) → add it: printf '.retake/\\n' >> /scratch/ws/projects/acme/.gitignore",
    ]);
  });

  it('a workspace whose only workspace file is the old one: a FAIL line with the mv, the other checks still run', async () => {
    const ws = join(tmp, 'old-only');
    await mkdir(join(ws, 'projects'), { recursive: true });
    await writeFile(join(ws, 'studio.yaml'), 'version: 1\nprojects_dir: projects\n');
    const io = memoryIo();
    const code = await doctorCommand(new Ui(io), { root: ws }, { json: true }, probes({}, []));
    const checks = (JSON.parse(io.stdout()) as { checks: DoctorCheck[] }).checks;
    expect(code).toBe(1);
    expect(checks.find((c) => c.name === 'Before Retake: workspace file')).toEqual({
      status: 'fail',
      name: 'Before Retake: workspace file',
      detail: `${join(ws, 'studio.yaml')} is the workspace file from before L5.13 (Demo Studio): it is not read any more`,
      hint: `rename it: mv ${join(ws, 'studio.yaml')} ${join(ws, 'retake.yaml')}`,
    });
    expect(checks.map((c) => c.name)).toContain('Node.js');
  });
});

describe.skipIf(!built)('the old-home line at CLI start (built CLI)', () => {
  let home: string;
  beforeAll(async () => {
    home = join(tmp, 'home');
    await mkdir(join(home, '.demo-studio', 'sessions', 'p'), { recursive: true });
  });
  const env = () => {
    const e: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };
    return e;
  };

  it('on stderr, once; stdout keeps the command\'s own output; not shown once RETAKE_HOME is set', () => {
    const r = spawnSync(process.execPath, [BIN, '--version'], { env: env(), encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.stderr).toBe('Retake keeps sign-ins in ~/.retake; ~/.demo-studio (from before the rename) is not read — stop the Studio, MCP clients and the worker, then: mv ~/.demo-studio ~/.retake (retake doctor says more)\n');
    const set = spawnSync(process.execPath, [BIN, '--version'], { env: { ...env(), RETAKE_HOME: join(tmp, 'scratch-home') }, encoding: 'utf8' });
    expect(set.stderr).toBe('');
  });

  it('old variables set without their new twin: named on stderr, values never; stdout keeps the version (reviews A M4, B M4)', () => {
    const scratch = join(tmp, 'scratch-home');
    const r = spawnSync(process.execPath, [BIN, '--version'], { env: { ...env(), RETAKE_HOME: scratch, DEMO_STUDIO_HOME: '/Volumes/old/home', DEMO_STUDIO_ROOT: '/old/ws' }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(r.stderr).toBe("DEMO_STUDIO_ROOT is set but no longer read: rename it RETAKE_ROOT where it is set — shell profile, the MCP registration's env\n");
    const both = spawnSync(process.execPath, [BIN, '--version'], { env: { ...env(), RETAKE_HOME: scratch, RETAKE_ROOT: '/w', DEMO_STUDIO_ROOT: '/old/ws', DEMO_STUDIO_SANDBOX: 'x' }, encoding: 'utf8' });
    expect(both.stderr).toBe('');
  });

  it('ui --supervised: stdout is its JSON lines only, the line on stderr', async () => {
    const ws = join(tmp, 'ws-ui');
    await mkdir(join(ws, 'projects'), { recursive: true });
    await writeFile(join(ws, 'retake.yaml'), 'version: 1\n');
    const child = spawn(process.execPath, [BIN, '--root', ws, 'ui', '--supervised'], { env: { ...env(), RETAKE_ROOT: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    const first = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
        if (out.includes('\n')) resolve(out.split('\n')[0]);
      });
      child.on('exit', () => reject(new Error(`exited: ${err}`)));
    });
    expect(JSON.parse(first)).toMatchObject({ type: 'ui', v: 2 });
    child.stdin.end();
    await new Promise((r) => child.on('exit', r));
    for (const l of out.split('\n').filter(Boolean)) expect(() => JSON.parse(l), l).not.toThrow();
    expect(err).toContain('Retake keeps sign-ins in ~/.retake; ~/.demo-studio (from before the rename) is not read');
  });
});

describe('commands that take a lock refuse beside an old Studio, with the fix line (reviews A L3, B M2)', () => {
  let sleeper: ReturnType<typeof spawn>;
  let ws: string;
  beforeAll(async () => {
    sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    const started = new Date((await processStart(sleeper.pid!))!).toISOString();
    ws = join(tmp, 'ws-holder');
    await mkdir(join(ws, 'projects', 'acme', 'scenarios'), { recursive: true });
    await writeFile(join(ws, 'retake.yaml'), 'version: 1\n');
    await writeFile(join(ws, 'projects', 'acme', 'project.yaml'), 'name: Acme\nenvironments:\n  local: {app: "http://127.0.0.1:9"}\n');
    await mkdir(join(ws, '.demo-studio'), { recursive: true });
    await writeFile(join(ws, '.demo-studio', 'ui.json'), JSON.stringify({ version: 1, kind: 'ui', pid: sleeper.pid, started_at: started, port: 4999, since: '2026-11-01T10:00:00.000Z' }));
  });
  afterAll(() => {
    sleeper?.kill('SIGKILL');
  });

  async function refused(args: string[], doing: string): Promise<void> {
    const io = memoryIo();
    const code = await main(['node', 'retake', '--root', ws, ...args], io);
    expect(code).toBe(1);
    const err = io.stderr();
    expect(err).toContain(`a Studio from before the rename (Demo Studio, pid ${sleeper.pid}) still runs on this workspace — ${doing} would run beside it`);
    expect(err).toContain(`fix: quit the Demo Studio app, or stop that Studio (Ctrl-C in its terminal), then try again — or remove ${join(ws, '.demo-studio', 'ui.json')} if no old Studio or worker runs`);
  }

  it('retake env reset', async () => {
    await refused(['env', 'reset', 'acme'], 'this env reset');
  });

  it('retake record', async () => {
    await refused(['record', 'acme'], 'this recording');
  });
});
