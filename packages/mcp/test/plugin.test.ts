/**
 * L3.7 Claude Code plugin and registration: the local marketplace at the repository root, the `skills/` plugin (its
 * manifest, userConfig and the .mcp.json that starts `retake mcp` from those values), the plugin lines of
 * `retake mcp --print-config`, and the PATH `retake mcp` serves with (absolute entries only).
 *
 * The last block runs the real Claude Code CLI (gated: RETAKE_TEST_CLAUDE=1 or RETAKE_TEST_SLOW=1 — `pnpm
 * test:slow` — and `claude` on the PATH; `pnpm build` first): `claude plugin validate` on both manifests, `plugin details`
 * and `mcp list` (the server connected through `${user_config.*}`), with CLAUDE_CONFIG_DIR and RETAKE_HOME in a
 * temporary folder. It never installs, adds a marketplace or signs in; no model is called.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETAKE_VERSION } from '@retake/core';
import { clientPath } from '@retake/core/io';
import { EXIT, main, memoryIo } from '../../cli/src/index.js';
import { REPO as REPO_URL, fixtureWorkspace } from '../../engine/test/helpers.js';
import { PLUGIN_ID, claudeCodeCommand, mcpServerEntry, pluginInstallCommands, pluginMarketplaceRoot } from '@retake/engine/integrations';
import { testChildEnv } from '../../core/test/child-env.js';

const REPO = resolve(REPO_URL);
const PLUGIN = join(REPO, 'skills');
const DIST_BIN = join(REPO, 'packages', 'cli', 'dist', 'bin.js');
const SOURCE_ARGS = ['--conditions=source', '--import', 'tsx', join(REPO, 'packages', 'cli', 'src', 'bin.ts')];
const SKILLS = ['retake-component', 'retake-scenario', 'retake-theme'];

const json = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;

let ws: string;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-plugin-'));
  await fixtureWorkspace(ws);
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('the Claude Code plugin in skills/ and its local marketplace', () => {
  it('marketplace.json at the repository root lists one plugin, retake, from ./skills', () => {
    const m = json(join(REPO, '.claude-plugin', 'marketplace.json'));
    expect(m.name).toBe('retake');
    expect(m.plugins).toEqual([expect.objectContaining({ name: 'retake', source: './skills' })]);
    expect(Object.keys((m.plugins as object[])[0]).sort()).toEqual(['description', 'name', 'source']);
  });

  it("plugin.json: the tool's version, skills from the plugin root, userConfig node / cli / workspace (required) and home (optional)", () => {
    const p = json(join(PLUGIN, '.claude-plugin', 'plugin.json'));
    expect(p.name).toBe('retake');
    expect(p.version).toBe(RETAKE_VERSION);
    expect(p.skills).toBe('./');
    const uc = p.userConfig as Record<string, { type: string; required?: boolean; default?: string; sensitive?: boolean }>;
    expect(Object.keys(uc)).toEqual(['node', 'cli', 'workspace', 'home']);
    expect(Object.fromEntries(Object.entries(uc).map(([k, v]) => [k, [v.type, v.required ?? false]]))).toEqual({
      node: ['file', true],
      cli: ['file', true],
      workspace: ['directory', true],
      home: ['directory', false],
    });
    expect(uc.home.default).toBe('');
    expect(Object.values(uc).some((v) => v.sensitive)).toBe(false); // nothing secret goes through the plugin
  });

  it('.mcp.json starts `retake mcp` on the workspace from the userConfig values, RETAKE_HOME from home, nothing else', () => {
    const m = json(join(PLUGIN, '.mcp.json')) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(Object.keys(m)).toEqual(['mcpServers']);
    expect(m.mcpServers).toEqual({
      'retake': {
        command: '${user_config.node}',
        args: ['${user_config.cli}', '--root', '${user_config.workspace}', 'mcp'],
        env: { RETAKE_HOME: '${user_config.home}' },
      },
    });
  });

  it('the plugin root holds the three skill folders, each with a SKILL.md named after it', () => {
    const dirs = readdirSync(PLUGIN).filter((d) => !d.startsWith('.') && statSync(join(PLUGIN, d)).isDirectory()).sort();
    expect(dirs).toEqual(SKILLS);
    for (const d of dirs) expect(readFileSync(join(PLUGIN, d, 'SKILL.md'), 'utf8')).toMatch(new RegExp(`^---\\nname: ${d}\\n`));
  });
});

describe('retake mcp: the plugin registration and the serving PATH', () => {
  it('--print-config: either `claude mcp add` or the plugin lines (marketplace add, install --scope local from the workspace)', async () => {
    const io = memoryIo();
    expect(await main(['node', 'retake', '--root', ws, 'mcp', '--print-config'], io)).toBe(EXIT.ok);
    const err = io.stderr();
    const node = (JSON.parse(io.stdout()) as { mcpServers: Record<string, { command: string }> }).mcpServers['retake'].command;
    expect(err).toMatch(/Either .*\n {2}claude mcp add retake --scope user /);
    expect(err).toContain('not both');
    expect(err).toContain(`\n  claude plugin marketplace add ${REPO}\n`);
    const home = process.env.RETAKE_HOME?.trim() ? ` --config home=${resolve(process.env.RETAKE_HOME.trim())}` : '';
    expect(err).toContain(`\n  cd ${ws} && claude plugin install ${PLUGIN_ID} --scope local --config node=${node} --config cli=${DIST_BIN} --config workspace=${ws}${home}\n`);
    expect(err).toContain('--plugin-dir');
  });

  it('the plugin lines: shell-quoted values, home only when RETAKE_HOME is set (absolute), the marketplace found above the entry point', () => {
    const o = { root: "/w/my ws/it's", bin: '/r/packages/cli/dist/bin.js', node: '/n/22/bin/node', repo: '/r/a b' };
    expect(pluginInstallCommands({ ...o, env: {} })).toEqual([
      "claude plugin marketplace add '/r/a b'",
      `cd '/w/my ws/it'\\''s' && claude plugin install retake@retake --scope local --config node=/n/22/bin/node --config cli=/r/packages/cli/dist/bin.js --config 'workspace=/w/my ws/it'\\''s'`,
    ]);
    expect(pluginInstallCommands({ ...o, env: { RETAKE_HOME: '  ' } })[1]).not.toContain('home=');
    expect(pluginInstallCommands({ ...o, env: { RETAKE_HOME: '~/scratch home' } })[1]).toMatch(new RegExp(` --config 'home=${homedir()}/scratch home'$`));
    expect(pluginMarketplaceRoot(DIST_BIN)).toBe(REPO);
    expect(pluginMarketplaceRoot(join(ws, 'packages', 'cli', 'dist', 'bin.js'))).toBeUndefined(); // no marketplace above it
  });

  it('clientPath keeps absolute entries only: a relative `.` or `bin` would resolve in the client project folder', () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(clientPath('/n/bin/node', `bin${delimiter}.${delimiter}/usr/bin${delimiter}..${delimiter}x/y${delimiter}/bin`, has(['/opt/homebrew/bin']))).toBe(
      ['/n/bin', '/usr/bin', '/bin', '/opt/homebrew/bin'].join(delimiter),
    );
  });

  it('clientPath drops the entries inside the workspace (the agent writes files there), under any spelling of it (review M4)', async () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    const current = ['/w/ws/bin', '/w/ws', '/w/ws-other/bin', '/w/ws/node_modules/.bin', '/usr/bin'].join(delimiter);
    expect(clientPath('/n/bin/node', current, has([]), '/w/ws')).toBe(['/n/bin', '/w/ws-other/bin', '/usr/bin'].join(delimiter));
    expect(clientPath('/n/bin/node', current, has([]), '/w/ws/')).toBe(['/n/bin', '/w/ws-other/bin', '/usr/bin'].join(delimiter));
    expect(clientPath('/n/bin/node', current, has([]))).toContain('/w/ws/bin'); // no workspace given: kept
    // a workspace reached through a symbolic link (macOS: /tmp → /private/tmp): its real path's entries go too
    const link = join(ws, 'link-to-ws');
    await symlink(ws, link);
    const real = realpathSync(ws);
    expect(clientPath('/n/bin/node', [join(real, 'bin'), join(link, 'tools'), '/usr/bin'].join(delimiter), has([]), link)).toBe(['/n/bin', '/usr/bin'].join(delimiter));
    // the printed registration too
    const entry = mcpServerEntry({ root: ws, bin: DIST_BIN, node: '/n/bin/node', env: { PATH: [join(ws, 'bin'), '/usr/bin'].join(delimiter) } });
    expect(entry.env.PATH.split(delimiter)).not.toContain(join(ws, 'bin'));
  });

  it('the `claude mcp add` route prints an absolute RETAKE_HOME, like the plugin route (review L7)', () => {
    const o = { root: '/w/ws', bin: '/r/packages/cli/dist/bin.js', node: '/n/22/bin/node' };
    for (const v of ['rel/home', '~/scratch-home']) {
      const abs = v.startsWith('~') ? join(homedir(), v.slice(2)) : resolve(v);
      expect(mcpServerEntry({ ...o, env: { RETAKE_HOME: v } }).env.RETAKE_HOME).toBe(abs);
      expect(claudeCodeCommand({ ...o, env: { RETAKE_HOME: v } })).toContain(` -e RETAKE_HOME=${abs} `);
      expect(pluginInstallCommands({ ...o, repo: '/r', env: { RETAKE_HOME: v } })[1]).toContain(` --config home=${abs}`);
    }
    expect(mcpServerEntry({ ...o, env: { RETAKE_HOME: ' ' } }).env).not.toHaveProperty('RETAKE_HOME');
  });

  it('`retake mcp` serves with that PATH: the node folder first, relative and workspace entries dropped, system folders present', async () => {
    const out = join(ws, 'served-path.txt');
    const probe = `data:text/javascript,import{writeFileSync}from'node:fs';process.on('exit',()=>writeFileSync(${JSON.stringify(out)},process.env.PATH??''))`;
    const given = ['bin', '.', join(ws, 'bin'), '/usr/bin', '/bin'].join(delimiter);
    const child = spawn(process.execPath, ['--import', probe, ...SOURCE_ARGS, '--root', ws, 'mcp'], {
      cwd: REPO, // where `--import tsx` resolves
      env: testChildEnv({ PATH: given, RETAKE_HOME: join(ws, '.home') }),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    child.stdin.end(); // no client: the server ends with its input
    expect(await exited, stderr).toBe(0);
    const served = (await readFile(out, 'utf8')).split(delimiter);
    expect(served[0]).toBe(dirname(process.execPath));
    expect(served.every((p) => isAbsolute(p))).toBe(true);
    expect(served).toContain('/usr/bin');
    expect(served).not.toContain('bin');
    expect(served).not.toContain(join(ws, 'bin'));
  });
});

/** `claude` on the PATH (the CLI the user runs), or undefined. */
function claudeBin(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, 'claude');
    if (dir && isAbsolute(dir) && existsSync(p)) return p;
  }
  return undefined;
}

