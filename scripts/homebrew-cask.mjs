#!/usr/bin/env node
/**
 * The Homebrew casks of a release (.github/workflows/release.yml › publish, docs/RELEASING.md › The Homebrew tap) —
 * plain Node, no dependency, no network:
 *
 *   node scripts/homebrew-cask.mjs tap        the tap's place, from the run's own context (GITHUB_SERVER_URL,
 *                                             GITHUB_REPOSITORY): `remote=` (`git@<host>:<owner>/homebrew-tap.git`,
 *                                             Homebrew's name for `<owner>/tap`), `known_host=` (the host's published
 *                                             SSH key, pinned) and the commit's `author=` / `email=` (for $GITHUB_OUTPUT)
 *   node scripts/homebrew-cask.mjs sha256 <SHA256SUMS file> <dmg>
 *                                             `sha256=<hex>`: the DMG's line of the release's sums, exactly one
 *   node scripts/homebrew-cask.mjs write <version> --dmg <name> --sha256 <hex> --tap <folder> [--homepage <url>]
 *                                             writes the version's casks into <folder>/Casks: `retake.rb` follows the
 *                                             stable versions, `retake@beta.rb` every version (release candidates and
 *                                             stable ones, so it is never behind `retake`); a cask is never moved back
 *                                             to an older version (a re-run of an old tag leaves it alone)
 *
 * Both casks install the release's DMG (Apple silicon, the app's minimum macOS) from this repository's releases, link
 * the `retake` command inside the app, and leave the updates to the app (auto_updates).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAUNCHER, MINIMUM_MACOS, PRODUCT } from '../apps/desktop/scripts/bundle.mjs';
import { compareVersions, parseVersion } from './publish-update.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The app's bundle identifier (tauri.conf.json): the folders macOS keeps for it, which `zap` removes. */
export const IDENTIFIER = JSON.parse(readFileSync(join(REPO, 'apps', 'desktop', 'tauri.conf.json'), 'utf8')).identifier;
export const DESCRIPTION = 'Product videos of a web app from a written scenario, with an MCP server for agents';
/** GitHub's published SSH host key (ed25519; `gh api meta --jq .ssh_keys`), pinned rather than trusted on first use. */
export const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
/** The account GitHub Actions commits as (its noreply address is on the server's host). */
const BOT = { name: 'github-actions[bot]', id: 41898282 };
/** Homebrew's names of the macOS versions a cask may require (`depends_on macos:`). */
const MACOS_NAMES = { 14: 'sonoma', 15: 'sequoia', 26: 'tahoe' };
const TOKEN = PRODUCT.toLowerCase();

export class CaskError extends Error {}

/** The server and repository of the run (`GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`: GitHub Actions sets both). */
export function location(env = process.env) {
  const server = (env.GITHUB_SERVER_URL?.trim() ?? '').replace(/\/+$/, '');
  const repository = env.GITHUB_REPOSITORY?.trim() ?? '';
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(server)) throw new CaskError(`GITHUB_SERVER_URL is not an https origin: "${server}"`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new CaskError(repository ? `GITHUB_REPOSITORY is not <owner>/<repo>: "${repository}"` : 'GITHUB_REPOSITORY is not set');
  return { server, repository, host: new URL(server).host, owner: repository.split('/')[0] };
}

/** The tap's remote, its host's pinned key (a known_hosts line) and the commit's author: `{ remote, known_host, author, email }`. */
export function tapPlace(env = process.env) {
  const { host, owner } = location(env);
  return { remote: `git@${host}:${owner}/homebrew-tap.git`, known_host: `${host} ${HOST_KEY}`, author: BOT.name, email: `${BOT.id}+${BOT.name}@users.noreply.${host}` };
}

/** The sha256 of `dmg` in a `shasum -a 256` listing: exactly one line names it. */
export function dmgSha256(sums, dmg) {
  const lines = String(sums ?? '').split('\n').map((l) => /^([0-9a-f]{64}) [ *](.+)$/.exec(l.trim())).filter((m) => m && m[2] === dmg);
  if (lines.length !== 1) throw new CaskError(`the sums name ${dmg} ${lines.length ? `${lines.length} times` : 'nowhere'}: one line expected`);
  return lines[0][1];
}

/** The `depends_on macos:` of the app's minimum macOS (bundle.mjs MINIMUM_MACOS: `15.0` → `>= :sequoia`). */
export function macosRequirement(minimum = MINIMUM_MACOS) {
  const name = MACOS_NAMES[Number(String(minimum).split('.')[0])];
  if (!name) throw new CaskError(`no Homebrew name known for macOS ${minimum}: add it to MACOS_NAMES`);
  return `>= :${name}`;
}

/**
 * One cask: `{ file, content }`, `retake@beta` when `beta`, else `retake` (stable versions only). `dmg` is the release's
 * disk image, whose name carries the version (written `#{version}` in the cask's url); `homepage` defaults to the
 * repository's page.
 */
