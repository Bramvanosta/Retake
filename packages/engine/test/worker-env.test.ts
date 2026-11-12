/**
 * Review A #3 / B L5 (L4.2 fixes): the environment of a jobs worker a client starts. Every client but the CLI (the
 * Studio, an MCP client, tests) hands its worker cleanWorkerEnv — no package-manager variables, no model or agent
 * credential, no code loaded from the workspace (NODE_OPTIONS files, NODE_PATH / DYLD_* / LD_* entries inside one of its
 * folders or relative), PATH without its folders under any spelling — the tool variables kept as they are (the
 * worker's agent policy refuses one inside the workspace, saying what to change) — and the CLI keeps its own. The
 * secrets of a sign-in are looked for in that same environment (auth.forScenario: what the cleaner drops is missing).
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { programProblem, PERSON_POLICY, workPolicyFrom } from '@retake/core';
import { loadWorkspaceConfig, nodeFileFacts } from '@retake/core/io';
import { cleanWorkerEnv, createEngine } from '../src/index.js';
import type { WorkerSpawnFn } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';
import type { WorkPolicy } from '@retake/core';

/** The policy the work below runs under (core WorkPolicy): a command a person types until a test turns the agent policy on. */
let policy: WorkPolicy = PERSON_POLICY;

let ws: string;
const savedHome = process.env.RETAKE_HOME;

beforeAll(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), 'engine-worker-env-')));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await mkdir(join(ws, 'bin'), { recursive: true });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
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
      RETAKE_MCP_TOKEN: 'x',
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

  it('tool variables are kept as they are, inside the workspace too: the worker refuses such a program when a job would start it, saying what to change', () => {
    const tools = {
      RETAKE_FFMPEG: join(ws, 'bin', 'ffmpeg'),
      RETAKE_FFPROBE: 'tools/ffprobe',
      RETAKE_CHROMIUM: join(ws, 'chrome', '..', 'bin', 'Chromium'),
      RETAKE_CHROMIUM_HEADLESS_SHELL: '/opt/shell/headless_shell',
      RETAKE_DOCKER: join(ws, 'bin', 'docker'),
      PLAYWRIGHT_BROWSERS_PATH: join(ws, 'browsers'),
    };
    const env = cleanWorkerEnv({ ...tools, PATH: '/usr/bin' }, ws, { exists: () => false });
    expect(env).toMatchObject(tools);
    policy = workPolicyFrom([ws], policy.ffmpeg, policy.render);
    try {
      // What the worker's mediaBin / launchTarget / docker check say of these values (core programProblem).
      expect(programProblem(policy, env.RETAKE_FFMPEG!, '$RETAKE_FFMPEG', { path: '', files: nodeFileFacts })).toMatch(
        /^\$RETAKE_FFMPEG \(.*\/bin\/ffmpeg\) lies inside the workspace .*: move the program out of the workspace and point \$RETAKE_FFMPEG at its new place$/,
      );
      expect(programProblem(policy, env.RETAKE_FFPROBE!, '$RETAKE_FFPROBE', { path: '', files: nodeFileFacts })).toMatch(/is a relative path/);
      expect(programProblem(policy, env.RETAKE_DOCKER!, '$RETAKE_DOCKER', { path: '', files: nodeFileFacts })).toMatch(/lies inside the workspace/);
    } finally {
      policy = workPolicyFrom(null, policy.ffmpeg, policy.render);
    }
  });

  it("all the workspace's folders count (its templates or components folder outside the root): PATH and load-path entries there are dropped", () => {
    const templates = join(ws, '..', `${ws.split('/').pop()}-templates`);
    const env = cleanWorkerEnv({ PATH: [join(templates, 'bin'), '/usr/bin'].join(delimiter), NODE_PATH: join(templates, 'lib'), DYLD_LIBRARY_PATH: '/opt/lib' }, ws, {
      node: '/n/bin/node',
      exists: () => false,
      folders: [ws, templates],
    });
    expect(env.PATH).toBe(['/n/bin', '/usr/bin'].join(delimiter));
    expect(env.NODE_PATH).toBeUndefined();
    expect(env.DYLD_LIBRARY_PATH).toBe('/opt/lib');
    // The root alone: that folder is not the workspace's.
    expect(cleanWorkerEnv({ PATH: join(templates, 'bin'), NODE_PATH: join(templates, 'lib') }, ws, { node: '/n/bin/node', exists: () => false })).toMatchObject({
      PATH: ['/n/bin', join(templates, 'bin')].join(delimiter),
      NODE_PATH: join(templates, 'lib'),
    });
  });

  it('PATH: no entry inside the workspace under another case or spelling (realpath.native)', () => {
    const up = (p: string) => (process.platform === 'darwin' ? p.toUpperCase() : p);
    // An existing folder under another case (the file system's own spelling: realpath.native), one not created yet.
    const env = cleanWorkerEnv({ PATH: [up(join(ws, 'bin')), join(ws, 'bin'), join(ws, 'not', 'yet'), up(join(ws, 'not', 'yet')), '/usr/bin'].join(delimiter) }, ws, {
      node: '/n/bin/node',
      exists: () => false,
    });
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
    // The fixture workspace's templates_dir lies outside its root (the repository's templates/).
    const templates = (await loadWorkspaceConfig(ws)).templatesDir;
    process.env.PATH = [join(ws, 'bin'), join(templates, 'bin'), process.env.PATH ?? ''].join(delimiter);
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
    expect((env.PATH ?? '').split(delimiter)).not.toContain(join((await loadWorkspaceConfig(ws)).templatesDir, 'bin'));
    expect(env.RETAKE_HOME).toBe(join(ws, '.home'));
  });

  it('the CLI: its own environment (a person at a terminal)', async () => {
    const env = await spawned('cli');
    expect(env.OPENAI_API_KEY).toBe('sk-from-the-agent');
  });

  it("a sign-in's secrets are looked for where that worker finds them: a variable the cleaner drops is missing for MCP, not for the CLI", async () => {
    // The supplier's login steps read a code host's token (dropped from a clean worker environment), set in this process.
    const other = await realpath(await mkdtemp(join(tmpdir(), 'engine-worker-env-signin-')));
    await fixtureWorkspace(other);
    const file = join(other, 'projects', 'northfield-fixture', 'project.yaml');
    const yaml = await readFile(file, 'utf8');
    expect(yaml).toContain('{{env:NORTHFIELD_SUPPLIER_PASSWORD}}');
    await writeFile(file, yaml.replace('{{env:NORTHFIELD_SUPPLIER_PASSWORD}}', '{{env:GITHUB_TOKEN}}'));
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'a-token-of-the-shell';
    try {
      const supplier = async (client: 'mcp' | 'cli') => (await (await createEngine({ root: other, client, autoStartWorker: false })).auth.forScenario('northfield-fixture', 'proforma')).personas[0];
      expect(await supplier('mcp')).toMatchObject({ persona: 'supplier', auto: false, login_env_missing: ['GITHUB_TOKEN'] });
      const cli = await supplier('cli');
      expect(cli).toMatchObject({ persona: 'supplier', auto: true });
      expect(cli.login_env_missing).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
      await rm(other, { recursive: true, force: true });
    }
  });
});
