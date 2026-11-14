#!/usr/bin/env node
// Test-migration guard (L5.10): when a screen is rebuilt and its e2e tests are migrated, a test must not get weaker
// without a reason. For every changed test file it compares a git ref (default HEAD) with the working tree, per test
// title: a title that disappeared, fewer `expect(` / `expect.poll(` / `expect.soft(` calls, a `getByTestId(...)` /
// `data-testid="…"` no longer used, a matcher traded for a weaker one (`toEqual(x)` → `toBeDefined()` or
// `toBeGreaterThan(0)`, `toThrow(/x/)` → `toThrow()`, `toHaveBeenCalledWith(x)` → `toHaveBeenCalled()`: the count of
// expects stays, what they hold does not; exact > partial > weak, WEAK_MATCHERS and PARTIAL_MATCHERS). Titles are read from `it(…)`, `it.skipIf(…)(…)`, `it.runIf(…)(…)`,
// `it.only` / `it.skip`, and `it.each(…)(…)` / `it.for(…)(…)` (the title template). Renames and dropped checks are
// then explained in the lot's notes, or the test is fixed.
// Usage: node scripts/test-guard.mjs [--base <ref>] [<path> …]   (paths default to every packages/*/test folder)
// Exit 1 when something decreased; new files and added tests are listed, never counted against.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Matchers that hold less than the value itself: trading another matcher for one of these weakens a test. */
export const WEAK_MATCHERS = new Set([
  'toBeDefined',
  'toBeTruthy',
  'toBeFalsy',
  'toBeTypeOf',
  'toBeInstanceOf',
  'not.toBeNull',
  'not.toBeUndefined',
  'not.toThrow',
  'toHaveBeenCalled',
  // A matcher that holds a value when given one, and almost nothing called bare.
  'toThrow()',
  'toThrowError()',
  'toHaveBeenCalledWith()',
]);
/** Matchers whose bare call (no argument) holds less than the same call given a value. */
const BARE_MATTERS = new Set(['toThrow', 'toThrowError', 'toHaveBeenCalledWith']);
/** Matchers that hold part of a value (a bound, a member, a pattern): weaker than an exact one, stronger than a weak one. */
export const PARTIAL_MATCHERS = new Set([
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeCloseTo',
  'toContain',
  'toContainEqual',
  'toMatch',
  'toMatchObject',
  'toHaveProperty',
  'toThrow',
  'toThrowError',
]);

/** The index just past a string or template literal that starts at `i` (a template's `${…}` is skipped as code). */
function skipString(text, i) {
  const q = text[i];
  let j = i + 1;
  while (j < text.length && text[j] !== q) {
    if (text[j] === '\\') j += 2;
    else if (q === '`' && text[j] === '$' && text[j + 1] === '{') j = skipBalanced(text, j + 1, '{', '}');
    else j++;
  }
  return j + 1;
}

/** The index just past the bracket that closes the one at `i` (strings and comments skipped). */
function skipBalanced(text, i, open = '(', close = ')') {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j];
    if (c === "'" || c === '"' || c === '`') {
      j = skipString(text, j);
      continue;
    }
    if (c === '/' && text[j + 1] === '/') {
      const nl = text.indexOf('\n', j);
      j = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === '/' && text[j + 1] === '*') {
      const end = text.indexOf('*/', j + 2);
      j = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
    j++;
  }
  return text.length;
}

const skipSpace = (text, i) => {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
};

/** The test declarations of a file: each `it` call's title (by its value) and where it starts. */
function testMarks(text) {
  const marks = [];
  for (const m of text.matchAll(/(?<![\w$.])it(?=\s*[.(])/g)) {
    let i = m.index + 2;
    let ok = true;
    // The chain of modifiers: .only / .skip / .todo / .fails, .skipIf(…) / .runIf(…) / .each(…) / .for(…).
    for (;;) {
      i = skipSpace(text, i);
      if (text[i] !== '.') break;
      const word = /^\.\s*([A-Za-z]+)/.exec(text.slice(i, i + 40));
      if (!word) {
        ok = false;
        break;
      }
      i += word[0].length;
      if (['only', 'skip', 'todo', 'fails', 'sequential', 'concurrent'].includes(word[1])) continue;
      if (['skipIf', 'runIf', 'each', 'for'].includes(word[1])) {
        i = skipSpace(text, i);
        if (text[i] !== '(') {
          ok = false;
          break;
        }
        i = skipBalanced(text, i);
        continue;
      }
      ok = false;
      break;
    }
    if (!ok) continue;
    i = skipSpace(text, i);
    if (text[i] !== '(') continue;
    i = skipSpace(text, i + 1);
    const q = text[i];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    const end = skipString(text, i);
    marks.push({ title: text.slice(i + 1, end - 1).replace(/\\(['"`\\])/g, '$1'), at: m.index });
  }
  return marks;
}

/**
 * Per test title: the number of expect calls, the matchers they end in and the test ids its body uses. A title is read
 * by its value (an escaped quote and the same quote unescaped are one title: a formatter may change the quotes) and
 * `expect` may be followed by `.poll` / `.soft` on the next line (how a formatter breaks a long chain).
 */
export function parseTests(text) {
  const out = new Map();
  const marks = testMarks(text);
  marks.forEach((m, i) => {
    const body = text.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : text.length);
    const expects = (body.match(/\bexpect(?:\s*\.(?:poll|soft))?\(/g) ?? []).length;
    // A matcher called with nothing (`toThrow()`) is told apart from the same one given a value (`toThrow(/boom/)`).
    const matchers = [...body.matchAll(/\.\s*(not\s*\.\s*)?(?:(?:resolves|rejects)\s*\.\s*)?(to[A-Z]\w*)\((\s*\))?/g)].map(
      (x) => `${x[1] ? 'not.' : ''}${x[2]}${x[3] && BARE_MATTERS.has(x[2]) ? '()' : ''}`,
    );
    const ids = new Set([...body.matchAll(/getByTestId\(\s*['"`]([^'"`]+)['"`]/g), ...body.matchAll(/data-testid="([^"]+)"/g)].map((x) => x[1]));
    out.set(m.title, { expects, matchers, ids });
  });
  return out;
}

/** How many of `matchers` are weak (WEAK_MATCHERS), partial (PARTIAL_MATCHERS) and exact (every other one). */
function strength(matchers = []) {
  const weak = matchers.filter((m) => WEAK_MATCHERS.has(m)).length;
  const partial = matchers.filter((m) => !WEAK_MATCHERS.has(m) && PARTIAL_MATCHERS.has(m.replace(/\(\)$/, ''))).length;
  return { weak, partial, exact: matchers.length - weak - partial };
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
    const [a, b] = [strength(was.matchers), strength(now.matchers)];
    // A stronger class lost what a weaker one gained: exact → partial or weak, partial → weak.
    if ((b.exact < a.exact && b.partial + b.weak > a.partial + a.weak) || (b.exact + b.partial < a.exact + a.partial && b.weak > a.weak)) {
      lines.push(`weaker matchers (exact ${a.exact} → ${b.exact}, partial ${a.partial} → ${b.partial}, weak ${a.weak} → ${b.weak}): ${title}`);
    }
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
