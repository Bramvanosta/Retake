// The shared part of the import probes (read-only): one scan of `packages/*/src`, the layer rules, file cycles and the
// wiring rules (who builds the file job queue, who submits to it or writes as its worker, where a module-level variable
// would hold the work's policy), plus the ratchet that compares
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

/** The files the layer rules read: TypeScript sources, declaration files left out. */
const isScanned = (name) => /\.(ts|tsx|mts|cts)$/.test(name) && !/\.d\.[cm]?ts$/.test(name);
/** Every file the compiler can parse as a module: what the seam rule (R10) reads, declaration files included. */
const isSource = (name) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(name);

function walk(dir, out = [], keep = isScanned) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, out, keep); }
    else if (keep(e.name)) out.push(p);
  }
  return out;
}

/**
 * Every source file of every package: `{ pkgs, nameToDir, declared, files: [{ rel, pkg, text, specs }], fileImports }`.
 * `specs` are the module specifiers of the file (specifiersOf): what the compiler's pre-processor finds (static,
 * `import type`, `import()`, `require()`) and every import / export declaration of the syntax tree.
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
      const rel = path.relative(root, f).split(path.sep).join('/');
      const specs = specifiersOf(ts, rel, text);
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
/**
 * Every package of the repository in its layer (docs/audit/target-architecture.md): a folder of packages/ that is in
 * none, or in two, fails packages/core/test/import-rules.test.ts — a new package is given its rules on purpose.
 */
export const LAYERS = { domain: ['core'], adapters: ADAPTERS, application: ['engine'], shells: SHELLS };
/**
 * The domain entries of the adapter packages (docs/audit/target-architecture.md, the domain line): pure modules — no
 * I/O, no renderer, no adapter code. A shell may import their types only (R4: a value would be the shell doing the
 * application's work by itself); the engine may import their values (R11), all but the editor's, which R9 holds whole
 * (`@retake/editor/plan` as a value in the engine outside its loader is an R9 hit). Each is held pure by its own walk
 * test (components geometry-entry, editor plan-entry, review checks-entry, hooks describe-entry, runner-web types-entry
 * and sandbox types-entry: type-only entries, whose built files load nothing).
 */
export const DOMAIN_ENTRIES = ['@retake/components/geometry', '@retake/editor/plan', '@retake/review/checks', '@retake/hooks/describe', '@retake/runner-web/types', '@retake/sandbox/types'];
/**
 * The review's pure modules (packages/review/src/<name>.ts): what `@retake/review/checks` reaches. R7 keeps each free of
 * I/O and renderer imports, R12 keeps each on the components' geometry entry; both read one file at a time — the
 * transitive proof is packages/review/test/checks-entry.test.ts, which walks the entry's imports.
 */
export const REVIEW_PURE = ['checks-entry', 'checks', 'pixel-checks', 'pixel-maths', 'spans', 'timeline', 'anchor', 'diff', 'types', 'images', 'report-lines'];
const reviewPure = (f) => f.startsWith('packages/review/src/') && f.endsWith('.ts') && REVIEW_PURE.includes(f.slice('packages/review/src/'.length, -3));
/** Core's side that touches the machine (`@retake/core/io`): R1 holds for the rest of core, which never imports it. */
export const CORE_IO_DIR = 'packages/core/src/io/';
/** An import of core's io side from the rest of core: `@retake/core/io`, or a relative path to src/io (`./io`) or into it. */
const coreIoImport = (s, f) => {
  if (s === '@retake/core/io' || s.startsWith('@retake/core/io/')) return true;
  if (!s.startsWith('.')) return false;
  const to = path.posix.normalize(path.posix.join(path.posix.dirname(f), s));
  return to === CORE_IO_DIR.slice(0, -1) || to.startsWith(CORE_IO_DIR);
};
/**
 * The bindings of an I/O module that do no I/O, by module: node:net's address helpers (isIP / isIPv4 / isIPv6 parse a
 * string; a BlockList matches addresses in memory) — an import naming only these is not I/O; any other form of the
 * import (another name, a default or namespace import, require(), import()) is.
 */
/** The one file of the engine that loads an adapter's code (its lazy imports). */
export const ENGINE_LOADER = 'packages/engine/src/lazy.ts';
/** Where the engine's renderer port, its adapters and the work on them live: the only engine folder that names the editor's render functions. */
export const RENDER_HOME = 'packages/engine/src/render/';
/** The engine's Clock port (clock-read): the one file of the engine that reads the wall clock for a stamp. */
export const CLOCK_HOME = 'packages/engine/src/clock.ts';
/** The project store's folder and the media storage (store-new): where a store or a storage of a folder is built. */
export const STORE_HOME = 'packages/engine/src/store/';
export const STORAGE_FILE = 'packages/engine/src/storage.ts';
/**
 * Where each product adapter of a port may be named as a value (clock-read, store-new): its own file, the ports bag
 * (packages/engine/src/ports.ts enginePorts: the one place the defaults are written) and the composition roots that
 * call it — createEngine, the jobs worker, the job process, the CLI's cliPorts — and the job queues' defaults (for
 * tests: the roots pass their clock, the queue check holds them to it).
 */
export const PORT_ROOTS = {
  systemClock: [CLOCK_HOME, 'packages/engine/src/ports.ts', 'packages/engine/src/jobs/queue.ts', 'packages/engine/src/jobs/memory-queue.ts'],
  enginePorts: ['packages/engine/src/ports.ts', 'packages/engine/src/engine.ts', 'packages/engine/src/jobs/worker.ts', 'packages/engine/src/jobs/job-child.ts', 'packages/cli/src/workspace.ts'],
  diskProjectStores: ['packages/engine/src/store/project-store.ts', 'packages/engine/src/ports.ts'],
  packageHookRunner: ['packages/engine/src/hook-run/package-hooks.ts', 'packages/engine/src/ports.ts'],
  packageReviewer: ['packages/engine/src/review/review-package.ts', 'packages/engine/src/ports.ts'],
  runnerWebCapture: ['packages/engine/src/capture/runner-web-capture.ts', 'packages/engine/src/ports.ts'],
  packageSandboxes: ['packages/engine/src/sandboxes/package-sandboxes.ts', 'packages/engine/src/ports.ts'],
};
/** The check that holds each product adapter of PORT_ROOTS to its roots (its entries: `<name> outside a root`). */
export const PORT_ROOT_RULE = { systemClock: 'clock-read', enginePorts: 'clock-read', diskProjectStores: 'store-new', packageHookRunner: 'loader-use', packageReviewer: 'loader-use', runnerWebCapture: 'loader-use', packageSandboxes: 'loader-use' };
/**
 * The loaders of lazy.ts held to a home (loader-use): each is imported from lazy.ts only in its port's folder, where the
 * port's package adapter lives. The editor's loader is not here: R9 and render-call hold the editor.
 */
export const LOADER_HOMES = { hooks: 'packages/engine/src/hook-run/', review: 'packages/engine/src/review/', thumbs: 'packages/engine/src/review/', runnerWeb: 'packages/engine/src/capture/', sandbox: 'packages/engine/src/sandboxes/' };
/**
 * The engine's port files (port-types): the interfaces its adapters satisfy, which name no adapter package — types
 * included — but through a domain entry (an adapter satisfies a port structurally: R2 forbids it the engine's types).
 */
export const PORT_FILES = [
  CLOCK_HOME,
  'packages/engine/src/store/store.ts',
  'packages/engine/src/jobs/job-queue.ts',
  'packages/engine/src/render/renderer.ts',
  'packages/engine/src/hook-run/runner.ts',
  'packages/engine/src/review/reviewer.ts',
  'packages/engine/src/capture/runner.ts',
  'packages/engine/src/sandboxes/sandboxes.ts',
];
/**
 * The editor's render entries: its functions that render (a video, stills, an export's formats, component previews)
 * and what makes its renderer or a part of one (the driver, the plan's part, the previews' part and their backend).
 * A render entry the editor exports and this list misses fails packages/core/test/import-rules.test.ts.
 */
export const RENDER_CALLS = ['renderVideo', 'renderStill', 'renderStills', 'renderPlan', 'renderComponentPreviews', 'renderComponentLoops', 'exportRender', 'createRenderer', 'planDriver', 'previewDriver', 'REMOTION_PREVIEW_BACKEND'];
/** The one module that names playwright-core's private browser registry (browser-registry, L7.25). */
export const BROWSER_REGISTRY_HOME = 'packages/core/src/io/browsers.ts';
/** The one module that starts the media tools, ffmpeg and ffprobe (media-call, L7.31). */
export const MEDIA_RUN_HOME = 'packages/core/src/io/media-run.ts';
export const PURE_BINDINGS = { 'node:net': ['isIP', 'isIPv4', 'isIPv6', 'BlockList'], net: ['isIP', 'isIPv4', 'isIPv6', 'BlockList'] };
export const RULES = [
  { id: 'R1', title: `core is I/O-free (domain; everything but its io side, ${CORE_IO_DIR}, which the rest never imports; a module loader — node:module, process.getBuiltinModule(), import() of a computed name — counts as I/O; node:net's address helpers ${PURE_BINDINGS['node:net'].join(', ')} do no I/O)`, files: (f) => pkgOf(f) === 'core' && !f.startsWith(CORE_IO_DIR), bad: (s, f) => IO.test(s) || coreIoImport(s, f), loaders: true, pure: PURE_BINDINGS },
  { id: 'R2', title: 'adapters never import application or shells', files: (f) => ADAPTERS.includes(pkgOf(f)), bad: (s) => ['engine', 'mcp', 'ui', 'cli'].includes(retake(s)) },
  { id: 'R3', title: 'shells never import another shell (ui→mcp, mcp→ui; cli is the composition root and may)', files: (f) => ['mcp', 'ui'].includes(pkgOf(f)), bad: (s, f) => { const p = retake(s); return !!p && SHELLS.includes(p) && p !== pkgOf(f); } },
  { id: 'R4', title: 'shells call the application only (no direct adapter import; the types of their domain entries are free — pure, no adapter code — a value of one is a hit like any adapter import)', files: (f) => SHELLS.includes(pkgOf(f)), bad: (s) => ADAPTERS.includes(retake(s)), typeOnlyCheck: (s) => DOMAIN_ENTRIES.includes(s) },
  { id: 'R5', title: 'the Studio front end imports types only from other packages (checked: any @retake value import, re-export, side-effect import or import() in src/app)', files: (f) => f.startsWith('packages/ui/src/app/'), bad: (s) => !!retake(s), typeOnlyCheck: true },
  { id: 'R6', title: 'shells do not touch the file system / processes themselves', files: (f) => ['packages/mcp/src/tools/', 'packages/ui/src/server/', 'packages/cli/src/commands/'].some((p) => f.startsWith(p)), bad: (s) => /^(node:)?(fs|fs\/promises|child_process)$/.test(s) },
  { id: 'R7', title: 'the planner and review checks stay renderer-free (editor/review pure modules; for the review: REVIEW_PURE)', files: (f) => /packages\/editor\/src\/(plan|plan-entry|plan-types|render-record|timing|camera|layout|panes|timeline|resolve|tutorial|summary|util|remotion\/frames|planner\/[a-z-]+)\.ts$/.test(f) || reviewPure(f), bad: (s) => IO.test(s) || /^remotion|^react/.test(s) },
  { id: 'R8', title: 'the review imports the editor only through its planner entry (@retake/editor/plan: loads no renderer, Remotion, React or esbuild)', files: (f) => pkgOf(f) === 'review', bad: (s) => retake(s) === 'editor' && s !== '@retake/editor/plan' },
  { id: 'R9', title: `the engine loads the editor's code in its loader only (${ENGINE_LOADER}): everywhere else in packages/engine/src a value import, re-export, import() or require() of @retake/editor is a hit, and so is a loader that could load it unseen — import() of a computed name, a call of a require made with createRequire, process.getBuiltinModule() (its types are free, and so is createRequire(…).resolve(), which loads nothing; the other adapters' loaders are not checked yet)`, files: (f) => f.startsWith('packages/engine/src/') && f !== ENGINE_LOADER, bad: (s) => retake(s) === 'editor', typeOnlyCheck: true, loaders: true },
  { id: 'R11', title: `the engine imports the adapter packages as types only outside its loader (${ENGINE_LOADER}; the editor is R9's): a value import, re-export or import() of runner-web, review, sandbox, hooks or components is a hit; their domain entries are free (the editor's, @retake/editor/plan, is not: R9 holds the editor whole). Not seen: a value reached through another engine file (the loader included) and \`typeof import()\` in a type position, which loads nothing`, files: (f) => f.startsWith('packages/engine/src/') && f !== ENGINE_LOADER, bad: (s) => ADAPTERS.includes(retake(s)) && retake(s) !== 'editor' && !DOMAIN_ENTRIES.includes(s), typeOnlyCheck: true },
  { id: 'R12', title: "the review's pure modules (REVIEW_PURE) import the components through their geometry entry only (@retake/components/geometry: no renderer, no registry, no compile check), types included", files: reviewPure, bad: (s) => retake(s) === 'components' && s !== '@retake/components/geometry' },
  { id: 'R13', title: "a relative import never leaves its package (another package is imported by its name, so that the layer rules, which read names, see it: `../../sandbox/dist/index.js` would compile and be invisible to R2, R4 and R11)", files: () => true, bad: (s, f) => s.startsWith('.') && !path.posix.normalize(path.posix.join(path.posix.dirname(f), s)).startsWith(`packages/${pkgOf(f)}/`) },
];

