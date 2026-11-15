// comment-ref: comments a reader can follow. A comment of packages/*/src, packages/*/test, apps/ or scripts/ names no
// lot or phase id (`L`, the phase, maybe a dot, the lot and a letter: the docs keep those, the code says what it does)
// and no reference to a note that is not in the repository: a review named by its letter, any critic's note, an audit by
// its date, a finding, plan or probe by its code, a path into the private notes folder, an audit or review finding
// code (letters, a dash, a letter and a number), a bare finding code as a parenthesis' item, an id of the private
// action or test plan. Requirement ids (`R-UI-07`) resolve in docs/requirements.json and are not hits. Only comment
// ranges are read — the trivia of TypeScript's syntax tree for TS / JS files, a small lexer for Rust, CSS, shell, TOML
// and Python — never another string or runtime text; a comment with the old-name tag is left out (it names the old
// spellings on purpose). The test titles of packages/*/test (the first argument of `it`, `describe`, `test` and
// `suite`, a template's text parts included) hold none either, nor a bare finding code before a title's colon, a list of
// codes, a parenthesis of a bare code, number or section ("(C1)", "(9)", "(§4)") nor a review's fix or a plan's part
// (titleRefHits). Look-alikes accepted (never hits): the import rules' `R<n>`, the codecs VP8 / VP9, MP4, PS4, the C0 /
// C1 control sets (outside a title's lone parenthesis), D1 / D2 in a comment's parenthesis, the SPEC's version 2.
// Look-alikes that ARE hits, so a comment or title spells them another way: an SVG path command (`L` and a number),
// an ISO time (`T` and the hour), a heading or track label before a title's colon ("H1:", "V1:"), a count alone in a
// parenthesis ("(45)").
// import-rules.test.ts holds one fixture per form.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** The TypeScript compiler of the scanned tree, else this repository's. */
const loadTs = (root) => {
  try {
    return createRequire(path.join(root, 'package.json'))('typescript');
  } catch {
    return createRequire(import.meta.url)('typescript');
  }
};

/** A lot id or a phase id: `L`, the phase, then maybe a dot, the lot and a letter. */
export const LOT_ID = /\bL\d+(?:\.\d+[a-z]?)?\b/g;
/**
 * A reference to a note outside the repository, any case: a review with its letter (and its finding), any critic's note,
 * an audit by its date, a finding, a plan item or a probe with its code, a path into the private notes folder.
 */
export const NOTE_REF =
  /\b(?:reviews? [a-zA-Z](?:[ -][A-Z]{1,2}-?[A-Z]?\d+[a-z]?\b|(?=[\s]*(?:[.,;:)/—–]|$)))|critiques?\b|audit 20\d\d-\d\d-\d\d|findings? [A-Z]{1,3}\d+[a-z]?\b|plan [A-Z]{1,2}\d+[a-z]?\b|plan §\d|probes? [A-Z]{1,2}\d+\b|reviews? [A-Z]{1,2}\d+[a-z]?\b)|\.private\//gi;
/** A finding code: two letters, a dash, a letter and a number (the audit's); a letter, a dash, a severity and a number (a review's); `T-` and a number (the test plan's). */
export const FINDING_CODE = /(?<![\w-])(?:[A-Z]{2}-[A-Z]\d+[a-z]?|[A-Z]-[A-Z]{1,2}\d+[a-z]?|T-\d+[a-z]?)(?![\w-])/g;
/**
 * A bare finding code, one or two capitals and a number, as the start of a parenthesis' item (alone, after a comma,
 * a semicolon or a slash, maybe after a review's letter). Not one: the import rules' own R-numbers (they resolve), the
 * product version 2 of the SPEC, names that look alike (the VP8 / VP9 codecs, MP4, PS4, the C0 / C1 control sets, the
 * camera's difference matrices D1 / D2).
 */
export const BARE_CODE = /(?<=\([^()]*?)(?<=[(,;/][ \t]*(?:[A-D] )?)(?<![\w-])(?!R\d|V2\b|VP[89]\b|MP4\b|PS4\b|C[01]\b|D[12]\b)[A-Z]{1,2}\d{1,2}[a-z]?(?=\s*(?:[),;/]|:\s))/g;
/** An id of the private action plan or test plan: `U` or `T`, a number, maybe a letter. */
export const PLAN_ID = /(?<![\w-])[UT]\d{1,2}[a-z]?(?![\w-])/g;
/** Every pattern a comment may not hold. */
export const COMMENT_REF_PATTERNS = [LOT_ID, NOTE_REF, FINDING_CODE, BARE_CODE, PLAN_ID];

/** The tag of a comment that names the old spellings on purpose (spelt in two pieces: this file carries no tag). */
const OLD_NAME_TAG = ['old-name', ':'].join('');

const SKIP = new Set(['node_modules', 'dist', 'target', 'gen', '.git']);
const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const OTHER_EXT = /\.(rs|css|sh|toml|py)$/;

/** The files the check reads, repository-relative. */
export function commentFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(r);
      } else if (TS_EXT.test(e.name) || OTHER_EXT.test(e.name)) out.push(r);
    }
  };
  const pkgs = path.join(root, 'packages');
  if (fs.existsSync(pkgs)) for (const p of fs.readdirSync(pkgs).sort()) for (const d of ['src', 'test']) walk(`packages/${p}/${d}`);
  walk('apps');
  walk('scripts');
  return out.sort();
}