export function buildCask({ version, dmg, sha256, beta, server, repository, homepage }) {
  if (!parseVersion(version)) throw new CaskError(`"${version}" is not a version (no leading v)`);
  if (!/^[0-9a-f]{64}$/.test(String(sha256 ?? ''))) throw new CaskError(`"${sha256}" is not a sha256 (64 lowercase hex digits)`);
  if (version.includes('-') && !beta) throw new CaskError(`${version} is a pre-release: only ${TOKEN}@beta follows it`);
  const name = String(dmg ?? '');
  if (!/^[\w.-]+\.dmg$/.test(name) || !name.includes(version)) throw new CaskError(`"${name}" is not a disk image named with ${version}`);
  const page = homepage?.trim() || `${server}/${repository}`;
  if (!/^https:\/\/[^\s"#\\]+$/.test(page)) throw new CaskError(`the homepage is not an https address: "${page}"`);
  const token = beta ? `${TOKEN}@beta` : TOKEN;
  const other = beta ? TOKEN : `${TOKEN}@beta`;
  // The beta looks among every release (pre-releases too); the stable cask at the latest one.
  const livecheck = beta
    ? `  livecheck do
    url :url
    regex(/^v?(\\d+(?:\\.\\d+)+(?:-[0-9A-Za-z.-]+)?)$/i)
    strategy :github_releases
  end`
    : `  livecheck do
    url :url
    strategy :github_latest
  end`;
  const content = `cask "${token}" do
  version "${version}"
  sha256 "${sha256}"

  url "${server}/${repository}/releases/download/v#{version}/${name.split(version).join('#{version}')}"
  name "${PRODUCT}"
  desc "${DESCRIPTION}"
  homepage "${page}"

${livecheck}

  auto_updates true
  conflicts_with cask: "${other}"
  depends_on arch: :arm64
  depends_on macos: "${macosRequirement()}"

  app "${PRODUCT}.app"
  binary "#{appdir}/${PRODUCT}.app/Contents/Resources/${LAUNCHER}"

  zap trash: [
    "~/Library/Caches/${IDENTIFIER}",
    "~/Library/Preferences/${IDENTIFIER}.plist",
    "~/Library/Saved Application State/${IDENTIFIER}.savedState",
    "~/Library/WebKit/${IDENTIFIER}",
  ]
end
`;
  return { file: `${token}.rb`, content };
}

/** The casks a version updates: both for a stable version, the beta alone for a pre-release. */
export function buildCasks(opts) {
  const beta = buildCask({ ...opts, beta: true });
  return opts.version.includes('-') ? [beta] : [buildCask({ ...opts, beta: false }), beta];
}

/** The version a cask's content names, or null. */
export function caskVersion(content) {
  return /^\s*version "([^"]+)"/m.exec(content ?? '')?.[1] ?? null;
}

/** Writes the version's casks into `<tap>/Casks`, none moved back; returns one line per cask (written or kept). */
export function writeCasks({ tap, ...opts }) {
  const casks = buildCasks(opts);
  mkdirSync(join(tap, 'Casks'), { recursive: true });
  return casks.map(({ file, content }) => {
    const path = join(tap, 'Casks', file);
    const current = existsSync(path) ? caskVersion(readFileSync(path, 'utf8')) : null;
    if (current && parseVersion(current) && compareVersions(opts.version, current) < 0) return `Casks/${file} is at ${current}: left alone (this is ${opts.version})`;
    writeFileSync(path, content);
    return `Casks/${file} → ${opts.version}`;
  });
}

/** `write`'s flags: --dmg, --sha256, --tap (required), --homepage (may be empty). */
export function parseWriteFlags(rest) {
  const out = {};
  const known = { '--dmg': 'dmg', '--sha256': 'sha256', '--tap': 'tap', '--homepage': 'homepage' };
  for (let i = 0; i < rest.length; i += 2) {
    const key = known[rest[i]];
    if (!key || rest[i + 1] === undefined || key in out) throw new CaskError(`unknown or repeated argument "${rest[i]}" (--dmg, --sha256, --tap, --homepage)`);
    out[key] = rest[i + 1];
  }
  for (const k of ['dmg', 'sha256', 'tap']) if (!out[k]) throw new CaskError(`--${k} is required`);
  return out;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'tap' && !rest.length) {
      process.stdout.write(Object.entries(tapPlace()).map(([k, v]) => `${k}=${v}\n`).join(''));
    } else if (command === 'sha256' && rest.length === 2) {
      process.stdout.write(`sha256=${dmgSha256(readFileSync(rest[0], 'utf8'), rest[1])}\n`);
    } else if (command === 'write' && rest.length) {
      const [version, ...flags] = rest;
      const { server, repository } = location();
      for (const line of writeCasks({ version, server, repository, ...parseWriteFlags(flags) })) process.stdout.write(`${line}\n`);
    } else {
      throw new CaskError('usage: homebrew-cask.mjs tap | sha256 <sums file> <dmg> | write <version> --dmg <name> --sha256 <hex> --tap <folder> [--homepage <url>]');
    }
  } catch (e) {
    process.stderr.write(`homebrew-cask: ${e instanceof CaskError || e?.name === 'PublishError' ? e.message : e?.stack ?? e}\n`);
    process.exit(1);
  }
}
