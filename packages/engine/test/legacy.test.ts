/**
 * old-name: this whole file (the guard test allows it).
 *
 * L5.13 — the engine and the names from before the rename (core legacy.ts, engine legacy.ts):
 * - M4: a Studio or a worker of the old build still alive on the workspace (its `.demo-studio/ui.json` or
 *   `workers/worker.lock`) stops a new worker, the Studio, MCP and sandbox up / reset from starting beside it; a dead,
 *   linked, oversized or broken holder file is no holder, nor one without the start time ps gives for its pid (the
 *   folder is agent-writable: review A M1), nor one under a linked old folder;
 * - R-REN-04: a worker never gets the HTTP token under its old variable either;
 * - D0: a theme the tool made before the rename (its old provenance file and `made_by`) is still the tool's to replace;
 * - H3: engine_info's `legacy` field while the old home holds the only sign-ins.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanWorkerEnv, createEngine, oldLiveHolder, processStart, refuseBesideOldHolder, replaceProblem, runWorker, sha256Hex } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';

let tmp: string;
let sleeper: ChildProcess;
/** The sleeper's start time as ps gives it (what an old Studio or worker recorded of itself). */
let started: string;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'retake-engine-legacy-')));
  sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  started = new Date((await processStart(sleeper.pid!))!).toISOString();
});

afterAll(async () => {
  sleeper.kill('SIGKILL');
  await rm(tmp, { recursive: true, force: true });
});

