/**
 * The integrations entry (@retake/engine/integrations): the agent registrations as bytes. The MCP registration a
 * client gets (the JSON block, the `claude mcp add` lines, the plugin route's argv), the Claude Desktop config as merged
 * (the exact text written: key order, two-space JSON, a final line break), its backup (the old bytes, the name) and the
 * command's link (its target as written). Scratch folders only.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APP_BUNDLE_ID,
  claudeCodeCommand,
  claudeCodeHttpCommand,
  cliLinkState,
  installCliLink,
  mcpConfigJson,
  mcpHttpConfigJson,
  mcpHttpTokenExport,
  planDesktopEntry,
  pluginInstallCommands,
  pluginInstallSteps,
  removeCliLink,
  stableNodePath,
  writeDesktopEntry,
} from '@retake/engine/integrations';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'integrations-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const scratch = (name: string) => {
  const d = join(base, `${name}-${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// A checkout's registration: no app bundle, so no module lookup guard before the entry point (nodeArgs: []).
const input = { root: '/ws/demo', bin: '/repo/packages/cli/dist/bin.js', node: '/n/22/bin/node', nodeArgs: [], env: { PATH: '/opt/homebrew/bin:relative:/usr/bin', RETAKE_HOME: '/h/retake home' } };

describe('the MCP registration (the config snippet)', () => {
  // clientPath adds this machine's system folders that exist after the given ones.
  const PATH = mcpConfigJson(input).mcpServers.retake!.env.PATH!;
  it("the mcpServers block: node, the entry point, --root, mcp; PATH with absolute entries only after node's folder; RETAKE_HOME absolute", () => {
    expect(PATH.startsWith('/n/22/bin:/opt/homebrew/bin:/usr/bin')).toBe(true);
    expect(PATH.split(':').every((e) => e.startsWith('/'))).toBe(true);
    expect(JSON.stringify(mcpConfigJson(input))).toBe(
      `{"mcpServers":{"retake":{"command":"/n/22/bin/node","args":["/repo/packages/cli/dist/bin.js","--root","/ws/demo","mcp"],"env":{"PATH":"${PATH}","RETAKE_HOME":"/h/retake home"}}}}`,
    );
    expect(Object.keys(mcpConfigJson({ ...input, env: { PATH: '' } }).mcpServers.retake!.env)).toEqual(['PATH']);
  });

  it('the `claude mcp add` line, the plugin route (argv and its two lines), the HTTP block and its token lines', () => {
    expect(claudeCodeCommand(input)).toBe(`claude mcp add retake --scope user -e PATH=${PATH} -e 'RETAKE_HOME=/h/retake home' -- /n/22/bin/node /repo/packages/cli/dist/bin.js --root /ws/demo mcp`);
    expect(pluginInstallSteps({ ...input, repo: '/repo' })).toEqual([
      { argv: ['plugin', 'marketplace', 'add', '/repo'] },
      {
        argv: [
          'plugin',
          'install',
          'retake@retake',
          '--scope',
          'local',
          '--config',
          'node=/n/22/bin/node',
          '--config',
          'cli=/repo/packages/cli/dist/bin.js',
          '--config',
          'workspace=/ws/demo',
          '--config',
          'home=/h/retake home',
        ],
        cwd: '/ws/demo',
      },
    ]);
    expect(pluginInstallCommands({ ...input, repo: '/repo' })).toEqual([
      'claude plugin marketplace add /repo',
      "cd /ws/demo && claude plugin install retake@retake --scope local --config node=/n/22/bin/node --config cli=/repo/packages/cli/dist/bin.js --config workspace=/ws/demo --config 'home=/h/retake home'",
    ]);
    expect(JSON.stringify(mcpHttpConfigJson({ url: 'http://127.0.0.1:47820/mcp' }))).toBe(
      '{"mcpServers":{"retake":{"type":"http","url":"http://127.0.0.1:47820/mcp","headers":{"Authorization":"Bearer ${RETAKE_MCP_TOKEN}"}}}}',
    );
    expect(claudeCodeHttpCommand({ url: 'http://127.0.0.1:47820/mcp', tokenFile: '/h/mcp token' })).toBe(
      `claude mcp add --transport http retake http://127.0.0.1:47820/mcp --scope user --header "Authorization: Bearer $(cat '/h/mcp token')"`,
    );
    expect(mcpHttpTokenExport('/h/mcp-token')).toBe('export RETAKE_MCP_TOKEN="$(cat /h/mcp-token)"');
  });

  it("a stable Node.js path: the major's alias (mise, nvm, Homebrew) when it exists, else the path as given", () => {
    const has =
      (...p: string[]) =>
      (x: string) =>
        p.includes(x);
    expect(stableNodePath('/m/installs/node/22.16.0/bin/node', has('/m/installs/node/22/bin/node'))).toBe('/m/installs/node/22/bin/node');
    expect(stableNodePath('/v/node/v22.16.0/bin/node', has('/v/node/22/bin/node'))).toBe('/v/node/22/bin/node');
    expect(stableNodePath('/b/Cellar/node@22/22.16.0/bin/node', has('/b/opt/node@22/bin/node'))).toBe('/b/opt/node@22/bin/node');
    expect(stableNodePath('/m/installs/node/22.16.0/bin/node', has())).toBe('/m/installs/node/22.16.0/bin/node');
  });
});

describe('Claude Desktop: the merged config as bytes', () => {
  const ENTRY = mcpConfigJson(input).mcpServers.retake! as unknown as Record<string, unknown>;

  it('created, then merged beside every other key in its place, two-space JSON with a final line break', () => {
    expect(planDesktopEntry(null, ENTRY).text).toBe(`${JSON.stringify({ mcpServers: { retake: ENTRY } }, null, 2)}\n`);
    const text = '{"z":1,"mcpServers":{"files":{"command":"x"}},"a":[1,2]}';
    expect(planDesktopEntry(text, ENTRY).text).toBe(
      `{\n  "z": 1,\n  "mcpServers": {\n    "files": {\n      "command": "x"\n    },\n    "retake": ${JSON.stringify(ENTRY, null, 2).replace(/\n/g, '\n    ')}\n  },\n  "a": [\n    1,\n    2\n  ]\n}\n`,
    );
    // A replaced entry keeps its place among the servers.
    const replaced = planDesktopEntry('{"mcpServers":{"retake":{"command":"old"},"files":{}}}', ENTRY);
    expect(replaced.kind).toBe('replace');
    expect(Object.keys(JSON.parse(replaced.text).mcpServers)).toEqual(['retake', 'files']);
  });

  it('written: the file holds the planned text, the backup the old bytes under a stamped name, mode 0600 in a 0700 folder', () => {
    const dir = scratch('claude');
    const file = join(dir, 'claude_desktop_config.json');
    const old = '{ "theme": "dark",\n  "mcpServers": {} }\n';
    writeFileSync(file, old);
    chmodSync(file, 0o640);
    const backupDir = join(scratch('home'), 'backups', 'claude-desktop');
    const r = writeDesktopEntry(file, ENTRY, { backupDir, now: new Date('2026-11-09T08:30:15.250Z') });
    expect(r).toEqual({ kind: 'add', file, backup: join(backupDir, 'claude_desktop_config.json.retake-backup-2026-11-09T08-30-15-250Z') });
    expect(readFileSync(file, 'utf8')).toBe(planDesktopEntry(old, ENTRY).text);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readFileSync(r.backup!, 'utf8')).toBe(old);
    expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir)).toEqual(['claude_desktop_config.json']);
  });
});

describe("the command's link", () => {
  it('a link to the launcher as given (absolute, not resolved), replaced atomically for another copy of the app', () => {
    const apps = scratch('apps');
    const launcherOf = (name: string) => {
      const res = join(apps, `${name}.app`, 'Contents', 'Resources');
      mkdirSync(join(res, 'bin'), { recursive: true });
      writeFileSync(join(res, 'bin', 'retake'), '#!/bin/sh\n');
      chmodSync(join(res, 'bin', 'retake'), 0o755);
      writeFileSync(join(apps, `${name}.app`, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleIdentifier</key>\n<string>${APP_BUNDLE_ID}</string></dict></plist>`);
      return join(res, 'bin', 'retake');
    };
    const one = launcherOf('Retake');
    const two = launcherOf('Retake 2');
    const dir = join(scratch('home'), '.local', 'bin');
    expect(installCliLink(dir, one, { createDir: true })).toEqual({ path: join(dir, 'retake'), result: 'created' });
    expect(readlinkSync(join(dir, 'retake'))).toBe(one);
    expect(cliLinkState(join(dir, 'retake'), two)).toEqual({ state: 'other_app', target: one, dangling: false });
    expect(installCliLink(dir, two, { replace: true })).toEqual({ path: join(dir, 'retake'), result: 'replaced' });
    expect(readlinkSync(join(dir, 'retake'))).toBe(two);
    expect(lstatSync(join(dir, 'retake')).isSymbolicLink()).toBe(true);
    expect(readdirSync(dir)).toEqual(['retake']);
    expect(removeCliLink(join(dir, 'retake'), two)).toBe('removed');
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('one import path', () => {
  it("the registrations and the set-up come from @retake/engine/integrations only — not core, not the engine's main entry, not the MCP package", async () => {
    const names = ['mcpConfigJson', 'mcpServerEntry', 'stableNodePath', 'pluginInstallSteps', 'SERVER_NAME', 'writeDesktopEntry', 'installCliLink', 'SetupError', 'readAppSettings', 'UPDATES_FILE'];
    const integrations: Record<string, unknown> = await import('@retake/engine/integrations');
    for (const n of names) expect(integrations[n], n).toBeDefined();
    for (const entry of [await import('@retake/core'), await import('@retake/core/io'), await import('@retake/engine'), await import('@retake/mcp')] as Array<Record<string, unknown>>) {
      expect(names.filter((n) => n in entry)).toEqual([]);
    }
    // clientPath stays core's (its io side, @retake/core/io: one path — the MCP package no longer hands it on).
    expect('clientPath' in (await import('@retake/mcp'))).toBe(false);
  });
});
