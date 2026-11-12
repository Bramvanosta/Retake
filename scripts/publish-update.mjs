#!/usr/bin/env node
/**
 * Publish one signed update of the macOS app on GitHub (L5.16d, moved to a GitHub release by L5.16f; DESIGN §4p (d),
 * docs/RELEASING.md), then rebuild the feed the installed apps read.
 *
 *   node scripts/publish-update.mjs 0.2.1 --artifact <dir>/Retake.app.tar.gz --signature <dir>/Retake.app.tar.gz.sig \
 *     [--platforms darwin-aarch64] [--notes notes.txt]
 *
 * The layout, on the repository's releases (public downloads: what an installed app fetches, with no credentials):
 *
 *   releases/download/v<version>/<archive>                  the signed archive (+ its .sig), the version's release
 *   releases/download/v<version>/platform-<platform>.json   {signature, url}: one per platform
 *   releases/download/update-feed/rc.json                   the feed of the newest version, pre-release or not
 *   releases/download/update-feed/latest.json               the feed of the newest stable version
 *
 * The channels sit on ONE fixed release, `update-feed` (GitHub's `releases/latest/download/…` skips pre-releases, and
 * the app has a pre-release channel), itself marked a pre-release and never "latest"; the first publication creates it.
 * It is the only release whose files are replaced after it is public: a version's release only gains files (the
 * archive, its .sig and its platform files when missing) — a file it holds already is never replaced.
 *
 * - Nothing is written before the archive's signature is checked here, in Node, against the public key the apps carry
 *   (RETAKE_UPDATE_PUBKEY, the value given to `pnpm desktop:bundle`): minisign, Ed25519 over the BLAKE2b-512 hash of
 *   the file, the global signature over the trusted comment, and the comment's `version:` equal to the version
 *   published (the apps are built with `requireSignedVersion`: a signature without it would be refused by every app).
 *   Then, still before any write: the repository is public (the apps download without credentials), the version's
 *   release is published (a draft's files answer 404 to them), and what it already holds is these very bits — its
 *   archive and .sig (size, and GitHub's sha256 digest when the API gives one), its platform files (the same
 *   signature and URL). Other bits are refused, with no override: a public release's files are never replaced, a fixed
 *   build is a new version (the `--force` of the update-host days is gone).
 * - The feed is never edited: it is rebuilt from the platform files the version's release holds (this version's own
 *   entry: the one just checked, which the re-read file must equal), so a re-run heals a feed that lost a race. A
 *   channel never goes back: a feed already at a newer version is left alone — looked at again before each delete, so a
 *   newer feed another publication wrote meanwhile is kept too; a kept version that has no published release (a feed
 *   that freezes every app) is a `::warning::` of the run.
 * - A channel is replaced without a moment where it is missing for longer than two API calls: GitHub cannot overwrite
 *   an asset nor rename one onto a taken name, so the new feed is uploaded whole under `<name>.tmp-<run>`, then the old
 *   one is deleted and the new one renamed (`replaceAsset`). An app checking in that instant gets a failed check and
 *   checks again later; it never reads half a file. Every request has a timeout; a server error, a rate limit
 *   (Retry-After honoured up to a minute) or a network error is asked again with a backoff; a run that still cannot
 *   rename keeps its temporary file and says the channel may be missing and what to re-run. Leftover temporary files
 *   of an interrupted run go at the next replacement; a half-uploaded file (GitHub's `starter` state, never
 *   downloadable) on the version's release is deleted and uploaded again.
 * - Platforms: darwin-aarch64 only for now (the archive is the Apple-silicon app: SUPPORTED_PLATFORMS).
 * - The channel follows the version: a pre-release goes to rc.json only, a stable version to both; RETAKE_UPDATE_FEED,
 *   when set (the feed the apps were built with), must be this version's channel on this repository.
 * - Release notes (plain text: the app shows them as text): `--notes <file>`, else the summary paragraph of the
 *   version's section of CHANGELOG.md (`## [0.2.1]` up to its first `###`), else the lead of each bullet, else
 *   "Retake <version>".
 * - Environment: GITHUB_TOKEN (contents: write — the release workflow's own job token; by hand `gh auth token`),
 *   GITHUB_REPOSITORY (`<owner>/<repo>`), RETAKE_UPDATE_PUBKEY; GITHUB_API_URL and GITHUB_SERVER_URL default to
 *   GitHub's own (GitHub Actions sets them), https only. No other token, no other host: the token goes to the API and
 *   to a release's upload address only when that is the API's own upload host (`uploadOrigin`).
 *
 * Tests never reach GitHub: they hand `publish()` a fetch bound to a local stand-in of its REST API on 127.0.0.1.
 */
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every key a Tauri updater may look up in a feed; the feed lists those present for the version. */
export const KNOWN_PLATFORMS = ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'linux-aarch64', 'windows-x86_64'];
export const DEFAULT_PLATFORMS = ['darwin-aarch64'];
/** What an archive of this repository can be for (review d A-L8): the macOS app on Apple silicon only, for now. */
export const SUPPORTED_PLATFORMS = ['darwin-aarch64'];
/** The fixed release whose files are the channels. */
export const FEED_TAG = 'update-feed';
/** GitHub's own addresses: the defaults of GITHUB_API_URL and GITHUB_SERVER_URL (GitHub Actions sets both). */
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_SERVER = 'https://github.com';
/** The most a feed or platform file read back may weigh (they are a few hundred bytes). */
export const JSON_MAX = 1024 * 1024;
/** How long one request may take (its answer's body included); an upload larger than JSON_MAX (the archive) gets more. */
export const REQUEST_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;
/** The pauses before each new try of a request that met a server error, a rate limit or a network error. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
/** The longest Retry-After honoured (a longer one waits this long). */
export const RETRY_AFTER_MAX_MS = 60_000;
/** The redirects a file read back may follow (GitHub answers with one, to its storage): https only, no token. */
export const MAX_REDIRECTS = 3;

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
    throw new PublishError(`${what} is not a URL (an https address)`);
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

