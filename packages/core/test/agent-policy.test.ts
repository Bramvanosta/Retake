/**
 * The shared rules for work an agent can shape (core agent-policy.ts): the loader variables, the NODE_OPTIONS flags
 * that load a file and the path lists node or the dynamic linker loads code from.
 */
import { describe, expect, it } from 'vitest';
import { LOAD_PATH_ENV, NODE_OPTIONS_LOADS, isLoaderEnvName, loadPathSeparator } from '@retake/core';

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
    ];
    for (const name of loaders) expect(isLoaderEnvName(name), name).toBe(true);
  });

  it('leaves the variables a hook passes to its command', () => {
    for (const name of ['SKU', 'API_BASE', 'DATABASE_URL', 'LANG', 'TZ', 'NODE_ENV', 'PATHNAME', 'MY_PATH', 'HOMEPAGE', 'ENVIRONMENT', 'GITHUB_REF_NAME_X', 'JAVA_HOME', 'NPM_TOKEN_NAME']) {
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
