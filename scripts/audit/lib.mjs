// The shared part of the import probes (read-only): one scan of `packages/*/src`, the layer rules, file cycles and the
// two wiring rules (who builds the file job queue, who calls the process-wide setters), plus the ratchet that compares
// them with the committed baseline (scripts/audit/baseline.json). Used by imports.mjs, rules.mjs and the import-rules
// test (packages/core/test/import-rules.test.ts), so the scripts and the test have one implementation.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export const BASELINE = 'scripts/audit/baseline.json';
export const WRITE_HINT = 'node scripts/audit/rules.mjs . --write-baseline';

const IO_PACKAGES = /^(playwright|playwright-core|pg|sharp|@remotion\/(renderer|bundler)|esbuild|@modelcontextprotocol|pdfjs-dist)/;
const IO_BUILTINS = new Set(['fs', 'fs/promises', 'child_process', 'net', 'http', 'https', 'http2', 'dgram', 'tls', 'worker_threads', 'cluster', 'os', 'process', 'readline', 'dns', 'inspector', 'v8', 'vm', 'sqlite']);

/** The TypeScript compiler of the scanned tree, else the one of this repository (no install of its own). */
export function loadTs(root) {
  try {
    return createRequire(path.join(root, 'package.json'))('typescript');
  } catch {
    return createRequire(import.meta.url)('typescript');
  }
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, out); }
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Every source file of every package: `{ pkgs, nameToDir, declared, files: [{ rel, pkg, text, specs }], fileImports }`.
 * `specs` are the module specifiers the compiler's pre-processor finds (static, `import type`, dynamic `import()`).
 */
export function scan(root) {
  const ts = loadTs(root);
  const pkgsDir = path.join(root, 'packages');
  const pkgs = fs.readdirSync(pkgsDir).filter((d) => fs.existsSync(path.join(pkgsDir, d, 'package.json')));
  const nameToDir = {};
  const declared = {};
  for (const d of pkgs) {
    const pj = JSON.parse(fs.readFileSync(path.join(pkgsDir, d, 'package.json'), 'utf8'));
    nameToDir[pj.name] = d;
    declared[d] = Object.keys({ ...pj.dependencies }).filter((n) => n.startsWith('@retake/')).map((n) => n.replace('@retake/', ''));
  }
  const files = [];
  const fileImports = {};
  for (const d of pkgs) {
    for (const f of walk(path.join(pkgsDir, d, 'src'))) {
      const text = fs.readFileSync(f, 'utf8');
      const specs = ts.preProcessFile(text, true, true).importedFiles.map((x) => x.fileName);
      const rel = path.relative(root, f).split(path.sep).join('/');
      files.push({ rel, pkg: d, text, specs });
      fileImports[rel] = specs;
    }
  }
  return { pkgs, nameToDir, declared, files, fileImports };
}

/** Whether a specifier is an I/O module for the package report of imports.mjs. */
export function ioKind(spec, builtins) {
  if (spec.startsWith('node:') || builtins.has(spec.split('/')[0])) {
    const b = spec.replace(/^node:/, '');
    return IO_BUILTINS.has(b) ? b : null;
  }
  if (!spec.startsWith('.') && IO_PACKAGES.test(spec)) return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  return null;
}

/** Strongly connected components with more than one node (Tarjan). */
export function cycles(graph) {
  const out = [];
  const idx = {}; const low = {}; const on = new Set(); const st = []; let i = 0;
  function sc(v) {
    idx[v] = low[v] = i++; st.push(v); on.add(v);
    for (const w of graph[v] ?? []) {
      if (!(w in idx)) { sc(w); low[v] = Math.min(low[v], low[w]); }
      else if (on.has(w)) low[v] = Math.min(low[v], idx[w]);
    }
    if (low[v] === idx[v]) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) out.push(c); }
  }
  for (const v of Object.keys(graph)) if (!(v in idx)) sc(v);
  return out;
}

/** The file graph of relative imports, and its cycles (each sorted). */
export function fileCycles(fileImports) {
  const fg = {};
  for (const [f, specs] of Object.entries(fileImports)) {
    fg[f] = [];
    for (const s of specs) {
      if (!s.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), s)).replace(/\.js$/, '');
      for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
        if (fileImports[target + ext] !== undefined) { fg[f].push(target + ext); break; }
      }
    }
  }
  return cycles(fg).map((c) => c.sort());
}