// ---- where it goes ------------------------------------------------------------------------------------------------

/** `<owner>/<repo>` as GitHub names them (GITHUB_REPOSITORY); else a PublishError. */
export function checkRepository(value) {
  const r = String(value ?? '').trim();
  const m = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(r);
  if (!m || m[1] === '.' || m[1] === '..') throw new PublishError(`GITHUB_REPOSITORY "${r}" is not <owner>/<repo> (letters, digits, - . _)`);
  return r;
}

/** The repository and the server its public downloads come from (GITHUB_REPOSITORY, GITHUB_SERVER_URL or GitHub's). */
export function feedLocation(env = process.env) {
  if (!env.GITHUB_REPOSITORY?.trim()) throw new PublishError('GITHUB_REPOSITORY is not set (<owner>/<repo>: the repository whose releases carry the updates)');
  return { repository: checkRepository(env.GITHUB_REPOSITORY), server: checkUrl(env.GITHUB_SERVER_URL?.trim() || GITHUB_SERVER, 'GITHUB_SERVER_URL') };
}

/** The public download address of a release's file: no API, no token — what an installed app can fetch. */
export function assetUrl({ server, repository }, tag, name) {
  return `${server}/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** One file per platform on the version's release. */
export const platformAssetName = (platform) => `platform-${platform}.json`;

/** The channel of a version: a pre-release's is rc.json, a stable one's latest.json (bundle.mjs ties the apps the same way). */
export function channelOf(version) {
  return version.includes('-') ? 'rc.json' : 'latest.json';
}

/** The channels a version moves: rc.json follows every version, latest.json the stable ones. */
export const channelsFor = (version) => (version.includes('-') ? ['rc.json'] : ['rc.json', 'latest.json']);

/** The feed an app of `version` reads: `<server>/<owner>/<repo>/releases/download/update-feed/<channel>`. */
export function feedUrl(version, location) {
  return assetUrl(location, FEED_TAG, channelOf(version));
}

/** The environment's settings, checked: the token, the repository, both https addresses, the public key. */
export function settings(env) {
  if (!env.GITHUB_TOKEN?.trim()) throw new PublishError("GITHUB_TOKEN is not set (a token that may write the repository's releases: the workflow's job token, or `gh auth token` by hand)");
  const location = feedLocation(env);
  if (!env.RETAKE_UPDATE_PUBKEY?.trim()) throw new PublishError('RETAKE_UPDATE_PUBKEY is not set (the public key the apps were built with: the signature is checked before anything is written)');
  return { token: env.GITHUB_TOKEN.trim(), ...location, api: checkUrl(env.GITHUB_API_URL?.trim() || GITHUB_API, 'GITHUB_API_URL'), pubkey: env.RETAKE_UPDATE_PUBKEY.trim() };
}

// ---- GitHub's REST API ----------------------------------------------------------------------------------------------

/**
 * Where the API's uploads go (review f A-L4): `api.<host>` uploads to `uploads.<host>` (GitHub: api.github.com →
 * uploads.github.com), any other API host (GitHub Enterprise Server: `<host>/api/v3`) to itself.
 */
export function uploadOrigin(api) {
  const u = new URL(api);
  if (u.hostname.startsWith('api.')) u.hostname = `uploads.${u.hostname.slice('api.'.length)}`;
  return u.origin;
}

/**
 * A release's `upload_url` is a URI template (`…/assets{?name,label}`): the https address to POST `name` to — refused
 * unless it is on the API's own upload host (the token goes there).
 */
export function uploadUrl(template, name, api) {
  const u = String(template ?? '').replace(/\{[^}]*\}$/, '');
  if (!u.startsWith('https://')) throw new PublishError(`the release's upload address is not https (${u.slice(0, 80)})`);
  if (new URL(u).origin !== uploadOrigin(api))
    throw new PublishError(`the release's upload address is not on ${uploadOrigin(api)}, the API's upload host (${new URL(u).origin}): refused — the token goes there`);
  return `${u}?name=${encodeURIComponent(name)}`;
}

