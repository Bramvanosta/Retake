/**
 * R-ENV-06: `retake env add | set | remove` write the environments of project.yaml in place — only the environment's
 * lines and default_env change, every other byte (comments, CRLF) stays. A person's command asks nothing; a sandbox
 * environment and a result project.yaml with errors are refused; add refuses an existing environment, set a missing one.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, main, memoryIo } from '../src/index.js';
import { parsePageOptions } from '../src/commands/env.js';
import { EngineError, createEngine } from '@retake/engine';
import { editEnvironment, removeEnvironment } from '@retake/core';
import type { EnvironmentChange } from '@retake/core';

const PROJECT = [
  '# Northfield, filmed on this machine',
  'name: Northfield',
  'environments:',
  '  local:   # the fixture',
  '    console: http://localhost:4521',
  '  live:',
  '    production: true',
  '    pages:',
  '      console: https://console.example.com',
  'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
  'template: default',
  '',
].join('\r\n');

let ws = '';
let file = '';

async function cli(args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-env-cli-'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  await mkdir(join(ws, 'projects', 'shop', 'scenarios'), { recursive: true });
  file = join(ws, 'projects', 'shop', 'project.yaml');
});
beforeEach(async () => {
  await writeFile(file, PROJECT);
});
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('retake env add / set / remove (R-ENV-06)', () => {
  it('write project.yaml in place: its comments and CRLF line endings stay, nothing is asked (a new origin, production lowered)', async () => {
    const add = await cli(['env', 'add', 'shop', 'stg', '--page', 'console=https://console.stg.example.com,display=console.example.com', '--read-only']);
    expect(add.code, add.err).toBe(EXIT.ok);
    expect(add.out + add.err).toContain('add environment stg (read-only)');
    const set = await cli(['env', 'set', 'shop', 'live', '--no-production', '--default']);
    expect(set.code, set.err).toBe(EXIT.ok);
    expect(set.out + set.err).toContain('production: yes → no');
    expect(await readFile(file, 'utf8')).toBe(
      PROJECT.replace('      console: https://console.example.com\r\n', '      console: https://console.example.com\r\n  stg:\r\n    access: read-only\r\n    pages:\r\n      console: {url: https://console.stg.example.com, display: console.example.com}\r\ndefault_env: live\r\n').replace(
        '    production: true\r\n',
        '    access: read-only\r\n    production: false\r\n',
      ),
    );
    const rm1 = await cli(['env', 'remove', 'shop', 'stg', '--json']);
    expect(rm1.code, rm1.err).toBe(EXIT.ok);
    expect(JSON.parse(rm1.out)).toMatchObject({ action: 'removed', env: 'stg', environment: null, removed: { scenarios: [], sessions: 0 } });
  });

  it('env add refuses an existing environment, env set a missing one; a page that is not key=url is a usage error', async () => {
    expect((await cli(['env', 'add', 'shop', 'local', '--page', 'console=http://localhost:4521'])).err).toMatch(/environment local is already in project\.yaml/);
    const missing = await cli(['env', 'set', 'shop', 'qa', '--production']);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.err).toMatch(/environment qa is not in project\.yaml \(environments: local, live\)/);
    expect((await cli(['env', 'add', 'shop', 'qa'])).err).toMatch(/env add needs its pages/);
    expect((await cli(['env', 'set', 'shop', '../x', '--production'])).err).toMatch(/invalid environment "\.\.\/x": an environment name of project\.yaml, never a path/);
    expect(() => parsePageOptions(['console:http://x'])).toThrow(/expected key=url/);
    expect(parsePageOptions(['a=http://x', 'b=https://y/z,display=y.example.com'])).toEqual({ a: 'http://x', b: { url: 'https://y/z', display: 'y.example.com' } });
    expect(await readFile(file, 'utf8')).toBe(PROJECT);
  });

  it('refuses a result project.yaml with errors, naming the issue: nothing is written', async () => {
    await writeFile(file, PROJECT.replace('template: default\r\n', 'template: default\r\nauth:\r\n  local:\r\n    personas:\r\n      admin: {pages: [console]}\r\n'));
    const before = await readFile(file, 'utf8');
    const r = await cli(['env', 'remove', 'shop', 'local']);
    expect(r.code).not.toBe(EXIT.ok);
    expect(r.err).toMatch(/project\.yaml would not be valid — auth/);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('says project.yaml\'s warnings after a change; refuses removing the last page', async () => {
    await writeFile(file, PROJECT.replace('  local:   # the fixture\r\n    console: http://localhost:4521\r\n', '  local:   # the fixture\r\n    access: read-only\r\n    pages:\r\n      console: http://localhost:4521\r\n    read_only:\r\n      hosts: [api.example.com]\r\n'));
    const r = await cli(['env', 'set', 'shop', 'local', '--read-write']);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.out + r.err).toMatch(/project\.yaml: environments\.local\.read_only: read_only applies only to read-only runs/);
    const last = await cli(['env', 'set', 'shop', 'local', '--remove-page', 'console']);
    expect(last.code).toBe(EXIT.usage);
    expect(last.err).toMatch(/would have no page left: remove the environment instead/);
  });

  it('every `retake env` command an agent is handed runs as printed and writes what the agent asked for', async () => {
    const mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
    const cases: Array<[string, EnvironmentChange | 'remove']> = [
      ['stg', { pages: { console: '  https://console.stg.example.com/a  ', shop: { url: 'https://user:pw@shop.stg.example.com', display: 'shop.example.com' } }, access: 'read-only', default: false }],
      ['live', { production: false, default: true }],
      // A new environment given production / default false: `env add` has no --no-… flags.
      ['qa', { pages: { console: 'https://console.qa.example.com' }, production: false, default: false }],
      ['live', { pages: { console: "https://console.example.com/it's" } }],
      ['live', 'remove'],
    ];
    /** A command line split as a POSIX shell would (single quotes only, which is all the printer uses). */
    const words = (line: string) => [...line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]).replace(/''/g, ''));
    for (const [env, change] of cases) {
      await writeFile(file, PROJECT);
      const e = await (change === 'remove' ? mcp.projects.removeEnvironment('shop', env) : mcp.projects.setEnvironment('shop', env, change)).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(e, env).toBeInstanceOf(EngineError);
      const fix = (e as EngineError).fix!;
      const args = words(fix);
      expect(args.slice(0, 3)).toEqual(['retake', '-C', ws]);
      const run = await cli(args.slice(3));
      expect(run.code, `${fix}\n${run.err}`).toBe(EXIT.ok);
      // The person's run of the command writes what the agent asked for (sign-in details: USER:PASSWORD@ to fill in).
      const want = change === 'remove' ? removeEnvironment(PROJECT, env).text : editEnvironment(PROJECT, env, change, 'upsert').text;
      expect(await readFile(file, 'utf8'), fix).toBe(want.replace('user:pw@', 'USER:PASSWORD@'));
    }
  });
});