const CLAUDE = claudeBin();
const GATED = (process.env.RETAKE_TEST_CLAUDE === '1' || process.env.RETAKE_TEST_SLOW === '1') && !!CLAUDE;

describe.skipIf(!GATED)('the plugin in Claude Code (RETAKE_TEST_CLAUDE=1 or RETAKE_TEST_SLOW=1, `claude` on the PATH)', () => {
  let scratch: string;
  let env: NodeJS.ProcessEnv;
  let home: string;
  let inherited: string;
  let wrapper: string;
  let seen: string;
  const claude = (args: string[]) => {
    const r = spawnSync(CLAUDE!, args, { cwd: ws, env, encoding: 'utf8', timeout: 90_000 });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  beforeAll(async () => {
    expect(existsSync(DIST_BIN), 'pnpm build first').toBe(true);
    scratch = await mkdtemp(join(tmpdir(), 'studio-claude-'));
    home = join(scratch, 'retake-home');
    inherited = join(scratch, 'inherited-home');
    wrapper = join(scratch, 'node-wrapper.sh');
    seen = join(scratch, 'server-saw.txt');
    const config = join(scratch, 'claude');
    await mkdir(config);
    await mkdir(home);
    await mkdir(inherited);
    // The node value is a wrapper that writes down the server's RETAKE_HOME and working directory, then runs node.
    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n%s\\n' "$RETAKE_HOME" "$(pwd -P)" > ${q(seen)}\nexec ${q(process.execPath)} "$@"\n`, { mode: 0o755 });
    // `--plugin-dir` loads the plugin as retake@inline: its userConfig values are read under that id.
    const options = { node: wrapper, cli: DIST_BIN, workspace: ws, home };
    await writeFile(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'retake@inline': { options } } }, null, 2));
    env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: config,
      RETAKE_HOME: inherited, // another folder: the server must get `home` from .mcp.json, not this one
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    };
  });

  afterAll(async () => {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('claude plugin validate passes for the plugin and for the marketplace', () => {
    for (const dir of [PLUGIN, REPO]) {
      const r = claude(['plugin', 'validate', dir]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('Validation passed');
    }
  });

  it('plugin details lists the three skills and the retake MCP server', () => {
    const r = claude(['--plugin-dir', PLUGIN, 'plugin', 'details', 'retake']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(new RegExp(`Skills \\(3\\)\\s+${SKILLS.join(', ')}`));
    expect(r.out).toMatch(/MCP servers \(1\)\s+retake\b/);
  });

  it('mcp list: the plugin server, started from the userConfig values (RETAKE_HOME from home, not inherited), is connected', async () => {
    const r = claude(['--plugin-dir', PLUGIN, 'mcp', 'list']);
    expect(r.code, r.out).toBe(0);
    const line = r.out.split('\n').find((l) => l.startsWith('plugin:retake:retake:'));
    expect(line, r.out).toBeDefined();
    expect(line).toContain(`${wrapper} ${DIST_BIN} --root ${ws} mcp`);
    expect(line).toContain('✔ Connected');
    // what the server process got: the `home` value (not the inherited RETAKE_HOME), and the session folder as its
    // working directory (what the skills compare with engine_info's root)
    const [gotHome, gotCwd] = (await readFile(seen, 'utf8')).split('\n');
    expect(gotHome).toBe(home);
    expect(gotCwd).toBe(realpathSync(ws));
  });
});
