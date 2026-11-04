#!/usr/bin/env node
/**
 * Publish one signed update of the macOS app to the person's own update host (L5.16d, DESIGN §4p (d), README
 * "Releasing"), then rebuild the feed the installed apps read.
 *
 *   node scripts/publish-update.mjs 0.2.1 --artifact <dir>/Retake.app.tar.gz --signature <dir>/Retake.app.tar.gz.sig \
 *     [--platforms darwin-aarch64] [--notes notes.txt] [--force]
 *
 * The host is a static folder: a web server that accepts an authenticated PUT, and answers an authenticated GET of the
 * upload address with the file or 404 when it is missing (any other answer stops the publish — an upload-only endpoint,
 * or a bucket that answers 403 for a missing key, cannot be published to):
 *
 *   <app>/v<version>/<archive>                 the signed archive the updater downloads
 *   <app>/v<version>/platforms/<platform>.json {signature, url}: one per platform
 *   <app>/rc.json                              the feed of the newest version, pre-release or not
 *   <app>/latest.json                          the feed of the newest stable version
 *
 * - Nothing is uploaded before the archive's signature is checked here, in Node, against the public key the apps carry
 *   (RETAKE_UPDATE_PUBKEY, the value given to `pnpm desktop:bundle`): minisign, Ed25519 over the BLAKE2b-512 hash of
 *   the file, the global signature over the trusted comment, and the comment's `version:` equal to the version
 *   published (the apps are built with `requireSignedVersion`: a signature without it would be refused by every app).
 * - The feed is never edited: it is rebuilt from the platform files present for that version, so a re-run heals a feed
 *   that lost a race. A channel never goes back: a feed already at a newer version is left alone.
 * - A version already published with OTHER bits (its platform file names another signature) is never replaced without
 *   `--force` (apps downloading meanwhile would get a mismatch); the same bits again (a re-run) heal the feed.
 * - Platforms: darwin-aarch64 only for now (the archive is the Apple-silicon app: SUPPORTED_PLATFORMS).
 * - The channel follows the version: a pre-release goes to rc.json only, a stable version to both; RETAKE_UPDATE_FEED,
 *   when set (the feed the apps were built with), must be this version's channel at UPDATES_PUBLIC_URL.
 * - Release notes (plain text: the app shows them as text): `--notes <file>`, else the summary paragraph of the
 *   version's section of CHANGELOG.md (`## [0.2.1]` up to its first `###`), else the lead of each bullet, else
 *   "Retake <version>".
 * - Environment, all required, nothing defaulted to a host: UPDATES_UPLOAD_TOKEN (a bearer token for the PUTs),
 *   UPDATES_UPLOAD_URL (where to write) and UPDATES_PUBLIC_URL (what the apps download from), both https, no user,
 *   query or fragment; UPDATES_APP (the folder, default `retake`).
 *
 * Tests never upload anywhere: they hand `publish()` a fetch bound to a local server.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every key a Tauri updater may look up in a feed; the feed lists those present for the version. */
export const KNOWN_PLATFORMS = ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'linux-aarch64', 'windows-x86_64'];
export const DEFAULT_PLATFORMS = ['darwin-aarch64'];
/** What an archive of this repository can be for (review d A-L8): the macOS app on Apple silicon only, for now. */
export const SUPPORTED_PLATFORMS = ['darwin-aarch64'];
export const DEFAULT_APP = 'retake';

