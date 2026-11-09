// The shared part of the import probes (read-only): one scan of `packages/*/src`, the layer rules, file cycles and the
// wiring rules (who builds the file job queue, who submits to it or writes as its worker, who calls the process-wide
// setters), plus the ratchet that compares
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

/** The file graph of relative imports: file → the files it imports (each once). */
export function fileGraph(fileImports) {
  const fg = {};
  for (const [f, specs] of Object.entries(fileImports)) {
    const to = new Set();
    for (const s of specs) {
      if (!s.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), s)).replace(/\.js$/, '');
      for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
        if (fileImports[target + ext] !== undefined) { to.add(target + ext); break; }
      }
    }
    fg[f] = [...to];
  }
  return fg;
}

/** The cycles of the file graph of relative imports (each sorted). */
export function fileCycles(fileImports) {
  return cycles(fileGraph(fileImports)).map((c) => c.sort());
}

/** How many imports (file → file, each pair once) run between the files of one cycle. */
export function cycleEdges(graph, cycle) {
  const inside = new Set(cycle);
  return cycle.reduce((n, f) => n + (graph[f] ?? []).filter((t) => inside.has(t)).length, 0);
}

// The layer rules of docs/audit/target-architecture.md. `files` selects importing files; `bad(spec, file)` says whether
// one import breaks the rule.
// A module loader (node:module's createRequire) loads any package at run time, so it counts as I/O too.
const IO = /^(node:)?(fs|fs\/promises|child_process|net|tls|http|https|http2|dgram|os|dns|dns\/promises|worker_threads|readline|sqlite|zlib|stream|vm|module)$|^(playwright|playwright-core|pg|sharp|esbuild|@remotion\/(renderer|bundler)|@modelcontextprotocol|pdfjs-dist)/;
const pkgOf = (f) => f.split('/')[1];
const retake = (s) => (s.startsWith('@retake/') ? s.slice(8).split('/')[0] : null);
const SHELLS = ['cli', 'mcp', 'ui'];
const ADAPTERS = ['runner-web', 'editor', 'review', 'sandbox', 'hooks', 'components'];
export const RULES = [
  { id: 'R1', title: 'core is I/O-free (domain; a module loader — node:module, process.getBuiltinModule(), import() of a computed name — counts as I/O)', files: (f) => pkgOf(f) === 'core', bad: (s) => IO.test(s), loaders: true },
  { id: 'R2', title: 'adapters never import application or shells', files: (f) => ADAPTERS.includes(pkgOf(f)), bad: (s) => ['engine', 'mcp', 'ui', 'cli'].includes(retake(s)) },
  { id: 'R3', title: 'shells never import another shell (ui→mcp, mcp→ui; cli is the composition root and may)', files: (f) => ['mcp', 'ui'].includes(pkgOf(f)), bad: (s, f) => { const p = retake(s); return !!p && SHELLS.includes(p) && p !== pkgOf(f); } },
  { id: 'R4', title: 'shells call the application only (no direct adapter import)', files: (f) => SHELLS.includes(pkgOf(f)), bad: (s) => ADAPTERS.includes(retake(s)) },
  { id: 'R5', title: 'the Studio front end imports types only from other packages (checked: any @retake value import, re-export, side-effect import or import() in src/app)', files: (f) => f.startsWith('packages/ui/src/app/'), bad: (s) => !!retake(s), typeOnlyCheck: true },
  { id: 'R6', title: 'shells do not touch the file system / processes themselves', files: (f) => ['packages/mcp/src/tools/', 'packages/ui/src/server/', 'packages/cli/src/commands/'].some((p) => f.startsWith(p)), bad: (s) => /^(node:)?(fs|fs\/promises|child_process)$/.test(s) },
  { id: 'R7', title: 'the planner and review checks stay renderer-free (editor/review pure modules)', files: (f) => /packages\/editor\/src\/(plan|plan-types|timing|camera|layout|panes|timeline|resolve|tutorial|summary)\.ts$/.test(f) || /packages\/review\/src\/(checks|pixel-checks|spans|timeline|anchor|diff)\.ts$/.test(f), bad: (s) => IO.test(s) || /^remotion|^react/.test(s) },
];
export const CHECKS = [
  ...RULES.map((r) => ({ id: r.id, title: r.title })),
  { id: 'cycle', title: 'no import cycle between the files of a package (entries: each file and the first file of its cycle, and the number of imports inside the cycle)' },
  { id: 'queue', title: 'only the composition roots build the file job queue (`new FileJobQueue`, a class extending it, or the class itself passed on as a value): the engine, the worker, the job process and the CLI\'s workspaceQueue (and the adapter itself, for withOwnMemory); everything else is handed the JobQueue port' },
  { id: 'queue-call', title: 'outside packages/engine/src nothing submits to the job queue or writes as its worker (`queue.enqueue|write|claim|unclaim|setYield|append(…)`, also `x.queue.…`): the engine\'s operations submit after their checks, the worker writes' },
  { id: 'setter', title: 'the process-wide setters (useAgentPolicy, useWorkspaceFfmpeg, useWorkspaceRender) are used by packages/engine/src/workspace.ts only' },
  { id: 'layout', title: 'the folder layout of a workspace and its projects is joined in packages/core/src/layout.ts only (entries: each file and how many `join(…)` / `resolve(…)` calls of node:path name a layout folder in it)' },
];

