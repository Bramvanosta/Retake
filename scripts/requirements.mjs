#!/usr/bin/env node
// Regenerates docs/REQUIREMENTS.md from docs/requirements.json (the source of truth) and prints a summary.
// Usage: node scripts/requirements.mjs                  → rewrite the Markdown + summary
//        node scripts/requirements.mjs --lot L2.3       → list the requirements of one lot
//        node scripts/requirements.mjs --untested [1]   → list the items no test exercises (of one phase), exit 1 if any
//        node scripts/requirements.mjs --check-cites [file] → list the quoted test titles no test file has, exit 1 if any
// A rewrite also checks the quoted test titles and exits 1 when one is stale.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lotArg = process.argv.indexOf('--lot');
const untestedArg = process.argv.indexOf('--untested');
const citesArg = process.argv.indexOf('--check-cites');
const citesFile = citesArg > 0 && process.argv[citesArg + 1] && !process.argv[citesArg + 1].startsWith('--') ? process.argv[citesArg + 1] : undefined;
const data = JSON.parse(readFileSync(citesFile ?? `${root}docs/requirements.json`, 'utf8'));
const items = data.items;

/**
 * Quoted test titles: `'packages/<pkg>/test/<file>.test.ts > <describe> > … > <it>'` in an evidence or a gap. Each
 * title must start a string literal of that file (an apostrophe escaped in the source counts as one; a title may be
 * shortened, and one elided with "…" counts up to its first "…"). Other ways of naming a test are not checked.
 *
 * A title may hold apostrophes ("the jobs' protection", "keeps the 'port busy' answer"), so where a quote ends is
 * read with the source (citesOf). An apostrophe that a separator follows (`,` `.` `;` `:` `)`, a space, the end) is a
 * possible end, from the first one to the first that plainly closes the quote (punctuation, the end, a space then a
 * quote, "(", a dash or "and '"), the end after an elided title's "…", or the next cite. The longest whose titles the
 * file has is the cite — unless it stops at an apostrophe a word follows and the plain end comes later with no quote
 * opened in between: then the longer one is, and it is broken (said "possibly reads past the quote": prose after a
 * good cite that holds a possessive reads the same). When none is found, the cite is reported up to its plain end,
 * else its first end.
 *
 * Known limits: (1) the possessive after a cite (`'… > a title' holds the reviewers' notes.`) is reported as above —
 * reword the prose; (2) a wrong tail that holds a quoted word (`… the files' wrong, a 'quoted' word'`) is checked only
 * up to the apostrophe before it, the quote that opens in between stopping the read; (3) an apostrophe a space and "("
 * follow (`… signed files' (review B M3)'`) plainly closes the quote: such a title is checked up to it.
 */