export class PublishError extends Error {}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** `major.minor.patch[-pre]` (no leading v) → its parts, or null. */
export function parseVersion(text) {
  const m = VERSION_RE.exec(typeof text === 'string' ? text : '');
  if (!m || text.length > 64) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: < 0 when a is older than b; a pre-release is older than its release. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new PublishError(`cannot compare the versions "${a}" and "${b}"`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const plain = (t) => t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');

/**
 * The notes of `version` in a CHANGELOG (Keep a Changelog headings, `## [0.2.1] — date` or `## [v0.2.1]`): the summary
 * paragraph (what stands between the heading and its first `###`), plain text; without one the lead of each bullet
 * (its bold sentence, else its first clause), `max` of them; null when the version has no section.
 */
export function extractNotes(changelog, version, max = 8) {
  const lines = String(changelog ?? '').split('\n');
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((l) => new RegExp(`^## \\[v?${esc}\\]`).test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## \[/.test(l));
  const body = end < 0 ? rest : rest.slice(0, end);
  const firstHeading = body.findIndex((l) => /^### /.test(l));
  const summary = (firstHeading < 0 ? body : body.slice(0, firstHeading)).join('\n').trim();
  if (summary && !summary.startsWith('- ')) return plain(summary);
  const leads = body
    .filter((l) => /^- /.test(l))
    .map((l) => /^- \*\*(.+?)\*\*/.exec(l)?.[1] ?? l.slice(2).split(/(?<=[.:;])\s/)[0])
    .map((lead) => `• ${plain(lead).replace(/[.:;]$/, '')}`);
  if (!leads.length) return null;
  return leads.slice(0, max).join('\n') + (leads.length > max ? `\n… and ${leads.length - max} more` : '');
}

/** The static JSON a Tauri v2 updater reads. */
export function buildManifest({ version, notes, pubDate, platforms }) {
  return { version, notes, pub_date: pubDate, platforms };
}

/** An https URL with no user, query or fragment, its trailing slashes removed; else a PublishError naming `what`. */
export function checkUrl(value, what) {
  let u;
  try {
    u = new URL(String(value ?? ''));
  } catch {
    throw new PublishError(`${what} is not a URL (an https address of your update host)`);
  }
  if (u.protocol !== 'https:') throw new PublishError(`${what} must be https (it is ${u.protocol.replace(':', '')})`);
  if (u.username || u.password || u.search || u.hash) throw new PublishError(`${what} must not carry a user, a query or a fragment`);
  return u.href.replace(/\/+$/, '');
}

// ---- minisign (the format of `tauri signer`) ----------------------------------------------------------------------

export class MinisignError extends Error {}

/** A base64 field of a Tauri key or signature: the text it holds (two or four minisign lines). */
function unwrap(b64, what) {
  const text = Buffer.from(String(b64 ?? '').trim(), 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment:')) throw new MinisignError(`${what} is not a minisign ${what} (base64 of its text, as tauri signer writes it)`);
  return text.split('\n').map((l) => l.replace(/\r$/, ''));
}

/** A Tauri public key (RETAKE_UPDATE_PUBKEY) → its key id and Ed25519 key; MinisignError otherwise. */
export function decodePublicKey(b64) {
  const lines = unwrap(b64, 'public key');
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new MinisignError('the public key is not an Ed25519 minisign key');
  return { keyId: raw.subarray(2, 10), key: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.subarray(10).toString('base64url') }, format: 'jwk' }) };
}

/** A `.sig` file's content → its parts; MinisignError otherwise. */
export function decodeSignature(b64) {
  const lines = unwrap(b64, 'signature');
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  const alg = raw.subarray(0, 2).toString('latin1');
  if (raw.length !== 74 || (alg !== 'ED' && alg !== 'Ed')) throw new MinisignError('the signature is not an Ed25519 minisign signature');
  const tc = lines[2] ?? '';
  if (!tc.startsWith('trusted comment: ')) throw new MinisignError('the signature has no trusted comment');
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (global.length !== 64) throw new MinisignError('the signature has no global signature');
  return { prehashed: alg === 'ED', keyId: raw.subarray(2, 10), sig: raw.subarray(10), trusted: tc.slice('trusted comment: '.length), global };
}

/** The `version:` field of a trusted comment (tab-separated key:value pairs), or null. */
export function signedVersion(trusted) {
  for (const f of String(trusted).split('\t')) if (f.startsWith('version:')) return f.slice('version:'.length);
  return null;
}

/**
 * Check `data` against a `.sig` (`signatureB64`) and a public key (`pubkeyB64`) as the updater does: the key ids
 * match, Ed25519 over the BLAKE2b-512 hash of the data (or the data itself for a legacy `Ed` signature), the global
 * signature over the signature and the trusted comment; then, when `version` is given, the comment's `version:` must
 * equal it. Returns the trusted comment; throws MinisignError with the reason.
 */
export function verifyMinisign({ data, signatureB64, pubkeyB64, version }) {
  const pk = decodePublicKey(pubkeyB64);
  const s = decodeSignature(signatureB64);
  if (!s.keyId.equals(pk.keyId)) throw new MinisignError('the archive was signed with another key than RETAKE_UPDATE_PUBKEY');
  const message = s.prehashed ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, pk.key, s.sig)) throw new MinisignError('the signature does not match the archive');
  if (!verify(null, Buffer.concat([s.sig, Buffer.from(s.trusted, 'utf8')]), pk.key, s.global)) throw new MinisignError('the trusted comment does not match its signature');
  if (version !== undefined) {
    const signed = signedVersion(s.trusted);
    if (signed === null) throw new MinisignError('the signature carries no version (sign with `tauri signer sign --app-version <version>`)');
    if (signed.replace(/^v/, '') !== version) throw new MinisignError(`the archive was signed for version ${signed}, not ${version}`);
  }
  return s.trusted;
}

