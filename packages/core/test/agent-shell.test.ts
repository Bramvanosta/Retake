/**
 * What a shell hook the agent wrote may be (core agent-policy.ts agentShellProblems, trust `mcp`): plain words joined
 * by single spaces and ` && `, read in one pass — then a few rules per word (programs, loader variables, paths).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_SHELL_MAX_CHARS, agentShellCwdProblems, agentShellEnvProblems, agentShellProblems, agentWritablePath } from '@retake/core';
import { nodeFileFacts } from '@retake/core/io';

const ws = realpathSync(mkdtempSync(join(tmpdir(), 'retake-agent-shell-')));
const projectDir = join(ws, 'projects', 'p');
for (const d of ['runs/r1', 'scenarios', 'hooks', 'comments', 'scripts', 'review']) mkdirSync(join(projectDir, d), { recursive: true });
mkdirSync(join(ws, 'projects', 'other', 'scenarios'), { recursive: true });
writeFileSync(join(projectDir, 'runs/r1/x.sh'), 'echo agent\n');
writeFileSync(join(projectDir, 'hooks/seed.sh'), 'echo person\n');
symlinkSync(join(projectDir, 'runs'), join(projectDir, 'scripts', 'out'));
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const problems = (text: string, cwd?: string) => agentShellProblems(text, { files: nodeFileFacts, projectDir, ...(cwd ? { cwd } : {}) });

describe('agent-written shell commands: the grammar', () => {
  it('only the characters of plain words, single spaces and ` && `: anything else is named, once', () => {
    const REFUSED: Array<[string, string]> = [
      ['echo $HOME', '`$`'],
      ["echo 'a b'", "`'`"],
      ['echo "a"', '`"`'],
      ['echo `id`', '```'],
      ['echo a; cd x', '`;`'],
      ['echo a | sh', '`|`'],
      ['echo a > runs/x', '`>`'],
      ['cat < hooks/x', '`<`'],
      ['rm -f *.log', '`*`'],
      ['ls a?b', '`?`'],
      ['cat [ab].txt', '`[`'],
      ['sh ru{n,}s/x.sh', '`{`'],
      ['cat ~root/x', '`~`'],
      ['echo a # b', '`#`'],
      ['echo a\\b', '`\\`'],
      ['(id)', '`(`'],
      ['echo !x', '`!`'],
      ['echo a\nid', '`\\u{a}`'],
      ['true\r#; cd x', '`\\u{d}`'],
      ['echo\ta', '`\\u{9}`'],
      ['true\u00a0#; sh x', '`\\u{a0}`'],
      ['echo a\u200bb', '`\\u{200b}`'],
      ['echo café', '`\\u{e9}`'],
      ['curl http://127.0.0.1:9/api?x=1&y=2', '`?`'],
    ];
    for (const [cmd, shown] of REFUSED) {
      const p = problems(cmd);
      expect(p[0], `${JSON.stringify(cmd)} → ${JSON.stringify(p)}`).toMatch(/^the characters? /);
      expect(p[0], JSON.stringify(cmd)).toContain(shown);
      expect(p[0]).toContain('(only plain words: letters, digits and . / : = @ % + , - _)');
    }
    // Each character once, in the order found.
    expect(problems('a $b $c; d;')).toEqual(['the characters `$`, `;` (only plain words: letters, digits and . / : = @ % + , - _)']);
  });

  it('one space between two words, `&&` alone between two commands', () => {
    expect(problems('a  b')).toEqual(['two spaces in a row, or a space at its start or end (one space between two words)']);
    expect(problems(' a')).toEqual(['two spaces in a row, or a space at its start or end (one space between two words)']);
    expect(problems('a ')).toEqual(['two spaces in a row, or a space at its start or end (one space between two words)']);
    for (const cmd of ['a & b', 'a&&b', 'a &&b', 'a &', 'a &> x']) expect(problems(cmd), cmd).toContain('`&` other than ` && ` between two commands (`&`, `&>`, `a&&b`)');
    for (const cmd of ['a &&', '&& a', 'a && && b']) expect(problems(cmd), cmd).toEqual(['` && ` without a command on each side']);
    expect(problems('')).toEqual(['no command']);
  });

  it('its length first: a longer text is refused without being read (linear, whatever it holds)', () => {
    const long = `echo ${'['.repeat(AGENT_SHELL_MAX_CHARS)}`;
    const t0 = Date.now();
    expect(problems(long)).toEqual([`${long.length.toLocaleString('en-US')} characters (at most 4,000)`]);
    // At the limit, a text of special characters is read in one pass too.
    expect(problems('['.repeat(AGENT_SHELL_MAX_CHARS))[0]).toMatch(/^the character `\[`/);
    expect(problems(`a ${'b '.repeat(1_990)}c`)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('agent-written shell commands: the rules per word', () => {
  const REFUSED: Array<[string, RegExp, string[]]> = [
    ['cd and its kin', /^`(?:cd|pushd|popd)` \(it changes the folder its paths resolve from/, ['cd hooks && sh seed.sh', 'true && cd /tmp', 'pushd hooks', 'popd']],
    [
      'text or a file run as a command',
      /^`(?:eval|exec|command|builtin|trap|source|\.)` \(it (?:runs|replaces)/,
      ['eval x', 'exec node hooks/x.js', 'command node', 'builtin cd', 'trap id EXIT', 'source hooks/x.sh', '. hooks/x.sh'],
    ],
    ['names rebound', /^`(?:alias|unalias|hash|enable)` \(it (?:renames a command|changes which program a name runs)\)/, ['alias e=eval', 'unalias ls', 'hash -p /tmp/x ls', 'enable -n echo']],
    [
      'by its last path part, and after a wrapper',
      /^`(?:command|eval|cd|trap)` /,
      ['/usr/bin/command eval x', '/usr/bin/cd x', 'nice -n 1 cd x', 'time -p cd x', 'env A=1 eval x', 'nohup trap id EXIT', 'timeout 5 eval x'],
    ],
    [
      'after a prefix word of the shell (bash coproc, zsh noglob / nocorrect / -)',
      /^`(?:\.|source|eval|exec|cd)` /,
      ['coproc . x', 'coproc source x', 'noglob eval x', 'nocorrect exec x', '- cd x', 'coproc NAME eval x'],
    ],
    ['a shell given a script string', /`(?:sh|bash|zsh|dash) -[a-z]*c[a-z]*` \(it runs code/, ['sh -c id', 'bash -lc id', 'zsh -c x', 'nohup bash -c x', '/bin/sh -ec x']],
    [
      'inline interpreter code',
      /\(it runs code written in the command\)/,
      [
        'node -e x',
        'node -p 1',
        'node --eval x',
        'node --import=data:text/javascript,x hooks/app.js',
        'node -r ./x.cjs hooks/app.js',
        'timeout 5 node -e x',
        'bun -e x',
        'deno eval x',
        'python3 -c x',
        'python3.12 -Bc x',
        'perl -e x',
        'perl -ne x hooks/f',
        'ruby -e x',
        'php -r x',
        'osascript -e x',
      ],
    ],
    ['awk without -f', /`g?awk` with a program text/, ['awk 1 hooks/f', 'gawk BEGIN']],
    [
      'commands built or run for each input',
      /^`(?:xargs|parallel|find -exec|find -execdir|find -ok)`/,
      ['xargs rm', 'parallel x', 'find . -name x -exec rm +', 'find . -execdir ls +', 'find . -ok rm +'],
    ],
    ['env -S', /^`env -S`/, ['env -S x', '/usr/bin/env -iS x']],
    [
      'package runners, their subcommand wherever it stands',
      /\(it runs a package, downloading it when it is not installed\)/,
      [
        'npx cowsay',
        'pnpx x',
        'bunx x',
        'uvx x',
        'pnpm dlx cowsay',
        'pnpm --filter app dlx x',
        'pnpm -C .. dlx x',
        'yarn --cwd .. dlx x',
        'npm exec cowsay',
        'npm --yes exec cowsay',
        'npm --prefix .. exec x',
        'npm -w app x cowsay',
        'npm init x',
        'npm create x',
        'bun x cowsay',
        'pipx run x',
        'uv tool run x',
        'deno run npm:cowsay',
      ],
    ],
    ['git -c', /^`git -c`/, ['git -c core.pager=x log', 'git -C ../app -c alias.x=y x', 'git --config-env=core.pager=V log']],
    ['a stream read as a file', /\(a stream read as a file\)/, ['node /dev/stdin', 'sh /dev/fd/3']],
  ];
  for (const [what, re, commands] of REFUSED) {
    it(what, () => {
      for (const cmd of commands)
        expect(
          problems(cmd).some((p) => re.test(p)),
          `${cmd} → ${JSON.stringify(problems(cmd))}`,
        ).toBe(true);
    });
  }

  it('a loader variable it sets: before the program, as an env argument, a setter’s name — never a plain argument', () => {
    const SETS: Array<[string, string]> = [
      ['PATH=/tmp/x node -v', '`PATH=` (it sets PATH, a loader variable)'],
      ['echo ok && LD_PRELOAD=/tmp/x.so ls', '`LD_PRELOAD=` (it sets LD_PRELOAD, a loader variable)'],
      ['A=1 HOME=/tmp/h npm run seed', '`HOME=` (it sets HOME, a loader variable)'],
      ['env A=1 NODE_OPTIONS=--require=./x.cjs node app.js', '`NODE_OPTIONS=` (it sets NODE_OPTIONS, a loader variable)'],
      ['env -i GIT_SSH_COMMAND=/tmp/s git fetch', '`GIT_SSH_COMMAND=` (it sets GIT_SSH_COMMAND, a loader variable)'],
      ['export PATH=/tmp/bin && seed', '`PATH=` (it sets PATH, a loader variable)'],
      ['export CDPATH', '`CDPATH` (it sets CDPATH, a loader variable)'],
      ['declare -x ZDOTDIR=/tmp/z', '`ZDOTDIR=` (it sets ZDOTDIR, a loader variable)'],
      ['read IFS', '`IFS` (it sets IFS, a loader variable)'],
      ['printf -v PROMPT_COMMAND %s x', '`PROMPT_COMMAND` (it sets PROMPT_COMMAND, a loader variable)'],
      ['PATH+=:/tmp/bin seed', '`PATH=` (it sets PATH, a loader variable)'],
      ['PSQLRC=/tmp/rc psql -f hooks/a.sql', '`PSQLRC=` (it sets PSQLRC, a loader variable)'],
      ['npm_config_registry=http://127.0.0.1:9 npm i', '`npm_config_registry=` (it sets npm_config_registry, a loader variable)'],
      ['LESSOPEN=x less hooks/a', '`LESSOPEN=` (it sets LESSOPEN, a loader variable)'],
      ['env MANPAGER=x man ls', '`MANPAGER=` (it sets MANPAGER, a loader variable)'],
      ['SSH_ASKPASS=/tmp/a ssh h', '`SSH_ASKPASS=` (it sets SSH_ASKPASS, a loader variable)'],
      ['export SUDO_ASKPASS=/tmp/a', '`SUDO_ASKPASS=` (it sets SUDO_ASKPASS, a loader variable)'],
      ['RUSTC_WRAPPER=/tmp/w cargo build', '`RUSTC_WRAPPER=` (it sets RUSTC_WRAPPER, a loader variable)'],
      ['MAVEN_OPTS=-javaagent:/tmp/a.jar mvn test', '`MAVEN_OPTS=` (it sets MAVEN_OPTS, a loader variable)'],
      ['GRADLE_OPTS=x gradle build', '`GRADLE_OPTS=` (it sets GRADLE_OPTS, a loader variable)'],
      ['ANT_OPTS=x ant', '`ANT_OPTS=` (it sets ANT_OPTS, a loader variable)'],
      ['FPATH=x zsh hooks/a.zsh', '`FPATH=` (it sets FPATH, a loader variable)'],
      ['PIP_INDEX_URL=http://127.0.0.1:9 pip install x', '`PIP_INDEX_URL=` (it sets PIP_INDEX_URL, a loader variable)'],
      ['UV_INDEX_URL=http://127.0.0.1:9 uv sync', '`UV_INDEX_URL=` (it sets UV_INDEX_URL, a loader variable)'],
    ];
    for (const [cmd, problem] of SETS) expect(problems(cmd), cmd).toContain(problem);
    // Not an assignment to the shell (`%` is no name's), so no variable: its env names are checked (agentShellEnvProblems).
    expect(problems('BASH_FUNC_ls%%=x bash hooks/a.sh')).toEqual([]);
    for (const cmd of ['SKU=abc pnpm seed', 'echo PATH', 'echo PATH=x', 'printf HOME=%s x', 'env LANG=C sort x', 'grep -r HOME .', 'curl -s http://127.0.0.1:9/PATH=x']) {
      expect(problems(cmd), cmd).toEqual([]);
    }
  });

  it('a path through a folder an agent can write, whether the file exists or not, however it is written', () => {
    const PATHS: Array<[string, string]> = [
      ['sh runs/r1/x.sh', 'runs/'],
      ['sh runs/r2/missing.sh', 'runs/'],
      ['./scenarios/x.sh', 'scenarios/'],
      ['node README.md', 'README.md'],
      ['python3 scenarios', 'scenarios/'],
      ['sh RUNS/r1/x.sh', 'runs/'],
      [`sh ${projectDir}/runs/r1/x.sh`, 'runs/'],
      [`sh file://${projectDir}/runs/r1/x.sh`, 'runs/'],
      ['psql --file=comments/x.sql', 'comments/'],
      ['psql -fcomments/x.sql', 'comments/'],
      ['psql -f comments/x.sql', 'comments/'],
      ['curl -d @runs/r1/body.json http://127.0.0.1:9/', 'runs/'],
      ['sh scripts/out/r1/x.sh', 'runs/'],
      ['sh ./hooks/../runs/r1/x.sh', 'runs/'],
      ['sh ../other/scenarios/x.sh', 'scenarios/ of another project'],
      ['python3 -m runs.r1.seed', 'runs/'],
      ['python3 -mruns.r1.seed', 'runs/'],
      ['pnpm -C runs run seed', 'runs/'],
      ['make --directory=review', 'review/'],
      ['node --env-file=.env,runs/r1/x hooks/a.js', 'runs/'],
      ['cat .retake/jobs/x', '.retake/'],
    ];
    for (const [cmd, folder] of PATHS) {
      const p = problems(cmd);
      expect(
        p.some((x) => x.includes(`(a path through ${folder}, which an agent can write)`)),
        `${cmd} → ${JSON.stringify(p)}`,
      ).toBe(true);
    }
    // Relative words resolve from the command's working folder.
    expect(problems('sh r1/x.sh', join(projectDir, 'runs'))[0]).toBe('`r1/x.sh` (a path through runs/, which an agent can write)');
    expect(agentWritablePath('scenarios', { files: nodeFileFacts, projectDir, cwd: projectDir, tilde: false })).toBe('scenarios');
    expect(agentWritablePath('hooks/seed.sh', { files: nodeFileFacts, projectDir })).toBeNull();
    expect(agentWritablePath('~/runs/x', { files: nodeFileFacts, projectDir, home: projectDir })).toBe('runs/x');
    expect(agentWritablePath('~/runs/x', { files: nodeFileFacts, projectDir, cwd: projectDir, home: ws, tilde: false })).toBeNull();
  });

  it('a file an agent writes (README.md), bare or not, whatever program reads it; a bare folder name stays a name', () => {
    for (const cmd of ['tclsh README.md', 'expect readme.md', 'julia README.md', 'swift --x=README.md', 'cat ./README.md', 'sh ../other/README.md', 'jshell @README.md']) {
      expect(
        problems(cmd).some((p) => /\(a path through README\.md(?: of another project)?, which an agent can write\)/i.test(p)),
        `${cmd} → ${JSON.stringify(problems(cmd))}`,
      ).toBe(true);
    }
    // From a folder beside the project's own README.md, the bare name is another file.
    expect(problems('tclsh README.md', join(projectDir, 'scripts'))).toEqual([]);
    for (const cmd of ['npm run review', 'make renders', 'grep -r TODO comments']) expect(problems(cmd), cmd).toEqual([]);
  });

  it("a person's files: project.yaml never, hooks/ only as the script a command runs", () => {
    const PERSON: Array<[string, string]> = [
      ['cp /tmp/x hooks/a.sh', "`hooks/a.sh` (a path into hooks/, a person's folder, other than the script a command runs)"],
      ['mv /tmp/x hooks', "`hooks` (a path into hooks/, a person's folder, other than the script a command runs)"],
      ['node hooks/x.mjs hooks/out.json', "`hooks/out.json` (a path into hooks/, a person's folder, other than the script a command runs)"],
      ['cp /tmp/x project.yaml', "`project.yaml` (project.yaml, a person's file)"],
      ['sed -i.bak s/a/b/ ./project.yaml', "`./project.yaml` (project.yaml, a person's file)"],
      ['cp /tmp/x ../other/project.yaml', "`../other/project.yaml` (project.yaml, a person's file)"],
    ];
    for (const [cmd, problem] of PERSON) expect(problems(cmd), cmd).toContain(problem);
    // From a working folder in hooks/, a bare name is a path into it.
    expect(problems('cp /tmp/x a.sh', join(projectDir, 'hooks'))).toEqual(["`a.sh` (a path into hooks/, a person's folder, other than the script a command runs)"]);
    expect(problems('sh seed.sh', join(projectDir, 'hooks'))).toEqual([]);
  });

  it('keeps plain commands — the scripts a person wrote, a name that is also a folder', () => {
    const KEPT = [
      'echo hello',
      'sleep 1.5',
      'true',
      'pnpm run seed --small',
      'npm run db:reset && npm run db:seed',
      'curl -s -X POST http://localhost:4401/api/reset',
      'sh hooks/seed.sh',
      './hooks/seed.sh',
      'bash hooks/seed.sh --rows=3',
      'node hooks/seed.mjs --rows=3',
      'awk -f hooks/x.awk data.csv',
      'psql -f hooks/reset.sql',
      'psql --file=hooks/reset.sql',
      'python3 -m hooks.seed',
      'git -C ../app status',
      'git log -n 1',
      'npm --prefix ../app run build',
      'npm run review',
      'make renders',
      'grep -r TODO comments',
      'touch /tmp/retake-elsewhere',
      'A=1 B=x,y pnpm seed',
      'echo user@example.test 50% +1 a:b',
    ];
    for (const cmd of KEPT) expect(problems(cmd), cmd).toEqual([]);
  });

  it('each problem once, in the order found', () => {
    expect(problems('cd x && cd y && eval z')).toEqual(["`cd` (it changes the folder its paths resolve from: set the hook's `cwd` instead)", '`eval` (it runs text as a command)']);
  });
});

describe('agent-written shell hooks: the working folder and the env names', () => {
  it('a working folder is one plain word, not through a folder an agent can write', () => {
    const o = { projectDir, cwd: projectDir, files: nodeFileFacts };
    expect(agentShellCwdProblems('scripts', o)).toEqual([]);
    expect(agentShellCwdProblems('../app', o)).toEqual([]);
    expect(agentShellCwdProblems('scenarios', o)).toEqual(['its working folder `scenarios` (a path through scenarios/, which an agent can write)']);
    expect(agentShellCwdProblems('a b', o)).toEqual(['its working folder `a b` (one plain word: letters, digits and . / : = @ % + , - _)']);
    expect(agentShellCwdProblems('~/x', o)[0]).toMatch(/^its working folder `~\/x` \(one plain word/);
    expect(agentShellCwdProblems('x'.repeat(AGENT_SHELL_MAX_CHARS + 1), o)).toEqual(['its working folder: 4,001 characters (at most 4,000)']);
  });

  it('env names are plain identifiers and no loader variable', () => {
    expect(agentShellEnvProblems({ SKU: 'a', MODE: 'demo', _X1: 'y' })).toEqual([]);
    expect(agentShellEnvProblems(undefined)).toEqual([]);
    expect(agentShellEnvProblems({ 'BASH_FUNC_ls%%': '() { id; }', 'A\nB': 'x', '1A': 'x', NODE_OPTIONS: '-r x', PSQLRC: '/tmp/rc' })).toEqual([
      'its env name `BASH_FUNC_ls%%` (letters, digits and _, not starting with a digit)',
      'its env name `A\\u{a}B` (letters, digits and _, not starting with a digit)',
      'its env name `1A` (letters, digits and _, not starting with a digit)',
      'its env `NODE_OPTIONS` (a loader variable)',
      'its env `PSQLRC` (a loader variable)',
    ]);
    expect(agentShellEnvProblems({ LESSOPEN: 'x', RUSTC_WRAPPER: 'x', MAVEN_OPTS: 'x', FPATH: 'x', PIP_INDEX_URL: 'x', UV_INDEX_URL: 'x', SUDO_ASKPASS: 'x' })).toHaveLength(7);
  });
});