export const CHECKS = [
  ...RULES.map((r) => ({ id: r.id, title: r.title })),
  { id: 'R10', title: 'the rendering library (`remotion`, `@remotion/*`) is named in its seam files only (LIBRARY_SEAMS: each with the packages it may load or resolve; the built-in components and the scaffolds name it nowhere): a static, type or dynamic import, a re-export, a require, a `resolve()` of its path, a seam file re-exported wholesale by another file, or a seam file that hands the library on imported from outside its folder (LIBRARY_SEAM_IMPORTERS). Not seen: a specifier computed at run time (LIBRARY_COMPUTED_READS), a require reached under another name, the library\'s name inside a data string, what a seam file itself exports, and tests, scripts, fixtures and apps' },
  { id: 'cycle', title: 'no import cycle between the files of a package (entries: each file and the first file of its cycle, and the number of imports inside the cycle)' },
  { id: 'queue', title: 'only the composition roots build the file job queue (`new FileJobQueue`, a class extending it, or the class itself passed on as a value): the engine, the worker, the job process and the CLI\'s workspaceQueue (and the adapter itself, for withOwnMemory); everything else is handed the JobQueue port. And each of them hands it its clock: a `new FileJobQueue(…)` with fewer than three arguments, or a third that is `undefined` or `void 0`, anywhere in packages/*/src outside the adapter\'s own file is a hit (`without a clock`; its default is for tests; a variable that holds undefined is not seen)' },
  { id: 'clock-read', title: `the engine stamps what it writes with its Clock port (${CLOCK_HOME}): in packages/engine/src outside it, every wall-clock read is counted per file — \`new Date()\` with no argument, \`Date.now\` (called or passed on as a value, \`Date['now']\` too) and \`Date()\` called as a function — and the pinned files are elapsed time, deadlines, memo lifetimes and file times, never a stamp (entries: each file and its count); and the product's ports are named at the composition roots only: \`systemClock\` and \`enginePorts\` as values anywhere in packages/*/src outside PORT_ROOTS (a default parameter included; import and export declarations are not uses). Also read: a name imported under another (\`{ systemClock as sc }\`), a member of a namespace import (\`k.systemClock\`, \`k['enginePorts']\`) and \`now\` taken out of \`Date\` by a pattern (\`const { now } = Date\`). Not seen: \`globalThis.Date\`, \`Date\` or a port under another name made in the file (\`const D = Date\`, \`const c = systemClock\` then \`c\`: the first is counted, not the uses), a name reached through \`Reflect\`, \`Function.prototype.call\` or a computed key, a namespace from \`await import()\`, and \`performance.now()\`, which is allowed (elapsed time)` },
  { id: 'store-new', title: `only the project store builds a store or a storage of a folder: in packages/*/src outside ${STORE_HOME} and ${STORAGE_FILE}, \`new LocalStorage(…)\`, \`new DiskProjectStore(…)\`, a class extending either, or either class passed on as a value is a hit, and so is the disk adapter \`diskProjectStores\` named as a value outside PORT_ROOTS (entries: the file and the form; a type position, an import and an export are not uses), under its own name, an import alias (\`{ LocalStorage as LS }\`) or off a namespace import (\`new st.LocalStorage()\`, \`ps.diskProjectStores\`): every authored write is handed a ProjectStores port in its StoreScope. Not seen: \`Reflect.construct(LocalStorage, …)\` counted only as the class used as a value, a class reached through another variable, a namespace from \`await import()\`` },
  { id: 'loader-use', title: `each adapter loader of ${ENGINE_LOADER} is imported in its home only (LOADER_HOMES: \`hooks\` in hook-run/, \`review\` and \`thumbs\` in review/, \`runnerWeb\` in capture/, \`sandbox\` in sandboxes/ — where its port's package adapter lives), in packages/engine/src: a loader imported from the loader file outside its home (under an alias too: \`loader-use:<name>\`), the loader file imported whole (\`import * as\`, a default import, \`import lazy = require(…)\`) or by \`import()\` / \`require()\` of its name, and a loader re-exported anywhere (\`export { review }\`, \`export { review } from\`, \`export * from\` the loader file: \`<name> re-exported\`); and the product's adapters of those ports, \`packageHookRunner\`, \`packageReviewer\`, \`runnerWebCapture\` and \`packageSandboxes\`, named as values outside PORT_ROOTS (\`<name> outside a root\`, read as clock-read reads its names). Not seen: the editor's loader (R9 and render-call hold the editor), \`import(p)\` or \`require(p)\` of a name computed at run time (R9 counts a computed \`import()\` as a loader), a loader taken under another name and exported that way (\`export const load = review\`, a wrapper function), a value of the adapter that a file of the home hands on under a name of its own (the work on the port, on purpose), a loader reached through another engine module that imported it` },
  { id: 'port-types', title: `the engine's port files (PORT_FILES) name no adapter package — a type import, \`typeof import()\` and a value alike (entries: the file and the specifier) — but through a domain entry (DOMAIN_ENTRIES): an adapter satisfies a port structurally, so the vocabulary they share lives in core or a domain entry. Not seen: what a port file names through a relative engine module (not followed)` },
  { id: 'shell-op', title: 'an operation is defined in the engine (packages/engine/src/operations/, U7): in the shells\' sources (SHELL_OP_DIRS: packages/mcp/src, packages/ui/src) every call of `defineTool` or `defineOperation` — by its name, an import alias or a member of a namespace import — is counted per file (entries: each file and its count), so that an operation moved into the engine lowers the baseline and a new one in a shell fails it; and in packages/*/src outside DEFINER_HOMES (the engine\'s operations/, MCP\'s tools/define.ts) a definer re-exported under another name (`export { defineTool as op }`) is a hit. Not seen: a definer under another name made in a file (`const d = defineTool`), a wrapper of one, a parenthesised or computed callee (`(defineTool)(…)`, `c[name](…)`), a member of a namespace from `await import()`, and an operation written as a `ToolDef` object literal with no definer' },
  { id: 'hook-call', title: 'the hooks use cases outside a capture are orchestrated in the engine only (packages/engine/src/hooks-work.ts, U8b: shared by the CLI\'s `hooks run` / `hooks rollback` / `env reset` and the jobs): in packages/*/src outside packages/engine/src every call of `createHookContext` (by its name, an import alias or a member of a namespace import), of `hooks.run` (on something named `hooks`, also `x.hooks`) and of `journals.rollback|openPending|rollbackPending` (on something named `journals`, also `x.journals`), and in the shells (cli, mcp, ui) of `.rollbackAll` on anything, is counted per file (entries: each file and its count; the adapters replay their own journals). Read through parentheses, a comma (`(0, hooks.run)(…)`), a cast or `!`, and as `.call` / `.apply` / `.bind` of a counted function. Not seen: a destructured member (`const { run } = hooks`), a member or port held in a variable (`const r = hooks.run`, `const h = ports.hooks` then `h.run`), a dynamic import\'s destructuring (`const { createHookContext } = await import(…)`) or namespace, an import-equals alias (`import c = e.createHookContext`), a key computed at run time' },
  { id: 'browser-registry', title: `playwright-core's private modules (\`playwright-core/lib/…\`: its browser registry) are named in ${BROWSER_REGISTRY_HOME} only (U14, finding X9: one browser-discovery module; each caller hands it its own require): in packages/*/src elsewhere, every string or template that holds \`playwright-core/lib/\` is counted per file (entries: each file and its count). Not seen: the path put together from pieces (\`'playwright-core' + '/lib'\`), a specifier computed at run time, and everything outside packages/*/src` },
  { id: 'media-call', title: `the media tools (ffmpeg, ffprobe) are started in ${MEDIA_RUN_HOME} only (U11, finding X3: one wrapper for their runs — arguments, time limits, cancels, stderr — and one error type): in packages/*/src elsewhere, a file that names a media tool (an identifier holding \`ffmpeg\` or \`ffprobe\`, such as ffmpegBin, or a string or template holding either word) and calls node:child_process to start a process (\`spawn\`, \`spawnSync\`, \`execFile\`, \`execFileSync\`, \`exec\`, \`execSync\`, \`fork\`: by its name, an import alias or a member of a namespace or default import, by a key spelt as a string or a template without substitution; read through parentheses, a comma, a cast or \`!\`, and as \`.call\` / \`.apply\` / \`.bind\` of a starter) is counted, its calls per file (entries: each file and its count); a type import of the module starts nothing. Not seen: a file that starts a program whose name it reads elsewhere and names no media tool, a call reached through another module or under another name made in the file (\`const run = execFile\`, a destructured member), an import-equals alias (\`import cp = require('node:child_process')\`), a key computed at run time or a template key with a substitution (\`cp[\`ex${'${'}k}\`]\`), \`require('node:child_process')\` and a namespace from \`await import()\`, and everything outside packages/*/src` },
  { id: 'queue-call', title: 'outside packages/engine/src nothing submits to the job queue or writes as its worker (`queue.enqueue|write|claim|unclaim|setYield|append|exclusive(…)`, also `x.queue.…`): the engine\'s operations submit after their checks (under the queue\'s lock: `exclusive`), the worker writes' },
  { id: 'render-call', title: `the editor's render entries (${RENDER_CALLS.join(', ')}) are named in ${RENDER_HOME} only — the work on the renderer port — never elsewhere in the engine nor in a shell: read from the syntax tree, as a property (\`ed.renderVideo\`, \`ed['renderVideo']\`, a key spelt in pieces: \`ed['render' + 'Video']\`), a destructured name in a declaration or an assignment (\`{ renderVideo }\`, \`({ renderVideo: f } = ed)\`), a shorthand name, an alias (\`import f = ed.renderVideo\`), or a value imported or re-exported from @retake/editor (\`export *\` too); a type position, a comment and a string are not uses. Known limit: a key only known at run time (\`ed[name]\`) cannot be read from the text: nothing in the file names the function` },
  { id: 'policy-state', title: 'no module-level variable (`let` / `var`) of core, the engine or an adapter holds the policy work runs under — one named after a policy, its agent folders, ffmpeg / ffprobe, a program check or render settings, or typed or set with WorkPolicy, RenderSettings, RenderPolicy or ProgramPolicyOptions: the policy is a value (core WorkPolicy) the engine passes to the adapters' },
  { id: 'layout', title: 'the folder layout of a workspace and its projects is written in packages/core/src/layout.ts only (entries: each file and how many layout paths it spells by hand — a string or template naming `.retake`, a layout file or `<layout folder>/…` anywhere, or a layout folder as a node:path `join(…)` / `resolve(…)` argument)' },
  { id: 'id-grammar', title: 'the grammars of the run id, the render id, the ULID ids and the theme names are written in their two homes only (ID_HOMES; the Studio front end has one mirror, ID_MIRRORS), in packages/*/src (entries: each file and how many id patterns it writes by hand — (1) a regular expression, string or template holding the date stamp `\\d{8}-\\d{6}`, the version suffix `-v\\d` / `-v(\\d` (whatever follows the digit: `+`, `{1,6}`; a named or a non-capturing group) or the ULID character class; (2) a string holding the ULID alphabet; (3) a regular expression, or a string (what `new RegExp` is given), that is the run-folder grammar or a theme-name grammar, a final `{0,N}` read as `*`; (4) a template with a text part ending in `-v`, or starting with a ULID prefix before a substitution; (5) a string or template part starting with `-vertical` or `-square`; (6) a capped grammar used without its cap: `.test()` / `.exec()` on RUN_ID_RE, RENDER_ID_RE, ANY_THEME_NAME_RE or NEW_THEME_NAME_RE, or one of them handed to `.match()` / `.matchAll()` / `.search()` / `.replace()` / `.split()`, or to the `.regex()` of a schema — with or without a `.max()` beside it: the `z…` helpers of ids.ts hold the cap). Not seen: a grammar spelt another way (`[0-9]{8}`, a character class in another order), a pattern put together from pieces or by `+` (`s + \'-v\' + n`), a capped grammar reached under another name or handed to a helper, a parser made of `.startsWith(\'j_\')` / `.slice(2)` / `.split(\'-\')`, the mirror\'s patterns used without their caps, and everything outside packages/*/src (tests, scripts, fixtures, the desktop shell, docs)' },
  { id: 'record-read', title: 'a run.json, a timeline.json or a render record (renders/*.json) is read in one place (RECORD_READ_HOME: the readers answer a record or a typed problem), in packages/*/src (entries: each file and how many times it gives a value the type of a run record, a timeline or a render record without the reader (RECORD_READ_TYPES; also inside `Partial<…>`, a union, a list or a `Promise<…>`; a member\'s type such as `RunRecord[\'status\']` is not one) — the result of `JSON.parse(…)` or of a `readJson(…)` call typed (1) by a cast (`as T`, `as unknown as T`, `<T>…`, through `await`, parentheses and `!`), (2) by a type argument (`readJson<T>(…)`), (3) by the annotation of the variable it initialises, (4) by the declared return type of the function that returns it; (5) any other value cast to one of those types, wherever it came from; (6) a type guard or an assertion function that says a value is one (`v is T`, `asserts v is T`); (7) a call that names one as its type argument (`cast<T>(…)`: a generic cast helper); (8) a parse through a record\'s or a timeline\'s schema itself (RECORD_READ_SCHEMAS: `.parse(…)`, `.safeParse(…)` — typed, and past the reader\'s link, size and version rules); (9) an interface that extends one; and, for each file of RECORD_READ_OWN — the files that read a run folder\'s or renders/\'s file on their own, on purpose, into a shape of their own — every `JSON.parse(…)` it holds, so that such a read is an entry with its reason and one more is a new entry). The types counted include the render record\'s base types under their own names (RenderBase, StoredRenderBase, RenderFields) and the answers that hold a record (NamedRenderFound, FoundRender, FoundReviewRender). Not seen: a type under an alias or an own interface of the same members (outside RECORD_READ_OWN, that is how a file would read a record out of sight — a render record\'s members copied into a view of the engine\'s are such an interface, on purpose); a `JSON.parse(…)` of a record in a file that reads a record on its own and is not in RECORD_READ_OWN, into an untyped value or a shape of its own; a file\'s own bytes handed to the reader\'s parsers (parseRunRecord, parseTimeline, parseRenderRecord: the type is the reader\'s, the link, size and version rules are the caller\'s); a stored record\'s plan typed as an edit plan by a member\'s type (`StoredRender[\'plan\']` is a member\'s type, not a record); an untyped (`any`) parse result that reaches a record without a cast — behind a helper of another name, or assigned, returned or passed in a later statement; a property or a parameter typed so; and everything outside packages/*/src (tests, scripts, fixtures, the desktop shell)' },
];

