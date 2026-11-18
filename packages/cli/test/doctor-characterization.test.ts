/**
 * `retake doctor`'s whole output, pinned byte for byte with a fixed machine (probes): the text a person reads, its exit
 * code, and the `--json` shape a script reads. A published surface: the checks moved into the engine behind the ports
 * (the command keeps the printing and the exit code), and this file holds that the move changed nothing a reader sees.
 * The workspace's temporary folder and the Retake home are written as `<ws>` and `<home>`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, memoryIo } from '../src/index.js';
import { doctorCommand } from '../src/commands/doctor.js';
import type { DoctorProbes, ExecResult } from '../src/commands/doctor.js';
import { Ui } from '../src/ui.js';
import { productPorts } from '@retake/compose';

const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));
const PINNED = fileURLToPath(new URL('./fixtures/doctor', import.meta.url));

let ws: string;
let home: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-doctor-pin-'));
  home = join(ws, 'home');
  await mkdir(home, { recursive: true });
  await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\nffmpeg: /opt/media/bin/ffmpeg\n`);
  await mkdir(join(ws, 'projects', 'shop', 'scenarios'), { recursive: true });
  await writeFile(
    join(ws, 'projects', 'shop', 'project.yaml'),
    [
      'name: Shop',
      'environments:',
      '  staging: {app: "https://app.staging.example.com", admin: "http://localhost:4999"}',
      '  prod: {app: "https://app.example.com"}',
      'default_env: staging',
      'auth:',
      '  staging:',
      '    login_url: /login',
      '    personas:',
      '      editor: {pages: [app], check: {expect_text: Jane}}',
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

/** A Mac with ffmpeg 4.4 (too old), no docker daemon, a slow host and an unreachable one. */
function probes(): DoctorProbes {
  const bins: Record<string, string> = { security: '/usr/bin/security', docker: '/usr/local/bin/docker' };
  return {
    platform: 'darwin',
    nodeVersion: '22.12.0',
    env: { RETAKE_HOME: home, PATH: '/usr/bin:/bin' },
    which: (cmd) => bins[cmd] ?? null,
    exec: async (cmd, args): Promise<ExecResult | null> => {
      if (cmd === '/opt/media/bin/ffmpeg') return { code: 0, stdout: 'ffmpeg version 4.4.2 Copyright\n', stderr: '' };
      if (cmd === '/opt/media/bin/ffprobe') return { code: 0, stdout: 'ffprobe version 7.1 Copyright\n', stderr: '' };
      if (cmd === '/usr/local/bin/docker' && args[0] === 'compose') return { code: 0, stdout: 'v2.29.1\n', stderr: '' };
      if (cmd === '/usr/local/bin/docker' && args[0] === 'info') return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon\n' };
      return null;
    },
    exists: (p) => p === '/opt/media/bin/ffprobe' || p.startsWith(ws),
    chromium: async () => ({
      path: '/opt/chromium/Chromium',
      source: 'playwright',
      exists: true,
      launched: true,
      version: '159.0.8154.6',
      ms: 640,
      gpu: { accelerated: false, renderer: 'SwiftShader', software: ['webgl'] },
      sandbox: { on: true, off: [] },
    }),
    renderBrowser: () => ({ path: '/opt/chromium/headless_shell', source: 'playwright' }),
    renders: async () => ({
      policy: {
        gl: { asked: 'auto', resolved: 'angle', source: 'default' },
        encoder: { asked: 'auto', source: 'default' },
        ffmpeg: { asked: 'auto', source: 'default' },
        concurrency: 4,
        concurrencySource: 'default',
        platform: 'darwin',
      },
      gl: 'software',
      gpu: { accelerated: false, renderer: 'SwiftShader' },
      encoder: 'libx264',
      concurrency: 4,
    }),
    captures: async () => ({ dir: join(home, 'captures'), override: false, exists: false, takes: [], qos: true, capMin: 20 }),
    head: async (url) => (url.includes('localhost') ? { error: 'ECONNREFUSED', ms: 3 } : { status: 200, ms: 1250 }),
    execPath: '/opt/homebrew/bin/node',
    worker: async () => null,
    engine: '/opt/retake',
  };
}

async function doctor(json: boolean) {
  const io = memoryIo();
  const code = await doctorCommand(new Ui(io), { root: ws, ports: productPorts() }, { project: 'shop', json }, probes());
  const named = (s: string) => s.replaceAll(home, '<home>').replaceAll(ws, '<ws>').replaceAll(TEMPLATES, '<templates>');
  return { code, out: named(io.stdout()), err: named(io.stderr()) };
}

describe('retake doctor: the whole output, pinned', () => {
  it('the text: one line per check, its hint, the summary; exit 1 on a failure', async () => {
    const r = await doctor(false);
    expect(r.code).toBe(EXIT.failure);
    expect(r.out).toBe('');
    expect(r.err).toBe(await readFile(join(PINNED, 'text.txt'), 'utf8'));
  });

  it('--json: ok, failures, warnings and the checks, on stdout', async () => {
    const r = await doctor(true);
    expect(r.code).toBe(EXIT.failure);
    expect(r.out).toBe(await readFile(join(PINNED, 'json.txt'), 'utf8'));
  });
});
