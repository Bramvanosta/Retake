#!/usr/bin/env node
// Test-migration guard (L5.10): when a screen is rebuilt and its e2e tests are migrated, a test must not get weaker
// without a reason. For every changed test file it compares a git ref (default HEAD) with the working tree, per test
// title: a title that disappeared, fewer `expect(` / `expect.poll(` calls, a `getByTestId(...)` / `data-testid="…"` no
// longer used. Renames and dropped checks are then explained in the lot's notes, or the test is fixed.
// Usage: node scripts/test-guard.mjs [--base <ref>] [<path> …]   (paths default to every packages/*/test folder)
// Exit 1 when something decreased; new files and added tests are listed, never counted against.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Per test title: the number of expect calls and the test ids its body uses. */
export function parseTests(text) {
  const out = new Map();
  const re = /\bit(?:\.skipIf\([^)]*\)|\.only|\.skip)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  const marks = [...text.matchAll(re)].map((m) => ({ title: m[2], at: m.index }));
  marks.forEach((m, i) => {
    const body = text.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : text.length);
    const expects = (body.match(/\bexpect(?:\.poll)?\(/g) ?? []).length;
    const ids = new Set(
      [...body.matchAll(/getByTestId\(\s*['"`]([^'"`]+)['"`]/g), ...body.matchAll(/data-testid="([^"]+)"/g)].map((x) => x[1]),
    );
    out.set(m.title, { expects, ids });
  });
  return out;
}

/** What got weaker from `before` to `after` (two parseTests results), one line per finding. */
export function compareTests(before, after) {
  const lines = [];
  for (const [title, was] of before) {
    const now = after.get(title);
    if (!now) {
      lines.push(`missing title: ${title}`);
      continue;
    }
    if (now.expects < was.expects) lines.push(`fewer expects (${was.expects} → ${now.expects}): ${title}`);
    const lost = [...was.ids].filter((id) => !now.ids.has(id));
    if (lost.length) lines.push(`lost test ids [${lost.join(', ')}]: ${title}`);
  }
  return lines;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const args = process.argv.slice(2);
  const b = args.indexOf('--base');
  const base = b >= 0 ? args[b + 1] : 'HEAD';
  const paths = args.filter((a, i) => a !== '--base' && i !== b + 1);
  const scope = paths.length ? paths : ['packages'];
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const files = git('diff', '--name-only', base, '--', ...scope)
    .split('\n')
    .filter((f) => /\/test\/.+\.(test\.ts|ts|mjs)$/.test(f));
  let problems = 0;
  for (const f of files) {
    let head;
    try {
      head = git('show', `${base}:${f}`);
    } catch {
      console.log(`${f}: new file`);
      continue;
    }
    const now = existsSync(`${root}${f}`) ? readFileSync(`${root}${f}`, 'utf8') : '';
    const before = parseTests(head);
    const after = parseTests(now);
    if (before.size === 0 && after.size === 0) continue;
    const lines = compareTests(before, after);
    const sum = (m) => [...m.values()].reduce((n, v) => n + v.expects, 0);
    const added = [...after.keys()].filter((t) => !before.has(t)).length;
    console.log(`${f}: ${before.size} → ${after.size} tests, expects ${sum(before)} → ${sum(after)}${added ? `, ${added} added` : ''}`);
    for (const l of lines) console.log(`  ${l}`);
    problems += lines.length;
  }
  console.log(problems ? `${problems} item(s) to explain` : 'no decrease');
  process.exitCode = problems ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
