/**
 * The shared rules for work an agent can shape (core agent-policy.ts): the loader variables, the NODE_OPTIONS flags
 * that load a file and the path lists node or the dynamic linker loads code from; the Chromium switches no browser.args
 * may hold.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_OPEN_SWITCHES,
  LINUX_ONLY_SANDBOX_SWITCHES,
  LOAD_PATH_ENV,
  NODE_OPTIONS_LOADS,
  SANDBOX_OFF_SWITCHES,
  isLoaderEnvName,
  loadPathSeparator,
  loadWorkspaceConfig,
  parseProjectYaml,
  sandboxOffArgProblem,
  sandboxSwitchOff,
} from '@retake/core';

describe('loader variables', () => {
  it('names every variable that makes a program load code or change its shell or configuration folders', () => {
    const loaders = [
      'NODE_OPTIONS',
      'NODE_PATH',
      'PATH',
      'HOME',
      'ZDOTDIR',
      'XDG_CONFIG_HOME',
      'BASH_ENV',
      'ENV',
      'SHELLOPTS',
      'BASHOPTS',
      'PS4',
      'PROMPT_COMMAND',
      'IFS',
      'CDPATH',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'LD_AUDIT',
      'GIT_DIR',
      'GIT_SSH_COMMAND',
      'GIT_CONFIG_GLOBAL',
      'PYTHONPATH',
      'PYTHONSTARTUP',
      'PERL5LIB',
      'PERL5OPT',
      'RUBYOPT',
      'RUBYLIB',
      'JAVA_TOOL_OPTIONS',
      '_JAVA_OPTIONS',
      'JDK_JAVA_OPTIONS',
      'npm_config_registry',
      'NPM_CONFIG_USERCONFIG',
      'PNPM_HOME',
      'pnpm_config_store_dir',
      'YARN_RC_FILENAME',
      'COREPACK_HOME',
      'BASH_FUNC_ls%%',
      'PERLLIB',
      'PERL5DB',
      'GEM_HOME',
      'BUNDLE_GEMFILE',
      'LUA_INIT',
      'LUA_INIT_5_4',
      'LUA_PATH',
      'PHPRC',
      'PHP_INI_SCAN_DIR',
      'CLASSPATH',
      'R_PROFILE_USER',
      'TCLLIBPATH',
      'GOFLAGS',
      'PSQLRC',
      'CURL_HOME',
      'WGETRC',
      'EDITOR',
      'PAGER',
    ];
    for (const name of loaders) expect(isLoaderEnvName(name), name).toBe(true);
  });

  it('leaves the variables a hook passes to its command', () => {
    for (const name of ['SKU', 'API_BASE', 'DATABASE_URL', 'LANG', 'TZ', 'NODE_ENV', 'PATHNAME', 'MY_PATH', 'HOMEPAGE', 'ENVIRONMENT', 'GITHUB_REF_NAME_X', 'JAVA_HOME', 'NPM_TOKEN_NAME', 'R_HOME', 'LUA_VERSION', 'EDITOR_THEME', 'GEMS']) {
      expect(isLoaderEnvName(name), name).toBe(false);
    }
  });

  it('NODE_OPTIONS flags that load a file, and the path lists code is loaded from', () => {
    for (const v of ['--require ./x.cjs', '-r x', '--import=./x.mjs', '--loader ./l.mjs', '--max-old-space-size=4096 --env-file=.env']) expect(NODE_OPTIONS_LOADS.test(v), v).toBe(true);
    for (const v of ['--max-old-space-size=4096', '--enable-source-maps', '--no-warnings']) expect(NODE_OPTIONS_LOADS.test(v), v).toBe(false);
    for (const k of ['NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT']) expect(LOAD_PATH_ENV.test(k), k).toBe(true);
    expect(LOAD_PATH_ENV.test('LD_BIND_NOW')).toBe(false);
    expect('/a/x.so /b/y.so:/c/z.so'.split(loadPathSeparator('LD_PRELOAD', ':'))).toEqual(['/a/x.so', '/b/y.so', '/c/z.so']);
    expect('/a b:/c'.split(loadPathSeparator('NODE_PATH', ':'))).toEqual(['/a b', '/c']);
    expect('C:\\a;D:\\b'.split(loadPathSeparator('NODE_PATH', ';'))).toEqual(['C:\\a', 'D:\\b']);
  });
});

describe('Chromium switches that turn the sandbox or site isolation off', () => {
  it('refuses each one, however it is spelled, and only those', () => {
    for (const name of SANDBOX_OFF_SWITCHES) {
      for (const arg of [`--${name}`, `-${name}`, `--${name}=1`, `--${name.toUpperCase()}`, ` --${name}`]) {
        expect(sandboxOffArgProblem(arg), arg).toMatch(new RegExp(`^--${name} turns Chromium's (?:sandbox|site isolation) off — .*remove it from browser\\.args`));
      }
    }
    expect(SANDBOX_OFF_SWITCHES).toEqual(expect.arrayContaining(['no-sandbox', 'disable-setuid-sandbox', 'disable-gpu-sandbox', 'no-zygote', 'single-process', 'disable-site-isolation-trials']));
    for (const arg of ['--disable-features=IsolateOrigins', '--disable-features=Translate,site-per-process', '--disable-features=SitePerProcess<Study', '--disable-features=MediaRouter, isolate_origins:x/1']) {
      expect(sandboxOffArgProblem(arg), arg).toMatch(/^--disable-features=\S+ turns Chromium's site isolation off/);
    }
    for (const arg of ['--hide-scrollbars', '--disable-features=Translate,MediaRouter', '--enable-features=SitePerProcess', '--sandbox', '--no-sandbox-x', 'no-sandbox', '--lang=fr', '--window-size=1280,800']) {
      expect(sandboxOffArgProblem(arg), arg).toBeNull();
    }
  });

  it('the switches that open the browser to other code are refused too, each with what it does; the narrower reading keeps the sandbox ones only', () => {
    const open = ['disable-web-security', 'renderer-cmd-prefix', 'gpu-launcher', 'utility-cmd-prefix', 'browser-subprocess-path', 'remote-debugging-port', 'remote-debugging-address'];
    expect(Object.keys(BROWSER_OPEN_SWITCHES).sort()).toEqual([...open].sort());
    for (const name of open) {
      for (const arg of [`--${name}`, `-${name}=/tmp/x`, ` --${name.toUpperCase()}=9222`]) {
        expect(sandboxOffArgProblem(arg), arg).toMatch(new RegExp(`^--${name} (?:turns Chromium's same-origin policy off|starts Chromium's .* (?:through|from) another program|opens a debugging port) .*remove it from browser\\.args`));
        expect(sandboxSwitchOff(arg), arg).toBeNull();
      }
    }
    expect(sandboxOffArgProblem('--remote-debugging-pipe')).toBeNull();
    expect(sandboxSwitchOff('--no-sandbox')).toMatch(/turns Chromium's sandbox off/);
    // Linux's own sandbox switches have no effect on macOS (Remotion passes --no-zygote): only there are they not read as off.
    for (const name of LINUX_ONLY_SANDBOX_SWITCHES) {
      expect(sandboxSwitchOff(`--${name}`, { platform: 'darwin' }), name).toBeNull();
      expect(sandboxSwitchOff(`--${name}`, { platform: 'linux' }), name).toMatch(/turns Chromium's sandbox off/);
      expect(sandboxOffArgProblem(`--${name}`), name).toMatch(/turns Chromium's sandbox off/);
    }
    for (const arg of ['--no-sandbox', '--disable-gpu-sandbox', '--single-process', '--disable-site-isolation-trials']) expect(sandboxSwitchOff(arg, { platform: 'darwin' }), arg).not.toBeNull();
    expect(sandboxSwitchOff('--disable-features=IsolateOrigins')).toMatch(/turns Chromium's site isolation off/);
  });

  it('project.yaml and retake.yaml refuse them in browser.args, at their line', async () => {
    const { config, issues } = parseProjectYaml(['name: Demo', 'environments: {local: {app: "http://localhost:3000"}}', 'browser:', '  args: [--lang=fr, --no-sandbox, "--disable-features=IsolateOrigins", --remote-debugging-port=9222]', ''].join('\n'));
    expect(config).toBeUndefined();
    expect(issues.filter((i) => i.severity === 'error').map((i) => `${i.path.join('.')}@${i.line}: ${i.message}`)).toEqual([
      expect.stringMatching(/^browser\.args\.1@4: --no-sandbox turns Chromium's sandbox off/),
      expect.stringMatching(/^browser\.args\.2@4: --disable-features=IsolateOrigins turns Chromium's site isolation off/),
      expect.stringMatching(/^browser\.args\.3@4: --remote-debugging-port opens a debugging port/),
    ]);
    expect(parseProjectYaml(['name: Demo', 'environments: {local: {app: "http://localhost:3000"}}', 'browser: {args: [--lang=fr]}', ''].join('\n')).config?.browser?.args).toEqual(['--lang=fr']);
    const dir = await mkdtemp(join(tmpdir(), 'retake-core-args-'));
    try {
      await writeFile(join(dir, 'retake.yaml'), 'browser:\n  args:\n    - --disable-gpu-sandbox\n');
      await expect(loadWorkspaceConfig(dir)).rejects.toThrow(/retake\.yaml:3:7 error browser\.args\[0\]: --disable-gpu-sandbox turns Chromium's sandbox off/);
      await writeFile(join(dir, 'retake.yaml'), 'browser:\n  args: [--hide-scrollbars]\n');
      expect((await loadWorkspaceConfig(dir)).browser).toEqual({ args: ['--hide-scrollbars'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