function parse(ts, rel, text) {
  // A .js / .mjs / .cjs file is read as TSX too: JSX is legal there for a bundler, and its imports parse the same.
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, /\.(ts|mts|cts)$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
}

const literal = (ts, e) => (e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined);

/**
 * The module specifiers of every import and export declaration of a file, read from its syntax tree: `import … from`,
 * `import '…'`, `export … from`, `export * from`, `export * as ns from`, `import x = require('…')`, type-only ones
 * included, in the order written.
 */
export function declaredSpecifiers(ts, rel, text) {
  const out = [];
  (function visit(n) {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const spec = literal(ts, n.moduleSpecifier);
      if (spec !== undefined) out.push(spec);
      return;
    }
    if (ts.isImportEqualsDeclaration(n)) {
      const spec = ts.isExternalModuleReference(n.moduleReference) ? literal(ts, n.moduleReference.expression) : undefined;
      if (spec !== undefined) out.push(spec);
      return;
    }
    n.forEachChild(visit);
  })(parse(ts, rel, text));
  return out;
}

/**
 * Every module specifier of a file: the compiler's pre-processor's list as it gives it (static, `import type`,
 * `import()`, `require()`, `typeof import()`), then the declarations it does not list — TypeScript 5.9's pre-processor
 * misses a namespace re-export (`export * as ns from '…'`), which the syntax tree has.
 */
export function specifiersOf(ts, rel, text) {
  const specs = ts.preProcessFile(text, true, true).importedFiles.map((x) => x.fileName);
  const listed = new Set(specs);
  for (const s of declaredSpecifiers(ts, rel, text)) if (!listed.has(s)) { listed.add(s); specs.push(s); }
  return specs;
}

/**
 * What a file loads, read from its syntax tree: `values`, the module specifiers it imports or re-exports as values (an
 * `import`, `export … from`, `export *`, side-effect `import '…'`, `import x = require()`, `import()` or `require()` call;
 * not `import type`, `export type` nor an import whose every name is `type`), and `loaders`, its run-time module loaders
 * (`getBuiltinModule()` calls, `import()` of a computed name, a call of a require made with `createRequire`);
 * `statics`, the values loaded by a declaration (when the file itself loads, not on a call): everything of `values`
 * but `import()` and `require()` calls.
 */
export function moduleUses(ts, rel, text) {
  const values = new Set();
  const statics = new Set();
  const loaders = new Set();
  const allTypes = (els) => els.length > 0 && els.every((e) => e.isTypeOnly);
  const sf = parse(ts, rel, text);
  // The names a `createRequire(…)` result is kept under (a variable or an assignment), whatever createRequire is called.
  const requires = new Set();
  const inner = (e) => { while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))) e = e.expression; return e; };
  const makesRequire = (e) => { e = inner(e); return !!e && ts.isCallExpression(e) && ((ts.isIdentifier(e.expression) && e.expression.text === 'createRequire') || (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'createRequire')); };
  if (text.includes('createRequire')) {
    (function collect(n) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && makesRequire(n.initializer)) requires.add(n.name.text);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && makesRequire(n.right)) requires.add(n.left.text);
      n.forEachChild(collect);
    })(sf);
  }
  const madeRequire = (callee) => { callee = inner(callee); return makesRequire(callee) || (!!callee && ts.isIdentifier(callee) && requires.has(callee.text)); };
  (function visit(n) {
    if (ts.isImportDeclaration(n)) {
      const c = n.importClause;
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings) && allTypes(c.namedBindings.elements)));
      const spec = literal(ts, n.moduleSpecifier);
      if (spec !== undefined && !typeOnly) { values.add(spec); statics.add(spec); }
      return;
    }
    if (ts.isExportDeclaration(n)) {
      const spec = literal(ts, n.moduleSpecifier);
      const typeOnly = n.isTypeOnly || (!!n.exportClause && ts.isNamedExports(n.exportClause) && allTypes(n.exportClause.elements));
      if (spec !== undefined && !typeOnly) { values.add(spec); statics.add(spec); }
      return;
    }
    if (ts.isImportEqualsDeclaration(n)) {
      const spec = ts.isExternalModuleReference(n.moduleReference) ? literal(ts, n.moduleReference.expression) : undefined;
      if (spec !== undefined && !n.isTypeOnly) { values.add(spec); statics.add(spec); }
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
      // A require made with createRequire and called (`createRequire(x)('m')`, `const req = createRequire(x); req('m')`):
      // it loads a module the pre-processor never lists. `.resolve()` on it loads nothing and is not a call of it.
      if (madeRequire(callee)) loaders.add('createRequire()()');
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
      if (name === 'getBuiltinModule') loaders.add('getBuiltinModule()');
    }
    n.forEachChild(visit);
  })(sf);
  return { values, statics, loaders };
}

/**
 * Whether every import of `spec` in a file names only bindings of `allowed` (named imports; a type-only import or
 * binding loads nothing and is left out); false
 * when the module is imported any other way (a default or namespace import, a side-effect import, an `export … from`,
 * `import x = require()`, `require()` or `import()`), or not at all.
 */
export function importsOnly(ts, rel, text, spec, allowed) {
  let ok = true;
  let seen = false;
  (function visit(n) {
    if (!ok) return;
    if (ts.isImportDeclaration(n) && literal(ts, n.moduleSpecifier) === spec) {
      seen = true;
      const c = n.importClause;
      if (c?.isTypeOnly) return;
      const b = c?.namedBindings;
      if (!c || c.name || !b || !ts.isNamedImports(b) || !b.elements.every((e) => e.isTypeOnly || allowed.includes((e.propertyName ?? e.name).text))) ok = false;
      return;
    }
    if (ts.isExportDeclaration(n) && literal(ts, n.moduleSpecifier) === spec) { ok = false; return; }
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && literal(ts, n.moduleReference.expression) === spec) { ok = false; return; }
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && literal(ts, n.arguments[0]) === spec) { ok = false; return; }
    n.forEachChild(visit);
  })(parse(ts, rel, text));
  return ok && seen;
}

/**
 * Rule hits as `[{ rule, file, spec }]`, one per specifier the pre-processor lists (a file importing a module twice
 * gives the hit twice; ratchetEntries keeps one entry per rule, file and import). A type-only rule (`typeOnlyCheck`:
 * true, or a function saying for which specifiers — R4's domain entries) keeps the
 * specifiers the file loads as values, and the I/O rule of core (R1) adds the file's run-time module loaders, both read
 * from the syntax tree; a file that cannot be read counts as loading every one of its specifiers as a value.
 */