function parse(ts, rel, text) {
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

const literal = (ts, e) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined);

/**
 * What a file loads, read from its syntax tree: `values`, the module specifiers it imports or re-exports as values (an
 * `import`, `export … from`, `export *`, side-effect `import '…'`, `import x = require()`, `import()` or `require()` call;
 * not `import type`, `export type` nor an import whose every name is `type`), and `loaders`, its run-time module loaders
 * (`getBuiltinModule()` calls, `import()` of a computed name).
 */
export function moduleUses(ts, rel, text) {
  const values = new Set();
  const loaders = new Set();
  const allTypes = (els) => els.length > 0 && els.every((e) => e.isTypeOnly);
  (function visit(n) {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings) && allTypes(c.namedBindings.elements)));
      const spec = literal(ts, n.moduleSpecifier);
      if (spec !== undefined && !typeOnly) values.add(spec);
      return;
    }
    if (ts.isExportDeclaration(n)) {
      const spec = literal(ts, n.moduleSpecifier);
      const typeOnly = n.isTypeOnly || (!!n.exportClause && ts.isNamedExports(n.exportClause) && allTypes(n.exportClause.elements));
      if (spec !== undefined && !typeOnly) values.add(spec);
      return;
    }
    if (ts.isImportEqualsDeclaration(n)) {
      const spec = ts.isExternalModuleReference(n.moduleReference) ? literal(ts, n.moduleReference.expression) : undefined;
      if (spec !== undefined && !n.isTypeOnly) values.add(spec);
      return;
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword;
      if (dynamic || (ts.isIdentifier(callee) && callee.text === 'require')) {
        const spec = literal(ts, n.arguments[0]);
        if (spec !== undefined) values.add(spec);
        else if (dynamic) loaders.add('import()');
      }
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name === 'getBuiltinModule') loaders.add('getBuiltinModule()');
    }
    n.forEachChild(visit);
  })(parse(ts, rel, text));
  return { values, loaders };
}

/**
 * Rule hits as `[{ rule, file, spec }]`, one per specifier the pre-processor lists (a file importing a module twice
 * gives the hit twice; ratchetEntries keeps one entry per rule, file and import). The type-only rule (R5) keeps the
 * specifiers the file loads as values, and the I/O rule of core (R1) adds the file's run-time module loaders, both read
 * from the syntax tree; a file that cannot be read counts as loading every one of its specifiers as a value.
 */
