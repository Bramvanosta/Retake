#!/usr/bin/env node
// The size ratchet: the sources of `packages/*/src` measured with the TypeScript syntax tree and held to
// scripts/audit/size-baseline.json. Four measures, each with its limit (LIMITS):
//   file    lines of a file
//   body    lines of a function (declaration, method, accessor, constructor, arrow or function expression, a class's
//           `static {}` block), first to last
//   params  parameters of a function (a `this` parameter left out)
//   nesting depth of the control structures inside one function (if, loops, switch, try, a conditional expression);
//           an `else if`, a `catch` (at its try's depth) and a conditional in the false branch of another (a chain) add
//           no depth, and a nested function starts again from 0
// The baseline lists what is over a limit today, each entry with its size and its group's one-line reason. It holds
// exactly: a new entry, a size above or below its recorded one and an entry back under its limit all fail, until the
// code is split or `--write-baseline` records today's sizes (the baseline only shrinks).
// Entries are keyed by file and name path (`<file> › <outer> › <name>`), never by line or position, so an edit above a
// function does not move it. A function without a name of its own is named by what it is given to: a variable, a
// property, a JSX attribute, or a call with its first string or identifier argument (that of a call it is chained to,
// or of the call it is passed to, when it has none: `action('add <project>')`), `<iife>` when it is called at once.
// Two functions over a limit that still share a key fail as ambiguous: give one a name.
// Usage: node scripts/audit/size-limits.mjs [<repo-root>]                   the measures over their limits
//        node scripts/audit/size-limits.mjs [<repo-root>] --check           the ratchet: exit 1 on any difference
//        node scripts/audit/size-limits.mjs [<repo-root>] --write-baseline  rewrite the baseline for today (reasons kept)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs } from './lib.mjs';

export const SIZE_BASELINE = 'scripts/audit/size-baseline.json';
export const SIZE_WRITE_HINT = 'node scripts/audit/size-limits.mjs --write-baseline';
/** The limits: a measure above its limit is an entry. */
export const LIMITS = { file: 1000, body: 100, params: 5, nesting: 5 };
const MEASURES = Object.keys(LIMITS);

const isScanned = (name) => /\.(ts|tsx|mts|cts)$/.test(name) && !/\.d\.[cm]?ts$/.test(name);
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, out);
    } else if (isScanned(e.name)) out.push(p);
  }
  return out;
}

