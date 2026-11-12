// Ubiquitous-language probe (read-only).
// Usage: node scripts/audit/terms.mjs <repo-root>
// 1. Per term: occurrences (case-insensitive word match) per package src and in docs/ + README.
// 2. Exported type / interface / class names declared in more than one package (possible duplicated models).
// 3. Exported names per "context noun" (Run*, Take*, Capture*, Template*, Theme*, Thread*, Comment*…).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(process.argv[2] ?? '.');
const ts = createRequire(path.join(root, 'package.json'))('typescript');
const walk = (d, out = []) => {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'dist'].includes(e.name)) walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
};
const pkgs = fs.readdirSync(path.join(root, 'packages'));
const TERMS = [
  'scenario',
  'step',
  'scene',
  'run',
  'take',
  'capture',
  'rehearsal',
  'dry run',
  'render',
  'review',
  'check',
  'export',
  'component',
  'theme',
  'template',
  'project',
  'workspace',
  'persona',
  'session',
  'sandbox',
  'hook',
  'job',
  'comment',
  'thread',
  'studio',
  'recording',
  'environment',
  'account',
  'brand',
  'look',
  'master',
  'video',
  'timeline',
  'plan',
  'edit',
];

const texts = {};
for (const p of pkgs)
  texts[p] = walk(path.join(root, 'packages', p, 'src'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
const docFiles = walk(path.join(root, 'docs')).concat([]);
const md = [];
(function w(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) w(p);
    else if (e.name.endsWith('.md')) md.push(p);
  }
})(path.join(root, 'docs'));
md.push(path.join(root, 'README.md'));
texts['docs+README'] = md.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const count = (t, s) => (s.match(new RegExp(`\\b${t.replace(' ', '[ _-]')}(s|es)?\\b`, 'gi')) ?? []).length;
const cols = [...pkgs, 'docs+README'];
console.log('# Term occurrences (word match, plural included)');
console.log(['term', ...cols].join('\t'));
for (const t of TERMS) console.log([t, ...cols.map((c) => count(t, texts[c]))].join('\t'));

// exported declarations
const decl = new Map(); // name -> [{pkg, file, kind}]
for (const p of pkgs) {
  for (const f of walk(path.join(root, 'packages', p, 'src'))) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    for (const st of sf.statements) {
      const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      let kind;
      let name;
      if (ts.isInterfaceDeclaration(st)) {
        kind = 'interface';
        name = st.name.text;
      } else if (ts.isTypeAliasDeclaration(st)) {
        kind = 'type';
        name = st.name.text;
      } else if (ts.isClassDeclaration(st) && st.name) {
        kind = 'class';
        name = st.name.text;
      } else if (ts.isFunctionDeclaration(st) && st.name) {
        kind = 'function';
        name = st.name.text;
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations)
          if (ts.isIdentifier(d.name)) {
            const n = d.name.text;
            (decl.get(n) ?? decl.set(n, []).get(n)).push({ pkg: p, file: path.relative(root, f), kind: 'const', line: sf.getLineAndCharacterOfPosition(d.getStart()).line + 1 });
          }
        continue;
      } else continue;
      (decl.get(name) ?? decl.set(name, []).get(name)).push({ pkg: p, file: path.relative(root, f), kind, line: sf.getLineAndCharacterOfPosition(st.getStart()).line + 1 });
    }
  }
}
console.log('\n# Exported names declared in more than one package');
let n = 0;
for (const [name, ds] of [...decl].sort()) {
  const ps = new Set(ds.map((d) => d.pkg));
  if (ps.size > 1) {
    n++;
    console.log(`${name}: ${ds.map((d) => `${d.file}:${d.line} (${d.kind})`).join(' | ')}`);
  }
}
console.log(`total: ${n}`);
console.log('\n# Exported names declared in more than one file of the same package');
let m = 0;
for (const [name, ds] of [...decl].sort()) {
  const byPkg = {};
  for (const d of ds) (byPkg[d.pkg] ??= new Set()).add(d.file);
  for (const [p, fs_] of Object.entries(byPkg))
    if (fs_.size > 1) {
      m++;
      console.log(`${p} ${name}: ${[...fs_].join(' | ')}`);
    }
}
console.log(`total: ${m}`);

console.log('\n# Exported type-ish names by context noun (interface/type/class)');
const NOUNS = [
  'Run',
  'Take',
  'Capture',
  'Rehearsal',
  'Render',
  'Review',
  'Export',
  'Template',
  'Theme',
  'Comment',
  'Thread',
  'Job',
  'Session',
  'Persona',
  'Sandbox',
  'Hook',
  'Scenario',
  'Scene',
  'Step',
  'Project',
  'Workspace',
  'Component',
  'Recording',
  'Record',
  'Plan',
  'Timeline',
  'Check',
  'Issue',
  'Finding',
];
for (const N of NOUNS) {
  const hits = [...decl].filter(([name, ds]) => new RegExp(`^${N}[A-Z]|^${N}$`).test(name) && ds.some((d) => d.kind !== 'const' && d.kind !== 'function'));
  const per = {};
  for (const [, ds] of hits) for (const d of ds) per[d.pkg] = (per[d.pkg] ?? 0) + 1;
  console.log(`${N}*: ${hits.length} types — ${JSON.stringify(per)}`);
}
