/**
 * Review A #3 / B L5 (L4.2 fixes): the environment of a jobs worker a client starts. Every client but the CLI (the
 * Studio, an MCP client, tests) hands its worker cleanWorkerEnv — no package-manager variables, no model or agent
 * credential, no code loaded from the workspace (NODE_OPTIONS files, NODE_PATH / DYLD_* / LD_* entries inside it or
 * relative), PATH without the workspace under any spelling — and the CLI keeps its own.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanWorkerEnv, createEngine } from '../src/index.js';
import type { WorkerSpawnFn } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';

let ws: string;
const savedHome = process.env.DEMO_STUDIO_HOME;

beforeAll(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'engine-worker-env-')));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await mkdir(join(ws, 'bin'), { recursive: true });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  await rm(ws, { recursive: true, force: true });
});

describe('cleanWorkerEnv', () => {
  it('drops package-manager, model, agent and code-host credentials; keeps sign-in secrets and the rest', () => {
    const dropped = {
      npm_config__authToken: 'x',
      PNPM_HOME: 'x',
      INIT_CWD: 'x',
      NPM_TOKEN: 'x',
      NODE_AUTH_TOKEN: 'x',
      DEMO_STUDIO_MCP_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'x',
      ANTHROPIC_AUTH_TOKEN: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'x',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'x',
      CLAUDECODE: '1',
      OPENAI_API_KEY: 'x',
      AZURE_OPENAI_API_KEY: 'x',
      AWS_BEARER_TOKEN_BEDROCK: 'x',
      GEMINI_API_KEY: 'x',
      GOOGLE_API_KEY: 'x',
      MISTRAL_API_KEY: 'x',
      HF_TOKEN: 'x',
      GH_TOKEN: 'x',
      GITHUB_TOKEN: 'x',
    };
    const env = cleanWorkerEnv({ ...dropped, NORTHFIELD_SUPPLIER_PASSWORD: 'kept', HOME: '/h', LANG: 'en_US.UTF-8', PATH: '/usr/bin' }, ws, { node: '/n/bin/node', exists: () => false });
    for (const k of Object.keys(dropped)) expect(env[k], k).toBeUndefined();
    expect([env.NORTHFIELD_SUPPLIER_PASSWORD, env.HOME, env.LANG]).toEqual(['kept', '/h', 'en_US.UTF-8']);
    expect(env.PATH).toBe(['/n/bin', '/usr/bin'].join(delimiter));
  });

  it('nothing that loads code from the workspace: NODE_OPTIONS files, NODE_PATH / DYLD_* / LD_* entries inside it or relative', () => {
    const env = cleanWorkerEnv(
      {
        NODE_OPTIONS: `--require ${join(ws, 'evil.cjs')}`,
        NODE_PATH: ['/usr/lib/node', join(ws, 'node_modules')].join(delimiter),
        DYLD_INSERT_LIBRARIES: join(ws, 'x.dylib'),
        DYLD_LIBRARY_PATH: 'lib',
        LD_PRELOAD: `/usr/lib/a.so ${join(ws, 'b.so')}`,
        PATH: '/usr/bin',
      },
      ws,
      { exists: () => false },
    );
    for (const k of ['NODE_OPTIONS', 'NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'LD_PRELOAD']) expect(env[k], k).toBeUndefined();
    // Relative files resolve in the worker's cwd (the workspace): refused as well; options that load nothing stay.
    expect(cleanWorkerEnv({ NODE_OPTIONS: '--import=./x.mjs' }, ws).NODE_OPTIONS).toBeUndefined();
    expect(cleanWorkerEnv({ NODE_OPTIONS: '-r x' }, ws).NODE_OPTIONS).toBeUndefined();
    expect(cleanWorkerEnv({ NODE_OPTIONS: '--max-old-space-size=4096', NODE_PATH: '/usr/lib/node', DYLD_LIBRARY_PATH: '/opt/lib' }, ws)).toMatchObject({
      NODE_OPTIONS: '--max-old-space-size=4096',
      NODE_PATH: '/usr/lib/node',
      DYLD_LIBRARY_PATH: '/opt/lib',
    });
  });

  it('PATH: no entry inside the workspace under another case or spelling (realpath.native)', () => {
    const up = (p: string) => (process.platform === 'darwin' ? p.toUpperCase() : p);
    // An existing folder under another case (the file system's own spelling: realpath.native), one not created yet.
    const env = cleanWorkerEnv({ PATH: [up(join(ws, 'bin')), join(ws, 'bin'), join(ws, 'not', 'yet'), up(join(ws, 'not', 'yet')), '/usr/bin'].join(delimiter) }, ws, { node: '/n/bin/node', exists: () => false });
    expect(env.PATH).toBe(['/n/bin', '/usr/bin'].join(delimiter));
  });
});

describe('every client but the CLI starts its worker with it', () => {
  async function spawned(client: 'mcp' | 'cli'): Promise<NodeJS.ProcessEnv> {
    const seen: NodeJS.ProcessEnv[] = [];
    const spawn: WorkerSpawnFn = (_c, _a, options) => {
      seen.push({ ...(options.env ?? {}) });
      return { pid: 4243, on: () => undefined, unref: () => undefined } as unknown as ReturnType<WorkerSpawnFn>;
    };
    const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, PATH: process.env.PATH };
    process.env.OPENAI_API_KEY = 'sk-from-the-agent';
    process.env.PATH = [join(ws, 'bin'), process.env.PATH ?? ''].join(delimiter);
    try {
      const engine = await createEngine({ root: ws, client, workerSpawn: spawn });
      const sub = await engine.runs.submit({ project: 'northfield-fixture', scenario: 'highlights', mode: 'dry' });
      await engine.jobs.cancel(sub.job.id);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    return seen[0];
  }

  it('an MCP client: clean (review A #3: its worker serves the Studio’s later jobs too)', async () => {
    const env = await spawned('mcp');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect((env.PATH ?? '').split(delimiter)).not.toContain(join(ws, 'bin'));
    expect(env.DEMO_STUDIO_HOME).toBe(join(ws, '.home'));
  });

  it('the CLI: its own environment (a person at a terminal)', async () => {
    const env = await spawned('cli');
    expect(env.OPENAI_API_KEY).toBe('sk-from-the-agent');
  });
});
