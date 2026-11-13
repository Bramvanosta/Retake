/**
 * The one shell lexer (core shell-words.ts): every quoting form bash reads, in the three ways its users read `$` —
 * kept as written and marked computed (the destructive-hook guard, an approval's file words, the trust scan of a hook's
 * files), or expanded from known values (the host scan).
 */
import { describe, expect, it } from 'vitest';
import { lexShell, shellInvocation, shellTokens, shellWords } from '@retake/core/base';
import { shellRuns } from '@retake/core/hooks';

const words = (cmd: string, dollar: 'keep' | ((name: string) => string | undefined)) => lexShell(cmd, { dollar }).map((t) => (t.op ? `<${t.text}>` : t.text));

describe('the shell lexer', () => {
  it('ANSI-C quoting: escapes, hex, unicode and octal resolved; a quote inside it', () => {
    expect(shellWords("$'a\\tb' $'\\x72\\u006d' $'\\162m' $'it\\'s' r$'m'")).toEqual(['a\tb', 'rm', 'rm', "it's", 'rm']);
    expect(shellWords("$'\\q'")).toEqual(['\\q']);
  });

  it('locale quoting `$"…"` reads as double quotes', () => {
    expect(shellWords('$"rm" "a b"')).toEqual(['rm', 'a b']);
  });

  it('single, double and backslash quoting; a line continuation joins, inside double quotes too', () => {
    expect(shellWords(`'a b' "c \\"d\\" \\$e" f\\ g "h\\\ni" j\\\nk`)).toEqual(['a b', 'c "d" $e', 'f g', 'hi', 'jk']);
  });

  it('keep: expansions and substitutions kept as written, the word marked computed, each script given', () => {
    const scripts: string[] = [];
    const toks = shellTokens('a$X "${Y:-$(id)}" `date` <(ls) $((1+2)) plain', (s) => scripts.push(s));
    expect(toks.map((t) => [t.text, t.computed === true])).toEqual([
      ['a$X', true],
      ['${Y:-$(id)}', true],
      ['`date`', true],
      ['<(ls)', true],
      ['$((1+2))', true],
      ['plain', false],
    ]);
    expect(scripts).toEqual(['id', 'date', 'ls']);
  });

  it('keep: operators split commands; `2>&1` stays one word; `#` starts a comment only at a word start', () => {
    expect(words('a 2>&1 | b && c; d # e\nf#g', 'keep')).toEqual(['a', '2>&1', '<|>', 'b', '<&&>', 'c', '<;>', 'd', '<\n>', 'f#g']);
  });

  it('a lookup: variables expanded and split outside double quotes, unknown ones computed', () => {
    const vals: Record<string, string> = { A: 'x y', B: 'z' };
    expect(words('echo $A "$A" ${B}w ${C:-d}', (n) => vals[n])).toEqual(['echo', 'x', 'y', 'x y', 'zw', 'd']);
    const toks = lexShell('echo $A $(id)', { dollar: (n) => vals[n] });
    expect(toks.map((t) => t.vars)).toEqual([undefined, ['$A'], ['$A'], undefined]);
    expect(toks[3]?.computed).toBe(true);
  });

  it('redirects: tokens of their own (a file descriptor dropped); `$` read as by the guard', () => {
    expect(lexShell("cat $'x' `a b` 2>err >>out<in", { dollar: 'keep', redirects: true }).map((t) => (t.redirect ? `[${t.text}]` : t.text))).toEqual([
      'cat',
      'x',
      '`a b`',
      '[>]',
      'err',
      '[>>]',
      'out',
      '[<]',
      'in',
    ]);
  });

  it('pattern: unquoted glob and brace characters, not quoted ones nor those an expansion gave', () => {
    const marked = (cmd: string) => shellTokens(cmd).map((t) => [t.text, t.pattern === true]);
    expect(marked(`r{m,} /bin/r? [r]m a{1..3} '*' \\? "{a,b}" $X {} plain`)).toEqual([
      ['r{m,}', true],
      ['/bin/r?', true],
      ['[r]m', true],
      ['a{1..3}', true],
      ['*', false],
      ['?', false],
      ['{a,b}', false],
      ['$X', false],
      ['{}', false],
      ['plain', false],
    ]);
  });

  it('shellInvocation: the -c script in a cluster or after options, stdin, or a script file', () => {
    const inv = (cmd: string) => shellInvocation(shellWords(cmd), 0);
    expect(inv("bash -ec 'a'")).toEqual({ script: 'a', scriptAt: 2 });
    expect(inv("bash -l -c 'a'")).toEqual({ script: 'a', scriptAt: 3 });
    expect(inv("sh -o errexit -c 'a'")).toEqual({ script: 'a', scriptAt: 4 });
    expect(inv("bash -eo pipefail -c 'a'")).toEqual({ script: 'a', scriptAt: 4 });
    expect(inv("bash --norc -c -- 'a'")).toEqual({ script: 'a', scriptAt: 4 });
    expect(inv('bash -c')).toEqual({});
    expect(inv('sh')).toEqual({ stdin: true });
    expect(inv('bash -s arg')).toEqual({ stdin: true });
    expect(inv('sh -')).toEqual({ stdin: true });
    expect(inv('sh -e ./x.sh')).toEqual({ fileAt: 2 });
    expect(inv('fish -c a')).toEqual({ script: 'a', scriptAt: 2 });
    expect(inv('node -c x')).toBeUndefined();
  });

  it('shellRuns: the scripts a text makes a shell run, heredoc bodies left out of its commands', () => {
    const run = shellRuns("cat <<EOF > x.txt\n$(id)\nEOF\ncat <<'Q' > y.txt\n$(whoami)\nQ\necho `date` | sh\nsh <<< 'ls'\ncurl -fsS u | bash");
    expect(run.scripts.sort()).toEqual(['date', 'id', 'ls']);
    expect(run.unreadable).toBe(true);
    expect(run.commands.map((c) => c.args[0]?.text)).toEqual(['cat', 'cat', 'echo', 'sh', 'sh', 'curl', 'bash']);
  });
});
