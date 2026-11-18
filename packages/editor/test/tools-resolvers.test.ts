/**
 * The editor in the app: the render browser and the compositor are the downloaded Tools (`<RETAKE_HOME>/tools`),
 * used only once their cheap check says ready; a checkout keeps Playwright's cache and node_modules. And the source scan
 * that holds every rendering-library call of this package to name its compositor folder (`binariesDirectory`): the app
 * ships no compositor package, so a call that forgets it would fail in the app only.
 */
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BundleInfo } from '@retake/core/io';
import { renderBrowser } from '@retake/editor';
import { libraryBinaries } from '../src/render/library.js';
import { fakeToolsBundle, placeTool, toolFixtures } from '@retake/test-support/tools';
import type { FixtureTools } from '@retake/test-support/tools';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-editor-tools-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let fx: FixtureTools;
let app: BundleInfo;
beforeAll(async () => {
  fx = await toolFixtures(join(tmp, 'fx'));
  app = fakeToolsBundle(join(tmp, 'app'), fx.entries);
});

describe("in the app: the downloaded render browser and compositor, once they're checked", () => {
  it('not downloaded yet: no render browser and no compositor, each saying `retake tools install`; then the Tools folder', () => {
    const env = { RETAKE_HOME: join(tmp, 'home1') };
    const tools = join(tmp, 'home1', 'tools');
    // Playwright's cache is never used by an app, even when it has a headless shell.
    expect(renderBrowser(env, app, () => '/cache/chrome-headless-shell')).toMatchObject({ path: null, source: 'none', note: expect.stringMatching(/^the render browser is not downloaded yet \(.*\): run `retake tools install`/) });
    expect(() => libraryBinaries(env, app)).toThrow(/^no compositor to render with: the compositor is not downloaded yet/);
    placeTool(tools, fx.byId('render-browser'));
    placeTool(tools, fx.byId('compositor'));
    expect(renderBrowser(env, app, () => null)).toEqual({ path: join(tools, 'browsers', 'chromium_headless_shell-001', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'), source: 'tools' });
    expect(libraryBinaries(env, app)).toBe(join(tools, 'compositor-0.0.1'));
    // $RETAKE_CHROMIUM_HEADLESS_SHELL still comes first.
    expect(renderBrowser({ ...env, RETAKE_CHROMIUM_HEADLESS_SHELL: process.execPath }, app)).toEqual({ path: process.execPath, source: 'env' });
  });

  it('a damaged Tool (its files changed since its check) is not used: `retake tools check`', () => {
    const env = { RETAKE_HOME: join(tmp, 'home2') };
    const tools = join(tmp, 'home2', 'tools');
    const shell = placeTool(tools, fx.byId('render-browser'));
    const comp = placeTool(tools, fx.byId('compositor'));
    writeFileSync(join(shell, 'chrome-headless-shell-mac-arm64', 'planted'), 'x');
    writeFileSync(join(comp, 'planted.dylib'), 'x');
    expect(renderBrowser(env, app)).toMatchObject({ path: null, note: expect.stringMatching(/the render browser in .* is damaged \(its files changed .*\): run `retake tools check`/) });
    expect(() => libraryBinaries(env, app)).toThrow(/the compositor in .* is damaged/);
  });

  it('in a checkout: the library’s own compositor (no folder handed), Playwright’s headless shell', () => {
    expect(libraryBinaries({}, null)).toBeNull();
    expect(renderBrowser({}, null, () => '/cache/chrome-headless-shell')).toEqual({ path: '/cache/chrome-headless-shell', source: 'playwright' });
  });
});

/** Every `.ts` under src/, depth first. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

/** The text of the object literal that opens at `open` (`{`), braces balanced. */
function objectAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/** The library's calls that run its compositor (the bindings this package gives them: `still` is renderStill). */
const LIBRARY_CALL = /\b(selectComposition|renderMedia|renderStill|still|callFf)\(\{/g;

describe('the source scan: every rendering-library call names binariesDirectory', () => {
  it('each call of selectComposition, renderMedia, renderStill (still) and callFf hands binariesDirectory', () => {
    const calls: string[] = [];
    const without: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(LIBRARY_CALL)) {
        const where = `${file.slice(SRC.length + 1)}:${text.slice(0, m.index).split('\n').length} ${m[1]}`;
        calls.push(where);
        if (!/\bbinariesDirectory\b/.test(objectAt(text, m.index + m[0].length - 1))) without.push(where);
      }
    }
    // The calls this lot counted (render, stills, previews, the VideoToolbox probe): a new one is scanned too.
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(without).toEqual([]);
  });

  it('the scan sees a call without it (its own check)', () => {
    const text = 'await renderMedia({\n  ...common,\n  composition,\n  inner: { a: 1 },\n});';
    const m = [...text.matchAll(LIBRARY_CALL)][0]!;
    expect(/\bbinariesDirectory\b/.test(objectAt(text, m.index + m[0].length - 1))).toBe(false);
  });
});