/** The comment ranges of a TS / JS file: the trivia before every token of its syntax tree (JSX text is no comment). */
function tsComments(ts, rel, text) {
  const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.jsx$/.test(rel) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, false, kind);
  const seen = new Map();
  const add = (rs) => {
    for (const r of rs ?? []) seen.set(r.pos, [r.pos, r.end]);
  };
  (function visit(n) {
    if (n.kind === ts.SyntaxKind.JsxText) return;
    const kids = n.getChildren(sf);
    if (!kids.length) {
      add(ts.getLeadingCommentRanges(text, n.pos));
      add(ts.getTrailingCommentRanges(text, n.end));
    } else for (const k of kids) visit(k);
  })(sf);
  return [...seen.values()];
}

/** Rust: `//…` and nested `/* … *\/`, outside strings, raw strings and char literals. */
function rustComments(text) {
  const out = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const j = text.indexOf('\n', i);
      const end = j < 0 ? text.length : j;
      out.push([i, end]);
      i = end;
    } else if (c === '/' && d === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth) {
        if (text[j] === '/' && text[j + 1] === '*') depth++, (j += 2);
        else if (text[j] === '*' && text[j + 1] === '/') depth--, (j += 2);
        else j++;
      }
      out.push([i, j]);
      i = j;
    } else if (c === 'r' && (d === '"' || d === '#') && !/\w/.test(text[i - 1] ?? ' ')) {
      let j = i + 1;
      let hashes = 0;
      while (text[j] === '#') hashes++, j++;
      if (text[j] !== '"') {
        i++;
        continue;
      }
      const close = `"${'#'.repeat(hashes)}`;
      const k = text.indexOf(close, j + 1);
      i = k < 0 ? text.length : k + close.length;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else if (c === "'") {
      if (d === '\\') i = text.indexOf("'", i + 2) + 1 || text.length;
      else i += text[i + 2] === "'" ? 3 : 1; // a char literal, else a lifetime
    } else i++;
  }
  return out;
}

/** CSS: `/* … *\/`. */
function cssComments(text) {
  const out = [];
  for (let i = text.indexOf('/*'); i >= 0; i = text.indexOf('/*', i)) {
    const j = text.indexOf('*/', i + 2);
    const end = j < 0 ? text.length : j + 2;
    out.push([i, end]);
    i = end;
  }
  return out;
}

/** Shell, TOML, Python: a `#` at a line's start or after a space, outside quotes, to the line's end (not a shebang). */
function hashComments(text) {
  const out = [];
  let off = 0;
  for (const line of text.split('\n')) {
    let quote = null;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (quote) {
        if (ch === '\\' && quote === '"') k++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '#' && (k === 0 || /\s/.test(line[k - 1]))) {
        if (!(k === 0 && line.startsWith('#!'))) out.push([off + k, off + line.length]);
        break;
      }
    }
    off += line.length + 1;
  }
  return out;
}

/** The comment ranges `[start, end]` of one file. */
export function commentRanges(ts, rel, text) {
  if (TS_EXT.test(rel)) return tsComments(ts, rel, text);
  if (/\.rs$/.test(rel)) return rustComments(text);
  if (/\.css$/.test(rel)) return cssComments(text);
  return hashComments(text);
}