/** The scanned sources: `[{ rel, text }]`, every package's `src`, declaration files left out. */
export function sizeSources(root) {
  const pkgs = path.join(root, 'packages');
  const out = [];
  for (const d of fs.readdirSync(pkgs).sort()) {
    for (const f of walk(path.join(pkgs, d, 'src')).sort()) out.push({ rel: path.relative(root, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') });
  }
  return out;
}

/** The lines of a text, a last newline not counted as a line of its own. */
export const lineCount = (text) => (text === '' ? 0 : text.replace(/\r?\n$/, '').split('\n').length);

const isFunctionLike = (ts, n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isArrowFunction(n) ||
  ts.isFunctionExpression(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessorDeclaration(n) ||
  ts.isSetAccessorDeclaration(n) ||
  ts.isClassStaticBlockDeclaration(n);

const QUALIFIER_MAX = 40;
/** A call's first argument that is a string or an identifier (not `fn` itself), as it reads: `'add'`, `items`. */
function firstWordArg(ts, call, fn) {
  for (const a of call.arguments) {
    if (a === fn) continue;
    if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) return `'${a.text.length > QUALIFIER_MAX ? `${a.text.slice(0, QUALIFIER_MAX)}…` : a.text}'`;
    if (ts.isIdentifier(a)) return a.text;
  }
  return undefined;
}

/**
 * What names a call a function is passed to: its own first string or identifier argument, else that of the first call
 * of the chain it ends (`x.command('add').option('--json').action(fn)`: `'add'`), else the same for the call it is
 * itself passed to (`.action(action(fn))`).
 */
function qualifierOf(ts, call, fn) {
  for (let c = call; c; ) {
    const own = firstWordArg(ts, c, fn);
    if (own) return own;
    const chain = [];
    for (let r = c; r && ts.isCallExpression(r); r = ts.isPropertyAccessExpression(r.expression) ? r.expression.expression : undefined) chain.unshift(r);
    for (const r of chain) {
      const q = firstWordArg(ts, r, fn);
      if (q) return q;
    }
    let p = c.parent;
    while (p && ts.isParenthesizedExpression(p)) p = p.parent;
    c = p && ts.isCallExpression(p) && p.arguments.includes(c) ? p : undefined;
  }
  return undefined;
}

/** The name of the function a call calls: a method's or a function's name, else `call`. */
const calleeName = (ts, e) => (ts.isPropertyAccessExpression(e) ? e.name.text : ts.isIdentifier(e) ? e.text : 'call');

/** A function's own name, else the name it is given (a variable, a property, a JSX attribute, a call's callee), else `<anonymous>`. */
function ownName(ts, n) {
  if (ts.isConstructorDeclaration(n)) return 'constructor';
  if (ts.isClassStaticBlockDeclaration(n)) return 'static';
  if (n.name) return (ts.isGetAccessorDeclaration(n) ? 'get ' : ts.isSetAccessorDeclaration(n) ? 'set ' : '') + n.name.getText();
  let p = n.parent;
  while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression?.(p))) p = p.parent;
  if (!p) return '<anonymous>';
  if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isJsxAttribute(p)) && p.name) return p.name.getText();
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return p.left.getText().replace(/\s+/g, '');
  if (ts.isCallExpression(p)) {
    let callee = p.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    if (callee === n) return '<iife>';
    const q = qualifierOf(ts, p, n);
    return `${calleeName(ts, p.expression)}(${q ?? '…'})`;
  }
  if (ts.isExportAssignment(p)) return 'default';
  if (ts.isReturnStatement(p)) return '<returned>';
  return '<anonymous>';
}

/**
 * The control structures that nest; an `else if` (the else branch of an if), a conditional's false branch and a
 * `catch` (which sits at its try's depth, as an else does) do not.
 */
function nestsHere(ts, n) {
  if (ts.isIfStatement(n)) return !(ts.isIfStatement(n.parent) && n.parent.elseStatement === n);
  if (ts.isConditionalExpression(n)) {
    let p = n.parent;
    while (p && ts.isParenthesizedExpression(p)) p = p.parent;
    return !(p && ts.isConditionalExpression(p) && (p.whenFalse === n || p.whenFalse === n.parent));
  }
  return ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n) || ts.isSwitchStatement(n) || ts.isTryStatement(n);
}

/** The deepest nesting of control structures inside one function's body, nested functions left to themselves. */
function nestingOf(ts, fn) {
  let max = 0;
  const visit = (n, depth) => {
    if (n !== fn && isFunctionLike(ts, n)) return;
    // An `else if` adds no depth: it sits at the depth of the if it continues.
    const d = nestsHere(ts, n) ? depth + 1 : depth;
    if (d > max) max = d;
    ts.forEachChild(n, (c) => visit(c, d));
  };
  ts.forEachChild(fn, (c) => visit(c, 0));
  return max;
}

/**
 * The measures of one source: `[{ measure, file, name, size, shared }]` for every file and function (all of them, over
 * the limit or not). A function's name is its path of names in the file (`Outer › inner`); `shared` counts the
 * functions of the file with that same path (1 when the key is its own).
 */
