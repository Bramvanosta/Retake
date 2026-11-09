// Import graph probe for the Retake monorepo (read-only).
// Usage: node scripts/audit/imports.mjs <repo-root> [--json out.json]
// Prints: package graph (declared deps vs actual imports), cycles, node: built-ins per package,
// I/O-free ("pure") modules per package, intra-package file cycles, external deps per file (playwright, remotion, sdk).
// The scan and the cycle search live in lib.mjs (shared with rules.mjs and the import-rules test).
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { cycles, fileCycles, ioKind, scan } from './lib.mjs';

const root = path.resolve(process.argv[2] ?? '.');
const BUILTINS = new Set(builtinModules);
const { pkgs, declared, files: all, fileImports } = scan(root);

const result = { packages: {}, files: {} };
for (const d of pkgs) {
  const files = all.filter((f) => f.pkg === d);
  const actual = new Map(); // pkg -> count
  const builtins = new Map();
  const externals = new Map();
  let lines = 0;
  const ioFiles = [];
  const pureFiles = [];
  for (const { rel, text, specs } of files) {
    lines += text.split('\n').length;
    const io = [];
    for (const s of specs) {
      if (s.startsWith('@retake/')) {
        const p = s.replace('@retake/', '').split('/')[0];
        actual.set(p, (actual.get(p) ?? 0) + 1);
      } else if (s.startsWith('node:') || BUILTINS.has(s.split('/')[0])) {
        const b = s.replace(/^node:/, '');
        builtins.set(b, (builtins.get(b) ?? 0) + 1);
      } else if (!s.startsWith('.')) {
        const e = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
        externals.set(e, (externals.get(e) ?? 0) + 1);
      }
      const k = ioKind(s, BUILTINS);
      if (k) io.push(k);
    }
    // global process / fetch usage counts as I/O-ish
    if (/\bprocess\.(env|cwd|platform|exit|argv|kill|pid|stdout|stderr)\b/.test(text)) io.push('process.*');
    if (/\bfetch\(/.test(text)) io.push('fetch');
    result.files[rel] = { lines: text.split('\n').length, io: [...new Set(io)] };
    (io.length ? ioFiles : pureFiles).push(rel);
  }
  result.packages[d] = {
    files: files.length,
    lines,
    declared: declared[d],
    actual: Object.fromEntries([...actual].sort()),
    undeclared: [...actual.keys()].filter((p) => p !== d && !declared[d].includes(p)),
    unused: declared[d].filter((p) => !actual.has(p)),
    builtins: Object.fromEntries([...builtins].sort((a, b) => b[1] - a[1])),
    builtinImportsTotal: [...builtins.values()].reduce((a, b) => a + b, 0),
    externals: Object.fromEntries([...externals].sort((a, b) => b[1] - a[1])),
    ioFiles: ioFiles.length,
    pureFiles: pureFiles.length,
  };
}

// package cycles (on actual)
const pg = Object.fromEntries(pkgs.map((d) => [d, Object.keys(result.packages[d].actual).filter((p) => p !== d)]));
result.packageCycles = cycles(pg);
// file-level cycles per package (relative imports)
result.fileCycles = fileCycles(fileImports);

// layering: topological level of each package
const level = {};
function lv(p, seen = new Set()) { if (p in level) return level[p]; if (seen.has(p)) return 0; seen.add(p); const ds = pg[p] ?? []; level[p] = ds.length ? 1 + Math.max(...ds.map((d) => lv(d, seen))) : 0; return level[p]; }
pkgs.forEach((p) => lv(p));
result.levels = level;

const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx > 0) fs.writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ ...result, fileImports }, null, 1));

// print
console.log('# Package graph (actual imports; count = import statements)');
for (const d of pkgs.sort((a, b) => level[a] - level[b])) {
  const r = result.packages[d];
  console.log(`L${level[d]} ${d.padEnd(11)} files=${r.files} lines=${r.lines} -> ${Object.entries(r.actual).filter(([p]) => p !== d).map(([p, n]) => `${p}(${n})`).join(' ')}`);
  if (r.undeclared.length) console.log(`   UNDECLARED: ${r.undeclared}`);
  if (r.unused.length) console.log(`   declared but unused: ${r.unused}`);
  console.log(`   node built-ins: total=${r.builtinImportsTotal} ${JSON.stringify(r.builtins)}`);
  console.log(`   externals: ${JSON.stringify(r.externals)}`);
  console.log(`   files with I/O: ${r.ioFiles} / pure: ${r.pureFiles}`);
}
console.log('\n# Package cycles:', JSON.stringify(result.packageCycles));
console.log('\n# File cycles (relative imports):', result.fileCycles.length);
for (const c of result.fileCycles) console.log('  ', c.length, c.slice(0, 8).join(' , '), c.length > 8 ? '…' : '');