export function ruleHits(root, fileImports, rules = RULES) {
  const ts = (rules.some((r) => r.typeOnlyCheck || r.loaders || r.pure) && loadTs(root)) || undefined;
  const uses = new Map();
  const texts = new Map();
  const textOf = (f) => {
    if (!texts.has(f)) {
      try {
        texts.set(f, fs.readFileSync(path.join(root, f), 'utf8'));
      } catch {
        texts.set(f, undefined);
      }
    }
    return texts.get(f);
  };
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
        if (typeof r.typeOnlyCheck === 'function' ? r.typeOnlyCheck(s, f) : r.typeOnlyCheck) {
          const u = usesOf(f);
          if (u && !u.values.has(s)) continue;
        }
        if (r.pure && Object.hasOwn(r.pure, s)) {
          const text = textOf(f);
          if (text !== undefined && importsOnly(ts, f, text, s, r.pure[s])) continue;
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
/** The file queue's own file: its withOwnMemory() hands its clock on through `this.clock`, its constructor has the default. */
const QUEUE_ADAPTER = 'packages/engine/src/jobs/queue.ts';
const queueRoot = (rel) => QUEUE_ROOTS.includes(rel);
/** The queue's submit and the worker's writes (JobQueue minus JobQueueView): called inside packages/engine/src only. */
const QUEUE_WRITES = new Set(['enqueue', 'write', 'claim', 'unclaim', 'setYield', 'append', 'exclusive']);
const queueCallsAllowed = (rel) => rel.startsWith('packages/engine/src/');
/** Where the render-call check looks: the engine outside its render folder, and the shells. */
const renderCallsChecked = (rel) => (rel.startsWith('packages/engine/src/') && !rel.startsWith(RENDER_HOME)) || SHELLS.some((s) => rel.startsWith(`packages/${s}/src/`));
const RENDER_CALL_SET = new Set(RENDER_CALLS);
/** A cheap pre-filter: a render entry spelt whole, or anything a key could be put together from (a `+` or a template beside a quote). */
const RENDER_CALL_TEXT = new RegExp(`${RENDER_CALLS.join('|')}|['"\`]\\s*\\+|\\+\\s*['"\`]|\\$\\{|@retake/editor`);
/**
 * The text an expression spells when it can be read without running it: a string or template literal, pieces joined
 * with `+`, a template of such pieces, in parentheses or under a cast; undefined for anything known only at run time.
 */
const constText = (ts, e) => {
  if (!e) return undefined;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || (ts.isSatisfiesExpression?.(e) ?? false)) return constText(ts, e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = constText(ts, e.left);
    const r = constText(ts, e.right);
    return l === undefined || r === undefined ? undefined : l + r;
  }
  if (ts.isTemplateExpression(e)) {
    let out = e.head.text;
    for (const span of e.templateSpans) {
      const v = constText(ts, span.expression);
      if (v === undefined) return undefined;
      out += v + span.literal.text;
    }
    return out;
  }
  return undefined;
};
/** The name a property key spells (`a`, `'a'`, `['a']`, `['a' + 'b']`), undefined when it is computed at run time. */
const keyText = (ts, name) => (!name ? undefined : ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : ts.isComputedPropertyName(name) ? constText(ts, name.expression) : undefined);
/** Whether an object literal is written to, not read: the left side of `=`, a `for … of` target, or nested in one. */
const assignedTo = (ts, obj) => {
  let n = obj;
  for (;;) {
    const p = n.parent;
    if (!p) return false;
    if (ts.isParenthesizedExpression(p)) { n = p; continue; }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return p.left === n;
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === n;
    // Nested patterns: `({ a: { renderVideo: f } } = x)`, `[{ renderVideo: f }] = xs`, a default (`{ … } = {}` inside).
    if ((ts.isPropertyAssignment(p) && p.initializer === n) || ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) { n = p; continue; }
    return false;
  }
};
/** The packages where the work's policy is passed as a value (core WorkPolicy): core, the engine and the adapters. */
const POLICY_VALUE_PACKAGES = ['core', 'engine', ...ADAPTERS];
/** A module-level variable named for the policy's state (what the process-wide setters before WorkPolicy held). */
const POLICY_STATE_NAME = /polic|agentfolders|ffmpeg|ffprobe|programcheck|rendersettings|workspacerender/i;
/** A module-level variable typed or set with the policy's types. */
const POLICY_STATE_TYPE = /\b(?:WorkPolicy|RenderSettings|RenderPolicy|ProgramPolicyOptions)\b/;

/**
 * The wiring rules, read from the syntax tree: outside the composition roots (QUEUE_ROOTS, the CLI), `new FileJobQueue(…)`, a class extending it and
 * any other use of the class as a value (`const Q = FileJobQueue`, a destructured `{ FileJobQueue }`, `ns.FileJobQueue`
 * passed on), under its own name, an import alias or `ns.name` (a type position is not a use); outside
 * packages/engine/src, a call of the queue's submit or of a worker's write on something named `queue` (`queue.claim(…)`,
 * `engine.queue.enqueue(…)`, `this.queue['write'](…)`). Declarations, imports and re-exports are not uses. And in core,
 * the engine and the adapters, a module-level `let` / `var` (exported or not, a destructured name too) that holds the
 * work's policy — named after it (POLICY_STATE_NAME) or typed or set with its types (POLICY_STATE_TYPE): the policy is a
 * value the engine passes on, never state a setter changes (a `const` of such a type is a value, not state). And in the
 * engine outside RENDER_HOME and in the shells, one of the editor's render functions (RENDER_CALLS) taken off anything:
 * a property (`ed.renderVideo`, `ed['renderVideo']`, `ed['render' + 'Video']`, called or not), a destructured name in a
 * declaration or an assignment (`{ renderVideo }`, `{ renderVideo: f }`, `({ renderVideo: f } = ed)`), a shorthand
 * property, an alias (`import f = ed.renderVideo`), or a value imported or re-exported from @retake/editor under any
 * local name. A key computed at run time (`ed[name]`) is the check's limit: nothing in the text names the function.
 */
export function wiringHits(root, files) {
  const ts = loadTs(root);
  const hits = [];
  for (const { rel, text } of files) {
    const queue = !queueRoot(rel) && text.includes(QUEUE_CLASS);
    // Every construction but the adapter's own hands the queue its clock (the roots included).
    const queueClock = rel !== QUEUE_ADAPTER && text.includes(QUEUE_CLASS);
    const calls = !queueCallsAllowed(rel) && text.includes('queue');
    const state = POLICY_VALUE_PACKAGES.includes(pkgOf(rel)) && /\b(?:let|var)\b/.test(text);
    const render = renderCallsChecked(rel) && RENDER_CALL_TEXT.test(text);
    if (!queue && !queueClock && !calls && !state && !render) continue;
    const sf = parse(ts, rel, text);
    if (state) for (const name of policyStateNames(ts, sf)) hits.push({ rule: 'policy-state', file: rel, spec: `let ${name}` });
    if (!queue && !queueClock && !calls && !render) continue;
    const names = new Map([[QUEUE_CLASS, QUEUE_CLASS]]); // local name → original
    const found = new Set();
    sf.forEachChild(function imports(n) {
      if (ts.isImportSpecifier(n)) {
        const orig = (n.propertyName ?? n.name).text;
        if (names.has(orig)) names.set(n.name.text, orig);
        // A render function imported from the editor as a value (under any local name).
        const decl = n.parent.parent.parent;
        const typeOnly = n.isTypeOnly || n.parent.parent.isTypeOnly;
        if (render && !typeOnly && RENDER_CALL_SET.has(orig) && ts.isImportDeclaration(decl) && retake(literal(ts, decl.moduleSpecifier) ?? '') === 'editor') found.add(`render-call:${orig}`);
      }
      // A render entry re-exported from the editor (`export { renderVideo } from`, `export * from`, `export * as ed from`):
      // the file would hand it on under its own name.
      if (render && ts.isExportDeclaration(n) && !n.isTypeOnly && retake(literal(ts, n.moduleSpecifier) ?? '') === 'editor') {
        if (!n.exportClause || ts.isNamespaceExport(n.exportClause)) found.add('render-call:export * from @retake/editor');
        else for (const e of n.exportClause.elements) if (!e.isTypeOnly && RENDER_CALL_SET.has((e.propertyName ?? e.name).text)) found.add(`render-call:${(e.propertyName ?? e.name).text}`);
      }
      n.forEachChild(imports);
    });
    const nameOf = (e) => (ts.isIdentifier(e) ? names.get(e.text) : ts.isPropertyAccessExpression(e) && names.has(e.name.text) && e.name.text === names.get(e.name.text) ? e.name.text : undefined);
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
      if (queueClock && !typeHere && ts.isNewExpression(n) && nameOf(n.expression) === QUEUE_CLASS) {
        // Fewer than three arguments, or a third that says none: `undefined`, `void 0` (the adapter's default would apply).
        const c = n.arguments?.[2];
        const none = !c || (ts.isIdentifier(c) && c.text === 'undefined') || ts.isVoidExpression(c);
        if (none) found.add(`queue:new ${QUEUE_CLASS} without a clock`);
      }
      if (queue && !typeHere && ts.isHeritageClause(n) && n.types.some((t) => nameOf(t.expression) === QUEUE_CLASS)) found.add(`queue:extends ${QUEUE_CLASS}`);
      if (queue && !typeHere) {
        const ref = (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) && nameOf(n) === QUEUE_CLASS && !notAValue(n);
        const destructured = ts.isBindingElement(n) && named(n.propertyName ?? n.name, QUEUE_CLASS);
        const indexed = ts.isElementAccessExpression(n) && named(n.argumentExpression, QUEUE_CLASS);
        const shorthand = ts.isShorthandPropertyAssignment(n) && names.get(n.name.text) === QUEUE_CLASS;
        const aliased = ts.isImportEqualsDeclaration(n) && ts.isQualifiedName(n.moduleReference) && n.moduleReference.right.text === QUEUE_CLASS; // import Q = ns.FileJobQueue
        if (ref || destructured || indexed || shorthand || aliased) found.add(`queue:${QUEUE_CLASS} as a value`);
      }
      if (render && !typeHere) {
        // Any way a render function is taken off something: called or not, so an alias (`const f = ed.renderVideo`) counts.
        const member = ts.isPropertyAccessExpression(n) ? n.name.text
          : ts.isElementAccessExpression(n) ? constText(ts, n.argumentExpression)
            : ts.isBindingElement(n) ? (n.propertyName ? keyText(ts, n.propertyName) : ts.isIdentifier(n.name) ? n.name.text : undefined)
              : ts.isShorthandPropertyAssignment(n) ? n.name.text
                // An assignment's pattern: `({ renderVideo: f } = ed)` (a key being defined in an object that is read is not a use).
                : ts.isPropertyAssignment(n) && assignedTo(ts, n.parent) ? keyText(ts, n.name)
                  // `import f = ed.renderVideo` (an alias of a namespace's member).
                  : ts.isImportEqualsDeclaration(n) && ts.isQualifiedName(n.moduleReference) ? n.moduleReference.right.text
                    : undefined;
        if (member !== undefined && RENDER_CALL_SET.has(member)) found.add(`render-call:${member}`);
      }
      if (calls && ts.isCallExpression(n)) {
        const callee = n.expression;
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isElementAccessExpression(callee) ? literal(ts, callee.argumentExpression) : undefined;
        const on = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? callee.expression : undefined;
        const queueNamed = !!on && ((ts.isIdentifier(on) && on.text === 'queue') || (ts.isPropertyAccessExpression(on) && on.name.text === 'queue'));
        if (method && QUEUE_WRITES.has(method) && queueNamed) found.add(`queue-call:queue.${method}`);
      }
      n.forEachChild((c) => visit(c, typeHere));
    })(sf);
    for (const k of found) { const i = k.indexOf(':'); hits.push({ rule: k.slice(0, i), file: rel, spec: k.slice(i + 1) }); }
  }
  return hits;
}

/** The names of the module-level `let` / `var` declarations of `sf` that hold the work's policy (wiringHits). */
function policyStateNames(ts, sf) {
  const out = [];
  const bound = (n, into) => {
    if (ts.isIdentifier(n)) into.push(n.text);
    else for (const e of n.elements) if (!ts.isOmittedExpression(e)) bound(e.name, into);
  };
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || st.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using)) continue;
    for (const d of st.declarationList.declarations) {
      const names = [];
      bound(d.name, names);
      const typed = [d.type, d.initializer].some((x) => x && POLICY_STATE_TYPE.test(x.getText(sf)));
      for (const name of names) if (typed || POLICY_STATE_NAME.test(name)) out.push(name);
    }
  }
  return out;
}

/** The classes of a folder's store or storage (store-new). */
const STORE_CLASSES = new Set(['LocalStorage', 'DiskProjectStore']);

/**
 * The ports' wiring, read from the syntax tree (clock-read, store-new). In packages/engine/src outside CLOCK_HOME, the
 * wall-clock reads of each file, counted: `new Date` with no argument, `Date.now` taken off `Date` in any way (a
 * property, `Date['now']`, called or not) and `Date()` called; in packages/*\/src, `systemClock`, `enginePorts` and
 * `diskProjectStores` used as values outside their PORT_ROOTS, and outside STORE_HOME and STORAGE_FILE a store or a
 * storage built (`new LocalStorage`, `new DiskProjectStore`), extended or passed on as a value. Import and export
 * declarations, a declaration's own name, a property name and type positions are not uses. `{ clock: [{ file, count,
 * lines }], hits: [{ rule, file, spec }] }`.
 */
