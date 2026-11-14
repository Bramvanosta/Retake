#!/usr/bin/env node
// The lint ratchet: Biome's linter (biome.json: the recommended rules, some turned off) over the code, held to
// scripts/lint-baseline.json — the violations the code had when the linter came in, counted per rule and file. A new
// violation fails, and so does a count that went down until the baseline is lowered: the baseline only ever shrinks.
// Every rule biome.json turns off has a one-line reason in the baseline's `off` table.
// Usage: node scripts/lint.mjs                    the check (pnpm lint): exit 1 on a new, raised or stale count
//        node scripts/lint.mjs --list             also print every diagnostic the baseline allows
//        node scripts/lint.mjs --write-baseline   rewrite the counts for today (the `off` reasons are kept)
// The formatter is separate: pnpm format (writes) and pnpm format:check.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = 'scripts/lint-baseline.json';

/** Biome's JSON report of the linter over biome.json's files (the formatter's opinion left out). */
export function biomeReport(root = ROOT) {
  const bin = createRequire(path.join(root, 'package.json')).resolve('@biomejs/biome/bin/biome');
  let out;
  try {
    out = execFileSync(process.execPath, [bin, 'lint', '--reporter=json', '--max-diagnostics=none'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // Biome exits 1 when it reports an error-level diagnostic: the report is still on stdout.
    out = e.stdout;
    if (!out) throw new Error(`biome lint did not run: ${String(e.stderr || e.message).trim()}`);
  }
  return JSON.parse(out);
}

/** The report's diagnostics as `rule → file → [lines]`; anything that is not a lint rule (a configuration problem) apart. */
export function countDiagnostics(report) {
  const counts = {};
  const other = [];
  for (const d of report.diagnostics ?? []) {
    const file = d.location?.path;
    if (!String(d.category).startsWith('lint/') || !file) {
      other.push(`${d.category}: ${d.message}${file ? ` (${file})` : ''}`);
      continue;
    }
    ((counts[d.category] ??= {})[file] ??= []).push(d.location.start?.line ?? 0);
  }
  return { counts, other };
}

/** Today's counts against the baseline's: `added` (new or raised), `stale` (lowered or gone). */
export function compareCounts(counts, baseline) {
  const added = [];
  const stale = [];
  const allowed = baseline.rules ?? {};
  for (const [rule, files] of Object.entries(counts))
    for (const [file, lines] of Object.entries(files)) {
      const was = allowed[rule]?.[file] ?? 0;
      if (lines.length > was) added.push(`${rule} ${file}: ${was} → ${lines.length} (line${lines.length > 1 ? 's' : ''} ${lines.join(', ')})`);
    }
  for (const [rule, files] of Object.entries(allowed))
    for (const [file, was] of Object.entries(files)) {
      const now = counts[rule]?.[file]?.length ?? 0;
      if (now < was) stale.push(`${rule} ${file}: ${was} → ${now}`);
    }
  return { added, stale };
}

/** The rules biome.json turns off that the baseline gives no reason for. */
export function unexplainedOff(config, baseline) {
  const off = [];
  for (const [group, rules] of Object.entries(config.linter?.rules ?? {}))
    if (rules && typeof rules === 'object')
      for (const [name, level] of Object.entries(rules))
        if ((level === 'off' || level?.level === 'off') && !String(baseline.off?.[`lint/${group}/${name}`] ?? '').trim()) off.push(`lint/${group}/${name}`);
  return off;
}

function sorted(counts) {
  const out = {};
  for (const rule of Object.keys(counts).sort()) {
    out[rule] = {};
    for (const file of Object.keys(counts[rule]).sort()) out[rule][file] = counts[rule][file].length;
  }
  return out;
}

function main() {
  const file = path.join(ROOT, BASELINE);
  const baseline = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { rules: {}, off: {} };
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'biome.json'), 'utf8'));
  const { counts, other } = countDiagnostics(biomeReport());
  const total = Object.values(counts).reduce((n, f) => n + Object.values(f).reduce((m, l) => m + l.length, 0), 0);
  if (process.argv.includes('--write-baseline')) {
    const cmp = compareCounts(counts, baseline);
    const biome = JSON.parse(fs.readFileSync(createRequire(path.join(ROOT, 'package.json')).resolve('@biomejs/biome/package.json'), 'utf8')).version;
    const next = { about: baseline.about, biome, off: baseline.off ?? {}, rules: sorted(counts) };
    fs.writeFileSync(file, `${JSON.stringify(next, null, 1)}\n`);
    console.log(`${BASELINE}: ${total} diagnostics in ${Object.keys(counts).length} rules (${cmp.added.length} counts added or raised, ${cmp.stale.length} lowered)`);
    if (cmp.added.length) console.log(`raised (review them in the diff):\n${cmp.added.map((x) => `  ${x}`).join('\n')}`);
    return;
  }
  const { added, stale } = compareCounts(counts, baseline);
  const off = unexplainedOff(config, baseline);
  const parts = [];
  const list = (title, xs) => xs.length && parts.push(`${title} (${xs.length}):\n${xs.map((x) => `  ${x}`).join('\n')}`);
  list('Not a lint rule (fix biome.json or the file)', other);
  list('New lint violations (fix them: npx biome lint <file> explains each)', added);
  list('Lowered counts (the violation is gone: lower the baseline with node scripts/lint.mjs --write-baseline)', stale);
  list(`Rules turned off in biome.json without a reason in ${BASELINE} \`off\``, off);
  if (process.argv.includes('--list')) for (const [rule, files] of Object.entries(counts)) for (const [f, lines] of Object.entries(files)) console.log(`${rule} ${f}: ${lines.join(', ')}`);
  if (parts.length) {
    console.log(parts.join('\n'));
    process.exitCode = 1;
  } else console.log(`${BASELINE} holds: ${total} diagnostics allowed, none new`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
