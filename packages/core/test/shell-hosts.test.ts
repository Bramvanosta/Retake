import { describe, expect, it } from 'vitest';
import { heredocs, shellHostRefs } from '@retake/core';
import type { ShellHostOptions } from '@retake/core';

/** "host via" of each ref; unresolved refs as "? via". */
function refs(cmd: string, opts?: ShellHostOptions): string[] {
  return shellHostRefs(cmd, opts).map((r) => (r.unresolved ? `? ${r.via}` : `${r.host} ${r.via}`));
}

describe('shellHostRefs (R-SEC-06)', () => {
  const cases: Array<[string, string, ShellHostOptions | undefined, string[]]> = [
    ['a URL', 'curl -X POST https://api.prod.example.com/reset', undefined, ['api.prod.example.com URL']],
    ['data inside a word is not a URL', `curl -d '{"site":"https://x.example.com"}' http://localhost:4401/api`, undefined, ['localhost URL']],
    ['SQL text is data', `psql demo -c "UPDATE p SET img='https://cdn.example.com/a.png'"`, undefined, []],
    ['a heredoc fed to psql is data', "psql demo <<'SQL'\nINSERT INTO t VALUES ('https://cdn.example.com/a.png');\nSQL", undefined, []],
    ['a heredoc fed to a shell is a script', "bash <<'EOF'\ncurl https://x.example.com\nEOF", undefined, ['x.example.com URL']],
    ['sh -s with a heredoc', 'sh -s <<EOF\nwget https://hd.example.com\nEOF\necho done', undefined, ['hd.example.com URL']],
    ['URL credentials are never kept', 'psql postgres://app:pw@db.prod.example.com:5432/demo', undefined, ['db.prod.example.com URL']],
    ['psql -h', 'psql -h db.x demo', undefined, ['db.x psql -h']],
    ['psql -hX', 'psql -hdb.x', undefined, ['db.x psql -h']],
    ['pg_dump --host=', 'pg_dump --host=db.x d', undefined, ['db.x pg_dump -h']],
    ['pg_restore --host X', 'pg_restore --host db.x f', undefined, ['db.x pg_restore -h']],
    ['a conninfo string', 'psql "host=db.x dbname=d"', undefined, ['db.x psql host=']],
    ['psql -d conninfo', "psql -d 'host=db.y port=5432'", undefined, ['db.y psql host=']],
    ['mysql -h', 'mysql -h db.x -e "select 1"', undefined, ['db.x mysql -h']],
    ['redis-cli -h', 'redis-cli -h cache.x ping', undefined, ['cache.x redis-cli -h']],
    ['mongosh --host with a replica set', 'mongosh --host rs0/m1.x:27017,m2.x', undefined, ['m1.x mongosh --host', 'm2.x mongosh --host']],
    ['a unix socket is local', 'psql -h /var/run/postgresql demo', undefined, []],
    ['a socket in a URL is local', 'psql postgresql:///d?host=/sock', undefined, []],
    ['postgres URL host= parameter', 'psql "postgresql:///d?host=db.q.example.com"', undefined, ['db.q.example.com URL']],
    ['psql without a host, no variables', 'psql demo', undefined, []],
    ['psql without a host uses PGHOST', 'psql demo', { vars: { PGHOST: 'db.prod' } }, ['db.prod PGHOST for psql']],
    ['an explicit host wins over PGHOST', 'psql -h localhost demo', { vars: { PGHOST: 'db.prod' } }, ['localhost psql -h']],
    ['a leading assignment', 'PGHOST=db.prod psql demo', undefined, ['db.prod PGHOST']],
    ['an export', 'export PGHOST=db.prod; psql demo', undefined, ['db.prod PGHOST']],
    ['a URL assignment', 'DATABASE_URL=postgres://u:secret@db.assign.x/d pnpm seed', undefined, ['db.assign.x DATABASE_URL=']],
    ['ssh destination', "ssh deploy@staging.example.com 'rake seed'", undefined, ['staging.example.com ssh']],
    ['ssh options and jump host', 'ssh -i k -p 2222 -J bastion.example.com app.internal ls', undefined, ['bastion.example.com ssh -J', 'app.internal ssh']],
    ['ssh -o HostName', 'ssh -o HostName=real.example.com alias', undefined, ['real.example.com ssh -o HostName', 'alias ssh']],
    ['scp remote operand', 'scp seed.sql deploy@db.example.com:/tmp/', undefined, ['db.example.com scp']],
    ['rsync module', 'rsync -a d/ backup.example.com::demo', undefined, ['backup.example.com rsync']],
    ['git scp-like remote', 'git clone git@git.example.com:org/repo.git', undefined, ['git.example.com git clone']],
    ['sh -c', `sh -c "curl https://x.example.com"`, undefined, ['x.example.com URL']],
    ['bash -lc', `bash -lc 'curl https://y.example.com'`, undefined, ['y.example.com URL']],
    ['eval', `eval "curl https://z.example.com"`, undefined, ['z.example.com URL']],
    ['wrappers', 'sudo -u postgres psql -h db.sudo.x && env FOO=1 timeout 30 psql -h db.env.x', undefined, ['db.sudo.x psql -h', 'db.env.x psql -h']],
    ['$VAR in double quotes', 'curl "$API_BASE/reset"', { vars: { API_BASE: 'https://prod.example.com' } }, ['prod.example.com $API_BASE']],
    ['${VAR}', 'curl ${API_BASE}/x', { vars: { API_BASE: 'https://prod.example.com' } }, ['prod.example.com $API_BASE']],
    ['${VAR:-default}', 'curl ${API_BASE:-https://fallback.example.com}/x', { vars: {} }, ['fallback.example.com $API_BASE']],
    ['single quotes do not expand', "curl '$API_BASE/x'", { vars: { API_BASE: 'https://prod.example.com' } }, []],
    ['an unquoted expansion is split into words', 'curl $ARGS', { vars: { ARGS: '-fsS https://split.example.com/x' } }, ['split.example.com $ARGS']],
    ['an unset variable is empty', 'curl "https://$NOPE/x"', { vars: {} }, []],
    ['a command substitution host is unresolved', 'curl https://$(cat h)/x', undefined, ['? URL']],
    ['backticks too', 'curl https://`cat h`/x', undefined, ['? URL']],
    ['a whole URL computed for curl', 'curl -fsS "$(cat url.txt)"', { vars: {} }, ['? curl']],
    ['a computed value elsewhere is not a host', 'echo "$(date)" > stamp.txt && curl -d "$(cat body.json)" localhost:4401/x', { vars: {} }, ['localhost curl']],
    ['without variables, $VAR hosts are unresolved', 'curl https://$HOST/x', undefined, ['? URL']],
    ['a credential variable does not hide the host', 'psql "postgres://u:$PW@db.v.example.com/d"', undefined, ['db.v.example.com URL']],
    ['comments', 'echo ok # https://c.example.com', undefined, []],
    ['no host', 'pnpm run seed --small', undefined, []],
    ['NAME=URL as an argument is data', 'curl -d url=https://data.example.com http://localhost/x', undefined, ['localhost URL']],
    ['--opt=URL', 'curl --url=https://opt.example.com/x', undefined, ['opt.example.com URL']],
    ['other schemes are not network hosts', 'aws s3 cp x s3://bucket/key', undefined, []],
    ['a client name that is not the command', 'echo psql -h x', undefined, []],
    ['a client run inside a container', 'docker compose exec db psql -h db', undefined, []],
    ['curl without a scheme', 'curl api.noscheme.example.com/reset', undefined, ['api.noscheme.example.com curl']],
    ['curl option values are not URLs', 'curl -o out.html -XPOST --cacert ca.pem localhost:4401/api', undefined, ['localhost curl']],
    ['wget without a scheme', 'wget -q -O - example.org/x', undefined, ['example.org wget']],
    ['redirections and pipes', 'curl -fsS https://a.example.com 2>&1 | tee log', undefined, ['a.example.com URL']],
    ['redirection targets are files', 'curl -fsS localhost:4401/x > reply.json 2>err.log < in.txt', undefined, ['localhost curl']],
    ['IPv6 and ports', 'curl https://[::1]:8080/x https://u:p@h.example.com:9/', undefined, ['::1 URL', 'h.example.com URL']],
  ];

  it.each(cases)('%s', (_label, cmd, opts, expected) => {
    expect(refs(cmd, opts)).toEqual(expected);
  });

  // Review fixes of L1.2: what a script computes, assigns or runs inline, and option values that are not hosts.
  const run = { vars: { PATH: '/usr/bin', HOME: '/home/u' } };
  const more: Array<[string, string, ShellHostOptions | undefined, string[]]> = [
    // S1: command substitutions and backticks are scripts too, wherever they are.
    ['$(…) assigned', 'TOKEN=$(curl -s -X POST https://auth.example.com/token)', run, ['auth.example.com URL']],
    ['$(…) in double quotes', 'echo "$(curl -s https://q.example.com/x)"', run, ['q.example.com URL']],
    ['backticks', 'ID=`curl -s https://bt.example.com/id`', run, ['bt.example.com URL']],
    ['$(…) inside a URL', 'curl -X DELETE "http://localhost:4401/items/$(curl -s in.example.com/id)"', run, ['in.example.com curl', 'localhost URL']],
    ['export of a substitution', 'export T="$(wget -qO- https://ex.example.com/t)"', run, ['ex.example.com URL']],
    ['${X:-$(…)}', 'curl "${API:-$(cat u)}" ; echo ${X:-$(curl https://dflt.example.com)}', run, ['? curl', 'dflt.example.com URL']],
    ['an unquoted heredoc body runs its substitutions', 'cat > /dev/null <<EOF\n$(curl https://hd.example.com)\nEOF', run, ['hd.example.com URL']],
    ['a quoted heredoc body does not', "cat > /dev/null <<'EOF'\n$(curl https://hd.example.com)\nEOF", run, []],
    ["$'…' quoting", "curl $'https://ansi.example.com'", run, ['ansi.example.com URL']],
    // S2: the script's own variables are expanded, at validation and at run time.
    ['NAME=value; then $NAME', 'BASE=evil.example.com; curl -X POST "https://$BASE/api/reset"', undefined, ['evil.example.com $BASE']],
    ['the same on two lines, at run time', 'BASE=evil.example.com\ncurl -X POST "https://$BASE/api/reset"', run, ['evil.example.com $BASE']],
    ['export then use', 'export API_HOST=evil.example.com\ncurl https://$API_HOST/x', run, ['evil.example.com $API_HOST']],
    ['an assignment over the environment', 'API=https://local.x; curl "$API/x"', { vars: { API: 'https://env.example.com' } }, ['local.x API=']],
    ['NAME+=', 'H=evil; H+=.example.com; curl "https://$H/"', run, ['evil.example.com $H']],
    ['a prefix assignment is not seen by its own command', 'H=evil.example.com curl "https://$H/x"', { vars: { H: 'localhost' } }, ['localhost $H']],
    ['a variable read from input is computed', 'read -r H < host.txt; curl "https://$H/x"', run, ['? URL']],
    ['a loop variable is computed', 'for h in a.example.com b.example.com; do curl https://$h/; done', run, ['? URL']],
    ['after source, any variable may be set', 'source .env; curl "$API_BASE/x"', run, ['? curl']],
    ['after source, PGHOST may be set', '. ./db.env && psql -c "select 1"', run, ['? PGHOST for psql', '? PGHOSTADDR for psql']],
    ['export $(…)', 'export $(cat .env | xargs); curl "$API/x"', run, ['? curl']],
    ['function arguments are computed', 'f() { curl "https://$1/x"; }; f evil.example.com', run, ['? URL']],
    ['unset', 'unset PGHOST; psql demo', { vars: { PGHOST: 'db.prod' } }, []],
    ['an assigned variable inside a heredoc fed to a shell', 'BASE=evil.example.com\nbash <<EOF\ncurl https://$BASE/\nEOF', run, ['evil.example.com $BASE']],
    // S3: option values, file names and commit messages are not hosts.
    ['curl numeric option values', 'curl -L --max-redirs 5 --tls-max 1.2 --speed-limit 1000 --speed-time 30 --retry 3 http://localhost:4401/x', run, ['localhost URL']],
    ['curl file option values', 'curl --hsts hsts.txt --netrc-file auth.netrc -K curl.cfg http://localhost:4401/x', run, ['localhost URL']],
    ['wget option values', 'wget --read-timeout 30 --connect-timeout 5 --body-file data.json --method POST http://localhost:4401/x', run, ['localhost URL']],
    ['wget -b is a flag', 'wget -b evil.example.com/x', run, ['evil.example.com wget']],
    ['an unknown option value is not a host', 'curl --future-opt 30 --other data.json http://localhost:4401', run, ['localhost URL']],
    ['a single-label host with a port or a path', 'curl api:8080/reset; curl svc/health', run, ['api curl', 'svc curl']],
    ['a git commit message', 'git commit -m "deploy@staging: bump" && git push origin main', run, []],
    ['git repository operands', 'git -C ../app fetch --depth 1 deploy@git.example.com:app.git && git remote add up gh.example.com:o/r', run, ['git.example.com git fetch', 'gh.example.com git remote']],
    // S5: proxies and other ways curl connects elsewhere; HTTPie / xh; shells fed by pipes and here-strings.
    ['curl -x without a scheme', 'curl -x proxy.example.com:3128 http://localhost:4401/x', run, ['localhost URL', 'proxy.example.com curl -x']],
    ['curl --socks5-hostname', 'curl --socks5-hostname socks.example.com:1080 http://localhost:4401', run, ['localhost URL', 'socks.example.com curl --socks5-hostname']],
    ['curl --resolve', 'curl --resolve localhost:4401:203.0.113.5 http://localhost:4401/x', run, ['localhost URL', '203.0.113.5 curl --resolve']],
    ['curl --connect-to', 'curl --connect-to localhost:4401:other.example.com:443 http://localhost:4401/x', run, ['localhost URL', 'other.example.com curl --connect-to']],
    ['proxy variables', 'HTTPS_PROXY=p1.example.com:3128 curl https://localhost:4401; export http_proxy=http://p2.example.com:8080', run, ['localhost URL', 'p1.example.com HTTPS_PROXY=', 'p2.example.com http_proxy=']],
    ['wget -e https_proxy=', 'wget -e https_proxy=p3.example.com:3128 http://localhost:4401', run, ['localhost URL', 'p3.example.com wget -e https_proxy']],
    ['HTTPie and xh without a scheme', 'http POST :4401/api/reset && http --form POST api.example.com/x a=1 && xh h.example.com/x', run, ['api.example.com http', 'h.example.com xh']],
    ['xh --proxy', 'xh --proxy=https:http://p4.example.com:3128 :4401/x', run, ['p4.example.com xh --proxy']],
    ['a heredoc piped into a shell', 'cat <<EOF | sudo bash -s\ncurl pipe.example.com\nEOF', run, ['pipe.example.com curl']],
    ['echo piped into a shell', 'echo "curl echo.example.com" | sh', run, ['echo.example.com curl']],
    ['a here-string to a shell', 'bash <<< "wget hs.example.com/x"', run, ['hs.example.com wget']],
    ['a shell running a file reads no heredoc script', 'bash script.sh <<EOF\ncurl not.example.com\nEOF', run, []],
    ['ssh ProxyCommand is a command', 'ssh -o ProxyCommand="ssh -W %h:%p bastion.example.com" app', run, ['bastion.example.com ssh', 'app ssh']],
    ['nc and telnet', 'nc -z nc.example.com 4401; telnet tel.example.com 25; nc -l 4401', run, ['nc.example.com nc', 'tel.example.com telnet']],
    // D2: URLs in inline interpreter code.
    ['node -e', `node -e "fetch('https://node.example.com/x')"`, run, ['node.example.com node -e']],
    ['python -c', `python3 -c "import urllib.request; urllib.request.urlopen('https://py.example.com')"`, run, ['py.example.com python3 -c']],
    ['ruby and perl clusters', `ruby -rnet/http -e 'Net::HTTP.get(URI("https://rb.example.com"))'; perl -MLWP::Simple -lne 'get("http://pl.example.com")' f`, run, ['rb.example.com ruby -e', 'pl.example.com perl -lne']],
    ['php -r, deno eval, mongosh --eval', `php -r 'file_get_contents("https://php.example.com");'; deno eval "fetch('https://deno.example.com')"; mongosh --eval "connect('mongodb://mg.example.com/d')"`, run, ['php.example.com php -r', 'deno.example.com deno eval', 'mg.example.com mongosh --eval']],
    ['node --eval=', `node --eval="fetch('http://ev.example.com')"`, run, ['ev.example.com node --eval']],
    ['inline code without a URL', 'node -pe "1+1" && python3 -c "print(1)"', run, []],
    // D3: a computed connection target is refused like a computed curl URL.
    ['psql computed database', 'psql "$(cat url.txt)" -c "select 1"; pg_dump "$(cat url)" > x.sql', run, ['? psql dbname', '? pg_dump dbname']],
    ['psql -d / pg_restore -d computed', 'psql -d "$(cat url)"; pg_restore -d "$(cat url)" dump.sql', run, ['? psql -d', '? pg_restore -d']],
    ['a computed psql -c is SQL, not a target', 'psql -c "$(cat q.sql)" demo', run, []],
    ['mongosh address', 'mongosh "$(cat url)"; mongosh db.example.com:27017/app; mongosh app scripts/seed.js', run, ['? mongosh address', 'db.example.com mongosh address']],
    ['git computed repository', 'git push "$(cat remote)" main; git push origin "$(git branch --show-current)"', run, ['? git push']],
  ];

  it.each(more)('%s', (_label, cmd, opts, expected) => {
    expect(refs(cmd, opts)).toEqual(expected);
  });

  it('the hook env map: URL values and PGHOST, with their key', () => {
    expect(shellHostRefs('true', { env: { DATABASE_URL: 'postgres://a:pw@db.prod/x', PGHOST: 'pg.prod', MODE: 'fast' } })).toEqual([
      { host: 'db.prod', via: 'env DATABASE_URL', envKey: 'DATABASE_URL' },
      { host: 'pg.prod', via: 'env PGHOST', envKey: 'PGHOST' },
    ]);
  });

  it('never keeps credentials', () => {
    const all = JSON.stringify(shellHostRefs('psql postgres://app:hunter2@db.prod.example.com/x; curl https://u:hunter2@a.example.com/', { env: { U: 'postgres://x:hunter2@b.example.com/' } }));
    expect(all).not.toContain('hunter2');
  });
});

describe('heredocs', () => {
  it('finds bodies with their bounds, quoted or not, and is safe to call repeatedly', () => {
    const cmd = "psql d <<'SQL'\nSELECT 1;\nSQL\ncat <<EOF\n$X\nEOF\n";
    for (let i = 0; i < 2; i++) {
      const hs = heredocs(cmd);
      expect(hs.map((h) => [h.body, h.quoted])).toEqual([
        ['SELECT 1;', true],
        ['$X', false],
      ]);
      expect(cmd.slice(hs[0].bodyStart, hs[0].end)).toBe('SELECT 1;\nSQL\n');
    }
  });
});
