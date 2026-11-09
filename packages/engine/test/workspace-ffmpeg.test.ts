/**
 * L5.16a (reviews A M2 / L1, B M2 / M3) — the workspace's ffmpeg reaches every spawn of the process: `openWorkspace`
 * makes retake.yaml `ffmpeg` the process's (the option-less sites: preview quantiser, silent-track fix, review frames,
 * pixels), the workspace opened last wins (one workspace per process, documented), a relative path is the workspace's
 * whatever the cwd, and a worker a client starts never inherits a relative tool variable. And the raw package, exported
 * from a synthetic run with an ffmpeg without libx264, names the encoder its clips were really made with.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { agentProgramProblem, ffmpegBin, loadProject, mediaTools, resolveMediaTools, useWorkspaceFfmpeg } from '@retake/core';
import { exportCapture } from '@retake/runner-web';
import { openWorkspace } from '../src/workspace.js';
import { cleanWorkerEnv } from '../src/jobs/worker-env.js';
import { capture, writeRun } from './synthetic-runs.js';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-ws-ffmpeg-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => useWorkspaceFfmpeg(undefined));

function workspace(name: string, yaml: string): string {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'retake.yaml'), yaml);
  return root;
}

describe("openWorkspace: retake.yaml's ffmpeg is the process's", () => {
  it('reaches ffmpegBin() (what every option-less site runs); switching workspaces updates it, a workspace without one clears it', async () => {
    const a = workspace('a', 'ffmpeg: /x/bin/ffmpeg\n');
    const b = workspace('b', 'version: 1\n');
    await openWorkspace({ root: a });
    expect(ffmpegBin()).toBe('/x/bin/ffmpeg');
    expect(mediaTools().ffmpegSource).toBe('retake.yaml');
    await openWorkspace({ root: b });
    expect(ffmpegBin()).not.toBe('/x/bin/ffmpeg');
    expect(mediaTools().ffmpegSource).not.toBe('retake.yaml');
    await openWorkspace({ root: a });
    expect(ffmpegBin()).toBe('/x/bin/ffmpeg');
  });

  it('a relative path names the same file from any cwd (the server and its worker, whose cwd is the root)', async () => {
    const root = workspace('rel', 'ffmpeg: tools/ffmpeg\n');
    const cwd = process.cwd();
    try {
      process.chdir(tmp);
      await openWorkspace({ root });
      const server = ffmpegBin();
      process.chdir(root);
      await openWorkspace({ root });
      expect(ffmpegBin()).toBe(server);
      expect(server).toBe(join(root, 'tools', 'ffmpeg'));
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('the worker a client starts: no relative tool variable', () => {
  it('RETAKE_FFMPEG / RETAKE_FFPROBE / RETAKE_CHROMIUM* reach it as they are; a relative one is refused there as by the server, saying what to change', () => {
    const root = join(tmp, 'ws');
    const env = {
      PATH: '/usr/bin:/bin',
      RETAKE_FFMPEG: 'tools/ffmpeg',
      RETAKE_FFPROBE: './ffprobe',
      RETAKE_CHROMIUM: 'chrome/Chromium',
      RETAKE_CHROMIUM_HEADLESS_SHELL: '/opt/shell/headless_shell',
    };
    const out = cleanWorkerEnv(env, root, { node: '/usr/local/bin/node', exists: () => false });
    expect(out).toMatchObject({ RETAKE_FFMPEG: 'tools/ffmpeg', RETAKE_FFPROBE: './ffprobe', RETAKE_CHROMIUM: 'chrome/Chromium', RETAKE_CHROMIUM_HEADLESS_SHELL: '/opt/shell/headless_shell' });
    expect(cleanWorkerEnv({ RETAKE_FFMPEG: '/opt/ff/ffmpeg', RETAKE_FFPROBE: 'ffprobe' }, root, { exists: () => false })).toMatchObject({ RETAKE_FFMPEG: '/opt/ff/ffmpeg', RETAKE_FFPROBE: 'ffprobe' });
    // The worker refuses the relative value as the server does (core resolveMediaTools, and the agent policy for the
    // browser), so no process runs a cwd-relative file — and the job says what to change instead of running another one.
    expect(() => resolveMediaTools({ env: out })).toThrow(/^\$RETAKE_FFMPEG \(tools\/ffmpeg\) must be an absolute path/);
    expect(agentProgramProblem(out.RETAKE_CHROMIUM!, '$RETAKE_CHROMIUM', [root])).toMatch(/^\$RETAKE_CHROMIUM \(chrome\/Chromium\) is a relative path — .*: give the absolute path of a program outside the workspace$/);
  });
});

describe('the raw package names the encoder its MP4 clips were made with (review B M2)', () => {
  it('an ffmpeg without libx264: VideoToolbox clips, and the manifest and selects say so (never CRF 14)', async () => {
    const real = execFileSync('/bin/sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
    // The real ffmpeg, minus libx264 in its encoder list (what an ffmpeg built without it says).
    const wrapper = join(tmp, 'ffmpeg-no-x264');
    writeFileSync(wrapper, `#!/bin/sh\ncase "$*" in *-encoders*) '${real}' "$@" | grep -v libx264; exit 0;; esac\nexec '${real}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const root = workspace('raw', 'version: 1\n');
    const dir = join(root, 'projects', 'p');
    mkdirSync(join(dir, 'scenarios'), { recursive: true });
    writeFileSync(join(dir, 'project.yaml'), 'name: P\nenvironments:\n  local: {console: "http://localhost:4950"}\n');
    const runDir = await writeRun(dir, capture('20261020-100000-blocks'));
    const project = await loadProject('p', root);
    const vt = await exportCapture({ project, runDir, out: join(tmp, 'pkg-vt'), ffmpeg: wrapper, selects: true });
    expect(vt.manifest.settings.codec).toBe('H.264 high profile (VideoToolbox q:v 85), yuv420p, faststart');
    expect(vt.manifest.selects?.codec).toBe(vt.manifest.settings.codec);
    const x264 = await exportCapture({ project, runDir, out: join(tmp, 'pkg-x264'), ffmpeg: real });
    expect(x264.manifest.settings.codec).toMatch(/CRF 14/);
  });
});
