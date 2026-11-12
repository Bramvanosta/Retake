// Dependency-rule probe (read-only unless --write-baseline): the import rules of the target architecture, checked
// against today's code. The rules, the scan and the ratchet live in lib.mjs; packages/core/test/import-rules.test.ts
// holds the code to the baseline (scripts/audit/baseline.json: today's violations, each group with a reason, never more).
// Usage: node scripts/audit/rules.mjs [<repo-root>] [--imports <imports.json>] [--json <out.json>] [--list]
//        node scripts/audit/rules.mjs <repo-root> --check            the ratchet: exit 1 on a new or stale entry
//        node scripts/audit/rules.mjs <repo-root> --write-baseline   rewrite the baseline for today (reasons kept)
//        (imports.json comes from `imports.mjs --json`; without --imports the sources are scanned here)
import fs from 'node:fs';
import path from 'node:path';
import { BASELINE, RULES, compareBaseline, ratchetEntries, ratchetReport, readBaseline, rewriteBaseline, ruleHits, scan } from './lib.mjs';

// The repository root is the first argument unless it is an option (`rules.mjs --check` checks the current folder).
const root = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.');
const opt = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const LIST = process.argv.includes('--list');

if (process.argv.includes('--write-baseline') || process.argv.includes('--check')) {
  const entries = ratchetEntries(root);
  const old = readBaseline(root);
  if (process.argv.includes('--write-baseline')) {
    const next = rewriteBaseline(entries, old);
    fs.writeFileSync(path.join(root, BASELINE), JSON.stringify(next, null, 1) + '\n');
    const cmp = compareBaseline(entries, old);
    console.log(`${BASELINE}: ${entries.length} entries in ${next.groups.length} groups (${cmp.added.length} added, ${cmp.stale.length} removed)`);
    const todo = next.groups.filter((g) => !String(g.reason).trim());
    if (todo.length) console.log(`write a one-line reason for ${todo.length} new group(s): ${todo.map((g) => g.rule).join(', ')}`);
  } else {
    const report = ratchetReport(compareBaseline(entries, old));
    console.log(report || `${BASELINE} holds: ${entries.length} entries`);
    if (report) process.exitCode = 1;
  }
} else {
  const jf = opt('--imports');
  const fileImports = jf ? JSON.parse(fs.readFileSync(jf, 'utf8')).fileImports : scan(root).fileImports;
  const all = ruleHits(root, fileImports);
  const totals = [];
  for (const r of RULES) {
    const hits = all.filter((h) => h.rule === r.id).map((h) => `${h.file} → ${h.spec}`);
    const files = new Set(hits.map((h) => h.split(' → ')[0]));
    const id = `${r.id} ${r.title}`;
    totals.push({ rule: id, violations: hits.length, files: files.size });
    console.log(`${id}: ${hits.length} imports in ${files.size} files`);
    if (LIST) for (const h of hits) console.log('   ', h);
  }
  const out = opt('--json');
  if (out) fs.writeFileSync(out, JSON.stringify(totals, null, 1) + '\n');
}
