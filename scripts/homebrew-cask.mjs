#!/usr/bin/env node
/**
 * The release workflow's last step (docs/RELEASING.md › The Homebrew tap): write the Homebrew casks of a version into a
 * checkout of the tap — plain Node, no dependency, no network; the workflow clones the tap, runs this, then commits and
 * pushes only when a cask changed.
 *
 *   node scripts/homebrew-cask.mjs v0.2.1 --sums <dir>/SHA256SUMS-macos.txt --updates on|off --tap <tap checkout>
 *   node scripts/homebrew-cask.mjs v0.2.1 --sha256 <the DMG's sha256> --updates on|off --tap <tap checkout>
 *
 * - `Casks/retake.rb` follows the stable versions only; `Casks/retake@beta.rb` follows every version, pre-release or
 *   stable, so a beta install is never behind the stable one. A cask is never moved back to an older version (a re-run
 *   of an old tag leaves it alone); a cask whose version cannot be read is refused, not overwritten.
 * - Both install the release's DMG (scripts/release.mjs dmgName: `Retake_<version>_aarch64.dmg`, Apple silicon only,
 *   macOS 15 or later). Where the release lives comes from the run's own context — GITHUB_REPOSITORY (`<owner>/<repo>`)
 *   and GITHUB_SERVER_URL (else GitHub's) — never from this file: it names no account and no repository.
 * - The DMG's sha256: `--sha256`, or the DMG's line in the release's SHA256SUMS-macos.txt (`--sums`, exactly one line
 *   naming that DMG).
 * - `--updates`: whether this build has the updater (the release job's `updates`). Only then does a cask say
 *   `auto_updates true` — `brew upgrade` leaves an auto-updating cask alone unless --greedy, so a build that never
 *   updates itself must not claim it.
 * - Every value written into the Ruby is checked first (a version, a sha256, an https origin, `<owner>/<repo>`, a bundle
 *   identifier): a quote, a `#{`, a backslash or a newline never reaches a cask.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareVersions, feedLocation } from './publish-update.mjs';
import { dmgName } from './release.mjs';
import { VERSION_RE } from './set-version.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class CaskError extends Error {}

/** The casks' token: `retake` (stable versions) and `retake@beta` (every version). */
export const TOKEN = 'retake';
export const BETA_TOKEN = `${TOKEN}@beta`;
const SHA256_RE = /^[0-9a-f]{64}$/;
/** An origin a cask may name: https, a host, an optional port — nothing a Ruby string would interpret. */
const ORIGIN_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const REPOSITORY_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
/** Every value interpolated into a cask, whatever checked it before: no quote, `#`, `{`, backslash, space or newline. */
const RUBY_SAFE = /^[A-Za-z0-9._:/@+-]+$/;

/** The app's bundle identifier (apps/desktop/tauri.conf.json `identifier`): the folders `zap` removes are named by it. */
export function bundleId(repo = REPO) {
  const id = JSON.parse(readFileSync(join(repo, 'apps', 'desktop', 'tauri.conf.json'), 'utf8')).identifier;
  if (typeof id !== 'string' || !BUNDLE_ID_RE.test(id)) throw new CaskError(`apps/desktop/tauri.conf.json's identifier "${id}" is not a bundle identifier`);
  return id;
}

/**
 * What `zap` removes: what macOS and the app's shell keep under ~/Library, named by the bundle identifier. Never
 * `~/.retake` (the Retake home): the person's signed-in profiles, approval key and settings live there, and their
 * projects in their own workspace folders — an uninstall, even a zap, leaves them.
 */
export function zapPaths(id) {
  return [
    `~/Library/Application Support/${id}`,
    `~/Library/Caches/${id}`,
    `~/Library/Cookies/${id}.binarycookies`,
    `~/Library/HTTPStorages/${id}`,
    `~/Library/HTTPStorages/${id}.binarycookies`,
    `~/Library/Preferences/${id}.plist`,
    `~/Library/Saved Application State/${id}.savedState`,
    `~/Library/WebKit/${id}`,
  ];
}

