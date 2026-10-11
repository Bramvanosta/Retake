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

/** A healthy Mac: everything present, every host answers. */
function macProbes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  const bins: Record<string, string> = { security: '/usr/bin/security', osascript: '/usr/bin/osascript' };
  return {
    platform: 'darwin',
    nodeVersion: '22.12.0',
    env: {},
    which: (cmd) => bins[cmd] ?? null,
    exec: async (cmd): Promise<ExecResult | null> => {
      if (cmd === '/opt/media/bin/ffmpeg') return { code: 0, stdout: FFMPEG_VERSION, stderr: '' };
      if (cmd === '/opt/media/bin/ffprobe') return { code: 0, stdout: FFPROBE_VERSION, stderr: '' };
      return null;
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
    for (const name of ['Node.js', 'Chromium', 'ffmpeg', 'ffprobe', 'Display', 'Secrets', 'Notifications', 'Workspace', 'Template default', 'Project acme']) {
      expect(r.err).toMatch(new RegExp(`OK +${name.replace('.', '\\.')} `));
    }
    expect(r.err).toContain('141.0.7390.37');
    expect(r.err).toContain('7.1 · /opt/media/bin/ffprobe'); // next to the configured ffmpeg
    expect(r.err).toContain('macOS Keychain via security');
    expect(r.err).toContain('osascript');
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
    const missing = await checks(macProbes({ chromium: async () => ({ path: null, source: 'playwright', exists: false, launched: false }) }));
    expect(byName(missing.checks, 'Chromium')).toMatchObject({ status: 'fail', hint: expect.stringContaining('playwright-core install chromium') });
  });

  it('--project: missing profile → warn (studio login), unreachable default environment → fail, other environment → warn', async () => {
    const { code, checks: list } = await checks(
      macProbes({ head: async (url) => (url.includes('admin') || url.includes('app.example.com') ? { error: 'ENOTFOUND', ms: 3 } : { status: 302, ms: 8 }) }),
      'acme',
    );
    expect(code).toBe(EXIT.failure);
    expect(byName(list, 'Profile (prod)')).toMatchObject({ status: 'warn', hint: 'sign in once: studio login acme --env prod' });
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