export function portHits(root, files) {
  const ts = loadTs(root);
  const clock = [];
  const hits = [];
  const NAMED = Object.keys(PORT_ROOTS);
  for (const { rel, text } of files) {
    const reads = rel.startsWith('packages/engine/src/') && rel !== CLOCK_HOME && /\bDate\b/.test(text);
    const named = NAMED.filter((n) => !PORT_ROOTS[n].includes(rel) && text.includes(n));
    const stores = !rel.startsWith(STORE_HOME) && rel !== STORAGE_FILE && [...STORE_CLASSES].some((c) => text.includes(c));
    if (!reads && !named.length && !stores) continue;
    const sf = parse(ts, rel, text);
    const lines = [];
    const found = new Set();
    const watched = new Set([...named, ...(stores ? STORE_CLASSES : [])]);
    // The import map (as wiringHits keeps one): a watched name imported under another (`{ systemClock as sc }`), and
    // the namespaces imported whole (`import * as k`), whose `k.systemClock` / `k['systemClock']` is the name too.
    const local = new Map();
    const spaces = new Set();
    sf.forEachChild((d) => {
      if (!ts.isImportDeclaration(d) || !d.importClause || d.importClause.isTypeOnly) return;
      const b = d.importClause.namedBindings;
      if (b && ts.isNamespaceImport(b)) spaces.add(b.name.text);
      if (b && ts.isNamedImports(b)) for (const e of b.elements) if (!e.isTypeOnly && watched.has((e.propertyName ?? e.name).text)) local.set(e.name.text, (e.propertyName ?? e.name).text);
    });
    /** The watched name an expression stands for: a name (its own or an import alias), or a member of a namespace import. */
    const origOf = (e) => {
      if (ts.isIdentifier(e)) return local.get(e.text) ?? (watched.has(e.text) ? e.text : undefined);
      if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && spaces.has(e.expression.text)) return watched.has(e.name.text) ? e.name.text : undefined;
      if (ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) && spaces.has(e.expression.text)) {
        const k = constText(ts, e.argumentExpression);
        return k !== undefined && watched.has(k) ? k : undefined;
      }
      return undefined;
    };
    const isDate = (e) => ts.isIdentifier(e) && e.text === 'Date';
    // A name in a place that is not a use of a value: its declaration, a property name or key, a type.
    const notAValue = (n) => {
      const p = n.parent;
      if (!p) return true;
      if ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isMethodDeclaration(p) && p.name === n) || (ts.isPropertySignature(p) && p.name === n)) return true;
      if ((ts.isClassDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isPropertyDeclaration(p) || ts.isBindingElement(p)) && p.name === n) return true;
      return false;
    };
    // `now` taken out of Date by a pattern: `const { now } = Date`, `const { now: t } = Date`, `({ now } = Date)`.
    const patternNow = (pattern) =>
      (ts.isObjectBindingPattern(pattern) && pattern.elements.some((e) => (e.propertyName ? keyText(ts, e.propertyName) : ts.isIdentifier(e.name) ? e.name.text : undefined) === 'now')) ||
      (ts.isObjectLiteralExpression(pattern) && pattern.properties.some((p) => (ts.isShorthandPropertyAssignment(p) ? p.name.text : ts.isPropertyAssignment(p) ? keyText(ts, p.name) : undefined) === 'now'));
    const portHit = (name) => found.add(`${PORT_ROOT_RULE[name]}:${name} outside a root`);
    (function visit(n, inType = false) {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
      const typeHere = inType || (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || (ts.isHeritageClause(n) && n.token === ts.SyntaxKind.ImplementsKeyword);
      if (!typeHere) {
        if (reads) {
          const read =
            (ts.isNewExpression(n) && isDate(n.expression) && (n.arguments?.length ?? 0) === 0) ||
            (ts.isPropertyAccessExpression(n) && isDate(n.expression) && n.name.text === 'now') ||
            (ts.isElementAccessExpression(n) && isDate(n.expression) && constText(ts, n.argumentExpression) === 'now') ||
            (ts.isCallExpression(n) && isDate(n.expression)) ||
            (ts.isVariableDeclaration(n) && n.initializer && isDate(n.initializer) && patternNow(n.name)) ||
            (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && isDate(n.right) && patternNow(ts.isParenthesizedExpression(n.left) ? n.left.expression : n.left));
          if (read) lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
        }
        // A watched name used as a value: under its name, an alias, or off a namespace import.
        const name = ts.isIdentifier(n) ? (notAValue(n) ? undefined : origOf(n)) : ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) ? origOf(n) : ts.isShorthandPropertyAssignment(n) ? origOf(n.name) : undefined;
        if (name !== undefined && named.includes(name)) portHit(name);
        if (stores) {
          if (ts.isNewExpression(n) && STORE_CLASSES.has(origOf(n.expression) ?? '')) found.add(`store-new:new ${origOf(n.expression)}`);
          if (ts.isHeritageClause(n) && n.token === ts.SyntaxKind.ExtendsKeyword) {
            for (const t of n.types) if (STORE_CLASSES.has(origOf(t.expression) ?? '')) found.add(`store-new:extends ${origOf(t.expression)}`);
          }
          // Any other value use of the class (`const K = LocalStorage`, `f(st.LocalStorage)`): not its construction, not its base class.
          const built = (p) => (ts.isNewExpression(p) && p.expression === n) || (ts.isExpressionWithTypeArguments(p) && p.expression === n);
          if (name !== undefined && STORE_CLASSES.has(name) && !built(n.parent)) found.add(`store-new:${name} as a value`);
        }
      }
      n.forEachChild((c) => visit(c, typeHere));
    })(sf);
    if (lines.length) clock.push({ file: rel, count: lines.length, lines });
    for (const k of found) { const i = k.indexOf(':'); hits.push({ rule: k.slice(0, i), file: rel, spec: k.slice(i + 1) }); }
  }
  return { clock, hits };
}

/** Whether a relative specifier of an engine file names the engine's loader file (lazy.ts, as `.js`, `.ts` or bare). */
const namesLoader = (rel, spec) => spec.startsWith('.') && path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)).replace(/\.(js|ts|mjs|mts)$/, '') === ENGINE_LOADER.slice(0, -3);

/**
 * The loaders' wiring (loader-use), read from the syntax tree: in packages/engine/src outside ENGINE_LOADER, a loader of
 * LOADER_HOMES imported from the loader file outside its home, the loader file imported whole or by `import()`, and a
 * loader re-exported (from the loader file, or a local name imported from it). Type-only imports load nothing.
 */
export function loaderHits(root, files) {
  const ts = loadTs(root);
  const hits = [];
  const LOADERS = Object.keys(LOADER_HOMES);
  for (const { rel, text } of files) {
    if (!rel.startsWith('packages/engine/src/') || rel === ENGINE_LOADER || !/lazy/.test(text)) continue;
    const sf = parse(ts, rel, text);
    const found = new Set();
    const local = new Map(); // local name → loader imported from the loader file
    sf.forEachChild((n) => {
      if (ts.isImportDeclaration(n) && namesLoader(rel, literal(ts, n.moduleSpecifier) ?? '')) {
        const c = n.importClause;
        if (!c || c.isTypeOnly) return;
        const b = c.namedBindings;
        if (c.name || (b && ts.isNamespaceImport(b))) found.add('* as lazy');
        if (b && ts.isNamedImports(b)) {
          for (const e of b.elements) {
            if (e.isTypeOnly) continue;
            const orig = (e.propertyName ?? e.name).text;
            local.set(e.name.text, orig);
            if (LOADERS.includes(orig) && !rel.startsWith(LOADER_HOMES[orig])) found.add(orig);
          }
        }
      }
      if (ts.isExportDeclaration(n) && !n.isTypeOnly) {
        const spec = literal(ts, n.moduleSpecifier);
        const fromLoader = spec !== undefined && namesLoader(rel, spec);
        if (fromLoader && (!n.exportClause || ts.isNamespaceExport(n.exportClause))) found.add('export * from lazy.ts');
        if (n.exportClause && ts.isNamedExports(n.exportClause)) {
          for (const e of n.exportClause.elements) {
            if (e.isTypeOnly) continue;
            const name = (e.propertyName ?? e.name).text;
            const orig = fromLoader ? name : spec === undefined ? local.get(name) : undefined;
            if (orig !== undefined && LOADERS.includes(orig)) found.add(`${orig} re-exported`);
          }
        }
      }
    });
    (function visit(n) {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && namesLoader(rel, literal(ts, n.arguments[0]) ?? '')) found.add('import() of lazy.ts');
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require' && namesLoader(rel, literal(ts, n.arguments[0]) ?? '')) found.add('require() of lazy.ts');
      // `import lazy = require('./lazy.js')`: the loader file whole, as `import * as` (a type-only one loads nothing).
      if (ts.isImportEqualsDeclaration(n) && !n.isTypeOnly && ts.isExternalModuleReference(n.moduleReference) && namesLoader(rel, literal(ts, n.moduleReference.expression) ?? '')) found.add('* as lazy');
      n.forEachChild(visit);
    })(sf);
    for (const k of found) hits.push({ rule: 'loader-use', file: rel, spec: k });
  }
  return hits;
}

/** The names an operation is defined with (shell-op): the contract's two definers. */
export const OPERATION_DEFINERS = ['defineTool', 'defineOperation'];
/** Where the shells define operations (shell-op): the MCP server's and the Studio's sources. */
export const SHELL_OP_DIRS = ['packages/mcp/src/', 'packages/ui/src/'];
/** Where a definer may be re-exported under another name (shell-op): the engine's operations and MCP's define.ts. */
export const DEFINER_HOMES = ['packages/engine/src/operations/', 'packages/mcp/src/tools/define.ts'];

/**
 * The operations a shell defines (shell-op), read from the syntax tree: in SHELL_OP_DIRS, every call of a definer of
 * OPERATION_DEFINERS — by its name, under an import alias (`{ defineTool as d }`) or as a member of a namespace import
 * (`c.defineTool(…)`, `c['defineTool'](…)`) — counted per file (`{count}`). A mention in a string, a comment, a type or
 * an import is no call. And in any packages/*\/src file outside DEFINER_HOMES, a definer re-exported under another
 * name (`export { defineTool as op }`, with or without `from`: `{spec}`), so that a shell cannot reach one under a
 * name this check does not read. Not seen: a definer under another name made in a file (`const d = defineTool`), a
 * wrapper of one, a parenthesised or otherwise computed callee (`(defineTool)(…)`, `c[name](…)`), a member of a
 * namespace from `await import()`, and an operation written as a `ToolDef` object literal with no definer at all.
 */
export function shellOpHits(root, files) {
  const ts = loadTs(root);
  const hits = [];
  for (const { rel, text } of files) {
    if (!OPERATION_DEFINERS.some((n) => text.includes(n))) continue;
    if (rel.startsWith('packages/') && rel.includes('/src/') && !DEFINER_HOMES.some((h) => rel.startsWith(h))) {
      const sf = parse(ts, rel, text);
      sf.forEachChild((n) => {
        if (!ts.isExportDeclaration(n) || n.isTypeOnly || !n.exportClause || !ts.isNamedExports(n.exportClause)) return;
        for (const e of n.exportClause.elements) {
          const orig = (e.propertyName ?? e.name).text;
          if (!e.isTypeOnly && OPERATION_DEFINERS.includes(orig) && e.name.text !== orig) hits.push({ rule: 'shell-op', file: rel, spec: `${orig} re-exported as ${e.name.text}` });
        }
      });
    }
    if (!SHELL_OP_DIRS.some((d) => rel.startsWith(d))) continue;
    const sf = parse(ts, rel, text);
    const names = new Set(OPERATION_DEFINERS);
    const spaces = new Set();
    sf.forEachChild((n) => {
      const c = ts.isImportDeclaration(n) ? n.importClause : undefined;
      if (!c || c.isTypeOnly) return;
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b)) spaces.add(b.name.text);
      if (b && ts.isNamedImports(b)) for (const e of b.elements) if (!e.isTypeOnly && OPERATION_DEFINERS.includes((e.propertyName ?? e.name).text)) names.add(e.name.text);
    });
    const member = (e) => (ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) ? literal(ts, e.argumentExpression) : undefined);
    let count = 0;
    (function visit(n) {
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        if (ts.isIdentifier(e) && names.has(e.text)) count++;
        else if ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && ts.isIdentifier(e.expression) && spaces.has(e.expression.text) && OPERATION_DEFINERS.includes(member(e) ?? '')) count++;
      }
      n.forEachChild(visit);
    })(sf);
    if (count) hits.push({ rule: 'shell-op', file: rel, count });
  }
  return hits;
}

