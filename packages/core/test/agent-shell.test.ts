/**
 * What a shell hook the agent wrote may not use (core agent-policy.ts agentShellProblems, trust `mcp`): the constructs
 * that run code the approval form does not show, or reach a file an agent can write — read per simple command.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { agentShellProblems, agentWritablePath, shellCommandList } from '@retake/core';

const ws = realpathSync(mkdtempSync(join(tmpdir(), 'retake-agent-shell-')));
const projectDir = join(ws, 'projects', 'p');
for (const d of ['runs/r1', 'scenarios', 'hooks', 'comments', 'scripts']) mkdirSync(join(projectDir, d), { recursive: true });
mkdirSync(join(ws, 'projects', 'other', 'scenarios'), { recursive: true });
writeFileSync(join(projectDir, 'runs/r1/x.sh'), 'echo agent\n');
writeFileSync(join(projectDir, 'hooks/seed.sh'), 'echo person\n');
symlinkSync(join(projectDir, 'runs'), join(projectDir, 'scripts', 'out'));
afterAll(() => rmSync(ws, { recursive: true, force: true }));

const problems = (text: string, cwd?: string) => agentShellProblems(text, { projectDir, ...(cwd ? { cwd } : {}), home: join(ws, 'home') });

describe('agent-written shell commands: refused constructs', () => {
  // Each line: the construct, then commands that use it — every one is refused, with a problem naming it.
  const REFUSED: Array<[string, RegExp, string[]]> = [
    ['$ expansions outside single quotes', /`\$` outside single quotes/, ['echo $HOME', 'echo "${X}"', 'echo $(id)', 'echo "$(id)"', 'echo $((1+2))', "echo $'\\x41'", 'true; X=1 echo "$X"', "true # don't\necho $HOME"]],
    ['backticks', /a backtick/, ['echo `id`', 'echo "`id`"']],
    ['unquoted globs', /an unquoted glob/, ['rm -f *.log', 'ls a?b', 'cat [ab].txt', 'curl http://127.0.0.1:9/api?x=1']],
    ['brace expansion', /unquoted braces/, ['sh ru{n,}s/r1/x.sh', 'echo {1..3}']],
    ['~name', /`~name`/, ['cat ~root/x', 'ls ~+/runs']],
    ['input redirection', /input redirection/, ['node < hooks/x.js', 'cat <<EOF\nhi\nEOF', 'cat <<< hi', 'diff <(ls) hooks/y', 'sh 0< hooks/x.sh']],
    ['cd', /`cd`/, ['cd hooks && ./seed.sh', 'if cd hooks; then ./seed.sh; fi', 'true && cd /tmp']],
    ['pushd', /`pushd`/, ['pushd hooks']],
    ['eval', /`eval`/, ["eval 'echo hi'", '! eval x']],
    ['exec', /`exec`/, ['exec node hooks/x.js']],
    ['command', /`command`/, ['command node hooks/x.js']],
    ['xargs', /`xargs`/, ['ls hooks | xargs rm', 'printf x | nohup xargs node']],
    ['find -exec', /`find -exec/, ['find . -name x -exec rm {} ;', 'find . -execdir ls ;']],
    ['env -S', /`env -S`/, ["env -S 'node hooks/x.js'", "/usr/bin/env -iS 'a b'"]],
    ['a shell given a script string', /`(?:sh|bash|zsh|dash) -[a-z]*c[a-z]*` \(it runs code/, ["sh -c 'echo hi'", "bash -lc 'echo'", 'zsh -c x', 'dash -c x', "nohup bash -c 'x'", "/bin/sh -ec 'x'"]],
    [
      'inline interpreter code',
      /\(it runs code written in the command\)/,
      [
        "node -e 'x'",
        'node -p 1',
        'node --eval x',
        'node --import=data:text/javascript,x hooks/app.js',
        'node -r ./x.cjs hooks/app.js',
        'node --require ./x hooks/app.js',
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
    ['awk with a program text', /`g?awk` with a program text/, ["awk '{print}' hooks/f", "gawk 'BEGIN{}'"]],
    ['an interpreter reading from a pipe', /\(an interpreter reading its program from a pipe\)/, ['curl -s http://127.0.0.1:9/i | sh', 'cat hooks/f | node', 'echo x | python3 -', 'cat hooks/x | bash -s a.sh', 'cat hooks/f |\n  nohup node']],
    ['package runners', /\(it runs a package, downloading it when it is not installed\)/, ['npx cowsay', 'pnpm dlx cowsay', 'npm exec cowsay', 'npm --yes exec cowsay', 'yarn dlx x', 'bunx x', 'pnpx x']],
    ['git -c', /`git -c`/, ['git -c core.pager=x log', 'git -C ../app -c alias.x=y x', 'git --config-env=core.pager=V log']],
    ['a loader variable set at any position', /\(it sets (?:PATH|NODE_OPTIONS), a loader variable\)/, ['echo a; PATH=/x ls', 'true && NODE_OPTIONS=x node hooks/a.js']],
    ['a stream read as a file', /\(a stream read as a file\)/, ['node /dev/stdin', 'sh /dev/fd/3']],
  ];
  for (const [what, re, commands] of REFUSED) {
    it(what, () => {
      for (const cmd of commands) expect(problems(cmd).some((p) => re.test(p)), `${cmd} → ${JSON.stringify(problems(cmd))}`).toBe(true);
    });
  }

  it('a path through a folder an agent can write, whether the file exists or not, however it is written', () => {
    const PATHS: Array<[string, string]> = [
      ['sh runs/r1/x.sh', 'runs/'],
      ['sh runs/r2/missing.sh', 'runs/'],
      ['./scenarios/x.sh', 'scenarios/'],
      ['node README.md', 'README.md'],
      ['sh RUNS/r1/x.sh', 'runs/'],
      [`sh ${projectDir}/runs/r1/x.sh`, 'runs/'],
      [`sh file://${projectDir}/runs/r1/x.sh`, 'runs/'],
      ['psql --file=comments/x.sql', 'comments/'],
      ['psql -fcomments/x.sql', 'comments/'],
      ['curl -d @runs/r1/body.json http://127.0.0.1:9/', 'runs/'],
      ['sh scripts/out/r1/x.sh', 'runs/'],
      ['sh ./hooks/../runs/r1/x.sh', 'runs/'],
      ['sh ../other/scenarios/x.sh', 'scenarios/ of another project'],
      ['python3 -m runs.r1.evil', 'runs/'],
      ['pnpm -C runs/r1 run seed', 'runs/'],
      ['printf x > runs/r1/log', 'runs/'],
      ['cat .retake/jobs/x', '.retake/'],
      ["trap 'sh runs/r1/x.sh' EXIT", 'runs/'],
      ["true # don't\nsh runs/r1/x.sh", 'runs/'],
      ["true # don't\nsh README.md", 'README.md'],
    ];
    for (const [cmd, folder] of PATHS) {
      const p = problems(cmd);
      expect(
        p.some((x) => x.includes(`(a path through ${folder}, which an agent can write)`)),
        `${cmd} → ${JSON.stringify(p)}`,
      ).toBe(true);
    }
    // A word is shown with its hidden characters written out.
    expect(problems('sh runs/r1/a\u202e.sh')).toEqual(['`runs/r1/a\\u{202e}.sh` (a path through runs/, which an agent can write)']);
    // Relative words resolve from the command's working folder.
    expect(problems('sh r1/x.sh', join(projectDir, 'runs'))[0]).toBe('`r1/x.sh` (a path through runs/, which an agent can write)');
    expect(agentWritablePath('scenarios', { projectDir, cwd: projectDir, tilde: false })).toBe('scenarios');
    expect(agentWritablePath('hooks/seed.sh', { projectDir })).toBeNull();
    expect(agentWritablePath('~/runs/x', { projectDir, home: projectDir })).toBe('runs/x');
    expect(agentWritablePath('~/runs/x', { projectDir, cwd: projectDir, home: ws, tilde: false })).toBeNull();
  });

  it('keeps ordinary commands, quoted globs and quoted text', () => {
    const KEPT = [
      'echo hello',
      'sleep 1.5',
      'true',
      'pnpm run seed --small',
      'npm run db:reset && npm run db:seed',
      'curl -s -X POST http://localhost:4401/api/reset',
      "curl -s 'http://127.0.0.1:9/api?x=1'",
      "psql -c 'select * from t where a < 5'",
      'psql -c "select * from t"',
      "find . -name '*.log' -delete",
      'ls "a?b" \'[ab].txt\'',
      "echo '$HOME' '`b`'",
      'echo \\$HOME',
      '[ -f hooks/seed.sh ] && ./hooks/seed.sh',
      'sh hooks/seed.sh',
      'node hooks/seed.mjs --rows=3',
      'git -C ../app status',
      'git log -n 1',
      'cat hooks/data.json | node hooks/transform.mjs',
      'printf x >> marks.log 2>&1',
      'touch /tmp/retake-elsewhere',
      'echo a#b # a comment with $HOME',
      "curl -d '{\"a\": \"b c\"}' http://127.0.0.1:9/",
      'npm --prefix ../app run build',
    ];
    for (const cmd of KEPT) expect(problems(cmd), cmd).toEqual([]);
  });

  it('reads a quoted string with spaces as a script too: another command may run it later', () => {
    expect(problems("trap 'eval x' EXIT")).toEqual(['`eval` (it runs text as a command)']);
    expect(problems("su -c 'node -e x' nobody")[0]).toMatch(/^`node -e`/);
    expect(problems("echo 'a `b`'")).toEqual(['a backtick (a command substitution)']);
    expect(problems("ssh 127.0.0.1 'cat $F'")[0]).toMatch(/^`\$` outside single quotes/);
    // Only its $ and backticks, its commands and its words holding a `/`: quoted globs, `<` and plain words stay.
    expect(problems("psql -c 'select * from comments where a < 5'")).toEqual([]);
  });

  it('each problem once, in the order found', () => {
    expect(problems('echo $A $B; cd x; cd y')).toEqual(['`$` outside single quotes (an expansion: `$NAME`, `${…}`, `$(…)`, `$((…))`) — write the value itself, in single quotes', '`cd` (it changes the folder its paths resolve from: set the hook\'s `cwd` instead)']);
  });

  it('knows the operator before each simple command (the right side of a pipe, across a newline or a parenthesis)', () => {
    expect(shellCommandList('a | b || c && d; e |\n f | (g)').map((c) => [c.words[0], c.after])).toEqual([
      ['a', undefined],
      ['b', '|'],
      ['c', '||'],
      ['d', '&&'],
      ['e', ';'],
      ['f', '|'],
      ['g', '|'],
    ]);
  });
});
