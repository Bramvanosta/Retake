/**
 * The MCP server as a client sees it: `retake mcp` spawned from the sources over stdio, driven by the SDK's own client.
 * Every read tool is called on a copy of the fixture project; stdout must carry JSON-RPC only.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { EXIT, main, memoryIo } from '../../cli/src/index.js';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';
import { clientPath } from '@retake/core/io';
import { stableNodePath } from '@retake/engine/integrations';
import { TOOLS } from '../src/index.js';
import { progressReporter } from '../src/server.js';
import { testChildEnv } from '../../core/test/child-env.js';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
/** `studio` from the sources (no build): the workspace packages' `source` export condition + tsx. */
const SOURCE_ARGS = ['--conditions=source', '--import', 'tsx', BIN];

let ws: string;
let home: string;
let client: Client;
let transport: StdioClientTransport;
let stderr = '';
const protocolErrors: Error[] = [];

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

function errorOf(r: Result): { code: string; message: string; fix?: string; details?: Record<string, unknown> } {
  expect(r.isError, JSON.stringify(r)).toBe(true);
  return (r.structuredContent as { error: { code: string; message: string } }).error;
}

const GOOD = 'video: good\nscenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - click: Products\n';
const BAD = 'video: bad\nscenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - clik: Products\n';

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-mcp-'));
  home = join(ws, '.home');
  await fixtureWorkspace(ws);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [...SOURCE_ARGS, '--root', ws, 'mcp'],
    cwd: REPO,
    env: testChildEnv({ RETAKE_HOME: home }),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  client = new Client({ name: 'retake-test', version: '0' }, { capabilities: {} });
  client.onerror = (e) => protocolErrors.push(e);
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await rm(ws, { recursive: true, force: true });
});