// ---- publishing ---------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const [version, ...rest] = argv;
  const out = { version, platforms: DEFAULT_PLATFORMS, artifact: null, signature: null, notes: null, force: false };
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i + 1];
    if (rest[i] === '--force') {
      out.force = true;
      continue;
    }
    if (rest[i] === '--platforms') out.platforms = String(v ?? '').split(',').filter(Boolean);
    else if (rest[i] === '--artifact') out.artifact = v ?? null;
    else if (rest[i] === '--signature') out.signature = v ?? null;
    else if (rest[i] === '--notes') out.notes = v ?? null;
    else throw new PublishError(`unknown argument "${rest[i]}"`);
    i++;
  }
  return out;
}

/** The environment's settings, checked: the token, both https URLs, the app's folder. */
export function settings(env) {
  if (!env.UPDATES_UPLOAD_TOKEN?.trim()) throw new PublishError('UPDATES_UPLOAD_TOKEN is not set (the bearer token of your update host)');
  if (!env.UPDATES_UPLOAD_URL?.trim()) throw new PublishError('UPDATES_UPLOAD_URL is not set (where to write on your update host, https)');
  if (!env.UPDATES_PUBLIC_URL?.trim()) throw new PublishError('UPDATES_PUBLIC_URL is not set (the https address the apps download from)');
  if (!env.RETAKE_UPDATE_PUBKEY?.trim()) throw new PublishError('RETAKE_UPDATE_PUBKEY is not set (the public key the apps were built with: the signature is checked before anything is uploaded)');
  const app = env.UPDATES_APP?.trim() || DEFAULT_APP;
  if (!/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(app)) throw new PublishError(`UPDATES_APP "${app}" is not a folder name (lowercase letters, digits, - and _)`);
  return { token: env.UPDATES_UPLOAD_TOKEN.trim(), upload: checkUrl(env.UPDATES_UPLOAD_URL.trim(), 'UPDATES_UPLOAD_URL'), public: checkUrl(env.UPDATES_PUBLIC_URL.trim(), 'UPDATES_PUBLIC_URL'), app, pubkey: env.RETAKE_UPDATE_PUBKEY.trim() };
}

/** The channel of a version: a pre-release's is rc.json, a stable one's latest.json (bundle.mjs ties the apps the same way). */
export function channelOf(version) {
  return version.includes('-') ? 'rc.json' : 'latest.json';
}

/**
 * Check, upload, rebuild the feed. `fetchImpl`: the global fetch (tests: one bound to a local server). Returns what was
 * done: {manifest, channels: {name: 'written' | 'kept <version>'}, puts: [paths]}.
 */
