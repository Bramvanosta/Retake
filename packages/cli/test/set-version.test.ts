/**
 * L5.16d (review d B-M3) — scripts/set-version.mjs: the one version number moved in every file that carries it (the
 * list app-bundle.test.ts "one version number" checks), only the version field of each, on a copy of those files.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs script (no types)
import * as sv from '../../../scripts/set-version.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const base = mkdtempSync(join(tmpdir(), 'retake-set-version-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('set-version.mjs', () => {
  it('covers every file the version test checks; the repository agrees with itself', () => {
    const paths = (sv.versionFiles(REPO) as Array<{ path: string }>).map((f) => f.path);
    const check = readFileSync(join(REPO, 'packages', 'cli', 'test', 'app-bundle.test.ts'), 'utf8');
    for (const p of ['apps/desktop/tauri.conf.json', 'skills/.claude-plugin/plugin.json', 'apps/desktop/Cargo.toml', 'apps/desktop/Cargo.lock']) {
      expect(paths).toContain(p);
      expect(check).toContain(p);
    }
    expect(paths).toContain('packages/core/src/formats.ts');
    expect(paths.filter((p) => /^packages\/[^/]+\/package\.json$/.test(p)).length).toBeGreaterThanOrEqual(10);
    const versions = (sv.readVersions(REPO) as Array<{ version: string | null }>).map((f) => f.version);
    expect(new Set(versions)).toEqual(new Set([JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version]));
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'set-version.mjs'), '--check'], { encoding: 'utf8' });
    expect(r.status, r.stdout).toBe(0);
  });

  it('moves the version in a copy: every file, only its version field; a bad version refused', () => {
    const files = sv.versionFiles(REPO) as Array<{ path: string }>;
    for (const { path } of files) {
      mkdirSync(join(base, dirname(path)), { recursive: true });
      cpSync(join(REPO, path), join(base, path));
    }
    const before = (sv.readVersions(base) as Array<{ version: string }>)[0].version;
    expect(sv.setVersion('0.3.0-rc.1', base)).toEqual(files.map((f) => f.path));
    for (const { path, version } of sv.readVersions(base) as Array<{ path: string; version: string }>) {
      expect(version, path).toBe('0.3.0-rc.1');
      // Nothing else changed: putting the old number back gives the original text.
      const text = readFileSync(join(base, path), 'utf8');
      const re = files.find((f) => f.path === path) as unknown as { re: RegExp };
      expect(text.replace(re.re, (_: string, a: string, _v: string, b: string) => `${a}${before}${b}`), path).toBe(readFileSync(join(REPO, path), 'utf8'));
    }
    // The same version again changes nothing.
    expect(sv.setVersion('0.3.0-rc.1', base)).toEqual([]);
    for (const bad of ['v0.3.0', '0.3', '0.3.0 ', '']) expect(() => sv.setVersion(bad, base), bad).toThrow(/is not a version/);
  });
});