const CITE_START = /'((?:packages|scripts|fixtures)\/[^' ]+\.test\.tsx?) > /g;
/** Positions (in `s`, from `from` to `to`) of the apostrophes that may end a quote: a separator or the end follows. */
function endsOf(s, from, to) {
  const out = [];
  for (let k = from; k < to; k++) {
    if (s[k] === '\\') {
      k++;
      continue;
    }
    if (s[k] === "'" && (k + 1 === s.length || /[,.;:)\s]/.test(s[k + 1]))) out.push(k);
  }
  return out;
}
/** An end that plainly closes a quote: punctuation or the end follows, or a space then a quote, "(", "—" or "and '"/"or '". */
function plainEnd(s, k) {
  const rest = s.slice(k + 1);
  return rest === '' || /^[,.;:)]/.test(rest) || /^\s+(?:['(—–]|(?:and|or) ')/.test(rest);
}
/** Whether a quote opens between `from` and `to`: an apostrophe after a space or "(" and before a non-space. */
function opensBetween(s, from, to) {
  return /(?:^|[\s(])'\S/.test(s.slice(from, to));
}
/** The titles of one cite (`path` split on " > ") all found in `src`. */
function citeFound(src, path) {
  return path.split(' > ').every((title) => {
    const head = title.includes('…') ? title.slice(0, title.indexOf('…')).trimEnd() : title;
    return [`'`, '"', '`'].some((q) => src.includes(q + head));
  });
}
/**
 * Every cite of a text: { file, path, past? } — path the titles of the cite, " > " between them, as written; `past`
 * when it was read on past an apostrophe its file has a title up to (it may have read past the quote).
 */
function citesOf(s, sourceOf) {
  const starts = [...s.matchAll(CITE_START)];
  const out = [];
  starts.forEach((m, n) => {
    const from = m.index + m[0].length;
    const to = n + 1 < starts.length ? starts[n + 1].index : s.length;
    const all = endsOf(s, from, to);
    if (!all.length) return;
    // The quote goes on past an apostrophe a word follows ("the files' names"), up to the first end that plainly
    // closes it ("…', 'another title'" is two quotes) — or, for an elided title, the first end after its "…".
    const last = all.findIndex((e) => plainEnd(s, e) || s.slice(from, e).includes('…'));
    const ends = last < 0 ? all : all.slice(0, last + 1);
    const pathAt = (k) => s.slice(from, k);
    const src = sourceOf(m[1]);
    const plain = ends.find((e) => plainEnd(s, e));
    let k = (src === undefined ? undefined : [...ends].reverse().find((e) => citeFound(src, pathAt(e)))) ?? plain ?? ends[0];
    // Found only up to an apostrophe a word follows ("the jobs' …") while the quote plainly closes later with no quote
    // opened in between: the words up to it began some other title — the cite is the longer one, and it is broken.
    // Ambiguous: prose after a well-cited title that holds a possessive reads the same (`…' covers the reviewers'.`).
    const past = plain !== undefined && plain > k && !plainEnd(s, k) && !opensBetween(s, k + 1, plain);
    if (past) k = plain;
    out.push({ file: m[1], path: pathAt(k), ...(past ? { past: true } : {}) });
  });
  return out;
}
function staleCites(xs) {
  const sources = new Map();
  const sourceOf = (file) => {
    if (!existsSync(`${root}${file}`)) return undefined;
    if (!sources.has(file)) sources.set(file, readFileSync(`${root}${file}`, 'utf8').replace(/\\(['"`\\])/g, '$1'));
    return sources.get(file);
  };
  const out = [];
  for (const i of xs) {
    for (const field of ['evidence', 'gap']) {
      for (const { file, path, past } of citesOf(i[field] ?? '', sourceOf)) {
        const src = sourceOf(file);
        if (src === undefined) {
          out.push(`${i.id} (${field}): ${file} does not exist`);
          continue;
        }
        for (const title of path.split(' > ')) {
          if (!citeFound(src, title)) out.push(`${i.id} (${field}): ${file} has no test titled '${title}'${past ? ' (possibly reads past the quote; reword the prose after it)' : ''}`);
        }
      }
    }
  }
  return out;
}

if (citesArg > 0) {
  const stale = staleCites(items);
  for (const s of stale) console.log(s);
  process.exit(stale.length ? 1 : 0);
}

/**
 * "Never exercised": an item whose gap says that no test exercises it (whatever its status). Gaps are written by hand,
 * so this goes by their wording; a gap that names a test that cannot run here says so in other words.
 */
const UNTESTED = /never exercised|not exercised|untested|no (automated )?tests? (exercises|runs|covers)/i;
const untested = (xs) => xs.filter((i) => UNTESTED.test(i.gap ?? ''));

if (untestedArg > 0) {
  const phase = process.argv[untestedArg + 1]?.startsWith('--') ? undefined : process.argv[untestedArg + 1];
  const xs = untested(phase ? items.filter((i) => i.phase === phase) : items);
  for (const i of xs) console.log(`${i.id} [${i.status}] phase ${i.phase}, ${i.lot}: ${i.gap}`);
  process.exit(xs.length ? 1 : 0);
}

if (lotArg > 0) {
  const lot = process.argv[lotArg + 1];
  for (const i of items.filter((x) => x.lot === lot)) {
    console.log(`${i.id} [${i.status}] ${i.requirement}${i.gap ? `\n    gap: ${i.gap}` : ''}`);
  }
  process.exit(0);
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const phases = [...new Set(items.map((i) => i.phase))].sort((a, b) => (a === 'V2') - (b === 'V2') || a.localeCompare(b));
const count = (xs, st) => xs.filter((i) => i.status === st).length;

let md = `# Requirements traceability\n\nGenerated by \`node scripts/requirements.mjs\` from \`docs/requirements.json\` — edit the JSON (status, evidence, gap, lot), never this file.\nStatuses: **done** (implemented and exercised by a test or a verified run), **partial**, **todo**, **n/a-here** (cannot be verified in the Linux cloud container, e.g. macOS-only).\nLots are described in \`docs/ROADMAP.md\`.\n\n## Summary\n\n| Phase | Total | done | partial | todo | n/a-here |\n|---|---|---|---|---|---|\n`;
for (const p of phases) {
  const xs = items.filter((i) => i.phase === p);
  md += `| ${p} | ${xs.length} | ${count(xs, 'done')} | ${count(xs, 'partial')} | ${count(xs, 'todo')} | ${count(xs, 'n/a-here')} |\n`;
}
md += `| **all** | ${items.length} | ${count(items, 'done')} | ${count(items, 'partial')} | ${count(items, 'todo')} | ${count(items, 'n/a-here')} |\n`;

const never = untested(items);
md += `\n## Never exercised\n\nItems whose gap says no test exercises them, whatever their status (\`node scripts/requirements.mjs --untested [phase]\` lists them and exits 1 while there is one).\n\n`;
md += never.length
  ? `| ID | Phase | Lot | Status | Gap |\n|---|---|---|---|---|\n${never.map((i) => `| ${i.id} | ${i.phase} | ${i.lot} | ${i.status} | ${esc(i.gap)} |`).join('\n')}\n`
  : 'None.\n';

for (const p of phases) {
  md += `\n## Phase ${p}\n\n| ID | Requirement | Status | Lot | Evidence / gap |\n|---|---|---|---|---|\n`;
  for (const i of items.filter((x) => x.phase === p)) {
    const note = i.status === 'done' ? i.evidence : [i.gap, i.evidence && `(${i.evidence})`].filter(Boolean).join(' ');
    md += `| ${i.id} | ${esc(i.requirement)} <br><sub>${esc(i.source)}</sub> | ${i.status} | ${i.lot} | ${esc(note)} |\n`;
  }
}
writeFileSync(`${root}docs/REQUIREMENTS.md`, md);

const byLot = {};
for (const i of items) (byLot[i.lot] ??= []).push(i);
console.log(`${items.length} requirements · done ${count(items, 'done')} · partial ${count(items, 'partial')} · todo ${count(items, 'todo')} · n/a-here ${count(items, 'n/a-here')} · never exercised ${never.length}`);
for (const [lot, xs] of Object.entries(byLot).sort()) {
  if (lot === 'P1') continue;
  console.log(`  ${lot.padEnd(5)} ${String(xs.length).padStart(3)} open: ${xs.filter((i) => i.status !== 'done').length}`);
}
const stale = staleCites(items);
if (stale.length) {
  console.log(`${stale.length} quoted test title(s) no test file has:\n${stale.map((s) => `  ${s}`).join('\n')}`);
  process.exitCode = 1;
}
