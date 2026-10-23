/**
 * L4.1 part 2: the Studio app's sources never build HTML from data (D13) — a lint over src/app bans the raw-HTML and
 * code-from-string APIs, `src=` attributes, and any `href` not built by `hrefTo` (or a literal in-app fragment) — and the
 * hash routes treat whatever the address bar holds as an inert string. L4.2: one image source (Thumb.tsx, a data: URL
 * from `jpegDataUrl`), and no srcSet, createElement, `src` key or embedded media anywhere.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../../engine/test/helpers.js';
import { visibleControls } from '../src/app/bits.js';
import { hrefTo, parseRoute } from '../src/app/route.js';
import { THUMB_DATA_MAX, jpegDataUrl } from '../src/app/thumbs.js';

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
];

/**
 * L4.2: the app's one image source — Thumb.tsx renders `<img src={url}` where `url` is `jpegDataUrl(entry.base64)` (a
 * fixed `data:image/jpeg;base64,` prefix and a checked payload). Exactly that line, once, in that file only.
 */
const THUMB_FILE = 'Thumb.tsx';
const THUMB_SRC = /<img src=\{url\} /g;
const THUMB_URL = /const url = entry\?\.state === 'ok' \? jpegDataUrl\(entry\.base64\) : null;/g;

/** A source as the lint reads it: Thumb.tsx without its one allowed image source (checked on its own). */
function linted(f: string, src: string): string {
  return f === THUMB_FILE ? src.replace(THUMB_SRC, '<img ') : src;
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

  it('the one image source: Thumb.tsx, once, `src={url}` with url = jpegDataUrl(entry.base64)', async () => {
    const files = new Map(await appSources());
    const thumb = code(files.get(THUMB_FILE) ?? '');
    expect(thumb.match(THUMB_SRC)?.length, 'one <img src={url} in Thumb.tsx').toBe(1);
    expect(thumb.match(THUMB_URL)?.length, 'url is built by jpegDataUrl, once').toBe(1);
    expect(thumb.match(/\burl\s*=/g)?.length, 'url assigned once').toBe(1);
    expect(thumb.match(/\bsrc=/g)?.length).toBe(1);
    for (const [f, text] of files) if (f !== THUMB_FILE) expect(/\bsrc=/.test(code(text)), f).toBe(false);
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