/** The HookRunner members of the hooks use cases (hook-call): `<hooks>.run`, `<journals>.…`. */
const HOOK_RUN_MEMBERS = new Map([['hooks', new Set(['run'])], ['journals', new Set(['rollback', 'openPending', 'rollbackPending'])]]);
const HOOK_CONTEXT = 'createHookContext';

/**
 * The hooks orchestration calls outside the engine (hook-call), read from the syntax tree: in packages/*\/src outside
 * packages/engine/src, each call of `createHookContext` — by its name, under an import alias, or as a member of a
 * namespace import (`e.createHookContext(…)`, `e['createHookContext'](…)`) — and of a HookRunner member of
 * HOOK_RUN_MEMBERS on something named after its owner (`hooks.run(…)`, `cliPorts.hooks.run(…)`, `x.journals['rollback'](…)`),
 * and in the shells' sources of `.rollbackAll(…)` on anything; counted per file (`{count}`). The callee is read through
 * parentheses, a comma, a cast or `!`, and `.call` / `.apply` / `.bind` of a counted function counts too. A mention in a
 * string, a comment, a type or an import is no call. Not seen (the check's title lists them): a destructured member, a
 * member held in a variable, a dynamic import's destructuring, an import-equals alias, a computed key.
 */
export function hookCallHits(root, files) {
  const ts = loadTs(root);
  const hits = [];
  for (const { rel, text } of files) {
    if (!rel.startsWith('packages/') || !rel.includes('/src/') || rel.startsWith('packages/engine/src/')) continue;
    const shell = SHELLS.includes(pkgOf(rel));
    if (!text.includes(HOOK_CONTEXT) && !/\b(?:hooks|journals)\b/.test(text) && !(shell && text.includes('rollbackAll'))) continue;
    const sf = parse(ts, rel, text);
    const names = new Set([HOOK_CONTEXT]);
    const spaces = new Set();
    sf.forEachChild((n) => {
      const c = ts.isImportDeclaration(n) ? n.importClause : undefined;
      if (!c || c.isTypeOnly) return;
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b)) spaces.add(b.name.text);
      if (b && ts.isNamedImports(b)) for (const e of b.elements) if (!e.isTypeOnly && (e.propertyName ?? e.name).text === HOOK_CONTEXT) names.add(e.name.text);
    });
    const member = (e) => (ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) ? literal(ts, e.argumentExpression) : undefined);
    // `hooks` / `journals` themselves, or a property of that name (`cliPorts.hooks`, `this['journals']`).
    const owner = (e) => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? member(e) : undefined);
    // `(f)`, `(0, f)`, `f as T`, `f!`, `<T>f`, `f satisfies T`: the expression that is called.
    const unwrap = (e) => {
      for (;;) {
        if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || (ts.isTypeAssertionExpression?.(e) ?? false) || (ts.isSatisfiesExpression?.(e) ?? false)) e = e.expression;
        else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) e = e.right;
        else return e;
      }
    };
    // A counted function: createHookContext (its name, an alias, a namespace member), a HookRunner member on its owner,
    // a shell's rollbackAll.
    const counted = (e) => {
      e = unwrap(e);
      if (ts.isIdentifier(e)) return names.has(e.text);
      if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return false;
      const m = member(e);
      const on = unwrap(e.expression);
      if (ts.isIdentifier(on) && spaces.has(on.text) && m === HOOK_CONTEXT) return true;
      if (m !== undefined && HOOK_RUN_MEMBERS.get(owner(on) ?? '')?.has(m)) return true;
      return shell && m === 'rollbackAll';
    };
    const CALLERS = new Set(['call', 'apply', 'bind']);
    let count = 0;
    (function visit(n) {
      if (ts.isCallExpression(n)) {
        const e = unwrap(n.expression);
        if (counted(e)) count++;
        // `f.call(…)`, `f.apply(…)`, `f.bind(…)` of a counted function.
        else if ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && CALLERS.has(member(e) ?? '') && counted(e.expression)) count++;
      }
      n.forEachChild(visit);
    })(sf);
    if (count) hits.push({ rule: 'hook-call', file: rel, count });
  }
  return hits;
}

/** The port files' adapter imports (port-types): every specifier the scan lists (types and `typeof import()` included). */
/**
 * The private modules of playwright-core named outside BROWSER_REGISTRY_HOME (browser-registry), read from the syntax
 * tree: in packages/*\/src, every string literal, template (its text parts) or import specifier holding
 * `playwright-core/lib/`, counted per file (`{count}`). A comment is no use.
 */
export function browserRegistryHits(root, files) {
  const ts = loadTs(root);
  const hits = [];
  for (const { rel, text } of files) {
    if (!/^packages\/[^/]+\/src\//.test(rel) || rel === BROWSER_REGISTRY_HOME || !text.includes('playwright-core/lib/')) continue;
    const sf = parse(ts, rel, text);
    let count = 0;
    (function visit(n) {
      const t = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text : undefined;
      if (t !== undefined && t.includes('playwright-core/lib/')) count++;
      n.forEachChild(visit);
    })(sf);
    if (count) hits.push({ rule: 'browser-registry', file: rel, count });
  }
  return hits;
}

/**
 * The media tools started outside MEDIA_RUN_HOME (media-call), read from the syntax tree: in packages/*\/src, a file
 * that names ffmpeg or ffprobe (an identifier, a string literal or a template's text) and calls a process starter of
 * node:child_process (CHILD_STARTERS, by its imported name or alias, or as a member of the module imported whole),
 * counted per file (`{count}`: its calls; an imported name counts as naming the tool). Comments and type imports of node:child_process are no use.
 */
const CHILD_STARTERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);
export function mediaCallHits(root, files) {
  const ts = loadTs(root);
  const hits = [];
  const MEDIA_WORD = /ffmpeg|ffprobe/i;
  for (const { rel, text } of files) {
    if (!/^packages\/[^/]+\/src\//.test(rel) || rel === MEDIA_RUN_HOME || !text.includes('child_process') || !MEDIA_WORD.test(text)) continue;
    const sf = parse(ts, rel, text);
    const names = new Set();
    const spaces = new Set();
    let media = false;
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !/^(node:)?child_process$/.test(st.moduleSpecifier.text)) continue;
      const c = st.importClause;
      if (!c || c.isTypeOnly) continue;
      if (c.name) spaces.add(c.name.text);
      const b = c.namedBindings;
      if (b && ts.isNamespaceImport(b)) spaces.add(b.name.text);
      else if (b) for (const el of b.elements) if (!el.isTypeOnly && CHILD_STARTERS.has((el.propertyName ?? el.name).text)) names.add(el.name.text);
    }
    const member = (e) => (ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) ? literal(ts, e.argumentExpression) : undefined);
    // `(f)`, `(0, f)`, `f as T`, `f!`, `<T>f`, `f satisfies T`: the expression that is called (as hook-call reads it).
    const unwrap = (e) => {
      for (;;) {
        if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || (ts.isTypeAssertionExpression?.(e) ?? false) || (ts.isSatisfiesExpression?.(e) ?? false)) e = e.expression;
        else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) e = e.right;
        else return e;
      }
    };
    // A starter: its imported name or alias, or a starter member of the module imported whole (`cp.spawn`, `cp['spawn']`).
    const starter = (e) => {
      e = unwrap(e);
      if (ts.isIdentifier(e)) return names.has(e.text);
      if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return false;
      const on = unwrap(e.expression);
      return ts.isIdentifier(on) && spaces.has(on.text) && CHILD_STARTERS.has(member(e) ?? '');
    };
    const CALLERS = new Set(['call', 'apply', 'bind']);
    let count = 0;
    (function visit(n) {
      if (ts.isIdentifier(n) && MEDIA_WORD.test(n.text)) media = true;
      const t = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text : undefined;
      if (t !== undefined && MEDIA_WORD.test(t)) media = true;
      if (ts.isCallExpression(n)) {
        const e = unwrap(n.expression);
        if (starter(e)) count++;
        // `f.call(…)`, `f.apply(…)`, `f.bind(…)` of a starter.
        else if ((ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && CALLERS.has(member(e) ?? '') && starter(e.expression)) count++;
      }
      n.forEachChild(visit);
    })(sf);
    if (count && media) hits.push({ rule: 'media-call', file: rel, count });
  }
  return hits;
}

export function portTypeHits(fileImports) {
  const hits = [];
  for (const f of PORT_FILES) {
    for (const s of new Set(fileImports[f] ?? [])) if (ADAPTERS.includes(retake(s) ?? '') && !DOMAIN_ENTRIES.includes(s)) hits.push({ rule: 'port-types', file: f, spec: s });
  }
  return hits;
}

/** The folder names of the layout (packages/core/src/layout.ts PROJECT_DIRS and STATE_DIR; the import-rules test checks they agree). */
export const LAYOUT_NAMES = ['scenarios', 'hooks', 'assets', 'comments', 'runs', 'renders', 'review', 'exports', '.retake'];
/** The state files the layout names (layout.ts HISTORY_FILE, WORKSPACE_JOURNAL_FILE: the workspace's; PROJECT_SCENARIO_WRITES_FILE: a project's). */
export const LAYOUT_FILES = ['history.jsonl', 'journal.jsonl', 'scenario-writes.jsonl'];
export const LAYOUT_HOME = 'packages/core/src/layout.ts';
const PATH_MODULES = new Set(['path', 'node:path', 'path/posix', 'node:path/posix']);
/** Names that are a path wherever they are written (no word of the tool's other vocabularies). */
const LAYOUT_ALWAYS = ['.retake', ...LAYOUT_FILES];

/**
 * The hand-written layout names, read from the syntax tree, outside packages/core/src/layout.ts:
 * - anywhere, a string or template that is a layout path — `.retake` or a layout file name (`'.retake'`,
 *   `'history.jsonl'`), or text starting with a layout folder and a slash (`'runs/x'`, `` `scenarios/${name}.yaml` ``,
 *   `'.retake/journals'`, a message naming `renders/<id>.json` too) — or a template part continuing a path with one
 *   (`` `${dir}/.retake/jobs` ``);
 * - each argument of a node:path `join` / `resolve` call (under its own name, an import alias, `path.join`,
 *   `path.posix.join`, `posix.join`) that is a string naming a layout folder (`join(dir, 'runs')`).
 * A module specifier is not counted; a string is counted once. `[{ file, count, lines }]` (the line of each), files
 * with none left out.
 */
export function layoutHits(root, files) {
  const ts = loadTs(root);
  const out = [];
  const folderName = (t) => LAYOUT_NAMES.some((n) => t === n || t.startsWith(`${n}/`));
  const pathText = (t) => LAYOUT_ALWAYS.some((n) => t === n || t.startsWith(`${n}/`)) || LAYOUT_NAMES.some((n) => t.startsWith(`${n}/`));
  const pathPart = (t) => LAYOUT_ALWAYS.some((n) => t === `/${n}` || t.startsWith(`/${n}/`));
  for (const { rel, text } of files) {
    if (rel === LAYOUT_HOME || ![...LAYOUT_NAMES, ...LAYOUT_FILES].some((n) => text.includes(n))) continue;
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
    const isSpecifier = (n) => n.parent && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent) || ts.isExternalModuleReference(n.parent) || (ts.isCallExpression(n.parent) && n.parent.expression.kind === ts.SyntaxKind.ImportKeyword) || ts.isLiteralTypeNode(n.parent) && ts.isImportTypeNode(n.parent.parent));
    const hit = new Set();
    (function visit(n) {
      if (ts.isCallExpression(n) && isPathCall(n.expression)) {
        for (const a of n.arguments) {
          const t = literal(ts, a) ?? (ts.isTemplateExpression(a) ? a.head.text : undefined);
          if (t !== undefined && folderName(t)) hit.add(a);
        }
      }
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !isSpecifier(n) && pathText(n.text)) hit.add(n);
      if (ts.isTemplateExpression(n) && (pathText(n.head.text) || n.templateSpans.some((sp) => pathPart(sp.literal.text)))) hit.add(n);
      n.forEachChild(visit);
    })(sf);
    const lines = [...hit].map((a) => sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1).sort((x, y) => x - y);
    if (lines.length) out.push({ file: rel, count: lines.length, lines });
  }
  return out;
}

