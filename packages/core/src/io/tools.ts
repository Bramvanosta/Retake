/**
 * The downloaded Tools (DESIGN §4p): what the app no longer ships and downloads once, on the person's click,
 * from their publishers into `<RETAKE_HOME>/tools/` — the browser (captures, sign-in, recording), the render browser
 * (renders) and the compositor (the rendering library's own binaries). This module is their model: the manifest's
 * entries and their checks, the folder's layout, the cheap state read at each use, and the tree digest. Reading only:
 * the download, the extraction and the checks of an install are the engine's (packages/engine/src/tools/).
 *
 * - **The manifest**: `apps/desktop/bundle/tools.json` (committed, one list of entries per platform: `readToolsManifest`)
 *   is recorded per release from the real archives; the stage copies the app's platform's list into bundle.json's
 *   `tools` (sealed with the app: `bundleTools`). Each entry says where its archive is (an https URL on TOOL_HOSTS only),
 *   its size and sha256 (checked before anything is extracted), and the tree digest of the extracted folder (checked
 *   after, and again by "Check again"). `parseToolEntries` refuses anything else, in one sentence.
 * - **The layout** (`toolsFolder`, bundle.ts): `browsers/chromium-<rev>/` and `browsers/chromium_headless_shell-<rev>/`
 *   (Playwright's own layout and markers: PLAYWRIGHT_BROWSERS_PATH names `browsers/`), `compositor-<version>/` (the npm
 *   package's files), and the installer's own dot entries (TOOLS_FILES: `.lock`, `.state.json`, `.partial/`,
 *   `.started.json`, `.pending.json`, `.control.json`, `.tmp-*`, `.trash-*`). Each installed folder holds a `.verified`
 *   stamp (its tree digest, file count and bytes) and is made read-only.
 * - **The cheap state** (`toolsState`): a folder is `ready` when it is a real folder of this user that no one else may
 *   write, its markers are there, and its stamp names the manifest's tree digest and still matches the folder's file
 *   count and bytes (a walk of lstat calls, no file read). The full digest (`treeDigest`) runs at install and on
 *   "Check again" only.
 *
 * Builtin-only (node: modules and bundle.ts): the app's first module loads bundle.ts alone, and this one may be read
 * by any package's io side.
 */
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BundleError, TOOLS_BROWSERS_DIR, toolsFolder } from './bundle.js';
import type { BundleInfo } from './bundle.js';