// The layer rules of docs/audit/target-architecture.md. `files` selects importing files; `bad(spec, file)` says whether
// one import breaks the rule.
const IO = /^(node:)?(fs|fs\/promises|child_process|net|http|https|os|dns|dns\/promises|worker_threads|readline|sqlite|zlib|stream)$|^(playwright|playwright-core|pg|sharp|esbuild|@remotion\/(renderer|bundler)|@modelcontextprotocol|pdfjs-dist)/;
const pkgOf = (f) => f.split('/')[1];
const retake = (s) => (s.startsWith('@retake/') ? s.slice(8).split('/')[0] : null);
const SHELLS = ['cli', 'mcp', 'ui'];
const ADAPTERS = ['runner-web', 'editor', 'review', 'sandbox', 'hooks', 'components'];
export const RULES = [
  { id: 'R1', title: 'core is I/O-free (domain)', files: (f) => pkgOf(f) === 'core', bad: (s) => IO.test(s) },
  { id: 'R2', title: 'adapters never import application or shells', files: (f) => ADAPTERS.includes(pkgOf(f)), bad: (s) => ['engine', 'mcp', 'ui', 'cli'].includes(retake(s)) },
  { id: 'R3', title: 'shells never import another shell (ui→mcp, mcp→ui; cli is the composition root and may)', files: (f) => ['mcp', 'ui'].includes(pkgOf(f)), bad: (s, f) => { const p = retake(s); return !!p && SHELLS.includes(p) && p !== pkgOf(f); } },
  { id: 'R4', title: 'shells call the application only (no direct adapter import)', files: (f) => SHELLS.includes(pkgOf(f)), bad: (s) => ADAPTERS.includes(retake(s)) },
  { id: 'R5', title: 'the Studio front end imports types only from other packages (checked: any @retake value import in src/app)', files: (f) => f.startsWith('packages/ui/src/app/'), bad: (s) => !!retake(s), typeOnlyCheck: true },
  { id: 'R6', title: 'shells do not touch the file system / processes themselves', files: (f) => ['packages/mcp/src/tools/', 'packages/ui/src/server/', 'packages/cli/src/commands/'].some((p) => f.startsWith(p)), bad: (s) => /^(node:)?(fs|fs\/promises|child_process)$/.test(s) },
  { id: 'R7', title: 'the planner and review checks stay renderer-free (editor/review pure modules)', files: (f) => /packages\/editor\/src\/(plan|plan-types|timing|camera|layout|panes|timeline|resolve|tutorial|summary)\.ts$/.test(f) || /packages\/review\/src\/(checks|pixel-checks|spans|timeline|anchor|diff)\.ts$/.test(f), bad: (s) => IO.test(s) || /^remotion|^react/.test(s) },
];
export const CHECKS = [
  ...RULES.map((r) => ({ id: r.id, title: r.title })),
  { id: 'cycle', title: 'no import cycle between the files of a package (entry: a file and the first file of its cycle)' },
  { id: 'queue', title: 'only the engine builds the file job queue (`new FileJobQueue`)' },
  { id: 'setter', title: 'the process-wide setters (useAgentPolicy, useWorkspaceFfmpeg, useWorkspaceRender) are used by packages/engine/src/workspace.ts only' },
];

/** Rule hits as `[{ rule, file, spec }]`, one per import statement (a file importing a module twice gives two). */
export function ruleHits(root, fileImports, rules = RULES) {
  const hits = [];
  for (const r of rules) {
    for (const [f, specs] of Object.entries(fileImports)) {
      if (!r.files(f)) continue;
      let src;
      for (const s of specs) {
        if (!r.bad(s, f)) continue;
        if (r.typeOnlyCheck) {
          src ??= fs.readFileSync(path.join(root, f), 'utf8');
          const re = new RegExp(`import\\s+(?!type\\b)[^;]*from\\s+'${s.replace(/[/.]/g, '\\$&')}'`);
          if (!re.test(src)) continue;
        }
        hits.push({ rule: r.id, file: f, spec: s });
      }
    }
  }
  return hits;
}

const QUEUE_CLASS = 'FileJobQueue';
const SETTERS = ['useAgentPolicy', 'useWorkspaceFfmpeg', 'useWorkspaceRender'];
const SETTER_HOME = 'packages/engine/src/workspace.ts';

/**
 * The wiring rules, read from the syntax tree: `new FileJobQueue(…)` (or a class extending it) outside packages/engine,
 * and any use of a process-wide setter — a call or the function passed on as a value, under its own name, an import
 * alias or `ns.name` — outside packages/engine/src/workspace.ts. Declarations, imports and re-exports are not uses.
 */
export function wiringHits(root, files) {
  const ts = loadTs(root);
  const hits = [];
  for (const { rel, text } of files) {
    const queue = !rel.startsWith('packages/engine/') && text.includes(QUEUE_CLASS);
    const setters = rel !== SETTER_HOME && SETTERS.some((s) => text.includes(s));
    if (!queue && !setters) continue;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const names = new Map([[QUEUE_CLASS, QUEUE_CLASS], ...SETTERS.map((s) => [s, s])]); // local name → original
    sf.forEachChild(function imports(n) {
      if (ts.isImportSpecifier(n)) {
        const orig = (n.propertyName ?? n.name).text;
        if (names.has(orig)) names.set(n.name.text, orig);
      }
      n.forEachChild(imports);
    });
    const nameOf = (e) => (ts.isIdentifier(e) ? names.get(e.text) : ts.isPropertyAccessExpression(e) && names.has(e.name.text) && e.name.text === names.get(e.name.text) ? e.name.text : undefined);
    const found = new Set();
    (function visit(n) {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
      if (queue && ts.isNewExpression(n) && nameOf(n.expression) === QUEUE_CLASS) found.add(`queue:new ${QUEUE_CLASS}`);
      if (queue && ts.isHeritageClause(n) && n.types.some((t) => nameOf(t.expression) === QUEUE_CLASS)) found.add(`queue:extends ${QUEUE_CLASS}`);
      if (setters && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n))) {
        const orig = nameOf(n);
        const p = n.parent;
        const declName = p && (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === n;
        const inner = ts.isIdentifier(n) && p && ts.isPropertyAccessExpression(p) && p.name === n; // counted on the access
        if (orig && SETTERS.includes(orig) && !declName && !inner) found.add(`setter:${orig}`);
      }
      n.forEachChild(visit);
    })(sf);
    for (const k of found) { const i = k.indexOf(':'); hits.push({ rule: k.slice(0, i), file: rel, spec: k.slice(i + 1) }); }
  }
  return hits;
}

