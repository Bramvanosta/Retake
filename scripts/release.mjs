#!/usr/bin/env node
/**
 * The release workflow's helpers (L5.16e: .github/workflows/release.yml, docs/RELEASING.md) — plain Node, no
 * dependency, no network, nothing written:
 *
 *   node scripts/release.mjs tag <tag>        the tag is the repository's version: every version file agrees
 *                                             (scripts/set-version.mjs) and the tag is `v<version>`; prints
 *                                             `version=<version>` and `prerelease=true|false` (for $GITHUB_OUTPUT)
 *   node scripts/release.mjs notes <version> [--signed true|false] [--updates on|off]
 *                                             the GitHub release's notes (Markdown): the CHANGELOG paragraph
 *                                             (publish-update's extractNotes), how to install, what this build is
 *   node scripts/release.mjs feed <version>   the feed an app of <version> reads, as publish-update.mjs expects it
 *                                             (L5.16f: a GitHub release of this repository):
 *                                             <GITHUB_SERVER_URL>/<GITHUB_REPOSITORY>/releases/download/update-feed/
 *                                             <latest.json | rc.json> — from the workflow's own context, never committed
 *   node scripts/release.mjs preflight <version> --output <file>
 *                                             what this release is made with (review e B-M1): each set of secrets
 *                                             and variables all or nothing (CONFIG_SETS) — appends signed, updates
 *                                             (+ feed, pubkey) to <file> ($GITHUB_OUTPUT), says each part that is off,
 *                                             fails naming what a partial set lacks
 *   node scripts/release.mjs files <version>  the names of the files a release attaches (dmg=, archive=, signature=:
 *                                             bundle.mjs's own names)
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRODUCT, UPDATE_ARCHIVE } from '../apps/desktop/scripts/bundle.mjs';
import { MinisignError, PublishError, decodePublicKey, extractNotes, feedLocation, feedUrl, isPublic } from './publish-update.mjs';
import { VERSION_RE, readVersions } from './set-version.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The disk image bundle.mjs makes (Apple silicon only for now: BACKLOG BL-139). */
export const dmgName = (version) => `${PRODUCT}_${version}_aarch64.dmg`;
/** The files a release attaches besides SHA256SUMS-macos.txt: the DMG, and the update archive with its signature. */
export const releaseFiles = (version) => ({ dmg: dmgName(version), archive: UPDATE_ARCHIVE, signature: `${UPDATE_ARCHIVE}.sig` });

/**
 * What a release can be made with (review e B-M1), as two sets — each all or nothing: none of a set → that part is
 * off (said); some → the run fails before anything is built, naming what is missing. Each name is a secret (of the
 * `release` environment) or a variable. The update's publication needs nothing more (L5.16f): the feed is a release of
 * this repository, written with the workflow's own job token.
 */
export const CONFIG_SETS = {
  apple: {
    what: 'A Developer ID build, notarised',
    names: {
      APPLE_CERTIFICATE: 'secret',
      APPLE_CERTIFICATE_PASSWORD: 'secret',
      APPLE_SIGNING_IDENTITY: 'secret',
      APPLE_TEAM_ID: 'secret',
      APPLE_API_KEY: 'secret',
      APPLE_API_ISSUER: 'secret',
      APPLE_API_KEY_P8: 'secret',
    },
    off: 'No Apple signing set: an ad hoc build, not notarised (Gatekeeper asks for Open Anyway) — docs/RELEASING.md',
  },
  updater: {
    what: 'An app that updates itself',
    names: { TAURI_SIGNING_PRIVATE_KEY: 'secret', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'secret', RETAKE_UPDATE_PUBKEY: 'variable' },
    off: 'Updates are off in this build: the updater needs the TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD secrets and the RETAKE_UPDATE_PUBKEY variable — docs/RELEASING.md',
  },
};

/**
 * The preflight's verdict from what the workflow can see (`env`): a secret's presence as HAS_SECRET_<NAME>=true|false
 * (`secrets.<NAME> != ''`: never its value), a variable's value as <NAME>; and each name in the other store
 * (HAS_VAR_<NAME> for a secret's name, HAS_SECRET_<NAME> for a variable's) — "a variable, not a secret" is said; with the
 * updater, REPO_PRIVATE / REPO_VISIBILITY (the repository as the API describes it, read with the job token): an app that
 * updates itself needs a public repository (review f A-L3) — refused here, not after the release is public.
 * Returns `{ outputs, warnings, errors }`.
 */
