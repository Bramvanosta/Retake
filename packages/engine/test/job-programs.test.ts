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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentPolicyFolders, useAgentPolicy } from '@retake/core';
import { FileJobQueue, JOB_EXIT, buildStamp, createEngine, runJobChild, runWorker } from '../src/index.js';
import { REPO } from './helpers.js';

const CLI = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const PORT = 4971;
const SHORT = 'video: short\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n';

let ws: string;
let marker: string;
let server: Server;
const savedHome = process.env.RETAKE_HOME;

beforeAll(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'retake-job-programs-')));
  process.env.RETAKE_HOME = join(ws, '.home');
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
    ['name: W', 'environments:', '  local:', `    console: http://127.0.0.1:${PORT}`, 'capture: {width: 1280, height: 720, scale: 1, fps: 30}', 'template: default', 'browser:', `  executable: ${JSON.stringify(chrome)}`, ''].join('\n'),
  );
  await writeFile(join(project, 'scenarios', 'short.yaml'), SHORT);
  server = createServer((_q, r) => r.end('<p>page</p>'));
  await new Promise<void>((ok) => server.listen(PORT, '127.0.0.1', ok));
});

afterAll(async () => {
  useAgentPolicy(null);
  await new Promise((ok) => server?.close(ok));
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('a program inside the workspace: refused for a job of the worker, run by the CLI', () => {
  it('the worker fails the run before browser.executable starts, saying to move it out of the workspace', async () => {
    const engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
    const sub = await engine.runs.submit({ project: 'w', scenario: 'short', mode: 'dry' });
    // The submitting engine's own policy is not what refuses: the worker turns it on for itself.
    useAgentPolicy(null);
    const logs: string[] = [];
    expect(await runWorker({ root: ws, idleExitMs: 400, pollMs: 50, log: (m) => logs.push(m) })).toBe(0);
    const job = await new FileJobQueue(ws).get(sub.job.id);
    // The job ran; the run failed at its browser's launch, with the refusal.
    expect(job?.state, logs.join('\n')).toBe('succeeded');
    expect(job?.result).toMatchObject({ kind: 'run', status: 'failed', steps_done: 0 });
    expect((job?.result as { untrusted?: { error_message?: string } }).untrusted?.error_message).toMatch(/browser\.executable \(.*\/bin\/chrome\) lies inside the workspace .*move the program out of the workspace and point browser\.executable at its new place/);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);

  it('the engine of the MCP server and of the Studio server turns the policy on; the CLI\'s keeps it off', async () => {
    for (const client of ['mcp', 'ui', 'cli'] as const) {
      useAgentPolicy(null);
      await createEngine({ root: ws, client, autoStartWorker: false });
      if (client === 'cli') expect(agentPolicyFolders(), client).toBeNull();
      else expect(agentPolicyFolders(), client).toEqual([ws, join(ws, 'projects'), join(REPO, 'templates'), join(ws, 'components')]);
    }
    useAgentPolicy(null);
  });

  it('a job process (renders, reviews, exports) serves under the policy too', async () => {
    useAgentPolicy(null);
    const r = await runJobChild({ root: ws, id: 'j_none', kind: 'render', build: buildStamp(), supervisor: process.pid, digest: 'x', log: () => undefined });
    expect(r).toBe(JOB_EXIT.refused);
    expect(agentPolicyFolders()).toContain(ws);
    useAgentPolicy(null);
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
