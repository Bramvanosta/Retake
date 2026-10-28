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
 * never reads page text; the record route.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { RecordOptionsAnswer, RecordViewAnswer } from '../src/server/record-ops.js';
import { RecordingBody, StartForm } from '../src/app/RecordScreen.js';
import type { RecordingUi } from '../src/app/RecordScreen.js';
import { REPO } from '../../engine/test/helpers.js';
import { visibleControls } from '../src/app/bits.js';
import { hrefTo, parseRoute } from '../src/app/route.js';
import { FRAME_URL_RE, previewUrls } from '../src/app/timeline-words.js';
import { PREVIEW_FRAME_ATTRS } from '../src/player/parent.js';
import { LOOP_DATA_MAX, POSTER_DATA_MAX, SHEET_DATA_MAX, THUMB_DATA_MAX, imageDataUrl, jpegDataUrl } from '../src/app/thumbs.js';

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

describe('the app builds no HTML from data (source lint)', () => {
  it('no raw-HTML, eval or src= API in src/app; every href is hrefTo(...) or a literal "#…"', async () => {
    const files = await appSources();
    expect(files.map(([f]) => f)).toEqual(expect.arrayContaining(['main.tsx', 'ReadmeEditor.tsx', 'ProjectsScreen.tsx', 'Shell.tsx']));
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
      for (const m of src.matchAll(/^import\s+(type\s+)?[^;]*from\s+['"](@demo-studio\/[a-z-]+)['"]/gm)) expect(m[1], `${f}: a runtime import of ${m[2]}`).toBeTruthy();
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
const THREAD_CALL = /\b(?:call|useCall)(?:<[^>]*>)?\(\s*'(thread_[a-z_]+)'/g;
const NAMED = /\b(author|via|proposal|name)\s*:/;

/** The argument text of each `call('thread_…', …)` in a source (to its closing parenthesis). */
function threadCalls(src: string): Array<{ op: string; args: string }> {
  const out: Array<{ op: string; args: string }> = [];
  for (const m of src.matchAll(THREAD_CALL)) {
    let depth = 0;
    let i = src.indexOf('(', m.index);
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push({ op: m[1], args: src.slice(start, i + 1) });
  }
  return out;
}

describe('the comment writes name nobody (L4.6 part D1)', () => {
  it('⚑ no thread_* call of the app sends an author, a via, a proposal or a name', async () => {
    const calls = (await appSources()).flatMap(([f, text]) => threadCalls(code(text)).map((c) => ({ f, ...c })));
    const ops = new Set(calls.map((c) => c.op));
    // Part D2: Apply and Resolve with vN call their ops directly (ProposalPanel.tsx).
    for (const op of ['thread_add', 'thread_get', 'thread_still', 'thread_apply', 'thread_resolve']) expect(ops, op).toContain(op);
    // Reply, resolve and reopen go through one helper (ThreadActions' send): its op names are arguments.
    const screen = code((await appSources()).find(([f]) => f === 'CommentsScreen.tsx')![1]);
    for (const op of ['thread_reply', 'thread_resolve', 'thread_reopen']) expect(screen).toContain(`'${op}'`);
    expect(screen).toMatch(/call\(op, \{ project: slug, comment_id: th\.id, \.\.\.args \}\)/);
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
    expect(timeline).toMatch(/useCall<TimelineViewAnswer>\('timeline_view', args,/);
    // thread_apply sends the reply and the thread's hash shown, nothing else.
    const panel = code(files.find(([f]) => f === 'ProposalPanel.tsx')![1]);
    const applies = threadCalls(panel).filter((c) => c.op === 'thread_apply');
    expect(applies.map((c) => c.args)).toEqual(["('thread_apply', { project: slug, comment_id: threadId, entry_id: entryId, if_match: ifMatch })"]);
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

const UI: RecordingUi = { busy: false, note: { tone: 'danger', text: H('note'), issues: [{ severity: 'error', code: 'invalid', message: H('noteissue'), scene: H('scene'), step: 0 }], fix: H('notefix') }, taken: null, discarding: false, now: Date.parse('2026-10-28T10:05:00.000Z') };
const ACT = { annotate: () => undefined, stop: () => undefined, discard: () => undefined, save: () => undefined, onSignedIn: () => undefined };

describe('the Record screen shows page text only through Txt (L4.8 part 5)', () => {
  it('⚑ a recording: every page string (rows, targets, alternatives, inserts, issues, placeholders, writes, the check, the YAML) in a <bdi>, its direction controls as visible marks', () => {
    const done = hostileView();
    const failed = { ...done, state: 'failed' } as RecordViewAnswer;
    for (const [v, cursor] of [
      [done, { at: 'end' as const }],
      [done, { at: 'after' as const, row: 'a1' }],
      [failed, { at: 'end' as const }],
    ] as const) {
      const html = shownMarkup(renderToStaticMarkup(createElement(RecordingBody, { slug: 'p', v, cursor, setCursor: () => undefined, ui: UI, act: ACT })));
      expect(html.includes(RLO), 'a raw direction control').toBe(false);
      expect(html).not.toMatch(/<img|onerror="/);
      const places = placesOf(html);
      const bare = places.filter((p) => p.where === 'bare' || p.where === 'option');
      expect(bare, JSON.stringify(bare)).toEqual([]);
      // Attributes hold page text only with the controls made visible (visibleControls): no raw RLO above.
      const shown = new Set(places.filter((p) => p.where === 'bdi').map((p) => p.n));
      for (const n of ['name', 'env', 'persona', 'scene', 'scenepage', 'sceneopen', 'label0', 'target0', 'summary0', 'chip0', 'label1', 'alt0', 'alt1', 'waittext', 'caption', 'kicker', 'mark', 'issue', 'placeholder', 'write', 'checkerror', 'action', 'yaml1', 'yaml2', 'problem', 'warning', 'savedfile', 'note', 'noteissue', 'notefix']) {
        expect(shown, n).toContain(n);
      }
      // The cursor's words (its row's step and scene) are page text too; each row's Insert after names its step, its
      // controls made visible (an attribute), and keeps its name whatever the cursor (aria-pressed says it).
      if (cursor.at === 'after') expect(html.slice(html.indexOf('Where:')).slice(0, 400)).toMatch(/after (?:<!-- -->)?<bdi[^>]*>step 1 of /);
      if (v.can.annotate) expect(html).toMatch(/aria-label="Insert after step 1 of [^"]*PAGE-scene\[U\+202E\]gnp"/);
      // A failed job: its message and its command.
      if (v.state === 'failed') for (const n of ['jobmessage', 'jobfix']) expect(shown, n).toContain(n);
    }
  });

  it('B-L5: Start is refused for a persona that cannot sign in by itself — the reason said, Sign in offered', () => {
    const o = hostileOptions();
    const html = renderToStaticMarkup(createElement(StartForm, { slug: 'p', o: { ...o, open: null }, onStarted: () => undefined, onChanged: () => undefined }));
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*data-testid="record-start"/);
    expect(html).toContain('data-testid="record-start-blocked"');
    expect(html).toContain('data-testid="sign-in-button"');
    const signed = { ...o, open: null, environments: o.environments.map((e) => ({ ...e, problem: undefined, personas: e.personas.map((x) => ({ ...x, status: 'valid' as const })) })) } as RecordOptionsAnswer;
    const ok = renderToStaticMarkup(createElement(StartForm, { slug: 'p', o: signed, onStarted: () => undefined, onChanged: () => undefined }));
    expect(ok).not.toContain('data-testid="record-start-blocked"');
    expect(ok).not.toMatch(/<button type="submit"[^>]*disabled=""[^>]*data-testid="record-start"/);
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

