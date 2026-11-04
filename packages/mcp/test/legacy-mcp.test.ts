/**
 * old-name: this whole file (the guard test allows it).
 *
 * L5.13 through MCP, on a server started from the sources over stdio, with no RETAKE_HOME and an old DEMO_STUDIO_HOME
 * still exported whose folder holds the only sign-ins (a HOME whose `.demo-studio` holds some too — not that person's:
 * the L5.13a leftover, the old home is the variable's folder):
 * - critique H1: a scenario whose `eval.file` lies in an old `.demo-studio/` folder of the project is refused (its
 *   files — page dumps, drafts — are never run as code);
 * - critique H3 / L10: the old-home line goes to stderr only (the protocol on stdout stays clean) and engine_info says it;
 *   likewise the old variable (reviews A M4 / B M4: a client launched with an old registration env never shows stderr);
 * - critique M4: `retake mcp` does not start beside a Studio of the old build still serving the workspace, and says how
 *   to go on (review B M2: the fix line).
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { processStart } from '@retake/sandbox';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const SOURCE_ARGS = ['--conditions=source', '--import', 'tsx', BIN];

let tmp: string;
let ws: string;
let home: string;
let client: Client;
let transport: StdioClientTransport;
let stderr = '';
let sleeper: ChildProcess;
const protocolErrors: Error[] = [];

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'retake-legacy-mcp-'));
  ws = join(tmp, 'ws');
  home = join(tmp, 'home');
  await mkdir(ws, { recursive: true });
  await fixtureWorkspace(ws);
  await mkdir(join(home, '.demo-studio', 'profiles', 'northfield-fixture', 'signed-in', 'buyer'), { recursive: true });
  await mkdir(join(tmp, 'old-custom-home', 'profiles', 'northfield-fixture', 'signed-in', 'buyer'), { recursive: true });
  const old = join(ws, 'projects', 'northfield-fixture', '.demo-studio', 'inspect', 'i_01');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'dump.js'), 'document.title');
  sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [...SOURCE_ARGS, '--root', ws, 'mcp'],
    cwd: REPO,
    env: { PATH: process.env.PATH ?? '', CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME ?? '', HOME: home, DEMO_STUDIO_HOME: join(tmp, 'old-custom-home') },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  client = new Client({ name: 'retake-legacy-test', version: '0' }, { capabilities: {} });
  client.onerror = (e) => protocolErrors.push(e);
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  sleeper?.kill('SIGKILL');
  await rm(tmp, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;

describe('MCP and the names from before the rename', () => {
  it('an eval.file under the old tool folder is refused: never run as code (critique H1)', async () => {
    const yaml = 'video: old-folder\nscenes:\n  - id: home\n    page: console\n    open: /\n    steps:\n      - eval: {file: .demo-studio/inspect/i_01/dump.js}\n';
    const r = await call('scenario_validate', { project: 'northfield-fixture', yaml });
    const text = JSON.stringify(r);
    expect(text).toContain('.demo-studio/inspect/i_01/dump.js is a file an agent can write through MCP');
    expect(r.structuredContent?.ok).toBe(false);
  });

  it('the old-home line is on stderr, never on stdout; engine_info says the sign-ins are not read (critique H3, L10)', async () => {
    const info = await call('engine_info');
    expect(info.isError).toBeFalsy();
    const custom = join(tmp, 'old-custom-home');
    expect(info.structuredContent?.legacy).toEqual({ old_home: custom, old_home_var: 'DEMO_STUDIO_HOME', old_vars: ['DEMO_STUDIO_HOME'] });
    expect(info.content[0].text).toContain(`The signed-in sessions from before the rename (${custom}, the folder DEMO_STUDIO_HOME names) are not read: personas show as never signed in until the user sets RETAKE_HOME to that folder or moves it`);
    const vars = info.content[0].text.slice(info.content[0].text.indexOf("This server's environment"));
    expect(vars).toContain("This server's environment sets DEMO_STUDIO_HOME (names from before the rename), no longer read: ask the user to rename it RETAKE_HOME where set");
    expect(vars).not.toContain('old-custom-home');
    expect(info.content[0].text).not.toContain('~/.demo-studio');
    expect(stderr).toContain(`Sign-ins from before the rename are in ${custom}, set by DEMO_STUDIO_HOME, and not read (Retake keeps them in ~/.retake): set RETAKE_HOME to it, or move it`);
    expect(stderr).not.toContain('~/.demo-studio');
    expect(stderr).toContain("DEMO_STUDIO_HOME is set but no longer read: rename it RETAKE_HOME where it is set — shell profile, the MCP registration's env");
    expect(protocolErrors).toEqual([]);
  });

  it('`retake mcp` refuses to start beside a Studio of the old build still serving the workspace (critique M4)', async () => {
    const other = join(tmp, 'ws-old-ui');
    await mkdir(join(other, 'projects'), { recursive: true });
    await writeFile(join(other, 'retake.yaml'), 'version: 1\n');
    await mkdir(join(other, '.demo-studio'), { recursive: true });
    const started = new Date((await processStart(sleeper.pid!))!).toISOString();
    await writeFile(join(other, '.demo-studio', 'ui.json'), JSON.stringify({ version: 1, kind: 'ui', pid: sleeper.pid, started_at: started, port: 4999, url: 'http://127.0.0.1:4999/', token: 'x'.repeat(40), since: '2026-11-01T10:00:00.000Z' }));
    const r = spawnSync(process.execPath, [...SOURCE_ARGS, '--root', other, 'mcp'], { cwd: REPO, env: { PATH: process.env.PATH ?? '', CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME ?? '', HOME: home, RETAKE_CAPTURES_DIR: process.env.RETAKE_CAPTURES_DIR ?? '', RETAKE_HOME: join(tmp, 'h2') }, input: '', encoding: 'utf8', timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`a Studio from before the rename (Demo Studio, pid ${sleeper.pid}) still runs on this workspace — this MCP server would run beside it`);
    const fix = r.stderr.split('\n').find((l) => l.includes('fix:'));
    expect(fix?.trim().replace(/^\W+/, '')).toBe(`fix: quit the Demo Studio app, or stop that Studio (Ctrl-C in its terminal), then try again — or remove ${join(other, '.demo-studio', 'ui.json')} if no old Studio or worker runs`);
  });
});