/** The Tools, by stable id, in their install order (smallest first: renders and stills unblock early). */
export const TOOL_IDS = ['render-browser', 'compositor', 'browser'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** What a job kind needs of the Tools (engine job-input.ts JOB_TOOLS): the browser, or the render browser and the compositor. */
export type ToolNeed = 'browser' | 'render';
/** The Tools each need is made of. */
export const NEED_TOOLS: Readonly<Record<ToolNeed, readonly ToolId[]>> = { browser: ['browser'], render: ['render-browser', 'compositor'] };

/**
 * The only hosts a Tool is downloaded from, every redirect hop included: Google's Chrome for Testing bucket (the browser
 * and the render browser) and the npm registry (the compositor). https only, no other port.
 */
export const TOOL_HOSTS: readonly string[] = ['storage.googleapis.com', 'registry.npmjs.org'];

/** The archive kinds an entry may name: a zip (ditto keeps its links and modes) or an npm tarball. */
export const TOOL_ARCHIVES = ['zip', 'tgz'] as const;
export type ToolArchive = (typeof TOOL_ARCHIVES)[number];

/** One Tool of a manifest (tools.json, bundle.json `tools`): what to download, how to check it, where it goes. */
export interface ToolEntry {
  id: ToolId;
  /** The Studio's word ("Browser", "Render browser", "Compositor"). */
  label: string;
  /** The product's own name ("Chrome for Testing", …): data, shown as text. */
  name: string;
  version: string;
  /** Who publishes the archive (shown on the Tools page). */
  publisher: string;
  /** Its licence, in a few words (the Tools page; the full terms are apps/desktop/licenses/tools/). */
  licence: string;
  /** The folder under `<RETAKE_HOME>/tools` (`browsers/chromium-1255`, `compositor-4.0.534`). */
  folder: string;
  url: string;
  archive: ToolArchive;
  /** The archive's size (bytes): a download is refused past it. */
  bytes: number;
  /** The archive's sha256 (hex): checked before anything is extracted. */
  sha256: string;
  /** The npm `integrity` (sha512-…, the lockfile's) of an npm tarball: recorded, the sha256 is what is checked. */
  integrity?: string;
  /** A tgz's folder whose contents are the Tool (`package`); a zip's entries go into the folder as they are. */
  root?: string;
  /** Paths (relative to the folder) removed after extraction, before the tree check (an installer script nothing runs). */
  prune?: string[];
  /** treeDigest of the extracted folder (markers and dot entries left out): checked after extraction. */
  tree: string;
  /** The folder's size once extracted (bytes). */
  disk: number;
  /** The program the Tool is used through, relative to its folder (the compositor: `.`, its folder). */
  executable: string;
  /** Empty files written after the tree check (Playwright's `INSTALLATION_COMPLETE`, `DEPENDENCIES_VALIDATED`). */
  markers?: string[];
}

/** tools.json, as committed: the Tools of one Retake version, per platform (`darwin-arm64`). */
export interface ToolsManifestFile {
  v: 1;
  about?: string;
  platforms: Record<string, ToolEntry[]>;
}

/** The platform key of this machine (`darwin-arm64`). */
export function toolsPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A folder under tools/: one or two plain segments, the browsers under browsers/. */
const FOLDER_RE = /^(?:browsers\/)?[a-z0-9][a-z0-9_.-]{0,63}$/;
const TEXT_MAX = 80;
const MAX_BYTES = 2 * 1024 ** 3;

function problemOf(e: Record<string, unknown>, hosts: readonly string[]): string | undefined {
  if (!TOOL_IDS.includes(e.id as ToolId)) return `id must be one of ${TOOL_IDS.join(', ')}`;
  for (const k of ['label', 'name', 'publisher', 'licence'] as const) {
    const v = e[k];
    if (typeof v !== 'string' || !v.trim() || v.length > TEXT_MAX || /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/u.test(v)) return `${k} must be a short line of text`;
  }
  if (typeof e.version !== 'string' || !VERSION_RE.test(e.version)) return 'version must be a version';
  if (typeof e.folder !== 'string' || !FOLDER_RE.test(e.folder) || e.folder.split('/').some((s) => s === '.' || s === '..'))
    return 'folder must be a plain folder name (browsers/<name> for a browser)';
  if ((e.id === 'compositor') === e.folder.startsWith(`${TOOLS_BROWSERS_DIR}/`)) return `folder ${e.folder}: the browsers go under ${TOOLS_BROWSERS_DIR}/, the compositor does not`;
  const url = urlProblem(e.url, hosts);
  if (url) return url;
  if (!TOOL_ARCHIVES.includes(e.archive as ToolArchive)) return `archive must be one of ${TOOL_ARCHIVES.join(', ')}`;
  if (!Number.isSafeInteger(e.bytes) || (e.bytes as number) <= 0 || (e.bytes as number) > MAX_BYTES) return 'bytes must be the archive size';
  if (!Number.isSafeInteger(e.disk) || (e.disk as number) <= 0 || (e.disk as number) > 4 * MAX_BYTES) return 'disk must be the size once extracted';
  for (const k of ['sha256', 'tree'] as const) if (typeof e[k] !== 'string' || !HEX64.test(e[k] as string)) return `${k} must be a sha256 (64 lowercase hex characters)`;
  if (e.integrity !== undefined && (typeof e.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(e.integrity))) return 'integrity must be an npm sha512 integrity';
  if (e.root !== undefined && (e.archive !== 'tgz' || typeof e.root !== 'string' || !NAME_RE.test(e.root))) return 'root is a plain folder name of a tgz';
  if (typeof e.executable !== 'string' || (e.executable !== '.' && relProblem(e.executable))) return 'executable must be a relative path inside the folder';
  if (e.prune !== undefined && (!Array.isArray(e.prune) || e.prune.length > 16 || e.prune.some((p) => typeof p !== 'string' || relProblem(p) !== undefined)))
    return 'prune must list relative paths inside the folder';
  if (e.markers !== undefined && (!Array.isArray(e.markers) || e.markers.length > 4 || e.markers.some((m) => typeof m !== 'string' || !/^[A-Z][A-Z_]{0,39}$/.test(m))))
    return 'markers must be plain upper-case names';
  return undefined;
}

/** Why `p` is not a relative path inside a folder (absolute, a `..` or empty segment, a control character), or undefined. */
function relProblem(p: string): string | undefined {
  if (!p || p.length > 512 || isAbsolute(p) || p.includes('\\') || /[\u0000-\u001f]/.test(p)) return 'not a relative path';
  return p.split('/').some((s) => s === '' || s === '.' || s === '..') ? 'a . or .. segment' : undefined;
}

/**
 * Why `raw` is not a download URL of a Tool (`hosts`: TOOL_HOSTS), or undefined: https, a host of the list, no port,
 * no user or password, no query or fragment. The installer applies the same rule to every redirect hop.
 */
export function urlProblem(raw: unknown, hosts: readonly string[] = TOOL_HOSTS): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return 'url must be an https URL';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'url must be an https URL';
  }
  if (u.protocol !== 'https:') return `url ${raw}: https only`;
  if (!hosts.includes(u.hostname)) return `url ${raw}: ${u.hostname} is not one of the hosts Tools are downloaded from (${hosts.join(', ')})`;
  if (u.port || u.username || u.password || u.search || u.hash) return `url ${raw}: no port, user, query or fragment`;
  return undefined;
}

