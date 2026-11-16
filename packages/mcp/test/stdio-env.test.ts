/**
 * R-ENV-06 / R-ENV-07 over stdio: `retake mcp` spawned from the sources, driven by SDK clients that answer elicitation
 * (accept, decline) or do not declare it. project_env_set on the project's own origins writes without a form; a new
 * origin and the removal of a production environment ask the user (the form: the change, why, the terminal command);
 * a decline or a client that cannot ask writes nothing.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { REPO } from '@retake/test-support/repo';
import { testChildEnv } from '@retake/test-support/child-env';
import { projectChangeApprovalForm } from '../src/approval.js';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const SOURCE_ARGS = ['--conditions=source', '--import', 'tsx', BIN];

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

const PROJECT = [
  'name: Northfield',
  'environments:',
  '  local:   # this machine',
  '    console: http://localhost:4521',
  '  live:',
  '    production: true',
  '    pages:',
  '      console: https://console.example.com',
  'default_env: local',
  'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
  'template: default',
  '',
].join('\n');

let ws: string;
let file: string;
const sessions: Client[] = [];

async function connect(answer?: 'accept' | 'decline'): Promise<{ client: Client; asked: Array<{ message: string }> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...SOURCE_ARGS, '--root', ws, 'mcp'],
    cwd: REPO,
    env: testChildEnv({ RETAKE_HOME: join(ws, '.home'), RETAKE_WORKER_IDLE_MS: '1500' }),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'retake-test', version: '0' }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  const asked: Array<{ message: string }> = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push({ message: (req.params as { message: string }).message });
      return answer === 'accept' ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
    });
  }
  await client.connect(transport);
  sessions.push(client);
  return { client, asked };
}

const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<Result> => (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as Result;

function errorOf(r: Result): { code: string; message: string; fix?: string } {
  expect(r.isError, JSON.stringify(r)).toBe(true);
  return (r.structuredContent as { error: { code: string; message: string; fix?: string } }).error;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-mcp-env-'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  await mkdir(join(ws, 'projects', 'northfield', 'scenarios'), { recursive: true });
  file = join(ws, 'projects', 'northfield', 'project.yaml');
  await writeFile(file, PROJECT);
}, 60_000);

afterAll(async () => {
  await Promise.all(sessions.map((c) => c.close().catch(() => undefined)));
  await rm(ws, { recursive: true, force: true });
});

describe('project_env_set / project_env_remove through MCP (R-ENV-06, R-ENV-07)', () => {
  it("the project's own origins are written without a form; the tools are a write and a destructive one", async () => {
    const { client, asked } = await connect('accept');
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === 'project_env_set')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.find((t) => t.name === 'project_env_remove')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const r = await call(client, 'project_env_set', { project: 'northfield', env: 'demo', pages: { console: { url: 'http://localhost:4521', display: 'console.example.com' } } });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect(asked).toEqual([]);
    expect(r.content[0].text).toMatch(/^Environment demo of northfield added to project\.yaml\./);
    expect(await readFile(file, 'utf8')).toBe(PROJECT.replace('default_env:', '  demo:\n    console: {url: http://localhost:4521, display: console.example.com}\ndefault_env:'));
  }, 60_000);

  it('a new origin: a decline writes nothing, an accept writes; the form shows the change, why and the command', async () => {
    const before = await readFile(file, 'utf8');
    const no = await connect('decline');
    const e = errorOf(await call(no.client, 'project_env_set', { project: 'northfield', env: 'stg', pages: { console: 'https://console.stg.example.com' } }));
    expect(e.code).toBe('refused');
    expect(e.fix).toMatch(/ env add northfield stg --page console=https:\/\/console\.stg\.example\.com$/);
    expect(no.asked).toHaveLength(1);
    expect(no.asked[0].message).toContain('- add environment stg (read-write)\n- page console: https://console.stg.example.com\nIt needs you because:\n- page console reaches https://console.stg.example.com:443');
    expect(no.asked[0].message).toMatch(/Instead, you can run it yourself in a terminal: retake -C .+ env add northfield stg --page console=https:\/\/console\.stg\.example\.com$/);
    expect(await readFile(file, 'utf8')).toBe(before);
    const yes = await connect('accept');
    const r = await call(yes.client, 'project_env_set', { project: 'northfield', env: 'stg', pages: { console: 'https://console.stg.example.com' } });
    expect(r.content[0].text).toContain('added to project.yaml, as the user approved');
    expect(await readFile(file, 'utf8')).toContain('  stg:\n    console: https://console.stg.example.com\n');
  }, 60_000);

  it('project_env_remove of a production environment needs the user: no form → needs_approval, nothing removed', async () => {
    const before = await readFile(file, 'utf8');
    const { client } = await connect();
    const e = errorOf(await call(client, 'project_env_remove', { project: 'northfield', env: 'live' }));
    expect(e.code).toBe('needs_approval');
    expect(e.fix).toMatch(/ env remove northfield live$/);
    expect(await readFile(file, 'utf8')).toBe(before);
    const yes = await connect('accept');
    const r = await call(yes.client, 'project_env_remove', { project: 'northfield', env: 'live' });
    expect(r.content[0].text).toMatch(/^Environment live of northfield removed from project\.yaml, as the user approved\./);
    expect(await readFile(file, 'utf8')).not.toContain('live:');
  }, 60_000);

  it('the form asks one checkbox, unchecked by default', () => {
    const form = projectChangeApprovalForm({ what: 'environment change', project: 'p', env: 'e', lines: ['x'], asks: ['y'], fix: 'retake env set p e' });
    expect(form.requestedSchema).toEqual({
      type: 'object',
      properties: { approve: { type: 'boolean', title: 'Write this change to project.yaml', description: 'Check to write the change listed above, once.', default: false } },
      required: ['approve'],
    });
  });
});