export function ruleHits(root, fileImports, rules = RULES) {
  const ts = (rules.some((r) => r.typeOnlyCheck || r.loaders) && loadTs(root)) || undefined;
  const uses = new Map();
  const usesOf = (f) => {
    if (!uses.has(f)) {
      let text;
      try {
        text = fs.readFileSync(path.join(root, f), 'utf8');
      } catch {
        text = undefined;
      }
      uses.set(f, text === undefined ? null : moduleUses(ts, f, text));
    }
    return uses.get(f);
  };
  const hits = [];
  for (const r of rules) {
    for (const [f, specs] of Object.entries(fileImports)) {
      if (!r.files(f)) continue;
      for (const s of specs) {
        if (!r.bad(s, f)) continue;
        if (r.typeOnlyCheck) {
          const u = usesOf(f);
          if (u && !u.values.has(s)) continue;
        }
        hits.push({ rule: r.id, file: f, spec: s });
      }
      if (r.loaders) for (const l of usesOf(f)?.loaders ?? []) hits.push({ rule: r.id, file: f, spec: l });
    }
  }
  return hits;
}

const QUEUE_CLASS = 'FileJobQueue';
/**
 * Where the file job queue may be built: the composition roots — the engine, the worker, the job process, and the CLI's
 * workspaceQueue (its in-process commands read the queue so that their pruning spares the folders of active jobs) —
 * and the adapter's own file (its withOwnMemory() makes one).
 */
const QUEUE_ROOTS = ['packages/engine/src/engine.ts', 'packages/engine/src/jobs/worker.ts', 'packages/engine/src/jobs/job-child.ts', 'packages/engine/src/jobs/queue.ts', 'packages/cli/src/workspace.ts'];
const queueRoot = (rel) => QUEUE_ROOTS.includes(rel);
/** The queue's submit and the worker's writes (JobQueue minus JobQueueView): called inside packages/engine/src only. */
const QUEUE_WRITES = new Set(['enqueue', 'write', 'claim', 'unclaim', 'setYield', 'append']);
const queueCallsAllowed = (rel) => rel.startsWith('packages/engine/src/');
const SETTERS = ['useAgentPolicy', 'useWorkspaceFfmpeg', 'useWorkspaceRender'];
const SETTER_HOME = 'packages/engine/src/workspace.ts';

/**
 * The wiring rules, read from the syntax tree: outside the composition roots (QUEUE_ROOTS, the CLI), `new FileJobQueue(…)`, a class extending it and
 * any other use of the class as a value (`const Q = FileJobQueue`, a destructured `{ FileJobQueue }`, `ns.FileJobQueue`
 * passed on), under its own name, an import alias or `ns.name` (a type position is not a use); outside
 * packages/engine/src, a call of the queue's submit or of a worker's write on something named `queue` (`queue.claim(…)`,
 * `engine.queue.enqueue(…)`, `this.queue['write'](…)`); and any use of a process-wide setter — a call or the function
 * passed on as a value, under the same names — outside packages/engine/src/workspace.ts. Declarations, imports and
 * re-exports are not uses.
 */