/** Where the id grammars are written (packages/core/src): the pure grammar, and the generators with the schema helpers. */
export const ID_HOMES = ['packages/core/src/id-grammar.ts', 'packages/core/src/ids.ts'];
/** The one copy allowed outside: the Studio front end imports types only (R5); packages/ui/test/id-words.test.ts pins it to the homes. */
export const ID_MIRRORS = ['packages/ui/src/app/id-words.ts'];
/** The grammars a length cap belongs to: tested through `is…` / `parse…` / the `z…` helpers, never alone. */
export const ID_CAPPED_GRAMMARS = ['RUN_ID_RE', 'RENDER_ID_RE', 'ANY_THEME_NAME_RE', 'NEW_THEME_NAME_RE'];
/** The prefixes of the ULID ids (core ULID_PREFIXES; the import-rules test checks they agree). */
export const ID_ULID_PREFIXES = ['j_', 'p_', 'i_', 's_', 'rec_', 'c_', 'r_', 'k_'];
const ID_FINGERPRINTS = [/\\d\{8\}-\\d\{6\}/, /-v\(?(?:\?(?:<\w+>|:))?\\d/, /0-9A-HJKMNP-TV-Z/];
const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_WHOLE_GRAMMARS = new Set(['^[A-Za-z0-9][A-Za-z0-9._-]*$', '^[A-Za-z0-9][A-Za-z0-9_-]*$', '^[a-z0-9][a-z0-9-]*$']);
const ID_SUFFIXES = ['-vertical', '-square'];
const ID_MATCHERS = new Set(['match', 'matchAll', 'search', 'replace', 'replaceAll', 'split']);

/**
 * The id patterns written by hand, read from the syntax tree, outside ID_HOMES and ID_MIRRORS — the six kinds of the
 * `id-grammar` check's title. A module specifier is not read; a node is counted once, whatever kinds it shows.
 * `[{ file, count, lines, kinds }]` (the line and the kind of each hit, in line order), files with none left out.
 */
export function idGrammarHits(root, files) {
  const ts = loadTs(root);
  const out = [];
  const fingerprint = (t) => ID_FINGERPRINTS.some((re) => re.test(t));
  const suffix = (t) => ID_SUFFIXES.some((x) => t.startsWith(x));
  const whole = (t) => ID_WHOLE_GRAMMARS.has(t.replace(/\{0,\d+\}\$$/, '*$'));
  const cappedName = (e) => (ts.isIdentifier(e) ? ID_CAPPED_GRAMMARS.includes(e.text) : ts.isPropertyAccessExpression(e) && ID_CAPPED_GRAMMARS.includes(e.name.text));
  for (const { rel, text } of files) {
    if (ID_HOMES.includes(rel) || ID_MIRRORS.includes(rel)) continue;
    const sf = parse(ts, rel, text);
    const isSpecifier = (n) => n.parent && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent) || ts.isExternalModuleReference(n.parent) || (ts.isCallExpression(n.parent) && n.parent.expression.kind === ts.SyntaxKind.ImportKeyword) || (ts.isLiteralTypeNode(n.parent) && ts.isImportTypeNode(n.parent.parent)));
    const hit = new Map(); // node → kind (the first that matched)
    const add = (n, kind) => { if (!hit.has(n)) hit.set(n, kind); };
    (function visit(n) {
      if (ts.isRegularExpressionLiteral(n)) {
        const source = n.text.slice(1, n.text.lastIndexOf('/'));
        if (fingerprint(source)) add(n, 1);
        else if (whole(source)) add(n, 3);
      } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !isSpecifier(n)) {
        if (fingerprint(n.text)) add(n, 1);
        else if (n.text.includes(ID_ALPHABET)) add(n, 2);
        else if (whole(n.text)) add(n, 3);
        else if (suffix(n.text)) add(n, 5);
      } else if (ts.isTemplateExpression(n)) {
        const parts = [n.head.text, ...n.templateSpans.map((sp) => sp.literal.text)];
        if (parts.some(fingerprint)) add(n, 1);
        else if (parts.some((t) => t.includes(ID_ALPHABET))) add(n, 2);
        else if (parts.some((t) => t.endsWith('-v')) || ID_ULID_PREFIXES.includes(n.head.text)) add(n, 4);
        else if (parts.some(suffix)) add(n, 5);
      } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        if ((method === 'test' || method === 'exec') && cappedName(n.expression.expression)) add(n, 6);
        else if ((ID_MATCHERS.has(method) || method === 'regex') && n.arguments.some(cappedName)) add(n, 6);
      }
      n.forEachChild(visit);
    })(sf);
    const found = [...hit].map(([n, kind]) => ({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, kind })).sort((x, y) => x.line - y.line || x.kind - y.kind);
    if (found.length) out.push({ file: rel, count: found.length, lines: found.map((f) => f.line), kinds: found.map((f) => f.kind) });
  }
  return out;
}

/**
 * The files that may give a parsed run.json, timeline.json or render record its type: the parse boundaries (pure: the
 * run record's, the render record's and the lenient read they share), the reader of the run folders, the reader of
 * renders/ and its file seam, and the editor's one place where a stored plan becomes an edit plan (`withPlan`).
 */
export const RECORD_READ_HOME = [
  'packages/core/src/run-record.ts',
  'packages/core/src/io/run-folder.ts',
  'packages/core/src/render-record.ts',
  'packages/core/src/record-read.ts',
  'packages/core/src/io/render-folder.ts',
  'packages/core/src/io/record-file.ts',
  'packages/editor/src/render-record.ts',
];
/**
 * The files that read a file of a run folder or of renders/ on their own, on purpose, into a shape of their own (no
 * record type is named, so kinds 1-9 see nothing): each `JSON.parse(…)` there is counted, and the baseline holds the
 * reason.
 */
export const RECORD_READ_OWN = [
  'packages/engine/src/prune.ts',
  'packages/engine/src/jobs/run-job.ts',
];
/** The schemas of a run record, of a timeline and of a render record: a parse through one outside the reader is typed without it. */
export const RECORD_READ_SCHEMAS = ['RunRecordSchema', 'StoredRunRecordSchema', 'UnknownStatusRunSchema', 'TimelineSchema', 'RenderRecordSchema', 'RenderAttemptSchema', 'StoredRenderRecordSchema', 'UnknownStatusRenderSchema'];
/**
 * The types of a run record, of a timeline and of a render record (core run-record.ts, types.ts, render-record.ts; the
 * editor's names for a render record with its plan; the engine's names for a read record).
 */
export const RECORD_READ_TYPES = [
  'RunRecord', 'StoredRunRecord', 'UnknownStatusRun', 'RunRecordOnDisk', 'QueuedRun', 'RunningRun', 'SucceededRun', 'FailedRun', 'CancelledRun', 'FinishedRun', 'Timeline', 'TimelineHead',
  'RenderRecord', 'StoredRenderRecord', 'StoredRender', 'NamedRender', 'ProjectRender', 'FinishedRender', 'RenderAttempt', 'UnknownStatusRender', 'RenderForWork',
  // The render record's base types (exported under their own names) and the answers that hold a record (L7.6b fix pass).
  'RenderBase', 'StoredRenderBase', 'RenderFields', 'CompleteRender', 'NamedRenderFound', 'FoundRender', 'FoundReviewRender',
];
/** The calls whose result is a parsed file: `JSON.parse(…)`, and `readJson(…)` under that name (also `x.readJson(…)`). */
const RECORD_PARSERS = ['readJson'];

/**
 * The places that give a value the type of a run record, a timeline or a render record without the reader, read from the syntax tree,
 * outside RECORD_READ_HOME — the kinds of the `record-read` check's title (10: a `JSON.parse` of a RECORD_READ_OWN file).
 * `[{ file, count, lines, kinds }]` (the line and the kind of each hit, in line order), files with none left out.
 */
export function recordReadHits(root, files) {
  const ts = loadTs(root);
  const out = [];
  const named = (t) => {
    let yes = false;
    (function visit(n) {
      // A member's type (`RunRecord['status']`), `keyof` and `typeof` name the type without being a record.
      if (yes || ts.isIndexedAccessTypeNode(n) || ts.isTypeOperatorNode(n) || ts.isTypeQueryNode(n)) return;
      // `RunRecord`, `core.RunRecord`, and the type reached without an import: `import('@retake/core').RunRecord`.
      const ref = ts.isTypeReferenceNode(n) ? n.typeName : ts.isImportTypeNode(n) ? n.qualifier : undefined;
      if (ref && RECORD_READ_TYPES.includes(ts.isIdentifier(ref) ? ref.text : ref.right.text)) { yes = true; return; }
      n.forEachChild(visit);
    })(t);
    return yes;
  };
  const isAssertion = (e) => ts.isAsExpression(e) || (ts.isTypeAssertionExpression?.(e) ?? false);
  // The expression under parentheses, `await`, `!` and casts; `casts`: the types of the casts gone through.
  const bare = (e, casts = []) => {
    for (;;) {
      if (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isNonNullExpression(e) || (ts.isSatisfiesExpression?.(e) ?? false)) e = e.expression;
      else if (isAssertion(e)) { casts.push(e.type); e = e.expression; }
      else return e;
    }
  };
  const parser = (e) => {
    if (!ts.isCallExpression(e)) return false;
    const f = e.expression;
    if (ts.isPropertyAccessExpression(f)) return (f.name.text === 'parse' && ts.isIdentifier(f.expression) && f.expression.text === 'JSON') || RECORD_PARSERS.includes(f.name.text);
    return ts.isIdentifier(f) && RECORD_PARSERS.includes(f.text);
  };
  const functionOf = (n) => {
    for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
    return undefined;
  };
  for (const { rel, text } of files) {
    if (RECORD_READ_HOME.includes(rel)) continue;
    const sf = parse(ts, rel, text);
    const own = RECORD_READ_OWN.includes(rel);
    const schemaName = (e) => (ts.isIdentifier(e) ? RECORD_READ_SCHEMAS.includes(e.text) : ts.isPropertyAccessExpression(e) && RECORD_READ_SCHEMAS.includes(e.name.text));
    const hit = new Map(); // the parse call, or the cast → kind (the first that matched)
    const add = (n, kind) => { if (!hit.has(n)) hit.set(n, kind); };
    (function visit(n) {
      if (isAssertion(n)) {
        const casts = [];
        const inner = bare(n, casts);
        if (parser(inner) && casts.some(named)) add(inner, 1);
        // Any other value cast to a record: counted once, at its outermost cast.
        else if (named(n.type)) add(n, 5);
      } else if (ts.isCallExpression(n) && parser(n) && (n.typeArguments ?? []).some(named)) add(n, 2);
      // A generic cast helper: any other call that names a record as its type argument.
      else if (ts.isCallExpression(n) && (n.typeArguments ?? []).some(named)) add(n, 7);
      else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['parse', 'safeParse', 'parseAsync', 'safeParseAsync'].includes(n.expression.name.text) && schemaName(n.expression.expression)) add(n, 8);
      else if (ts.isTypePredicateNode(n) && n.type && named(n.type)) add(n, 6);
      else if (ts.isHeritageClause(n) && n.types.some((t) => ts.isIdentifier(t.expression) && RECORD_READ_TYPES.includes(t.expression.text))) add(n, 9);
      else if (own && ts.isCallExpression(n) && parser(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'parse') add(n, 10);
      else if (ts.isVariableDeclaration(n) && n.type && n.initializer && named(n.type)) {
        const inner = bare(n.initializer);
        if (parser(inner)) add(inner, 3);
      } else if (ts.isReturnStatement(n) && n.expression) {
        const inner = bare(n.expression);
        const fn = parser(inner) ? functionOf(n) : undefined;
        if (fn?.type && named(fn.type)) add(inner, 4);
      } else if (ts.isArrowFunction(n) && !ts.isBlock(n.body) && n.type && named(n.type)) {
        const inner = bare(n.body);
        if (parser(inner)) add(inner, 4);
      }
      n.forEachChild(visit);
    })(sf);
    const found = [...hit].map(([n, kind]) => ({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, kind })).sort((x, y) => x.line - y.line || x.kind - y.kind);
    if (found.length) out.push({ file: rel, count: found.length, lines: found.map((f) => f.line), kinds: found.map((f) => f.kind) });
  }
  return out;
}

