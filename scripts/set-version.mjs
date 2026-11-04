#!/usr/bin/env node
/**
 * Move Retake's one version number (L5.16d review d B-M3, docs/guide/desktop-app.md "Releasing an update"): every file that carries it,
 * the same list packages/cli/test/app-bundle.test.ts "one version number" checks — the root and every package's
 * package.json, RETAKE_VERSION (core formats.ts), apps/desktop/tauri.conf.json, the Claude plugin's manifest, the
 * desktop crate's Cargo.toml and its Cargo.lock entry. Only the version field of each changes.
 *
 *   node scripts/set-version.mjs 0.2.1          # write it everywhere
 *   node scripts/set-version.mjs --check        # list the files that disagree with the root package.json (exit 1)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const JSON_VERSION = /^(\s*"version":\s*")([^"]+)(")/m;
/** Each file: its path in the repository and the pattern whose second group is the version. */
export function versionFiles(repo = REPO) {
  const packages = readdirSync(join(repo, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `packages/${d.name}/package.json`)
    .sort();
  return [
    ...['package.json', ...packages, 'apps/desktop/tauri.conf.json', 'skills/.claude-plugin/plugin.json'].map((path) => ({ path, re: JSON_VERSION })),
    { path: 'packages/core/src/formats.ts', re: /^(export const RETAKE_VERSION = ')([^']+)(';)/m },
    { path: 'apps/desktop/Cargo.toml', re: /^(version = ")([^"]+)(")/m },
    { path: 'apps/desktop/Cargo.lock', re: /(name = "retake-desktop"\nversion = ")([^"]+)(")/ },
  ];
}

/** The version each file carries (null: its field was not found). */
export function readVersions(repo = REPO) {
  return versionFiles(repo).map(({ path, re }) => ({ path, version: re.exec(readFileSync(join(repo, path), 'utf8'))?.[2] ?? null }));
}

/** Write `version` into every file (only the field); returns the files changed. */
export function setVersion(version, repo = REPO) {
  if (!VERSION_RE.test(version)) throw new Error(`"${version}" is not a version (major.minor.patch, an optional -pre-release, no leading v)`);
  const changed = [];
  for (const { path, re } of versionFiles(repo)) {
    const file = join(repo, path);
    const text = readFileSync(file, 'utf8');
    if (!re.test(text)) throw new Error(`${path}: its version field was not found`);
    const next = text.replace(re, (_, a, _old, b) => `${a}${version}${b}`);
    if (next !== text) {
      writeFileSync(file, next);
      changed.push(path);
    }
  }
  return changed;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = process.argv[2];
  try {
    if (arg === '--check') {
      const all = readVersions();
      const want = all[0].version;
      const off = all.filter((f) => f.version !== want);
      for (const f of off) process.stdout.write(`${f.path}: ${f.version ?? 'no version field'} (package.json: ${want})\n`);
      process.exit(off.length ? 1 : 0);
    }
    const changed = setVersion(arg ?? '');
    process.stdout.write(`${changed.length} files now at ${arg}${changed.length ? `:\n  ${changed.join('\n  ')}` : ''}\nThen: a "## [${arg}]" section in CHANGELOG.md (its first paragraph is the release notes), and pnpm build.\n`);
  } catch (e) {
    process.stderr.write(`set-version: ${e.message}\n`);
    process.exit(1);
  }
}