export function measureSource(ts, rel, text) {
  const out = [{ measure: 'file', file: rel, name: '', size: lineCount(text) }];
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, /x$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const visit = (n, owners) => {
    let next = owners;
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) next = [...owners, n.name?.getText() ?? '<class>'];
    if (isFunctionLike(ts, n)) {
      const name = [...owners, ownName(ts, n)].join(' › ');
      const params = (n.parameters ?? []).filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this')).length;
      out.push({ measure: 'body', file: rel, name, size: lineOf(n.getEnd()) - lineOf(n.getStart(sf)) + 1 });
      out.push({ measure: 'params', file: rel, name, size: params });
      out.push({ measure: 'nesting', file: rel, name, size: nestingOf(ts, n) });
      next = [...owners, ownName(ts, n)];
    }
    ts.forEachChild(n, (c) => visit(c, next));
  };
  visit(sf, []);
  const shared = new Map();
  for (const m of out) if (m.measure === 'body') shared.set(m.name, (shared.get(m.name) ?? 0) + 1);
  for (const m of out) m.shared = m.measure === 'file' ? 1 : shared.get(m.name);
  return out;
}

/** The key of an entry in the baseline. */
export const entryKey = (m) => (m.name ? `${m.file} › ${m.name}` : m.file);

/**
 * Every measure over its limit: `{ file: { key: size }, body: …, params: …, nesting: …, ambiguous: [lines] }`. A
 * function over a limit whose key other functions of its file share is not an entry but an `ambiguous` line: it asks
 * for a name.
 */
export function sizeEntries(root, sources = sizeSources(root), limits = LIMITS) {
  const ts = loadTs(root);
  const out = Object.fromEntries(MEASURES.map((m) => [m, {}]));
  const ambiguous = new Set();
  for (const { rel, text } of sources) {
    for (const m of measureSource(ts, rel, text)) {
      if (m.size <= limits[m.measure]) continue;
      if (m.shared > 1) ambiguous.add(`${entryKey(m)}: ${m.shared} functions share this key, one is over the ${m.measure} limit (give it a name)`);
      else out[m.measure][entryKey(m)] = m.size;
    }
  }
  out.ambiguous = [...ambiguous];
  return out;
}

/** The committed baseline: `{ about, limits, groups: [{ measure, reason, entries: { key: size } }] }`. */
export function readSizeBaseline(root) {
  const p = path.join(root, SIZE_BASELINE);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { groups: [] };
}

/** The allowed size of each key per measure, all groups together. */
function allowed(baseline) {
  const out = Object.fromEntries(MEASURES.map((m) => [m, {}]));
  for (const g of baseline.groups ?? []) Object.assign((out[g.measure] ??= {}), g.entries);
  return out;
}

/**
 * Today's entries against the baseline: `added` (new, or above the recorded size), `stale` (recorded, now within the
 * limit), `lowered` (smaller than recorded, still over), `ambiguous` (a function over a limit without a key of its
 * own), `limits` (the baseline's limits are not LIMITS), `unexplained` (a group without a reason). Each a list of
 * lines; any of them fails the check.
 */
export function compareSizes(entries, baseline, limits = LIMITS) {
  const base = allowed(baseline);
  const added = [];
  const stale = [];
  const lowered = [];
  for (const m of MEASURES) {
    const now = entries[m] ?? {};
    const was = base[m] ?? {};
    for (const [k, size] of Object.entries(now)) {
      if (!(k in was)) added.push(`${m} ${k}: ${size} (limit ${limits[m]})`);
      else if (size > was[k]) added.push(`${m} ${k}: ${size}, above its recorded ${was[k]}`);
      else if (size < was[k]) lowered.push(`${m} ${k}: ${size}, below its recorded ${was[k]}`);
    }
    for (const k of Object.keys(was)) if (!(k in now)) stale.push(`${m} ${k}: within ${limits[m]} now`);
  }
  const limitsDiffer = JSON.stringify(baseline.limits ?? {}) !== JSON.stringify(limits) ? [`the baseline's limits ${JSON.stringify(baseline.limits ?? {})} are not ${JSON.stringify(limits)}`] : [];
  const unexplained = (baseline.groups ?? []).filter((g) => !String(g.reason ?? '').trim()).map((g) => `a ${g.measure} group has no reason`);
  return { added, stale, lowered, ambiguous: entries.ambiguous ?? [], limits: limitsDiffer, unexplained };
}