export function preflight(version, env = process.env) {
  const has = (n, kind) => (kind === 'secret' ? env[`HAS_SECRET_${n}`] === 'true' : !!env[n]?.trim());
  const elsewhere = (n, kind) => (kind === 'secret' ? env[`HAS_VAR_${n}`] === 'true' : env[`HAS_SECRET_${n}`] === 'true');
  const on = {};
  const warnings = [];
  const errors = [];
  for (const [set, { what, names, off }] of Object.entries(CONFIG_SETS)) {
    const all = Object.entries(names);
    const missing = all.filter(([n, k]) => !has(n, k));
    const misplaced = missing.filter(([n, k]) => elsewhere(n, k));
    on[set] = missing.length === 0;
    if (on[set]) continue;
    if (missing.length === all.length && !misplaced.length) {
      warnings.push(off);
      continue;
    }
    const why = missing.map(([n, k]) => `${n} (${elsewhere(n, k) ? `set as a ${k === 'secret' ? 'variable' : 'secret'}: it must be a ${k}` : `a ${k}, not set`})`);
    errors.push(`${what} needs all of ${all.map(([n]) => n).join(', ')} — or none: missing ${why.join(', ')}`);
  }
  const outputs = { signed: String(on.apple), updates: on.updater ? 'on' : 'off' };
  if (on.updater) {
    try {
      outputs.feed = feedFor(version, env);
    } catch (e) {
      errors.push(`The update feed: ${e.message}`);
    }
    const repo = { private: env.REPO_PRIVATE === 'false' ? false : env.REPO_PRIVATE === 'true' ? true : undefined, visibility: env.REPO_VISIBILITY?.trim() || undefined };
    if (!isPublic(repo)) {
      const seen = env.REPO_PRIVATE?.trim() ? `private: ${env.REPO_PRIVATE.trim()}, visibility: ${env.REPO_VISIBILITY?.trim() || '?'}` : 'its visibility unknown';
      errors.push(
        `The update feed: the repository is not public (${seen}) — an installed app downloads its updates with no credentials: make the repository public, or remove the updater set (an app without updates)`,
      );
    }
    const pub = env.RETAKE_UPDATE_PUBKEY.trim();
    try {
      if (/\s/.test(pub)) throw new MinisignError('one line of base64 expected');
      decodePublicKey(pub);
      outputs.pubkey = pub;
    } catch (e) {
      errors.push(`RETAKE_UPDATE_PUBKEY is not a public key (the content of the .pub file \`tauri signer generate\` wrote): ${e.message}`);
    }
  }
  return { outputs, warnings, errors };
}

export class ReleaseError extends Error {}

/**
 * The version a release tag stands for: `tag` is `v<version>` and every file that carries the version agrees on it
 * (`versions`: set-version's readVersions). Returns {version, prerelease}; ReleaseError otherwise.
 */
export function tagVersion(tag, versions = readVersions(REPO)) {
  const t = String(tag ?? '');
  if (!t.startsWith('v') || !VERSION_RE.test(t.slice(1))) throw new ReleaseError(`"${t}" is not a release tag (v<major>.<minor>.<patch>, an optional -pre-release: v0.2.1, v0.3.0-rc.1)`);
  const version = t.slice(1);
  const want = versions[0]?.version;
  const off = versions.filter((f) => f.version !== want);
  if (off.length)
    throw new ReleaseError(
      `the repository's version files disagree (${off.map((f) => `${f.path}: ${f.version}`).join(', ')}; package.json: ${want}): node scripts/set-version.mjs <version>, commit, tag that commit`,
    );
  if (want !== version) throw new ReleaseError(`the tag ${t} is not the repository's version (${want}): node scripts/set-version.mjs ${version}, commit on main, then tag that commit`);
  return { version, prerelease: version.includes('-') };
}

/**
 * The release's notes. `signed` / `updates` describe the build (the `attach` job knows them; the draft made before it
 * says the build is coming): signed = a Developer ID and notarisation, updates = an app with the updater.
 */