/** Whether an answer is worth asking again: a server error, or a rate limit (429; 403 with Retry-After or no request left). */
export function retryable(res) {
  if (res.status >= 500 || res.status === 429) return true;
  return res.status === 403 && (res.headers.get('retry-after') !== null || res.headers.get('x-ratelimit-remaining') === '0');
}

/** The pause before asking again: the answer's Retry-After (seconds or a date) up to `cap`, else `backoff`. */
export function retryDelay(res, backoff, cap = RETRY_AFTER_MAX_MS, now = Date.now()) {
  const after = res?.headers.get('retry-after')?.trim();
  if (!after) return backoff;
  const ms = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), cap) : backoff;
}

/** Whether a 422's body says the thing exists already (GitHub: `errors[].code` "already_exists"). */
export function alreadyExists(text) {
  try {
    return (JSON.parse(text)?.errors ?? []).some((e) => e?.code === 'already_exists');
  } catch {
    return false;
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The few REST calls a publication needs, through `fetchImpl` (tests: a local stand-in). The token goes to the API and
 * to the release's upload address (on the API's upload host) only; a file read back follows GitHub's redirects to its
 * storage with no token, only to https addresses, at most MAX_REDIRECTS. Every request has a timeout; the ones that
 * may be sent again (GET, DELETE, PATCH: not an upload, not a creation) are, after a server error, a rate limit or a
 * network error, with a pause (`sleep`, RETRY_DELAYS_MS).
 */
export function createGitHub({
  token,
  api,
  repository,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  uploadTimeoutMs = UPLOAD_TIMEOUT_MS,
  retryDelays = RETRY_DELAYS_MS,
  sleep = pause,
  log = () => {},
}) {
  const base = `${api}/repos/${repository}`;
  const common = { 'user-agent': 'retake-publish-update', 'x-github-api-version': '2022-11-28' };
  /** One request, tried again when `retry` and the answer (or its absence) says so; a PublishError when it cannot be sent. */
  const send = async (what, url, init, { retry = false, timeout = timeoutMs } = {}) => {
    const delays = retry ? retryDelays : [];
    for (let i = 0; ; i++) {
      let res = null;
      let err = null;
      try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) });
      } catch (e) {
        err = e;
      }
      if (i >= delays.length || !(err || retryable(res))) {
        if (err) throw new PublishError(`${what}: ${err?.name === 'TimeoutError' ? `no answer in ${timeout / 1000} s` : `network error (${err?.cause?.code ?? err?.message ?? err})`}`);
        return res;
      }
      const wait = err ? delays[i] : retryDelay(res, delays[i]);
      await res?.body?.cancel().catch(() => {});
      log(`  ${what}: ${err ? 'no answer' : res.status} — asked again in ${Math.round(wait / 100) / 10} s`);
      await sleep(wait);
    }
  };
  const fail = async (method, url, res) => {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    return new PublishError(`${method} ${new URL(url).pathname}: ${res.status} ${detail}`.trim());
  };
  const call = async (method, url, { json, body, type, allow = [], exists = false, timeout } = {}) => {
    const headers = { ...common, authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', ...(json ? { 'content-type': 'application/json' } : type ? { 'content-type': type } : {}) };
    const res = await send(`${method} ${new URL(url).pathname}`, url, { method, headers, body: json ? JSON.stringify(json) : body, redirect: 'manual' }, { retry: method !== 'POST', timeout });
    if (allow.includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (exists && res.status === 422) {
      // Only GitHub's "already exists" means that (review f B-L2): any other validation error is the error.
      const text = await res.text().catch(() => '');
      if (alreadyExists(text)) return null;
      throw new PublishError(`${method} ${new URL(url).pathname}: 422 ${text.replace(/\s+/g, ' ').slice(0, 300)}`.trim());
    }
    if (!res.ok) throw await fail(method, url, res);
    return res.status === 204 ? null : res.json();
  };
  return {
    sleep,
    retryDelays,
    repo: () => call('GET', base),
    /** A published release (GitHub answers 404 for a draft), or null. */
    releaseByTag: (tag) => call('GET', `${base}/releases/tags/${encodeURIComponent(tag)}`, { allow: [404] }),
    /** null when a release of that tag exists already (another run got there first, or a draft): a 422 "already_exists". */
    createRelease: (fields) => call('POST', `${base}/releases`, { json: fields, exists: true }),
    async assets(release) {
      const all = [];
      for (let page = 1; page < 100; page++) {
        const batch = await call('GET', `${base}/releases/${release.id}/assets?per_page=100&page=${page}`);
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    /** The file's text, at most JSON_MAX bytes. */
    async read(asset) {
      const what = `reading ${asset.name}`;
      let res = await send(
        what,
        `${base}/releases/assets/${asset.id}`,
        { headers: { ...common, authorization: `Bearer ${token}`, accept: 'application/octet-stream' }, redirect: 'manual' },
        { retry: true },
      );
      for (let hops = 0; res.status >= 300 && res.status < 400; hops++) {
        await res.body?.cancel().catch(() => {});
        if (hops === MAX_REDIRECTS) throw new PublishError(`${asset.name}: GitHub redirected its download more than ${MAX_REDIRECTS} times`);
        const location = res.headers.get('location') ?? '';
        if (!location.startsWith('https://')) throw new PublishError(`${asset.name}: GitHub redirected its download to a non-https address`);
        // The storage address carries its own authorization: no token there, nor at any later hop.
        res = await send(what, location, { headers: { ...common, accept: 'application/octet-stream' }, redirect: 'manual' }, { retry: true });
      }
      if (!res.ok) throw new PublishError(`reading ${asset.name}: ${res.status}`);
      const announced = Number(res.headers.get('content-length') ?? 0);
      if (announced > JSON_MAX) {
        await res.body?.cancel().catch(() => {});
        throw new PublishError(`${asset.name} is larger than ${JSON_MAX} bytes (${announced} announced)`);
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > JSON_MAX) throw new PublishError(`${asset.name} is larger than ${JSON_MAX} bytes`);
      return bytes.toString('utf8');
    },
    /** The new asset, or null on 422 (the name is taken). */
    upload: (release, name, body, type) =>
      call('POST', uploadUrl(release.upload_url, name, api), { body, type, allow: [422], timeout: Buffer.byteLength(body) > JSON_MAX ? uploadTimeoutMs : timeoutMs }),
    remove: (asset) => call('DELETE', `${base}/releases/assets/${asset.id}`, { allow: [404] }),
    /** The renamed asset, or null on 422 (the name is taken — or GitHub's list was not up to date yet). */
    rename: (asset, name) => call('PATCH', `${base}/releases/assets/${asset.id}`, { json: { name }, allow: [422] }),
  };
}

/** Whether a listed asset can be downloaded: GitHub lists an interrupted upload too, in the state `starter`. */
export const uploaded = (asset) => !asset.state || asset.state === 'uploaded';

/** Whether GitHub's description of a repository says it is public (`private` false, and `visibility` public when given). */
export function isPublic(repo) {
  return repo?.private === false && (!repo.visibility || repo.visibility === 'public');
}

/** Whether a release asset holds `bytes`: its size, and GitHub's sha256 digest when the API gives one. */
export function sameBytes(asset, bytes) {
  if (asset.size !== bytes.length) return false;
  return !asset.digest || asset.digest === `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A JSON file of a release, parsed; null when it is not JSON (a network or API failure throws: never "absent"). */
async function readJson(gh, asset, log) {
  const text = await gh.read(asset);
  try {
    return JSON.parse(text);
  } catch {
    log(`  ${asset.name} is not JSON: treated as absent`);
    return null;
  }
}

/**
 * Replace a release's file with no moment where it is missing longer than two API calls (GitHub cannot overwrite an
 * asset, nor rename one onto a taken name): the new content (the feed of `version`) uploaded whole under
 * `<name>.tmp-<run>`, then the old file deleted and the new one renamed. Before each delete, every file holding the
 * name is looked at again (review f A-M1): one that appeared since the caller's check (not `known`, the asset it
 * compared) holding `version` or a newer one is kept and ours dropped — a channel never goes back. A rename refused
 * (another run took the name, or GitHub's list was not up to date yet) is tried again after a pause, `tries` times in
 * all. The temporary file is dropped only when the name is held by an equal or newer feed; otherwise a run that gives
 * up keeps it and says the channel may be missing and what to re-run (review f A-M2). Afterwards, temporary files of
 * that name left by an interrupted run are removed. Returns 'written' or 'kept <version>'.
 */
export async function replaceAsset(gh, release, name, body, run, { version, known = null, log = () => {}, tries = 4 } = {}) {
  const tmp = `${name}.tmp-${run}`;
  const where = `${release.tag_name}/${name}`;
  const fresh = await gh.upload(release, tmp, body, 'application/json');
  if (!fresh) throw new PublishError(`${release.tag_name}: ${tmp} exists already`);
  const rerun = `re-run this publication (the workflow: the run's publish job › Re-run failed jobs; by hand: the same command) — it writes ${name} again and removes the temporary file`;
  /** The feed now holding the name, when it is `version` or newer and not the one the caller compared: its version. */
  const newer = async (holder) => {
    if (holder.id === known) return null;
    const theirs = await readJson(gh, holder, log);
    const v = typeof theirs?.version === 'string' && parseVersion(theirs.version) ? theirs.version : null;
    return v && compareVersions(version, v) <= 0 ? v : null;
  };
  const keep = async (v) => {
    try {
      await gh.remove(fresh);
    } catch (e) {
      log(`  could not remove ${release.tag_name}/${tmp} (the next publication will): ${e.message}`);
    }
    log(`  ${where} holds ${v} now (another publication wrote it meanwhile): kept — this run's feed of ${version} dropped`);
    return `kept ${v}`;
  };
  let deleted = false;
  try {
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt) await gh.sleep(gh.retryDelays[Math.min(attempt - 1, gh.retryDelays.length - 1)] ?? 0);
      for (const holder of (await gh.assets(release)).filter((a) => a.name === name)) {
        const v = await newer(holder);
        if (v) return await keep(v);
        // From here the channel may be missing (a DELETE that timed out may still have been done).
        deleted = true;
        await gh.remove(holder);
      }
      if (await gh.rename(fresh, name)) {
        for (const stale of (await gh.assets(release)).filter((a) => a.name.startsWith(`${name}.tmp-`) && a.id !== fresh.id)) {
          try {
            await gh.remove(stale);
            log(`  removed ${release.tag_name}/${stale.name} (an interrupted run's)`);
          } catch (e) {
            log(`  could not remove ${release.tag_name}/${stale.name} (an interrupted run's: the next publication will): ${e.message}`);
          }
        }
        return 'written';
      }
      log(`  renaming ${release.tag_name}/${tmp} to ${name}: the name is taken — looking again`);
    }
    // Given up: the name is held by an equal or newer feed (ours dropped), or ours is kept for a re-run.
    const holder = (await gh.assets(release)).find((a) => a.name === name);
    const v = holder && (await newer(holder));
    if (v) return await keep(v);
    if (holder)
      throw new PublishError(
        `could not replace ${where}: another publication keeps writing an older feed there (${tries} tries). This run's feed of ${version} is kept as ${release.tag_name}/${tmp}: ${rerun}`,
      );
    throw new PublishError(
      `could not rename ${release.tag_name}/${tmp} to ${name} (${tries} tries, the name refused though no file holds it): ${where} is MISSING — every app's check fails until it is back. This run's feed of ${version} is kept as ${release.tag_name}/${tmp}: ${rerun}`,
    );
  } catch (e) {
    if (!(e instanceof PublishError) || /^could not (replace|rename) /.test(e.message)) throw e;
    if (deleted)
      throw new PublishError(
        `${e.message} — while replacing ${where}: it may be MISSING (its old file was deleted, or being deleted) and every app's check fails until it is back. This run's feed of ${version} is kept as ${release.tag_name}/${tmp}: ${rerun}`,
      );
    throw new PublishError(`${e.message} — while replacing ${where} (left as it was; ${release.tag_name}/${tmp} goes at the next publication): re-run this publication`);
  }
}

/** The fixed feed release: found, or created as a pre-release that is never "latest". */
async function feedRelease(gh, log) {
  const found = await gh.releaseByTag(FEED_TAG);
  if (found) {
    if (found.prerelease !== true) log(`  warning: the ${FEED_TAG} release is not a pre-release — GitHub may show it as the latest release (mark it a pre-release)`);
    return found;
  }
  const created = await gh.createRelease({
    tag_name: FEED_TAG,
    name: 'Update feed',
    body: "What the installed Retake apps read to find updates: `latest.json` (stable versions) and `rc.json` (pre-releases too), replaced at every release. Nothing to download here: see the versions' releases.",
    draft: false,
    prerelease: true,
    make_latest: 'false',
  });
  if (created) {
    log(`  created the ${FEED_TAG} release (a pre-release)`);
    return created;
  }
  // GitHub said "already exists": another run made it meanwhile, or it is a draft (which the lookup by tag cannot see).
  const raced = await gh.releaseByTag(FEED_TAG);
  if (!raced) throw new PublishError(`a release ${FEED_TAG} exists but is not published (a draft?): publish it as a pre-release, or delete it and run this again`);
  return raced;
}

// ---- publishing ---------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const [version, ...rest] = argv;
  const out = { version, platforms: DEFAULT_PLATFORMS, artifact: null, signature: null, notes: null };
  for (let i = 0; i < rest.length; i++) {
    const v = rest[i + 1];
    if (rest[i] === '--force') throw new PublishError("--force is gone: a public release's files are never replaced — a fixed build is a new version (node scripts/set-version.mjs, then tag it)");
    if (rest[i] === '--platforms')
      out.platforms = String(v ?? '')
        .split(',')
        .filter(Boolean);
    else if (rest[i] === '--artifact') out.artifact = v ?? null;
    else if (rest[i] === '--signature') out.signature = v ?? null;
    else if (rest[i] === '--notes') out.notes = v ?? null;
    else throw new PublishError(`unknown argument "${rest[i]}"`);
    i++;
  }
  return out;
}

/**
 * Check, read, then write: the version's files (only those it lacks), then the feed. `fetchImpl`: the global fetch
 * (tests: one bound to a local stand-in of GitHub); `net`: createGitHub's timeouts, pauses and `sleep` (tests). Returns
 * what was done: {manifest, channels: {name: 'written' | 'kept <version>'}, writes: ['<tag>/<file>' …], warnings}.
 */
export async function publish({ args, env = process.env, fetchImpl = fetch, net = {}, changelog = join(REPO, 'CHANGELOG.md'), now = () => new Date(), log = () => {} }) {
  const version = args.version;
  if (!parseVersion(version)) throw new PublishError(`"${version}" is not a version (major.minor.patch, no leading v)`);
  const cfg = settings(env);
  if (!args.artifact || !args.signature) throw new PublishError('--artifact and --signature are required');
  if (!args.platforms.length) throw new PublishError('--platforms names no platform');
  for (const p of args.platforms) if (!KNOWN_PLATFORMS.includes(p)) throw new PublishError(`unknown platform "${p}" (known: ${KNOWN_PLATFORMS.join(', ')})`);
  for (const p of args.platforms)
    if (!SUPPORTED_PLATFORMS.includes(p)) throw new PublishError(`the archive is the macOS app on Apple silicon: it cannot be published for ${p} (only ${SUPPORTED_PLATFORMS.join(', ')} for now)`);
  const feed = env.RETAKE_UPDATE_FEED?.trim();
  const want = feedUrl(version, cfg);
  if (feed && feed !== want)
    throw new PublishError(
      `RETAKE_UPDATE_FEED is ${feed}, but ${version} belongs to ${want} (a pre-release goes to rc.json, a stable version to latest.json): the apps built with that feed would never see it`,
    );
  const data = readFileSync(args.artifact);
  if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) throw new PublishError(`${args.artifact} is not a gzip archive (the app's .tar.gz)`);
  const sigBytes = readFileSync(args.signature);
  const signature = sigBytes.toString('utf8').trim();
  try {
    verifyMinisign({ data, signatureB64: signature, pubkeyB64: cfg.pubkey, version });
  } catch (e) {
    if (e instanceof MinisignError) throw new PublishError(`not published: ${e.message}`);
    throw e;
  }
  const notes = args.notes ? readFileSync(args.notes, 'utf8').trim() : (existsSync(changelog) && extractNotes(readFileSync(changelog, 'utf8'), version)) || `Retake ${version}`;
  const run = `${/^\d+$/.test(env.GITHUB_RUN_ID ?? '') ? `${env.GITHUB_RUN_ID}-` : ''}${randomBytes(4).toString('hex')}`;
  const gh = createGitHub({ token: cfg.token, api: cfg.api, repository: cfg.repository, fetchImpl, log, ...net });

  // 1. Read, before any write: a public repository, the version's published release, and what it holds is these bits.
  const tag = `v${version}`;
  const repo = await gh.repo();
  if (!isPublic(repo)) throw new PublishError(`${cfg.repository} is not public: the installed apps download their updates without credentials (make the repository public)`);
  const release = await gh.releaseByTag(tag);
  if (!release || release.draft) throw new PublishError(`${cfg.repository} has no published release ${tag}: publish it first (a draft's files answer 404 to the apps)`);
  const file = basename(args.artifact);
  const sigFile = basename(args.signature);
  const listed = await gh.assets(release);
  // An interrupted upload is listed in the state `starter` (review f A-L7): never downloadable, it is not a file of the
  // release — deleted before this run uploads its own (step 2).
  const half = listed.filter((a) => !uploaded(a));
  const held = listed.filter(uploaded);
  const archive = held.find((a) => a.name === file);
  const never = "a public release's files are never replaced — a fixed build is a new version";
  if (archive && !sameBytes(archive, data)) throw new PublishError(`${tag}'s ${file} is not the archive checked here (${archive.size} bytes on the release, ${data.length} here): ${never}`);
  const sigAsset = held.find((a) => a.name === sigFile);
  if (sigAsset && !sameBytes(sigAsset, sigBytes)) throw new PublishError(`${tag}'s ${sigFile} is not the signature checked here: ${never}`);
  const entry = { signature, url: assetUrl(cfg, tag, archive?.name ?? file) };
  const samePlatform = (old) => old?.signature === entry.signature && old?.url === entry.url;
  for (const p of args.platforms) {
    const a = held.find((x) => x.name === platformAssetName(p));
    if (a && !samePlatform(await readJson(gh, a, log))) throw new PublishError(`${version} is published already for ${p} with another archive (${tag}/${a.name}): ${never}`);
  }

  // 2. The version's release: only what it lacks — the archive, its .sig, its platform files.
  log(`Retake ${version} on ${cfg.repository}: ${args.platforms.join(', ')}`);
  const writes = [];
  const ours = new Set([file, sigFile, ...args.platforms.map(platformAssetName)]);
  for (const a of half.filter((x) => ours.has(x.name))) {
    await gh.remove(a);
    log(`  removed ${tag}/${a.name}: a half-uploaded file (an interrupted upload, never downloadable) — uploaded again`);
  }
  if (!archive) {
    const up = await gh.upload(release, file, data, 'application/octet-stream');
    if (!up) throw new PublishError(`${tag}: ${file} appeared meanwhile (another run?): run this again`);
    entry.url = assetUrl(cfg, tag, up.name);
    writes.push(`${tag}/${up.name}`);
    log(`  uploaded ${tag}/${up.name}`);
  }
  if (!sigAsset) {
    const up = await gh.upload(release, sigFile, sigBytes, 'text/plain');
    if (!up) throw new PublishError(`${tag}: ${sigFile} appeared meanwhile (another run?): run this again`);
    writes.push(`${tag}/${up.name}`);
  }
  const entryJson = JSON.stringify(entry, null, 2);
  for (const p of args.platforms) {
    const name = platformAssetName(p);
    if (held.some((x) => x.name === name)) continue;
    const up = await gh.upload(release, name, entryJson, 'application/json');
    if (!up) {
      // Another run wrote it meanwhile: fine when it is the same.
      const raced = (await gh.assets(release)).find((x) => x.name === name && uploaded(x));
      if (!raced || !samePlatform(await readJson(gh, raced, log))) throw new PublishError(`${version} was published meanwhile for ${p} with another archive (${tag}/${name}): ${never}`);
      continue;
    }
    writes.push(`${tag}/${name}`);
    log(`  uploaded ${tag}/${name}`);
  }

  // 3. This version's feed, from every platform file its release holds (never edited: rebuilt) — this run's platforms
  // from the entry checked here, which their file read back must equal (review f A-L1: never a feed that names other
  // bits, or lacks this run's platform).
  const platforms = {};
  const holds = await gh.assets(release);
  for (const p of KNOWN_PLATFORMS) {
    const a = holds.find((x) => x.name === platformAssetName(p) && uploaded(x));
    const found = a && (await readJson(gh, a, log));
    if (args.platforms.includes(p)) {
      if (a && !samePlatform(found)) throw new PublishError(`${tag}/${a.name} read back is not the platform file checked here (changed meanwhile?): nothing written to the feed — run this again`);
      platforms[p] = { signature: entry.signature, url: entry.url };
    } else if (found && typeof found.signature === 'string' && typeof found.url === 'string') platforms[p] = { signature: found.signature, url: found.url };
  }
  const manifest = buildManifest({ version, notes, pubDate: now().toISOString(), platforms });
  const body = JSON.stringify(manifest, null, 2);

  // 4. The channels on the feed release: rc.json follows every version, latest.json the stable ones; never backwards.
  const feedRel = await feedRelease(gh, log);
  const feedHeld = await gh.assets(feedRel);
  const channels = {};
  const warnings = [];
  for (const channel of channelsFor(version)) {
    const a = feedHeld.find((x) => x.name === channel);
    const current = a ? await readJson(gh, a, log) : null;
    if (current?.version && parseVersion(current.version) && compareVersions(version, current.version) < 0) {
      channels[channel] = `kept ${current.version}`;
      log(`  ${channel} is at ${current.version}: left alone (this is ${version})`);
    } else {
      channels[channel] = await replaceAsset(gh, feedRel, channel, body, run, { version, known: a?.id ?? null, log });
      if (channels[channel] === 'written') {
        writes.push(`${FEED_TAG}/${channel}`);
        log(`  ${FEED_TAG}/${channel} → ${version}`);
      }
    }
    const kept = /^kept (.+)$/.exec(channels[channel])?.[1];
    if (kept && !(await gh.releaseByTag(`v${kept}`))) warnings.push(frozen(channel, kept, cfg.repository));
  }
  // GitHub Actions turns a `::warning::` line of the log into an annotation of the run.
  for (const w of warnings) log(`::warning::${w}`);
  return { manifest, channels, writes, warnings };
}

/**
 * A channel kept at a version that has no published release (review f A-L2): a hand-placed or forged feed naming a
 * version nobody can install freezes every app reading it, and never moving a channel back keeps it so. The run stays
 * green — this version's release is complete, and which feed is right is a person's call — but says it loudly.
 */
export function frozen(channel, version, repository) {
  return `${FEED_TAG}/${channel} names ${version}, newer than this version, but ${repository} has no published release v${version}: every app reading ${channel} is stuck (no update is offered while it names a version nobody can install). This run did its part and stays green (a channel never moves back on its own); check ${FEED_TAG}'s files — delete the wrong ${channel}, then re-run the publish job of the newest real version`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const r = await publish({ args: parseArgs(process.argv.slice(2)), log: (m) => process.stdout.write(`${m}\n`) });
    process.stdout.write(
      `feed: ${Object.keys(r.manifest.platforms).join(', ')} — ${Object.entries(r.channels)
        .map(([c, s]) => `${c} ${s}`)
        .join(', ')}\n`,
    );
  } catch (e) {
    process.stderr.write(`publish-update: ${e instanceof PublishError ? e.message : e.stack}\n`);
    process.exit(1);
  }
}
