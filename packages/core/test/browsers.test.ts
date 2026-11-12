/**
 * core/io browsers.ts (L7.25, finding X9): the one module that reads playwright-core's private browser registry,
 * through the caller's own `require` (runner-web's launch target, the editor's render browser). What it answers for a
 * registry that knows the browser, does not, gives an empty path, cannot be loaded, and with `installed` for a file
 * that is there or not.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PLAYWRIGHT_REGISTRY_MODULE, playwrightBrowser } from '@retake/core/io';

const dir = await mkdtemp(join(tmpdir(), 'retake-browsers-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

/** A require whose registry knows `paths` (name → executable path); every id it was asked for, and with which language. */
function fakeRequire(paths: Record<string, string | undefined>) {
  const asked: string[] = [];
  const require = (id: string) => {
    asked.push(id);
    return { registry: { findExecutable: (name: string) => (name in paths ? { executablePath: (lang?: string) => (asked.push(`lang ${lang}`), paths[name]) } : undefined) } };
  };
  return { require, asked };
}

describe('playwrightBrowser: the browser registry of playwright-core, read once', () => {
  it('answers the executable the registry gives for a name, through the private module, for the javascript language', () => {
    const { require, asked } = fakeRequire({ chromium: '/x/chromium', 'chromium-headless-shell': '/x/shell' });
    expect(playwrightBrowser(require, 'chromium')).toBe('/x/chromium');
    expect(playwrightBrowser(require, 'chromium-headless-shell')).toBe('/x/shell');
    expect(asked).toEqual([PLAYWRIGHT_REGISTRY_MODULE, 'lang javascript', PLAYWRIGHT_REGISTRY_MODULE, 'lang javascript']);
    expect(PLAYWRIGHT_REGISTRY_MODULE).toBe('playwright-core/lib/server/registry/index');
  });

  it('null when the registry does not say: an unknown browser, an empty path, a module that cannot be loaded', () => {
    expect(playwrightBrowser(fakeRequire({}).require, 'chrome')).toBeNull();
    expect(playwrightBrowser(fakeRequire({ chromium: '' }).require, 'chromium')).toBeNull();
    expect(playwrightBrowser(fakeRequire({ chromium: undefined }).require, 'chromium')).toBeNull();
    expect(
      playwrightBrowser(() => {
        throw new Error('Cannot find module');
      }, 'chromium'),
    ).toBeNull();
  });

  it('with installed: the path only when the file is there', async () => {
    const there = join(dir, 'shell');
    await writeFile(there, '');
    expect(playwrightBrowser(fakeRequire({ s: there }).require, 's', { installed: true })).toBe(there);
    expect(playwrightBrowser(fakeRequire({ s: join(dir, 'gone') }).require, 's', { installed: true })).toBeNull();
    expect(playwrightBrowser(fakeRequire({ s: join(dir, 'gone') }).require, 's')).toBe(join(dir, 'gone'));
  });

  it('through a real playwright-core (the one of the runner), the registry still answers a path for Chromium', () => {
    const require = createRequire(new URL('../../runner-web/package.json', import.meta.url));
    const path = playwrightBrowser(require, 'chromium');
    expect(typeof path).toBe('string');
    expect(path!.length).toBeGreaterThan(0);
  });
});