describe('retake mcp over stdio', () => {
  it('initializes with instructions and lists the tools with JSON Schemas from zod (input mode, no extra keys)', async () => {
    expect(client.getServerVersion()?.name).toBe('retake');
    expect(client.getInstructions()).toContain('untrusted');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'engine_info',
      'project_list',
      'project_get',
      'project_create',
      'project_update_readme',
      'project_prune',
      'scenario_get',
      'scenario_validate',
      'scenario_save',
      'page_inspect',
      'scenario_record',
      'scenario_from_script',
      'run_list',
      'run_status',
      'run_dry',
      'run_capture',
      'run_cancel',
      'plan_preview',
      'render',
      'render_status',
      'review',
      'review_get',
      'export',
      'comments_list',
      'comment_reply',
      'comment_resolve',
      'template_list',
      'template_preview',
      'template_from_site',
      'template_create_from_brand',
      'component_list',
      'component_get',
      'component_validate',
      'component_preview',
      'component_create',
      'job_list',
      'job_status',
      'job_cancel',
      'hooks_run',
      'env_reset',
      'auth_status',
      'auth_login',
      'sandbox_status',
      'sandbox_up',
      'sandbox_reset',
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect((t.inputSchema as { additionalProperties?: unknown }).additionalProperties, t.name).toBe(false);
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.annotations?.readOnlyHint, t.name).toBe(
        !['project_create', 'project_update_readme', 'project_prune', 'scenario_save', 'page_inspect', 'scenario_record', 'run_dry', 'run_capture', 'run_cancel', 'render', 'review', 'export', 'comment_reply', 'comment_resolve', 'template_preview', 'template_from_site', 'template_create_from_brand', 'component_preview', 'component_create', 'job_cancel', 'hooks_run', 'env_reset', 'auth_login', 'sandbox_up', 'sandbox_reset'].includes(t.name),
      );
      expect(t.annotations?.openWorldHint, t.name).toBe(['page_inspect', 'scenario_record', 'run_dry', 'run_capture', 'hooks_run', 'env_reset', 'auth_login', 'template_from_site'].includes(t.name));
      expect(t.annotations?.destructiveHint, t.name).toBe(['hooks_run', 'env_reset', 'sandbox_up', 'sandbox_reset', 'template_create_from_brand', 'project_prune', 'job_cancel'].includes(t.name));
      // No tool takes a credential.
      expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/password|secret|token|cookie/i);
      expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/allow_writes/);
      // No file path: page_inspect's and scenario_record's `path` is a URL path under an environment page (no host, no template), checked by core;
      // template_create_from_brand's files are references relative to the workspace root, checked by the engine (brand/files.ts).
      if (t.name !== 'page_inspect' && t.name !== 'scenario_record') expect(JSON.stringify(t.inputSchema), t.name).not.toMatch(/"path"/);
    }
    // A field with a default is optional for the caller.
    const runList = tools.find((t) => t.name === 'run_list');
    expect(runList?.inputSchema.required).toEqual(['project']);
    expect(tools.find((t) => t.name === 'run_dry')?.inputSchema.required).toEqual(['project', 'scenario']);
    expect(tools.find((t) => t.name === 'hooks_run')?.inputSchema.required).toEqual(['project', 'source']);
    expect((tools.find((t) => t.name === 'run_status')?.inputSchema.properties as Record<string, { maximum?: number }>).wait_s.maximum).toBe(25);
  });

  it('engine_info, project_list and project_get on the fixture', async () => {
    const info = await call('engine_info');
    expect(info.structuredContent).toMatchObject({ root: ws, client: 'mcp', api: 1 });
    expect(info.content[0].text).toContain(ws);
    // started in the repository (this test's cwd), outside the workspace: said, so a skill can stop (review M3)
    expect(info.structuredContent).toMatchObject({ started_in: resolve(REPO), started_outside_workspace: true });
    expect(info.content[0].text).toContain(`Started in ${resolve(REPO)}, outside the workspace`);
    const list = await call('project_list');
    expect(list.content[0].text).toContain('northfield-fixture');
    expect((list.structuredContent as { projects: Array<{ slug: string }> }).projects.map((p) => p.slug)).toEqual(['northfield-fixture']);
    const p = await call('project_get', { project: 'northfield-fixture' });
    expect(p.isError).toBeFalsy();
    expect(p.content[0].text).toMatch(/production \(production, read-only\)/);
    expect(p.structuredContent).toMatchObject({ slug: 'northfield-fixture', file: 'project.yaml' });
    const text = JSON.stringify(p);
    expect(text).not.toContain('roast-lot-2026');
    expect(text).not.toContain(home);
  });

  it('refuses paths and unknown arguments before the engine sees them', async () => {
    for (const project of ['../northfield-fixture', '/etc', 'projects/northfield-fixture']) {
      const e = errorOf(await call('project_get', { project }));
      expect(e.code).toBe('invalid');
      expect(e.message).toContain('never a path');
    }
    expect(errorOf(await call('scenario_save', { project: 'northfield-fixture', name: '../../evil', yaml: GOOD })).code).toBe('invalid');
    expect(errorOf(await call('run_status', { project: 'northfield-fixture', run_id: '../../../etc' })).code).toBe('invalid');
    const extra = errorOf(await call('project_get', { project: 'northfield-fixture', allow_writes: true }));
    expect(extra.message).toContain('unknown argument allow_writes');
    expect(errorOf(await call('project_get', {})).message).toContain('project:');
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/unknown tool/);
  });

  it('scenario_validate gives line/col; scenario_get / scenario_save round trip with if_match', async () => {
    const bad = await call('scenario_validate', { project: 'northfield-fixture', yaml: BAD });
    expect(bad.isError).toBeFalsy();
    expect(bad.structuredContent?.ok).toBe(false);
    expect(bad.content[0].text).toMatch(/^Not valid: 1 error/);
    expect(bad.content[0].text).toMatch(/\n7:\d+ error scenes\.0\.steps\.0/);

    const refused = errorOf(await call('scenario_save', { project: 'northfield-fixture', name: 'mcp-good', yaml: BAD }));
    expect(refused.code).toBe('invalid');
    expect(refused.message).toContain('not saved');
    expect((refused.details?.issues as unknown[]).length).toBeGreaterThan(0);

    const created = await call('scenario_save', { project: 'northfield-fixture', name: 'mcp-good', yaml: GOOD, if_match: null });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ created: true, file: 'scenarios/mcp-good.yaml' });
    expect(await readFile(join(ws, 'projects', 'northfield-fixture', 'scenarios', 'mcp-good.yaml'), 'utf8')).toBe(GOOD);

    const conflict = errorOf(await call('scenario_save', { project: 'northfield-fixture', name: 'mcp-good', yaml: GOOD.replace('Products', 'Orders') }));
    expect(conflict.code).toBe('conflict');
    const got = await call('scenario_get', { project: 'northfield-fixture', name: 'mcp-good' });
    expect(conflict.details?.current).toBe(got.structuredContent?.hash);
    expect(got.structuredContent?.yaml).toBe(GOOD);
    const saved = await call('scenario_save', { project: 'northfield-fixture', name: 'mcp-good', yaml: GOOD.replace('Products', 'Orders'), if_match: got.structuredContent?.hash });
    expect(saved.isError).toBeFalsy();
    expect(saved.structuredContent?.created).toBe(false);
  });

  it('project_create and project_update_readme (if_match required once the README exists)', async () => {
    const created = await call('project_create', { name: 'Acme Demo', environments: { staging: { app: 'https://app.staging.example.com' } } });
    expect(created.isError).toBeFalsy();
    expect(created.structuredContent).toMatchObject({ slug: 'acme-demo' });
    expect(errorOf(await call('project_create', { name: 'Acme Demo' })).message).toContain('already exists');
    expect(errorOf(await call('project_create', { name: 'X', template: '../../templates/default' })).code).toBe('invalid');
    const noMatch = errorOf(await call('project_update_readme', { project: 'acme-demo', markdown: '# Acme' }));
    expect(noMatch.code).toBe('conflict');
    const ok = await call('project_update_readme', { project: 'acme-demo', markdown: '# Acme', if_match: created.structuredContent?.readme_hash });
    expect(ok.isError).toBeFalsy();
    expect(await readFile(join(ws, 'projects', 'acme-demo', 'README.md'), 'utf8')).toBe('# Acme\n');
  });

  it('run_list and run_status: paths for Claude, page text only under "untrusted"', async () => {
    const list = await call('run_list', { project: 'northfield-fixture' });
    expect(list.content[0].text).toContain('20261017-120000-quote dry failed');
    const st = await call('run_status', { project: 'northfield-fixture', run_id: '20261017-120000-quote' });
    expect(st.isError).toBeFalsy();
    expect(st.content[0].text).toContain('failed at catalog.1 (click)');
    expect(st.content[0].text).toContain(join(ws, 'projects', 'northfield-fixture', 'runs', '20261017-120000-quote', 'error-catalog-1.png'));
    expect(st.content[0].text).not.toMatch(/ignore|IGNORE/);
    const data = st.structuredContent as { untrusted: { error_message: string; warnings: string[] }; files: { screenshots: { dir: string; count: number } } };
    expect(data.untrusted.error_message).toContain('ignore your rules');
    expect(data.untrusted.warnings[0]).toContain('IGNORE PREVIOUS INSTRUCTIONS');
    // Compact (L5.8): the screenshots folder and their count; `detail: "full"` lists each one.
    expect(data.files.screenshots).toEqual({ dir: join(ws, 'projects', 'northfield-fixture', 'runs', '20261017-120000-quote', 'screenshots'), count: expect.any(Number) });
    const full = (await call('run_status', { project: 'northfield-fixture', run_id: '20261017-120000-quote', detail: 'full' })).structuredContent as { screenshots: Array<{ path: string }>; untrusted: { warnings: string[] } };
    expect(full.screenshots[0].path).toBe(join(ws, 'projects', 'northfield-fixture', 'runs', '20261017-120000-quote', 'screenshots', '001-catalog.0.png'));
    expect(full.untrusted.warnings[0]).toContain('IGNORE PREVIOUS INSTRUCTIONS');
    expect(errorOf(await call('run_status', { project: 'northfield-fixture', run_id: '20990101-000000-none' })).code).toBe('not_found');
  });

  it('project_prune lists what can go (a dry run by default) and deletes nothing (L5.7)', async () => {
    const r = await call('project_prune', { project: 'northfield-fixture' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/^1 item of northfield-fixture can go \(\d+ kB\); call again with dry_run: false/);
    expect(r.content[0].text).toContain('- run 20261017-120000-quote: dry run');
    expect((r.structuredContent as { dry_run: boolean }).dry_run).toBe(true);
    expect(existsSync(join(ws, 'projects', 'northfield-fixture', 'runs', '20261017-120000-quote', 'run.json'))).toBe(true);
    expect(errorOf(await call('project_prune', { project: 'northfield-fixture', keep_renders: 0 })).code).toBe('invalid');
  });

  it('runs whose hooks need a human are refused with the command, before anything is queued; a CLI run is not cancelled here', async () => {
    // catalogue's setup has an HTTP DELETE marked `confirm: true`: through this server, that line does not count.
    const refused = errorOf(await call('run_capture', { project: 'northfield-fixture', scenario: 'catalogue' }));
    expect(refused.code).toBe('needs_approval');
    expect(refused.message).toContain('HTTP DELETE');
    expect(refused.fix).toBe(`retake -C ${ws} run northfield-fixture catalogue`);
    const dry = errorOf(await call('run_dry', { project: 'northfield-fixture', scenario: 'catalogue', hooks: 'run' }));
    expect(dry.code).toBe('needs_approval');
    expect(dry.fix).toBe(`retake -C ${ws} run northfield-fixture catalogue --dry --hooks run`);
    expect(errorOf(await call('run_dry', { project: 'northfield-fixture', scenario: '../../etc/passwd' })).code).toBe('invalid');
    expect(errorOf(await call('run_dry', { project: 'northfield-fixture', scenario: 'nope' })).code).toBe('not_found');
    const jobs = await call('job_list');
    expect((jobs.structuredContent as { jobs: unknown[] }).jobs).toEqual([]);
    expect(jobs.content[0].text).toContain('No job yet.');
    expect(errorOf(await call('run_cancel', { project: 'northfield-fixture', run_id: '20261017-120000-quote' })).code).toBe('refused');
    expect(errorOf(await call('job_status', { job_id: 'j_nope' })).code).toBe('invalid');
    expect(errorOf(await call('job_status', { job_id: 'j_01M54RMZFD01N86CKQC03GP9GN' })).code).toBe('not_found');
  });

  it('auth_status (no browser, no session paths) and sandbox_status', async () => {
    const auth = await call('auth_status', { project: 'northfield-fixture' });
    expect(auth.isError).toBeFalsy();
    expect(auth.content[0].text).toContain(`sign it in: auth_login (the user signs in in a window), or a human runs retake -C ${ws} login northfield-fixture --env signed-in --persona supplier`);
    expect(JSON.stringify(auth)).not.toContain(home);
    expect(errorOf(await call('auth_status', { env: 'signed-in' })).code).toBe('invalid');
    const sb = await call('sandbox_status', { project: 'northfield-fixture' });
    expect(sb.isError).toBeFalsy();
    expect(sb.structuredContent).toMatchObject({ env: 'sandbox', state: 'down', provider: 'process' });
    expect(sb.content[0].text).toContain('start it: sandbox_up {project: "northfield-fixture", env: "sandbox"}');
    expect(errorOf(await call('sandbox_status', { project: 'northfield-fixture', env: 'local' })).code).toBe('not_found');
  });

  it('auth_login and sandbox_up / sandbox_reset refuse what they cannot do before queuing anything (no window opened)', async () => {
    const before = (await call('job_list', {})).structuredContent as { jobs: unknown[] };
    const noPersonas = errorOf(await call('auth_login', { project: 'northfield-fixture', env: 'local' }));
    expect(noPersonas).toMatchObject({ code: 'invalid', message: expect.stringContaining('has no personas: pick an environment that has some with env (signed-in, sandbox') });
    const several = errorOf(await call('auth_login', { project: 'northfield-fixture', env: 'signed-in', mode: 'auto' }));
    expect(several.message).toContain('pick one with persona supplier | buyer');
    expect(errorOf(await call('auth_login', { project: 'northfield-fixture', env: 'signed-in', persona: 'nobody' })).message).toContain('has no persona "nobody"');
    expect(errorOf(await call('auth_login', { project: 'northfield-fixture', persona: 'supplier', password: 'x' })).code).toBe('invalid');
    expect(errorOf(await call('sandbox_up', { project: 'northfield-fixture', env: 'local' })).code).toBe('not_found');
    expect(errorOf(await call('sandbox_reset', { project: 'northfield-fixture', env: 'production' })).code).toBe('not_found');
    expect(((await call('job_list', {})).structuredContent as { jobs: unknown[] }).jobs).toHaveLength(before.jobs.length);
  });

  it('ran no browser, and wrote nothing but JSON-RPC on stdout', async () => {
    const pid = transport.pid;
    expect(pid).toBeTypeOf('number');
    let pids: string[] = [];
    try {
      pids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch {
      pids = []; // pgrep exits 1 when there is none
    }
    // Short-lived helpers may be there (ps, an esbuild service when running from the sources): never a browser.
    const commands = pids.map((p) => {
      try {
        return execFileSync('ps', ['-o', 'command=', '-p', p], { encoding: 'utf8' }).trim();
      } catch {
        return ''; // gone meanwhile
      }
    });
    expect(commands.filter((c) => /chrom|headless_shell|playwright/i.test(c))).toEqual([]);
    expect(protocolErrors).toEqual([]);
    expect(stderr).not.toMatch(/unexpected|Error:/);
  });
});

