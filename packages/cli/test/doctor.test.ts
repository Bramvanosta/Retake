import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BundleInfo } from '@retake/core/io';
import type { ChromiumProbe } from '@retake/runner-web';
import { EXIT, memoryIo } from '../src/index.js';
import { agentJobsCheck, doctorCommand, systemProbes } from '../src/commands/doctor.js';
import type { DoctorCheck, DoctorProbes, ExecResult } from '../src/commands/doctor.js';
import { Ui } from '../src/ui.js';

const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));

let ws: string;
let profile: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-doctor-'));
  profile = join(ws, 'profiles', 'acme');
  await mkdir(profile, { recursive: true });
  await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\nffmpeg: /opt/media/bin/ffmpeg\n`);
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
      if (cmd === '/opt/media/bin/ffmpeg' && args.includes('h264_videotoolbox')) return { code: 0, stdout: '', stderr: '' };
      if (cmd === '/opt/media/bin/ffmpeg') return { code: 0, stdout: FFMPEG_VERSION, stderr: '' };
      if (cmd === '/opt/media/bin/ffprobe') return { code: 0, stdout: FFPROBE_VERSION, stderr: '' };
      return dockerAnswers(cmd, args);
    },
    // retake.yaml's ffmpeg has its ffprobe beside it (core resolveMediaTools looks there first).
    exists: (p) => p === '/opt/media/bin/ffprobe' || existsSync(p),
    chromium: async (): Promise<ChromiumProbe> => ({
      path: '/Users/me/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      source: 'playwright',
      exists: true,
      launched: true,
      version: '141.0.7390.37',
      ms: 640,
      gpu: { accelerated: true, renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4)' },
      sandbox: { on: true, off: [] },
    }),
    head: async () => ({ status: 200, ms: 42 }),
    execPath: '/opt/homebrew/bin/node',
    worker: async () => null,
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

describe('retake doctor (mocked environment)', () => {
  it('a healthy Mac: one OK line per check, exit 0', async () => {
    const prodProfile = join(ws, 'profiles', 'acme-prod');
    await mkdir(prodProfile, { recursive: true });
    const r = await doctor(macProbes(), { project: 'acme' });
    await rm(prodProfile, { recursive: true });
    expect(r.code, r.err).toBe(EXIT.ok);
    for (const name of [
      'Node.js',
      'Chromium',
      'Chromium sandbox',
      'GPU',
      'ffmpeg',
      'ffprobe',
      'Capture encoder',
      'Display',
      'Secrets',
      'Notifications',
      'Docker',
      'Workspace',
      'Template default',
      'Project acme',
    ]) {
      expect(r.err).toMatch(new RegExp(`OK +${name.replace('.', '\\.')} `));
    }
    expect(r.err).toContain('141.0.7390.37');
    expect(r.err).toMatch(/OK +GPU +hardware accelerated · ANGLE \(Apple, ANGLE Metal Renderer: Apple M4\)/);
    expect(r.err).toMatch(/OK +Capture encoder +hardware H\.264 \(VideoToolbox\) during the take/);
    expect(r.err).toContain('7.1 · /opt/media/bin/ffprobe'); // next to the configured ffmpeg
    expect(r.err).toContain('macOS Keychain via security');
    expect(r.err).toContain('osascript');
    expect(r.err).toMatch(/OK +Docker +27\.3\.1 · Compose 2\.29\.1 · context orbstack · \/usr\/local\/bin\/docker/);
    expect(r.err).toMatch(/OK +Profile \(staging\) +.*profiles\/acme$/m);
    expect(r.err).toMatch(/OK +Host staging·app +https:\/\/app\.staging\.example\.com → HTTP 200/);
    expect(r.err).toMatch(/0 failures/);
    expect(r.err).not.toMatch(/FAIL|WARN/);
  });

  it('a capture browser without its GPU, an ffmpeg without VideoToolbox: warnings with the fix (L5.7, R-FLD-24)', async () => {
    const software = { accelerated: false, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))', software: ['gpu_compositing', 'rasterization'] };
    const probe = async (): Promise<ChromiumProbe> => ({ path: '/c/Chromium', source: 'playwright', exists: true, launched: true, version: '141', ms: 500, gpu: software });
    const { code, checks: list } = await checks(
      macProbes({
        chromium: probe,
        exec: async (cmd, args) =>
          cmd === '/opt/media/bin/ffmpeg' && args.includes('h264_videotoolbox') ? { code: 1, stdout: '', stderr: 'Unknown encoder h264_videotoolbox\n' } : macProbes().exec(cmd, args, 1000),
      }),
    );
    expect(code).toBe(EXIT.ok);
    expect(byName(list, 'GPU')).toMatchObject({
      status: 'warn',
      detail: 'the capture browser renders in software · ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device)) · in software: gpu_compositing, rasterization',
      hint: expect.stringContaining('choppy'),
    });
    expect(byName(list, 'Capture encoder')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('Unknown encoder h264_videotoolbox'),
      hint: expect.stringContaining('brew install ffmpeg'),
    });
    // A Chromium that did not launch has no GPU line; Linux encodes with libx264.
    const down = await checks(macProbes({ chromium: async () => ({ path: '/c/Chromium', source: 'playwright', exists: true, launched: false, error: 'boom' }) }));
    expect(down.checks.some((c) => c.name === 'GPU')).toBe(false);
    const linux = await checks(macProbes({ platform: 'linux', which: () => null }));
    expect(byName(linux.checks, 'Capture encoder')).toMatchObject({ status: 'ok', detail: 'libx264 (preset veryfast) during the take' });
  });

  it("the capture browser's sandbox, read from its own command line: on, off through a wrapper executable, not reported", async () => {
    const at = (over: Partial<ChromiumProbe>) => async (): Promise<ChromiumProbe> => ({
      path: '/c/Chromium',
      source: 'playwright',
      exists: true,
      launched: true,
      version: '141',
      ms: 500,
      gpu: { accelerated: true },
      ...over,
    });
    const on = await checks(macProbes({ chromium: at({ sandbox: { on: true, off: [] } }) }));
    expect(byName(on.checks, 'Chromium sandbox')).toMatchObject({ status: 'ok', detail: "on · read from the capture browser's command line" });
    const wrapped = await checks(macProbes({ chromium: at({ source: 'RETAKE_CHROMIUM', sandbox: { on: false, off: ['--no-sandbox'] } }) }));
    expect(wrapped.code).toBe(EXIT.failure);
    expect(byName(wrapped.checks, 'Chromium sandbox')).toMatchObject({
      status: 'fail',
      detail: 'off: the capture browser runs with --no-sandbox',
      hint: expect.stringContaining('the executable of $RETAKE_CHROMIUM adds them itself'),
    });
    const silent = await checks(macProbes({ chromium: at({}) }));
    expect(byName(silent.checks, 'Chromium sandbox')).toMatchObject({ status: 'warn', detail: 'the capture browser did not report its command line' });
    // No line for a browser that did not launch; a sandbox that cannot start on Linux says what it needs.
    const linux = await checks(macProbes({ chromium: at({ launched: false, error: 'Chromium sandboxing failed! No usable sandbox!' }) }));
    expect(linux.checks.some((c) => c.name === 'Chromium sandbox')).toBe(false);
    expect(byName(linux.checks, 'Chromium')).toMatchObject({ status: 'fail', hint: expect.stringContaining('unprivileged user namespaces') });
    // As root, Chromium refuses its sandbox: the hint says to run as a regular user, never to turn the sandbox off.
    const root = await checks(macProbes({ chromium: at({ launched: false, error: 'Running as root without --no-sandbox is not supported. See https://crbug.com/638180.' }) }));
    expect(byName(root.checks, 'Chromium')).toMatchObject({ status: 'fail', hint: expect.stringMatching(/does not run sandboxed as root.*run Retake as a regular user/) });
    expect(byName(root.checks, 'Chromium').hint).not.toMatch(/user namespaces/);
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
        chromium: async () => ({ path: '/opt/chromium/chrome', source: 'RETAKE_CHROMIUM', exists: true, launched: false, error: 'Failed to launch: missing libnss3.so' }),
      }),
    );
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toMatch(/FAIL +Node\.js +20\.11\.1 \(needs 22\+\)/);
    expect(r.err).toMatch(/FAIL +Chromium +\/opt\/chromium\/chrome \(RETAKE_CHROMIUM\) did not launch headless: Failed to launch: missing libnss3\.so/);
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

  it("Docker (L1.8): missing, too old or stopped is a warning — a failure only when the --project's default sandbox is a docker-compose one (I6)", async () => {
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
    const answer = (over: Record<string, ExecResult>) => macProbes({ exec: async (cmd, args) => over[args.join(' ').split(' ').slice(0, 2).join(' ')] ?? (await dockerAnswers(cmd, args)) });
    expect(byName((await checks(answer({ 'compose version': { code: 0, stdout: '2.12.0', stderr: '' } }))).checks, 'Docker')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('Compose 2.12.0 (needs 2.17.0+)'),
    });
    const stopped = answer({ 'info --format': { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.' } });
    expect(byName((await checks(stopped)).checks, 'Docker')).toMatchObject({
      status: 'warn',
      detail: expect.stringMatching(/^Compose 2\.29\.1, but the daemon is not running \(Cannot connect/),
      hint: 'start Docker Desktop or OrbStack',
    });
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
      await writeFile(
        join(dir, 'sandbox', 'local', 'sandbox.yaml'),
        'version: 1\nprovider: process\nservices:\n  app: {command: x, url: "http://localhost:4610", pages: {app: "http://localhost:4610"}}\n',
      );
      await writeFile(join(dir, 'project.yaml'), 'name: Boxed\nenvironments:\n  local: {app: "http://localhost:9"}\nsandboxes: {box: sandbox/local/sandbox.yaml, demo: sandbox/sandbox.yaml}\n');
      const optional = await checks(stopped, 'boxed');
      expect(byName(optional.checks, 'Docker')).toMatchObject({
        status: 'warn',
        detail: expect.stringMatching(/the daemon is not running .* — needed by the docker-compose sandbox demo of project boxed$/),
      });
      // default_env naming the docker-compose one makes it the default sandbox again.
      await writeFile(
        join(dir, 'project.yaml'),
        'name: Boxed\nenvironments:\n  local: {app: "http://localhost:9"}\nsandboxes: {box: sandbox/local/sandbox.yaml, demo: sandbox/sandbox.yaml}\ndefault_env: demo\n',
      );
      expect(byName((await checks(stopped, 'boxed')).checks, 'Docker').status).toBe('fail');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--project: missing profile → warn (retake login), unreachable default environment → fail, other environment → warn', async () => {
    const { code, checks: list } = await checks(
      macProbes({ head: async (url) => (url.includes('admin') || url.includes('app.example.com') ? { error: 'ENOTFOUND', ms: 3 } : { status: 302, ms: 8 }) }),
      'acme',
    );
    expect(code).toBe(EXIT.failure);
    // The hints name the workspace root the command line gave (-C).
    expect(byName(list, 'Profile (prod)')).toMatchObject({ status: 'warn', hint: `sign in once: retake -C ${ws} login acme --env prod` });
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

  it('the lines come in display order, one check each (L7.29): the machine, the workspace and its themes, then the project, its browser, its profiles, its hosts', async () => {
    const dir = join(ws, 'projects', 'ordered');
    await mkdir(join(dir, 'scenarios'), { recursive: true });
    await writeFile(
      join(dir, 'project.yaml'),
      [
        'name: Ordered',
        'environments:',
        '  staging: {app: "https://app.staging.example.com"}',
        '  prod: {app: "https://app.example.com"}',
        'browser: {executable: ./tools/chrome}',
        'auth:',
        `  staging: {profile: ${JSON.stringify(profile)}}`,
        '',
      ].join('\n'),
    );
    try {
      const { checks: list } = await checks(macProbes(), 'ordered');
      const names = list.map((c) => c.name);
      const themes = names.filter((n) => n.startsWith('Template '));
      expect(themes.length).toBeGreaterThan(0);
      expect(names).toEqual([
        'Node.js',
        'Chromium',
        'Chromium sandbox',
        'GPU',
        'ffmpeg',
        'ffprobe',
        'Capture encoder',
        'Display',
        'Secrets',
        'Notifications',
        'Docker',
        'Workspace',
        ...themes,
        'MCP',
        'Project ordered',
        'Project ordered: Studio and MCP jobs',
        'Profile (staging)',
        'Host staging·app',
        'Host prod·app',
      ]);
      // A project with a profile and no persona has no "none configured" line; one with neither has it, after its browser.
      await writeFile(join(dir, 'project.yaml'), ['name: Ordered', 'environments:', '  staging: {app: "https://app.staging.example.com"}', 'browser: {executable: ./tools/chrome}', ''].join('\n'));
      const bare = (await checks(macProbes(), 'ordered')).checks.map((c) => c.name);
      expect(bare.slice(bare.indexOf('Project ordered'))).toEqual(['Project ordered', 'Project ordered: Studio and MCP jobs', 'Profile', 'Host staging·app']);
      expect(byName((await checks(macProbes(), 'ordered')).checks, 'Profile')).toMatchObject({ status: 'ok', detail: 'none configured (a fresh temporary profile per run)' });
      // A damaged app bundle: its line right after Node.js.
      const damaged = (await checks(macProbes({ bundleProblems: () => ['manifest unreadable'] }))).checks.map((c) => c.name);
      expect(damaged.slice(0, 3)).toEqual(['Node.js', 'App bundle', 'Chromium']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('projects or themes that cannot be listed: a failure saying why, never "no projects" or "no themes"', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'studio-doctor-list-'));
    try {
      // A file where the folders should be: listing them fails (ENOTDIR).
      await writeFile(join(broken, 'projects'), 'not a folder\n');
      await writeFile(join(broken, 'themes'), 'not a folder\n');
      await writeFile(join(broken, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: themes\n');
      const io = memoryIo();
      const code = await doctorCommand(new Ui(io), { root: broken }, { json: true }, macProbes());
      const list = (JSON.parse(io.stdout()) as { checks: DoctorCheck[] }).checks;
      expect(code).toBe(EXIT.failure);
      expect(byName(list, 'Workspace')).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining('the projects cannot be listed: ENOTDIR'),
        hint: expect.stringContaining(join(broken, 'projects')),
      });
      expect(byName(list, 'Templates')).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining('the themes cannot be listed: ENOTDIR'),
        hint: expect.stringContaining(join(broken, 'themes')),
      });
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it('a template whose fonts are missing is a failure', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'studio-doctor-tpl-'));
    try {
      await cp(join(TEMPLATES, 'default'), join(broken, 'templates', 'plain'), { recursive: true });
      await rm(join(broken, 'templates', 'plain', 'fonts', 'Inter-Bold.ttf'));
      await writeFile(join(broken, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
      const io = memoryIo();
      const code = await doctorCommand(
        new Ui(io),
        { root: broken },
        { json: true },
        macProbes({ exec: async (cmd) => ({ code: 0, stdout: `${cmd.endsWith('ffprobe') ? 'ffprobe' : 'ffmpeg'} version 7.1\n`, stderr: '' }), which: (c) => `/usr/bin/${c}` }),
      );
      const list = (JSON.parse(io.stdout()) as { checks: DoctorCheck[] }).checks;
      expect(code).toBe(EXIT.failure);
      expect(byName(list, 'Template plain')).toMatchObject({ status: 'fail', detail: expect.stringContaining('fonts/Inter-Bold.ttf') });
      // The check names stay (the JSON reads them); the words a person reads follow the glossary.
      expect(byName(list, 'Template default')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/ · starter theme$/) });
      expect(byName(list, 'Workspace')).toMatchObject({ status: 'warn', hint: expect.stringContaining('retake new') });
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });
});

describe('retake doctor: what jobs of the Studio, the desktop app or an MCP client would refuse; the render browser', () => {
  it('a program inside the workspace or by a relative path, a browser.args entry that is no switch or loads files: one WARN line naming each', () => {
    const ws = { root: '/w', projectsDir: '/w/projects', templatesDir: '/t', componentsDir: '/w/components', ffmpeg: '/w/tools/ffmpeg' };
    const c = agentJobsCheck({ RETAKE_CHROMIUM: 'chrome/Chromium', RETAKE_FFPROBE: '/usr/bin/ffprobe', RETAKE_DOCKER: '/w/bin/docker', PLAYWRIGHT_BROWSERS_PATH: '/t/browsers' }, ws, {
      args: ['--lang=fr', '--load-extension=/w/ext', 'https://example.com/'],
    });
    expect(c).toMatchObject({ status: 'warn', name: 'Studio and MCP jobs', hint: expect.stringMatching(/a run typed in a terminal .* is not affected/) });
    expect(c?.detail).toMatch(/^would refuse: \$RETAKE_CHROMIUM \(chrome\/Chromium\) is a relative path/);
    expect(c?.detail).toMatch(/ · `ffmpeg:` of retake\.yaml \(\/w\/tools\/ffmpeg\) lies inside the workspace \(\/w\)/);
    expect(c?.detail).toMatch(/ · \$RETAKE_DOCKER \(\/w\/bin\/docker\) lies inside the workspace \(\/w\)/);
    expect(c?.detail).toMatch(/ · \$PLAYWRIGHT_BROWSERS_PATH \(\/t\/browsers\) lies inside the workspace \(\/t\)/);
    expect(c?.detail).toMatch(/ · browser\.args\[1\]: --load-extension is not one of the switches these jobs may pass/);
    expect(c?.detail).toMatch(/ · browser\.args\[2\]: "https:\/\/example\.com\/" is not a switch/);
    expect(c?.detail).not.toMatch(/RETAKE_FFPROBE|--lang/);
    expect(agentJobsCheck({ RETAKE_FFMPEG: 'ffmpeg' }, { ...ws, ffmpeg: '/opt/ff/ffmpeg' }, { executable: '/opt/chromium/chrome', args: ['--lang=fr'] })).toBeNull();
  });

  it('no headless shell outside an app: the Render browser line FAILs with the install command (Remotion never downloads its own)', async () => {
    const r = await checks(macProbes({ renderBrowser: () => ({ path: null, source: 'none' }) }));
    expect(r.code).toBe(EXIT.failure);
    expect(byName(r.checks, 'Render browser')).toMatchObject({
      status: 'fail',
      detail: 'no headless shell: renders do not start',
      hint: expect.stringContaining('playwright-core install chromium-headless-shell'),
    });
  });
});

describe('retake doctor from an app bundle (L5.16a): every tool line names its source, no pnpm / brew hint', () => {
  const bundle: BundleInfo = {
    root: '/Applications/Retake.app/Contents/Resources',
    sealed: '/Applications/Retake.app',
    manifest: {} as BundleInfo['manifest'],
    paths: { node: '/R/node/bin/node', engine: '/R/engine', browsers: '/R/browsers', ffmpeg: '/R/ffmpeg/bin', templates: '/R/engine/templates', plugin: '/R/plugin' },
  };
  const appChromium = async (): Promise<ChromiumProbe> => ({
    path: '/R/browsers/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    source: 'bundled',
    exists: true,
    launched: true,
    version: '141.0.7390.37',
    ms: 500,
    gpu: { accelerated: true },
    sandbox: { on: true, off: [] },
  });
  const answers =
    (bins: Record<string, string>) =>
    async (cmd: string, args: string[]): Promise<ExecResult | null> => {
      const tool = Object.entries(bins).find(([, path]) => path === cmd)?.[0];
      if (!tool) return dockerAnswers(cmd, args);
      if (args.includes('h264_videotoolbox')) return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: `${tool.startsWith('ffprobe') ? 'ffprobe' : 'ffmpeg'} version 9.0.2 Copyright\n`, stderr: '' };
    };
  let bare: string;
  beforeAll(async () => {
    bare = await mkdtemp(join(tmpdir(), 'studio-doctor-bundle-'));
    await writeFile(join(bare, 'retake.yaml'), `templates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  });
  afterAll(async () => rm(bare, { recursive: true, force: true }));
  const run = async (probes: DoctorProbes, root = bare) => {
    const io = memoryIo();
    const code = await doctorCommand(new Ui(io), { root }, { json: true }, probes);
    return { code, checks: (JSON.parse(io.stdout()) as { checks: DoctorCheck[] }).checks };
  };

  it('bundled tools: ffmpeg, ffprobe, Chromium and the render browser say "bundled"', async () => {
    const r = await run(
      macProbes({
        bundle,
        chromium: appChromium,
        exec: answers({ ffmpeg: '/R/ffmpeg/bin/ffmpeg', ffprobe: '/R/ffmpeg/bin/ffprobe' }),
        renderBrowser: () => ({ path: '/R/browsers/chromium_headless_shell-1194/chrome-mac/headless_shell', source: 'bundled' }),
      }),
    );
    expect(byName(r.checks, 'ffmpeg')).toMatchObject({ status: 'ok', detail: '9.0.2 · /R/ffmpeg/bin/ffmpeg · bundled' });
    expect(byName(r.checks, 'ffprobe').detail).toBe('9.0.2 · /R/ffmpeg/bin/ffprobe · bundled');
    expect(byName(r.checks, 'Chromium').detail).toContain(' · bundled · new headless');
    expect(byName(r.checks, 'Render browser')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/headless_shell · bundled$/) });
  });

  it('the order: retake.yaml, then $RETAKE_FFMPEG, then the bundle, then PATH', async () => {
    const all = {
      ffmpeg: '/opt/media/bin/ffmpeg',
      ffprobe: '/opt/media/bin/ffprobe',
      envff: '/env/ffmpeg',
      envfp: '/env/ffprobe',
      bff: '/R/ffmpeg/bin/ffmpeg',
      bfp: '/R/ffmpeg/bin/ffprobe',
      pff: '/usr/local/bin/ffmpeg',
      pfp: '/usr/local/bin/ffprobe',
    };
    const probes = (over: Partial<DoctorProbes>) => macProbes({ chromium: appChromium, exec: answers(all), which: (c) => (c === 'ffmpeg' ? all.pff : c === 'ffprobe' ? all.pfp : null), ...over });
    expect(byName((await run(probes({ bundle, env: { RETAKE_FFMPEG: '/env/ffmpeg' } }), ws)).checks, 'ffmpeg').detail).toMatch(/\/opt\/media\/bin\/ffmpeg · retake\.yaml$/);
    expect(byName((await run(probes({ bundle, env: { RETAKE_FFMPEG: '/env/ffmpeg' } }))).checks, 'ffmpeg').detail).toMatch(/\/env\/ffmpeg · \$RETAKE_FFMPEG$/);
    expect(byName((await run(probes({ bundle }))).checks, 'ffmpeg').detail).toMatch(/bundled$/);
    expect(byName((await run(probes({ bundle: null }))).checks, 'ffmpeg').detail).toMatch(/\/usr\/local\/bin\/ffmpeg · PATH$/);
  });

  it('a damaged app: FAIL with "reinstall Retake", never a pnpm / brew command', async () => {
    const r = await run(
      macProbes({
        bundle,
        exec: async () => null,
        chromium: async () => ({ path: '/R/browsers/chromium-1194/x/Chromium', source: 'bundled', exists: false, launched: false }),
        renderBrowser: () => ({ path: null, source: 'none', note: "the app's headless shell is missing" }),
      }),
    );
    expect(r.code).toBe(EXIT.failure);
    for (const name of ['ffmpeg', 'ffprobe', 'Chromium', 'Render browser']) {
      const c = byName(r.checks, name);
      expect(c.status, name).toBe('fail');
      expect(c.hint, name).toMatch(/reinstall Retake/);
    }
    for (const c of r.checks) expect(`${c.detail} ${c.hint ?? ''}`).not.toMatch(/\bpnpm\b|\bbrew\b/);
  });

  it('an app without its own ffmpeg, or with $RETAKE_CHROMIUM pointing nowhere: still no pnpm / brew / Homebrew hint', async () => {
    const noFfmpeg: BundleInfo = { ...bundle, paths: { ...bundle.paths, ffmpeg: null } };
    const r = await run(
      macProbes({
        bundle: noFfmpeg,
        exec: async () => null,
        which: () => null,
        chromium: async () => ({ path: '/nowhere/Chromium', source: 'RETAKE_CHROMIUM', exists: false, launched: false }),
        renderBrowser: () => ({ path: '/R/browsers/chromium_headless_shell-1194/chrome-mac/headless_shell', source: 'bundled' }),
      }),
    );
    expect(byName(r.checks, 'ffmpeg')).toMatchObject({ status: 'fail', hint: expect.stringContaining('this app carries no ffmpeg of its own') });
    expect(byName(r.checks, 'Chromium')).toMatchObject({ status: 'fail', hint: expect.stringContaining("remove it to use the app's own") });
    for (const c of r.checks) expect(`${c.name}: ${c.detail} ${c.hint ?? ''}`).not.toMatch(/\bpnpm\b|\bbrew\b|Homebrew/);
  });

  it('a damaged bundle (core bundleProblems) is a FAIL line of its own; a relative $RETAKE_FFMPEG is refused', async () => {
    const r = await run(macProbes({ bundle: null, bundleProblems: () => ['bundle.json: paths.ffmpeg (../../ffmpeg) leaves the bundle'], env: { RETAKE_FFMPEG: 'tools/ffmpeg' } }));
    expect(byName(r.checks, 'App bundle')).toMatchObject({ status: 'fail', detail: expect.stringContaining('leaves the bundle'), hint: 'reinstall Retake' });
    expect(byName(r.checks, 'ffmpeg')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/\$RETAKE_FFMPEG \(tools\/ffmpeg\) must be an absolute path/) });
    expect((await run(macProbes({ bundleProblems: () => [] }))).checks.find((c) => c.name === 'App bundle')).toBeUndefined();
  });

  it("the MCP line checks what the MCP client gets (PATH + RETAKE_HOME only): the shell's $RETAKE_FFMPEG does not count", async () => {
    const path = '/usr/bin:/bin';
    // A client PATH of system folders only (no Homebrew completed in, a node folder without ffmpeg).
    const exists = (p: string) => !/^\/(?:opt\/homebrew|usr\/local)\b/.test(p) && existsSync(p);
    const probes = (env: Record<string, string>) =>
      macProbes({ chromium: appChromium, env: { PATH: path, ...env }, exec: answers({ ff: '/env/ffmpeg', fp: '/env/ffprobe' }), worker: async () => null, execPath: '/nowhere/node/bin/node', exists });
    const shellOnly = byName((await run(probes({ RETAKE_FFMPEG: '/env/ffmpeg', RETAKE_FFPROBE: '/env/ffprobe' }))).checks, 'MCP');
    expect(shellOnly).toMatchObject({ status: 'warn', detail: expect.stringContaining('$RETAKE_FFMPEG is set in this shell only') });
    // retake.yaml's ffmpeg is read by the server itself: nothing to check on the client's PATH.
    expect(byName((await run(probes({ RETAKE_FFMPEG: '/env/ffmpeg' }), ws)).checks, 'MCP').detail).not.toContain('ffmpeg is not on the PATH');
  });
});