/** The failure report of a comparison, '' when the baseline holds. */
export function sizeReport(cmp) {
  const parts = [];
  if (cmp.added.length) parts.push(`over the limit, not in ${SIZE_BASELINE} (split it, or add it with a reason):\n  ${cmp.added.join('\n  ')}`);
  if (cmp.stale.length) parts.push(`within the limit now, remove from ${SIZE_BASELINE} (${SIZE_WRITE_HINT}):\n  ${cmp.stale.join('\n  ')}`);
  if (cmp.lowered.length) parts.push(`smaller than recorded, lower it in ${SIZE_BASELINE} (${SIZE_WRITE_HINT}):\n  ${cmp.lowered.join('\n  ')}`);
  if (cmp.ambiguous.length) parts.push(`over a limit without a key of its own (name the function):\n  ${cmp.ambiguous.join('\n  ')}`);
  if (cmp.limits.length) parts.push(cmp.limits.join('\n'));
  if (cmp.unexplained.length) parts.push(cmp.unexplained.join('\n'));
  return parts.join('\n');
}

/**
 * The baseline for today: each entry stays in the group it was in (its reason kept, its size today's); a new entry goes
 * to a group of its measure without a reason (`reason: ''`), for the author to write.
 */
export function rewriteSizeBaseline(entries, old, limits = LIMITS) {
  const groups = (old.groups ?? []).map((g) => ({ measure: g.measure, reason: g.reason, entries: {} }));
  const placed = new Set();
  for (const [gi, g] of (old.groups ?? []).entries()) {
    for (const k of Object.keys(g.entries ?? {})) {
      const size = entries[g.measure]?.[k];
      if (size !== undefined && !placed.has(`${g.measure} ${k}`)) {
        groups[gi].entries[k] = size;
        placed.add(`${g.measure} ${k}`);
      }
    }
  }
  for (const m of MEASURES) {
    const fresh = Object.entries(entries[m] ?? {}).filter(([k]) => !placed.has(`${m} ${k}`));
    if (!fresh.length) continue;
    let g = groups.find((x) => x.measure === m && !String(x.reason).trim());
    if (!g) groups.push((g = { measure: m, reason: '', entries: {} }));
    for (const [k, size] of fresh) g.entries[k] = size;
  }
  for (const g of groups) g.entries = Object.fromEntries(Object.entries(g.entries).sort(([a], [b]) => a.localeCompare(b)));
  return { about: old.about ?? '', limits, groups: groups.filter((g) => Object.keys(g.entries).length) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
  const entries = sizeEntries(root);
  const old = readSizeBaseline(root);
  if (process.argv.includes('--write-baseline')) {
    const next = rewriteSizeBaseline(entries, old);
    fs.writeFileSync(path.join(root, SIZE_BASELINE), JSON.stringify(next, null, 1) + '\n');
    const count = next.groups.reduce((a, g) => a + Object.keys(g.entries).length, 0);
    console.log(`${SIZE_BASELINE}: ${count} entries in ${next.groups.length} groups`);
    const todo = next.groups.filter((g) => !String(g.reason).trim());
    if (todo.length) console.log(`write a one-line reason for ${todo.length} new group(s): ${todo.map((g) => g.measure).join(', ')}`);
    if (entries.ambiguous.length) console.log(`name these functions (not recorded):\n  ${entries.ambiguous.join('\n  ')}`);
  } else if (process.argv.includes('--check')) {
    const cmp = compareSizes(entries, old);
    const report = sizeReport(cmp);
    const count = MEASURES.reduce((a, m) => a + Object.keys(entries[m]).length, 0);
    console.log(report || `${SIZE_BASELINE} holds: ${count} entries`);
    if (report) process.exitCode = 1;
  } else {
    for (const a of entries.ambiguous) console.log(`ambiguous  ${a}`);
    for (const m of MEASURES) {
      const list = Object.entries(entries[m]).sort((a, b) => b[1] - a[1]);
      console.log(`# ${m} over ${LIMITS[m]}: ${list.length}`);
      for (const [k, size] of list) console.log(`${String(size).padStart(5)}  ${k}`);
    }
  }
}