/**
 * The Tools of a manifest, checked: each entry valid (problemOf), each id once, each folder once. BundleError naming
 * `where` and the entry otherwise. `hosts`: the allow-list (TOOL_HOSTS; tests hand their own).
 */
export function parseToolEntries(value: unknown, where: string, hosts: readonly string[] = TOOL_HOSTS): ToolEntry[] {
  if (!Array.isArray(value)) throw new BundleError(`${where}: tools must be a list`);
  const ids = new Set<string>();
  const folders = new Set<string>();
  const out: ToolEntry[] = [];
  for (const [i, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BundleError(`${where}: tools[${i}] is not an entry`);
    const e = raw as Record<string, unknown>;
    const problem = problemOf(e, hosts);
    if (problem) throw new BundleError(`${where}: tools[${i}]${typeof e.id === 'string' ? ` (${e.id.slice(0, 20)})` : ''}: ${problem}`);
    if (ids.has(e.id as string)) throw new BundleError(`${where}: tools[${i}]: ${String(e.id)} is listed twice`);
    if (folders.has(e.folder as string)) throw new BundleError(`${where}: tools[${i}]: the folder ${String(e.folder)} is listed twice`);
    ids.add(e.id as string);
    folders.add(e.folder as string);
    out.push(raw as ToolEntry);
  }
  const missing = TOOL_IDS.filter((id) => !ids.has(id));
  if (missing.length) throw new BundleError(`${where}: tools lacks ${missing.join(', ')}`);
  // Install order (TOOL_IDS), whatever the file's.
  return TOOL_IDS.map((id) => out.find((e) => e.id === id)!);
}

/** Read tools.json (`file`) and its entries for `platform` (default this machine's), checked. BundleError otherwise. */
export function readToolsManifest(file: string, platform: string = toolsPlatform(), hosts: readonly string[] = TOOL_HOSTS): ToolEntry[] {
  let m: ToolsManifestFile;
  try {
    m = JSON.parse(readFileSync(file, 'utf8')) as ToolsManifestFile;
  } catch (e) {
    throw new BundleError(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (m?.v !== 1 || !m.platforms || typeof m.platforms !== 'object') throw new BundleError(`${file} is not a version 1 tools manifest`);
  if (!Object.hasOwn(m.platforms, platform)) throw new BundleError(`${file} lists no Tools for ${platform}`);
  return parseToolEntries(m.platforms[platform], `${file} (${platform})`, hosts);
}

const bundleEntries = new WeakMap<BundleInfo, ToolEntry[]>();

/** The Tools of the app this engine runs from (bundle.json `tools`), checked once per bundle; BundleError when damaged. */
export function bundleTools(bundle: BundleInfo): ToolEntry[] {
  let e = bundleEntries.get(bundle);
  if (!e) {
    e = parseToolEntries(bundle.manifest.tools, `${bundle.root}/bundle.json`);
    bundleEntries.set(bundle, e);
  }
  return e;
}

/** The Tools' folder (`<RETAKE_HOME>/tools`, bundle.ts toolsFolder). */
export function toolsDir(env: NodeJS.ProcessEnv = process.env): string {
  return toolsFolder(env);
}

/** An entry's folder under `dir` (the Tools' folder). */
export function toolFolder(entry: Pick<ToolEntry, 'folder'>, dir: string): string {
  return join(dir, ...entry.folder.split('/'));
}

/** The program a Tool is used through (its folder for the compositor). */
export function toolExecutable(entry: Pick<ToolEntry, 'folder' | 'executable'>, dir: string): string {
  return entry.executable === '.' ? toolFolder(entry, dir) : join(toolFolder(entry, dir), ...entry.executable.split('/'));
}

/** Is `p` inside the Tools' folder `dir` (lexically, once made absolute)? */
export function insideTools(p: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The installer's own entries of the Tools' folder (all dot names: a folder's tree digest never sees them). */
export const TOOLS_FILES = {
  lock: '.lock',
  state: '.state.json',
  partial: '.partial',
  started: '.started.json',
  pending: '.pending.json',
  control: '.control.json',
  inUse: '.in-use',
} as const;
/** The stamp an installed folder holds (inside it: a dot entry, so the tree digest leaves it out). */
export const VERIFIED_FILE = '.verified';

/** `.verified`: what the install checked, and the walk's figures the cheap state compares. */
export interface ToolStamp {
  v: 1;
  /** The tree digest the folder matched (the manifest's `tree` then). */
  tree: string;
  /** Entries (files, folders, links) and bytes of the files, as `treeSummary` counts them. */
  entries: number;
  bytes: number;
  /** When it was checked (ISO). */
  at: string;
  /** "Check again" found its tree digest changed (why): it stays damaged until it is installed again. */
  damaged?: string;
}

/** The state of one Tool as the cheap check reads it. */
export type ToolReadiness = 'ready' | 'missing' | 'damaged';
export interface ToolState {
  id: ToolId;
  state: ToolReadiness;
  /** The folder. */
  path: string;
  /** Why it is damaged (one line). */
  problem?: string;
}

/** Entries skipped by the tree digest and its summary: top-level dot entries (the stamp) and these names (the markers). */
function skipped(rel: string, skip: readonly string[]): boolean {
  const top = rel.split(sep)[0]!;
  return top.startsWith('.') || skip.includes(top);
}

/** Every path under `dir` (lstat, links not followed), depth first, as bundle.mjs `walk` lists them. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    out.push(p);
    if (e.isDirectory() && !e.isSymbolicLink()) walk(p, out);
  }
  return out;
}

/** The entries and file bytes of a folder, the digest's skips applied (lstat only: no file is read). */
export function treeSummary(dir: string, skip: readonly string[] = []): { entries: number; bytes: number } {
  let entries = 0;
  let bytes = 0;
  for (const p of walk(dir)) {
    if (skipped(relative(dir, p), skip)) continue;
    entries++;
    const st = lstatSync(p);
    if (st.isFile()) bytes += st.size;
  }
  return { entries, bytes };
}

async function fileSha256(p: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * A folder's tree digest — the stage's tree walk (apps/desktop/scripts/bundle.mjs `treeDigest`) hashed line by line,
 * here for the installer, "Check again" and record-tools (test/tools.test.ts pins the two against each other): every entry → `link <target>`, `dir` or
 * `file <size> <x|-> <sha256>`, top-level dot entries and `skip` names left out, the lines `<path>\t<what>\n` in path
 * order, hashed. Files are read as streams (a 400 MB browser does not block the event loop for its whole length).
 */
export async function treeDigest(dir: string, skip: readonly string[] = []): Promise<string> {
  const lines = new Map<string, string>();
  for (const p of walk(dir)) {
    const rel = relative(dir, p);
    if (skipped(rel, skip)) continue;
    const st = lstatSync(p);
    lines.set(rel, st.isSymbolicLink() ? `link ${readlinkSync(p)}` : st.isDirectory() ? 'dir' : `file ${st.size} ${st.mode & 0o111 ? 'x' : '-'} ${await fileSha256(p)}`);
  }
  const h = createHash('sha256');
  for (const k of [...lines.keys()].sort()) h.update(`${k.split(sep).join('/')}\t${lines.get(k)}\n`);
  return h.digest('hex');
}

/** The stamp of an installed folder, or null when it is missing or not one. */
export function readStamp(folder: string): ToolStamp | null {
  try {
    const s = JSON.parse(readFileSync(join(folder, VERIFIED_FILE), 'utf8')) as ToolStamp;
    return s && s.v === 1 && typeof s.tree === 'string' && Number.isSafeInteger(s.entries) && Number.isSafeInteger(s.bytes) ? s : null;
  } catch {
    return null;
  }
}

/** Why the folder (or the Tools' folder above it) may not be trusted as this user's own, or undefined. */
export function ownerProblem(p: string, uid: number | undefined = process.getuid?.()): string | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    return undefined;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${p} is not a folder`;
  if (uid !== undefined && st.uid !== uid) return `${p} belongs to another user`;
  if (st.mode & 0o022) return `${p} may be written by other users`;
  return undefined;
}

/**
 * The cheap state of one installed Tool (no file read but its stamp): `missing` when its folder is not there; `damaged`
 * when it is not a real folder of this user that only they may write, a marker is missing, its stamp is missing or
 * names another tree digest than the manifest's, or the folder's entries or bytes are no longer the stamp's; else
 * `ready`. `walk: false` leaves the summary out (the queue's gate: a stamp and markers only).
 */
export function toolState(entry: ToolEntry, dir: string, o: { walk?: boolean } = {}): ToolState {
  const path = toolFolder(entry, dir);
  const base = { id: entry.id, path };
  try {
    lstatSync(path);
  } catch {
    return { ...base, state: 'missing' };
  }
  const damaged = (problem: string): ToolState => ({ ...base, state: 'damaged', problem });
  const owner = ownerProblem(dir) ?? (entry.folder.includes('/') ? ownerProblem(join(dir, TOOLS_BROWSERS_DIR)) : undefined) ?? ownerProblem(path);
  if (owner) return damaged(owner);
  for (const m of entry.markers ?? []) {
    try {
      lstatSync(join(path, m));
    } catch {
      return damaged(`its marker ${m} is missing`);
    }
  }
  const stamp = readStamp(path);
  if (!stamp) return damaged('it was never checked (no .verified stamp)');
  if (stamp.damaged) return damaged(`its last check found its files changed (${stamp.damaged})`);
  if (stamp.tree !== entry.tree) return damaged(`it was checked against another tree digest (${stamp.tree.slice(0, 12)}…) than this version records`);
  if (o.walk !== false) {
    let sum: { entries: number; bytes: number };
    try {
      sum = treeSummary(path, entry.markers ?? []);
    } catch (e) {
      return damaged(`it cannot be read (${e instanceof Error ? e.message : String(e)})`);
    }
    if (sum.entries !== stamp.entries || sum.bytes !== stamp.bytes)
      return damaged(`its files changed since they were checked (${sum.entries} entries, ${sum.bytes} bytes; checked: ${stamp.entries}, ${stamp.bytes})`);
  }
  return { ...base, state: 'ready' };
}

/** The cheap state of every Tool of a manifest (in install order). */
export function toolsState(entries: readonly ToolEntry[], dir: string, o: { walk?: boolean } = {}): ToolState[] {
  return entries.map((e) => toolState(e, dir, o));
}

/** How a sentence names each Tool. */
export const TOOL_WORDS: Readonly<Record<ToolId, string>> = { browser: 'the browser', 'render-browser': 'the render browser', compositor: 'the compositor' };

/**
 * The Tool a launch of `b` (a project's `browser:`) starts — runner-web launchTarget's rule, here so the queue's gate
 * and the CLI's refusal read it the same way: none for a browser of the person's own (`browser.executable`, an
 * installed channel such as `chrome`); the render browser for the headless shell (`headless-shell`, headless); else the
 * browser. `$RETAKE_CHROMIUM` (another browser for every launch) is the caller's to honour.
 */
export function launchTool(b: { executable?: string | undefined; channel?: string | undefined } | undefined, headless: boolean): ToolId | null {
  if (b?.executable) return null;
  const channel = b?.channel === 'headless-shell' ? undefined : (b?.channel ?? 'chromium');
  if (channel === 'chromium' || (channel === undefined && !headless)) return 'browser';
  return channel === undefined ? 'render-browser' : null;
}

/** The need a Tool is part of (NEED_TOOLS): the browser, or the render tools; null for none. */
export function toolNeedOf(id: ToolId | null): ToolNeed | null {
  return id === null ? null : id === 'browser' ? 'browser' : 'render';
}

/** What a person runs to download the Tools (the Studio's set-up sheet does the same). */
export const TOOLS_INSTALL_COMMAND = 'retake tools install';

/**
 * Why the app's Tool `id` cannot be used now (one sentence saying what to do), or undefined: it is ready, or this
 * engine runs from a checkout (`bundle` null: Playwright's cache and node_modules, as before). `walk: false`: the stamp
 * and markers only.
 */
export function toolProblem(id: ToolId, env: NodeJS.ProcessEnv, bundle: BundleInfo | null, o: { walk?: boolean } = {}): string | undefined {
  if (!bundle) return undefined;
  const entry = bundleTools(bundle).find((e) => e.id === id)!;
  const dir = toolsDir(env);
  const s = toolState(entry, dir, o);
  if (s.state === 'ready') return undefined;
  if (s.state === 'missing') return `${TOOL_WORDS[id]} is not downloaded yet (${s.path}): run \`${TOOLS_INSTALL_COMMAND}\`, or Download in the Studio's set-up`;
  return `${TOOL_WORDS[id]} in ${s.path} is damaged (${s.problem}): run \`retake tools check\`, then \`${TOOLS_INSTALL_COMMAND}\``;
}

/** The program of the app's Tool `id` under `env`'s home (its folder for the compositor); null in a checkout. */
export function appToolPath(id: ToolId, env: NodeJS.ProcessEnv, bundle: BundleInfo | null): string | null {
  if (!bundle) return null;
  return toolExecutable(bundleTools(bundle).find((e) => e.id === id)!, toolsDir(env));
}