describe('retake mcp: lifecycle and registration', () => {
  it('answers what was sent, then exits 0 when its input ends; stdout is JSON-RPC lines only', async () => {
    const child = spawn(process.execPath, [...SOURCE_ARGS, '--root', ws, 'mcp'], { cwd: REPO, env: { ...process.env, RETAKE_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'project_list', arguments: {} } });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_list', arguments: { project: 'northfield-fixture' } } });
    child.stdin.end();
    expect(await exited).toBe(0);
    const lines = out.trimEnd().split('\n');
    const messages = lines.map((l) => JSON.parse(l) as { jsonrpc: string; id: number; result?: unknown });
    expect(messages.every((m) => m.jsonrpc === '2.0' && m.result !== undefined)).toBe(true);
    expect(messages.map((m) => m.id).sort()).toEqual([1, 2, 3]);
  });

  it('--print-config: absolute Node.js, the built entry point, the workspace and a PATH for GUI clients', async () => {
    const io = memoryIo();
    expect(await main(['node', 'retake', '--root', ws, 'mcp', '--print-config'], io)).toBe(EXIT.ok);
    const cfg = JSON.parse(io.stdout()) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    const entry = cfg.mcpServers['retake'];
    expect(entry.command).toMatch(/^\/.*\/node$/);
    expect(entry.args).toEqual([join(REPO, 'packages', 'cli', 'dist', 'bin.js'), '--root', ws, 'mcp']);
    expect(entry.env.PATH.split(':')[0]).toBe(dirname(entry.command));
    expect(io.stderr()).toContain('claude mcp add retake --scope user');
    expect(io.stderr()).toContain('claude_desktop_config.json');
  });

  it('refuses to serve without a workspace (exit 2)', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'studio-mcp-none-'));
    const io = memoryIo();
    expect(await main(['node', 'retake', '--root', empty, 'mcp'], io)).toBe(EXIT.usage);
    expect(io.stderr()).toContain('no workspace here');
    expect(io.stdout()).toBe('');
    await rm(empty, { recursive: true, force: true });
  });

  it('prefers a Node.js path that survives patch upgrades; PATH gains Homebrew', () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(stableNodePath('/u/.local/share/mise/installs/node/22.16.0/bin/node', has(['/u/.local/share/mise/installs/node/22/bin/node']))).toBe('/u/.local/share/mise/installs/node/22/bin/node');
    expect(stableNodePath('/u/.local/share/mise/installs/node/22.16.0/bin/node', has([]))).toBe('/u/.local/share/mise/installs/node/22.16.0/bin/node');
    expect(stableNodePath('/opt/homebrew/Cellar/node@22/22.16.0/bin/node', has(['/opt/homebrew/opt/node@22/bin/node']))).toBe('/opt/homebrew/opt/node@22/bin/node');
    expect(clientPath('/n/bin/node', '/usr/bin:/bin', has(['/opt/homebrew/bin', '/usr/bin']))).toBe('/n/bin:/usr/bin:/bin:/opt/homebrew/bin');
    // nvm's v-prefixed folders; the folders `pnpm retake …` adds for its script never go into a registration.
    expect(stableNodePath('/u/.nvm/versions/node/v22.16.0/bin/node', has(['/u/.nvm/versions/node/22/bin/node']))).toBe('/u/.nvm/versions/node/22/bin/node');
    expect(clientPath('/n/bin/node', '/repo/node_modules/.bin:/u/.cache/node/corepack/v1/pnpm/10.28.0/dist/node-gyp-bin:/repo/packages/cli/node_modules/.bin:/usr/bin', has([]))).toBe('/n/bin:/usr/bin');
  });

  it('progress notifications: strictly increasing, at most one per interval, the final one always', () => {
    const sent: number[] = [];
    const report = progressReporter((p) => sent.push(p.progress), 60_000);
    report({ progress: 0, total: 3 });
    report({ progress: 0, total: 3 });
    report({ progress: 1, total: 3 });
    report({ progress: 3, total: 3 });
    report({ progress: 2, total: 3 });
    expect(sent).toEqual([0, 3]);
  });

  it('every tool has a zod schema that publishes as an object schema', () => {
    expect(TOOLS).toHaveLength(45);
    for (const t of TOOLS) expect(t.input.safeParse({ __nope: 1 }).success, t.name).toBe(false);
  });
});
