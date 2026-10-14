import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChromiumProbe } from '@demo-studio/runner-web';
import { EXIT, memoryIo } from '../src/index.js';
import { doctorCommand, systemProbes } from '../src/commands/doctor.js';
import type { DoctorCheck, DoctorProbes, ExecResult } from '../src/commands/doctor.js';
import { Ui } from '../src/ui.js';

const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));

let ws: string;
let profile: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-doctor-'));
  profile = join(ws, 'profiles', 'acme');
  await mkdir(profile, { recursive: true });
  await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\nffmpeg: /opt/media/bin/ffmpeg\n`);
  await mkdir(join(ws, 'projects', 'acme', 'scenarios'), { recursive: true });
  await writeFile(
    join(ws, 'projects', 'acme', 'project.yaml'),
    [
      'name: Acme',
      'environments:',
      '  staging: {app: "https://app.staging.example.com", admin: "https://admin.staging.example.com"}',
      '  prod: {app: "https://app.example.com"}',
      'default_env: staging',
      'auth:',
      `  staging: {profile: ${JSON.stringify(profile)}}`,
      `  prod: {profile: ${JSON.stringify(join(ws, 'profiles', 'acme-prod'))}}`,
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

const FFMPEG_VERSION = 'ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers\nbuilt with Apple clang\n';
const FFPROBE_VERSION = 'ffprobe version 7.1 Copyright (c) 2007-2024 the FFmpeg developers\n';

/** docker on a healthy Mac: Compose 2.29, the daemon running, context orbstack. */
async function dockerAnswers(cmd: string, args: string[]): Promise<ExecResult | null> {
  if (cmd !== '/usr/local/bin/docker') return null;
  const a = args.join(' ');
  if (a === 'compose version --short') return { code: 0, stdout: '2.29.1\n', stderr: '' };
  if (a.startsWith('info')) return { code: 0, stdout: '27.3.1\n', stderr: '' };
  if (a === 'context show') return { code: 0, stdout: 'orbstack\n', stderr: '' };
  return null;
}

/** A healthy Mac: everything present, every host answers. */
function macProbes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  const bins: Record<string, string> = { security: '/usr/bin/security', osascript: '/usr/bin/osascript', docker: '/usr/local/bin/docker' };
  return {
    platform: 'darwin',
    nodeVersion: '22.12.0',
    env: {},
    which: (cmd) => bins[cmd] ?? null,
    exec: async (cmd, args): Promise<ExecResult | null> => {
      if (cmd === '/opt/media/bin/ffmpeg') return { code: 0, stdout: FFMPEG_VERSION, stderr: '' };
      if (cmd === '/opt/media/bin/ffprobe') return { code: 0, stdout: FFPROBE_VERSION, stderr: '' };
      return dockerAnswers(cmd, args);
    },
    exists: (p) => existsSync(p),
    chromium: async (): Promise<ChromiumProbe> => ({
      path: '/Users/me/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      source: 'playwright',
      exists: true,
      launched: true,
      version: '141.0.7390.37',
      ms: 640,
    }),
    head: async () => ({ status: 200, ms: 42 }),
    ...over,
  };
}

async function doctor(probes: DoctorProbes, opts: { project?: string; json?: boolean } = {}) {
  const io = memoryIo();
  const code = await doctorCommand(new Ui(io), { root: ws }, opts, probes);
  return { code, out: io.stdout(), err: io.stderr() };
}

async function checks(probes: DoctorProbes, project?: string): Promise<{ code: number; checks: DoctorCheck[] }> {
  const r = await doctor(probes, { project, json: true });
  return { code: r.code, checks: (JSON.parse(r.out) as { checks: DoctorCheck[] }).checks };
}

const byName = (list: DoctorCheck[], name: string) => list.find((c) => c.name === name)!;

describe('studio doctor (mocked environment)', () => {
  it('a healthy Mac: one OK line per check, exit 0', async () => {
    const prodProfile = join(ws, 'profiles', 'acme-prod');
    await mkdir(prodProfile, { recursive: true });
    const r = await doctor(macProbes(), { project: 'acme' });
    await rm(prodProfile, { recursive: true });
    expect(r.code, r.err).toBe(EXIT.ok);
    for (const name of ['Node.js', 'Chromium', 'ffmpeg', 'ffprobe', 'Display', 'Secrets', 'Notifications', 'Docker', 'Workspace', 'Template default', 'Project acme']) {
      expect(r.err).toMatch(new RegExp(`OK +${name.replace('.', '\\.')} `));
    }
    expect(r.err).toContain('141.0.7390.37');
    expect(r.err).toContain('7.1 · /opt/media/bin/ffprobe'); // next to the configured ffmpeg
    expect(r.err).toContain('macOS Keychain via security');
    expect(r.err).toContain('osascript');
    expect(r.err).toMatch(/OK +Docker +27\.3\.1 · Compose 2\.29\.1 · context orbstack · \/usr\/local\/bin\/docker/);
    expect(r.err).toMatch(/OK +Profile \(staging\) +.*profiles\/acme$/m);
    expect(r.err).toMatch(/OK +Host staging·app +https:\/\/app\.staging\.example\.com → HTTP 200/);
    expect(r.err).toMatch(/0 failures/);
    expect(r.err).not.toMatch(/FAIL|WARN/);
  });

  it('Linux without display, secret-tool or notify-send: warnings with hints, still exit 0', async () => {
    const { code, checks: list } = await checks(macProbes({ platform: 'linux', which: () => null, env: {} }));
    expect(code).toBe(EXIT.ok);
    expect(byName(list, 'Display')).toMatchObject({ status: 'warn', hint: expect.stringContaining('--headed') });
    expect(byName(list, 'Secrets')).toMatchObject({ status: 'warn', detail: expect.stringContaining('secret-tool') });
    expect(byName(list, 'Notifications')).toMatchObject({ status: 'warn', detail: expect.stringContaining('notify-send') });
    const withDisplay = await checks(macProbes({ platform: 'linux', which: (c) => `/usr/bin/${c}`, env: { DISPLAY: ':0' } }));
    expect(byName(withDisplay.checks, 'Display')).toMatchObject({ status: 'ok', detail: expect.stringContaining('DISPLAY=:0') });
    expect(byName(withDisplay.checks, 'Secrets').status).toBe('ok');
  });

  it('old Node, missing ffmpeg/ffprobe and a Chromium that does not launch are failures: exit 1', async () => {
    const r = await doctor(
      macProbes({
        nodeVersion: '20.11.1',
        exec: async () => null,
        chromium: async () => ({ path: '/opt/chromium/chrome', source: 'DEMO_STUDIO_CHROMIUM', exists: true, launched: false, error: 'Failed to launch: missing libnss3.so' }),
      }),
    );
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toMatch(/FAIL +Node\.js +20\.11\.1 \(needs 22\+\)/);
    expect(r.err).toMatch(/FAIL +Chromium +\/opt\/chromium\/chrome \(DEMO_STUDIO_CHROMIUM\) did not launch headless: Failed to launch: missing libnss3\.so/);
    expect(r.err).toMatch(/FAIL +ffmpeg +\/opt\/media\/bin\/ffmpeg not found/);
    expect(r.err).toMatch(/→ install ffmpeg/);
    expect(r.err).toMatch(/4 failures/);
    // ffmpeg older than 5.1 has no -fps_mode (review, raw export); snapshot builds are not judged.
    const versioned = (v: string) => macProbes({ exec: async (cmd) => ({ code: 0, stdout: `${cmd.endsWith('ffprobe') ? 'ffprobe' : 'ffmpeg'} version ${v} Copyright\n`, stderr: '' }) });
    const old = await checks(versioned('4.4.2-0ubuntu0.22.04.1'));
    expect(byName(old.checks, 'ffmpeg')).toMatchObject({ status: 'fail', detail: expect.stringContaining('(needs 5.1+)'), hint: expect.stringContaining('upgrade ffmpeg') });
    expect(byName(old.checks, 'ffprobe')).toMatchObject({ status: 'fail' });
    expect(byName((await checks(versioned('5.0.3'))).checks, 'ffmpeg').status).toBe('fail');
    expect(byName((await checks(versioned('5.1.6'))).checks, 'ffmpeg').status).toBe('ok');
    expect(byName((await checks(versioned('n9.0.2'))).checks, 'ffmpeg').status).toBe('ok');
    expect(byName((await checks(versioned('N-117245-g0b097ed9f1'))).checks, 'ffmpeg').status).toBe('ok');
    expect(byName((await checks(versioned('2025-03-10-git-9d4b1a6ab2'))).checks, 'ffmpeg').status).toBe('ok');
    const missing = await checks(macProbes({ chromium: async () => ({ path: null, source: 'playwright', exists: false, launched: false }) }));
    expect(byName(missing.checks, 'Chromium')).toMatchObject({ status: 'fail', hint: expect.stringContaining('playwright-core install chromium') });
  });

  it('Docker (L1.8): missing, too old or stopped is a warning — a failure only when the --project\'s default sandbox is a docker-compose one (I6)', async () => {
    const noDocker = macProbes({ which: (c) => (c === 'docker' ? null : `/usr/bin/${c}`), exists: () => false });
    // Not on PATH: the places the sandbox package looks in too — OrbStack's xbin among them (K10).
    const xbin = '/Applications/OrbStack.app/Contents/MacOS/xbin/docker';
    const orb = macProbes({
      which: (c) => (c === 'docker' ? null : `/usr/bin/${c}`),
      exists: (p) => p === xbin,
      exec: async (cmd, args) => (cmd === xbin ? dockerAnswers('/usr/local/bin/docker', args) : null),
    });
    expect(byName((await checks(orb)).checks, 'Docker')).toMatchObject({ status: 'ok', detail: `27.3.1 · Compose 2.29.1 · context orbstack · ${xbin}` });
    expect(byName((await checks(noDocker)).checks, 'Docker')).toMatchObject({
      status: 'warn',
      detail: 'not found — only needed by docker-compose sandboxes',
      hint: expect.stringContaining('Docker Desktop or OrbStack'),
    });
    const answer = (over: Record<string, ExecResult>) =>
      macProbes({ exec: async (cmd, args) => over[args.join(' ').split(' ').slice(0, 2).join(' ')] ?? (await dockerAnswers(cmd, args)) });
    expect(byName((await checks(answer({ 'compose version': { code: 0, stdout: '2.12.0', stderr: '' } }))).checks, 'Docker')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('Compose 2.12.0 (needs 2.17.0+)'),
    });
    const stopped = answer({ 'info --format': { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.' } });
    expect(byName((await checks(stopped)).checks, 'Docker')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/^Compose 2\.29\.1, but the daemon is not running \(Cannot connect/), hint: 'start Docker Desktop or OrbStack' });
    // A project with a docker-compose sandbox needs it.
    const dir = join(ws, 'projects', 'boxed');
    await mkdir(join(dir, 'sandbox'), { recursive: true });
    await writeFile(join(dir, 'project.yaml'), 'name: Boxed\nenvironments:\n  local: {app: "http://localhost:9"}\nsandboxes: {demo: sandbox/sandbox.yaml}\n');
    await writeFile(join(dir, 'sandbox', 'compose.yaml'), 'services:\n  app: {image: busybox:1.38.0}\n');
    await writeFile(join(dir, 'sandbox', 'sandbox.yaml'), 'version: 1\nprovider: docker-compose\nservices:\n  app: {url: "http://localhost:4600", pages: {app: "http://localhost:4600"}}\n');
    try {
      const r = await checks(stopped, 'boxed');
      expect(r.code).toBe(EXIT.failure);
      expect(byName(r.checks, 'Docker')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/the daemon is not running .* — needed by the docker-compose sandbox demo of project boxed$/) });
      expect(byName((await checks(macProbes(), 'boxed')).checks, 'Docker').status).toBe('ok');
      // A process sandbox first (the default one), the docker-compose one optional — the fixture's layout: a warning.
      await mkdir(join(dir, 'sandbox', 'local'), { recursive: true });
      await writeFile(join(dir, 'sandbox', 'local', 'sandbox.yaml'), 'version: 1\nprovider: process\nservices:\n  app: {command: x, url: "http://localhost:4610", pages: {app: "http://localhost:4610"}}\n');
      await writeFile(join(dir, 'project.yaml'), 'name: Boxed\nenvironments:\n  local: {app: "http://localhost:9"}\nsandboxes: {box: sandbox/local/sandbox.yaml, demo: sandbox/sandbox.yaml}\n');
      const optional = await checks(stopped, 'boxed');
      expect(byName(optional.checks, 'Docker')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/the daemon is not running .* — needed by the docker-compose sandbox demo of project boxed$/) });
      // default_env naming the docker-compose one makes it the default sandbox again.
      await writeFile(join(dir, 'project.yaml'), 'name: Boxed\nenvironments:\n  local: {app: "http://localhost:9"}\nsandboxes: {box: sandbox/local/sandbox.yaml, demo: sandbox/sandbox.yaml}\ndefault_env: demo\n');
      expect(byName((await checks(stopped, 'boxed')).checks, 'Docker').status).toBe('fail');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--project: missing profile → warn (studio login), unreachable default environment → fail, other environment → warn', async () => {
    const { code, checks: list } = await checks(
      macProbes({ head: async (url) => (url.includes('admin') || url.includes('app.example.com') ? { error: 'ENOTFOUND', ms: 3 } : { status: 302, ms: 8 }) }),
      'acme',
    );
    expect(code).toBe(EXIT.failure);
    // The hints name the workspace root the command line gave (-C).
    expect(byName(list, 'Profile (prod)')).toMatchObject({ status: 'warn', hint: `sign in once: studio -C ${ws} login acme --env prod` });
    expect(byName(list, 'Host staging·app')).toMatchObject({ status: 'ok', detail: expect.stringContaining('HTTP 302') });
    expect(byName(list, 'Host staging·admin')).toMatchObject({ status: 'fail', detail: expect.stringContaining('ENOTFOUND') });
    expect(byName(list, 'Host prod·app')).toMatchObject({ status: 'warn' });
    // A profile in use by another browser.
    await writeFile(join(profile, 'SingletonLock'), '');
    const busy = await checks(macProbes(), 'acme');
    expect(byName(busy.checks, 'Profile (staging)')).toMatchObject({ status: 'warn', detail: expect.stringContaining('in use') });
    await rm(join(profile, 'SingletonLock'));
    const unknown = await checks(macProbes(), 'nope');
    expect(byName(unknown.checks, 'Project nope')).toMatchObject({ status: 'fail' });
  });

  it('a template whose fonts are missing is a failure', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'studio-doctor-tpl-'));
    try {
      await cp(join(TEMPLATES, 'default'), join(broken, 'templates', 'plain'), { recursive: true });
      await rm(join(broken, 'templates', 'plain', 'fonts', 'Inter-Bold.ttf'));
      await writeFile(join(broken, 'studio.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
      const io = memoryIo();
      const code = await doctorCommand(new Ui(io), { root: broken }, { json: true }, macProbes({ exec: async (cmd) => ({ code: 0, stdout: `${cmd.endsWith('ffprobe') ? 'ffprobe' : 'ffmpeg'} version 7.1\n`, stderr: '' }), which: (c) => `/usr/bin/${c}` }));
      const list = (JSON.parse(io.stdout()) as { checks: DoctorCheck[] }).checks;
      expect(code).toBe(EXIT.failure);
      expect(byName(list, 'Template plain')).toMatchObject({ status: 'fail', detail: expect.stringContaining('fonts/Inter-Bold.ttf') });
      expect(byName(list, 'Workspace')).toMatchObject({ status: 'warn', hint: expect.stringContaining('studio new') });
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });
});

describe('studio doctor (this machine)', () => {
  it('real probes: PATH lookup, ffmpeg version, HEAD on a live and a closed port', async () => {
    const p = systemProbes();
    expect(p.which('node')).toMatch(/node$/);
    expect(p.which('surely-not-a-command-xyz')).toBeNull();
    expect(await p.exec('surely-not-a-command-xyz', [], 1000)).toBeNull();
    const server = createServer((_req, res) => res.writeHead(204).end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await p.head(`http://127.0.0.1:${port}/`, 5000)).toMatchObject({ status: 204 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    const closed = await p.head(`http://127.0.0.1:${port}/`, 5000);
    expect(closed.status).toBeUndefined();
    expect(closed.error).toBeTruthy();
  });
});

