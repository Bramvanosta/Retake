// Size probe (read-only): largest files, longest functions (any function-like node, incl. arrows and methods,
// React components), per-package test/src ratio and test-file classification.
// Usage: node scripts/audit/sizes.mjs <repo-root> [--top 30] [--fn 150] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2] ?? '.');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const TOP = arg('--top', 30); const FN = arg('--fn', 150);
const jsonOut = (() => { const i = process.argv.indexOf('--json'); return i > 0 ? process.argv[i + 1] : undefined; })();
const summary = { tests: {} };
const ts = createRequire(path.join(root, 'package.json'))('typescript');
const walk = (d, out = []) => {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'dist', 'target'].includes(e.name)) walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
};
const pkgs = fs.readdirSync(path.join(root, 'packages'));
const files = [];
for (const p of pkgs) for (const f of walk(path.join(root, 'packages', p, 'src'))) files.push({ p, f, lines: fs.readFileSync(f, 'utf8').split('\n').length });
files.sort((a, b) => b.lines - a.lines);
console.log(`# ${TOP} largest src files`);
for (const x of files.slice(0, TOP)) console.log(`${String(x.lines).padStart(5)}  ${path.relative(root, x.f)}`);
const buckets = { '>1000': 0, '500-1000': 0, '300-500': 0, '<300': 0 };
for (const x of files) buckets[x.lines > 1000 ? '>1000' : x.lines > 500 ? '500-1000' : x.lines > 300 ? '300-500' : '<300']++;
console.log('file size buckets:', JSON.stringify(buckets), 'files:', files.length, 'lines:', files.reduce((a, b) => a + b.lines, 0));
Object.assign(summary, { buckets, files: files.length, lines: files.reduce((a, b) => a + b.lines, 0), largest: files.slice(0, TOP).map((x) => ({ file: path.relative(root, x.f), lines: x.lines })) });

const fns = [];
for (const { p, f } of files) {
  const src = fs.readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (n, owner) => {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
      const a = sf.getLineAndCharacterOfPosition(n.getStart()).line; const b = sf.getLineAndCharacterOfPosition(n.getEnd()).line;
      let name = n.name?.getText?.() ?? owner ?? '<anon>';
      if (!n.name && ts.isVariableDeclaration(n.parent)) name = n.parent.name.getText();
      if (!n.name && ts.isPropertyAssignment(n.parent)) name = n.parent.name.getText();
      fns.push({ p, file: path.relative(root, f), line: a + 1, len: b - a + 1, name });
    }
    ts.forEachChild(n, (c) => visit(c, owner));
  };
  visit(sf);
}
// keep only outermost long functions: drop a function fully nested in another listed one of the same file
fns.sort((a, b) => b.len - a.len);
const long = fns.filter((x) => x.len >= FN);
const outer = long.filter((x) => !long.some((y) => y !== x && y.file === x.file && y.line <= x.line && y.line + y.len >= x.line + x.len && y.len > x.len));
console.log(`\n# functions >= ${FN} lines: ${long.length} (outermost ${outer.length})`);
const perPkg = {};
for (const x of outer) perPkg[x.p] = (perPkg[x.p] ?? 0) + 1;
console.log('per package (outermost):', JSON.stringify(perPkg));
for (const x of outer.slice(0, 40)) console.log(`${String(x.len).padStart(5)}  ${x.file}:${x.line}  ${x.name}`);
Object.assign(summary, { longFunctions: outer.length, longFunctionsPerPackage: perPkg, longest: outer.slice(0, 40).map(({ file, line, len, name }) => ({ file, line, len, name })) });

// tests
console.log('\n# tests per package: test lines / src lines, files, gated (skipIf/RETAKE_TEST_*), spawn/browser/fixture use');
for (const p of pkgs) {
  const tf = walk(path.join(root, 'packages', p, 'test')).filter((f) => /\.test\.tsx?$/.test(f));
  const all = walk(path.join(root, 'packages', p, 'test'));
  const srcL = files.filter((x) => x.p === p).reduce((a, b) => a + b.lines, 0);
  const tl = all.reduce((a, f) => a + fs.readFileSync(f, 'utf8').split('\n').length, 0);
  let gated = 0, browser = 0, spawn = 0, fsTmp = 0, pure = 0, cases = 0;
  const gatedNames = [];
  for (const f of tf) {
    const s = fs.readFileSync(f, 'utf8');
    cases += (s.match(/\b(it|test)(\.each\([^)]*\))?\(\s*['"`]/g) ?? []).length;
    const g = /skipIf|RETAKE_TEST_[A-Z_]+|describe\.skip|it\.skip/.test(s);
    const b = /chromium|playwright|launchBrowser|server\.mjs|fixtures\/wholesale|startFixture/i.test(s);
    const sp = /child_process|spawn\(|execFile|execa|bin\.js/.test(s);
    const t = /mkdtemp|tmpdir\(\)|os\.tmpdir/.test(s);
    if (g) { gated++; gatedNames.push(path.basename(f)); }
    if (b) browser++; if (sp) spawn++; if (t) fsTmp++;
    if (!b && !sp && !t && !/from 'node:fs|from 'node:http|fetch\(/.test(s)) pure++;
  }
  summary.tests[p] = { src: srcL, test: tl, files: tf.length, cases, gated, browser, spawn, tmpdir: fsTmp, noIO: pure };
  console.log(`${p.padEnd(11)} src=${srcL} test=${tl} ratio=${(tl / srcL).toFixed(2)} files=${tf.length} cases≈${cases} gated=${gated} browser/fixture=${browser} spawn=${spawn} tmpdir=${fsTmp} no-I/O=${pure}`);
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 1) + '\n');
