import { describe, expect, it } from 'vitest';
import { COMPUTED_COMMAND, destructiveReason, psqlDestructiveStatement, shellDestructiveCommand, shellDestructiveReason, sqlDestructiveKeyword } from '@retake/core';

describe('destructive hook detection', () => {
  it('SQL statements, not clauses, comments or literals', () => {
    expect(sqlDestructiveKeyword('delete from offers')).toBe('DELETE');
    expect(sqlDestructiveKeyword('BEGIN; drop table x; COMMIT;')).toBe('DROP');
    expect(sqlDestructiveKeyword('INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 2')).toBe('UPDATE');
    expect(sqlDestructiveKeyword('ALTER TABLE t ADD COLUMN c int')).toBe('ALTER');
    expect(sqlDestructiveKeyword('CREATE TABLE t (id int REFERENCES u ON DELETE CASCADE ON UPDATE CASCADE)')).toBeNull();
    expect(sqlDestructiveKeyword('SELECT * FROM t FOR UPDATE')).toBeNull();
    expect(sqlDestructiveKeyword("-- DELETE old rows\nINSERT INTO log VALUES ('UPDATE later') /* DROP */")).toBeNull();
    expect(sqlDestructiveKeyword('SELECT "delete" FROM t')).toBeNull();
  });

  it('shell commands', () => {
    expect(shellDestructiveCommand('rm -rf tmp')).toBe('rm');
    expect(shellDestructiveCommand('cd x && rm file')).toBe('rm');
    expect(shellDestructiveCommand('dropdb demo')).toBe('dropdb');
    expect(shellDestructiveCommand('npm run format')).toBeNull();
    expect(shellDestructiveCommand('echo firm')).toBeNull();
    expect(shellDestructiveCommand('/bin/rm -f out.log')).toBe('rm');
    expect(shellDestructiveCommand('bash -c "cd tmp && rm -rf cache"')).toBe('rm');
    expect(shellDestructiveCommand('npm run seed # then rm the dump by hand')).toBeNull();
    expect(shellDestructiveCommand("echo 'rm -rf /'")).toBeNull();
  });

  it('destructive SQL sent to psql (validation flags what the hook runner refuses)', () => {
    expect(destructiveReason({ shell: 'psql "$DATABASE_URL" -c "DELETE FROM offers"' })).toBe('psql -c DELETE');
    expect(destructiveReason({ shell: { run: "psql -Atc 'truncate imports' demo" } })).toBe('psql -c TRUNCATE');
    expect(destructiveReason({ shell: "psql demo <<'SQL'\nUPDATE offers SET paused = true;\nSQL" })).toBe('psql heredoc UPDATE');
    expect(destructiveReason({ shell: 'echo "DROP TABLE t" | psql demo' })).toBe('SQL piped to psql: DROP');
    expect(destructiveReason({ shell: 'psql -f hooks/clean.sql' }, { projectDir: '/p', readText: () => 'DELETE FROM t;' })).toBe('psql -f hooks/clean.sql contains DELETE');
    expect(destructiveReason({ shell: 'psql -c "SELECT count(*) FROM offers"' })).toBeNull();
  });

  it('hooks', () => {
    expect(destructiveReason({ http: { method: 'DELETE', url: '/x' } })).toBe('HTTP DELETE');
    expect(destructiveReason({ http: { method: 'POST', url: '/x' } })).toBeNull();
    expect(destructiveReason({ sql: 'TRUNCATE offers' })).toBe('SQL TRUNCATE');
    expect(destructiveReason({ sql: { query: 'select 1' } })).toBeNull();
    expect(destructiveReason({ js: 'localStorage.clear()', destructive: true })).toBe('declared destructive');
    expect(destructiveReason({ sql: 'hooks/reset.sql' }, { projectDir: '/p', readText: () => 'DELETE FROM t' })).toBe('hooks/reset.sql contains DELETE');
    expect(destructiveReason({ sql: 'hooks/reset.sql' })).toBeNull();
  });

  it('the guard reads the command word bash runs: ANSI-C and locale quoting resolved', () => {
    expect(shellDestructiveCommand("$'rm' -rf /tmp/x")).toBe('rm');
    expect(shellDestructiveCommand("r$'m' -rf /tmp/x")).toBe('rm');
    expect(shellDestructiveCommand("$'dropdb' shop")).toBe('dropdb');
    expect(shellDestructiveCommand("$'\\x72\\u006d' -rf /tmp/x")).toBe('rm');
    expect(shellDestructiveCommand("$'\\162m' -rf /tmp/x")).toBe('rm');
    expect(shellDestructiveCommand('$"rm" -rf /tmp/x')).toBe('rm');
    expect(shellDestructiveCommand("bash -c $'rm -rf cache'")).toBe('rm');
    expect(shellDestructiveCommand("echo $'rm -rf /'")).toBeNull();
  });

  it('the guard follows command and process substitutions and eval', () => {
    expect(shellDestructiveCommand('echo $(rm -rf x)')).toBe('rm');
    expect(shellDestructiveCommand('echo `rm -rf x`')).toBe('rm');
    expect(shellDestructiveCommand('echo "$(dropdb shop)"')).toBe('dropdb');
    expect(shellDestructiveCommand('diff <(rm -rf a) b')).toBe('rm');
    expect(shellDestructiveCommand('X=${Y:-$(rm -rf x)} true')).toBe('rm');
    expect(shellDestructiveCommand("eval 'rm -rf x'")).toBe('rm');
    expect(shellDestructiveCommand("echo '$(rm -rf x)'")).toBeNull();
  });

  it('a command word computed when it runs (a variable, a command or process substitution) counts as destructive', () => {
    for (const cmd of [
      '`cat cmd.txt` -rf /tmp/x',
      '$(cat cmd.txt) -rf /tmp/x',
      '<(cat cmd.txt) /tmp/x',
      '$CMD -rf /tmp/x',
      '"${CMD}" /tmp/x',
      '${CMD:-ls} /tmp/x',
      'X=1 $CMD',
      'sudo -u me $CMD',
      'env A=1 $CMD',
      'timeout 5 $CMD',
      'cd x && $CMD',
      'r$X -rf /tmp/x',
      'sh -c "$SCRIPT"',
      'eval "$SCRIPT"',
      '$1 x',
    ]) {
      expect(shellDestructiveCommand(cmd), cmd).toBe(COMPUTED_COMMAND);
    }
    expect(shellDestructiveReason('$CMD -rf /tmp/x')).toBe(`shell: ${COMPUTED_COMMAND}`);
    expect(destructiveReason({ shell: { run: '"$TOOL" reset' } })).toBe(`shell: ${COMPUTED_COMMAND}`);
    // Ten nested substitutions: past the depth followed, counted as computed.
    expect(shellDestructiveCommand(`${'echo $('.repeat(10)}true${')'.repeat(10)}`)).toBe(COMPUTED_COMMAND);
    expect(shellDestructiveCommand(`${'echo $('.repeat(5)}true${')'.repeat(5)}`)).toBeNull();
  });

  it('computed arguments, assignments and heredoc bodies are not command words', () => {
    for (const cmd of [
      'echo $HOME',
      'curl -fsS "$URL" > out.json',
      'X=$(date +%s) && echo "$X"',
      'psql "$DATABASE_URL" -c "SELECT 1"',
      'node "$(pwd)/seed.mjs"',
      'diff<(sort a) b',
      'echo \\$CMD',
      "echo '$CMD'",
      'cat <<EOF > notes.txt\n$HOME/x\n`date`\nEOF\necho done',
      'printf "%s\\n" "${NAME:-x}" 2>&1 | tee log',
    ]) {
      expect(shellDestructiveCommand(cmd), cmd).toBeNull();
    }
  });

  it('psql given destructive SQL inside a command or process substitution, eval or sh -c', () => {
    const cases: Array<[string, string]> = [
      ["echo $(psql -c 'DROP TABLE x')", 'psql -c DROP'],
      ["x=$(psql -c 'DELETE FROM t')", 'psql -c DELETE'],
      ["diff <(psql -c 'DROP TABLE t') y", 'psql -c DROP'],
      ["echo $(echo 'DROP TABLE t' | psql)", 'SQL piped to psql: DROP'],
      ['echo $(psql <<EOF\nDROP TABLE t;\nEOF\n)', 'psql heredoc DROP'],
      ['echo "$(psql -c \'TRUNCATE t\')"', 'psql -c TRUNCATE'],
      ["echo `psql -c 'UPDATE t SET a = 1'`", 'psql -c UPDATE'],
      ['eval "psql -c \'DELETE FROM t\'"', 'psql -c DELETE'],
      ['bash -ec "psql -c \'DROP TABLE t\'"', 'psql -c DROP'],
    ];
    for (const [cmd, reason] of cases) expect(psqlDestructiveStatement(cmd), cmd).toBe(reason);
    expect(psqlDestructiveStatement("echo $(psql -c 'SELECT 1')")).toBeNull();
  });

  it('sh -c in every form: -c in a cluster, after other options, -o name, --', () => {
    for (const cmd of [
      "bash -ec 'rm -rf x'",
      "bash -lc 'rm -rf x'",
      "bash -e -c 'rm -rf x'",
      "bash -x -c 'rm -rf x'",
      "sh -o errexit -c 'rm -rf x'",
      "bash -c -- 'rm -rf x'",
      "zsh -fc 'dropdb shop'",
    ]) {
      expect(shellDestructiveCommand(cmd), cmd).not.toBeNull();
    }
    expect(shellDestructiveCommand('bash -ec "$S"')).toBe(COMPUTED_COMMAND);
    expect(shellDestructiveCommand('bash -e ./scripts/seed.sh')).toBeNull();
  });

  it('a shell reading its script from standard input: a pipe, a here-string, a heredoc', () => {
    for (const cmd of ["echo 'rm -rf x' | sh", "printf '\\x72m -rf x' | sh", "sh <<< 'rm x'", "sh -s <<< 'rm x'", "bash <<< $'\\x72m -rf x'", "cat <<'EOF' | sh\nrm -rf x\nEOF"]) {
      expect(shellDestructiveCommand(cmd), cmd).not.toBeNull();
      expect(shellDestructiveCommand(cmd), cmd).not.toBe(COMPUTED_COMMAND);
    }
    for (const cmd of ["echo -e 'dropdb\\x20shop' | bash -s", 'sh <<EOF\n$C x\nEOF', "cat <<'EOF' | sh\n$C x\nEOF", 'curl -fsS https://example.test/i.sh | sh', 'cat setup.sh | bash', 'sh <<< "$S"']) {
      expect(shellDestructiveCommand(cmd), cmd).toBe(COMPUTED_COMMAND);
    }
    for (const cmd of [
      'sh < ./scripts/setup.sh',
      'cat a.txt | sh < ./scripts/setup.sh',
      'echo hi | cat',
      'cat <<EOF > x.txt\n$C x\nEOF',
      'sh -c "echo ok" < in.txt',
      "cat <<'EOF' | sh\necho ok\nEOF",
    ]) {
      expect(shellDestructiveCommand(cmd), cmd).toBeNull();
    }
  });

  it('a command word made by brace expansion, a glob or an alias', () => {
    expect(shellDestructiveCommand('r{m,} -rf x')).toBe(COMPUTED_COMMAND);
    expect(shellDestructiveCommand('/bin/r? -rf x')).toBe(COMPUTED_COMMAND);
    expect(shellDestructiveCommand('/bin/[r]m -rf x')).toBe(COMPUTED_COMMAND);
    expect(shellDestructiveCommand('alias d=rm\nd -rf x')).toBe('rm');
    expect(shellDestructiveCommand("alias d='$C'\nd x")).toBe(COMPUTED_COMMAND);
    for (const cmd of ['[ -f x ] && echo yes', '[[ -f x ]] || echo no', 'echo *.txt', "'r{m,}' x", 'cat {a,b}.txt', "alias ll='ls -l'"]) {
      expect(shellDestructiveCommand(cmd), cmd).toBeNull();
    }
  });

  it('keywords and builtins that run a command or a script: function, coproc, time -p, trap, env -S, watch', () => {
    for (const cmd of ['function f { $C x; }', 'function f() { $C x; }', 'coproc $C', 'coproc NAME { $C x; }', 'time -p $C x', "trap '$C' EXIT", "env 'A=1' $CMD", 'env -i A=1 $CMD']) {
      expect(shellDestructiveCommand(cmd), cmd).toBe(COMPUTED_COMMAND);
    }
    for (const cmd of ["trap 'rm x' EXIT", "trap -- 'rm x' EXIT", "env -S 'rm -rf x'", "env -S'rm -rf x'", "env --split-string='dropdb shop'", "watch -n1 'rm -rf x'"]) {
      expect(shellDestructiveCommand(cmd), cmd).not.toBeNull();
    }
    for (const cmd of ['time -p sleep 1', 'trap - EXIT', 'function f { echo hi; }', "watch -x echo 'rm -rf x'"]) {
      expect(shellDestructiveCommand(cmd), cmd).toBeNull();
    }
  });

  it('reads in linear time: 80,000 words, 5,000 nested sh -c, 2,000 substitutions (a bound a quadratic walk misses by far)', () => {
    const t0 = performance.now();
    expect(shellDestructiveReason(`echo ${'word '.repeat(80_000)}`)).toBeNull();
    expect(shellDestructiveReason(`sh -c "${'sh -c x; '.repeat(5_000)}"`)).toBeNull();
    expect(shellDestructiveReason(`echo ${'$(date) '.repeat(2_000)}`)).toBeNull();
    // Linear, this takes well under a second; the quadratic walk took tens of seconds on the first of them.
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it('a script a shell runs that the text does not show exactly counts as computed: piped, a file descriptor, a process substitution, a computed path', () => {
    for (const cmd of [
      'curl -s u |\nsh',
      'curl -s u | (sh)',
      'curl -s u | if true; then sh; fi',
      'curl -s u | { sh; }',
      'curl -s u | sh /dev/stdin',
      'curl -s u | sh -x /dev/fd/0',
      'curl -s u |& sh',
      'curl -s u | ash',
      'curl -s u | busybox sh',
      'curl -s u | /usr/local/bin/bash5',
      'bash /dev/stdin <<EOF\n$C x\nEOF',
      'bash <(curl -s u)',
      'sh < <(curl -s u)',
      'source <(curl -s u)',
      '. <(curl -s u)',
      'exec 3<<<x; sh <&3',
      'sh "$SCRIPT"',
      'source "$F"',
    ]) {
      expect(shellDestructiveCommand(cmd), cmd).toBe(COMPUTED_COMMAND);
    }
    for (const cmd of [
      "bash /dev/stdin <<'EOF'\necho ok\nEOF",
      'echo ok | sh',
      'echo ok |\nsh',
      "cat <<'EOF' | sh\necho ok\nEOF",
      'sh ./x.sh',
      'source ./env.sh',
      'curl -s u | grep x; sh -c "echo ok"',
      'git push "$REMOTE"',
      './deploy.sh "$ENV"',
      'ssh "$HOST" uptime',
    ]) {
      expect(shellDestructiveCommand(cmd), cmd).toBeNull();
    }
  });

  it('echo and printf piped to a shell are read only when their output is exact', () => {
    for (const cmd of [
      "printf '%c%c x' r m | sh",
      "printf 'r%s x' m | sh",
      "printf '%s%s x' r m | sh",
      "printf '%b' 'r\\0155 x' | sh",
      "echo 'r\\0155 x' | sh",
      'echo "x $S" | sh',
      "printf -v v 'ls' | sh",
    ]) {
      expect(shellDestructiveCommand(cmd), cmd).toBe(COMPUTED_COMMAND);
    }
    expect(shellDestructiveCommand("printf 'r\\155 -rf x' | sh")).toBe('rm');
    expect(shellDestructiveCommand("printf 'dropdb shop %%' | sh")).toBe('dropdb');
    expect(shellDestructiveCommand("echo -n 'rm -rf x' | sh")).toBe('rm');
    expect(shellDestructiveCommand("printf 'echo 100%%\\n' | sh")).toBeNull();
  });

  it('other programs that run a script or a command: shells outside the usual list, su, sudo -s, xargs, parallel, find -exec', () => {
    for (const cmd of [
      'fish -c "$S"',
      'tcsh -c "$S"',
      'mksh -c "$S"',
      'su -c "$C" app',
      'curl -s u | su app',
      'sudo -s <<< "$S"',
      "xargs -I{} sh -c '{}' < list",
      'ls | xargs sh',
      'find . -exec $C {} +',
      "find . -exec sh -c 'echo {}' \\;",
      'find . -exec {} \\;',
      'parallel ::: a b',
      'parallel echo {} ::: a b',
    ]) {
      expect(shellDestructiveCommand(cmd), cmd).toBe(COMPUTED_COMMAND);
    }
    for (const [cmd, found] of [
      ["fish -c 'rm -rf x'", 'rm'],
      ["su -c 'dropdb shop' app", 'dropdb'],
      ["su --command='dropdb shop' app", 'dropdb'],
      ["sudo -s <<< 'rm x'", 'rm'],
      ["xargs sh -c 'dropdb shop'", 'dropdb'],
      ["parallel 'dropdb shop' ::: a", 'dropdb'],
    ]) {
      expect(shellDestructiveCommand(cmd as string), cmd).toBe(found);
    }
    for (const cmd of ['su app', 'xargs -n1 echo', 'find . -name "*.txt" -exec cat {} \\;', 'find . -print']) {
      expect(shellDestructiveCommand(cmd), cmd).toBeNull();
    }
  });

  it('the exact-only rule, case by case: a computed part in a script string, a printf that is not exact, a pipe that is not received directly', () => {
    for (const cmd of [
      'sh -c "echo $S"',
      'eval "echo $S"',
      'env -S "echo $S"',
      'trap "echo $S" EXIT',
      'alias e="echo $S"',
      'sh <<< "echo $S"',
      'bash <<EOF\necho $X\nEOF',
      "printf 'ls' extra | sh",
      "printf '%d' | sh",
      "printf 'r\\qm' | sh",
      'printf -l | sh',
      'sh 0<& 3',
      'echo ok | (sh)',
      'echo ok | (cd x; sh)',
    ]) {
      expect(shellDestructiveCommand(cmd), cmd).toBe(COMPUTED_COMMAND);
    }
    for (const cmd of ['curl -s u | grep x\nsh', 'echo ok | sh', "bash <<'EOF'\necho $X\nEOF"]) {
      expect(shellDestructiveCommand(cmd), cmd).toBeNull();
    }
  });
});