/** The lot ids and note references of one file's comments: `[{ line, ref }]`. */
export function commentRefsOf(ts, rel, text) {
  const out = [];
  for (const [start, end] of commentRanges(ts, rel, text)) {
    const body = text.slice(start, end);
    if (body.includes(OLD_NAME_TAG)) continue;
    for (const re of COMMENT_REF_PATTERNS) for (const m of body.matchAll(re)) out.push({ line: text.slice(0, start + m.index).split('\n').length, ref: m[0] });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** comment-ref hits of the tree (or of `files`, `[{ rel, text }]`): one per file, with its count. `{ rule, file, count, refs }`. */
export function commentRefHits(root, files) {
  const ts = loadTs(root);
  const list = files ?? commentFiles(root).map((rel) => ({ rel, text: fs.readFileSync(path.join(root, rel), 'utf8') }));
  const hits = [];
  for (const { rel, text } of list) {
    const refs = commentRefsOf(ts, rel, text);
    if (refs.length) hits.push({ rule: 'comment-ref', file: rel, count: refs.length, refs });
  }
  return hits;
}

/** A bare finding code (maybe after a review's letter) or a list of them before a title's colon, at its start. */
export const LEAD_CODE = /^(?:⚑ )?(?:(?:[A-D] )?(?!R\d|V2\b|VP[89]\b|MP4\b|PS4\b|C[01]\b|D[12]\b)[A-Z]{1,2}\d{1,2}[a-z]?(?:\s*[,/]\s*|\s+and\s+)?)+(?=:\s)/g;
/**
 * A review's fix or its numbered point ("review fixes", "review fix K1", "review A #4", "small point 3.2", "fix pass"), a
 * ruling by its number, a plan's part or point as a parenthesis of its own ("(part D)", "(#6)").
 */
export const REVIEW_FIX = /\breviews? (?:[A-Za-z] )?(?:fix(?:es)?\b|#\d+)|\b(?:small point \d+(?:\.\d+)?|ruling \d+|fix pass)\b|\((?:part [A-Z0-9]+|#\d+)\)/gi;
/** A list of finding codes anywhere in a title, slashes or commas between them: "B16 / B5", "A1, A2". */
export const CODE_LIST = /(?<![\w-])(?:(?!R\d|VP[89]\b|MP4\b|PS4\b|C[01]\b)[A-Z]{1,2}\d{1,2}[a-z]?)(?:\s*[,/]\s*(?!R\d|VP[89]\b|MP4\b|PS4\b|C[01]\b)[A-Z]{1,2}\d{1,2}[a-z]?)+(?![\w-])/g;
/** A parenthesis of a title holding a bare code, number or section only: "(C1)", "(9)", "(§4.2)". */
export const BARE_PAREN = /\((?:(?!R\d|VP[89]\)|MP4\)|PS4\))[A-Z]{1,2}\d{1,2}[a-z]?|\d{1,2}|§\d+(?:\.\d+)*)\)/g;
/** Every pattern a test title may not hold. */
export const TITLE_REF_PATTERNS = [...COMMENT_REF_PATTERNS, LEAD_CODE, REVIEW_FIX, CODE_LIST, BARE_PAREN];

const TEST_FNS = new Set(['it', 'describe', 'test', 'suite']);

/** The test titles of a TS / JS file: `[{ line, text }]`, a template's text parts joined (its `${…}` left out). */
export function testTitles(ts, rel, text) {
  const kind = /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : /\.jsx$/.test(rel) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(rel) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  /** The name a call's callee starts from: `it` of `it.skipIf(…)(…)`, `describe.each(…)(…)`. */
  const rootName = (e) => {
    while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) e = e.expression;
    return ts.isIdentifier(e) ? e.text : null;
  };
  const out = [];
  (function visit(n) {
    if (ts.isCallExpression(n) && n.arguments.length && TEST_FNS.has(rootName(n.expression) ?? '')) {
      // A string or template first argument (the table of `it.each(table)` and the condition of `it.skipIf(cond)` are
      // neither; the title is the first argument of the call they return).
      const a = n.arguments[0];
      const line = sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1;
      if (ts.isStringLiteralLike(a)) out.push({ line, text: a.text });
      else if (ts.isTemplateExpression(a)) out.push({ line, text: [a.head.text, ...a.templateSpans.map((s) => s.literal.text)].join(' ') });
    }
    ts.forEachChild(n, visit);
  })(sf);
  return out;
}

/** The lot ids and note references of one test file's titles: `[{ line, ref }]`. */
export function titleRefsOf(ts, rel, text) {
  const out = [];
  for (const t of testTitles(ts, rel, text)) {
    if (t.text.includes(OLD_NAME_TAG)) continue;
    for (const re of TITLE_REF_PATTERNS) for (const m of t.text.matchAll(re)) out.push({ line: t.line, ref: m[0] });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** comment-ref hits of the test titles (every packages/<pkg>/test, or `files`): one per file, with its count. `{ rule, file, count, refs }`. */
export function titleRefHits(root, files) {
  const ts = loadTs(root);
  const list =
    files ??
    commentFiles(root)
      .filter((rel) => /^packages\/[^/]+\/test\//.test(rel) && TS_EXT.test(rel))
      .map((rel) => ({ rel, text: fs.readFileSync(path.join(root, rel), 'utf8') }));
  const hits = [];
  for (const { rel, text } of list) {
    if (!TS_EXT.test(rel)) continue;
    const refs = titleRefsOf(ts, rel, text);
    if (refs.length) hits.push({ rule: 'comment-ref', file: rel, count: refs.length, refs });
  }
  return hits;
}