describe('studio doctor --project: personas (R-AUTH-02)', () => {
  it('one line per persona (never signed in, valid, in use, expired) and where the sessions live (a git work tree)', async () => {
    const { writeStatus } = await import('@demo-studio/runner-web');
    const { personaPaths } = await import('@demo-studio/core');
    const root = await mkdtemp(join(tmpdir(), 'studio-doctor-personas-'));
    try {
      const home = join(root, 'repo', 'home');
      await mkdir(home, { recursive: true });
      await mkdir(join(ws, 'projects', 'shop', 'scenarios'), { recursive: true });
      await writeFile(
        join(ws, 'projects', 'shop', 'project.yaml'),
        [
          'name: Shop',
          'environments:',
          '  staging: {app: "https://app.staging.example.com", admin: "https://admin.staging.example.com"}',
          'auth:',
          '  staging:',
          '    login_url: /login',
          '    personas:',
          '      editor: {pages: [app], check: {expect_text: Jane}}',
          '      viewer: {pages: [admin], check: {expect_text: Joe}}',
          '      ops: {session: storage_state, check: {url: "app:/ops", expect_text: Ops}}',
          '      newbie: {check: {url: "app:/", expect_text: New}}',
          '      quiet: {session: storage_state, check: {url: "app:/", expect_text: Quiet}}',
          '',
        ].join('\n'),
      );
      const files = (persona: string) => personaPaths(home, 'shop', 'staging', persona);
      for (const persona of ['editor', 'viewer']) {
        await mkdir(files(persona).profileDir, { recursive: true });
        await writeFile(join(files(persona).profileDir, 'Local State'), '{}');
      }
      await writeStatus(files('editor').statusFile, { status: 'valid', by: 'preflight', run: '20261013-101010-quote', detail: 'app:/ shows "Jane"' });
      await writeFile(join(files('viewer').profileDir, 'SingletonLock'), '');
      await writeFile(files('ops').snapshot, '{"cookies":[],"origins":[]}');
      await writeStatus(files('ops').statusFile, { status: 'expired', by: 'auth-status', detail: 'app:/ops landed on the sign-in page (https://app.staging.example.com/login)' });
      await writeFile(files('quiet').snapshot, '{"cookies":[],"origins":[]}');
      const real = systemProbes();
      const probes = macProbes({ env: { DEMO_STUDIO_HOME: home }, exec: (cmd, args, ms) => (cmd === 'git' ? real.exec(cmd, args, ms) : macProbes().exec(cmd, args, ms)) });
      const outside = await checks(probes, 'shop');
      expect(byName(outside.checks, 'Session home')).toMatchObject({ status: 'ok', detail: `${home} (DEMO_STUDIO_HOME) · outside any git work tree` });
      expect(byName(outside.checks, 'Persona staging·editor')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^valid · checked (just now|\d+ s ago) \(preflight of run 20261013-101010-quote\) · profile$/) });
      expect(byName(outside.checks, 'Persona staging·viewer')).toMatchObject({ status: 'warn', detail: 'its profile is in use by a browser', hint: expect.stringContaining('close the studio login window') });
      expect(byName(outside.checks, 'Persona staging·ops')).toMatchObject({
        status: 'warn',
        detail: expect.stringMatching(/^expired · checked .* \(auth status --check\): app:\/ops landed on the sign-in page/),
        hint: `sign in again: studio -C ${ws} login shop --env staging --persona ops`,
      });
      expect(byName(outside.checks, 'Persona staging·newbie')).toMatchObject({ status: 'warn', detail: 'never signed in', hint: `sign in once: studio -C ${ws} login shop --env staging --persona newbie` });
      expect(byName(outside.checks, 'Persona staging·quiet')).toMatchObject({ status: 'ok', detail: `snapshot saved, not checked yet (studio -C ${ws} auth status --project shop --check)` });
      expect(outside.checks.find((c) => c.name === 'Profile')).toBeUndefined();
      // The studio home inside a git work tree: a warning, unless git ignores it.
      await real.exec('git', ['init', '-q', join(root, 'repo')], 10_000);
      const inside = await checks(probes, 'shop');
      expect(byName(inside.checks, 'Session home')).toMatchObject({ status: 'warn', detail: expect.stringContaining('is inside the git work tree'), hint: expect.stringContaining('DEMO_STUDIO_HOME') });
      expect(byName(inside.checks, 'Session home').detail).toContain('not ignored');
      expect(byName(inside.checks, 'Persona staging·editor').status).toBe('ok');
      await writeFile(join(root, 'repo', '.gitignore'), 'home/\n');
      const ignored = await checks(probes, 'shop');
      expect(byName(ignored.checks, 'Session home')).toMatchObject({ status: 'ok', detail: expect.stringContaining(', ignored by git') });
    } finally {
      await rm(join(ws, 'projects', 'shop'), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a profile of the single-account form in a git work tree, not ignored: a warning', async () => {
    const real = systemProbes();
    const repo = await mkdtemp(join(tmpdir(), 'studio-doctor-git-'));
    try {
      await real.exec('git', ['init', '-q', repo], 10_000);
      const inRepo = join(repo, 'profiles', 'acme');
      await mkdir(inRepo, { recursive: true });
      await mkdir(join(ws, 'projects', 'legacy', 'scenarios'), { recursive: true });
      await writeFile(join(ws, 'projects', 'legacy', 'project.yaml'), `name: Legacy\nenvironments:\n  prod: {app: "https://app.example.com"}\nauth: {profile: ${JSON.stringify(inRepo)}}\n`);
      const probes = macProbes({ exec: (cmd, args, ms) => (cmd === 'git' ? real.exec(cmd, args, ms) : macProbes().exec(cmd, args, ms)) });
      const list = (await checks(probes, 'legacy')).checks;
      expect(byName(list, 'Profile')).toMatchObject({ status: 'warn', detail: expect.stringContaining('is inside the git work tree'), hint: expect.stringContaining('auth.personas') });
    } finally {
      await rm(join(ws, 'projects', 'legacy'), { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    }
  });
});