async function holderFile(root: string, rel: string, body: string | object): Promise<string> {
  const file = join(root, '.demo-studio', rel);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

describe('an old Studio or worker still running (critique M4)', () => {
  it('a live holder of the old ui.json or worker.lock is found; a dead, linked, oversized or broken one is not', async () => {
    const live = join(tmp, 'live-ui');
    const file = await holderFile(live, 'ui.json', { version: 1, kind: 'ui', pid: sleeper.pid, started_at: started, port: 4999, url: 'http://127.0.0.1:4999/', token: 'x'.repeat(40), since: '2026-11-01T10:00:00.000Z' });
    expect(await oldLiveHolder(live)).toEqual({ what: 'ui', pid: sleeper.pid, file });
    const worker = join(tmp, 'live-worker');
    const lock = await holderFile(worker, 'workers/worker.lock', { pid: sleeper.pid, started_at: started, host: 'h', version: '0.1.0', build: 'b', since: '2026-11-01T10:00:00.000Z' });
    expect(await oldLiveHolder(worker)).toEqual({ what: 'worker', pid: sleeper.pid, file: lock });

    const dead = spawn('true');
    await new Promise((r) => dead.on('exit', r));
    await holderFile(join(tmp, 'dead'), 'ui.json', { pid: dead.pid, started_at: started });
    expect(await oldLiveHolder(join(tmp, 'dead'))).toBeNull();
    // A link to a live holder's file is never followed; nor is a file over the cap or one that is not JSON.
    await mkdir(join(tmp, 'linked', '.demo-studio'), { recursive: true });
    await symlink(file, join(tmp, 'linked', '.demo-studio', 'ui.json'));
    expect(await oldLiveHolder(join(tmp, 'linked'))).toBeNull();
    await holderFile(join(tmp, 'big'), 'ui.json', `{"pid": ${sleeper.pid}, "started_at": "${started}", "pad": "${'x'.repeat(70 * 1024)}"}`);
    expect(await oldLiveHolder(join(tmp, 'big'))).toBeNull();
    await holderFile(join(tmp, 'broken'), 'workers/worker.lock', `pid=${sleeper.pid}`);
    expect(await oldLiveHolder(join(tmp, 'broken'))).toBeNull();
    expect(await oldLiveHolder(join(tmp, 'nothing'))).toBeNull();
  });

  it('a record without the start time ps gives for its pid, or under a linked old folder, is no holder (review A M1)', async () => {
    // A pid alone (any live process of the person: the editor, Claude) — the old folder is agent-writable.
    await holderFile(join(tmp, 'pid-only'), 'ui.json', { pid: sleeper.pid });
    expect(await oldLiveHolder(join(tmp, 'pid-only'))).toBeNull();
    await holderFile(join(tmp, 'pid-only-worker'), 'workers/worker.lock', { pid: sleeper.pid, host: 'h' });
    expect(await oldLiveHolder(join(tmp, 'pid-only-worker'))).toBeNull();
    // Another start time (a pid the system reused), or one that is no date.
    await holderFile(join(tmp, 'other-start'), 'ui.json', { pid: sleeper.pid, started_at: '2020-01-01T00:00:00.000Z' });
    expect(await oldLiveHolder(join(tmp, 'other-start'))).toBeNull();
    await holderFile(join(tmp, 'no-date'), 'ui.json', { pid: sleeper.pid, started_at: 'yesterday' });
    expect(await oldLiveHolder(join(tmp, 'no-date'))).toBeNull();
    // ps cannot tell the pid's start time (then the pid alone would decide): no holder.
    expect(await oldLiveHolder(join(tmp, 'live-ui'), async () => null)).toBeNull();
    // A linked old folder, or a linked workers/ folder, leading to a live holder's real files: never followed.
    await mkdir(join(tmp, 'link-dir'), { recursive: true });
    await symlink(join(tmp, 'live-ui', '.demo-studio'), join(tmp, 'link-dir', '.demo-studio'));
    expect(await oldLiveHolder(join(tmp, 'link-dir'))).toBeNull();
    await mkdir(join(tmp, 'link-workers', '.demo-studio'), { recursive: true });
    await symlink(join(tmp, 'live-worker', '.demo-studio', 'workers'), join(tmp, 'link-workers', '.demo-studio', 'workers'));
    expect(await oldLiveHolder(join(tmp, 'link-workers'))).toBeNull();
  });

  it('the refusal names the file, the old pid and what to stop', async () => {
    const err = await refuseBesideOldHolder(join(tmp, 'live-ui'), 'this Studio').catch((e: unknown) => e as Error & { fix?: string });
    expect(err?.message).toBe(
      `${join(tmp, 'live-ui', '.demo-studio', 'ui.json')}: a Studio from before the rename (Demo Studio, pid ${sleeper.pid}) still runs on this workspace — this Studio would run beside it (two job queues, take locks in two folders)`,
    );
    expect(err?.fix).toBe(`quit the Demo Studio app, or stop that Studio (Ctrl-C in its terminal), then try again — or remove ${join(tmp, 'live-ui', '.demo-studio', 'ui.json')} if no old Studio or worker runs`);
    await expect(refuseBesideOldHolder(join(tmp, 'dead'), 'x')).resolves.toBeUndefined();
  });

  it('a new worker does not start beside an old one: it exits 1 and says why, without taking the new lock', async () => {
    const ws = join(tmp, 'ws-worker');
    await mkdir(join(ws, 'projects'), { recursive: true });
    await writeFile(join(ws, 'retake.yaml'), 'version: 1\n');
    await holderFile(ws, 'workers/worker.lock', { pid: sleeper.pid, started_at: started, host: 'h', version: '0.1.0', build: 'b', since: '2026-11-01T10:00:00.000Z' });
    const log: string[] = [];
    const code = await runWorker({ root: ws, idleExitMs: 200, pollMs: 50, log: (m) => log.push(m) });
    expect(code).toBe(1);
    expect(log.join('\n')).toContain(`a jobs worker from before the rename (Demo Studio, pid ${sleeper.pid}) still runs on this workspace — this jobs worker would run beside it`);
    expect(log.join('\n')).toContain('let its job finish and stop that worker, then try again — or remove');
    expect(log.join('\n')).not.toContain('kill');
  });
});

describe('the old HTTP token variable (R-REN-04)', () => {
  it('a worker a client starts never gets the HTTP token under its old variable either', () => {
    const env = cleanWorkerEnv({ DEMO_STUDIO_MCP_TOKEN: 'old-token', RETAKE_MCP_TOKEN: 'new-token', DEMO_STUDIO_OTHER: 'kept', PATH: '/usr/bin' }, tmp, { node: '/n/bin/node', exists: () => false });
    expect(env.DEMO_STUDIO_MCP_TOKEN).toBeUndefined();
    expect(env.RETAKE_MCP_TOKEN).toBeUndefined();
    expect(env.DEMO_STUDIO_OTHER).toBe('kept');
  });
});

describe('a theme the tool made before the rename (D0)', () => {
  async function theme(dir: string, provFile: string, madeBy: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    const files: Record<string, string> = { 'template.yaml': 'version: 1\nname: Harbor\n', 'brand.json': '{"name":"Harbor"}\n' };
    for (const [f, text] of Object.entries(files)) await writeFile(join(dir, f), text);
    const hashes = Object.fromEntries(Object.entries(files).map(([f, text]) => [f, sha256Hex(Buffer.from(text))]));
    await writeFile(join(dir, provFile), JSON.stringify({ version: 1, made_by: madeBy, tool_version: '0.1.0', created_at: '2026-10-01T10:00:00.000Z', name: 'harbor', base: 'editorial', trust: 'author', inputs: {}, files: hashes }));
  }

  it('its old provenance file and made_by are still the tool\'s: replaceable while unchanged; anything else is not', async () => {
    await theme(join(tmp, 'themes', 'old'), '.demo-studio-theme.json', 'demo-studio');
    expect(await replaceProblem(join(tmp, 'themes', 'old'))).toBeNull();
    await theme(join(tmp, 'themes', 'new'), '.retake-theme.json', 'retake');
    expect(await replaceProblem(join(tmp, 'themes', 'new'))).toBeNull();
    await theme(join(tmp, 'themes', 'other'), '.demo-studio-theme.json', 'someone-else');
    expect(await replaceProblem(join(tmp, 'themes', 'other'))).toBe(`${join(tmp, 'themes', 'other')}: .demo-studio-theme.json is not this tool's`);
    await writeFile(join(tmp, 'themes', 'old', 'brand.json'), '{"name":"Changed"}\n');
    expect(await replaceProblem(join(tmp, 'themes', 'old'))).toBe('brand.json was changed since it was made');
  });
});

describe('engine_info and the old home (critique H3)', () => {
  it('`legacy.old_home` while the old home holds the only sign-ins; absent once RETAKE_HOME is set', async () => {
    const ws = join(tmp, 'ws-info');
    await mkdir(ws, { recursive: true });
    await fixtureWorkspace(ws);
    const home = join(tmp, 'home-info');
    await mkdir(join(home, '.demo-studio', 'sessions'), { recursive: true });
    const saved = { HOME: process.env.HOME, RETAKE_HOME: process.env.RETAKE_HOME };
    const engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    try {
      process.env.HOME = home;
      delete process.env.RETAKE_HOME; // scratch HOME: restored below
      expect(engine.info().legacy).toEqual({ old_home: '~/.demo-studio' });
      process.env.RETAKE_HOME = join(tmp, 'scratch-home');
      expect(engine.info().legacy).toBeUndefined();
    } finally {
      process.env.HOME = saved.HOME;
      process.env.RETAKE_HOME = saved.RETAKE_HOME;
    }
  });

  it('`legacy.old_vars`: old variables set without their new twin, by name only; outgoing names and set twins are not counted (reviews A M4, B M4)', async () => {
    const ws = join(tmp, 'ws-vars');
    await mkdir(ws, { recursive: true });
    await fixtureWorkspace(ws);
    const home = join(tmp, 'home-vars');
    await mkdir(home, { recursive: true });
    const keys = ['HOME', 'RETAKE_HOME', 'RETAKE_ROOT', 'DEMO_STUDIO_HOME', 'DEMO_STUDIO_ROOT', 'DEMO_STUDIO_SANDBOX'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const engine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    try {
      process.env.HOME = home;
      delete process.env.RETAKE_HOME; // scratch HOME: restored below
      delete process.env.RETAKE_ROOT;
      process.env.DEMO_STUDIO_HOME = '/scratch/old-home';
      process.env.DEMO_STUDIO_ROOT = '/scratch/old-ws';
      process.env.DEMO_STUDIO_SANDBOX = '1';
      expect(engine.info().legacy).toEqual({ old_vars: ['DEMO_STUDIO_HOME', 'DEMO_STUDIO_ROOT'] });
      process.env.RETAKE_HOME = join(tmp, 'scratch-home');
      process.env.RETAKE_ROOT = ws;
      expect(engine.info().legacy).toBeUndefined();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