/** A specifier of the rendering library: the package, a path into it, or one of its scoped packages. */
const LIBRARY_SPEC = /^remotion($|\/)|^@remotion\//;
/**
 * The seam files of the rendering library, each with the library packages it may `load` (import, re-export, require,
 * type against) and those whose path it may only `resolve` (a version read). Widening this list is a design change:
 * packages/core/test/import-rules.test.ts pins it.
 */
export const LIBRARY_SEAMS = {
  'packages/editor/src/render/library.ts': { load: ['@remotion/renderer', '@remotion/bundler'], resolve: ['remotion'] },
  'packages/editor/src/remotion/host.ts': { load: ['remotion'], resolve: [] },
  'packages/components/src/kit/renderer.ts': { load: ['remotion', '@remotion/lottie'], resolve: [] },
  'packages/ui/src/player/frame-main.tsx': { load: ['@remotion/player'], resolve: [] },
  'packages/ui/src/player/bundle-player.ts': { load: [], resolve: ['@remotion/player'] },
};
/**
 * The seam files that hand the library on (its loaders, its names), each with the one folder whose files may import
 * it: a file elsewhere importing or re-exporting one would use the library under another name. The two player files
 * are not here: they hand nothing of the library on (the frame is a bundle entry, the other reads a version).
 */
export const LIBRARY_SEAM_IMPORTERS = {
  'packages/editor/src/render/library.ts': 'packages/editor/src/render',
  'packages/editor/src/remotion/host.ts': 'packages/editor/src/remotion',
  'packages/components/src/kit/renderer.ts': 'packages/components/src/kit',
};
/**
 * The reaches of the library the rule cannot see because their specifier is computed, by file: known, and pinned with
 * the seams so the lists say what the code does. The test checks each is still there as described.
 */
export const LIBRARY_COMPUTED_READS = {
  'packages/components/src/compile.ts': 'moduleExports(): `import(name)` for each name of STUBBED (react, its JSX runtimes and remotion), to list the export names the compile check stubs',
};
/** Folders outside `packages/<name>/src` the seam rule reads too: the built-in components and the scaffolds, which name the library nowhere. */
export const LIBRARY_FREE_DIRS = ['packages/components/library', 'packages/components/scaffolds'];

/**
 * What the seam rule reads beside the scan's files, as `[{ rel, text }]`: every source of LIBRARY_FREE_DIRS (nested
 * folders, `.js` / `.jsx` / `.mjs` / `.cjs` / `.cts` and declaration files too), and the files of `packages/<name>/src`
 * the scan leaves out (the same extensions).
 */
export function libraryFreeSources(root) {
  const pkgsDir = path.join(root, 'packages');
  const unscanned = fs.existsSync(pkgsDir)
    ? fs.readdirSync(pkgsDir).flatMap((d) => walk(path.join(pkgsDir, d, 'src'), [], (name) => isSource(name) && !isScanned(name)))
    : [];
  return [...LIBRARY_FREE_DIRS.flatMap((d) => walk(path.join(root, d), [], isSource)), ...unscanned]
    .map((f) => ({ rel: path.relative(root, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
}

/**
 * R10, read from the syntax tree of every file given (`[{ rel, text }]`: the scan's files plus libraryFreeSources):
 * the rendering library named outside the seam file allowed to name that package. A hit is
 * - a module specifier of the library in an `import` (also `import type`: typing against the library is coupling), an
 *   `export … from`, `export *`, `import x = require()`, a type `import('…')`, a dynamic `import()`, or a call of
 *   `require` or of a require made with `createRequire` — spec: the specifier;
 * - a string argument of `require.resolve()`, `import.meta.resolve()` or the `.resolve()` of a made require naming the
 *   library — spec: `resolve(<specifier>)`;
 * - a relative import or re-export, in any of the forms above, of a seam file that hands the library on, from a file
 *   outside the seam's folder (LIBRARY_SEAM_IMPORTERS) — spec: `seam <file>`;
 * - `export * from` (or `export * as x from`) a seam file, in a file that is not a seam and is not already a hit of
 *   the line above — spec: `export * from <seam>`: the seam's names would leave under another file's name, and a later
 *   name of the library with them.
 * Specifiers are read as the compiler cooks them, so an escaped spelling (`'remotion'`) is the same name.
 * What it cannot see, by construction: a specifier computed at run time (`import(name)`, `'remo' + 'tion'`,
 * `` resolve(`${name}/package.json`) ``: LIBRARY_COMPUTED_READS lists the one the code has); a require reached under
 * another name (`createRequire as cr`, `const { resolve } = require`, `require['resolve']`); `declare module 'remotion'`
 * and `/// <reference types>`; the library's name inside a data string (the lists of imports a component may use, the
 * bundles' externals, the generated bundle entry, the player frame's read of a global the library sets, cache keys,
 * messages); a named re-export of one seam binding through a file of the seam's folder (how the kit's index hands on
 * its six public names, by design: a new one is a visible line there), and what a seam file itself exports; a seam
 * file reached through a package specifier rather than a relative path; and anything outside the files given — tests,
 * scripts/, fixtures/, apps/, workspace components (which may import the library; the bundlers' own lists rule that).
 */
export function seamHits(root, files) {
  const ts = loadTs(root);
  const hits = [];
  const pkgName = (s) => s.split('/').slice(0, s.startsWith('@') ? 2 : 1).join('/');
  /** The seam file a relative specifier of `rel` points at, if any. */
  const seamAt = (rel, spec) => {
    if (!spec?.startsWith('.')) return undefined;
    const to = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    const bare = to.replace(/\.(js|jsx|mjs)$/, '');
    return [to, ...['.ts', '.tsx', '/index.ts', '/index.tsx'].map((x) => bare + x)].find((t) => Object.hasOwn(LIBRARY_SEAMS, t));
  };
  for (const { rel, text } of files) {
    const seam = Object.hasOwn(LIBRARY_SEAMS, rel) ? LIBRARY_SEAMS[rel] : undefined;
    const sf = parse(ts, rel, text);
    const found = new Set();
    const loads = (s) => {
      if (s === undefined) return;
      if (LIBRARY_SPEC.test(s) && !seam?.load.includes(pkgName(s))) found.add(s);
      const target = seamAt(rel, s);
      if (target && target !== rel && Object.hasOwn(LIBRARY_SEAM_IMPORTERS, target) && path.posix.dirname(rel) !== LIBRARY_SEAM_IMPORTERS[target]) found.add(`seam ${target}`);
    };
    const resolves = (s) => { if (s !== undefined && LIBRARY_SPEC.test(s) && !seam?.resolve.includes(pkgName(s)) && !seam?.load.includes(pkgName(s))) found.add(`resolve(${s})`); };
    const inner = (e) => { while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))) e = e.expression; return e; };
    const makesRequire = (e) => { e = inner(e); return !!e && ts.isCallExpression(e) && ((ts.isIdentifier(e.expression) && e.expression.text === 'createRequire') || (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'createRequire')); };
    const requires = new Set(['require']);
    (function collect(n) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && makesRequire(n.initializer)) requires.add(n.name.text);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && makesRequire(n.right)) requires.add(n.left.text);
      n.forEachChild(collect);
    })(sf);
    const isRequire = (e) => { e = inner(e); return !!e && ((ts.isIdentifier(e) && requires.has(e.text)) || makesRequire(e)); };
    (function visit(n) {
      if (ts.isImportDeclaration(n)) loads(literal(ts, n.moduleSpecifier));
      else if (ts.isExportDeclaration(n)) {
        const spec = literal(ts, n.moduleSpecifier);
        loads(spec);
        const target = seam ? undefined : seamAt(rel, spec);
        if (target && !found.has(`seam ${target}`) && (!n.exportClause || ts.isNamespaceExport(n.exportClause))) found.add(`export * from ${target}`);
      } else if (ts.isImportEqualsDeclaration(n)) { if (ts.isExternalModuleReference(n.moduleReference)) loads(literal(ts, n.moduleReference.expression)); }
      else if (ts.isImportTypeNode(n)) { if (ts.isLiteralTypeNode(n.argument)) loads(literal(ts, n.argument.literal)); }
      else if (ts.isCallExpression(n)) {
        const callee = inner(n.expression);
        if (callee.kind === ts.SyntaxKind.ImportKeyword || isRequire(callee)) loads(literal(ts, n.arguments[0]));
        else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' && (isRequire(callee.expression) || (ts.isMetaProperty(inner(callee.expression)) && inner(callee.expression).name.text === 'meta'))) resolves(literal(ts, n.arguments[0]));
      }
      n.forEachChild(visit);
    })(sf);
    for (const spec of found) hits.push({ rule: 'R10', file: rel, spec });
  }
  return hits;
}

/**
 * One ratchet entry per (rule, file, import): the strings the baseline holds, sorted. A cycle gives one entry per file
 * and one with the number of imports inside it, so a new import between files already in a cycle fails too.
 */
export function ratchetEntries(root, scanned = scan(root)) {
  const set = new Set();
  for (const h of [...ruleHits(root, scanned.fileImports), ...wiringHits(root, scanned.files), ...seamHits(root, [...scanned.files, ...libraryFreeSources(root)]), ...loaderHits(root, scanned.files), ...portTypeHits(scanned.fileImports)]) set.add(`${h.rule} ${h.file} → ${h.spec}`);
  const ports = portHits(root, scanned.files);
  for (const h of ports.hits) set.add(`${h.rule} ${h.file} → ${h.spec}`);
  for (const h of ports.clock) set.add(`clock-read ${h.file} → ${h.count} wall-clock read${h.count === 1 ? '' : 's'}`);
  for (const h of layoutHits(root, scanned.files)) set.add(`layout ${h.file} → ${h.count} hand-written layout path${h.count === 1 ? '' : 's'}`);
  for (const h of shellOpHits(root, scanned.files)) set.add(h.spec !== undefined ? `shell-op ${h.file} → ${h.spec}` : `shell-op ${h.file} → ${h.count} operation${h.count === 1 ? '' : 's'} defined`);
  for (const h of hookCallHits(root, scanned.files)) set.add(`hook-call ${h.file} → ${h.count} hooks orchestration call${h.count === 1 ? '' : 's'}`);
  for (const h of browserRegistryHits(root, scanned.files)) set.add(`browser-registry ${h.file} → ${h.count} private module${h.count === 1 ? '' : 's'} of playwright-core named`);
  for (const h of mediaCallHits(root, scanned.files)) set.add(`media-call ${h.file} → ${h.count} media tool start${h.count === 1 ? '' : 's'}`);
  for (const h of idGrammarHits(root, scanned.files)) set.add(`id-grammar ${h.file} → ${h.count} hand-written id pattern${h.count === 1 ? '' : 's'}`);
  for (const h of recordReadHits(root, scanned.files)) {
    const own = h.kinds.filter((k) => k === 10).length;
    if (own) set.add(`record-read ${h.file} → ${own} own read${own === 1 ? '' : 's'} of a run folder's or renders/'s file`);
    if (h.count > own) set.add(`record-read ${h.file} → ${h.count - own} record${h.count - own === 1 ? '' : 's'} typed without the reader`);
  }
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
