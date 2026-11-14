/**
 * The agent policy (core agent-policy.ts) is on in every process that serves trust mcp — the jobs worker and its job
 * processes, the engine of the MCP server and of the Studio server — and off in the CLI: a run job whose project names
 * a `browser.executable` inside the workspace fails before that program starts, with what to change, whoever submitted
 * the job, while the same run typed in a terminal (`retake run`) starts it. The stand-in executable only leaves a
 * marker and exits, so no browser is needed.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileJobQueue, JOB_EXIT, buildStamp, createEngine, runJobChild, runWorker } from '../src/index.js';
import { REPO } from '@retake/test-support/repo';
import type { OpenedWorkspace } from '../src/index.js';
import * as workspaceModule from '../src/workspace.js';
import { scratchHome } from '@retake/test-support/home';

// Every workspace this file's engines and job processes open, with the policy it carries (core WorkPolicy).
vi.mock('../src/workspace.js', async (original) => {
  const m = await original<typeof import('../src/workspace.js')>();
  return { ...m, openWorkspace: vi.fn(m.openWorkspace) };
});
const opened = async (): Promise<OpenedWorkspace> => {
  const results = vi.mocked(workspaceModule.openWorkspace).mock.results;
  return (await results[results.length - 1].value) as OpenedWorkspace;
};

const CLI = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
/** The page server's port: one the system picks (beforeAll), never a fixed number another session may hold. */
let PORT = 0;
const SHORT = 'video: short\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n';

let ws: string;
let marker: string;
let server: Server;
const retakeHome = scratchHome();

beforeAll(async () => {
  server = createServer((_q, r) => r.end('<p>page</p>'));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  PORT = (server.address() as AddressInfo).port;
  ws = await realpath(await mkdtemp(join(tmpdir(), 'retake-job-programs-')));
  retakeHome.use(join(ws, '.home'));
  marker = join(ws, 'started');
  await mkdir(join(ws, 'bin'), { recursive: true });
  const chrome = join(ws, 'bin', 'chrome');
  await writeFile(chrome, `#!/bin/sh\necho "$@" > '${marker}'\nexit 1\n`);
  await chmod(chrome, 0o755);
  await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  const project = join(ws, 'projects', 'w');
  await mkdir(join(project, 'scenarios'), { recursive: true });
  await writeFile(
    join(project, 'project.yaml'),
    [
      'name: W',
      'environments:',
      '  local:',
      `    console: http://127.0.0.1:${PORT}`,
      'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
      'template: default',
      'browser:',
      `  executable: ${JSON.stringify(chrome)}`,
      '',
    ].join('\n'),
  );
  await writeFile(join(project, 'scenarios', 'short.yaml'), SHORT);
});

afterAll(async () => {
  await new Promise((ok) => server?.close(ok));
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('a program inside the workspace: refused for a job of the worker, run by the CLI', () => {
  it('the worker fails the run before browser.executable starts, saying to move it out of the workspace', async () => {
    const engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
    const sub = await engine.runs.submit({ project: 'w', scenario: 'short', mode: 'dry' });
    // The submitting engine's own policy is not what refuses: the worker opens the workspace under it for itself.
    const logs: string[] = [];
    expect(await runWorker({ root: ws, idleExitMs: 400, pollMs: 50, log: (m) => logs.push(m) })).toBe(0);
    const job = await new FileJobQueue(ws).get(sub.job.id);
    // The job ran; the run failed at its browser's launch, with the refusal.
    expect(job?.state, logs.join('\n')).toBe('succeeded');
    expect(job?.result).toMatchObject({ kind: 'run', status: 'failed', steps_done: 0 });
    expect((job?.result as { untrusted?: { error_message?: string } }).untrusted?.error_message).toMatch(
      /browser\.executable \(.*\/bin\/chrome\) lies inside the workspace .*move the program out of the workspace and point browser\.executable at its new place/,
    );
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it("the engine of the MCP server and of the Studio server turns the policy on; the CLI's keeps it off", async () => {
    for (const client of ['mcp', 'ui', 'cli'] as const) {
      const engine = await createEngine({ root: ws, client, autoStartWorker: false });
      if (client === 'cli') expect(engine.workspace.policy.agentFolders, client).toBeNull();
      else expect(engine.workspace.policy.agentFolders, client).toEqual([ws, join(ws, 'projects'), join(REPO, 'templates'), join(ws, 'components')]);
    }
  });

  it('a job process (renders, reviews, exports) serves under the policy too', async () => {
    const r = await runJobChild({ root: ws, id: 'j_none', kind: 'render', build: buildStamp(), supervisor: process.pid, digest: 'x', log: () => undefined });
    expect(r).toBe(JOB_EXIT.refused);
    expect((await opened()).policy.agentFolders).toContain(ws);
  });

  it('`retake run` in a terminal starts it (the run then fails: the stand-in is no browser)', async () => {
    // Not spawnSync: the page server of this process must answer the run's reachability check.
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((ok) => {
      const child = spawn(process.execPath, [CLI, '-C', ws, 'run', 'w', 'short', '--dry'], { env: { ...process.env, NO_COLOR: '1' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (status) => ok({ status, stdout, stderr }));
    });
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr + r.stdout).not.toMatch(/lies inside the workspace/);
    expect(existsSync(marker), r.stderr).toBe(true);
  }, 70_000);
});