describe('retake doctor (this machine)', () => {
  it('MCP (L3.1): the Node.js a registration names (a stable alias), the worker, .retake/ git-ignored', async () => {
    // A mise install with its major alias: the alias is what --print-config registers.
    const versioned = '/Users/me/.local/share/mise/installs/node/22.16.0/bin/node';
    const alias = '/Users/me/.local/share/mise/installs/node/22/bin/node';
    const ok = await checks(macProbes({ execPath: versioned, exists: (p) => p === alias || existsSync(p), worker: async () => ({ pid: 4242, since: '2026-10-17T10:00:00.000Z' }) }));
    expect(byName(ok.checks, 'MCP')).toMatchObject({ status: 'ok', detail: `node ${alias} · worker running (pid 4242) · register: retake mcp --print-config` });
    // No alias: a patch upgrade would break the registration.
    const bare = await checks(macProbes({ execPath: versioned, worker: async () => null }));
    expect(byName(bare.checks, 'MCP')).toMatchObject({ status: 'warn', detail: expect.stringContaining('names a patch version'), hint: expect.stringContaining('retake mcp --print-config') });
    expect(byName(bare.checks, 'MCP').detail).toContain('worker idle');
    // A worker lock that cannot be read: said, never "idle".
    const unread = await checks(
      macProbes({
        exists: (p) => p === alias || existsSync(p),
        execPath: versioned,
        worker: async () => {
          throw new Error('EACCES: permission denied, open worker.lock');
        },
      }),
    );
    expect(byName(unread.checks, 'MCP')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining("the jobs worker's state cannot be read: EACCES"),
      hint: expect.stringContaining('can be read'),
    });
    expect(byName(unread.checks, 'MCP').detail).toContain('worker state unknown');
    expect(byName(unread.checks, 'MCP').detail).not.toContain('worker idle');
    // nvm / fnm name their folders v22.16.0: a patch version too.
    const nvm = await checks(macProbes({ execPath: '/Users/me/.nvm/versions/node/v22.16.0/bin/node', worker: async () => null }));
    expect(byName(nvm.checks, 'MCP')).toMatchObject({ status: 'warn', detail: expect.stringContaining('names a patch version') });
    // A workspace in a git work tree whose .gitignore misses .retake/.
    await mkdir(join(ws, '.git'), { recursive: true });
    try {
      const git = await checks(macProbes({ exec: async (cmd) => (cmd === 'git' ? { code: 1, stdout: '', stderr: '' } : null) }));
      expect(byName(git.checks, 'MCP')).toMatchObject({
        status: 'warn',
        detail: expect.stringContaining('.retake (the job queue and history of this machine) is not ignored by git'),
        hint: expect.stringContaining('.retake/'),
      });
      const ignored = await checks(macProbes({ exec: async (cmd, args) => (cmd === 'git' && args.includes('.retake/') ? { code: 0, stdout: '', stderr: '' } : null) }));
      expect(byName(ignored.checks, 'MCP').status).toBe('ok');
    } finally {
      await rm(join(ws, '.git'), { recursive: true });
    }
  });

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

describe('retake doctor --project: personas (R-AUTH-02)', () => {
  it('one line per persona (never signed in, valid, in use, expired) and where the sessions live (a git work tree)', async () => {
    const { writeStatus } = await import('@retake/runner-web');
    const { personaPaths } = await import('@retake/core');
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
      const probes = macProbes({ env: { RETAKE_HOME: home }, exec: (cmd, args, ms) => (cmd === 'git' ? real.exec(cmd, args, ms) : macProbes().exec(cmd, args, ms)) });
      const outside = await checks(probes, 'shop');
      expect(byName(outside.checks, 'Session home')).toMatchObject({ status: 'ok', detail: `${home} (RETAKE_HOME) · outside any git work tree` });
      expect(byName(outside.checks, 'Persona staging·editor')).toMatchObject({
        status: 'ok',
        detail: expect.stringMatching(/^valid · checked (just now|\d+ s ago) \(preflight of run 20261013-101010-quote\) · profile$/),
      });
      expect(byName(outside.checks, 'Persona staging·viewer')).toMatchObject({
        status: 'warn',
        detail: 'its profile is in use by a browser',
        hint: expect.stringContaining('close the retake login window'),
      });
      expect(byName(outside.checks, 'Persona staging·ops')).toMatchObject({
        status: 'warn',
        detail: expect.stringMatching(/^expired · checked .* \(auth status --check\): app:\/ops landed on the sign-in page/),
        hint: `sign in again: retake -C ${ws} login shop --env staging --persona ops`,
      });
      expect(byName(outside.checks, 'Persona staging·newbie')).toMatchObject({
        status: 'warn',
        detail: 'never signed in',
        hint: `sign in once: retake -C ${ws} login shop --env staging --persona newbie`,
      });
      expect(byName(outside.checks, 'Persona staging·quiet')).toMatchObject({ status: 'ok', detail: `snapshot saved, not checked yet (retake -C ${ws} auth status --project shop --check)` });
      expect(outside.checks.find((c) => c.name === 'Profile')).toBeUndefined();
      // The Retake home inside a git work tree: a warning, unless git ignores it.
      await real.exec('git', ['init', '-q', join(root, 'repo')], 10_000);
      const inside = await checks(probes, 'shop');
      expect(byName(inside.checks, 'Session home')).toMatchObject({ status: 'warn', detail: expect.stringContaining('is inside the git work tree'), hint: expect.stringContaining('RETAKE_HOME') });
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
