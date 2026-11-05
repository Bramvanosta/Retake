/**
 * The environment of the programs a job starts: a shell hook run by the jobs worker (a job the Studio, the desktop app
 * or an MCP client submitted) gets core childEnv's allow-list of the worker's environment and project.yaml `pass_env:`
 * — never a secret the person exported in the terminal that started it —, while the same hook typed in a terminal
 * (`retake hooks run`) gets everything, as before.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useAgentPolicy } from '@retake/core';
import { FileJobQueue, createEngine, runWorker } from '../src/index.js';
import { REPO } from './helpers.js';

const CLI = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const SECRET = 'T_JOB_CHILD_ENV_SECRET';
const PASSED = 'T_JOB_CHILD_ENV_PASSED';
const accept = { approver: { approve: async () => ({ approved: true as const }) } };

let ws: string;
let project: string;
const saved = { home: process.env.RETAKE_HOME, secret: process.env[SECRET], passed: process.env[PASSED] };

beforeAll(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'retake-job-child-env-')));
  process.env.RETAKE_HOME = join(ws, '.home');
  process.env[SECRET] = 'exported-in-the-terminal';
  process.env[PASSED] = 'listed-in-pass-env';
  await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  project = join(ws, 'projects', 'w');
  await mkdir(join(project, 'hooks'), { recursive: true });
  await writeFile(join(project, 'project.yaml'), ['name: W', 'environments:', '  local:', '    console: http://127.0.0.1:4972', `pass_env: [${PASSED}]`, ''].join('\n'));
  await writeFile(join(project, 'hooks', 'env.yaml'), '- name: env\n  shell: {run: "env > env.txt"}\n  writes: false\n');
});

afterAll(async () => {
  useAgentPolicy(null);
  for (const [k, v] of [['RETAKE_HOME', saved.home], [SECRET, saved.secret], [PASSED, saved.passed]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (ws) await rm(ws, { recursive: true, force: true });
});

const seen = async () => (await readFile(join(project, 'env.txt'), 'utf8')).split('\n');

describe('a shell hook\'s environment: an allow-list for a job of the worker, everything in a terminal', () => {
  it('the worker runs it with the shell\'s own variables and pass_env, never an exported secret', async () => {
    const engine = await createEngine({ root: ws, client: 'test', autoStartWorker: false });
    const sub = await engine.hooks.submit({ project: 'w', source: 'hooks/env.yaml', dry: false }, accept);
    // The worker turns the policy on for itself.
    useAgentPolicy(null);
    const logs: string[] = [];
    expect(await runWorker({ root: ws, idleExitMs: 400, pollMs: 50, log: (m) => logs.push(m) })).toBe(0);
    const job = await new FileJobQueue(ws).get(sub.job.id);
    expect(job?.state, `${logs.join('\n')}\n${JSON.stringify(job?.result)}`).toBe('succeeded');
    const lines = await seen();
    expect(lines).toContain(`${PASSED}=listed-in-pass-env`);
    expect(lines.some((l) => l.startsWith(`${SECRET}=`))).toBe(false);
    expect(lines.some((l) => l.startsWith('HOME='))).toBe(true);
    expect(lines.some((l) => l.startsWith('RETAKE_HOME='))).toBe(false);
  }, 60_000);

  it('`retake hooks run` in a terminal passes the whole environment on', async () => {
    useAgentPolicy(null);
    await rm(join(project, 'env.txt'), { force: true });
    const code = await new Promise<number | null>((ok) => {
      const child = spawn(process.execPath, [CLI, '-C', ws, 'hooks', 'run', 'w', 'hooks/env.yaml', '--yes'], { cwd: ws, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('exit', ok);
    });
    expect(code).toBe(0);
    const lines = await seen();
    expect(lines).toContain(`${SECRET}=exported-in-the-terminal`);
    expect(lines).toContain(`${PASSED}=listed-in-pass-env`);
  }, 60_000);
});
