/**
 * L4.1 part 2: the Studio app's sources never build HTML from data (D13) — a lint over src/app bans the raw-HTML and
 * code-from-string APIs, `src=` attributes, and any `href` not built by `hrefTo` (or a literal in-app fragment) — and the
 * hash routes treat whatever the address bar holds as an inert string. L4.2: one image source (Thumb.tsx, a data: URL
 * from `jpegDataUrl`), and no srcSet, createElement, `src` key or embedded media anywhere. L4.4 (critique B14): the live
 * picture is decoded by `createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}))` in LiveView.tsx only — no blob: or
 * object URL anywhere (an address a frame could be loaded from). L4.5 part C: one frame — PreviewFrame.tsx's `<iframe`,
 * once, with the literal attributes of player/parent.ts's PREVIEW_FRAME_ATTRS (`sandbox="allow-scripts"` and no other
 * sandbox token anywhere in the app) and `src={frameSrc}` once, frameSrc being the URL TimelineScreen.tsx checked with
 * previewUrls (the player origin's frame route) and set only after connectPreview listens. L4.7 part D1: the one image
 * source is Thumb.tsx's `Picture` (`imageDataUrl`: JPEG step pictures and contact sheets through `Jpeg`, PNG library
 * posters, GIF library loops — fixed prefixes, plain base64, the use's cap, PNG / GIF magic; never SVG or WebP); every
 * `<Picture` of the app names its format and cap literally; the library route; no "made with Claude" anywhere. L4.7 part
 * D2: the theme editor's live frame is the second page passing a checked URL to PreviewFrame (the same literal lines).
 * L4.8 part 5: the Record screen renders page text only through Txt — its views rendered (react-dom/server) with a
 * hostile string in every page field: each one inside a <bdi>, no raw direction control, no markup; its words module
 * never reads page text; the record route. L4.9 part B: the palette closed (no colour literal outside app.css's :root,
 * every var() defined and every token used, no fallback), the Geist pair named first, every text / background token pair
 * at 4.5:1 (the static contrast guarantee), placeholders coloured by the app, and real controls — a TypeScript-parser
 * pass: a user-input handler (any `on…` but focus, change, load and media events) only on a native control or an
 * element with a control role, a literal or roving tabIndex 0 and, for a click, a key handler (five reasoned
 * exceptions, keyed by exact attributes and their source line), no spread onto a non-native element, no <a> without a
 * real href, no positive tabIndex; no outline removed, transparent or faded without an accent ring in its place, and
 * every focus ring drawn in --accent / --accent-strong; opacity below 1 only on the accepted states (four since L5.9, three since L5.12a, two since L5.12c — the unset colour well is hatched in the kit); no colour
 * literal (hex of 3–8 digits, a colour function, a named colour) in the app's TypeScript.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Fragment, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@retake/components/kit';
import { catalogueOperation } from '@retake/engine/catalogue';
import type { RecordOptionsAnswer, RecordViewAnswer } from '../src/server/record-ops.js';
import { RecordingBody } from '../src/app/record/RecordingBody.js';
import { StartForm } from '../src/app/record/StartScreen.js';
import { SlotContext } from '../src/app/shell/slots.js';
import type { RecordingUi } from '../src/app/record/draft.js';
import { REPO } from '../../engine/test/helpers.js';
import { visibleControls } from '../src/app/bits.js';
import { hrefTo, parseRoute } from '../src/app/route.js';
import { FRAME_URL_RE, previewUrls } from '../src/app/timeline-words.js';
import { PREVIEW_FRAME_ATTRS } from '../src/player/parent.js';
import { LOOP_DATA_MAX, POSTER_DATA_MAX, SHEET_DATA_MAX, THUMB_DATA_MAX, imageDataUrl, jpegDataUrl } from '../src/app/thumbs.js';
import { colourTokens, tokenMap, tokensCss } from '../src/app/tokens.js';
import { Blocker, Button, Callout, Checklist, ChecklistItem, ChoiceChips, ColorField, CommandPalette, ContactSheet, DataTable, DiffTable, Disclosure, EmptyState, Facts, FieldRow, FrameCard, FrameGrid, FrameOption, InspectorSection, Kbd, LinkButton, Menu, NumberField, PosterGrid, Progress, RadioGroup, RegionOverlay, RowCard, Scrubber, Segmented, SegmentedLinks, Select, Sheet, SourceList, StatusBar, StatusMark, Switch, Tag, TerminalCommands, TextArea, TextField, Toolbar, Track, TrackItem } from '../src/app/ui-kit/index.js';
import { STATUS_TOKENS } from './a11y.js';
import { cssClasses, offKit, ratchetFindings, readTable } from '../scripts/kit-ratchet.js';
import type { Appearance } from '../src/app/tokens.js';

const APP = join(REPO, 'packages', 'ui', 'src', 'app');

/** Each banned pattern with why. */
const BANNED: Array<[RegExp, string]> = [
  [/dangerouslySetInnerHTML/, 'React raw HTML'],
  [/\.innerHTML\b|\.outerHTML\b/, 'raw HTML through the DOM'],
  [/insertAdjacentHTML|createContextualFragment|DOMParser|\bsrcdoc\b|srcDoc/i, 'HTML parsing from a string'],
  [/document\.write/, 'document.write'],
  [/\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(/, 'code from a string'],
  [/set(?:Timeout|Interval)\s*\(\s*['"`]/, 'a timer with code as a string'],
  [/\.setAttribute\s*\(/, 'attributes set outside React'],
  [/javascript:/i, 'a javascript: URL'],
  [/\bsrc=\{?/, 'a src attribute (the app shows no frame or script from data; Thumb.tsx holds the one image source)'],
  [/\bsrcset\b/i, 'a srcSet attribute (an image address list from data)'],
  [/\bcreateElement\s*\(|\bcloneElement\s*\(/, 'elements built outside JSX (props the lint cannot see)'],
  [/(?:^|[{,\s])['"]?src['"]?\s*:|\[\s*['"]src['"]\s*\]/m, 'a src key (spread onto an element as {...{src: x}})'],
  [/<(?:iframe|object|embed|video|audio|source|track|image)\b|\bposter=/, 'a frame, an embedded object or media from data'],
  [/\b(?:formAction|action)=\{/, 'a form action bound to data'],
  [/URL\.createObjectURL|\bcreateObjectURL\b|\bblob:/i, 'an object or blob: URL (the live picture is decoded in memory: createImageBitmap)'],
];

/**
 * L4.4 (B14): the one image decoder — LiveView.tsx's decodeJpeg: `new Decoder({ data: bytes, type: 'image/jpeg' })`
 * (WebCodecs' ImageDecoder, review A) else `createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))`, each once,
 * on the checked bytes of a frame; no other file decodes an image.
 */
const LIVE_FILE = 'LiveView.tsx';
const LIVE_DECODE = /createImageBitmap\(new Blob\(\[bytes\], \{ type: 'image\/jpeg' \}\)\)/g;
const LIVE_IMAGE_DECODER = /new Decoder\(\{ data: bytes, type: 'image\/jpeg' \}\)/g;

/**
 * L4.2: the app's one image source — Thumb.tsx renders `<img src={url}` where `url` is built by the checked-address
 * function. Exactly that line, once, in that file only. L4.5 part E: the step pictures and the review's contact sheets
 * go through `Jpeg`; every `<Jpeg` in the app passes `max={THUMB_DATA_MAX}` or `max={SHEET_DATA_MAX}` literally. L4.7
 * part D1: that `<img>` is `Picture` with `const url = imageDataUrl(format, base64, max);` — every `<Picture` names its
 * format and the cap of that format literally (`format="png" … max={POSTER_DATA_MAX}`, `format="gif" … max={LOOP_DATA_MAX}`),
 * except Jpeg's own one in Thumb.tsx (`format="jpeg" base64={base64} max={max}`).
 */
const THUMB_FILE = 'Thumb.tsx';
const THUMB_SRC = /<img src=\{url\} /g;
const THUMB_URL = /const url = imageDataUrl\(format, base64, max\);/g;
const JPEG_USE = /<Jpeg\b[^>]*>/g;
const JPEG_MAX = /\bmax=\{(THUMB_DATA_MAX|SHEET_DATA_MAX)\}/;
const PICTURE_USE = /<Picture\b[^>]*>/g;
const PICTURE_CAP = /^<Picture format="(?:png"[^>]*\bmax=\{POSTER_DATA_MAX\}|gif"[^>]*\bmax=\{LOOP_DATA_MAX\})[^>]*>$/;
const PICTURE_JPEG = '<Picture format="jpeg" base64={base64} max={max} width={width} height={height} alt={alt} />';

/**
 * L4.5: the app's one frame — PreviewFrame.tsx renders `<iframe` once with these literal attributes (the same as
 * PREVIEW_FRAME_ATTRS) and `src={frameSrc}` once, where `const frameSrc = armed ? url : undefined;` (url: the checked
 * frame URL its page passes, `url={urls.frame}`, urls = previewUrls(...)).
 */
const FRAME_FILE = 'PreviewFrame.tsx';
const FRAME_TAG = /<iframe\b/g;
const FRAME_SRC = /\bsrc=\{frameSrc\}/g;
const FRAME_SRC_SET = /const frameSrc = armed \? url : undefined;/g;
const FRAME_LITERALS = ['sandbox="allow-scripts"', 'referrerPolicy="no-referrer"', 'allow="autoplay"', 'aria-hidden="true"', 'tabIndex={-1}'];
/** Sandbox tokens that would loosen the frame, and attributes that would bypass the literal ones: nowhere in the app. */
const FRAME_LOOSE = /allow-(?:same-origin|top-navigation|popups|forms|downloads|modals|pointer-lock|presentation|storage-access|orientation-lock)|\bsandbox=\{|\bcredentialless\b|\ballowFullScreen\b|\bcsp=/;

/** A source as the lint reads it: Thumb.tsx without its one allowed image source, PreviewFrame.tsx without its one frame (each checked on its own). */
function linted(f: string, src: string): string {
  if (f === THUMB_FILE) return src.replace(THUMB_SRC, '<img ');
  // L5.9: tokens.css's two font faces (their URLs are pinned by the palette lint).
  if (f === 'tokens.css') return src.replace(/^ {2}src: url\('\/fonts\/[\w-]+\.woff2'\) format\('woff2'\);$/gm, '');
  if (f === 'tokens.ts') return src.replace("\\n  src: url('/fonts/${f.file}') format('woff2');", '');
  if (f === FRAME_FILE) return src.replace(FRAME_TAG, '<span').replace(FRAME_SRC, 'data-frame-src');
  return src;
}

async function appSources(): Promise<Array<[string, string]>> {
  const files = (await readdir(APP, { recursive: true })).filter((f) => /\.(tsx?|css)$/.test(f));
  return Promise.all(files.map(async (f) => [f, await readFile(join(APP, f), 'utf8')] as [string, string]));
}

/** The source without comments (a comment may name what is banned). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * L6.13: the app's API calls go through its data modules (src/app/data/): `themeEdit(args, o)` is
 * `call('theme_edit', args, o)`, `useThemeList(args, key)` is `useCall('theme_list', args, key)`, and the two data
 * functions whose op is an argument (`threadWrite(op, args)`, `projectRead(op, args)`) are `call(op, args)`. The op
 * lints below see each as the call it makes: `call` / `useCall` by their names, a data function when the file imports
 * it from a data module (a local function of the same name is not one).
 */
interface DataFn {
  /** The op it calls, or null when the op is its first argument (then `ops`: the ones it takes). */
  op: string | null;
  ops: string[];
}
function dataFunctions(): Map<string, DataFn> {
  const out = new Map<string, DataFn>();
  for (const f of readdirSync(join(APP, 'data')).filter((x) => /\.ts$/.test(x))) {
    const text = readFileSync(join(APP, 'data', f), 'utf8');
    for (const m of text.matchAll(/^export const (\w+) = (?:op|readHook)\('([a-z_]+)'\);$/gm)) out.set(m[1], { op: m[2], ops: [m[2]] });
    const aliases = new Map([...text.matchAll(/^export type (\w+) = ((?:'[a-z_]+'(?: \| )?)+);$/gm)].map((m) => [m[1], m[2]]));
    // L6.12–L6.13 fixes: generic over the op (`<K extends …>(name: K, …)`); `keyof typeof <TABLE>` names a table's keys.
    const tables = new Map([...text.matchAll(/^const (\w+) = \{ ([^}]+) \};$/gm)].map((m) => [m[1], [...m[2].matchAll(/(\w+): /g)].map((x) => `'${x[1]}'`).join(' | ')]));
    for (const [k, v] of [...text.matchAll(/^export type (\w+) = keyof typeof (\w+);$/gm)].map((m) => [m[1], tables.get(m[2]) ?? ''] as const)) aliases.set(k, v);
    for (const m of text.matchAll(/^export function (\w+)(?:<\w+ extends ([^>]+)>)?\(name: ([^,]+), /gm)) {
      const type = m[2] ?? m[3];
      const union = aliases.get(type) ?? type;
      out.set(m[1], { op: null, ops: [...union.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) });
    }
  }
  return out;
}
const DATA_FNS = dataFunctions();

/** The data modules' sources but the client's and the op map's (which make no call of their own): [file, text]. */
function dataSources(): Array<[string, string]> {
  return readdirSync(join(APP, 'data'))
    .filter((x) => /\.ts$/.test(x) && x !== 'client.ts' && x !== 'ops.ts')
    .map((f) => [f, readFileSync(join(APP, 'data', f), 'utf8')]);
}

/** Every value those modules export, by name (its file): a re-export of values counts as one. */
function dataValueExports(sources: Array<[string, string]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [f, text] of sources) {
    const src = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    for (const st of src.statements) {
      const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported && ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) out.set(d.name.getText(src), f);
      if (exported && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) out.set(st.name.text, f);
      if (ts.isExportDeclaration(st) && !st.isTypeOnly) out.set(`(re-export in ${f})`, f);
    }
  }
  return out;
}
const isDataModule = (spec: string) => /(^|\/)data\/[a-z-]+\.js$/.test(spec);

/** The data functions a source imports from a data module (by their own names). */
function dataImports(src: ts.SourceFile): Map<string, DataFn> {
  const out = new Map<string, DataFn>();
  for (const st of src.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !isDataModule(st.moduleSpecifier.text)) continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamedImports(b)) for (const e of b.elements) if (!e.propertyName && DATA_FNS.has(e.name.text)) out.set(e.name.text, DATA_FNS.get(e.name.text)!);
  }
  return out;
}

interface ApiCall {
  /** The op (a literal), or `(not a literal: …)`. */
  op: string;
  /** Its arguments' expression. */
  args: ts.Expression | undefined;
  /** The call's argument list as written: `(…)`. */
  list: string;
  /** The callee as written. */
  callee: string;
  line: number;
  node: ts.CallExpression;
}

/** Every API call of a source: `call(op, args, …)` / `useCall(op, args, key)` (`members`: `x.call(…)` too) and data functions. */
function apiCalls(text: string, o: { members?: boolean } = {}): ApiCall[] {
  const src = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const data = dataImports(src);
  const out: ApiCall[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c) ? c.text : o.members && ts.isPropertyAccessExpression(c) && c.name.text === 'call' ? 'call' : null;
      const d = name !== null && ts.isIdentifier(c) ? data.get(name) : undefined;
      const at = name === 'call' || name === 'useCall' || (d && d.op === null) ? 0 : d ? -1 : null;
      if (at !== null) {
        const opArg = at === 0 ? n.arguments[0] : undefined;
        const op = d?.op ?? (opArg && ts.isStringLiteral(opArg) ? opArg.text : `(not a literal: ${opArg ? opArg.getText(src) : ''})`);
        const list = `(${n.arguments.map((x) => x.getText(src)).join(', ')})`;
        out.push({ op, args: n.arguments[at + 1], list, callee: c.getText(src), line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1, node: n });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

describe('the app builds no HTML from data (source lint)', () => {
  it('no raw-HTML, eval or src= API in src/app; every href is hrefTo(...) or a literal "#…"', async () => {
    const files = await appSources();
    expect(files.map(([f]) => f)).toEqual(expect.arrayContaining(['main.tsx', 'ReadmeEditor.tsx', 'WelcomeScreen.tsx', 'shell/AppShell.tsx', 'ui-kit/Button.tsx']));
    for (const [f, text] of files) {
      const src = linted(f, code(text));
      for (const [re, why] of BANNED) expect(re.test(src), `${f}: ${why} (${re})`).toBe(false);
      for (const m of src.matchAll(/\bhref=(\{[^}]*\}?|"[^"]*"|'[^']*')/g)) {
        expect(/^\{hrefTo\(/.test(m[1]) || /^["']#/.test(m[1]), `${f}: href=${m[1]} is not built by hrefTo`).toBe(true);
      }
    }
  });

  it('no raw direction control in the sources; the app shows the ones in data as visible marks', async () => {
    for (const [f, text] of await appSources()) expect(/[\u202A-\u202E\u2066-\u2069]/.test(text), f).toBe(false);
    expect(visibleControls('\u202Egnp.exe')).toBe('[U+202E]gnp.exe');
    expect(visibleControls('a\u2066b\u2069c\u202Ad')).toBe('a[U+2066]b[U+2069]c[U+202A]d');
    expect(visibleControls('Café — 東京 עברית')).toBe('Café — 東京 עברית');
  });

  it('L4.3: the app builds no YAML — no yaml import, only types from core (the server alone writes scenario text)', async () => {
    const files = await appSources();
    expect(files.map(([f]) => f)).toEqual(expect.arrayContaining(['YamlTab.tsx', 'TextEditing.tsx']));
    for (const [f, text] of files) {
      const src = code(text);
      expect(/from\s+['"]yaml['"]|import\(\s*['"]yaml['"]\s*\)|require\(\s*['"]yaml['"]/.test(src), `${f}: imports yaml`).toBe(false);
      for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*from\s+['"](@retake\/[a-z-]+)['"]/gm)) expect(m[1], `${f}: a runtime import of ${m[2]}`).toBeTruthy();
    }
  });

  it('the lint catches each banned API (a planted line fails it)', () => {
    const planted = [
      '<div dangerouslySetInnerHTML={{ __html: x }} />',
      'el.innerHTML = x;',
      'eval(x)',
      'new Function(x)',
      '<img src={x} />',
      'a.setAttribute("href", x)',
      "location.href = 'javascript:x'",
      '<img srcSet={x} />',
      '<source srcset="a.jpg 2x" />',
      "createElement('img', { alt: '' })",
      '<img {...{ src: x }} />',
      "const p = { alt: '', 'src': x };",
      "p['src'] = x;",
      '<iframe title="x" />',
      '<video poster={x} />',
      '<object data={x} />',
    ];
    for (const line of planted) expect(BANNED.some(([re]) => re.test(code(line))), line).toBe(true);
    expect(/^\{hrefTo\(/.test('{url}')).toBe(false);
    // The exception covers Thumb.tsx's one line only: the same line elsewhere, or another src in Thumb.tsx, fails.
    expect(BANNED.some(([re]) => re.test(linted('Other.tsx', '<img src={url} alt="" />')))).toBe(true);
    expect(BANNED.some(([re]) => re.test(linted(THUMB_FILE, '<img src={url} alt="" />')))).toBe(false);
    expect(BANNED.some(([re]) => re.test(linted(THUMB_FILE, '<img src={other} alt="" />')))).toBe(true);
    expect(BANNED.some(([re]) => re.test(linted(THUMB_FILE, '<img alt="" src={url} />')))).toBe(true);
  });

  it('L4.4: the one image decoder — ImageDecoder, else createImageBitmap of a JPEG Blob, in LiveView.tsx only; no blob: or object URL anywhere', async () => {
    const files = new Map(await appSources());
    const live = code(files.get(LIVE_FILE) ?? '');
    expect(live.match(LIVE_DECODE)?.length, 'one createImageBitmap(new Blob([bytes], {type: image/jpeg})) in LiveView.tsx').toBe(1);
    expect(live.match(LIVE_IMAGE_DECODER)?.length, "one new Decoder({ data: bytes, type: 'image/jpeg' }) in LiveView.tsx").toBe(1);
    expect(live.match(/createImageBitmap/g)?.length).toBe(1);
    expect(live.match(/new Blob\(/g)?.length).toBe(1);
    expect(live.match(/new Decoder\(/g)?.length).toBe(1);
    // bytes come from bytesOf (the frame's base64, checked FF D8 FF) only, through decodeJpeg.
    expect(live.match(/const bytes = bytesOf\(f\.jpeg\);/g)?.length).toBe(1);
    expect(live.match(/decodeJpeg\(bytes\)/g)?.length).toBe(1);
    for (const [f, text] of files) {
      if (f === LIVE_FILE) continue;
      expect(/createImageBitmap|new\s+Blob\b|\bImageDecoder\b|\bFileReader\b/.test(code(text)), `${f}: decodes an image or builds a Blob`).toBe(false);
    }
    for (const line of ['const u = URL.createObjectURL(b);', "const a = 'blob:' + x;", 'const { createObjectURL } = URL;']) expect(BANNED.some(([re]) => re.test(code(line))), line).toBe(true);
  });

  it('⚑ L4.5: the one frame — PreviewFrame.tsx, once, the literal sandboxed attributes, src={frameSrc} from a checked URL', async () => {
    const files = new Map(await appSources());
    const frame = code(files.get(FRAME_FILE) ?? '');
    expect(frame.match(FRAME_TAG)?.length, 'one <iframe in PreviewFrame.tsx').toBe(1);
    expect(frame.match(FRAME_SRC)?.length, 'one src={frameSrc}').toBe(1);
    expect(frame.match(/\bsrc=/g)?.length).toBe(1);
    expect(frame.match(FRAME_SRC_SET)?.length, 'frameSrc set once, from url, only once armed').toBe(1);
    expect(frame.match(/\bframeSrc\s*=/g)?.length).toBe(1);
    // The connection listens before the address is set: connectPreview in the layout effect, then setArmed(true).
    const connect = frame.indexOf('connectPreview(iframe');
    expect(connect).toBeGreaterThan(0);
    expect(frame.indexOf('setArmed(true)')).toBeGreaterThan(connect);
    expect(frame.match(/setArmed\(true\)/g)?.length).toBe(1);
    // The literal attributes, each once, and they are PREVIEW_FRAME_ATTRS.
    const tag = frame.slice(frame.indexOf('<iframe'), frame.indexOf('/>', frame.indexOf('<iframe')));
    for (const lit of FRAME_LITERALS) expect(tag.split(lit).length - 1, lit).toBe(1);
    expect(PREVIEW_FRAME_ATTRS).toEqual({ sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', allow: 'autoplay', 'aria-hidden': 'true', tabindex: '-1' });
    expect(tag).not.toMatch(/\{\.\.\./);
    // Its page passes the URL previewUrls checked, nothing else.
    const screen = code(files.get('TimelineScreen.tsx') ?? '');
    expect(screen.match(/<PreviewFrame\b/g)?.length).toBe(1);
    expect(screen.match(/\burl=\{urls\.frame\}/g)?.length).toBe(1);
    expect(screen.match(/const urls = 'frame_url' in v \? previewUrls\(v\.frame_url, v\.plan_url\) : null;/g)?.length).toBe(1);
    expect(screen.match(/\burls\s*=/g)?.length).toBe(1);
    // L4.7 part D2: the theme editor's live frame passes its checked URL the same way; no other file mounts a PreviewFrame.
    const themes = code(files.get('ThemeEditor.tsx') ?? '');
    expect(themes.match(/<PreviewFrame\b/g)?.length).toBe(1);
    expect(themes.match(/\burl=\{urls\.frame\}/g)?.length).toBe(1);
    expect(themes.match(/const urls = 'frame_url' in v \? previewUrls\(v\.frame_url, v\.plan_url\) : null;/g)?.length).toBe(1);
    expect(themes.match(/\burls\s*=/g)?.length).toBe(1);
    for (const [f, text] of files) if (f !== 'TimelineScreen.tsx' && f !== 'ThemeEditor.tsx') expect(/<PreviewFrame\b/.test(code(text)), `${f}: mounts a PreviewFrame`).toBe(false);
    // No other file frames anything, connects a preview or loosens a sandbox; sandbox= appears once in the app.
    let sandboxes = 0;
    for (const [f, text] of files) {
      const src = code(text);
      expect(FRAME_LOOSE.test(src), `${f}: loosens the frame`).toBe(false);
      sandboxes += src.split('sandbox=').length - 1;
      if (f === FRAME_FILE) continue;
      expect(/<iframe\b|connectPreview|PREVIEW_FRAME_ATTRS/.test(src), `${f}: frames or connects a preview`).toBe(false);
    }
    expect(sandboxes).toBe(1);
    // The lint catches a second frame, another src, a loosened sandbox.
    expect(BANNED.some(([re]) => re.test(linted('Other.tsx', '<iframe title="x" />')))).toBe(true);
    expect(BANNED.some(([re]) => re.test(linted(FRAME_FILE, '<iframe src={other} />')))).toBe(true);
    for (const line of ['<iframe sandbox="allow-scripts allow-same-origin" />', '<iframe sandbox={x} />', 'f.sandbox.add("allow-popups")']) expect(FRAME_LOOSE.test(line), line).toBe(true);
  });

  it('L4.5: previewUrls takes only the player origin\'s frame and a plan of the same capability', () => {
    const cap = 'A'.repeat(43);
    const frame = `http://127.0.0.1:4321/s/${cap}/frame`;
    const plan = `http://127.0.0.1:4321/m/${cap}/plan/${'b'.repeat(22)}.json`;
    expect(previewUrls(frame, plan)).toEqual({ frame, plan });
    expect(FRAME_URL_RE.test(frame)).toBe(true);
    for (const [f, p] of [
      [frame.replace('127.0.0.1', 'localhost'), plan],
      [frame.replace('http:', 'https:'), plan],
      [`${frame}?x`, plan],
      [frame.replace(cap, 'B'.repeat(43)), plan],
      [frame, plan.replace(':4321', ':4322')],
      [frame, plan.replace('/plan/', '/x/')],
      ['javascript:alert(1)', plan],
      [`data:text/html,<script>`, plan],
      [frame, `http://127.0.0.1:4321/m/${cap}/plan/../../v1/info`],
      [42, plan],
      [frame, undefined],
    ] as Array<[unknown, unknown]>) {
      expect(previewUrls(f, p), `${String(f)} ${String(p)}`).toBeNull();
    }
  });

  it('the one image source: Thumb.tsx, once, `src={url}` with url = imageDataUrl(format, base64, max)', async () => {
    const files = new Map(await appSources());
    const thumb = code(files.get(THUMB_FILE) ?? '');
    expect(thumb.match(THUMB_SRC)?.length, 'one <img src={url} in Thumb.tsx').toBe(1);
    expect(thumb.match(THUMB_URL)?.length, 'url is built by imageDataUrl, once').toBe(1);
    expect(thumb.match(/\burl\s*=/g)?.length, 'url assigned once').toBe(1);
    expect(thumb.match(/\bsrc=/g)?.length).toBe(1);
    expect(thumb).toMatch(/max: ImageCap;/);
    for (const [f, text] of files) if (f !== THUMB_FILE) expect(/\bsrc=/.test(linted(f, code(text))), f).toBe(false);
    // L4.5 part E: every use of the one <img> names one of the two caps.
    let uses = 0;
    for (const [f, text] of files) {
      for (const m of code(text).matchAll(JPEG_USE)) {
        uses++;
        expect(JPEG_MAX.test(m[0]), `${f}: ${m[0]}`).toBe(true);
      }
    }
    expect(uses).toBeGreaterThanOrEqual(2);
    expect(JPEG_MAX.test('<Jpeg base64={b} max={9999999} />')).toBe(false);
    // L4.7 part D1: every <Picture names its format and that format's cap literally; Jpeg's own one, once, in Thumb.tsx.
    let pictures = 0;
    let jpegs = 0;
    for (const [f, text] of files) {
      for (const m of code(text).matchAll(PICTURE_USE)) {
        if (f === THUMB_FILE && m[0] === PICTURE_JPEG) {
          jpegs++;
          continue;
        }
        pictures++;
        expect(PICTURE_CAP.test(m[0]), `${f}: ${m[0]}`).toBe(true);
      }
    }
    expect(jpegs).toBe(1);
    expect(pictures).toBeGreaterThanOrEqual(2);
    for (const bad of ['<Picture format="png" base64={b} max={LOOP_DATA_MAX} />', '<Picture format="gif" base64={b} max={POSTER_DATA_MAX} />', '<Picture format={f} base64={b} max={POSTER_DATA_MAX} />', '<Picture format="svg" base64={b} max={POSTER_DATA_MAX} />', '<Picture format="jpeg" base64={b} max={max} />']) {
      expect(PICTURE_CAP.test(bad), bad).toBe(false);
    }
    // The caps: a contact sheet's payload is refused past SHEET_DATA_MAX, a step picture's past THUMB_DATA_MAX.
    const b64 = (n: number) => 'A'.repeat(n);
    expect(jpegDataUrl(b64(THUMB_DATA_MAX + 4))).toBeNull();
    expect(jpegDataUrl(b64(THUMB_DATA_MAX + 4), SHEET_DATA_MAX)).not.toBeNull();
    expect(jpegDataUrl(b64(SHEET_DATA_MAX + 4), SHEET_DATA_MAX)).toBeNull();
    expect(jpegDataUrl(b64(THUMB_DATA_MAX + 4), 9_999_999 as never)).toBeNull();
    expect(jpegDataUrl('AAAA<svg>', SHEET_DATA_MAX)).toBeNull();
  });
});

/**
 * L4.6 part D1: the page never names who writes — every comment write (`thread_*` call) of the app carries no author,
 * channel (`via`) or proposal key: the Studio writes the channel `studio` under the name it was started with, and
 * proposals are Claude's (the server refuses all three: a 400).
 */
const NAMED = /\b(author|via|proposal|name)\s*:/;

/** The argument list of each `thread_…` call in a source (`call('thread_…', …)` or its data function's). */
function threadCalls(src: string): Array<{ op: string; args: string }> {
  return apiCalls(src)
    .filter((c) => c.op.startsWith('thread_'))
    .map((c) => ({ op: c.op, args: c.list }));
}

describe('the comment writes name nobody (L4.6 part D1)', () => {
  it('⚑ no thread_* call of the app sends an author, a via, a proposal or a name', async () => {
    const calls = (await appSources()).flatMap(([f, text]) => threadCalls(code(text)).map((c) => ({ f, ...c })));
    const ops = new Set(calls.map((c) => c.op));
    // Part D2: Apply and Resolve with vN call their ops directly (L5.12b: ProposalCard.tsx).
    for (const op of ['thread_add', 'thread_get', 'thread_still', 'thread_apply', 'thread_resolve']) expect(ops, op).toContain(op);
    // Reply, resolve and reopen go through one helper (ThreadActions' send — L5.12b: ThreadPanel.tsx): its op names are
    // arguments. M1: the helper's call is pinned by name to its owner, and no other file of the app holds it.
    const sources = await appSources();
    const screen = code(sources.find(([f]) => f === 'ThreadPanel.tsx')![1]);
    for (const op of ['thread_reply', 'thread_resolve', 'thread_reopen']) expect(screen).toContain(`'${op}'`);
    const HELPER = /threadWrite\(op, \{ project: slug, comment_id: th\.id, \.\.\.args \} as OpArgs<K>\)/g;
    expect(screen.match(HELPER)?.length).toBe(1);
    expect(sources.filter(([f, text]) => (code(text).match(HELPER) ?? []).length > 0 || /\bsend\('[A-Za-z]+', 'thread_/.test(code(text))).map(([f]) => f)).toEqual(['ThreadPanel.tsx']);
    for (const c of calls) expect(NAMED.test(c.args), `${c.f}: ${c.op} sends ${c.args}`).toBe(false);
    // Every send(...) of the thread's writes: its argument object names nobody either.
    for (const m of screen.matchAll(/\bsend\('[A-Za-z]+', '(thread_[a-z_]+)', (\{[^}]*\})/g)) expect(NAMED.test(m[2]), `${m[1]}: ${m[2]}`).toBe(false);
    expect([...screen.matchAll(/\bsend\('[A-Za-z]+', '(thread_[a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(['thread_reopen', 'thread_reply', 'thread_resolve']);
    // The lint catches a planted author (or via, proposal) in a write.
    for (const planted of ["call('thread_add', { project, author: { via: 'cli', name: 'x' }, text })", "call<X>('thread_reply', { project, via: 'cli' })", "call('thread_reply', { proposal: p })"]) {
      expect(threadCalls(planted).some((c) => NAMED.test(c.args)), planted).toBe(true);
    }
  });
});

describe('the page makes no proposal (L4.6 part D2)', () => {
  it("⚑ no source sends a scenario text as a proposal: the app's one `proposal` argument is timeline_view's {comment_id, entry_id}", async () => {
    const files = await appSources();
    let args = 0;
    for (const [f, text] of files) {
      const src = code(text);
      expect(/\bscenario_yaml\b|\bscenario_hash\b/.test(src), `${f}: names a proposal's input`).toBe(false);
      args += (src.match(/\{ proposal: \{ comment_id: pc, entry_id: pe \} \}/g) ?? []).length;
    }
    expect(args).toBe(1);
    const timeline = code(files.find(([f]) => f === 'TimelineScreen.tsx')![1]);
    expect(timeline).toMatch(/useTimelineView\(args,/);
    // L6.12–L6.13 fixes (L7): that read is timeline_view's (the one op whose `proposal` it is).
    expect(DATA_FNS.get('useTimelineView')).toEqual({ op: 'timeline_view', ops: ['timeline_view'] });
    // thread_apply sends the reply and the proposal's hash shown, nothing else (L5.12b: ProposalCard.tsx, M1: the one call
    // of the app — no other file applies).
    const panel = code(files.find(([f]) => f === 'ProposalCard.tsx')![1]);
    const applies = threadCalls(panel).filter((c) => c.op === 'thread_apply');
    expect(applies.map((c) => c.args)).toEqual(['({ project: slug, comment_id: threadId, entry_id: entryId, if_match: ifMatch })']);
    const everywhere = files.flatMap(([f, text]) => threadCalls(code(text)).filter((c) => c.op === 'thread_apply').map(() => f));
    expect(everywhere).toEqual(['ProposalCard.tsx']);
    // L6.13: data/ names it once (its function); its arguments and result are derived from the op table (data/ops.ts).
    expect(files.filter(([f, text]) => !f.startsWith('data/') && /thread_apply|threadApply/.test(code(text))).map(([f]) => f)).toEqual(['ProposalCard.tsx']);
    expect(files.filter(([f, text]) => f.startsWith('data/') && /\bop\('thread_apply'\)/.test(text)).map(([f]) => f)).toEqual(['data/comments.ts']);
  });
});

describe('hash routes', () => {
  it('parses the three screens; anything else is not-found; slugs are decoded strings, never paths', () => {
    expect(parseRoute('')).toEqual({ name: 'projects' });
    expect(parseRoute('#/')).toEqual({ name: 'projects' });
    expect(parseRoute('#/p/northfield-fixture')).toEqual({ name: 'project', slug: 'northfield-fixture' });
    expect(parseRoute('#/p/northfield-fixture/readme')).toEqual({ name: 'readme', slug: 'northfield-fixture' });
    expect(parseRoute('#/p/%3Cimg%20src%3Dx%3E')).toEqual({ name: 'project', slug: '<img src=x>' });
    expect(parseRoute('#/p/%E0%A4%A')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/a/b/c')).toMatchObject({ name: 'not-found' });
    expect(parseRoute(`#/p/${'a'.repeat(201)}`)).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#c=abc')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#javascript:alert(1)')).toMatchObject({ name: 'not-found' });
    // L4.2: a scenario as blocks or as YAML.
    expect(parseRoute('#/p/northfield-fixture/s/quote')).toEqual({ name: 'scenario', slug: 'northfield-fixture', scenario: 'quote', tab: 'blocks' });
    expect(parseRoute('#/p/northfield-fixture/s/quote/yaml')).toEqual({ name: 'scenario', slug: 'northfield-fixture', scenario: 'quote', tab: 'yaml' });
    expect(parseRoute('#/p/x/s/%3Cscript%3E')).toEqual({ name: 'scenario', slug: 'x', scenario: '<script>', tab: 'blocks' });
    expect(parseRoute('#/p/x/s/quote/blocks')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/x/s/')).toMatchObject({ name: 'not-found' });
    expect(parseRoute(`#/p/x/s/${'a'.repeat(201)}`)).toMatchObject({ name: 'not-found' });
    // L4.4: the Run screen, with or without a run.
    expect(parseRoute('#/p/northfield-fixture/s/quote/run')).toEqual({ name: 'run', slug: 'northfield-fixture', scenario: 'quote' });
    expect(parseRoute('#/p/northfield-fixture/s/quote/run/20261026-120000-quote')).toEqual({ name: 'run', slug: 'northfield-fixture', scenario: 'quote', run: '20261026-120000-quote' });
    expect(parseRoute('#/p/x/s/q/run/%3Cimg%3E')).toEqual({ name: 'run', slug: 'x', scenario: 'q', run: '<img>' });
    expect(parseRoute('#/p/x/s/q/run/a/b')).toMatchObject({ name: 'not-found' });
    expect(parseRoute(`#/p/x/s/q/run/${'a'.repeat(201)}`)).toMatchObject({ name: 'not-found' });
    // L4.5: the timeline of the latest capture, of one capture, at one of its steps.
    expect(parseRoute('#/p/northfield-fixture/s/quote/timeline')).toEqual({ name: 'timeline', slug: 'northfield-fixture', scenario: 'quote' });
    expect(parseRoute('#/p/northfield-fixture/s/quote/timeline/20261026-120000-quote')).toEqual({ name: 'timeline', slug: 'northfield-fixture', scenario: 'quote', run: '20261026-120000-quote' });
    expect(parseRoute('#/p/n/s/q/timeline/r1/request.2')).toEqual({ name: 'timeline', slug: 'n', scenario: 'q', run: 'r1', step: 'request.2' });
    expect(parseRoute('#/p/n/s/q/timeline/r1/request.2/x')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/n/s/q/timeline/%E0%A4%A')).toMatchObject({ name: 'not-found' });
    // L4.7 part D1: the library, in a theme, one component's detail.
    expect(parseRoute('#/p/northfield-fixture/library')).toEqual({ name: 'library', slug: 'northfield-fixture' });
    expect(parseRoute('#/p/northfield-fixture/library/editorial')).toEqual({ name: 'library', slug: 'northfield-fixture', theme: 'editorial' });
    expect(parseRoute('#/p/n/library/editorial/studio/card-cta')).toEqual({ name: 'library', slug: 'n', theme: 'editorial', component: 'studio/card-cta' });
    expect(parseRoute('#/p/n/library/editorial/studio')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/n/library/editorial/a/b/c')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/n/library/editorial/a%2Fb/c')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/n/library/%3Cimg%3E')).toEqual({ name: 'library', slug: 'n', theme: '<img>' });
    expect(parseRoute('#/p/n/library/%E0%A4%A')).toMatchObject({ name: 'not-found' });
  });

  it('hrefTo round-trips any slug through parseRoute and always yields an in-page fragment', () => {
    for (const slug of ['northfield-fixture', '<img src=x onerror=alert(1)>', 'a/b', '../..', '"\'><', '\u202Egnp.exe', '#/p/x']) {
      for (const name of ['project', 'readme'] as const) {
        const href = hrefTo({ name, slug });
        expect(href.startsWith('#/p/')).toBe(true);
        expect(parseRoute(href)).toEqual({ name, slug });
      }
    }
    expect(hrefTo({ name: 'projects' })).toBe('#/');
    for (const scenario of ['quote', '<img src=x>', 'a/b', '../..', '\u202Egnp.exe']) {
      for (const tab of ['blocks', 'yaml'] as const) {
        const href = hrefTo({ name: 'scenario', slug: 'p/q', scenario, tab });
        expect(href.startsWith('#/p/')).toBe(true);
        expect(parseRoute(href)).toEqual({ name: 'scenario', slug: 'p/q', scenario, tab });
      }
      for (const run of [undefined, '20261026-120000-quote', '../x', '<b>']) {
        const href = hrefTo({ name: 'run', slug: 'p/q', scenario, ...(run ? { run } : {}) });
        expect(href.startsWith('#/p/')).toBe(true);
        expect(parseRoute(href)).toEqual({ name: 'run', slug: 'p/q', scenario, ...(run ? { run } : {}) });
      }
      for (const [run, step] of [[undefined, undefined], ['20261026-120000-quote', undefined], ['../x', 'a.1'], ['<b>', '../../x']] as const) {
        const href = hrefTo({ name: 'timeline', slug: 'p/q', scenario, ...(run ? { run } : {}), ...(step ? { step } : {}) });
        expect(href.startsWith('#/p/')).toBe(true);
        expect(parseRoute(href)).toEqual({ name: 'timeline', slug: 'p/q', scenario, ...(run ? { run } : {}), ...(step ? { step } : {}) });
      }
      // A step without its run is dropped (the key is the run's own).
      expect(parseRoute(hrefTo({ name: 'timeline', slug: 'p', scenario, step: 'a.1' }))).toEqual({ name: 'timeline', slug: 'p', scenario });
    }
    // L4.7 part D1: the library; a component needs its theme and two segments.
    for (const theme of [undefined, 'editorial', '<b>', '../x', '\u202Egnp']) {
      for (const component of [undefined, 'studio/card-cta', 'a b/<c>']) {
        const r = { name: 'library' as const, slug: 'p/q', ...(theme ? { theme } : {}), ...(component ? { component } : {}) };
        const href = hrefTo(r);
        expect(href.startsWith('#/p/')).toBe(true);
        expect(parseRoute(href)).toEqual(theme ? r : { name: 'library', slug: 'p/q' });
      }
    }
    expect(parseRoute(hrefTo({ name: 'library', slug: 'p', theme: 't', component: 'a/b/c' }))).toEqual({ name: 'library', slug: 'p', theme: 't' });
    expect(parseRoute(hrefTo({ name: 'library', slug: 'p', theme: 't', component: 'nope' }))).toEqual({ name: 'library', slug: 'p', theme: 't' });
  });
});

describe('jpegDataUrl: the only way to an image address', () => {
  it('a fixed data:image/jpeg prefix on plain base64; anything else refused', () => {
    const ok = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]).toString('base64');
    expect(jpegDataUrl(ok)).toBe(`data:image/jpeg;base64,${ok}`);
    expect(jpegDataUrl('QUJD')).toBe('data:image/jpeg;base64,QUJD');
    for (const bad of [
      '',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      ' QUJD',
      'QU JD',
      'QUJD"',
      "QUJD'><script>",
      'QUJD\n',
      'QUJ',
      'QUJD====',
      'QU=D',
      'QUJD-_aa',
      'A'.repeat(THUMB_DATA_MAX + 4),
      null,
      undefined,
      42,
      ['QUJD'],
      { toString: () => 'QUJD' },
    ]) {
      expect(jpegDataUrl(bad), String(bad).slice(0, 40)).toBeNull();
    }
    expect(jpegDataUrl('A'.repeat(THUMB_DATA_MAX))).toBe(`data:image/jpeg;base64,${'A'.repeat(THUMB_DATA_MAX)}`);
  });
});

describe('imageDataUrl: library posters and loops (L4.7 part D1, critique B6 / B9)', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0]).toString('base64');
  const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00', 'latin1').toString('base64');
  const pad = (b64: string, n: number) => b64 + 'A'.repeat(n - b64.length);

  it('⚑ a PNG poster under POSTER_DATA_MAX and a GIF loop under LOOP_DATA_MAX, each with its fixed prefix and magic', () => {
    expect(imageDataUrl('png', PNG, POSTER_DATA_MAX)).toBe(`data:image/png;base64,${PNG}`);
    expect(imageDataUrl('gif', GIF, LOOP_DATA_MAX)).toBe(`data:image/gif;base64,${GIF}`);
    expect(imageDataUrl('png', pad(PNG, POSTER_DATA_MAX), POSTER_DATA_MAX)).not.toBeNull();
    expect(imageDataUrl('png', pad(PNG, POSTER_DATA_MAX + 4), POSTER_DATA_MAX)).toBeNull();
    expect(imageDataUrl('gif', pad(GIF, LOOP_DATA_MAX), LOOP_DATA_MAX)).not.toBeNull();
    expect(imageDataUrl('gif', pad(GIF, LOOP_DATA_MAX + 4), LOOP_DATA_MAX)).toBeNull();
  });

  it('⚑ the magic is checked: a GIF as a PNG, a PNG as a GIF, an SVG or a JPEG as either → refused', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]).toString('base64');
    const gif87 = Buffer.from('GIF87a\x01\x00\x01\x00', 'latin1').toString('base64');
    for (const [format, b64] of [['png', GIF], ['png', svg], ['png', jpeg], ['gif', PNG], ['gif', svg], ['gif', gif87], ['png', 'QUJD'], ['gif', 'AAAA']] as const) {
      expect(imageDataUrl(format, b64, format === 'png' ? POSTER_DATA_MAX : LOOP_DATA_MAX), `${format} ${b64.slice(0, 12)}`).toBeNull();
    }
  });

  it('⚑ a format only under its own cap; no SVG / WebP / other format; the base64 rules of jpegDataUrl hold', () => {
    // A PNG under the loop's larger cap counts as the poster's: refused past POSTER_DATA_MAX.
    expect(imageDataUrl('png', pad(PNG, POSTER_DATA_MAX + 4), LOOP_DATA_MAX)).toBeNull();
    // A JPEG under a library cap counts as a step picture's.
    expect(imageDataUrl('jpeg', 'A'.repeat(THUMB_DATA_MAX + 4), POSTER_DATA_MAX)).toBeNull();
    expect(imageDataUrl('jpeg', 'A'.repeat(THUMB_DATA_MAX + 4), SHEET_DATA_MAX)).not.toBeNull();
    for (const f of ['svg', 'svg+xml', 'webp', 'html', '', 'constructor', '__proto__', 'toString']) {
      expect(imageDataUrl(f as never, PNG, POSTER_DATA_MAX), f).toBeNull();
    }
    for (const bad of [`${PNG}"`, ` ${PNG}`, `${PNG}\n`, PNG.slice(0, -1), `data:image/png;base64,${PNG}`, null, 42, { toString: () => PNG }]) {
      expect(imageDataUrl('png', bad, POSTER_DATA_MAX), String(bad).slice(0, 30)).toBeNull();
    }
    expect(jpegDataUrl('QUJD')).toBe('data:image/jpeg;base64,QUJD');
  });

  it('no "made with Claude" in the app: the source badge says Built-in or Workspace (nobody can tell who wrote one)', async () => {
    for (const [f, text] of await appSources()) expect(/made (?:with|by) claude/i.test(code(text)), f).toBe(false);
  });
});

/** A right-to-left override, built at run time (the sources hold no raw direction control). */
const RLO = String.fromCharCode(0x202e);
/** A page string: markup that would run as HTML, a marker, then a direction override. */
const H = (n: string) => `<img src=x onerror="globalThis.__pwned='${n}'">PAGE-${n}${RLO}gnp`;

/** A Studio recording's view whose every page-derived string (and every name) is hostile. */
function hostileView(): RecordViewAnswer {
  const step = (index: number, n: string, extra: Record<string, unknown> = {}) => ({
    key: `${H('scene')}.${index}`,
    index,
    action: 'click',
    category: 'click',
    label: H(`label${n}`),
    target: H(`target${n}`),
    summary: H(`summary${n}`),
    chips: [{ kind: 'caption', label: H(`chip${n}`) }],
    occurrence: 0,
    issues: [],
    ...extra,
  });
  return {
    rec_id: 'rec_01JABCDEFGHJKMNPQRSTVWXYZ0',
    state: 'done',
    version: '0123456789abcdef',
    job: { id: 'j_01JABCDEFGHJKMNPQRSTVWXYZ0', state: 'failed', phase: null, cancel_requested: false, stop_requested: false, error: { code: 'invalid', message: H('jobmessage'), fix: H('jobfix') } },
    started_by: 'ui',
    can: { annotate: true, save: true, discard: true, stop: false },
    problem: H('problem'),
    name: H('name'),
    env: H('env'),
    persona: H('persona'),
    access: 'read-write',
    page: H('page'),
    path: H('path'),
    started_at: '2026-10-28T10:00:00.000Z',
    ends_at: '2026-10-28T10:30:00.000Z',
    rev: 3,
    counts: { events: 9, actions: 4, dropped_lines: 0 },
    stats: { scenes: 1, steps: 3, actions: 4, noise: 0, secrets: 1, fallbacks: 0 },
    issues: { error: 0, warning: 1, info: 0 },
    check: { status: 'failed', scope: 'all', steps_passed: 1, steps_total: 3, events_changed: false },
    saved: { name: H('savedname'), file: H('savedfile') },
    warnings: [H('warning')],
    writes: { total: 1, by_steps: 1, ambient: 0 },
    untrusted: {
      yaml_lines: [H('yaml1'), H('yaml2')],
      blocks: {
        parsed: true,
        video: { intro: { mode: 'theme' }, outro: { mode: 'theme' } },
        hooks: { setup: [], teardown: [], named: [] },
        entries: [{ type: 'scene', index: 0, id: H('scene'), page: H('scenepage'), open: H('sceneopen'), continues: false, context: 'x', steps: [step(0, '0'), step(1, '1'), step(2, '2', { category: 'hold', action: 'hold' })], issues: [] }],
        step_count: 3,
        issues: [],
      },
      sources: [
        { scene: H('scene'), step: 0, seqs: [1, 2], role: 'action', row: 'a1', target_seqs: [1], target_seq: 1, modifiers: ['i2'] },
        { scene: H('scene'), step: 1, seqs: [3, 3], role: 'helper', helper: 'wait', row: 'w3' },
        { scene: H('scene'), step: 2, seqs: [3, 3], role: 'insert', insert: 'i1', row: 'i:i1' },
      ],
      issues: [{ severity: 'warning', code: 'fragile_target', message: H('issue'), scene: H('scene'), step: 0 }],
      pending: ['i3'],
      placeholders: [{ name: H('placeholder'), kind: 'password', project_var: false, scene: H('scene'), step: 0 }],
      alternatives: [{ scene: H('scene'), step: 0, seq: 1, chosen: 1, options: [{ index: 0, target: { text: 'x' }, words: H('alt0'), fragile: [] }, { index: 1, target: { label: 'y' }, words: H('alt1'), fragile: ['css'] }] }],
      inserts: [
        { id: 'i1', after_seq: 2, kind: 'wait_for', until: 'text', text: H('waittext') },
        { id: 'i2', after_seq: 0, kind: 'caption', text: H('caption'), kicker: H('kicker') },
        { id: 'i3', after_seq: 3, kind: 'mark', name: H('mark') },
      ],
      writes: [{ label: H('write'), outcome: 'passed', scene: null, step: null }],
      check: { failed_at: { scene: H('scene'), step: 1, action: H('action') }, error: H('checkerror') },
    },
  } as unknown as RecordViewAnswer;
}

function hostileOptions(): RecordOptionsAnswer {
  return {
    project: 'p',
    default_env: H('env'),
    default_name: 'recorded-20261028-1000',
    max_minutes: 30,
    display: true,
    notes: [H('note')],
    open: { job: 'j_x', project: 'p', rec_id: H('openrec'), state: 'running' },
    environments: [
      {
        name: H('env'),
        production: false,
        access: 'read-write',
        sandbox: false,
        pages: [H('pagekey')],
        personas: [{ name: H('persona'), pages: [], login_steps: false, sandbox: false, status: 'never', in_use: false }],
        default: { page: H('pagekey'), path: '/', persona: H('persona') },
        problem: H('envproblem'),
        warnings: [H('envwarning')],
      },
    ],
    recent: [{ rec_id: H('recentid'), state: 'done', job: null, started_by: 'mcp', started_at: null, name: H('recentname'), env: H('recentenv'), persona: null, page: null, path: null, steps: 2, actions: 3, saved: { name: H('recentsaved'), file: 'x' }, studio: false }],
  } as unknown as RecordOptionsAnswer;
}

/**
 * The markup as a person (or a screen reader) gets it: identifiers that are never shown — a form value sent back, a
 * radio group's name, data-* attributes — removed (they hold the page string as it is).
 */
function shownMarkup(html: string): string {
  return html.replace(/\s(?:value|name|data-[a-z-]+)="[^"]*"/g, '');
}

/** Each `PAGE-<n>` of the markup: where it sits (in a <bdi>'s text, in an <option>'s text, in a tag's attribute, or bare). */
function placesOf(html: string): Array<{ n: string; where: 'bdi' | 'option' | 'attribute' | 'bare' }> {
  const out: Array<{ n: string; where: 'bdi' | 'option' | 'attribute' | 'bare' }> = [];
  for (const m of html.matchAll(/PAGE-([a-z0-9]+)/g)) {
    const before = html.slice(0, m.index);
    const inTag = before.lastIndexOf('<') > before.lastIndexOf('>');
    const where = inTag ? 'attribute' : before.lastIndexOf('<bdi') > before.lastIndexOf('</bdi>') ? 'bdi' : before.lastIndexOf('<option') > before.lastIndexOf('</option>') ? 'option' : 'bare';
    out.push({ n: m[1], where });
  }
  return out;
}

/** RecordingBody with its inspector rendered in place (the person hid it: ShellSlot's inline form), as the shell shows it. */
function recordingWithInspector(v: RecordViewAnswer, cursor: { at: 'end' } | { at: 'after'; row: string }) {
  const host = { targets: {}, hidden: { inspector: true }, claim: () => () => undefined };
  return createElement(SlotContext.Provider, { value: host }, createElement(Fragment, null, createElement(RecordingBody, { slug: 'p', v, cursor, setCursor: () => undefined, ui: UI, act: ACT })));
}

const UI: RecordingUi = { busy: false, note: { tone: 'danger', text: H('note'), issues: [{ severity: 'error', code: 'invalid', message: H('noteissue'), scene: H('scene'), step: 0 }], fix: H('notefix') }, taken: null, discarding: false, confirming: false, now: Date.parse('2026-10-28T10:05:00.000Z') };
const ACT = { annotate: () => undefined, stop: () => undefined, discard: () => undefined, save: () => undefined, onSignedIn: () => undefined, confirm: () => undefined };

describe('the Record screen shows page text only through Txt (L4.8 part 5)', () => {
  it('⚑ a recording: every page string (rows, targets, alternatives, inserts, issues, placeholders, writes, the check, the YAML) in a <bdi>, its direction controls as visible marks', () => {
    const done = hostileView();
    const failed = { ...done, state: 'failed' } as RecordViewAnswer;
    for (const [v, cursor] of [
      [done, { at: 'end' as const }],
      [done, { at: 'after' as const, row: 'a1' }],
      [failed, { at: 'end' as const }],
    ] as const) {
      const html = shownMarkup(renderToStaticMarkup(recordingWithInspector(v, cursor)));
      expect(html.includes(RLO), 'a raw direction control').toBe(false);
      expect(html).not.toMatch(/<img|onerror="/);
      const places = placesOf(html);
      const bare = places.filter((p) => p.where === 'bare' || p.where === 'option');
      expect(bare, JSON.stringify(bare)).toEqual([]);
      // Attributes hold page text only with the controls made visible (visibleControls): no raw RLO above.
      const shown = new Set(places.filter((p) => p.where === 'bdi').map((p) => p.n));
      for (const n of ['name', 'env', 'persona', 'page', 'path', 'scene', 'scenepage', 'sceneopen', 'label0', 'target0', 'summary0', 'chip0', 'label1', 'label2', 'summary2', 'caption', 'kicker', 'mark', 'issue', 'placeholder', 'write', 'checkerror', 'action', 'yaml1', 'yaml2', 'problem', 'warning', 'savedfile', 'note', 'noteissue', 'notefix']) {
        expect(shown, n).toContain(n);
      }
      // (L5.11b: an insert row says what it is by its own step — label2 / summary2 — beside its Remove; no chip repeats it.)
      // L5.11b: the selected row (the cursor's) shows its alternatives — the radios' words — and the inspector its step;
      // the cursor's words (its row's step and scene) are page text too, in the Insert toolbar's line and, its controls
      // made visible, in the toolbar's name (an attribute).
      if (cursor.at === 'after') {
        for (const n of ['alt0', 'alt1']) expect(shown, n).toContain(n);
        expect(html.slice(html.indexOf('Insert after')).slice(0, 400)).toMatch(/Insert after (?:<!-- -->)?<bdi[^>]*>step 1 of /);
        expect(html).toMatch(/aria-label="Insert after step 1 of [^"]*PAGE-scene\[U\+202E\]gnp"/);
        expect(html).toMatch(/<bdi>Step 1 · <\/bdi><bdi>[^<]*PAGE-label0/);
      } else expect(html).not.toContain('PAGE-alt0');
      // Each row an option of its scene's listbox (L5.11b fixes, review A-M2: the cursor's aria-selected="true"), its name
      // its own words; the cursor block is a group, not an option (review A-L3).
      if (v.can.annotate) {
        expect((html.match(/role="option" aria-selected="true"/g) ?? []).length).toBe(cursor.at === 'after' ? 1 : 0);
        expect(html).toMatch(/<div class="rc-here" role="group" aria-label="Inserts go [^"]*">/);
        expect((html.match(/role="option"/g) ?? []).length).toBe(v.untrusted!.blocks.entries.flatMap((e) => (e.type === 'scene' ? e.steps : [])).length);
      }
      // A failed job: its message and its command.
      if (v.state === 'failed') for (const n of ['jobmessage', 'jobfix']) expect(shown, n).toContain(n);
    }
  });

  it('B-L5: Start is refused for a persona that cannot sign in by itself — the reason said, Sign in offered', () => {
    const o = hostileOptions();
    const html = renderToStaticMarkup(createElement(StartForm, { slug: 'p', o: { ...o, open: null }, onStarted: () => undefined, onChanged: () => undefined }));
    expect(html).toMatch(/<button (?=[^>]*data-testid="record-start")(?=[^>]*type="submit")(?=[^>]*disabled="")/);
    expect(html).toContain('data-testid="record-start-blocked"');
    expect(html).toContain('data-testid="sign-in-button"');
    const signed = { ...o, open: null, environments: o.environments.map((e) => ({ ...e, problem: undefined, personas: e.personas.map((x) => ({ ...x, status: 'valid' as const })) })) } as RecordOptionsAnswer;
    const ok = renderToStaticMarkup(createElement(StartForm, { slug: 'p', o: signed, onStarted: () => undefined, onChanged: () => undefined }));
    expect(ok).not.toContain('data-testid="record-start-blocked"');
    expect(ok).toMatch(/<button (?=[^>]*data-testid="record-start")(?=[^>]*type="submit")/);
    expect(ok).not.toMatch(/<button (?=[^>]*data-testid="record-start")(?=[^>]*disabled="")/);
  });

  it('⚑ the start form and the recent list: names, notes, warnings, the open recording in a <bdi>; a select option with visible marks', () => {
    const html = shownMarkup(renderToStaticMarkup(createElement(StartForm, { slug: 'p', o: hostileOptions(), onStarted: () => undefined, onChanged: () => undefined })));
    expect(html.includes(RLO), 'a raw direction control').toBe(false);
    expect(html).not.toMatch(/<img|onerror="/);
    const places = placesOf(html);
    expect(places.filter((p) => p.where === 'bare'), html).toEqual([]);
    for (const n of ['note', 'openrec', 'persona', 'envproblem', 'envwarning']) expect(places.filter((p) => p.where === 'bdi').map((p) => p.n), n).toContain(n);
    // An <option> cannot hold a <bdi>: its text is visibleControls(…), the control shown as [U+202E].
    for (const n of ['env', 'pagekey', 'persona']) expect(html, n).toContain(`PAGE-${n}[U+202E]gnp`);
  });

  it('the lint catches a page string rendered bare (a planted row)', () => {
    expect(placesOf('<li>PAGE-x</li>')).toEqual([{ n: 'x', where: 'bare' }]);
    expect(placesOf('<li><bdi>PAGE-x</bdi> PAGE-y</li>')).toEqual([
      { n: 'x', where: 'bdi' },
      { n: 'y', where: 'bare' },
    ]);
    expect(placesOf('<button aria-label="PAGE-z">x</button>')).toEqual([{ n: 'z', where: 'attribute' }]);
    expect(shownMarkup('<option value="PAGE-a" data-key="PAGE-b">PAGE-c</option>')).toBe('<option>PAGE-c</option>');
  });

  it('record-words.ts never reads page text (no `untrusted`): its sentences hold enums, numbers and the Studio\'s own words', async () => {
    const words = code((await appSources()).find(([f]) => f === 'record-words.ts')![1]);
    expect(words).not.toMatch(/untrusted|yaml_lines|\.words\b|\.label\b|\.summary\b/);
  });

  it('the record route: the start form, one recording; ids inert strings; hrefTo round-trips', () => {
    expect(parseRoute('#/p/northfield-fixture/record')).toEqual({ name: 'record', slug: 'northfield-fixture' });
    expect(parseRoute('#/p/n/record/rec_01JABCDEFGHJKMNPQRSTVWXYZ0')).toEqual({ name: 'record', slug: 'n', rec: 'rec_01JABCDEFGHJKMNPQRSTVWXYZ0' });
    expect(parseRoute('#/p/n/record/%3Cimg%3E')).toEqual({ name: 'record', slug: 'n', rec: '<img>' });
    expect(parseRoute('#/p/n/record/a/b')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/n/record/%E0%A4%A')).toMatchObject({ name: 'not-found' });
    for (const rec of [undefined, 'rec_01JABCDEFGHJKMNPQRSTVWXYZ0', '../x', '<b>', `${RLO}gnp`]) {
      const r = { name: 'record' as const, slug: 'p/q', ...(rec ? { rec } : {}) };
      const href = hrefTo(r);
      expect(href.startsWith('#/p/')).toBe(true);
      expect(parseRoute(href)).toEqual(r);
    }
  });
});


// ── L4.9 part B: the closed palette, the fonts, contrast by token, real controls ─────────────────────────────────────

interface CssRule {
  selector: string;
  media?: string;
  decls: Array<[string, string]>;
}

/** app.css as rules (comments stripped; @media blocks walked). */
function cssRules(text: string): CssRule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: CssRule[] = [];
  const walk = (s: string, media?: string) => {
    let i = 0;
    for (;;) {
      const open = s.indexOf('{', i);
      if (open < 0) return;
      const prelude = s.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < s.length && depth > 0; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') depth--;
      }
      const body = s.slice(open + 1, j - 1);
      if (prelude.startsWith('@')) walk(body, prelude);
      else {
        const decls = body
          .split(';')
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()] as [string, string]);
        out.push({ selector: prelude, ...(media ? { media } : {}), decls });
      }
      i = j;
    }
  };
  walk(src);
  return out;
}

/** L5.12d: the page's base (element defaults only; the legacy layer, app.css, is gone). */
const baseCss = () => readFile(join(APP, 'base.css'), 'utf8');
/** L5.9: the app's stylesheets — every .css of the app but tokens.css (generated); L5.12d: base.css among them. */
async function kitCss(): Promise<Array<[string, string]>> {
  return (await appSources()).filter(([f]) => f.endsWith('.css') && f !== 'tokens.css');
}
/** L5.12d: the legacy layer is gone — app.css deleted, imported by nothing. */
async function legacyGone(): Promise<void> {
  expect(existsSync(join(APP, 'app.css'))).toBe(false);
  expect((await appSources()).filter(([, text]) => /app\.css['"]/.test(text)).map(([f]) => f)).toEqual([]);
}
const APPEARANCES: Appearance[] = ['dark', 'light'];
/** The tokens of one appearance, name → value: tokens.ts, the one token file (L5.9). */
const tokensOf = (a: Appearance): Map<string, string> => tokenMap(a);

/** A colour written as a literal (hex or a colour function); named colours are matched as whole values / words. */
const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const NAMED_COLOURS = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext field fieldtext highlight highlighttext graytext mark marktext accentcolor accentcolortext'.split(' ');
const NAMED_COLOUR = new RegExp(`(?:^|[\\s,(])(?:${NAMED_COLOURS.join('|')})(?=$|[\\s,)])`, 'i');
const colourIn = (value: string) => COLOUR_LITERAL.test(value) || NAMED_COLOUR.test(value);

// L5.12d: the legacy palette's pairs (CONTRAST_SETS, NON_TEXT_PAIRS) went with it — every pair below is the kit's.
/** The kit's backgrounds that carry no text: marks (status, the switch's track and knob, a progress fill), the sheet's backdrop. */
const UI_NON_TEXT_BG = ['ui-backdrop', 'ui-ring', 'ui-ok', 'ui-warn', 'ui-fail', 'ui-record', 'ui-idle', 'ui-waiting', 'ui-track', 'ui-knob', 'ui-hairline', 'ui-text-3'];
/** Translucent backgrounds laid over video: composited over every grey (anything may be under them). */
const OVER_MEDIA: string[] = [];

/**
 * L5.9: the kit's pairs (`--ui-*`), in both appearances — text at 4.5:1 on every surface it may sit on; marks (the focus
 * ring, status marks, the switch's knob and track, the accent fill as a mark) at 3:1 where they stand.
 * Accepted below 3:1 and stated (DESIGN §4k): --ui-hairline (decorative, inside lists), --ui-field-line (a field's
 * edge: every field has a visible label and the focus ring), --ui-select against --ui-pane (a selected row adds weight
 * 600 or a 2 px ring: the checker's `selected` rule), --ui-waiting on raised surfaces (never drawn there),
 * --ui-mark-plate against the title bar / canvas (L5.13b: the app mark's plate is a quiet lift in dark, ≈ 1.3:1 — the
 * blue take carries the mark, its pairs below).
 */
const UI_TEXT = ['text', 'text-2', 'text-3', 'text-strong', 'link', 'danger-text'];
const UI_SURFACES = ['canvas', 'pane', 'raised', 'raised-hi', 'field', 'well', 'overlay', 'select'];
const UI_TEXT_PAIRS: Array<[string, string[]]> = [
  ...UI_TEXT.map((t): [string, string[]] => [t, UI_SURFACES]),
  ['on-accent', ['accent', 'danger']],
  ['on-video', ['video']],
  ['text', ['kbd', 'record-tint', 'recording']],
  ['text-2', ['kbd']],
];
const UI_MARK_PAIRS: Array<[string, string[]]> = [
  ...['ring', 'ok', 'warn', 'fail', 'record', 'idle'].map((m): [string, string[]] => [m, ['canvas', 'pane', 'overlay', 'select', 'field']]),
  ['ring', ['raised']],
  ['waiting', ['canvas', 'pane', 'overlay']],
  ['knob', ['track']],
  ['track', ['canvas', 'pane', 'overlay']],
  ['accent', ['canvas', 'pane', 'overlay']],
  ['record', ['record-tint', 'recording']],
  // L5.13b: the app mark (kit AppMark, `fill` / `stroke` on these tokens): both takes on the plate, the front on the back.
  ['mark-back', ['mark-plate']],
  ['mark-front', ['mark-back', 'mark-plate']],
];

type RGBA = [number, number, number, number];
function rgbaOf(v: string | undefined): RGBA | undefined {
  if (!v) return undefined;
  const hex = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (hex) return [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as RGBA;
  const m = /^rgba\(([^)]+)\)$/.exec(v.trim());
  if (!m) return undefined;
  const p = m[1].split(',').map(Number);
  return p.length === 4 && p.every((x) => !Number.isNaN(x)) ? (p as RGBA) : undefined;
}
const hexOf = (c: RGBA) => `#${c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
const overOpaque = (top: RGBA, base: RGBA): RGBA => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3])).concat(1) as RGBA;
const GREYS = Array.from({ length: 11 }, (_x, i): RGBA => [i * 25.5, i * 25.5, i * 25.5, 1]);

/** The worst ratio of text token `t` on background token `b` (a translucent background composited over its bases). */
function worstRatio(tokens: Map<string, string>, t: string, b: string): number {
  const fg = rgbaOf(tokens.get(`--${t}`));
  const bg = rgbaOf(tokens.get(`--${b}`));
  if (!fg || !bg || fg[3] !== 1) return Number.NaN;
  const bases = bg[3] === 1 ? [bg] : (OVER_MEDIA.includes(b) ? GREYS : [rgbaOf(tokens.get('--ui-pane'))!, rgbaOf(tokens.get('--ui-canvas'))!]).map((base) => overOpaque(bg, base));
  // contrastRatio takes hex only: undefined (an unreadable token) is a failure, never a skip.
  return Math.min(...bases.map((base) => contrastRatio(hexOf(fg), hexOf(base)) ?? Number.NaN));
}

/** Any `on…` handler but these makes an element a control (user input): focus, change, form, load and media events. */
const NOT_INPUT = /^on(?:Focus|Blur|Change|Input|BeforeInput|Load|Error|Scroll|Submit|Reset|Invalid|Toggle|Close|Cancel|Select|Composition\w+|Animation\w+|Transition\w+|LoadStart|LoadedData|LoadedMetadata|CanPlay|CanPlayThrough|Play|Playing|Pause|Ended|TimeUpdate|Seeked|Seeking|Waiting|Stalled|Suspend|Emptied|DurationChange|RateChange|VolumeChange|Progress|Abort)(?:Capture)?$/;
const isHandler = (k: string) => /^on[A-Z]/.test(k) && !NOT_INPUT.test(k);
const NATIVE = new Set(['button', 'input', 'select', 'textarea', 'summary']);
const CONTROL_ROLE = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'option', 'menuitem', 'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox', 'listbox']);
/** Roles a click activates: Enter / Space must too (a key handler beside the click). */
const CLICK_ROLE = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'option', 'menuitem']);
/**
 * The deliberate exceptions, each with its reason: keyed by file, tag, every listed attribute's exact source text, and a
 * piece of the element's source line (a new element of the same kind is not excused).
 */
const REAL_CONTROL_EXCEPTIONS: Array<{ file: string; tag: string; attrs: Record<string, string>; line: string; why: string }> = [
  { file: 'FrameViewer.tsx', tag: 'div', attrs: { 'data-testid': '"viewer-frame"', onPointerDown: '{onDown}' }, line: '<div', why: "the region drag on the frame (L5.12b: FrameViewer.tsx's FramePicture; RegionOverlay draws, presentational); its keyboard alternative is the composer's four % fields" },
  { file: 'ui-kit/frames.tsx', tag: 'li', attrs: { role: '"option"', 'data-key': '{dataKey}', id: '{id}' }, line: '<li', why: "L5.10b: an option of a scene's frames listbox (FrameGrid), which holds the tab stop (aria-activedescendant); its drag moves are Alt+arrows by keyboard" },
  { file: 'ui-kit/frames.tsx', tag: 'p', attrs: { 'data-testid': '"drop-empty"', onDrop: '{dropped}' }, line: '<p', why: 'L5.10b: the drop target of a step dragged into an empty scene (FrameGrid); the keyboard moves steps with Alt+arrows' },
  { file: 'ui-kit/ChoiceChips.tsx', tag: 'div', attrs: { role: '"radiogroup"', className: '"k-chips"', onKeyDown: '{rove}' }, line: '<div className="k-chips" role="radiogroup"', why: "L5.12a (was TimelineInspector.tsx's tl-radios): the roving arrow keys of the kit's choice chips; its checked chip holds the tab stop" },
  { file: 'record/Inserts.tsx', tag: 'form', attrs: { className: '"rc-insert-form"', onKeyDown: '{onKey}' }, line: '<form', why: 'Escape from its fields closes the insert form; the form itself is no control' },
  { file: 'ui-kit/panes.tsx', tag: 'div', attrs: { role: '"toolbar"', onKeyDown: '{rove}' }, line: '<div role="toolbar"', why: 'L5.9: the roving arrow keys of a toolbar; its current control holds the tab stop' },
  { file: 'ui-kit/CommandPalette.tsx', tag: 'div', attrs: { role: '"option"', id: '{optId(c)}' }, line: 'role="option"', why: "L5.9: an option of the palette's listbox, which its combobox drives (aria-activedescendant: the focus stays in the input); Enter runs it" },
  { file: 'ui-kit/cards.tsx', tag: 'li', attrs: { role: '"option"', 'data-index': '{n}' }, line: '<li', why: 'L5.10a: an option of the productions listbox (PosterGrid), which holds the tab stop (aria-activedescendant); Enter opens the selected one as a double-click does' },
  { file: 'ui-kit/frames.tsx', tag: 'div', attrs: { role: '"option"', id: '{option.id}' }, line: 'role="option"', why: "L5.11b fixes (review A-M2): a RowCard option of a RowList listbox (the Record screen's draft), which holds the tab stop (aria-activedescendant); Enter / Space select the active one as a click does" },
  { file: 'LibraryScreen.tsx', tag: 'div', attrs: { className: '"lb-cards"', onKeyDown: '{gridKeys}' }, line: '<div className="lb-cards"', why: "L5.12c fixes (review A-M3): the roving keys of the Library's card grid (arrows, Home / End, Escape, Enter to the inspector); the cards' own buttons hold its one tab stop" },
  { file: 'ui-kit/Sheet.tsx', tag: 'dialog', attrs: { onKeyDown: '{onKeyDown}' }, line: '<dialog', why: "L5.12c fixes (review A-L2 / B-L2): Return in a sheet's one-line text field chooses its default action; the dialog is no control (its fields and actions are)" },
];
const SPREAD_EXCEPTIONS: Array<{ file: string; tag: string; why: string }> = [{ file: 'bits.tsx', tag: 'bdi', why: 'Txt passes its typed aria-current only' }];

interface JsxFinding {
  file: string;
  line: number;
  what: string;
}

/** A tab stop the keyboard reaches: a literal 0, or a roving expression one of whose branches is 0. */
function tabStop(init: ts.JsxAttributeValue | undefined): boolean {
  if (!init) return false;
  if (ts.isStringLiteral(init)) return init.text === '0';
  if (!ts.isJsxExpression(init) || !init.expression) return false;
  const zero = (e: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isNumericLiteral(e)) return e.text === '0';
    if (ts.isConditionalExpression(e)) return zero(e.whenTrue) || zero(e.whenFalse);
    return false;
  };
  return zero(init.expression);
}

/** The real-controls pass over one TSX source (TypeScript's parser: attributes as written, not regexes). */
function jsxControls(file: string, text: string): JsxFinding[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: JsxFinding[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(src);
      if (/^[a-z]/.test(tag)) {
        const list = n.attributes.properties.filter(ts.isJsxAttribute);
        const attrs = new Map(list.map((a) => [a.name.getText(src), a.initializer ? a.initializer.getText(src) : 'true']));
        const start = n.getStart(src);
        const line = src.getLineAndCharacterOfPosition(start).line + 1;
        const lineText = text.split('\n')[line - 1] ?? '';
        const href = attrs.get('href');
        const realHref = href !== undefined && !/^\{\s*(?:undefined|null)\s*\}$|^""$/.test(href);
        const native = NATIVE.has(tag) || (tag === 'a' && realHref);
        const handlers = [...attrs.keys()].filter(isHandler);
        if (handlers.length > 0 && !native) {
          const role = /^"([a-z]+)"$/.exec(attrs.get('role') ?? '')?.[1];
          const stop = tabStop(list.find((a) => a.name.getText(src) === 'tabIndex')?.initializer);
          const keys = handlers.some((h) => /^onKey(?:Down|Up)/.test(h));
          const clickOnly = handlers.some((h) => /^on(?:Click|DoubleClick)/.test(h)) && !keys && role !== undefined && CLICK_ROLE.has(role);
          const real = role !== undefined && CONTROL_ROLE.has(role) && stop && !clickOnly;
          const excused = REAL_CONTROL_EXCEPTIONS.some((x) => x.file === file && x.tag === tag && Object.entries(x.attrs).every(([k, v]) => attrs.get(k) === v) && lineText.includes(x.line));
          if (!real && !excused) out.push({ file, line, what: `<${tag}> with ${handlers.join(', ')} is not a control (${role === undefined || !CONTROL_ROLE.has(role) ? 'no control role' : !stop ? 'no tab stop (tabIndex 0 or a roving 0)' : 'a click with no key handler'})` });
        }
        if (n.attributes.properties.some(ts.isJsxSpreadAttribute) && !native && !SPREAD_EXCEPTIONS.some((x) => x.file === file && x.tag === tag)) out.push({ file, line, what: `a spread onto <${tag}> (props the lint cannot see)` });
        if (tag === 'a' && !realHref) out.push({ file, line, what: '<a> without href' });
        const ti = /^\{(-?\d+)\}$|^"(-?\d+)"$/.exec(attrs.get('tabIndex') ?? '');
        if (ti && Number(ti[1] ?? ti[2]) > 0) out.push({ file, line, what: `tabIndex ${ti[1] ?? ti[2]} (a positive tab order)` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** Colour literals in TypeScript source: a hex of 3, 4, 6 or 8 digits, a colour function, a named colour (a string's whole value, or a border's colour) — an href's "#…" excepted. */
function tsColourLiterals(src: string): string[] {
  // The CSS named colours (the system colours — field, mark, canvas … — are everyday words in TypeScript, never a colour there).
  const named = new RegExp(`^(?:${NAMED_COLOURS.slice(0, NAMED_COLOURS.indexOf('canvas')).join('|')})$`, 'i');
  const out: string[] = [];
  for (const m of src.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    const v = m[2].trim();
    if (/href\s*[=:]\s*\{?\s*$/.test(src.slice(Math.max(0, m.index! - 12), m.index))) continue;
    const words = v.split(/[\s,()]+/).filter(Boolean);
    if (words.some((w) => /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(w))) out.push(v);
    else if (/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i.test(v)) out.push(v);
    else if (named.test(v) || (/^[\d.]+px\s+(?:solid|dashed|dotted|double)\s+\S+$/i.test(v) && named.test(words.at(-1)!))) out.push(v);
  }
  return out;
}

/** The focus lint: an outline removed / hidden / transparent with no accent ring in its place; a focus ring not in --accent or --accent-strong. */
function focusLint(rules: CssRule[]): string[] {
  const RING = new Set(['accent', 'accent-strong', 'ui-ring']);
  const out: string[] = [];
  for (const r of rules) {
    const focus = /:focus/.test(r.selector);
    const removed = r.decls.some(([k, v]) => (k === 'outline' || k === 'outline-style' || k === 'outline-width') && /^(?:(?:none|0|0px|hidden)\s*)+(?:!important)?$/.test(v));
    const transparent = r.decls.some(([k, v]) => (k === 'outline' || k === 'outline-color') && /\btransparent\b/.test(v));
    if (transparent) out.push(`${r.selector}: a transparent outline (a ring nobody sees)`);
    const shadow = r.decls.find(([k, v]) => k === 'box-shadow' && v !== 'none');
    if (removed && !shadow) out.push(`${r.selector}: outline none, no ring in its place`);
    if (!focus && !removed) continue;
    for (const [k, v] of r.decls) {
      if (!(k === 'outline' || k === 'outline-color' || k === 'box-shadow') || /^(?:(?:none|0|0px|hidden)\s*)+(?:!important)?$/.test(v) || /\btransparent\b/.test(v)) continue;
      if (/^(?:-?[\d.]+(?:px)?|auto)$/.test(v)) continue;
      const vars = [...v.matchAll(/var\(--([\w-]+)\)/g)].map((m) => m[1]);
      if (vars.length === 0 && !/^\s*(?:-?[\d.]+px\s*)+$/.test(v)) out.push(`${r.selector}: ${k} ${v} — its colour is not a token`);
      for (const t of vars) if (!RING.has(t)) out.push(`${r.selector}: ${k} in --${t} (a focus ring is --accent, --accent-strong or --ui-ring)`);
    }
  }
  return out;
}

/** A var() reference: any custom-property character (an underscore or a capital is part of the name). */
const VAR_REF = /var\((--[\w-]+)/g;


describe('the closed palette, the fonts, contrast by token (L4.9 part B; L5.9: one token file, dark and light)', () => {
  it('⚑ no colour literal outside tokens.css (hex, colour functions, named colours); no var() fallback; no font file or URL but its two @font-face', async () => {
    // (L5.12d: the legacy layer is gone; every stylesheet of the app is read.)
    await legacyGone();
    expect((await kitCss()).flatMap(([, t]) => cssRules(t)).length).toBeGreaterThan(200);
    const bad: string[] = [];
    for (const [f, text] of await kitCss()) {
      for (const r of cssRules(text)) {
        for (const [k, v] of r.decls) {
          if (colourIn(v)) bad.push(`${f}: ${r.selector} { ${k}: ${v} }`);
          if (/var\(--[\w-]+\s*,/.test(v)) bad.push(`${f}: ${r.selector} { ${k}: ${v} } (a fallback)`);
          if (/url\(/.test(v)) bad.push(`${f}: ${r.selector} { ${k}: ${v} } (a URL)`);
        }
      }
      expect(text, f).not.toMatch(/@font-face|@import/);
    }
    expect(bad).toEqual([]);
    // Every token value is a literal colour, a length or a font list (no token built from another).
    for (const a of APPEARANCES) for (const [k, v] of tokensOf(a)) expect(v.includes('var('), `${a} ${k}`).toBe(false);
    // The lint catches each kind of literal (planted).
    for (const v of ['#123456', '#fff', 'rgb(1, 2, 3)', 'rgba(0,0,0,.5)', 'hsl(0 0% 0%)', 'oklch(0.5 0.1 200)', 'white', '1px solid red', 'linear-gradient(90deg, var(--a), black)', 'color-mix(in srgb, var(--a), var(--b))']) expect(colourIn(v), v).toBe(true);
    for (const v of ['var(--accent)', 'transparent', 'currentColor', 'inherit', '1px solid var(--line)', 'nowrap', 'pre-line', 'redirect']) expect(colourIn(v), v).toBe(false);
  });

  it('⚑ tokens.css is tokens.ts written out (generated: pnpm -F @retake/ui gen:tokens); its only URLs are the two bundled fonts', async () => {
    const file = await readFile(join(APP, 'tokens.css'), 'utf8');
    expect(file, 'tokens.css is stale: run pnpm -F @retake/ui gen:tokens').toBe(tokensCss());
    expect([...file.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["'/fonts/Geist-Variable.woff2'", "'/fonts/GeistMono-Variable.woff2'"]);
    expect(file.match(/@font-face/g)).toHaveLength(2);
    // Dark by default (no preference), light only when the system asks for it; the scopes after the media block.
    expect(file.indexOf("color-scheme: dark")).toBeLessThan(file.indexOf('@media (prefers-color-scheme: light)'));
    // (Twice: the tokens, then the dialogs' veils on ::backdrop.)
    expect(file.match(/@media[^{]*/g)).toEqual(['@media (prefers-color-scheme: light) ', '@media (prefers-color-scheme: light) ']);
    expect(file.lastIndexOf("[data-appearance='dark'] {")).toBeGreaterThan(file.indexOf('@media'));
    expect(file.lastIndexOf("[data-appearance='light'] {")).toBeGreaterThan(file.indexOf('@media'));
    // Both appearances define the same colour tokens, each a colour the contrast lint can read.
    expect([...colourTokens('dark').keys()]).toEqual([...colourTokens('light').keys()]);
    for (const a of APPEARANCES) for (const [k, v] of colourTokens(a)) expect(rgbaOf(v), `${a} ${k}: ${v}`).toBeDefined();
    // The fonts beside their licence (SIL OFL 1.1: the files unmodified, the licence with them).
    const fonts = await readdir(join(APP, '..', '..', 'fonts'));
    expect(fonts.sort()).toEqual(['Geist-Variable.woff2', 'GeistMono-Variable.woff2', 'LICENSE.txt']);
    expect(await readFile(join(APP, '..', '..', 'fonts', 'LICENSE.txt'), 'utf8')).toContain('SIL Open Font License, Version 1.1');
    // The lint sees a hand edit (planted).
    expect(file.replace('--ui-canvas: #111214', '--ui-canvas: #111215')).not.toBe(tokensCss());
    // (L5.12d: --main-h, the legacy screens' centre-pane height, went with them: the shell's grid reads the bars' tokens.)
    // Every token is the kit's.
    expect([...tokenMap('dark').keys()].filter((k) => !k.startsWith('--ui-'))).toEqual([]);
    // Review A-L9: the veils are declared on ::backdrop itself in each appearance (Safari 17 and Firefox 120 do not
    // inherit custom properties into it).
    for (const sel of ['::backdrop', "[data-appearance='light'] ::backdrop", "[data-appearance='dark'] ::backdrop"]) {
      // (L5.12c: the legacy --backdrop left with the Library's dialog: the kit's veil only.)
      expect(file, sel).toMatch(new RegExp(`^${sel.replace(/[[\]()'.*]/g, '\\$&')} \\{\\n  --ui-backdrop: rgba\\([^)]*\\);\\n\\}`, 'm'));
    }
    expect(file).toMatch(/@media \(prefers-color-scheme: light\) \{\n {2}::backdrop \{\n {4}--ui-backdrop: rgba\(22, 24, 29, 0\.35\);/);
    // No other token shares a status family's colour in an appearance: the checker's colour-only rule reads a colour
    // back to its family (a selection tint equal to --info-soft read as "info": L5.9's first dark tour).
    const status = (n: string) => STATUS_TOKENS.some((p) => n === p || n.startsWith(`${p}-`));
    for (const a of APPEARANCES) {
      const m = colourTokens(a);
      const taken = new Map([...m].filter(([n]) => status(n)).map(([n, v]) => [v.toLowerCase(), n]));
      expect([...m].filter(([n, v]) => !status(n) && taken.has(v.toLowerCase())).map(([n, v]) => `${a}: ${n} ${v} = ${taken.get(v.toLowerCase())}`)).toEqual([]);
    }
  });

  it('⚑ every var(--x) of the stylesheets and the app sources is a token, every token is used; the stylesheets read --ui-* tokens only (L5.12d: there is no other)', async () => {
    const tokens = tokensOf('dark');
    const used = new Set<string>();
    const kit = await kitCss();
    // (Any custom-property character: `var(--accent_strong)` is not read as --accent.)
    expect([...'1px solid var(--accent_strong)'.matchAll(VAR_REF)].map((m) => m[1])).toEqual(['--accent_strong']);
    for (const [f, css] of kit) {
      const own = cssRules(css).flatMap((r) => r.decls.flatMap(([, v]) => [...v.matchAll(VAR_REF)].map((m) => m[1])));
      expect(own.filter((u) => !u.startsWith('--ui-')), `${f} reads a legacy token`).toEqual([]);
      for (const u of own) used.add(u);
    }
    for (const [f, src] of await appSources()) {
      if (f.endsWith('.css') || f === 'tokens.ts') continue;
      for (const m of code(src).matchAll(/var\((--[\w-]+)|getPropertyValue\('(--[\w-]+)'\)/g)) used.add(m[1] ?? m[2]);
    }
    expect([...used].filter((u) => !tokens.has(u)), 'used but not defined').toEqual([]);
    expect([...tokens.keys()].filter((t) => !used.has(t)), 'defined but never used').toEqual([]);
    // (L5.12c: --ink, --veil and --backdrop left with the theme editor's frame and the Library's dialog: the kit's
    // --ui-video / --ui-overlay / --ui-backdrop draw them — the app holds no colour of its own.)
    expect([...used].some((u) => u === '--ink' || u === '--veil' || u === '--backdrop')).toBe(false);
  });

  it('⚑ colour literals in the app sources (hex of 3–8 digits, colour functions, named colours): only the theme editor\'s defaults (theme data, not the Studio\'s chrome) and tokens.ts', async () => {
    const THEME_DATA = new Set(['ThemeEditor.tsx', 'ThemesScreen.tsx', 'theme-words.ts', 'tokens.ts']);
    // L5.12c (critique M1): the set stays these four — a new file (ThemeFields.tsx, the kit's ColorField) takes its
    // colours as data, never a literal of its own.
    expect(THEME_DATA.size).toBe(4);
    for (const [f, src] of await appSources()) {
      if (f.endsWith('.css') || THEME_DATA.has(f)) continue;
      expect(tsColourLiterals(code(src)), `${f}: a colour literal`).toEqual([]);
    }
    // The lint catches each kind (planted), and leaves words and tokens alone.
    for (const line of ["g.fillStyle = '#16181d';", "const c = '#16181dcc';", "const c = '#abcd';", "style={{ color: 'red' }}", "style={{ background: 'White' }}", 'const c = `hsl(210 40% 20%)`;', "const c = 'rgba(0, 0, 0, .5)';", "const c = 'oklch(0.5 0.1 200)';", "border: '1px solid black'"]) expect(tsColourLiterals(line), line).not.toEqual([]);
    for (const line of ["const t = 'red flag';", "getPropertyValue('--ink')", "className=\"tan-line\"", "const words = 'a white page';", "href=\"#abc\"", "'#main'"]) expect(tsColourLiterals(line), line).toEqual([]);
  });

  it('⚑ the Geist pair first in the font stacks (bundled, BL-120); the body, code and the kit use them', async () => {
    const rules = cssRules(await baseCss());
    const tokens = tokensOf('dark');
    for (const [sans, mono] of [['--ui-font', '--ui-mono']]) {
      expect(tokens.get(sans)!.split(',')[0].trim()).toBe("'Geist'");
      expect(tokens.get(mono)!.split(',')[0].trim()).toBe("'Geist Mono'");
      expect(tokens.get(sans)).toMatch(/sans-serif$/);
      expect(tokens.get(mono)).toMatch(/monospace$/);
    }
    const fonts = rules.flatMap((r) => r.decls.filter(([k]) => k === 'font' || k === 'font-family').map(([k, v]) => `${r.selector} { ${k}: ${v} }`));
    // (L5.12d: the page's base, on the kit's tokens: the legacy body's 14px/1.5 is the kit's 13 / 18.)
    expect(fonts.find((d) => d.startsWith('body '))).toBe('body { font-family: var(--ui-font) }');
    expect(fonts.find((d) => d.startsWith('code,'))).toBe('code,\nkbd { font-family: var(--ui-mono) }');
    for (const [f, css] of await kitCss()) {
      for (const r of cssRules(css)) for (const [k, v] of r.decls) if (k === 'font' || k === 'font-family') expect(/var\(--ui-(?:font|mono)\)|^inherit$/.test(v), `${f}: ${r.selector} { ${k}: ${v} }`).toBe(true);
    }
  });

  it('⚑ every text token on every background it may sit on reaches 4.5:1 (alpha composited), marks 3:1 — in dark and in light', async () => {
    const fails: string[] = [];
    for (const a of APPEARANCES) {
      const tokens = tokensOf(a);
      // The kit's set (L5.12d: the only one).
      for (const [t, on] of UI_TEXT_PAIRS) for (const b of on) if (!(worstRatio(tokens, `ui-${t}`, `ui-${b}`) >= 4.5)) fails.push(`${a}: --ui-${t} on --ui-${b}: ${worstRatio(tokens, `ui-${t}`, `ui-${b}`).toFixed(2)}:1`);
      for (const [m, on] of UI_MARK_PAIRS) for (const b of on) if (!(worstRatio(tokens, `ui-${m}`, `ui-${b}`) >= 3)) fails.push(`${a}: --ui-${m} (a mark) on --ui-${b}: ${worstRatio(tokens, `ui-${m}`, `ui-${b}`).toFixed(2)}:1`);
      // Every pair a rule declares together, excuses or not.
      for (const [f, css] of (await kitCss()).map(([kf, kt]) => [kf, cssRules(kt)] as [string, CssRule[]])) {
        for (const r of css) {
          const fg = r.decls.filter(([k]) => k === 'color').flatMap(([, v]) => [...v.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
          const bg = r.decls.filter(([k]) => k === 'background' || k === 'background-color').flatMap(([, v]) => [...v.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
          for (const t of fg) for (const b of bg) if (!(worstRatio(tokens, t, b) >= 4.5)) fails.push(`${a}: ${f} ${r.selector}: --${t} on --${b}: ${worstRatio(tokens, t, b).toFixed(2)}:1`);
        }
      }
    }
    expect(fails).toEqual([]);
    // Every token used as a text colour is a text token; every background token is classified; every `fill` / `stroke`
    // token is in a mark pair (L5.13b: the app mark's paint — a mark or the ground it is checked on).
    const texts = new Set(UI_TEXT_PAIRS.map(([t]) => `ui-${t}`));
    const backs = new Set([...UI_TEXT_PAIRS.flatMap(([, on]) => on.map((b) => `ui-${b}`)), ...UI_NON_TEXT_BG]);
    const paints = new Set(UI_MARK_PAIRS.flatMap(([mk, on]) => [mk, ...on].map((x) => `ui-${x}`)));
    for (const [f, css] of (await kitCss()).map(([kf, kt]) => [kf, cssRules(kt)] as [string, CssRule[]])) {
      for (const r of css) {
        for (const [k, v] of r.decls) {
          for (const m of v.matchAll(/var\(--([a-z0-9-]+)\)/g)) {
            // (An icon's colour is a mark's: the record symbol, the attention triangle, the failure cross — 3:1 pairs.)
            const glyph = /^\.k-(?:record-mark|mark-attention|mark-fail)$/.test(r.selector) && UI_MARK_PAIRS.some(([mk]) => `ui-${mk}` === m[1]);
            if (k === 'color') expect(texts.has(m[1]) || glyph, `${f}: ${r.selector}: color --${m[1]} is not a text token`).toBe(true);
            if (k === 'background' || k === 'background-color') expect(backs.has(m[1]), `${f}: ${r.selector}: background --${m[1]} is not classified`).toBe(true);
            if (k === 'fill' || k === 'stroke') expect(paints.has(m[1]), `${f}: ${r.selector}: ${k} --${m[1]} is in no mark pair`).toBe(true);
          }
        }
      }
    }
    // The lint fails a pale text token (planted) in either appearance, and an unreadable token is a failure, not a skip.
    expect(worstRatio(new Map(tokensOf('light')).set('--ui-text-3', '#8b919b'), 'ui-text-3', 'ui-pane')).toBeLessThan(4.5);
    expect(worstRatio(new Map(tokensOf('dark')).set('--ui-text-3', '#6f747e'), 'ui-text-3', 'ui-raised')).toBeLessThan(4.5);
    expect(worstRatio(new Map(tokensOf('light')).set('--ui-track', '#cfd1d6'), 'ui-knob', 'ui-track')).toBeLessThan(3);
    // (L5.13b: a lighter dark plate sinks the blue take — the pair catches it.)
    expect(worstRatio(new Map(tokensOf('dark')).set('--ui-mark-plate', '#4a5266'), 'ui-mark-back', 'ui-mark-plate')).toBeLessThan(3);
    expect(Number.isNaN(worstRatio(new Map(tokensOf('dark')).set('--ui-text-3', 'grey'), 'ui-text-3', 'ui-pane'))).toBe(true);
  });

  it('⚑ placeholders take the app\'s own colour at full opacity (WebKit\'s default reads 2.35:1)', async () => {
    const rules = cssRules(await baseCss());
    const ph = rules.filter((r) => /(^|,\s*)::placeholder$/.test(r.selector));
    expect(ph).toHaveLength(1);
    // (L5.12d: the page's base, every placeholder; the kit's own rules alike.)
    for (const [f, css] of await kitCss()) {
      for (const r of cssRules(css).filter((x) => x.selector.includes('placeholder'))) {
        expect(new Map(r.decls).get('color'), `${f}: ${r.selector}`).toBe('var(--ui-text-3)');
        expect(new Map(r.decls).get('opacity'), `${f}: ${r.selector}`).toBe('1');
      }
    }
  });

  it('⚑ no outline removed, transparent or faded without an accent ring in its place; every focus ring in --accent / --accent-strong / --ui-ring (the skip link\'s target excepted)', async () => {
    // (L5.12d: the page's base ring is --ui-ring, read with the others.)
    expect(cssRules(await baseCss()).find((r) => r.selector === ':focus-visible')?.decls).toEqual([['outline', '2px solid var(--ui-ring)'], ['outline-offset', '2px']]);
    // main is focused by the skip link (tabIndex -1) to move the reading point, never to show a control.
    const kit = await kitCss();
    expect(kit.flatMap(([, css]) => focusLint(cssRules(css)))).toEqual(['.sh-main:focus: outline none, no ring in its place']);
    // The lint catches each planted way of hiding a ring.
    for (const [rule, what] of [
      ['button:focus-visible { outline: none !important }', 'no ring in its place'],
      ['button:focus-visible { outline: 0 none }', 'no ring in its place'],
      ['button:focus-visible { outline-style: hidden }', 'no ring in its place'],
      ['button:focus-visible { outline: 2px solid transparent }', 'transparent'],
      ['.x:focus { outline-color: transparent }', 'transparent'],
      ['.x { outline: 1px solid transparent }', 'transparent'],
      ['button:focus-visible { outline: 2px solid var(--accent-soft) }', '--accent-soft'],
      ['button:focus { outline: none; box-shadow: 0 0 0 2px var(--line) }', '--line'],
      ['button:focus { outline: none; box-shadow: none }', 'no ring in its place'],
      ['.chip:focus-within { outline: 2px solid currentColor }', 'not a token'],
      ['.k-button:focus-visible { outline: 2px solid var(--ui-hairline) }', '--ui-hairline'],
    ] as const) {
      expect(focusLint(cssRules(rule)).join(' | '), rule).toContain(what);
    }
    for (const rule of ['button:focus-visible { outline: 2px solid var(--accent) }', '.x:focus { outline: none; box-shadow: 0 0 0 2px var(--accent-strong) }', '.chip:focus-within { outline: 2px solid var(--accent); outline-offset: 1px }', '.k-button:focus-visible { outline: 2px solid var(--ui-ring) }']) expect(focusLint(cssRules(rule)), rule).toEqual([]);
  });

  it('⚑ no opacity below 1 in any stylesheet (L5.12c: the unset colour well is hatched; L5.12d: the legacy layer\'s two faded states — a disabled legacy button, a dragged step — went with it)', async () => {
    await legacyGone();
    for (const [f, css] of await kitCss()) expect(cssRules(css).filter((r) => r.decls.some(([k, v]) => k === 'opacity' && Number(v) > 0 && Number(v) < 1)).map((r) => `${f}: ${r.selector}`)).toEqual([]);
  });

  it('⚑ L5.9: heights follow the shell\'s centre pane (--main-h), never the viewport — no vh in a height, inside min() / max() / clamp() too (review B-M1)', async () => {
    const vh = (rules: CssRule[]) => rules.flatMap((r) => r.decls.filter(([k, v]) => /^(?:min-|max-)?height$/.test(k) && /\d(?:d|s|l)?vh\b/.test(v)).map(([k, v]) => `${r.selector} { ${k}: ${v} }`));
    for (const [f, css] of await kitCss()) expect(vh(cssRules(css)), f).toEqual([]);
    expect(vh(cssRules('.x { max-height: calc(100vh - 32px) } .y { height: 100dvh } .z { height: min(44vh, 460px) } .w { max-height: calc(clamp(1px, 40svh, 9px) + 2px) } .v { height: max(var(--main-h), 10px) }'))).toEqual(['.x { max-height: calc(100vh - 32px) }', '.y { height: 100dvh }', '.z { height: min(44vh, 460px) }', '.w { max-height: calc(clamp(1px, 40svh, 9px) + 2px) }']);
  });
});

describe('real controls (L4.9 part B, a TypeScript-parser lint)', () => {
  it('⚑ handlers only on native controls or a role with a tab stop; no spread onto a non-native element; <a> has href; no positive tabIndex', async () => {
    const files = (await appSources()).filter(([f]) => f.endsWith('.tsx'));
    expect(files.length).toBeGreaterThan(20);
    const found = files.flatMap(([f, text]) => jsxControls(f, text));
    expect(found).toEqual([]);
    // Each exception still excuses exactly one element (a stale one is removed from the list, not kept as a blanket pass).
    for (const x of REAL_CONTROL_EXCEPTIONS) {
      const text = files.find(([f]) => f === x.file)?.[1] ?? '';
      const without = REAL_CONTROL_EXCEPTIONS.filter((y) => y !== x);
      const saved = REAL_CONTROL_EXCEPTIONS.splice(0, REAL_CONTROL_EXCEPTIONS.length, ...without);
      try {
        expect(jsxControls(x.file, text).length, `${x.file} <${x.tag}> ${x.line}`).toBe(1);
      } finally {
        REAL_CONTROL_EXCEPTIONS.splice(0, REAL_CONTROL_EXCEPTIONS.length, ...saved);
      }
    }
    // L5.12a (M1): the radio-group exception moved with its element into the kit — one such group app-wide, so the move
    // could not leave a second, unexcused copy behind (a screen's own role="radiogroup" is a ratchet finding as well).
    expect(files.filter(([, text]) => /<\w+\s[^>]*\brole="radiogroup"/.test(code(text))).map(([f]) => f)).toEqual(['ui-kit/ChoiceChips.tsx']);
    // The lint catches each planted case.
    for (const [line, what] of [
      ['<span onClick={go}>x</span>', 'not a control'],
      ['<div role="button" onClick={go}>x</div>', 'not a control'],
      ['<label onClick={go}>x</label>', 'not a control'],
      ['<video onKeyDown={go} />', 'not a control'],
      ['<div {...props} />', 'a spread'],
      ['<a onClick={go}>x</a>', 'without href'],
      ['<button tabIndex={2}>x</button>', 'positive tab order'],
      ['<li role="option" onClick={go}>x</li>', 'not a control'],
      ['<div role="button" tabIndex={-1} onClick={go} onKeyDown={k}>x</div>', 'no tab stop'],
      ['<div role="button" tabIndex={n} onClick={go} onKeyDown={k}>x</div>', 'no tab stop'],
      ['<div role="button" tabIndex={0} onClick={go}>x</div>', 'no key handler'],
      ['<div onClickCapture={go}>x</div>', 'not a control'],
      ['<div onContextMenu={go}>x</div>', 'not a control'],
      ['<div onWheel={go}>x</div>', 'not a control'],
      ['<span onDragStart={go} draggable>x</span>', 'not a control'],
      ['<p onDrop={go}>x</p>', 'not a control'],
      ['<a href={undefined} onClick={go}>x</a>', 'without href'],
    ] as const) {
      const r = jsxControls('Planted.tsx', `export const X = () => (${line});`);
      expect(r.map((x) => x.what).join(' | '), line).toContain(what);
    }
    // An exception's look-alike in the same file (other attributes) is not excused.
    expect(jsxControls('ui-kit/frames.tsx', 'export const X = () => (<li role="option" data-testid="step" onClick={go}>x</li>);').map((x) => x.what)).toEqual([expect.stringContaining('not a control')]);
    for (const line of ['<button onClick={go}>x</button>', '<a href="#x" onClick={go}>x</a>', '<div role="button" tabIndex={0} onClick={go} onKeyDown={k}>x</div>', '<input {...p} />', '<ul role="listbox" tabIndex={0} onKeyDown={k} />', '<ul role="listbox" tabIndex={on ? 0 : -1} onKeyDown={k} />', '<img onLoad={a} onError={b} alt="" />', '<details onToggle={t} />', '<dialog onClose={c} onCancel={d} />', '<video onTimeUpdate={t} onEnded={e} />']) {
      expect(jsxControls('Planted.tsx', `export const X = () => (${line});`), line).toEqual([]);
    }
  });
});

// ── L5.12d: the end of the legacy layer ────────────────────────────────────────────────────────────────────────────

/**
 * Class words of the app's TSX that no stylesheet defines, each kept on purpose and said why (review A-L5 / B-L2: none
 * harvested from a comparison any more). A new word must be a class of a stylesheet (a forgotten one is a class of the
 * deleted legacy layer, or a typo); a word ending in "-" is a prefix a template completes (`k-mark-${state}`): some
 * class must start with it.
 */
const CLASS_HOOKS = new Map<string, string>([
  // Hooks the e2e tests read.
  ['sh-said', "the status bar's said line (record-keys, scenario and kit e2e read it)"],
  ['sp-live-screen', 'the live shoot screen (the shoot e2e waits on its data-read)'],
  // The kit's markup as kit-static pins it: the middle size is the base rule (only sm / lg have rules of their own).
  ['k-btn-md', "Menu's text trigger: a Button's middle size"],
  ['k-iconbtn-md', "Menu's icon trigger: an IconButton's middle size"],
  ['k-seg-md', "the link Segmented's middle size"],
  // A screen's root named beside sc-screen (which styles it), or a landmark beside the class that styles it.
  ['cast', 'CastScreen root beside sc-screen'],
  ['pr', 'ProductionsScreen root beside sc-screen'],
  ['wl', 'WelcomeScreen root beside sc-screen'],
  ['tm-editor', 'the theme editor beside tm-screen'],
  ['sidebar', "the browser's aside beside sh-browser"],
  // A state whose look comes from elsewhere (an attribute, a child, the native state).
  ['is-busy', "a busy Button: natively disabled, the k-spinner child moves"],
  ['is-gap', 'a DiffTable gap row (data-kind="gap" beside it)'],
  ['is-unusable', 'a chip with a reason: its k-why line says it'],
  ['th-none', 'a Thumb with no picture (data-state="none" beside it)'],
  // A part named for its reader: its parent's rule lays it out (a flex or grid child), it needs none of its own.
  ['k-card-picture-', 'k-card-picture-${kind}: the kind beside k-card-picture'],
  ['k-card-picture-poster', 'the poster kind beside k-card-picture'],
  ['k-chip-label', "a chip's label inside k-chip"],
  ['k-color', "ColorField's field (its parts: k-color-line, k-color-well…)"],
  ['k-contact-label', "a contact sheet item's label"],
  ['k-empty-action', "an EmptyState's action row"],
  ['k-facts-group', 'a named Facts group (kit-static pins its markup)'],
  ['k-palette-group', "a palette group (role=group, its heading styled)"],
  ['k-progress-label', "a Progress' label"],
  ['k-seg-label', "a segment's label"],
  ['k-source-group', 'a source list group (kit-static pins its markup)'],
  ['ed-notes', "Edit's notes pane (data-testid beside it)"],
  ['lb-cards', "the Library grid's key-handling wrapper"],
  ['rc-state-mark', "Record's state mark (data-state beside it)"],
  ['rv-family', "a Review family row inside its RowListItem"],
  ['sc-lately', 'Activity\'s list (its items and words styled)'],
  ['sh-foot-meta', "the browser foot's second line beside sh-foot-line"],
  ['sh-scenario-env', 'the status bar\'s " · on <env>" words'],
  ['sh-slot-inspector', "the inspector slot's portal target"],
  ['sp-col-persona', "Sessions' persona column head"],
  ['sp-group', "a Shoot checklist group (its head styled)"],
  ['tm-note-message', 'a theme note\'s message beside tm-note'],
  ['wl-project-error', "a Welcome project card's error words"],
  ['wl-run', "a Welcome project card's last-run words"],
]);

/** A comparison or a membership test: its operands are values tested, never classes (`x === 'record' ? … : …`). */
const TESTS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.InKeyword]);

/** A declaration a class expression may name and the lint follows: a class string or a helper that builds one. */
function followable(n: ts.Node): boolean {
  if (ts.isParenthesizedExpression(n)) return followable(n.expression);
  if (ts.isArrowFunction(n)) return !ts.isBlock(n.body);
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n) || ts.isConditionalExpression(n) || ts.isBinaryExpression(n) || (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'join');
}

/**
 * Every class word the app's TSX gives an element (review A-L5 / B-L2): JSX `className` attributes and object-literal
 * `className:` fields (a kit row's class); a name in them is followed to a const or an expression-bodied helper of the
 * same file (`className={cls}`, Button's `cls(variant, size)`), once. The literal parts of each are its words (a
 * template's too) — never a comparison's operands, nor a property read (`i.className`: another field's value).
 */
function classWords(file: string, text: string): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const decls = new Map<string, ts.Node[]>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && followable(n.initializer)) decls.set(n.name.text, [...(decls.get(n.name.text) ?? []), n.initializer]);
    ts.forEachChild(n, collect);
  };
  collect(src);
  const followed = new Set<ts.Node>();
  const out: string[] = [];
  const lits = (n: ts.Node, acc: string[]) => {
    if (ts.isBinaryExpression(n) && TESTS.has(n.operatorToken.kind)) return;
    if (ts.isElementAccessExpression(n)) return;
    if (ts.isPropertyAccessExpression(n)) {
      // A chain's object (`[…].filter(Boolean).join`) — not a field read off a name (`i.className`, `p.error`).
      if (!ts.isIdentifier(n.expression)) lits(n.expression, acc);
      return;
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) acc.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      acc.push(n.head.text);
      for (const sp of n.templateSpans) {
        lits(sp.expression, acc);
        acc.push(sp.literal.text);
      }
      return;
    } else if (ts.isIdentifier(n)) {
      for (const d of decls.get(n.text) ?? []) {
        if (followed.has(d)) continue;
        followed.add(d);
        lits(d, acc);
      }
      return;
    } else if (ts.isArrowFunction(n)) {
      // A helper's words are its body's (its parameters' defaults are not classes).
      lits(n.body, acc);
      return;
    }
    ts.forEachChild(n, (c) => lits(c, acc));
  };
  const words = (n: ts.Node) => {
    const acc: string[] = [];
    lits(n, acc);
    out.push(...acc.flatMap((x) => x.split(/\s+/)).filter(Boolean));
  };
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && n.name.getText(src) === 'className' && n.initializer) words(n.initializer);
    else if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) && n.name.text === 'className') words(n.initializer);
    else if (ts.isShorthandPropertyAssignment(n) && n.name.text === 'className') words(n.name);
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** The class words no stylesheet defines (nor starts, for a "-" prefix) and no hook excuses. */
function undefinedClasses(files: Array<[string, string]>, defined: Set<string>): string[] {
  const out = new Set<string>();
  for (const [f, text] of files.filter(([x]) => x.endsWith('.tsx'))) {
    for (const w of classWords(f, text)) {
      const ok = w.endsWith('-') ? [...defined].some((d) => d.startsWith(w)) : defined.has(w);
      if (!ok && !CLASS_HOOKS.has(w)) out.add(`${f}: ${w}`);
    }
  }
  return [...out].sort();
}

/** The reduced-motion media block (the kit's spelling: one per stylesheet that moves). */
const REDUCE = '@media (prefers-reduced-motion: reduce)';
/** A declaration that moves something, and a value that does not. */
const MOVES = /^(?:animation|animation-name|animation-duration|transition|transition-property|transition-duration)$/;
const STILL = /^(?:none|0s?|0ms)$/;
/** scrollIntoView / scrollTo / scrollBy with their arguments (one level of parentheses). */
const SCROLL_CALL = /\.(scrollIntoView|scrollTo|scrollBy)\??\.?\(((?:[^()]|\([^()]*\))*)\)/g;

/**
 * The app's stylesheets' rules in cascade order (review A-L4): main.tsx's CSS imports, in order (base → kit → shell →
 * screens; tokens.css moves nothing), each file's rules in source order.
 */
async function cascadeRules(): Promise<Array<CssRule & { f: string }>> {
  const main = (await appSources()).find(([f]) => f === 'main.tsx')![1];
  const order = [...main.matchAll(/^import '\.\/([\w/.-]+\.css)';$/gm)].map((m) => m[1]!).filter((f) => f !== 'tokens.css');
  const css = await kitCss();
  // Every stylesheet is imported there (none outside the cascade this reads).
  expect(css.map(([f]) => f).sort()).toEqual([...order].sort());
  return order.flatMap((f) => cssRules(css.find(([x]) => x === f)![1]).map((r) => ({ f, ...r })));
}

/**
 * Rules (in cascade order) that animate or transition with no LATER rule of their own selector turning it off under
 * REDUCE — the same specificity, so the later one wins (review A-L4: a rule re-declaring `.k-spinner`'s animation after
 * kit.css's reduce block would move again).
 */
function reducedMotionGaps(rules: Array<CssRule & { f: string }>): string[] {
  const out: string[] = [];
  rules.forEach((r, i) => {
    if (r.media === REDUCE) return;
    for (const kind of ['animation', 'transition'] as const) {
      if (!r.decls.some(([k, v]) => k.startsWith(kind) && MOVES.test(k) && !STILL.test(v))) continue;
      const offAt = rules.flatMap((x, j) => (x.media === REDUCE && x.selector.split(/,\s*/).includes(r.selector) && x.decls.some(([k, v]) => (k === kind || k === `${kind}-${kind === 'animation' ? 'name' : 'duration'}`) && STILL.test(v)) ? [j] : []));
      if (!offAt.some((j) => j > i)) out.push(`${r.f}: ${r.selector} (${kind}${offAt.length ? ', after its reduced-motion rule' : ''})`);
    }
  });
  return out;
}

describe('⚑ L5.12d: the legacy layer is gone', () => {
  it('app.css deleted and imported by nothing, no cascade layer left; base.css holds element defaults only; bits.tsx keeps Txt and the small helpers (Badge, Notice, Loading gone)', async () => {
    await legacyGone();
    const files = await appSources();
    const main = files.find(([f]) => f === 'main.tsx')![1];
    expect([...main.matchAll(/^import '\.\/([\w/.-]+\.css)';$/gm)].map((m) => m[1])).toEqual(['tokens.css', 'base.css', 'ui-kit/kit.css', 'shell/shell.css', 'screens.css']);
    for (const [f, css] of await kitCss()) expect(css, f).not.toMatch(/@layer\b/);
    expect([...cssClasses(await baseCss())]).toEqual([]);
    for (const r of cssRules(await baseCss())) expect(r.selector, r.selector).toMatch(/^(?:[*a-z0-9]+|\[hidden\]|#root|:focus-visible|::placeholder|a:hover|a:focus-visible)(?:,\n(?:[*a-z0-9]+|#root))*$/);
    // Review B-L4: a plain link's focus ring keeps the kit ring's radius (the legacy layer gave it one).
    expect(cssRules(await baseCss()).find((r) => r.selector === 'a:focus-visible')?.decls).toContainEqual(['border-radius', 'var(--ui-radius-control)']);
    const bits = files.find(([f]) => f === 'bits.tsx')![1];
    expect([...bits.matchAll(/^export (?:function|const|type) (\w+)/gm)].map((m) => m[1]).sort()).toEqual(['Txt', 'When', 'plural', 'shown', 'visibleControls']);
    expect(files.filter(([, text]) => /\b(?:Badge|Notice|Loading|EnvFlags|RunState|BadgeTone)\b[^\n]*from '\.{1,2}\/bits\.js'/.test(text) || /import \{[^}]*\b(?:Badge|Notice|Loading)\b[^}]*\} from '[^']*bits\.js'/.test(text)).map(([f]) => f)).toEqual([]);
  });

  it('⚑ reduced motion: every animation and transition of the stylesheets is turned off under prefers-reduced-motion: reduce (its own selector); no smooth scroll — every scrollIntoView / scrollTo / scrollBy says behavior: \'auto\'', async () => {
    const all = await cascadeRules();
    expect(reducedMotionGaps(all)).toEqual([]);
    expect(all.filter((r) => r.media !== REDUCE && r.decls.some(([k, v]) => MOVES.test(k) && !STILL.test(v))).length).toBeGreaterThanOrEqual(3);
    for (const r of all) expect(r.decls.filter(([k, v]) => k === 'scroll-behavior' && v !== 'auto'), `${r.f}: ${r.selector}`).toEqual([]);
    const calls = (await appSources()).filter(([f]) => /\.tsx?$/.test(f)).flatMap(([f, src]) => [...code(src).matchAll(SCROLL_CALL)].map((m) => [f, m[0], m[2]] as const));
    expect(calls.length).toBeGreaterThanOrEqual(10);
    expect(calls.filter(([, , args]) => !/behavior: 'auto'/.test(args)).map(([f, call]) => `${f}: ${call}`)).toEqual([]);
    // Planted: a transition with no reduced-motion rule of its own, a rule of the media block deleted, a smooth scroll.
    const kit = cssRules('.a { transition: opacity 0.2s } .b { animation: x 1s } @media (prefers-reduced-motion: reduce) { .b { animation: none } }').map((r) => ({ f: 'planted.css', ...r }));
    expect(reducedMotionGaps(kit)).toEqual(['planted.css: .a (transition)']);
    const real = (await kitCss()).find(([f]) => f === 'ui-kit/kit.css')![1];
    const without = real.replace(/(@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?)\s*\.k-spinner \{\n\s*animation: none;\n\s*\}/, '$1');
    expect(without).not.toBe(real);
    expect(reducedMotionGaps(cssRules(without).map((r) => ({ f: 'ui-kit/kit.css', ...r })))).toEqual(['ui-kit/kit.css: .k-spinner (animation)']);
    // Planted (review A-L4): a later stylesheet animating `.k-spinner` again, after kit.css's reduce block, moves.
    const later = [...all, ...cssRules('.k-spinner { animation: k-spin 0.8s linear infinite; }').map((r) => ({ f: 'screens.css', ...r }))];
    expect(reducedMotionGaps(later)).toEqual(['screens.css: .k-spinner (animation, after its reduced-motion rule)']);
    expect([..."el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); m.scrollTo({ top: 0 });".matchAll(SCROLL_CALL)].filter((m) => !/behavior: 'auto'/.test(m[2])).length).toBe(2);
  });

  it('every className word is a class of a stylesheet (a prefix of one), or one of the known hooks — a forgotten legacy class is caught', async () => {
    const files = await appSources();
    const defined = new Set<string>();
    for (const [, css] of await kitCss()) for (const c of cssClasses(css)) defined.add(c);
    expect(undefinedClasses(files, defined)).toEqual([]);
    // Each hook is still used (a stale one leaves the list) and is no class of a stylesheet (it would need no excuse).
    const words = new Set(files.filter(([f]) => f.endsWith('.tsx')).flatMap(([f, text]) => classWords(f, text)));
    expect([...CLASS_HOOKS.keys()].filter((h) => !words.has(h) || defined.has(h))).toEqual([]);
    // Planted: a legacy class back in a screen (the deleted layer's notice, card), a typo of a kit class.
    for (const [line, word] of [
      ['<div className="notice notice-warning">x</div>', 'notice'],
      ['<section className="sc-screen card">x</section>', 'card'],
      ['<p className="k-hnit">x</p>', 'k-hnit'],
      ['<span className={`badge badge-${tone}`}>x</span>', 'badge'],
    ] as const) {
      expect(undefinedClasses([['Planted.tsx', `export const X = () => (${line});`]], defined), line).toContain(`Planted.tsx: ${word}`);
    }
    expect(undefinedClasses([['Planted.tsx', 'export const X = () => (<span className={`k-mark k-mark-${s}`} />);']], defined)).toEqual([]);
    // Planted (review A-L5 / B-L2): a legacy word in an object-literal `className:` field (a kit row's class), through a
    // const, through an expression-bodied helper (Button's `cls`); a comparison's string is no class word.
    for (const [text, word] of [
      ["export const row = { key: 'a', label: 'A', current: false, className: 'nav-link' };", 'nav-link'],
      ['const cls = `k-source-item muted`;\nexport const X = () => <a className={cls} />;', 'muted'],
      ["const cls = (v: string) => `k-btn k-btn-${v} card`;\nexport const X = ({ v }: { v: string }) => <button className={cls(v)} />;", 'card'],
    ] as const) {
      expect(undefinedClasses([['Planted.tsx', text]], defined), text).toEqual([`Planted.tsx: ${word}`]);
    }
    expect(classWords('Planted.tsx', "export const X = ({ v }: { v: string }) => <a className={v === 'record' ? 'k-btn' : `k-btn ${'record' !== v ? 'k-btn-ghost' : ''}`} />;")).toEqual(['k-btn', 'k-btn', 'k-btn-ghost']);
  });
});

// ── L5.9 part E: screens stay on the kit (review A-M3: scripts/kit-ratchet.ts, the table in legacy-controls.json) ─────

/** A legacy screen's row as committed at HEAD (none outside a git checkout, or before the table existed). */
function headTable(): Record<string, number> | null {
  try {
    return JSON.parse(execFileSync('git', ['show', 'HEAD:packages/ui/test/legacy-controls.json'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as Record<string, number>;
  } catch {
    return null;
  }
}

describe('⚑ screens stay on the kit (L5.9 part E: a TypeScript-parser lint with a ratchet)', () => {
  it('no native control, widget role, kit class or legacy token outside ui-kit/ but the legacy screens\' counted ones (each count ≤ its row; the rows only go down)', async () => {
    const table = await readTable();
    const found = await ratchetFindings();
    const over = [...found].filter(([f, x]) => x.length > (table[f] ?? 0)).map(([f, x]) => `${f}: ${x.length} findings, the table allows ${table[f] ?? 0} (${x.slice(0, 4).join('; ')})`);
    expect(over).toEqual([]);
    // L5.12d: every legacy screen is rebuilt — the table is empty and every file of the app holds zero findings.
    expect(table).toEqual({});
    expect([...found].filter(([, x]) => x.length > 0).map(([f, x]) => `${f}: ${x.join('; ')}`)).toEqual([]);
    // The shell and the gallery are kit-only: no row, nothing found.
    for (const f of [...found.keys()].filter((x) => x.startsWith('shell/') || x === 'GalleryScreen.tsx')) {
      expect(table[f], f).toBeUndefined();
      expect(found.get(f), f).toEqual([]);
    }
    // A row never goes up: not above the committed table's (pnpm -F @retake/ui ratchet only lowers rows).
    const head = headTable();
    if (head) expect(Object.entries(table).filter(([f, n]) => n > (head[f] ?? 0)).map(([f]) => f)).toEqual([]);
    // Planted, in a file without a row: each kind found.
    const ctx = { tokens: new Set(['--danger-soft', '--accent']) };
    const planted = (line: string) => offKit('New.tsx', `export const X = () => (${line});`, ctx);
    expect(planted('<button type="button">Go</button>')).toEqual(['New.tsx:1 <button>']);
    expect(planted('<div role="switch" />')).toEqual(['New.tsx:1 role switch']);
    expect(planted('<a href="#/" className="k-btn k-btn-primary">Go</a>')).toEqual(['New.tsx:1 class k-btn', 'New.tsx:1 class k-btn-primary']);
    // The review's mutation: an ad-hoc button on a legacy colour, a link dressed as a legacy button.
    expect(planted('<div role="button" tabIndex={0} onClick={go} onKeyDown={go} style={{ background: \'var(--danger-soft)\' }}>Ad hoc</div>')).toEqual(['New.tsx:1 role button', 'New.tsx:1 legacy token --danger-soft']);
    expect(planted("<div role={on ? 'tab' : undefined} />")).toEqual([expect.stringContaining('(not a literal)')]);
    expect(planted('<div role={`tab`} />')).toEqual([expect.stringContaining('(not a literal)')]);
    expect(planted('<div className={on ? \'card\' : `k-panel ${x}`} />')).toEqual(['New.tsx:1 class k-panel']);
    for (const tag of ['progress', 'meter', 'details', 'summary', 'label']) expect(planted(`<${tag} />`), tag).toEqual([`New.tsx:1 <${tag}>`]);
    for (const role of ['checkbox', 'radio', 'tab', 'slider', 'option', 'menuitemradio', 'spinbutton']) expect(planted(`<div role="${role}" />`), role).toEqual([`New.tsx:1 role ${role}`]);
    expect(offKit('New.tsx', "const c = getComputedStyle(el).getPropertyValue('--accent');", ctx)).toEqual(['New.tsx:1 legacy token --accent']);
    // The kit's utilities, a kit component, a --ui-* token, a non-widget role, a CLI flag in a string: nothing.
    expect(planted('<span className="k-sr k-mono">x</span>')).toEqual([]);
    expect(planted('<Button variant="primary">Go</Button>')).toEqual([]);
    expect(planted('<div role="region" style={{ color: \'var(--ui-text-2)\' }} title="retake render --review" />')).toEqual([]);
    // A stylesheet's classes are read from its selectors (the className lint's).
    expect([...cssClasses('.a, .b > .c:hover { x: 1 } @media (max-width: 9px) { .d.e { y: 2 } } /* .f */')].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('the kit, the shell and the new screens\' stylesheets: sizes, weights and radii from --ui-* tokens only', async () => {
    const SIZED = new Set(['font-size', 'line-height', 'font-weight', 'border-radius', 'letter-spacing']);
    const bad: string[] = [];
    const lint = (f: string, css: string) => {
      for (const r of cssRules(css)) for (const [k, v] of r.decls) if (SIZED.has(k) && !/^(?:(?:var\(--ui-[\w-]+\)|0|50%|inherit)\s*)+$/.test(v)) bad.push(`${f}: ${r.selector} { ${k}: ${v} }`);
    };
    const kit = await kitCss();
    expect(kit.map(([f]) => f).sort()).toEqual(['base.css', 'screens.css', 'shell/shell.css', 'ui-kit/kit.css']);
    for (const [f, css] of kit) lint(f, css);
    expect(bad).toEqual([]);
    lint('planted.css', '.k-x { font-size: 14px; border-radius: 3px; font-weight: 650 } .k-y { border-radius: 0 0 var(--ui-radius-overlay) var(--ui-radius-overlay) }');
    expect(bad).toEqual(['planted.css: .k-x { font-size: 14px }', 'planted.css: .k-x { border-radius: 3px }', 'planted.css: .k-x { font-weight: 650 }']);
  });

  it('the product\'s name lives in brand.ts: never written in the app\'s sources (the screens, the kit, the shell, the gallery) or bundle.ts', async () => {
    const files = await appSources();
    files.push(['../bundle.ts', await readFile(join(APP, '..', 'bundle.ts'), 'utf8')]);
    // The name as a word, in JSX text, a string or a template.
    const NAME = /\bRetake\b/;
    expect(files.filter(([f, text]) => f !== 'brand.ts' && NAME.test(code(text))).map(([f]) => f)).toEqual([]);
    expect(files.find(([f]) => f === 'brand.ts')![1]).toContain("export const APP_NAME = 'Retake';");
    for (const planted of ['<p>\n        Retake</p>', "'Retake'", '`${x} · Retake`']) expect(NAME.test(code(planted)), planted).toBe(true);
    expect(NAME.test(code("import { x } from '@retake/core';"))).toBe(false);
  });
});

// ── L5.9 review A-M1: the kit shows text it did not write through Txt ───────────────────────────────────────────────

/** What a kit slot may hold as a JSX child: an element, a literal, `shown(…)` / `visibleControls(…)` / a kit formatter, a `.map` of elements. */
const KIT_TEXT_CALLS = new Set(['shown', 'visibleControls', 'formatTimecode']);

/** The JSX children of a kit source that show a value bare — not through `shown` (Txt), `<Txt>` or `visibleControls` (a parser pass). */
function kitBareText(file: string, text: string): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const ok = (e: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(e)) return ok(e.expression);
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return true;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isConditionalExpression(e)) return ok(e.whenTrue) && ok(e.whenFalse);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return ok(e.right);
    if (ts.isCallExpression(e)) {
      const c = e.expression;
      if (ts.isIdentifier(c) && KIT_TEXT_CALLS.has(c.text)) return true;
      // A list of elements: the elements' own children are visited.
      if (ts.isPropertyAccessExpression(c) && c.name.text === 'map') return true;
    }
    return false;
  };
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxExpression(n) && n.expression && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent)) && !ok(n.expression)) {
      out.push(`${file}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1} {${n.expression.getText(src)}}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** A right-to-left isolate, built at run time like RLO. */
const RLI = String.fromCharCode(0x2067);
/** A hostile string for a kit slot: markup, a marker, an override and an isolate. */
const K = (n: string) => `${H(n)}${RLI}x`;

describe('⚑ the kit shows text it did not write through Txt (L5.9 review A-M1)', () => {
  it('every slot of every kit component: a planted string lands in a <bdi> with its direction controls made visible (an <option> and key caps: visible marks)', () => {
    const go = () => undefined;
    const els = [
      createElement(CommandPalette, { open: true, onClose: go, commands: [{ id: 'a', label: K('plabel'), hint: K('phint'), group: K('pgroup'), run: go }] }),
      createElement(Menu, { label: 'More', text: K('mtext'), items: [{ id: 'x', label: K('mitem') }], onSelect: go }),
      createElement(Select, { label: K('slabel'), hint: K('shint'), value: 'v', options: [{ value: 'v', label: K('opt') }], onChange: go }),
      createElement(Sheet, { open: false, title: K('stitle'), actions: [{ id: 'c', label: K('saction'), isCancel: true }], onAction: go, children: K('sbody') }),
      createElement(SourceList, { label: 'Browser', groups: [{ key: 'g', heading: K('sheading'), items: [{ key: 'r', to: { name: 'projects' }, label: K('srow'), flag: K('sflag'), current: false, count: 3 }] }] }),
      createElement(StatusMark, { state: 'ok', word: K('status') }),
      createElement(StatusBar, { state: K('bstate'), info: K('binfo'), actions: K('bactions') }),
      createElement(FrameCard, { picture: K('cpic'), number: K('cnum'), title: K('ctitle'), meta: K('cmeta'), onSelect: go }),
      createElement(Switch, { label: K('wlabel'), hint: K('whint'), checked: false, onChange: go }),
      createElement(TextField, { label: K('flabel'), hint: K('fhint'), error: K('ferror'), value: 'x', onChange: go, unsaved: null }),
      createElement(TextArea, { label: K('alabel'), value: 'x', onChange: go, unsaved: null }),
      createElement(FieldRow, { label: K('rlabel'), hint: K('rhint'), children: K('rchild') }),
      createElement(Segmented, { label: K('seglegend'), value: 'a', options: [{ value: 'a', label: K('seg') }], onChange: go }),
      createElement(SegmentedLinks, { label: 'Mode', hint: K('seghint'), items: [{ key: 'a', label: K('link'), to: null, current: false }, { key: 'b', label: K('link2'), to: { name: 'projects' }, current: false }] }),
      createElement(EmptyState, { title: K('etitle'), children: K('etext'), actions: K('eactions') }),
      createElement(InspectorSection, { title: K('ititle'), children: K('ibody') }),
      createElement(InspectorSection, { title: K('ctitle2'), collapsible: true, children: K('cbody2') }),
      createElement(Progress, { label: K('prog'), valueText: K('progv'), value: 1 }),
      createElement(Blocker, { word: K('blword'), fix: { label: K('blfix'), onClick: go }, children: K('bltext') }),
      createElement(Button, { disabled: true, why: K('why'), children: K('btn') }),
      createElement(LinkButton, { to: { name: 'projects' }, children: K('lbtn') }),
      createElement(Toolbar, { label: 'Tools', children: K('tool') }),
      createElement(Kbd, { keys: [K('kbd')] }),
      // L5.10a: the project side's kit additions.
      createElement(Facts, { rows: [{ key: 'a', label: K('factl'), value: K('factv') }] }),
      createElement(Disclosure, { summary: K('dsum'), children: K('dbody') }),
      createElement(PosterGrid, { label: 'Productions', items: [{ id: 'a', picture: K('ppic'), title: K('ptitle'), meta: K('pmeta') }], selected: 'a', onSelect: go, onOpen: go }),
      createElement(SourceList, { label: 'Browser 2', groups: [{ key: 'g', items: [{ key: 'r', to: { name: 'projects' }, label: 'Row', value: K('svalue'), lead: K('slead'), icon: 'film', quiet: true, current: true }] }] }),
      // L5.10b: the scenario side's kit additions.
      createElement(FrameGrid, { label: 'Steps', tabbable: true, children: [createElement(FrameOption, { key: 'a', id: 'o', dataKey: 'a', label: 'Step', selected: true, picture: K('fpic'), number: K('fnum'), title: K('ftitle'), meta: K('fmeta'), draggable: false, drop: null, dragging: false, onPick: go })] }),
      createElement(FrameGrid, { label: 'Empty', tabbable: false, empty: K('fempty'), children: [] }),
      createElement(RowCard, { tile: K('rtile'), title: K('rtitle'), meta: K('rmeta'), selected: false, onSelect: go }),
      createElement(Callout, { title: K('caltitle'), children: K('calbody') }),
      createElement(TerminalCommands, { fix: K('tfix'), fixNode: K('tnode') }),
      createElement(Switch, { label: K('wrlabel'), hint: K('wrhint'), checked: true, onChange: go, layout: 'row' }),
      createElement(SourceList, { label: 'Scenes', groups: [{ key: 'g', items: [{ key: 'b', label: K('sbtn'), current: true, onSelect: go, bar: 0.5, value: '1 s' }] }] }),
      // L5.11a: Shoot's kit additions (the checklist, the status bar's compact blocker, a sheet's action test ids).
      createElement(Checklist, { label: 'Checks', children: createElement(ChecklistItem, { state: 'attention', word: K('ckword'), title: K('cktitle'), actions: K('ckact'), children: K('ckbody') }) }),
      createElement(Blocker, { compact: true, word: K('cbword'), fix: { copy: K('cbcopy') }, children: K('cbtext') }),
      createElement(Blocker, { compact: true, word: K('cbword2'), fix: { label: K('cblink'), to: { name: 'projects' } } }),
      createElement(Sheet, { open: false, alert: true, testId: 't', title: K('astitle'), actions: [{ id: 'c', label: K('asaction'), isCancel: true, testId: 'c' }], onAction: go }),
      // L5.11b: Record's kit additions (a radio group, a compact row card with a word on the right).
      createElement(RadioGroup, { legend: K('rglegend'), value: 'a', onChange: go, options: [{ value: 'a', label: K('rglabel'), detail: K('rgdetail'), aside: K('rgaside') }] }),
      createElement(RowCard, { compact: true, tile: K('crtile'), title: K('crtitle'), meta: K('crmeta'), aside: K('craside'), selected: true, onSelect: go }),
      // L5.12a: Edit's and the Review report's kit additions (chips, tracks, the scrubber, a contact sheet, a tag, a number field).
      createElement(ChoiceChips, { labelledBy: 'l', chips: [{ key: 'a', label: K('chlabel'), value: 'a', checked: true }, { key: 'b', label: K('chlabel2'), value: 'b', checked: false, disabled: true, why: K('chwhy') }], onPick: go }),
      createElement(Track, { name: K('trname'), testId: 't', count: 1, children: createElement(TrackItem, { variant: 'pin', place: { at: 3 }, frames: 10, label: 'Pin', testId: 'p', onActivate: go, tip: K('trtip'), children: K('tritem') }) }),
      createElement(Scrubber, { time: K('sctime'), max: 9, value: 0, valueText: K('scvalue'), onChange: go, marks: [{ at: 0.5, label: K('scmark') }] }),
      createElement(ContactSheet, { items: [{ key: 'a', name: 'Sheet', label: K('cslabel'), meta: K('csmeta'), picture: K('cspic'), state: 'ok' }, { key: 'b', name: 'Sheet 2', label: K('cslabel2'), picture: null, words: K('cswords'), state: 'error' }] }),
      createElement(Tag, { children: K('tag') }),
      createElement(NumberField, { label: K('nflabel'), hint: K('nfhint'), error: K('nferror'), value: '1', onChange: go }),
      // L5.12a fixes (review A-L5): a row card that is a link.
      createElement(RowCard, { compact: true, tile: K('lrtile'), title: K('lrtitle'), meta: K('lrmeta'), selected: true, to: { name: 'projects' } }),
      // L5.12b: the diff table (its code cells: visible marks, byte order — no <bdi> can go inside a bidi-overridden line),
      // the region over a frame, the palette's footnote, a tick that is a link.
      createElement(DiffTable, { label: 'Change', title: K('dttitle'), rows: [{ kind: 'add', sign: '+', word: K('dtword'), base: null, line: 3, pieces: [{ kind: 'text', text: K('dtcode') }], rtl: true }, { kind: 'gap', sign: '…', word: K('dtgap'), base: null, line: null, pieces: [], rtl: false }] }),
      createElement(RegionOverlay, { region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, label: K('rolabel') }),
      createElement(CommandPalette, { open: true, onClose: go, footnote: K('pfoot'), commands: [{ id: 'b', label: 'Row', icon: 'theme', group: 'Themes', run: go }] }),
      createElement(Track, { name: 'Pins', testId: 't2', count: 1, children: createElement(TrackItem, { variant: 'pin', place: { at: 3 }, frames: 10, label: 'Pin', testId: 'p2', to: { name: 'projects' }, tip: K('trltip'), children: K('trlitem') }) }),
      // L5.12c: the Library's data table, the theme editor's colour field, a sheet's fields.
      createElement(DataTable, { caption: K('dtcap'), columns: [{ key: 'a', label: K('dtcol') }, { key: 'b', label: 'B' }], rows: [{ key: 'r', cells: [K('dthead'), K('dtcell')] }] }),
      createElement(ColorField, { label: K('cflabel'), hint: K('cfhint'), value: 'x', picker: 'x', draft: K('cfdraft'), onDraft: go, onCommit: go }),
      createElement(Sheet, { open: false, title: 'Copy', actions: [{ id: 'c', label: 'Cancel', isCancel: true }], onAction: go, content: K('shcontent') }),
    ];
    const html = shownMarkup(els.map((el) => renderToStaticMarkup(el)).join('\n'));
    const raw = [...html.matchAll(/.{0,60}[\u202e\u2067].{0,10}/g)].map((m) => m[0]);
    expect(raw, "a raw direction control").toEqual([]);
    expect(html).not.toMatch(/<img|onerror="/);
    const places = placesOf(html);
    const marks = new Set(['opt', 'kbd', 'dtcode']);
    // Text outside a <bdi> only where no <bdi> can go (an <option>, a key cap); an attribute (aria-valuetext) with its controls visible (no raw one above).
    const wrong = places.filter((p) => !marks.has(p.n) && (p.where === 'bare' || p.where === 'option'));
    expect(wrong, JSON.stringify(wrong)).toEqual([]);
    const all = ['plabel', 'phint', 'pgroup', 'mtext', 'mitem', 'slabel', 'shint', 'stitle', 'saction', 'sbody', 'sheading', 'srow', 'sflag', 'status', 'bstate', 'binfo', 'bactions', 'cpic', 'cnum', 'ctitle', 'cmeta', 'wlabel', 'whint', 'flabel', 'fhint', 'ferror', 'alabel', 'rlabel', 'rhint', 'rchild', 'seglegend', 'seg', 'seghint', 'link', 'link2', 'etitle', 'etext', 'eactions', 'ititle', 'ibody', 'ctitle2', 'cbody2', 'prog', 'progv', 'blword', 'blfix', 'bltext', 'why', 'btn', 'lbtn', 'tool', 'factl', 'factv', 'dsum', 'dbody', 'ppic', 'ptitle', 'pmeta', 'svalue', 'slead', 'fpic', 'fnum', 'ftitle', 'fmeta', 'fempty', 'rtile', 'rtitle', 'rmeta', 'caltitle', 'calbody', 'tfix', 'tnode', 'wrlabel', 'wrhint', 'sbtn', 'ckword', 'cktitle', 'ckact', 'ckbody', 'cbword', 'cbcopy', 'cbtext', 'cbword2', 'cblink', 'astitle', 'asaction', 'rglegend', 'rglabel', 'rgdetail', 'rgaside', 'crtile', 'crtitle', 'crmeta', 'craside', 'chlabel', 'chlabel2', 'chwhy', 'trname', 'trtip', 'tritem', 'sctime', 'scmark', 'cslabel', 'csmeta', 'cspic', 'cslabel2', 'cswords', 'tag', 'nflabel', 'nfhint', 'nferror', 'lrtile', 'lrtitle', 'lrmeta', 'dttitle', 'dtword', 'dtgap', 'rolabel', 'pfoot', 'trltip', 'trlitem', 'dtcap', 'dtcol', 'dthead', 'dtcell', 'cflabel', 'cfhint', 'cfdraft', 'shcontent'];
    const inBdi = new Set(places.filter((p) => p.where === 'bdi').map((p) => p.n));
    expect(all.filter((n) => !inBdi.has(n))).toEqual([]);
    // An <option> and a key cap cannot isolate (no <bdi> inside): their controls are shown as marks.
    for (const n of marks) expect(html, n).toContain(`PAGE-${n}[U+202E]gnp[U+2067]x`);
  });

  it('a source lint: every JSX child of the kit goes through shown / <Txt> / visibleControls (a planted bare value fails it)', async () => {
    const kit = (await appSources()).filter(([f]) => f.startsWith('ui-kit/') && f.endsWith('.tsx'));
    expect(kit.length).toBeGreaterThan(10);
    expect(kit.flatMap(([f, text]) => kitBareText(f, text))).toEqual([]);
    for (const line of ['<span>{c.label}</span>', '<span>{title}</span>', '<p>{on ? label : <b />}</p>', '<p>{on && hint}</p>', '<p>{`${a} b`}</p>', '<p>{a ?? b}</p>', '<p>{format(a)}</p>']) {
      expect(kitBareText('Planted.tsx', `export const X = () => (${line});`), line).toHaveLength(1);
    }
    for (const line of ['<span>{shown(c.label)}</span>', '<span><Txt text={c.label} /></span>', '<option>{visibleControls(o.label)}</option>', '<p>{on ? shown(a) : null}</p>', '<p>{on && <b />}</p>', '<ul>{xs.map((x) => <li key={x}>{shown(x)}</li>)}</ul>', '<p>{"word"}</p>']) {
      expect(kitBareText('Planted.tsx', `export const X = () => (${line});`), line).toEqual([]);
    }
    expect(kitBareText('Planted.tsx', 'export const X = () => (<ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul>);')).toEqual(['Planted.tsx:1 {x}']);
  });
});

// ── L5.10a: the project side (Welcome, the Project screen, the Cast, Lately) ─────────────────────────────────────────

/** The rebuilt project-side files: kit only (no ratchet row), every value from data through Txt / a kit slot. */
const PROJECT_SIDE = ['WelcomeScreen.tsx', 'ProductionsScreen.tsx', 'CastScreen.tsx', 'Activity.tsx'];
/** The ops the project side may call: reads only (the write path is unchanged: critique §7.3). */
const PROJECT_SIDE_OPS = new Set(['project_get', 'project_board', 'auth_status', 'projects_overview', 'engine_info', 'run_list', 'run_status', 'run_thumbs', 'activity_list', 'search']);

/** The op names a source calls through call / useCall or a data function (a call whose op is not a literal is reported as such). */
function opsCalled(text: string): string[] {
  return apiCalls(code(text)).map((c) => c.op);
}

describe('L5.10a: the project side', () => {
  it('the routes: a smart group, a location, the Cast; ids inert strings; hrefTo round-trips', () => {
    expect(parseRoute('#/p/northfield-fixture/g/ready')).toEqual({ name: 'group', slug: 'northfield-fixture', group: 'ready' });
    expect(parseRoute('#/p/n/g/shoot/')).toEqual({ name: 'group', slug: 'n', group: 'shoot' });
    expect(parseRoute('#/p/n/g/failed')).toEqual({ name: 'group', slug: 'n', group: 'failed' });
    expect(parseRoute('#/p/n/g/other')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/n/g/')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/n/loc/local')).toEqual({ name: 'location', slug: 'n', env: 'local' });
    expect(parseRoute('#/p/n/loc/%3Cimg%3E')).toEqual({ name: 'location', slug: 'n', env: '<img>' });
    expect(parseRoute('#/p/n/loc/a/b')).toMatchObject({ name: 'not-found' });
    expect(parseRoute('#/p/n/cast')).toEqual({ name: 'cast', slug: 'n' });
    expect(parseRoute('#/p/n/cast/x')).toMatchObject({ name: 'not-found' });
    for (const slug of ['northfield-fixture', '<img src=x>', 'a/b', '\u202Egnp.exe']) {
      for (const r of [{ name: 'group', slug, group: 'ready' }, { name: 'location', slug, env: slug }, { name: 'cast', slug }] as const) {
        const h = hrefTo(r);
        expect(h.startsWith('#/p/')).toBe(true);
        expect(parseRoute(h)).toEqual(r);
      }
    }
    // A group the address cannot hold falls back to the project.
    expect(hrefTo({ name: 'group', slug: 'n', group: 'x' as 'ready' })).toBe('#/p/n');
  });

  it('⚑ every value from data is text: each JSX child of the project-side screens goes through Txt / shown / a kit slot (a planted bare title fails it)', async () => {
    const files = (await appSources()).filter(([f]) => PROJECT_SIDE.includes(f));
    expect(files.map(([f]) => f).sort()).toEqual([...PROJECT_SIDE].sort());
    expect(files.flatMap(([f, text]) => kitBareText(f, text))).toEqual([]);
    // The review's mutation: the poster title rendered bare.
    const productions = files.find(([f]) => f === 'ProductionsScreen.tsx')![1];
    const planted = productions.replace('title: <Txt text={posterTitle(s)} />,', 'title: <span>{posterTitle(s)}</span>,');
    expect(planted).not.toBe(productions);
    expect(kitBareText('ProductionsScreen.tsx', planted)).toEqual([expect.stringContaining('{posterTitle(s)}')]);
  });

  it('⚑ kit only: the rebuilt files have no ratchet row and nothing off the kit; the replaced files are gone', async () => {
    const table = await readTable();
    const found = await ratchetFindings();
    for (const f of [...PROJECT_SIDE, 'shell/AppShell.tsx']) {
      expect(table[f], f).toBeUndefined();
      expect(found.get(f) ?? [], f).toEqual([]);
    }
    const names = (await appSources()).map(([f]) => f);
    for (const gone of ['ProjectsScreen.tsx', 'ProjectPage.tsx']) {
      expect(names).not.toContain(gone);
      expect(table[gone], gone).toBeUndefined();
    }
  });

  it('⚑ the project side only reads: the ops it calls are read ops (a planted scenario_save fails it); project_board is a Studio read', async () => {
    const files = (await appSources()).filter(([f]) => [...PROJECT_SIDE, 'project-data.ts', 'board-words.ts'].includes(f));
    const called = files.flatMap(([f, text]) => opsCalled(text).map((op) => [f, op] as const));
    expect(called.length).toBeGreaterThan(5);
    expect(called.filter(([f, op]) => !PROJECT_SIDE_OPS.has(op) && !(f === 'project-data.ts' && op === '(not a literal: e.op)'))).toEqual([]);
    expect(opsCalled("call('scenario_save', { project })")).toEqual(['scenario_save']);
    expect(opsCalled('call(e.op, { project: e.slug })')).toEqual(['(not a literal: e.op)']);
    // project-data.ts reads by its own op table (e.op): the table holds the three reads only.
    const store = files.find(([f]) => f === 'project-data.ts')![1];
    expect(/export type ProjectOp = 'project_get' \| 'project_board' \| 'auth_status';/.test(store)).toBe(true);
  });
});

// ── L5.10b: the scenario side (the storyboard, its inspector, the take strip, the scenes browser, the YAML source) ────

/** The rebuilt scenario-side files: kit only (no ratchet row), every value from data through Txt / a kit slot. */
const SCENARIO_SIDE = ['ScenarioScreen.tsx', 'Storyboard.tsx', 'TakeStrip.tsx', 'ScenarioInspector.tsx', 'ScenesBrowser.tsx', 'StepForm.tsx', 'StepEditing.tsx', 'YamlTab.tsx', 'YamlView.tsx', 'TextEditing.tsx', 'Thumb.tsx'];
/** The ops the scenario side may call: its reads, and the mutating ones the plan allows (critique §7.3). */
// L5.11a: Rehearse, Capture and Stop moved to the status bar (shoot-data.ts): the scenario side no longer starts or stops a run.
const SCENARIO_SIDE_OPS = new Set(['scenario_blocks', 'scenario_forms', 'scenario_validate', 'run_status', 'run_thumbs', 'threads_counts', 'scenario_edit']);

/** Each `call('scenario_edit', …)` of a source: whether its arguments name the version shown (`hash`: the if_match). */
function editCalls(text: string): Array<{ at: number; hash: boolean }> {
  return apiCalls(text)
    .filter((c) => c.op === 'scenario_edit')
    .map((c) => ({ at: c.line, hash: !!c.args && ts.isObjectLiteralExpression(c.args) && c.args.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === 'hash' && ts.isPropertyAssignment(p) && !(ts.isIdentifier(p.initializer) && p.initializer.text === 'undefined')) }));
}

describe('L5.10b: the scenario side', () => {
  it('⚑ every value from data is text: each JSX child of the scenario-side files goes through Txt / shown / a kit slot (a planted bare target fails it)', async () => {
    const files = (await appSources()).filter(([f]) => SCENARIO_SIDE.includes(f));
    expect(files.map(([f]) => f).sort()).toEqual([...SCENARIO_SIDE].sort());
    expect(files.flatMap(([f, text]) => kitBareText(f, text))).toEqual([]);
    // The mutation: a frame's target rendered bare.
    const board = files.find(([f]) => f === 'Storyboard.tsx')![1];
    // (L5.10b fixes: the title's target or summary is `rest`, frameTitle's.)
    const planted = board.replace('<Txt text={rest} />', '<span>{rest}</span>');
    expect(planted).not.toBe(board);
    expect(kitBareText('Storyboard.tsx', planted)).toEqual([expect.stringContaining('{rest}')]);
    // A scene title and a caption the same way.
    const title = board.replace('<Txt text={e.caption?.kicker ?? e.id} />', '{e.caption?.kicker ?? e.id}');
    expect(title).not.toBe(board);
    expect(kitBareText('Storyboard.tsx', title)).toEqual([expect.stringContaining('e.caption?.kicker ?? e.id')]);
  });

  it('⚑ kit only: the rebuilt files have no ratchet row and nothing off the kit; Inspector.tsx is gone; the frames\' widget roles live in the kit', async () => {
    const table = await readTable();
    const found = await ratchetFindings();
    for (const f of SCENARIO_SIDE) {
      expect(table[f], f).toBeUndefined();
      expect(found.get(f) ?? [], f).toEqual([]);
    }
    const names = (await appSources()).map(([f]) => f);
    expect(names).not.toContain('Inspector.tsx');
    expect(table['Inspector.tsx']).toBeUndefined();
    // The mutation: an off-kit button in the storyboard counts (and Storyboard.tsx has no row to hold it).
    const board = (await appSources()).find(([f]) => f === 'Storyboard.tsx')![1];
    const planted = board.replace('<p id="steps-keys" className="sc-quiet sb-keys">', '<p id="steps-keys" className="sc-quiet sb-keys"><button className="button">x</button>');
    expect(planted).not.toBe(board);
    const ctx = { tokens: new Set<string>() };
    expect(offKit('Storyboard.tsx', planted, ctx).length).toBeGreaterThan(offKit('Storyboard.tsx', board, ctx).length);
  });

  it('⚑ the write path is unchanged: the scenario side calls only its reads and scenario_edit (L5.11a: runs start and stop in the status bar); every scenario_edit names the version shown (if_match)', async () => {
    const files = (await appSources()).filter(([f]) => SCENARIO_SIDE.includes(f));
    const called = files.flatMap(([f, text]) => opsCalled(text).map((op) => [f, op] as const));
    expect(called.filter(([, op]) => !SCENARIO_SIDE_OPS.has(op))).toEqual([]);
    expect(new Set(called.map(([, op]) => op))).toEqual(new Set(['scenario_blocks', 'scenario_forms', 'scenario_validate', 'run_status', 'run_thumbs', 'threads_counts', 'scenario_edit']));
    // scenario_edit: only from the edit loop (StepEditing.tsx) and the YAML save (YamlTab.tsx), each with its hash.
    const edits = files.flatMap(([f, text]) => editCalls(text).map((c) => ({ f, ...c })));
    expect(edits.map((e) => e.f).sort()).toEqual(['StepEditing.tsx', 'YamlTab.tsx']);
    expect(edits.every((e) => e.hash)).toBe(true);
    // The mutations: a planted scenario_save, an edit without its version.
    expect(opsCalled("call('scenario_save', { project, name, yaml })")).toEqual(['scenario_save']);
    expect(editCalls("call('scenario_edit', { project: slug, name, edit })")).toEqual([{ at: 1, hash: false }]);
    expect(editCalls("call('scenario_edit', { project: slug, name, hash: shown.hash, edit })")).toEqual([{ at: 1, hash: true }]);
  });
});

// ── L5.11a: Shoot (Prepare, live, the status bar's actions, the Cast) ──────────────────────────────────────────────────

/** The rebuilt Shoot files: kit only (no ratchet row), every value from data through Txt / a kit slot. */
const SHOOT_SIDE = ['ShootPrepare.tsx', 'ShootLive.tsx', 'ShootBrowser.tsx', 'LiveView.tsx', 'Sessions.tsx', 'CastScreen.tsx', 'shell/StatusActions.tsx'];
/** The ops Shoot may call: its reads, the run's own controls, a render, a sign-in (no edit, no other write). */
const SHOOT_OPS = new Set(['scenario_actions', 'scenario_sessions', 'scenario_run', 'scenario_render', 'run_cancel', 'run_pause', 'run_status', 'run_thumbs', 'auth_login', 'sign_in_cancel', 'job_list']);

/**
 * "dry run" in a string the page shows (M6 / M9 of the plan: the Studio says Rehearse) — string literals, templates and
 * JSX text of the app; comments, test ids and the one mapping line (shoot-words.ts REHEARSE_MAPPING) excepted.
 */
function dryRunWords(file: string, text: string): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const at = (n: ts.Node) => `${file}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
  const RE = /\bdry[\s-]?runs?\b/i;
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && /^(?:data-testid|testId)$/.test(n.name.getText(src))) return;
    if (ts.isVariableDeclaration(n) && n.name.getText(src) === 'REHEARSE_MAPPING') return;
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) && RE.test(n.text)) out.push(`${at(n)} ${n.text.trim().slice(0, 60)}`);
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

describe('L5.11a: Shoot', () => {
  it('⚑ every value from data is text: each JSX child of the Shoot files goes through Txt / shown / a kit slot (a planted bare blocker message fails it)', async () => {
    const files = (await appSources()).filter(([f]) => SHOOT_SIDE.includes(f));
    expect(files.map(([f]) => f).sort()).toEqual([...SHOOT_SIDE].sort());
    expect(files.flatMap(([f, text]) => kitBareText(f, text))).toEqual([]);
    // The mutation: Prepare's blocker message rendered bare.
    const prep = files.find(([f]) => f === 'ShootPrepare.tsx')![1];
    const planted = prep.replace('<Txt text={b.message} />', '{b.message}');
    expect(planted).not.toBe(prep);
    expect(kitBareText('ShootPrepare.tsx', planted)).toEqual([expect.stringContaining('{b.message}')]);
    // A step description of the live list the same way.
    const live = files.find(([f]) => f === 'ShootLive.tsx')![1];
    const desc = live.replace('{r.desc && <Txt text={r.desc} />}', '{r.desc}');
    expect(desc).not.toBe(live);
    expect(kitBareText('ShootLive.tsx', desc)).toEqual([expect.stringContaining('{r.desc}')]);
  });

  it('⚑ kit only: the rebuilt Shoot files have no ratchet row and nothing off the kit; RunScreen.tsx is gone (−192 legacy controls)', async () => {
    const table = await readTable();
    const found = await ratchetFindings();
    for (const f of [...SHOOT_SIDE, 'shell/command-bus.ts']) {
      expect(table[f], f).toBeUndefined();
      expect(found.get(f) ?? [], f).toEqual([]);
    }
    const names = (await appSources()).map(([f]) => f);
    expect(names).not.toContain('RunScreen.tsx');
    for (const gone of ['RunScreen.tsx', 'LiveView.tsx', 'Sessions.tsx']) expect(table[gone], gone).toBeUndefined();
    // The mutation: a native checkbox in the live step list counts (and ShootLive.tsx has no row to hold it).
    const live = (await appSources()).find(([f]) => f === 'ShootLive.tsx')![1];
    const planted = live.replace('<Switch label="Follow current step"', '<input type="checkbox" /><Switch label="Follow current step"');
    expect(planted).not.toBe(live);
    const ctx = { tokens: new Set<string>() };
    expect(offKit('ShootLive.tsx', planted, ctx).length).toBeGreaterThan(offKit('ShootLive.tsx', live, ctx).length);
  });

  it('⚑ Shoot calls only its reads, the run\'s controls, a render and a sign-in; every scenario_run of the app goes through shoot-data.ts and names the file shown (hash)', async () => {
    const files = (await appSources()).filter(([f]) => [...SHOOT_SIDE, 'shoot-data.ts'].includes(f));
    const called = files.flatMap(([f, text]) => opsCalled(text).map((op) => [f, op] as const));
    expect(called.length).toBeGreaterThan(5);
    expect(called.filter(([, op]) => !SHOOT_OPS.has(op))).toEqual([]);
    const runs = (await appSources()).flatMap(([f, text]) => opsCalled(text).filter((op) => op === 'scenario_run').map(() => f));
    expect(runs).toEqual(['shoot-data.ts']);
    const store = files.find(([f]) => f === 'shoot-data.ts')![1];
    expect(store).toMatch(/scenarioRun\(\{ project: o\.slug, name: o\.name, mode: o\.mode, \.\.\.\(o\.hash \? \{ hash: o\.hash \} : \{\}\)/);
  });

  it('⚑ the Studio says Rehearse: no "dry run" in a string the page shows (comments, test ids and the one mapping line excepted; a planted label fails it)', async () => {
    const files = await appSources();
    expect(files.flatMap(([f, text]) => dryRunWords(f, text))).toEqual([]);
    // The server's Studio-authored lines the page shows (op descriptions excepted: MCP-style metadata, never on screen).
    // L7.18: the Record screen's ops and scenario_edit are the engine's operations (operations/record.ts, scenario-edit.ts).
    const server = await readFile(join(REPO, 'packages/engine/src/operations/record.ts'), 'utf8');
    expect(dryRunWords('record.ts', server)).toEqual([]);
    const described = (text: string) => text.replace(/description: (["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/\.describe\((["'`])(?:\\.|(?!\1).)*\1\)/g, '');
    const ops = described(await readFile(join(REPO, 'packages/ui/src/server/ops.ts'), 'utf8'));
    expect(dryRunWords('ops.ts', ops)).toEqual([]);
    const edit = described(await readFile(join(REPO, 'packages/engine/src/operations/scenario-edit.ts'), 'utf8'));
    expect(dryRunWords('scenario-edit.ts', edit)).toEqual([]);
    // The mutations: a label, a template, JSX text.
    expect(dryRunWords('X.tsx', "const a = <Button>Start dry run</Button>;")).toEqual(['X.tsx:1 Start dry run']);
    expect(dryRunWords('X.tsx', 'const a = `the ${m} dry-run`;')).toHaveLength(1);
    expect(dryRunWords('X.tsx', "const a = 'Dry runs';")).toHaveLength(1);
    expect(dryRunWords('X.tsx', '// a dry run\nconst a = <i data-testid="blockers-dry-run" />;')).toEqual([]);
  });
});

// ── L5.11b: the Record screen in the shell (R4-Record) ─────────────────────────────────────────────────────────────

/** The Record screen's sources (L7.30: the record/ folder, RecordScreen.tsx and its parts), sorted: [file, text]. */
async function recordSources(): Promise<Array<[string, string]>> {
  return (await appSources()).filter(([f]) => f.split('\\').join('/').startsWith('record/') && /\.tsx?$/.test(f)).sort(([a], [b]) => a.localeCompare(b));
}

/** The ops the Record screen calls itself (the browser's and status bar's reads are the shared stores'). */
const RECORD_OPS = new Set(['record_options', 'record_start', 'record_view', 'record_annotate', 'record_stop', 'record_discard', 'record_save']);

describe('L5.11b: Record', () => {
  it('⚑ every value from data is text: each JSX child of the Record screen goes through Txt / shown / a kit slot (a planted bare issue message fails it)', async () => {
    // L7.30: the screen is the record/ folder's files (RecordScreen.tsx and its parts).
    const files = await recordSources();
    expect(files.flatMap(([f, text]) => kitBareText(f, text))).toEqual([]);
    // The mutations: an issue's message, a placeholder's step rendered bare (both in the inspector).
    const text = files.find(([f]) => f === 'record/RecordingInspector.tsx')![1];
    const planted = text.replace('<Txt text={i.message} />\n              </li>', '{i.message}\n              </li>');
    expect(planted).not.toBe(text);
    expect(kitBareText('RecordScreen.tsx', planted)).toEqual([expect.stringContaining('{i.message}')]);
    const step = text.replace('<Txt text={stepWords(p.scene, p.step)} />', '{stepWords(p.scene, p.step)}');
    expect(step).not.toBe(text);
    expect(kitBareText('RecordScreen.tsx', step)).toEqual([expect.stringContaining('{stepWords(p.scene, p.step)}')]);
  });

  it('⚑ kit only: RecordScreen.tsx has no ratchet row and nothing off the kit (−274 legacy controls); its CSS left app.css', async () => {
    const table = await readTable();
    const found = await ratchetFindings();
    const files = (await recordSources()).map(([f]) => f);
    expect(files).toContain('record/RecordScreen.tsx');
    for (const f of [...files, 'ShootBrowser.tsx']) {
      expect(table[f], f).toBeUndefined();
      expect(found.get(f) ?? [], f).toEqual([]);
    }
    await legacyGone();
    // The mutation: a native radio in the alternatives counts (and RecordScreen.tsx has no row to hold it).
    const text = (await appSources()).find(([f]) => f === 'record/DraftList.tsx')![1];
    const planted = text.replace('<RadioGroup\n        legend={`Ways to find step ${n}`}', '<input type="radio" /><RadioGroup\n        legend={`Ways to find step ${n}`}');
    expect(planted).not.toBe(text);
    const ctx = { tokens: new Set<string>() };
    expect(offKit('RecordScreen.tsx', planted, ctx).length).toBeGreaterThan(offKit('RecordScreen.tsx', text, ctx).length);
  });

  it('the Record screen calls only the record ops; the Scenario menu\'s commands are held at the recording\'s priority while it goes', async () => {
    const text = (await recordSources()).map(([, t]) => t).join('\n');
    const called = opsCalled(text);
    expect(called.length).toBeGreaterThanOrEqual(7);
    expect(called.filter((op) => !RECORD_OPS.has(op))).toEqual([]);
    // The four commands, one owner while the recording goes (a reload included: `live` is true before the view is read).
    for (const id of ['stop', 'rehearse', 'capture', 'render']) expect(text).toMatch(new RegExp(`useShellCommand\\('${id}', [^,]+, PRIORITY\\.recording, live\\)`));
    expect(text).toMatch(/const live = v \? LIVE_STATES\.has\(v\.state\) : error === null;/);
  });
});

// ── L5.12a: Edit and the Review report (R4-Edit, R4-Review) ──────────────────────────────────────────────────────────

/** The rebuilt Edit / Review files (L5.12a fixes, review A-M3): every value from data through Txt / a kit slot. */
const EDIT_REVIEW_SIDE = ['TimelineScreen.tsx', 'TimelineInspector.tsx', 'TimelineTracks.tsx', 'EditPreview.tsx', 'EditStatus.tsx', 'EditNotes.tsx', 'ReviewScreen.tsx', 'Renders.tsx'];

describe('L5.12a: Edit and the Review report', () => {
  it('⚑ every value from data is text: each JSX child of Edit\'s and the Review report\'s files goes through Txt / shown / a kit slot (a planted bare scenario name or finding code fails it)', async () => {
    const files = (await appSources()).filter(([f]) => EDIT_REVIEW_SIDE.includes(f));
    expect(files.map(([f]) => f).sort()).toEqual([...EDIT_REVIEW_SIDE].sort());
    expect(files.flatMap(([f, text]) => kitBareText(f, text))).toEqual([]);
    // The review's mutations: the scenario name from the address bar in Edit's h1 as a template, a finding's code bare.
    const edit = files.find(([f]) => f === 'TimelineScreen.tsx')![1];
    const h1 = edit.replace("<Txt text={name} />\n      {' — Edit'}", '{`${name} — Edit`}');
    expect(h1).not.toBe(edit);
    expect(kitBareText('TimelineScreen.tsx', h1)).toEqual([expect.stringContaining('{`${name} — Edit`}')]);
    const report = files.find(([f]) => f === 'ReviewScreen.tsx')![1];
    const code = report.replace('value: <Txt className="k-mono" text={finding.code} /> }', 'value: <span className="k-mono">{finding.code}</span> }');
    expect(code).not.toBe(report);
    expect(kitBareText('ReviewScreen.tsx', code)).toEqual([expect.stringContaining('{finding.code}')]);
  });
});

// ── L5.12b: Review › Comments, Claude's proposal, the README editor, the ⌘K palette (R4-Comments, R4-Palette) ─────────

/** The files L5.12b rebuilt or added (kit only, every value from data through Txt / a kit slot). */
const COMMENTS_SIDE = ['CommentsScreen.tsx', 'ThreadList.tsx', 'FrameViewer.tsx', 'Composer.tsx', 'ThreadPanel.tsx', 'ProposalCard.tsx', 'ProposalBanner.tsx', 'ReadmeEditor.tsx'];

/** The ops each comments-side file may call (L5.12b fixes, reviews A-M1 / B-M1 — like SHOOT_OPS / SCENARIO_SIDE_OPS). */
const COMMENTS_OPS: Record<string, string[]> = {
  'CommentsScreen.tsx': [],
  'ThreadList.tsx': ['threads_list'],
  'FrameViewer.tsx': ['render_outline', 'render_frame'],
  'Composer.tsx': ['frame_anchor', 'thread_add'],
  // Its reads, and the one helper of the thread's writes (`call(op, …)`: Reply, Resolve, Reopen — sendOps).
  'ThreadPanel.tsx': ['thread_get', 'thread_still', '(not a literal: op)'],
  'ProposalCard.tsx': ['thread_apply', 'scenario_render', 'scenario_edit', 'thread_resolve'],
  'ProposalBanner.tsx': ['thread_get'],
  'proposal-focus.ts': [],
};
/** The timeline's proposal banner may import exactly these values (a read, words, the focus hand-off, the kit). */
const BANNER_IMPORTS: Record<string, string[]> = {
  bits: ['Txt'],
  'comment-words': ['proposalButtons', 'proposalSummary'],
  'data/comments': ['useThreadGet'],
  'proposal-focus': ['focusProposalOf'],
  'render-words': ['versionWords'],
  'ui-kit/index': ['Callout', 'LinkButton'],
};

const tsx = (text: string) => ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** A file's value imports (type-only ones dropped), each module as an app-relative path without its extension. */
function importsOf(file: string, text: string): Array<{ module: string; names: string[] }> {
  const out: Array<{ module: string; names: string[] }> = [];
  for (const st of tsx(text).statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const module = spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.js$/, '') : spec;
    const c = st.importClause;
    const names: string[] = [];
    if (c && !c.isTypeOnly) {
      if (c.name) names.push(c.name.text);
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) if (!el.isTypeOnly) names.push(el.name.text);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) names.push(`* as ${c.namedBindings.name.text}`);
    }
    out.push({ module, names });
  }
  return out;
}

/** The names a file exports as values (functions, classes, consts; types and interfaces left out). */
function valueExports(text: string): string[] {
  const out: string[] = [];
  for (const st of tsx(text).statements) {
    const exported = ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) out.push(st.name.text);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push(d.name.text);
  }
  return out;
}

/** The keys of an object literal argument (a property set to `undefined` is no key; a spread is `...`). */
function keysOf(n: ts.Expression | undefined): string[] {
  if (!n || !ts.isObjectLiteralExpression(n)) return ['(not an object literal)'];
  return n.properties.flatMap((p) => {
    if (ts.isSpreadAssignment(p)) return ['...'];
    if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return [];
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer) && p.initializer.text === 'undefined') return [];
    return [p.name.text];
  });
}

/** How many API calls of a source (`call(…)`, not a method, or a data function) take an op that is not a string literal. */
function nonLiteralCalls(text: string): number {
  return apiCalls(text).filter((c) => c.op.startsWith('(not a literal')).length;
}

/** The literal op names of ThreadPanel's helper calls (`send(what, op, args, …)`). */
function sendOps(text: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'send' && n.arguments[1] && ts.isStringLiteral(n.arguments[1])) out.push(n.arguments[1].text);
    ts.forEachChild(n, visit);
  };
  visit(tsx(text));
  return out;
}

/** Every thread write of a source — `call('thread_…', {…})` or the helper's `send(what, 'thread_…', {…})` — and its argument keys. */
function threadWrites(text: string): Array<{ op: string; keys: string[]; line: number }> {
  const src = tsx(text);
  const out: Array<{ op: string; keys: string[]; line: number }> = [];
  const WRITES = new Set(['thread_add', 'thread_reply', 'thread_resolve', 'thread_reopen', 'thread_apply']);
  for (const c of apiCalls(text)) if (WRITES.has(c.op) && c.op !== 'thread_add') out.push({ op: c.op, keys: keysOf(c.args), line: c.line });
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'send') {
      const op = n.arguments[1];
      if (op && ts.isStringLiteral(op) && WRITES.has(op.text) && op.text !== 'thread_add') out.push({ op: op.text, keys: keysOf(n.arguments[2]), line: src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out.sort((a, b) => a.line - b.line);
}

/** What writes, imported: `call`, the proposal's card, a render, a run, the bus's commands (the menu's: they act). */
const WRITER_IMPORTS: Record<string, string[] | '*'> = {
  api: ['call'],
  ProposalCard: '*',
  Renders: ['useRenders'],
  'shoot-data': ['startRun', 'startRender', 'stopRun', 'pauseRun', 'openSheet'],
  'shell/command-bus': ['runShellCommand'],
};

/**
 * The palette's screen groups of a source (`usePaletteGroup(slot, …)`; the `scenario` slot is a live recording's own
 * commands — Stop recording, Discard… — the menu's, which act) and the writers their entries reach: each identifier the
 * group's code uses is followed to its definition in scope (a function, a const — a hook's callback, not its deps; a
 * parameter stops it) and walked in turn; a call of `call`, or of anything imported from WRITER_IMPORTS, is a writer.
 */
function paletteGroupWriters(file: string, text: string): Array<{ slot: string; writers: string[] }> {
  const src = tsx(text);
  const writerNames = new Set<string>();
  for (const i of importsOf(file, text)) {
    const w = WRITER_IMPORTS[i.module];
    if (w) for (const n of i.names) if (w === '*' || w.includes(n)) writerNames.add(n);
  }
  writerNames.add('call');
  // L6.13: a data function the file imports whose op writes (the catalogue's effect: anything but a read).
  for (const [name, d] of dataImports(src)) if (d.ops.some((op) => catalogueOperation(op)?.effect !== 'read')) writerNames.add(name);
  // Declarations by name, each with the scope that holds it (a block, the file, a function for its parameters); a
  // parameter or a destructured name is a declaration with nothing to follow (it shadows).
  const defs = new Map<string, Array<{ scope: ts.Node; body: ts.Node | null }>>();
  const define = (name: string, scope: ts.Node, body: ts.Node | null) => defs.set(name, [...(defs.get(name) ?? []), { scope, body }]);
  const blockOf = (n: ts.Node): ts.Node => {
    for (let p = n.parent; p; p = p.parent) if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p)) return p;
    return src;
  };
  const names = (b: ts.BindingName, scope: ts.Node) => {
    if (ts.isIdentifier(b)) define(b.text, scope, null);
    else for (const el of b.elements) if (!ts.isOmittedExpression(el)) names(el.name, scope);
  };
  const collect = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) define(n.name.text, blockOf(n), n.body);
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name) && n.initializer) {
        const init = n.initializer;
        // A hook's callback (useCallback / useMemo): its function, never its dependency list.
        const hook = ts.isCallExpression(init) && ts.isIdentifier(init.expression) && /^use(?:Callback|Memo)$/.test(init.expression.text) ? init.arguments[0] : undefined;
        define(n.name.text, blockOf(n), hook ?? init);
      } else names(n.name, blockOf(n));
    }
    if (ts.isParameter(n)) names(n.name, n.parent);
    ts.forEachChild(n, collect);
  };
  collect(src);
  /** The innermost declaration of `id` in scope at its place (a parameter or a binding: nothing to follow). */
  const resolve = (id: ts.Identifier): ts.Node | null => {
    const ds = defs.get(id.text) ?? [];
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      const d = ds.find((x) => x.scope === p);
      if (d) return d.body;
    }
    return null;
  };
  const out: Array<{ slot: string; writers: string[] }> = [];
  const visitGroup = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'usePaletteGroup' && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text !== 'scenario') {
      const writers: string[] = [];
      const seen = new Set<ts.Node>();
      const walk = (m: ts.Node) => {
        if (seen.has(m)) return;
        seen.add(m);
        if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && writerNames.has(m.expression.text)) writers.push(m.getText(src));
        if (ts.isIdentifier(m) && !(ts.isPropertyAccessExpression(m.parent) && m.parent.name === m)) {
          const d = resolve(m);
          if (d) walk(d);
        }
        ts.forEachChild(m, walk);
      };
      walk(n.arguments[1]);
      out.push({ slot: n.arguments[0].text, writers: [...new Set(writers)] });
    }
    ts.forEachChild(n, visitGroup);
  };
  visitGroup(src);
  return out;
}

describe('L5.12b: Comments, the proposal, the README, the palette', () => {
  it('⚑ every value from data is text: each JSX child of the Comments, proposal and README files goes through Txt / shown / a kit slot (a planted bare thread text, entry author or diff summary fails it)', async () => {
    const files = (await appSources()).filter(([f]) => COMMENTS_SIDE.includes(f));
    expect(files.map(([f]) => f).sort()).toEqual([...COMMENTS_SIDE].sort());
    expect(files.flatMap(([f, text]) => kitBareText(f, text))).toEqual([]);
    const panel = files.find(([f]) => f === 'ThreadPanel.tsx')![1];
    for (const [from, to, bare] of [
      ['<Txt text={th.untrusted.text} />', '{th.untrusted.text}', '{th.untrusted.text}'],
      ['<Txt text={u.author} />', '{u.author}', '{u.author}'],
    ]) {
      const planted = panel.replace(from, to);
      expect(planted, from).not.toBe(panel);
      expect(kitBareText('ThreadPanel.tsx', planted)).toEqual([expect.stringContaining(bare)]);
    }
    const card = files.find(([f]) => f === 'ProposalCard.tsx')![1];
    const summary = card.replace('<Txt text={`: ${proposalSummary(p)}.`} />', '{proposalSummary(p)}');
    expect(summary).not.toBe(card);
    expect(kitBareText('ProposalCard.tsx', summary)).toEqual([expect.stringContaining('{proposalSummary(p)}')]);
    const list = files.find(([f]) => f === 'ThreadList.tsx')![1];
    const row = list.replace('title={<Txt text={firstLine(t.untrusted.text)} />}', 'title={<span>{firstLine(t.untrusted.text)}</span>}');
    expect(row).not.toBe(list);
    expect(kitBareText('ThreadList.tsx', row)).toEqual([expect.stringContaining('firstLine(t.untrusted.text)')]);
  });

  it('⚑ kit only: the rebuilt files have no ratchet row and nothing off the kit; ProposalPanel.tsx and CommentsTab.tsx are gone (−339 legacy controls); their CSS left app.css', async () => {
    const table = await readTable();
    const found = await ratchetFindings();
    for (const f of COMMENTS_SIDE) {
      expect(table[f], f).toBeUndefined();
      expect(found.get(f) ?? [], f).toEqual([]);
    }
    const names = (await appSources()).map(([f]) => f);
    for (const gone of ['ProposalPanel.tsx', 'CommentsTab.tsx']) {
      expect(names).not.toContain(gone);
      expect(table[gone], gone).toBeUndefined();
    }
    await legacyGone();
    // The mutation: a native button in the composer counts (and Composer.tsx has no row to hold it).
    const text = (await appSources()).find(([f]) => f === 'Composer.tsx')![1];
    const planted = text.replace('<div className="cm-actions" ref={actionsRef}>', '<div className="cm-actions" ref={actionsRef}><button type="button">x</button>');
    expect(planted).not.toBe(text);
    const ctx = { tokens: new Set<string>() };
    expect(offKit('Composer.tsx', planted, ctx).length).toBeGreaterThan(offKit('Composer.tsx', text, ctx).length);
  });

  it('⚑ the palette never writes (L5.12b fixes, reviews A-L3 / B-M2: structural): every screen group\'s handlers reach no writer — the identifiers its entries use are followed to their definitions in the file; the shell\'s builder calls engine_info only', async () => {
    const files = await appSources();
    const shell = code(files.find(([f]) => f === 'shell/AppShell.tsx')![1]);
    const bus = code(files.find(([f]) => f === 'shell/command-bus.ts')![1]);
    const groups = files.flatMap(([f, text]) => paletteGroupWriters(f, text).map((g) => ({ f, ...g })));
    // Scenes (Scenario, Edit), Themes (Edit), Review (Comments), the report (Renders: the screens that hold renders).
    expect(groups.map((g) => `${g.f}:${g.slot}`).sort()).toEqual(['CommentsScreen.tsx:review', 'Renders.tsx:report', 'ScenarioScreen.tsx:scenes', 'TimelineScreen.tsx:scenes', 'TimelineScreen.tsx:themes']);
    for (const g of groups) expect(g.writers, `${g.f} ${g.slot}`).toEqual([]);
    expect(opsCalled(bus)).toEqual([]);
    // The shell's palette builder: commands go through the bus or a route; the one op the shell calls is engine_info.
    expect(new Set(opsCalled(shell))).toEqual(new Set(['engine_info']));
    // The mutations (reviews A-L3 / B-M2): a writer one definition away, a writer imported, the bus's commands.
    const timeline = files.find(([f]) => f === 'TimelineScreen.tsx')![1];
    const away = timeline.replace('run: () => onSelect(s.id, landingOf(s)) })),', 'run: () => pickScene(s.id) })),').replace('  // A segment gone from the new version', "  const pickScene = (id: string) => void call('scenario_edit', { project: slug, name, id });\n  // A segment gone from the new version");
    expect(away).not.toBe(timeline);
    expect(paletteGroupWriters('TimelineScreen.tsx', away).find((g) => g.slot === 'scenes')!.writers).toEqual(["call('scenario_edit', { project: slug, name, id })"]);
    const deep = timeline.replace('      setSelected(id);\n      seek(from);', "      setSelected(id);\n      seek(from);\n      void call('timeline_set', { id });");
    expect(deep).not.toBe(timeline);
    expect(paletteGroupWriters('TimelineScreen.tsx', deep).find((g) => g.slot === 'scenes')!.writers).toEqual(["call('timeline_set', { id })"]);
    const comments = files.find(([f]) => f === 'CommentsScreen.tsx')![1];
    const imported = comments.replace("import { ShellSlot } from './shell/slots.js';", "import { ShellSlot } from './shell/slots.js';\nimport { runShellCommand } from './shell/command-bus.js';").replace("if (composing) setTimeout(", "runShellCommand('render');\n              if (composing) setTimeout(");
    expect(imported).not.toBe(comments);
    expect(paletteGroupWriters('CommentsScreen.tsx', imported)[0].writers).toEqual(["runShellCommand('render')"]);
  });

  it('⚑ the comments side calls only its own ops (L5.12b fixes, reviews A-M1 / B-M1): an allow-list per file, like Shoot\'s and the scenario side\'s; the thread\'s writes through ThreadPanel\'s one helper', async () => {
    const files = await appSources();
    const found: Record<string, string[]> = {};
    for (const f of Object.keys(COMMENTS_OPS)) found[f] = [...new Set(opsCalled(files.find(([x]) => x === f)![1]))].sort();
    const want = Object.fromEntries(Object.entries(COMMENTS_OPS).map(([f, ops]) => [f, [...ops].sort()]));
    expect(found).toEqual(want);
    // The helper's literal ops (its op is an argument): Reply, Resolve, Reopen — nothing else.
    const panel = files.find(([f]) => f === 'ThreadPanel.tsx')![1];
    expect(sendOps(panel).sort()).toEqual(['thread_reopen', 'thread_reply', 'thread_resolve']);
    // A call with an op that is not a literal: the thread's helper, the project reads' loader and (L6.13) the data layer's
    // own — its client and the thread writes' data function (L6.12–L6.13 fixes: projectRead calls its reads' own op
    // functions) — no other.
    expect(files.flatMap(([f, text]) => (nonLiteralCalls(text) > 0 ? [f] : [])).sort()).toEqual(['ThreadPanel.tsx', 'data/client.ts', 'data/comments.ts', 'project-data.ts']);
    expect(nonLiteralCalls(panel)).toBe(1);
    // The mutation (review A-M1): a resolve planted in the list fails its allow-list.
    const list = files.find(([f]) => f === 'ThreadList.tsx')![1];
    const planted = list.replace("  const first = useRef(true);", "  void call('thread_resolve', { project: p.slug, comment_id: 'x', note: 'n' });\n  const first = useRef(true);");
    expect(planted).not.toBe(list);
    expect([...new Set(opsCalled(planted))].sort()).not.toEqual(want['ThreadList.tsx']);
  });

  it('⚑ the proposal\'s writers stay with their owner (L5.12b fixes, reviews A-M1 / B-M1: an import graph) — ProposalCard.tsx exports only its card, imported by ThreadPanel.tsx alone; the timeline\'s banner imports nothing that writes', async () => {
    const files = await appSources();
    const exportsOf = (f: string) => valueExports(files.find(([x]) => x === f)![1]).sort();
    expect(exportsOf('ProposalCard.tsx')).toEqual(['ProposalCard']);
    expect(exportsOf('ThreadPanel.tsx')).toEqual(['ChipList', 'ThreadPanel', 'threadMark']);
    const importers = (mod: string) => files.flatMap(([f, text]) => importsOf(f, text).filter((i) => i.module === mod && i.names.length > 0).map((i) => `${f}: ${i.names.sort().join(', ')}`)).sort();
    expect(importers('ProposalCard')).toEqual(['ThreadPanel.tsx: ProposalCard']);
    expect(importers('ThreadPanel')).toEqual(['CommentsScreen.tsx: ThreadPanel', 'Composer.tsx: ChipList', 'ThreadList.tsx: threadMark']);
    // The banner: exactly these imports (values) — a read (useCall), words, the focus hand-off, the kit. Nothing that writes.
    const banner = files.find(([f]) => f === 'ProposalBanner.tsx')![1];
    expect(Object.fromEntries(importsOf('ProposalBanner.tsx', banner).filter((i) => i.names.length > 0).map((i) => [i.module, i.names.sort()]))).toEqual(BANNER_IMPORTS);
    // The mutation (reviews A-M1 / B-M1): the banner applying through the card's helper (exported again for it) fails both.
    const card = files.find(([f]) => f === 'ProposalCard.tsx')![1];
    const exported = card.replace('async function applyProposal(', 'export async function applyProposal(');
    expect(exported).not.toBe(card);
    expect(valueExports(exported).sort()).toEqual(['ProposalCard', 'applyProposal']);
    const applying = banner.replace("import { focusProposalOf } from './proposal-focus.js';", "import { focusProposalOf } from './proposal-focus.js';\nimport { applyProposal } from './ProposalCard.js';");
    expect(applying).not.toBe(banner);
    expect(importsOf('ProposalBanner.tsx', applying).map((i) => i.module)).toContain('ProposalCard');
  });

  it('⚑ every thread write the engine guards carries the version shown (L5.12b fixes, review A-M1: checked on each call\'s argument object) — thread_resolve / thread_reopen / thread_apply name if_match; thread_reply, whose input has no if_match, sends its text only', async () => {
    const files = await appSources();
    const writes = files.flatMap(([f, text]) => threadWrites(text).map((w) => ({ f, ...w })));
    expect(writes.map((w) => `${w.f}:${w.op}`).sort()).toEqual(['ProposalCard.tsx:thread_apply', 'ProposalCard.tsx:thread_resolve', 'ThreadPanel.tsx:thread_reopen', 'ThreadPanel.tsx:thread_reply', 'ThreadPanel.tsx:thread_resolve']);
    for (const w of writes) {
      if (w.op === 'thread_reply') expect(w.keys, `${w.f}: thread_reply`).toEqual(['text']);
      else expect(w.keys, `${w.f}: ${w.op}`).toContain('if_match');
    }
    // The engine's own input: reply strict and without if_match, the three others requiring it (L7.16: the engine's operations).
    const ops = await readFile(join(REPO, 'packages', 'engine', 'src', 'operations', 'comment-screen.ts'), 'utf8');
    expect(ops).toMatch(/const ReplyInput = z\.strictObject\(\{ project, comment_id: commentId, text: text\('The reply'\) \}\);/);
    for (const input of ['ResolveInput', 'ReopenInput', 'ApplyInput']) expect(ops.slice(ops.indexOf(`const ${input} =`)).split('\n;')[0].split('});')[0]).toContain('if_match: ifMatch');
    // The mutations (review A-M1): a resolve without its version — through the helper, or a direct call.
    expect(threadWrites("send('Resolve', 'thread_resolve', { note, ...(answer ? { render_id: answer } : {}) }, 'Resolved', () => setNote(''));")).toEqual([{ op: 'thread_resolve', keys: ['note', '...'], line: 1 }]);
    expect(threadWrites("call('thread_resolve', { project: p.slug, comment_id: 'x', note: 'n' })")).toEqual([{ op: 'thread_resolve', keys: ['project', 'comment_id', 'note'], line: 1 }]);
    expect(threadWrites("call('thread_apply', { project, comment_id, entry_id, if_match: undefined })")[0].keys).not.toContain('if_match');
  });

});

// ── L5.12c: the Library, the Themes list and the theme editor (R4-Library, R4-Theme) ──────────────────────────────────

/** The files L5.12c rebuilt or added (kit only, every value from data through Txt / a kit slot). */
const LIBRARY_SIDE = ['LibraryScreen.tsx', 'LibraryCards.tsx', 'LibraryInspector.tsx', 'LibraryDetail.tsx', 'LibraryBrowser.tsx', 'CreateSheet.tsx', 'ThemesScreen.tsx', 'ThemeEditor.tsx', 'ThemeFields.tsx'];

/** The ops each Library / themes file may call (critique M1 of L5.12: an allow-list per file, like the comments side's). */
const LIBRARY_OPS: Record<string, string[]> = {
  'LibraryScreen.tsx': ['library_view', 'library_render', 'library_images', 'library_component'],
  'LibraryCards.tsx': [],
  'LibraryInspector.tsx': ['theme_view', 'theme_edit', 'theme_copy'],
  'LibraryDetail.tsx': [],
  'LibraryBrowser.tsx': [],
  'CreateSheet.tsx': [],
  'ThemesScreen.tsx': ['theme_list', 'theme_copy', 'brand_files', 'theme_create', 'site_list'],
  'ThemeEditor.tsx': ['theme_view', 'timeline_leave', 'theme_preview', 'theme_edit', 'theme_copy', 'preview_allow', 'scenario_blocks', 'scenario_edit'],
  'ThemeFields.tsx': [],
};

/** Every `call('<op>', {…})` of a source among `ops` and its argument keys (a parser pass: the object written in the call). */
function opCalls(text: string, ops: ReadonlySet<string>): Array<{ op: string; keys: string[]; line: number }> {
  // A bare `call(…)`, a data function or (L5.12c fixes, review A-M2) a member `x.call(…)`.
  return apiCalls(text, { members: true })
    .filter((c) => ops.has(c.op))
    .map((c) => ({ op: c.op, keys: keysOf(c.args), line: c.line }));
}

/** L6.13: the API's call / useCall and every data function (each is a call: data/). */
const API_NAMES = new Set(['call', 'useCall', ...DATA_FNS.keys()]);
const isApi = (spec: ts.Expression) => ts.isStringLiteral(spec) && (/(^|\/)api\.js$/.test(spec.text) || isDataModule(spec.text));

/**
 * L5.12c fixes (review A-M2): how a file reaches the api — `call` / `useCall` imported by their own names from api.js
 * (no `as`, no namespace or default import, no re-export, no dynamic import) and used only as a call's callee (never
 * bound to another name or passed on): the op lints (opsCalled, opCalls) then see every call a file makes. L6.13: the
 * same for the data modules' functions (data/*.js), the app's calls since only data/ imports call / useCall.
 */
function apiImportFindings(file: string, text: string): string[] {
  const src = tsx(text);
  const out: string[] = [];
  const bound = new Set<string>();
  for (const st of src.statements) {
    if (ts.isImportDeclaration(st) && isApi(st.moduleSpecifier)) {
      const c = st.importClause;
      if (c?.name) out.push(`${file}: a default import of the api (${c.name.text})`);
      const b = c?.namedBindings;
      if (b && ts.isNamespaceImport(b)) out.push(`${file}: import * as ${b.name.text} from the api`);
      if (b && ts.isNamedImports(b)) {
        for (const e of b.elements) {
          const name = (e.propertyName ?? e.name).text;
          if (e.propertyName && API_NAMES.has(name)) out.push(`${file}: import { ${name} as ${e.name.text} } from the api`);
          if (!e.propertyName && API_NAMES.has(name)) bound.add(name);
        }
      }
    }
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && isApi(st.moduleSpecifier)) out.push(`${file}: re-exports the api`);
  }
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && isApi(n.arguments[0])) out.push(`${file}: a dynamic import of the api`);
    if (ts.isIdentifier(n) && bound.has(n.text)) {
      const p = n.parent;
      const callee = ts.isCallExpression(p) && p.expression === n;
      const named = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || ts.isImportSpecifier(p) || ((ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)) && p.name === n);
      if (!callee && !named) out.push(`${file}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}: ${n.text} used as a value`);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** The exports of a source whose value holds a colour literal (theme-words.ts: the theme data the chrome must not take). */
function colourExports(text: string): string[] {
  const src = tsx(text);
  const out: string[] = [];
  for (const st of src.statements) {
    if (!ts.isVariableStatement(st) || !st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && tsColourLiterals(d.initializer.getText(src)).length) out.push(d.name.text);
  }
  return out;
}

/** A file's named imports from theme-words.ts (a namespace import: every name). */
function themeWordsImports(text: string): string[] | '*' {
  const out: string[] = [];
  for (const st of tsx(text).statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !/(^|\/)theme-words\.js$/.test(st.moduleSpecifier.text)) continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamespaceImport(b)) return '*';
    if (b && ts.isNamedImports(b)) for (const e of b.elements) out.push((e.propertyName ?? e.name).text);
  }
  return out;
}

describe('L5.12c: the Library, the Themes list and the theme editor', () => {
  it('⚑ every value from data is text: each JSX child of the Library\'s and the themes\' files goes through Txt / shown / a kit slot (a planted bare component name, page title or README fails it)', async () => {
    const files = (await appSources()).filter(([f]) => LIBRARY_SIDE.includes(f));
    expect(files.map(([f]) => f).sort()).toEqual([...LIBRARY_SIDE].sort());
    expect(files.flatMap(([f, text]) => kitBareText(f, text))).toEqual([]);
    for (const [file, from, to, bare] of [
      ['LibraryCards.tsx', '<Txt text={item.untrusted.name} />', '{item.untrusted.name}', '{item.untrusted.name}'],
      ['ThemesScreen.tsx', '<Txt text={s.untrusted.title} />', '{s.untrusted.title}', '{s.untrusted.title}'],
      ['LibraryDetail.tsx', '<Txt text={d.data.untrusted.readme} />', '{d.data.untrusted.readme}', '{d.data.untrusted.readme}'],
      ['ThemeFields.tsx', '<Txt text={w} />', '{w}', '{w}'],
    ] as const) {
      const text = files.find(([f]) => f === file)![1];
      const planted = text.replace(from, to);
      expect(planted, `${file}: ${from}`).not.toBe(text);
      expect(kitBareText(file, planted)).toEqual([expect.stringContaining(bare)]);
    }
  });

  it('⚑ kit only: the rebuilt files have no ratchet row and nothing off the kit (−603 legacy controls); no native <dialog> outside the kit; their CSS left app.css', async () => {
    const table = await readTable();
    const found = await ratchetFindings();
    for (const f of LIBRARY_SIDE) {
      expect(table[f], f).toBeUndefined();
      expect(found.get(f) ?? [], f).toEqual([]);
    }
    // The Library's Create dialog was the last ad-hoc one: every dialog of the app is the kit's (Sheet, the palette).
    const sources = await appSources();
    expect(sources.filter(([f, text]) => !f.startsWith('ui-kit/') && /<dialog\b/.test(code(text))).map(([f]) => f)).toEqual([]);
    await legacyGone();
    // The mutation: a native input in the theme's fields counts (and ThemeFields.tsx has no row to hold it).
    const text = sources.find(([f]) => f === 'ThemeFields.tsx')![1];
    const planted = text.replace('<div className="tm-chips" data-testid={`chips-${name}`}>', '<div className="tm-chips" data-testid={`chips-${name}`}><input type="radio" />');
    expect(planted).not.toBe(text);
    const ctx = { tokens: new Set<string>() };
    expect(offKit('ThemeFields.tsx', planted, ctx).length).toBeGreaterThan(offKit('ThemeFields.tsx', text, ctx).length);
  });

  it('⚑ the Library and the themes call only their own ops (an allow-list per file); a library render and the theme writes come from these files only', async () => {
    const files = await appSources();
    const found: Record<string, string[]> = {};
    for (const f of Object.keys(LIBRARY_OPS)) found[f] = [...new Set(opsCalled(files.find(([x]) => x === f)![1]))].sort();
    expect(found).toEqual(Object.fromEntries(Object.entries(LIBRARY_OPS).map(([f, ops]) => [f, [...ops].sort()])));
    // App-wide: who renders library previews, who writes a theme (the palette's Themes rows never do: L5.12b's lint).
    const owners = (op: string) => files.filter(([, text]) => opsCalled(text).includes(op)).map(([f]) => f).sort();
    expect(owners('library_render')).toEqual(['LibraryScreen.tsx']);
    expect(owners('theme_edit')).toEqual(['LibraryInspector.tsx', 'ThemeEditor.tsx']);
    expect(owners('theme_copy')).toEqual(['LibraryInspector.tsx', 'ThemeEditor.tsx', 'ThemesScreen.tsx']);
    expect(owners('theme_create')).toEqual(['ThemesScreen.tsx']);
    // The mutation: a theme write planted in the list fails its allow-list.
    const list = files.find(([f]) => f === 'ThemesScreen.tsx')![1];
    const planted = list.replace('  const first = useRef(true);', "  void call('theme_edit', { theme: 'x', if_match: 'y', edit: {} });\n  const first = useRef(true);");
    expect(planted).not.toBe(list);
    expect([...new Set(opsCalled(planted))].sort()).not.toEqual([...LIBRARY_OPS['ThemesScreen.tsx']].sort());
  });

  it('⚑ every theme write the engine guards names the version shown — theme_edit carries if_match (checked on each call\'s argument object); the scenario writes of "Use in a scenario" name its hash', async () => {
    const files = await appSources();
    const edits = files.flatMap(([f, text]) => opCalls(text, new Set(['theme_edit'])).map((c) => ({ f, ...c })));
    expect(edits.map((c) => c.f).sort()).toEqual(['LibraryInspector.tsx', 'LibraryInspector.tsx', 'ThemeEditor.tsx']);
    for (const c of edits) expect(c.keys, `${c.f}:${c.line}`).toEqual(['theme', 'if_match', 'edit']);
    const scenario = opCalls(files.find(([f]) => f === 'ThemeEditor.tsx')![1], new Set(['scenario_edit']));
    expect(scenario.length).toBe(2);
    for (const c of scenario) expect(c.keys).toContain('hash');
    // The engine's own input requires it (L7.17: theme_edit is the engine's operation).
    const ops = await readFile(join(REPO, 'packages', 'engine', 'src', 'operations', 'themes.ts'), 'utf8');
    expect(ops.slice(ops.indexOf('const EditInput ='), ops.indexOf('const CopyInput ='))).toMatch(/if_match: sha256/);
    // The mutation: a theme_edit without its version.
    expect(opCalls("call('theme_edit', { theme: target, edit: plan.edit })", new Set(['theme_edit']))[0].keys).not.toContain('if_match');
  });

  it('⚑ L5.12c fixes (review A-M2): every app file imports the api\'s call / useCall by their own names and only calls them — an alias, a namespace import or a call bound to another name fails (both of the review\'s dodges planted); the if_match lint sees `x.call(…)`', async () => {
    const files = (await appSources()).filter(([f]) => /\.tsx?$/.test(f) && f !== 'api.ts');
    expect(files.flatMap(([f, text]) => apiImportFindings(f, text))).toEqual([]);
    // The files that call the api at all (L6.13: through a data module) are seen by the lint (it is not vacuous).
    expect(files.filter(([, text]) => /from '\.\/(?:\.\.\/)?(?:api|data\/[a-z-]+)\.js'/.test(text)).length).toBeGreaterThan(20);
    const editor = files.find(([f]) => f === 'ThemeEditor.tsx')![1];
    const line = "import { CallError, errorText } from './api.js';";
    expect(editor).toContain(line);
    // Dodge 1: `import { call as rpc }` then rpc('theme_edit', …) — invisible to opsCalled, caught here.
    const alias = `${editor.replace(line, `${line}\nimport { call as rpc } from './api.js';`)}\nexport const dodge = () => rpc('theme_edit', { theme: 'x', edit: {} });\n`;
    expect(opsCalled(alias).filter((op) => op === 'theme_edit').length).toBe(opsCalled(editor).filter((op) => op === 'theme_edit').length);
    expect(apiImportFindings('ThemeEditor.tsx', alias)).toEqual(['ThemeEditor.tsx: import { call as rpc } from the api']);
    // L6.13: the same dodge through a data function — `import { themeEdit as rpc }`.
    const dataAlias = `${editor.replace(line, `${line}\nimport { themeEdit as rpc } from './data/themes.js';`)}\nexport const dodge = () => rpc({ theme: 'x', edit: {} });\n`;
    expect(opsCalled(dataAlias).filter((op) => op === 'theme_edit').length).toBe(opsCalled(editor).filter((op) => op === 'theme_edit').length);
    expect(apiImportFindings('ThemeEditor.tsx', dataAlias)).toEqual(['ThemeEditor.tsx: import { themeEdit as rpc } from the api']);
    // Dodge 2: `import * as api` then api.call('theme_edit', …) without if_match — caught here and by opCalls.
    const ns = `${editor.replace(line, `${line}\nimport * as api from './api.js';`)}\nexport const dodge = () => api.call('theme_edit', { theme: 'x', edit: {} });\n`;
    expect(apiImportFindings('ThemeEditor.tsx', ns)).toEqual(['ThemeEditor.tsx: import * as api from the api']);
    expect(opCalls(ns, new Set(['theme_edit'])).filter((c) => !c.keys.includes('if_match'))).toEqual([expect.objectContaining({ op: 'theme_edit', keys: ['theme', 'edit'] })]);
    // A call bound to another name or passed on; a default, a re-export, a dynamic import.
    expect(apiImportFindings('X.tsx', "import { call } from './api.js';\nconst rpc = call;\nrpc('theme_edit', {});")).toEqual(['X.tsx:2: call used as a value']);
    expect(apiImportFindings('X.tsx', "import { useCall } from './api.js';\nrun(useCall);")).toEqual(['X.tsx:2: useCall used as a value']);
    expect(apiImportFindings('X.tsx', "import api from './api.js';")).toEqual(['X.tsx: a default import of the api (api)']);
    expect(apiImportFindings('X.tsx', "export { call } from './api.js';")).toEqual(['X.tsx: re-exports the api']);
    expect(apiImportFindings('X.tsx', "const m = import('./api.js');")).toEqual(['X.tsx: a dynamic import of the api']);
    // What stays allowed: a call, a member named call of something else, an object key.
    expect(apiImportFindings('X.tsx', "import { call, useCall } from './api.js';\ncall<T>('theme_view', {});\nuseCall('x', {}, 'k');\nfn.call(null);\nconst o = { call: 1 };")).toEqual([]);
  });

  it('⚑ L6.12–L6.13 fixes (L7): every value a data module exports is a data function the op lints know (DATA_FNS: `op(…)` / `readHook(…)` of its op, or a helper whose op is its argument) — none escapes them', () => {
    const sources = dataSources();
    expect(sources.map(([f]) => f)).toEqual(expect.arrayContaining(['comments.ts', 'projects.ts', 'themes.ts']));
    const values = dataValueExports(sources);
    expect(values.size).toBeGreaterThan(60);
    expect([...values.keys()].filter((n) => !DATA_FNS.has(n))).toEqual([]);
    // The helpers whose op is an argument: each with the ops it takes.
    expect(DATA_FNS.get('threadWrite')).toEqual({ op: null, ops: ['thread_reply', 'thread_resolve', 'thread_reopen'] });
    expect(DATA_FNS.get('projectRead')).toEqual({ op: null, ops: ['project_get', 'project_board', 'auth_status'] });
    // The mutations: a data function the lints would not see (a wrapper of its own, a re-export, a class).
    const planted: Array<[string, string]> = [...sources, ['planted.ts', "import { call } from '../api.js';\nexport const sneaky = (a: object) => call('theme_edit', a);\nexport { themeEdit as edit } from './themes.js';\nexport class Client {}\n"]];
    expect([...dataValueExports(planted).keys()].filter((n) => !DATA_FNS.has(n))).toEqual(['sneaky', '(re-export in planted.ts)', 'Client']);
  });

  it('⚑ L5.12c fixes (review A-L5): the colour constants of theme-words.ts (an export whose value holds a colour literal) are imported only where theme data is shown — the gallery\'s sample, the New theme form, the colour fields\' fallback', async () => {
    const files = (await appSources()).filter(([f]) => /\.tsx?$/.test(f));
    const colours = colourExports(files.find(([f]) => f === 'theme-words.ts')![1]);
    expect(colours.sort()).toEqual(['EMPTY_FORM', 'SAMPLE_ACCENT', 'pickerValue']);
    const ALLOWED: Record<string, string[]> = {
      'GalleryScreen.tsx': ['SAMPLE_ACCENT', 'pickerValue'],
      'ThemesScreen.tsx': ['EMPTY_FORM', 'pickerValue'],
      'ThemeFields.tsx': ['pickerValue'],
    };
    const found: Record<string, string[]> = {};
    for (const [f, text] of files) {
      if (f === 'theme-words.ts') continue;
      const names = themeWordsImports(text);
      const taken = names === '*' ? ['*'] : names.filter((n) => colours.includes(n));
      if (taken.length) found[f] = taken.sort();
    }
    expect(found).toEqual(ALLOWED);
    // Planted: the chrome taking a theme colour; a namespace import.
    expect(themeWordsImports("import { SAMPLE_ACCENT } from './theme-words.js';")).toEqual(['SAMPLE_ACCENT']);
    expect(themeWordsImports("import * as tw from '../theme-words.js';")).toBe('*');
    expect(colourExports("export const X = '#123456';\nexport const Y = 'words';\nexport const Z = (v: string) => v ?? 'rgb(0, 0, 0)';").sort()).toEqual(['X', 'Z']);
  });
});

describe('no note about an earlier name in the browser foot (v0.2.1)', () => {
  it('⚑ the shell and its stylesheet hold no legacy note', async () => {
    const shellCss = cssRules((await kitCss()).find(([f]) => f === 'shell/shell.css')![1]);
    expect(shellCss.filter((r) => r.selector.includes('legacy'))).toEqual([]);
    const shell = await readFile(join(APP, 'shell', 'AppShell.tsx'), 'utf8');
    expect(shell).not.toMatch(/legacy|old_home|old_vars/);
  });
});