/** Where the release lives: `{ server, repository }` from the run's context (GITHUB_SERVER_URL, GITHUB_REPOSITORY). */
export function releaseLocation(env = process.env) {
  let loc;
  try {
    loc = feedLocation(env);
  } catch (e) {
    throw new CaskError(e.message);
  }
  if (!ORIGIN_RE.test(loc.server)) throw new CaskError(`GITHUB_SERVER_URL "${loc.server}" is not an https origin (no path)`);
  if (!REPOSITORY_RE.test(loc.repository)) throw new CaskError(`GITHUB_REPOSITORY "${loc.repository}" is not <owner>/<repo>`);
  return loc;
}

function safe(value, what) {
  if (typeof value !== 'string' || !RUBY_SAFE.test(value)) throw new CaskError(`${what} "${value}" cannot be written into a cask`);
  return value;
}

/**
 * One cask: its file name and its Ruby. `beta`: the `retake@beta` cask (every version), else `retake` (stable versions
 * only — a pre-release is refused). `autoUpdates`: the build has the updater (true / false, required).
 */
export function buildCask({ version, sha256, beta = String(version).includes('-'), location, id, autoUpdates }) {
  if (typeof autoUpdates !== 'boolean') throw new CaskError('whether the build updates itself is not given (--updates on|off)');
  if (typeof version !== 'string' || !VERSION_RE.test(version) || version.length > 64) throw new CaskError(`"${version}" is not a version (major.minor.patch, an optional -pre-release, no leading v)`);
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) throw new CaskError(`"${sha256}" is not a sha256 (64 lower-case hex digits)`);
  if (version.includes('-') && !beta) throw new CaskError(`${version} is a pre-release: only ${BETA_TOKEN} follows it`);
  if (!location || !ORIGIN_RE.test(location.server ?? '') || !REPOSITORY_RE.test(location.repository ?? '')) throw new CaskError('no release location (GITHUB_SERVER_URL, GITHUB_REPOSITORY)');
  if (typeof id !== 'string' || !BUNDLE_ID_RE.test(id)) throw new CaskError(`"${id}" is not a bundle identifier`);
  const token = beta ? BETA_TOKEN : TOKEN;
  const other = beta ? TOKEN : BETA_TOKEN;
  const homepage = safe(`${location.server}/${location.repository}`, 'The homepage');
  // The DMG's name with the version replaced by Homebrew's own interpolation (dmgName is the release's own name).
  const dmg = safe(dmgName('0.0.0'), 'The DMG\'s name').replace('0.0.0', '#{version}');
  safe(version, 'The version');
  // The stable cask follows GitHub's latest release (never a pre-release — nor the update-feed release, a pre-release);
  // the beta one every release whose tag is a version, pre-releases included: Homebrew's github_releases strategy skips
  // pre-releases by itself, so a block keeps them (drafts only skipped; `update-feed` never matches the regex).
  const livecheck = beta
    ? [
        '  livecheck do',
        '    url :url',
        '    regex(/^v?(\\d+(?:\\.\\d+)+(?:-[0-9A-Za-z.-]+)?)$/i)',
        '    strategy :github_releases do |json, regex|',
        '      json.map do |release|',
        '        next if release["draft"]',
        '',
        '        match = release["tag_name"]&.match(regex)',
        '        next if match.blank?',
        '',
        '        match[1]',
        '      end',
        '    end',
        '  end',
      ]
    : ['  livecheck do', '    url :url', '    strategy :github_latest', '  end'];
  const content = [
    `cask "${token}" do`,
    `  version "${version}"`,
    `  sha256 "${sha256}"`,
    '',
    `  url "${homepage}/releases/download/v#{version}/${dmg}"`,
    '  name "Retake"',
    '  desc "Product videos of web apps, written as scenarios and edited automatically"',
    `  homepage "${homepage}"`,
    '',
    ...livecheck,
    '',
    // A build with the updater updates itself (its own signed feed): `brew upgrade` then leaves it unless --greedy.
    ...(autoUpdates ? ['  auto_updates true'] : []),
    `  conflicts_with cask: "${other}"`,
    // macOS 15 or later (a symbol means "this version or later" in the cask DSL; the string form is deprecated).
    '  depends_on macos: :sequoia',
    '  depends_on arch: :arm64',
    '',
    '  app "Retake.app"',
    // The command: Homebrew's link to the launcher inside the app (it resolves links: the app is found from it).
    '  binary "#{appdir}/Retake.app/Contents/Resources/bin/retake"',
    '',
    // Quit a running app before an uninstall or a --greedy upgrade replaces it.
    `  uninstall quit: "${id}"`,
    '',
    '  # ~/.retake is kept on purpose: the signed-in profiles, the approval key and the settings live there.',
    '  zap trash: [',
    ...zapPaths(id).map((p) => `    "${p}",`),
    '  ]',
    'end',
    '',
  ].join('\n');
  return { file: `${token}.rb`, content };
}