export function wiringHits(root, files) {
  const ts = loadTs(root);
  const hits = [];
  for (const { rel, text } of files) {
    const queue = !queueRoot(rel) && text.includes(QUEUE_CLASS);
    const calls = !queueCallsAllowed(rel) && text.includes('queue');
    const setters = rel !== SETTER_HOME && SETTERS.some((s) => text.includes(s));
    if (!queue && !calls && !setters) continue;
    const sf = parse(ts, rel, text);
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
    const named = (x, text) => !!x && (ts.isIdentifier(x) || ts.isStringLiteral(x)) && x.text === text;
    // The places where the class's name is not a value of its own: a declaration's name, a property name (counted on
    // the access), an object key, and the class built or extended (counted as such).
    const notAValue = (n) => {
      const p = n.parent;
      if (!p) return false;
      if ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)) return true;
      if ((ts.isClassDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isBindingElement(p)) && p.name === n) return true;
      if (ts.isNewExpression(p) && p.expression === n) return true;
      return ts.isExpressionWithTypeArguments(p) && p.expression === n;
    };
    (function visit(n, inType = false) {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
      // Type positions (annotations, `typeof`, generics, `implements`, type declarations) never use the class as a value.
      const typeHere = inType || (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || (ts.isHeritageClause(n) && n.token === ts.SyntaxKind.ImplementsKeyword);
      if (queue && !typeHere && ts.isNewExpression(n) && nameOf(n.expression) === QUEUE_CLASS) found.add(`queue:new ${QUEUE_CLASS}`);
      if (queue && !typeHere && ts.isHeritageClause(n) && n.types.some((t) => nameOf(t.expression) === QUEUE_CLASS)) found.add(`queue:extends ${QUEUE_CLASS}`);
      if (queue && !typeHere) {
        const ref = (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && nameOf(n) === QUEUE_CLASS && !notAValue(n);
        const destructured = ts.isBindingElement(n) && named(n.propertyName ?? n.name, QUEUE_CLASS);
        const indexed = ts.isElementAccessExpression(n) && named(n.argumentExpression, QUEUE_CLASS);
        const shorthand = ts.isShorthandPropertyAssignment(n) && names.get(n.name.text) === QUEUE_CLASS;
        const aliased = ts.isImportEqualsDeclaration(n) && ts.isQualifiedName(n.moduleReference) && n.moduleReference.right.text === QUEUE_CLASS; // import Q = ns.FileJobQueue
        if (ref || destructured || indexed || shorthand || aliased) found.add(`queue:${QUEUE_CLASS} as a value`);
      }
      if (calls && ts.isCallExpression(n)) {
        const callee = n.expression;
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) ? literal(ts, callee.argumentExpression) : undefined;
        const on = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined;
        const queueNamed = !!on && ((ts.isIdentifier(on) && on.text === 'queue') || (ts.isPropertyAccessExpression(on) && on.name.text === 'queue'));
        if (method && QUEUE_WRITES.has(method) && queueNamed) found.add(`queue-call:queue.${method}`);
      }
      if (setters && (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n))) {
        const orig = nameOf(n);
        const p = n.parent;
        const declName = p && (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === n;
        const inner = ts.isIdentifier(n) && p && ts.isPropertyAccessExpression(p) && p.name === n; // counted on the access
        if (orig && SETTERS.includes(orig) && !declName && !inner) found.add(`setter:${orig}`);
      }
      n.forEachChild((c) => visit(c, typeHere));
    })(sf);
    for (const k of found) { const i = k.indexOf(':'); hits.push({ rule: k.slice(0, i), file: rel, spec: k.slice(i + 1) }); }
  }
  return hits;
}

/** The folder names of the layout (packages/core/src/layout.ts PROJECT_DIRS and STATE_DIR; the import-rules test checks they agree). */
export const LAYOUT_NAMES = ['scenarios', 'hooks', 'assets', 'comments', 'runs', 'renders', 'review', 'exports', '.retake'];
export const LAYOUT_HOME = 'packages/core/src/layout.ts';
const PATH_MODULES = new Set(['path', 'node:path', 'path/posix', 'node:path/posix']);

/**
 * The hand-joined layout names, read from the syntax tree: outside packages/core/src/layout.ts, each argument of a
 * node:path `join` / `resolve` call (under its own name, an import alias, `path.join`, `path.posix.join`, `posix.join`)
 * that is a string naming a layout folder (LAYOUT_NAMES) or starting with one (`'runs/x'`, `` `runs/${id}` ``).
 * `[{ file, count, lines }]` (the line of each), files with none left out.
 */
