/**
 * L4.1 part 2: the Studio app's sources never build HTML from data (D13) — a lint over src/app bans the raw-HTML and
 * code-from-string APIs, `src=` attributes, and any `href` not built by `hrefTo` (or a literal in-app fragment) — and the
 * hash routes treat whatever the address bar holds as an inert string. L4.2: one image source (Thumb.tsx, a data: URL
 * from `jpegDataUrl`), and no srcSet, createElement, `src` key or embedded media anywhere. L4.4 (critique B14): the live
 * picture is decoded by `createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}))` in LiveView.tsx only — no blob: or
 * object URL anywhere (an address a frame could be loaded from). L4.5 part C: one frame — PreviewFrame.tsx's `<iframe`,
 * once, with the literal attributes of player/parent.ts's PREVIEW_FRAME_ATTRS (`sandbox="allow-scripts"` and no other
 * sandbox token anywhere in the app) and `src={frameSrc}` once, frameSrc being the URL TimelineScreen.tsx checked with
 * previewUrls (the player origin's frame route) and set only after connectPreview listens.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../../engine/test/helpers.js';
import { visibleControls } from '../src/app/bits.js';
import { hrefTo, parseRoute } from '../src/app/route.js';
import { FRAME_URL_RE, previewUrls } from '../src/app/timeline-words.js';
import { PREVIEW_FRAME_ATTRS } from '../src/player/parent.js';
import { SHEET_DATA_MAX, THUMB_DATA_MAX, jpegDataUrl } from '../src/app/thumbs.js';

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
 * L4.2: the app's one image source — Thumb.tsx renders `<img src={url}` where `url` is `jpegDataUrl(base64, max)` (a
 * fixed `data:image/jpeg;base64,` prefix and a checked payload). Exactly that line, once, in that file only. L4.5 part
 * E: that `<img>` is Thumb.tsx's `Jpeg`, used for the step pictures and the review's contact sheets; `max` is one of the
 * two caps — every `<Jpeg` in the app passes `max={THUMB_DATA_MAX}` or `max={SHEET_DATA_MAX}` literally.
 */
const THUMB_FILE = 'Thumb.tsx';
const THUMB_SRC = /<img src=\{url\} /g;
const THUMB_URL = /const url = jpegDataUrl\(base64, max\);/g;
const JPEG_USE = /<Jpeg\b[^>]*>/g;
const JPEG_MAX = /\bmax=\{(THUMB_DATA_MAX|SHEET_DATA_MAX)\}/;

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

  it('the one image source: Thumb.tsx, once, `src={url}` with url = jpegDataUrl(entry.base64)', async () => {
    const files = new Map(await appSources());
    const thumb = code(files.get(THUMB_FILE) ?? '');
    expect(thumb.match(THUMB_SRC)?.length, 'one <img src={url} in Thumb.tsx').toBe(1);
    expect(thumb.match(THUMB_URL)?.length, 'url is built by jpegDataUrl, once').toBe(1);
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
    // The caps: a contact sheet's payload is refused past SHEET_DATA_MAX, a step picture's past THUMB_DATA_MAX.
    const b64 = (n: number) => 'A'.repeat(n);
    expect(jpegDataUrl(b64(THUMB_DATA_MAX + 4))).toBeNull();
    expect(jpegDataUrl(b64(THUMB_DATA_MAX + 4), SHEET_DATA_MAX)).not.toBeNull();
    expect(jpegDataUrl(b64(SHEET_DATA_MAX + 4), SHEET_DATA_MAX)).toBeNull();
    expect(jpegDataUrl(b64(THUMB_DATA_MAX + 4), 9_999_999 as never)).toBeNull();
    expect(jpegDataUrl('AAAA<svg>', SHEET_DATA_MAX)).toBeNull();
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
