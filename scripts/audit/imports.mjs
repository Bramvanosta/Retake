// Import graph probe for the Retake monorepo (read-only).
// Usage: node scripts/audit/imports.mjs <repo-root> [--json out.json]
// Prints: package graph (declared deps vs actual imports), cycles, node: built-ins per package,
// I/O-free ("pure") modules per package, intra-package file cycles, external deps per file (playwright, remotion, sdk).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2] ?? '.');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');

const BUILTINS = new Set(require('node:module').builtinModules);
const IO_BUILTINS = new Set(['fs', 'fs/promises', 'child_process', 'net', 'http', 'https', 'http2', 'dgram', 'tls', 'worker_threads', 'cluster', 'os', 'process', 'readline', 'dns', 'inspector', 'v8', 'vm', 'sqlite']);
const IO_PACKAGES = /^(playwright|playwright-core|pg|sharp|@remotion\/(renderer|bundler)|esbuild|@modelcontextprotocol|pdfjs-dist)/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, out); }
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const pkgsDir = path.join(root, 'packages');
const pkgs = fs.readdirSync(pkgsDir).filter((d) => fs.existsSync(path.join(pkgsDir, d, 'package.json')));
const nameToDir = {};
const declared = {};
for (const d of pkgs) {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgsDir, d, 'package.json'), 'utf8'));
  nameToDir[pj.name] = d;
  declared[d] = Object.keys({ ...pj.dependencies }).filter((n) => n.startsWith('@retake/')).map((n) => n.replace('@retake/', ''));
}

const result = { packages: {}, files: {} };
const fileImports = {}; // file -> [{spec, kind}]
for (const d of pkgs) {
  const files = walk(path.join(pkgsDir, d, 'src'));
  const actual = new Map(); // pkg -> count
  const builtins = new Map();
  const externals = new Map();
  let lines = 0;
  const ioFiles = [];
  const pureFiles = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    lines += text.split('\n').length;
    const pre = ts.preProcessFile(text, true, true);
    const specs = pre.importedFiles.map((x) => x.fileName);
    // also catch `import type` (preProcessFile includes them) and dynamic import(); fine.
    const rel = path.relative(root, f);
    fileImports[rel] = specs;
    let io = [];
    for (const s of specs) {
      if (s.startsWith('@retake/')) {
        const p = s.replace('@retake/', '').split('/')[0];
        actual.set(p, (actual.get(p) ?? 0) + 1);
      } else if (s.startsWith('node:') || BUILTINS.has(s.split('/')[0])) {
        const b = s.replace(/^node:/, '');
        builtins.set(b, (builtins.get(b) ?? 0) + 1);
        if (IO_BUILTINS.has(b)) io.push(b);
      } else if (!s.startsWith('.')) {
        const e = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
        externals.set(e, (externals.get(e) ?? 0) + 1);
        if (IO_PACKAGES.test(s)) io.push(e);
      }
    }
    // global process / fetch usage counts as I/O-ish
    const usesProcess = /\bprocess\.(env|cwd|platform|exit|argv|kill|pid|stdout|stderr)\b/.test(text);
    const usesFetch = /\bfetch\(/.test(text);
    if (usesProcess) io.push('process.*');
    if (usesFetch) io.push('fetch');
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
function cycles(graph) {
  const out = [];
  const nodes = Object.keys(graph);
  const idx = {}; const low = {}; const on = new Set(); const st = []; let i = 0;
  function sc(v) {
    idx[v] = low[v] = i++; st.push(v); on.add(v);
    for (const w of graph[v] ?? []) {
      if (!(w in idx)) { sc(w); low[v] = Math.min(low[v], low[w]); }
      else if (on.has(w)) low[v] = Math.min(low[v], idx[w]);
    }
    if (low[v] === idx[v]) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) out.push(c); }
  }
  for (const v of nodes) if (!(v in idx)) sc(v);
  return out;
}
const pg = Object.fromEntries(pkgs.map((d) => [d, Object.keys(result.packages[d].actual).filter((p) => p !== d)]));
result.packageCycles = cycles(pg);

// file-level cycles per package (relative imports)
const fg = {};
for (const [f, specs] of Object.entries(fileImports)) {
  fg[f] = [];
  for (const s of specs) {
    if (!s.startsWith('.')) continue;
    let target = path.normalize(path.join(path.dirname(f), s)).replace(/\.js$/, '');
    for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (fileImports[target + ext] !== undefined) { fg[f].push(target + ext); break; }
    }
  }
}
result.fileCycles = cycles(fg).map((c) => c.sort());

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