/** One ratchet entry per (rule, file, import): the strings the baseline holds, sorted. */
export function ratchetEntries(root, scanned = scan(root)) {
  const set = new Set();
  for (const h of [...ruleHits(root, scanned.fileImports), ...wiringHits(root, scanned.files)]) set.add(`${h.rule} ${h.file} → ${h.spec}`);
  for (const c of fileCycles(scanned.fileImports)) for (const f of c) set.add(`cycle ${f} → cycle of ${c[0]}`);
  return [...set].sort();
}

export function readBaseline(root) {
  const p = path.join(root, BASELINE);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { groups: [] };
}

/**
 * Today's entries against the baseline: `added` (not allowed by any group), `stale` (allowed but gone), `unexplained`
 * (groups without a one-line reason), `misfiled` (an entry in a group of another rule), `duplicates`.
 */
export function compareBaseline(entries, baseline) {
  const allowed = new Map();
  const duplicates = [];
  const misfiled = [];
  const unexplained = [];
  for (const g of baseline.groups ?? []) {
    const reason = String(g.reason ?? '').trim();
    if (!reason || reason.includes('\n') || /^todo\b/i.test(reason)) unexplained.push(`${g.rule}: ${g.entries?.[0] ?? '(empty group)'}`);
    for (const e of g.entries ?? []) {
      const key = `${g.rule} ${e}`;
      if (allowed.has(key)) duplicates.push(key);
      allowed.set(key, g);
    }
  }
  for (const k of allowed.keys()) if (!CHECKS.some((c) => k.startsWith(`${c.id} `))) misfiled.push(k);
  const now = new Set(entries);
  return {
    added: entries.filter((e) => !allowed.has(e)),
    stale: [...allowed.keys()].filter((k) => !now.has(k)).sort(),
    unexplained,
    misfiled,
    duplicates,
  };
}

/** The baseline rewritten for today's entries: reasons and groups kept, stale entries dropped, new ones in a group per rule to explain. */
export function rewriteBaseline(entries, baseline) {
  const now = new Set(entries);
  const kept = new Set();
  const groups = [];
  for (const g of baseline.groups ?? []) {
    const es = (g.entries ?? []).filter((e) => now.has(`${g.rule} ${e}`) && !kept.has(`${g.rule} ${e}`));
    es.forEach((e) => kept.add(`${g.rule} ${e}`));
    if (es.length) groups.push({ rule: g.rule, reason: g.reason ?? '', entries: es.sort() });
  }
  for (const c of CHECKS) {
    const fresh = entries.filter((e) => e.startsWith(`${c.id} `) && !kept.has(e)).map((e) => e.slice(c.id.length + 1));
    if (fresh.length) groups.push({ rule: c.id, reason: '', entries: fresh });
  }
  const order = (r) => CHECKS.findIndex((c) => c.id === r);
  groups.sort((a, b) => order(a.rule) - order(b.rule));
  return { about: baseline.about ?? ABOUT, groups };
}

const ABOUT = `The allowed exceptions of the import-rules ratchet (packages/core/test/import-rules.test.ts, rules in scripts/audit/lib.mjs). Each group has one rule, a one-line reason and its entries ("<file> → <import>"). A new entry and a stale one both fail the test: after a change, run ${WRITE_HINT}, write the reason of any new group, and review the diff.`;

/** The failure text of the ratchet, or '' when it holds. */
export function ratchetReport(cmp) {
  const parts = [];
  const list = (title, xs) => xs.length && parts.push(`${title} (${xs.length}):\n${xs.map((x) => `  ${x}`).join('\n')}`);
  list('New violations (fix them; an accepted exception goes into the baseline with a reason)', cmp.added);
  list('Stale baseline entries (the violation is gone: lower the baseline)', cmp.stale);
  list('Baseline groups without a one-line reason', cmp.unexplained);
  list('Baseline entries of an unknown rule', cmp.misfiled);
  list('Baseline entries listed twice', cmp.duplicates);
  if (!parts.length) return '';
  return `${parts.join('\n')}\n\nRules: ${CHECKS.map((c) => `${c.id} ${c.title}`).join('; ')}.\nUpdate ${BASELINE} with: ${WRITE_HINT} (keeps the reasons; new groups need one).`;
}