export function releaseNotes(version, { signed, updates, changelog = join(REPO, 'CHANGELOG.md'), env = process.env } = {}) {
  const summary = existsSync(changelog) ? extractNotes(readFileSync(changelog, 'utf8'), version) : null;
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const changes = server && repo ? `[CHANGELOG.md](${server}/${repo}/blob/v${version}/CHANGELOG.md)` : 'CHANGELOG.md';
  const lines = [summary ?? `Retake ${version}`, '', '## Install', ''];
  lines.push(`1. macOS 15 or later, Apple silicon: open \`${dmgName(version)}\` and drag **Retake** onto **Applications**, then open it from Applications.`);
  lines.push('2. The `retake` command: Help › Set Up Retake… › Command line › Install (it links `~/.local/bin/retake` to the app).');
  lines.push('');
  if (signed === true) lines.push('Signed with a Developer ID and notarised by Apple: it opens without a warning.', '');
  else if (signed === false)
    lines.push('**Not notarised**: this build is signed ad hoc. macOS refuses its first open — try to open it once, then System Settings › Privacy & Security › **Open Anyway**.', '');
  else lines.push("_The macOS build is attached when the release workflow's `attach` job ends._", '');
  if (updates === 'on') lines.push('It updates itself: a check at launch, Help › Check for Updates… any time.', '');
  else if (updates === 'off') lines.push('Updates are off in this build: install the next version from its release.', '');
  lines.push(`Each file's SHA-256 is in \`SHA256SUMS-macos.txt\`. What changed: ${changes}.`);
  return `${lines.join('\n')}\n`;
}

/**
 * The feed an app of `version` reads — exactly what publish-update.mjs accepts as RETAKE_UPDATE_FEED for it: the
 * channel's file on this repository's `update-feed` release (GITHUB_REPOSITORY, GITHUB_SERVER_URL or GitHub's own — the
 * workflow's own context).
 */
export function feedFor(version, env = process.env) {
  if (!VERSION_RE.test(String(version ?? ''))) throw new ReleaseError(`"${version}" is not a version (no leading v)`);
  return feedUrl(version, feedLocation(env));
}

/** The command line's flags after the positional argument: `--signed true|false`, `--updates on|off`. */
export function parseNotesFlags(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === '--signed' && (value === 'true' || value === 'false')) out.signed = value === 'true';
    else if (flag === '--updates' && (value === 'on' || value === 'off')) out.updates = value;
    else throw new ReleaseError(`unknown argument "${flag} ${value ?? ''}" (--signed true|false, --updates on|off)`);
  }
  return out;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, arg, ...rest] = process.argv.slice(2);
  try {
    if (command === 'tag') {
      const { version, prerelease } = tagVersion(arg);
      process.stdout.write(`version=${version}\nprerelease=${prerelease}\n`);
    } else if (command === 'notes') {
      if (!VERSION_RE.test(String(arg ?? ''))) throw new ReleaseError(`"${arg}" is not a version (no leading v)`);
      process.stdout.write(releaseNotes(arg, parseNotesFlags(rest)));
    } else if (command === 'feed') {
      process.stdout.write(`${feedFor(arg)}\n`);
    } else if (command === 'preflight') {
      if (!VERSION_RE.test(String(arg ?? ''))) throw new ReleaseError(`"${arg}" is not a version (no leading v)`);
      if (rest[0] !== '--output' || !rest[1] || rest.length !== 2) throw new ReleaseError('preflight <version> --output <file> ($GITHUB_OUTPUT)');
      const { outputs, warnings, errors } = preflight(arg);
      // Workflow commands on stdout: GitHub shows each as an annotation of the run.
      for (const w of warnings) process.stdout.write(`::warning::${w}\n`);
      for (const e of errors) process.stdout.write(`::error::${e}\n`);
      if (errors.length) process.exit(1);
      appendFileSync(
        rest[1],
        Object.entries(outputs)
          .map(([k, v]) => `${k}=${v}\n`)
          .join(''),
      );
      process.stdout.write(`signed=${outputs.signed} updates=${outputs.updates}\n`);
    } else if (command === 'files') {
      if (!VERSION_RE.test(String(arg ?? ''))) throw new ReleaseError(`"${arg}" is not a version (no leading v)`);
      process.stdout.write(
        Object.entries(releaseFiles(arg))
          .map(([k, v]) => `${k}=${v}\n`)
          .join(''),
      );
    } else {
      throw new ReleaseError('usage: release.mjs tag <tag> | notes <version> [--signed true|false] [--updates on|off] | feed <version> | preflight <version> --output <file> | files <version>');
    }
  } catch (e) {
    process.stderr.write(`release: ${e instanceof ReleaseError || e instanceof PublishError ? e.message : (e?.stack ?? e)}\n`);
    process.exit(1);
  }
}
