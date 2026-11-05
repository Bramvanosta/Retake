/**
 * The shared rules for work an agent can shape (core agent-policy.ts): the loader variables, the NODE_OPTIONS flags
 * that load a file and the path lists node or the dynamic linker loads code from.
 */
import { describe, expect, it } from 'vitest';
import { LOAD_PATH_ENV, NODE_OPTIONS_LOADS, agentShellLoaderVariables, isLoaderEnvName, loadPathSeparator, loaderAssignments, simpleCommands } from '@retake/core';

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

describe('simple commands', () => {
  it('splits on ; & && | || ( ) and newlines, and at every command substitution, inside double quotes too', () => {
    expect(simpleCommands('a 1; b 2 && c || d | e & f\ng (h) `i` $(j)')).toEqual([['a', '1'], ['b', '2'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h'], ['i'], ['$'], ['j']]);
    expect(simpleCommands('echo "x $(K=1 run "a b") y `L=2 go`"')).toEqual([['echo', 'x '], ['K=1', 'run', 'a b'], [' y '], ['L=2', 'go'], ['']]);
    // Nested parentheses inside a quoted substitution stay in it.
    expect(simpleCommands('echo "$(a $(b) c)" d')).toEqual([['echo', ''], ['a', '$'], ['b'], ['c'], ['', 'd']]);
  });

  it("resolves quotes, backslashes and $'…' strings; redirections are words of their own", () => {
    expect(simpleCommands(String.raw`env 'A=1' "B=2" C\=3 $'D\x3d4' $'\101'=5 x>out 2>&1 <in`)).toEqual([['env', 'A=1', 'B=2', 'C=3', 'D=4', 'A=5', 'x', '>', 'out', '2', '>&', '1', '<', 'in']]);
    expect(simpleCommands(String.raw`echo 'a; b' \; c`)).toEqual([['echo', 'a; b', ';', 'c']]);
  });
});

describe('loader variables a shell command sets', () => {
  it('a NAME= word in any simple command, at any position, however quoted', () => {
    const cases: Array<[string, string[]]> = [
      ['PATH=/tmp/x node -v', ['PATH']],
      ['echo ok; LD_PRELOAD=/tmp/x.so ls', ['LD_PRELOAD']],
      ['echo ok\nLD_PRELOAD=/tmp/x.so ls', ['LD_PRELOAD']],
      ['true && env NODE_OPTIONS=--require=./x.cjs node app.js', ['NODE_OPTIONS']],
      ['false || GIT_SSH_COMMAND=/tmp/s git fetch', ['GIT_SSH_COMMAND']],
      ['echo a | (GIT_DIR=/tmp/g git status)', ['GIT_DIR']],
      ['echo "$(PYTHONPATH=/tmp python3 -V)"', ['PYTHONPATH']],
      ['echo `BASH_ENV=/tmp/rc bash x`', ['BASH_ENV']],
      ['FOO=1 HOME=/tmp/h npm run seed', ['HOME']],
      ["env 'DYLD_INSERT_LIBRARIES=/tmp/x.dylib' ls", ['DYLD_INSERT_LIBRARIES']],
      [String.raw`env $'NODE_\x4fPTIONS=-r x' node`, ['NODE_OPTIONS']],
      ['export PATH=/tmp/bin:$PATH; seed', ['PATH']],
      ['PATH+=:/tmp/bin seed', ['PATH']],
      ['PATH[0]=/tmp/bin seed', ['PATH']],
      ['npm_config_registry=http://127.0.0.1:9 npm i', ['npm_config_registry']],
      ['for PATH in /tmp/bin; do seed; done', ['PATH']],
      ['echo /tmp | read IFS', ['IFS']],
      ['printf -v PROMPT_COMMAND %s x', ['PROMPT_COMMAND']],
      ['declare -x ZDOTDIR=/tmp/z; export CDPATH', ['ZDOTDIR', 'CDPATH']],
    ];
    for (const [cmd, names] of cases) expect(loaderAssignments(cmd), cmd).toEqual(names);
  });

  it('leaves commands that set none: other variables, a loader name as a plain argument', () => {
    for (const cmd of ['SKU=abc pnpm seed', 'echo PATH', 'echo $PATH', 'env LANG=C sort x', 'grep -r HOME .', 'curl -s http://127.0.0.1:9/?PATH=x', 'echo "see PATH=x"']) {
      expect(loaderAssignments(cmd), cmd).toEqual([]);
    }
  });

  it("an agent-written command's loader variables: its env's, then its text's, each once", () => {
    expect(agentShellLoaderVariables('PATH=/x a; NODE_OPTIONS= b', { NODE_OPTIONS: '-r x', SKU: 'a', PATH: '/y' })).toEqual(['NODE_OPTIONS', 'PATH']);
    expect(agentShellLoaderVariables('pnpm seed', { SKU: 'a', MODE: 'demo' })).toEqual([]);
  });
});