export function layoutHits(root, files) {
  const ts = loadTs(root);
  const out = [];
  const names = (t) => LAYOUT_NAMES.some((n) => t === n || t.startsWith(`${n}/`));
  for (const { rel, text } of files) {
    if (rel === LAYOUT_HOME || !LAYOUT_NAMES.some((n) => text.includes(`'${n}`) || text.includes(`"${n}`) || text.includes(`\`${n}`))) continue;
    const sf = parse(ts, rel, text);
    const fns = new Map(); // local name → join | resolve
    const spaces = new Set(); // local names of the path module (or its posix / win32 parts)
    sf.forEachChild((n) => {
      if (!ts.isImportDeclaration(n) || !PATH_MODULES.has(literal(ts, n.moduleSpecifier) ?? '') || !n.importClause) return;
      const c = n.importClause;
      if (c.name) spaces.add(c.name.text);
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b)) spaces.add(b.name.text);
      if (b && ts.isNamedImports(b)) {
        for (const e of b.elements) {
          const orig = (e.propertyName ?? e.name).text;
          if (orig === 'join' || orig === 'resolve') fns.set(e.name.text, orig);
          if (orig === 'posix' || orig === 'win32') spaces.add(e.name.text);
        }
      }
    });
    const isSpace = (e) => (ts.isIdentifier(e) && spaces.has(e.text)) || (ts.isPropertyAccessExpression(e) && ['posix', 'win32'].includes(e.name.text) && isSpace(e.expression));
    const isPathCall = (callee) => (ts.isIdentifier(callee) && fns.has(callee.text)) || (ts.isPropertyAccessExpression(callee) && ['join', 'resolve'].includes(callee.name.text) && isSpace(callee.expression));
    const lines = [];
    (function visit(n) {
      if (ts.isCallExpression(n) && isPathCall(n.expression)) {
        for (const a of n.arguments) {
          const t = literal(ts, a) ?? (ts.isTemplateExpression(a) ? a.head.text : undefined);
          if (t !== undefined && names(t)) lines.push(sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1);
        }
      }
      n.forEachChild(visit);
    })(sf);
    if (lines.length) out.push({ file: rel, count: lines.length, lines });
  }
  return out;
}

/**
 * One ratchet entry per (rule, file, import): the strings the baseline holds, sorted. A cycle gives one entry per file
 * and one with the number of imports inside it, so a new import between files already in a cycle fails too.
 */
export function ratchetEntries(root, scanned = scan(root)) {
  const set = new Set();
  for (const h of [...ruleHits(root, scanned.fileImports), ...wiringHits(root, scanned.files)]) set.add(`${h.rule} ${h.file} → ${h.spec}`);
  for (const h of layoutHits(root, scanned.files)) set.add(`layout ${h.file} → ${h.count} hand-joined layout name${h.count === 1 ? '' : 's'}`);
  const graph = fileGraph(scanned.fileImports);
  for (const c of cycles(graph).map((x) => x.sort())) {
    for (const f of c) set.add(`cycle ${f} → cycle of ${c[0]}`);
    set.add(`cycle ${c[0]} → ${cycleEdges(graph, c)} imports inside its cycle`);
  }
  return [...set].sort();
}

/** The cycle an entry of the cycle check belongs to (its first file), else undefined. */
function cycleOf(entry) {
  return /→ cycle of (.+)$/.exec(entry)?.[1] ?? /^(?:cycle )?(.+) → \d+ imports inside its cycle$/.exec(entry)?.[1];
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

/**
 * The baseline rewritten for today's entries: reasons and groups kept, stale entries dropped, new ones in a group per
 * rule to explain — except a new entry of a cycle a group already holds (a file joining it, its new import count),
 * which joins that group.
 */
export function rewriteBaseline(entries, baseline) {
  const now = new Set(entries);
  const kept = new Set();
  const groups = [];
  const cycleGroups = new Map();
  for (const g of baseline.groups ?? []) {
    const es = (g.entries ?? []).filter((e) => now.has(`${g.rule} ${e}`) && !kept.has(`${g.rule} ${e}`));
    es.forEach((e) => kept.add(`${g.rule} ${e}`));
    const group = { rule: g.rule, reason: g.reason ?? '', entries: es };
    if (g.rule === 'cycle') for (const e of g.entries ?? []) if (cycleOf(e) && !cycleGroups.has(cycleOf(e))) cycleGroups.set(cycleOf(e), group);
    groups.push(group);
  }
  for (const e of entries) {
    const group = e.startsWith('cycle ') && !kept.has(e) ? cycleGroups.get(cycleOf(e.slice(6))) : undefined;
    if (group) { group.entries.push(e.slice(6)); kept.add(e); }
  }
  for (let i = groups.length - 1; i >= 0; i--) if (groups[i].entries.length) groups[i].entries.sort(); else groups.splice(i, 1);
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