/** The casks a version writes: both for a stable version, the beta one alone for a pre-release. */
export function buildCasks({ version, sha256, location, id, autoUpdates }) {
  const beta = buildCask({ version, sha256, beta: true, location, id, autoUpdates });
  return String(version).includes('-') ? [beta] : [buildCask({ version, sha256, beta: false, location, id, autoUpdates }), beta];
}

/** The version a cask names (its `version "…"` line), or null. */
export function caskVersion(content) {
  return /^\s*version "([^"\n]+)"/m.exec(content ?? '')?.[1] ?? null;
}

/** The DMG's sha256 from a SHA256SUMS file (`shasum -a 256` lines): exactly one line naming `dmg`. */
export function dmgSha256(sums, dmg) {
  const found = String(sums ?? '').split('\n').map((l) => /^([0-9a-f]{64}) [ *](.+)$/.exec(l.replace(/\r$/, ''))).filter((m) => m && m[2] === dmg);
  if (found.length !== 1) throw new CaskError(`expected one line for ${dmg} in SHA256SUMS-macos.txt, found ${found.length}`);
  return found[0][1];
}

/**
 * Write the casks of `version` into `tap` (its `Casks/` folder, created when missing). Returns, per file, `written`,
 * `unchanged` or `kept <version>` (a newer version already there).
 */
export function writeCasks({ version, sha256, tap, autoUpdates, env = process.env, repo = REPO }) {
  const location = releaseLocation(env);
  const id = bundleId(repo);
  const casks = buildCasks({ version, sha256, location, id, autoUpdates });
  const dir = join(tap, 'Casks');
  mkdirSync(dir, { recursive: true });
  const result = {};
  for (const { file, content } of casks) {
    const path = join(dir, file);
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (before !== null) {
      const current = caskVersion(before);
      if (!current || !VERSION_RE.test(current) || current.length > 64) throw new CaskError(`Casks/${file} names no version this script can read ("${current ?? ''}"): left alone — fix it by hand`);
      if (compareVersions(version, current) < 0) {
        result[file] = `kept ${current}`;
        continue;
      }
      if (before === content) {
        result[file] = 'unchanged';
        continue;
      }
    }
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, content);
    renameSync(temp, path);
    result[file] = 'written';
  }
  return result;
}

/** The command line: `<tag> (--sha256 <hex> | --sums <file>) --updates on|off --tap <dir>`. */
export function parseArgs(argv) {
  const [tag, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (!['--sha256', '--sums', '--updates', '--tap'].includes(flag) || !value || o[flag.slice(2)] !== undefined) throw new CaskError(`unknown or repeated argument "${flag ?? ''}"`);
    o[flag.slice(2)] = value;
  }
  if (!/^v/.test(tag ?? '') || !VERSION_RE.test(tag.slice(1))) throw new CaskError(`"${tag ?? ''}" is not a release tag (v<version>)`);
  if (!o.tap || (o.sha256 === undefined) === (o.sums === undefined) || !['on', 'off'].includes(o.updates)) throw new CaskError('usage: homebrew-cask.mjs <tag> (--sha256 <hex> | --sums <SHA256SUMS-macos.txt>) --updates on|off --tap <dir>');
  return { version: tag.slice(1), ...o, autoUpdates: o.updates === 'on' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const sha256 = a.sha256 ?? dmgSha256(readFileSync(a.sums, 'utf8'), dmgName(a.version));
    const result = writeCasks({ version: a.version, sha256, tap: a.tap, autoUpdates: a.autoUpdates });
    for (const [file, what] of Object.entries(result)) process.stdout.write(`Casks/${file}: ${what === 'written' ? `${a.version}` : what === 'unchanged' ? `${a.version}, unchanged` : `${what.slice(5)} kept (this is ${a.version})`}\n`);
  } catch (e) {
    process.stderr.write(`homebrew-cask: ${e instanceof CaskError ? e.message : e?.stack ?? e}\n`);
    process.exit(1);
  }
}