export async function publish({ args, env = process.env, fetchImpl = fetch, changelog = join(REPO, 'CHANGELOG.md'), now = () => new Date(), log = () => {} }) {
  const version = args.version;
  if (!parseVersion(version)) throw new PublishError(`"${version}" is not a version (major.minor.patch, no leading v)`);
  const cfg = settings(env);
  if (!args.artifact || !args.signature) throw new PublishError('--artifact and --signature are required');
  if (!args.platforms.length) throw new PublishError('--platforms names no platform');
  for (const p of args.platforms) if (!KNOWN_PLATFORMS.includes(p)) throw new PublishError(`unknown platform "${p}" (known: ${KNOWN_PLATFORMS.join(', ')})`);
  for (const p of args.platforms) if (!SUPPORTED_PLATFORMS.includes(p)) throw new PublishError(`the archive is the macOS app on Apple silicon: it cannot be published for ${p} (only ${SUPPORTED_PLATFORMS.join(', ')} for now)`);
  const feed = env.RETAKE_UPDATE_FEED?.trim();
  const want = `${cfg.public}/${cfg.app}/${channelOf(version)}`;
  if (feed && feed !== want) throw new PublishError(`RETAKE_UPDATE_FEED is ${feed}, but ${version} belongs to ${want} (a pre-release goes to rc.json, a stable version to latest.json): the apps built with that feed would never see it`);
  const data = readFileSync(args.artifact);
  if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) throw new PublishError(`${args.artifact} is not a gzip archive (the app's .tar.gz)`);
  const signature = readFileSync(args.signature, 'utf8').trim();
  try {
    verifyMinisign({ data, signatureB64: signature, pubkeyB64: cfg.pubkey, version });
  } catch (e) {
    if (e instanceof MinisignError) throw new PublishError(`not published: ${e.message}`);
    throw e;
  }
  const notes = args.notes ? readFileSync(args.notes, 'utf8').trim() : (existsSync(changelog) && extractNotes(readFileSync(changelog, 'utf8'), version)) || `Retake ${version}`;

  const auth = { Authorization: `Bearer ${cfg.token}` };
  const puts = [];
  const put = async (path, body, type) => {
    const res = await fetchImpl(`${cfg.upload}/${path}`, { method: 'PUT', headers: { ...auth, 'Content-Type': type }, body });
    if (!res.ok) throw new PublishError(`PUT ${path}: ${res.status} ${res.statusText}`);
    puts.push(path);
    log(`  put ${path} (${res.status})`);
  };
  const getJson = async (path) => {
    const res = await fetchImpl(`${cfg.upload}/${path}`, { headers: auth });
    if (res.status === 404) return null;
    if (!res.ok) throw new PublishError(`GET ${path}: ${res.status} ${res.statusText}`);
    return res.json();
  };

  // 1. Not over other bits of the same version (unless --force), then the archive, then what points at it.
  const tag = `v${version}`;
  const file = basename(args.artifact);
  for (const p of args.platforms) {
    const old = await getJson(`${cfg.app}/${tag}/platforms/${p}.json`);
    if (old && old.signature !== signature && !args.force) throw new PublishError(`${version} is published already for ${p} with another archive: --force replaces it (apps downloading meanwhile get a signature mismatch and install nothing)`);
  }
  log(`${cfg.app} ${version}: ${args.platforms.join(', ')}`);
  await put(`${cfg.app}/${tag}/${file}`, data, 'application/octet-stream');
  const entry = { signature, url: `${cfg.public}/${cfg.app}/${tag}/${encodeURIComponent(file)}` };
  for (const p of args.platforms) await put(`${cfg.app}/${tag}/platforms/${p}.json`, JSON.stringify(entry, null, 2), 'application/json');

  // 2. This version's feed, from every platform file present (never edited: rebuilt).
  const platforms = {};
  for (const p of KNOWN_PLATFORMS) {
    const found = await getJson(`${cfg.app}/${tag}/platforms/${p}.json`);
    if (found && typeof found.signature === 'string' && typeof found.url === 'string') platforms[p] = { signature: found.signature, url: found.url };
  }
  const manifest = buildManifest({ version, notes, pubDate: now().toISOString(), platforms });
  const body = JSON.stringify(manifest, null, 2);

  // 3. The channels: rc.json follows every version, latest.json the stable ones; never backwards.
  const channels = {};
  for (const channel of version.includes('-') ? ['rc.json'] : ['rc.json', 'latest.json']) {
    const current = await getJson(`${cfg.app}/${channel}`);
    if (current?.version && parseVersion(current.version) && compareVersions(version, current.version) < 0) {
      channels[channel] = `kept ${current.version}`;
      log(`  ${channel} is at ${current.version}: left alone (this is ${version})`);
      continue;
    }
    await put(`${cfg.app}/${channel}`, body, 'application/json');
    channels[channel] = 'written';
  }
  return { manifest, channels, puts };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const r = await publish({ args: parseArgs(process.argv.slice(2)), log: (m) => process.stdout.write(`${m}\n`) });
    process.stdout.write(`feed: ${Object.keys(r.manifest.platforms).join(', ')} — ${Object.entries(r.channels).map(([c, s]) => `${c} ${s}`).join(', ')}\n`);
  } catch (e) {
    process.stderr.write(`publish-update: ${e instanceof PublishError ? e.message : e.stack}\n`);
    process.exit(1);
  }
}
