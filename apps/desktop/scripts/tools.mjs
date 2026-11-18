/**
 * The Tools the app downloads instead of carrying them (DESIGN §4p): the browser, the render browser and the compositor,
 * recorded per release in apps/desktop/bundle/tools.json and copied by the stage into bundle.json's `tools`.
 *
 * `node apps/desktop/scripts/bundle.mjs record-tools --from <folder of archives> [--out <file>]` (or `--fetch <folder>`:
 * the archives downloaded first, from the URLs the repository's pins name, each redirect hop on the Tools' hosts only):
 * each archive's size, sha256 (and the npm sha512 of the compositor's tarball, which must be the lockfile's), the
 * archive extracted by the installer's own code (packages/engine/dist/tools: its listing rules, ditto / tar), the
 * installer scripts nothing runs pruned (`PRUNE`), then the tree digest and size of what is left (core treeDigest, the
 * digest the installer and "Check again" compare). It writes tools.json, then checks it as `check-tools --archives`
 * does: an install of the recorded file from those archives would pass.
 *
 * `node apps/desktop/scripts/bundle.mjs check-tools [--archives <folder> | --fetch <folder>]`: tools.json names exactly
 * what the repository pins — the revisions and browser version of its playwright-core, the compositor version and
 * integrity of pnpm-lock.yaml, the URLs, folders and layout that follow from them (`toolsProblems`). With archives (or
 * once downloaded by the installer's downloader, the recorded size the cap), each archive is the recorded one and
 * extracts to the recorded tree (`checkArchives`: the installer's verifyTree).
 *
 * Nothing here runs at load: the release workflow's sign job imports bundle.mjs (and so this module) with no build of
 * the packages; core's and the engine's dist are loaded by the functions that need them.
 */
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(APP_DIR, '..', '..');
/** The committed manifest. */
export const TOOLS_FILE = join(APP_DIR, 'bundle', 'tools.json');
/** Our own short notices, one per Tool (`<id>.md`): never fetched; the stage refuses one that does not name its Tool. */
export const TOOL_NOTICES = join(APP_DIR, 'licenses', 'tools');
/** The platform the app is built for (the release is Apple silicon only for now). */
export const TOOLS_PLATFORM = 'darwin-arm64';
/** Playwright's marker files, written by the installer after the tree check (the browsers only). */
export const PLAYWRIGHT_MARKERS = ['INSTALLATION_COMPLETE', 'DEPENDENCIES_VALIDATED'];
/** The largest archive a recording downloads (the recorded size is the cap of every later download). */
const RECORD_MAX_BYTES = 2 * 1024 ** 3;
const CFT = 'https://storage.googleapis.com/chrome-for-testing-public';
const NPM = 'https://registry.npmjs.org';
/** The compositor's npm package (the lockfile's entry, the tarball's URL). */
export const COMPOSITOR_PACKAGE = '@remotion/compositor-darwin-arm64';

/** A Tool's pin, archive or manifest refused: one sentence that says what to do. */
export class ToolsError extends Error {}

/**
 * What each Tool is, beyond what its pins give (its version, revision, integrity): its words, its archive's kind and
 * layout, the program it is used through (`executable(dir)`: found in the extracted tree), and `prune` — the files
 * removed before the tree check, each a pattern whose `*` stands for one path segment (part of one), each required
 * to match: the browser framework's self-install script, which can run as root and nothing of Retake runs.
 */
export const TOOL_DEFS = {
  'render-browser': {
    label: 'Render browser',
    name: 'Chrome Headless Shell',
    publisher: 'Google',
    licence: "Google's terms for Chrome for Testing",
    archive: 'zip',
    zip: 'chrome-headless-shell-mac-arm64.zip',
    playwright: 'chromium-headless-shell',
    folder: (rev) => `browsers/chromium_headless_shell-${rev}`,
    markers: PLAYWRIGHT_MARKERS,
    prune: [],
    executable: () => 'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  },
  compositor: {
    label: 'Compositor',
    name: 'Remotion compositor',
    publisher: 'Remotion',
    licence: "Remotion's licence; its FFmpeg build: GPL v2 or later",
    archive: 'tgz',
    root: 'package',
    folder: (version) => `compositor-${version}`,
    prune: [],
    executable: () => '.',
  },
  browser: {
    label: 'Browser',
    name: 'Chrome for Testing',
    publisher: 'Google',
    licence: "Google's terms for Chrome for Testing",
    archive: 'zip',
    zip: 'chrome-mac-arm64.zip',
    playwright: 'chromium',
    folder: (rev) => `browsers/chromium-${rev}`,
    markers: PLAYWRIGHT_MARKERS,
    prune: ['chrome-mac-arm64/*.app/Contents/Frameworks/*.framework/Versions/*/Resources/install.sh'],
    // The one app of the archive's folder, run through its Contents/MacOS program of the same name.
    executable: (dir) => {
      const apps = readdirSync(join(dir, 'chrome-mac-arm64')).filter((n) => n.endsWith('.app'));
      if (apps.length !== 1) throw new ToolsError(`chrome-mac-arm64 holds ${apps.length} apps, not one`);
      return `chrome-mac-arm64/${apps[0]}/Contents/MacOS/${apps[0].slice(0, -'.app'.length)}`;
    },
  },
};

/** The Tools in their install order (core TOOL_IDS: the order tools.json lists them). */
export const TOOL_ORDER = ['render-browser', 'compositor', 'browser'];

const IO = join(REPO, 'packages', 'core', 'dist', 'io', 'tools.js');
const ENGINE_TOOLS = join(REPO, 'packages', 'engine', 'dist', 'tools');

/** core's io/tools module (builtin-only: loaded synchronously), from the packages' build. */
export function coreTools() {
  if (!existsSync(IO)) throw new ToolsError('run pnpm build first (the Tools are checked with packages/core/dist)');
  return createRequire(import.meta.url)(IO);
}

/** What core's check answers, its refusal (a BundleError: one sentence) as a ToolsError. */
function coreChecked(check) {
  try {
    return check();
  } catch (e) {
    if (e?.name === 'BundleError') throw new ToolsError(e.message);
    throw e;
  }
}

/** The installer's own modules (extraction, tree rules, download), from the packages' build. */
async function engineTools() {
  if (!existsSync(join(ENGINE_TOOLS, 'extract.js'))) throw new ToolsError('run pnpm build first (the Tools are extracted with packages/engine/dist)');
  const load = (m) => import(pathToFileURL(join(ENGINE_TOOLS, m)).href);
  const [extract, archive, download] = await Promise.all([load('extract.js'), load('archive.js'), load('download.js')]);
  return { ...extract, ...archive, ...download };
}

// ——— What the repository pins ———

/**
 * What the repository pins of the Tools: the browser version and revisions of its playwright-core (`playwright`: a
 * playwright-core folder; every playwright-core of the packages must agree) and the compositor's version and
 * integrity in pnpm-lock.yaml (one entry). Error naming what disagrees otherwise.
 */
export function repoPins({ repo = REPO, playwright, lockfile = join(repo, 'pnpm-lock.yaml') } = {}) {
  const read = (dir) => JSON.parse(readFileSync(join(dir, 'browsers.json'), 'utf8')).browsers;
  const dirs = playwright ? [playwright] : readdirSync(join(repo, 'packages')).map((p) => join(repo, 'packages', p, 'node_modules', 'playwright-core')).filter((d) => existsSync(join(d, 'browsers.json')));
  if (!dirs.length) throw new ToolsError('no playwright-core in the packages: run pnpm install');
  const pinOf = (dir) => Object.fromEntries(['chromium', 'chromium-headless-shell'].map((name) => {
    const b = read(dir).find((x) => x.name === name);
    if (!b?.revision || !b.browserVersion) throw new ToolsError(`${join(dir, 'browsers.json')} pins no ${name}`);
    return [name, { revision: b.revision, version: b.browserVersion }];
  }));
  const pins = dirs.map(pinOf);
  for (const [i, p] of pins.entries()) if (JSON.stringify(p) !== JSON.stringify(pins[0])) throw new ToolsError(`the packages' playwright-core copies pin different browsers (${dirs[0]}, ${dirs[i]})`);
  const lock = readFileSync(lockfile, 'utf8');
  const re = new RegExp(`^  '${COMPOSITOR_PACKAGE.replace(/[/.]/g, '\\$&')}@([^']+)':\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/]+=*)\\}`, 'gm');
  const found = [...lock.matchAll(re)];
  if (found.length !== 1) throw new ToolsError(`${lockfile} lists ${found.length} ${COMPOSITOR_PACKAGE} packages, not one`);
  return {
    browser: pins[0].chromium,
    'render-browser': pins[0]['chromium-headless-shell'],
    compositor: { version: found[0][1], integrity: found[0][2] },
  };
}

/** What tools.json must say of each Tool, from the pins: its version, folder, URL (and integrity). */
export function wantedTools(pins) {
  const out = {};
  for (const id of TOOL_ORDER) {
    const d = TOOL_DEFS[id];
    const p = pins[id];
    out[id] =
      id === 'compositor'
        ? { version: p.version, folder: d.folder(p.version), url: `${NPM}/${COMPOSITOR_PACKAGE}/-/${COMPOSITOR_PACKAGE.split('/')[1]}-${p.version}.tgz`, integrity: p.integrity }
        : { version: p.version, folder: d.folder(p.revision), url: `${CFT}/${p.version}/mac-arm64/${d.zip}` };
  }
  return out;
}

/**
 * How `entries` (tools.json's, checked by core) differ from what the pins want: one problem per field — the version,
 * the folder (the revision Playwright looks for), the URL (the publisher's), the compositor's integrity, the fixed
 * words and layout of TOOL_DEFS. [] when they agree.
 */
export function toolsProblems(entries, pins) {
  const want = wantedTools(pins);
  const problems = [];
  const ids = entries.map((e) => e.id);
  if (JSON.stringify(ids) !== JSON.stringify(TOOL_ORDER)) problems.push(`tools.json lists ${ids.join(', ')}, not ${TOOL_ORDER.join(', ')}`);
  for (const e of entries) {
    const w = want[e.id];
    const d = TOOL_DEFS[e.id];
    if (!w) continue;
    const fixed = { ...w, label: d.label, name: d.name, publisher: d.publisher, licence: d.licence, archive: d.archive, root: d.root, markers: d.markers, integrity: w.integrity };
    for (const [k, v] of Object.entries(fixed)) {
      if (JSON.stringify(e[k]) !== JSON.stringify(v)) problems.push(`tools.json ${e.id}: ${k} is ${JSON.stringify(e[k]) ?? 'missing'}, the repository pins ${JSON.stringify(v) ?? 'none'}`);
    }
  }
  return problems;
}

/** tools.json's entries for the app's platform, checked by core (shape, hosts), then against the pins. Error otherwise. */
export function readTools(file = TOOLS_FILE, pins = repoPins()) {
  const entries = coreChecked(() => coreTools().readToolsManifest(file, TOOLS_PLATFORM));
  const problems = toolsProblems(entries, pins);
  if (problems.length) throw new ToolsError(`${relative(REPO, file)} does not match the repository's pins — record it again (node apps/desktop/scripts/bundle.mjs record-tools --from <archives>):\n  ${problems.join('\n  ')}`);
  return entries;
}

/**
 * Why our notices (licenses/tools/<id>.md) do not describe `entries`: a notice missing, one for no Tool, or one that
 * does not name its Tool's name, version, publisher or download host. [] when they do.
 */
export function noticeProblems(entries, dir = TOOL_NOTICES) {
  const problems = [];
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
  for (const f of files) if (!entries.some((e) => `${e.id}.md` === f)) problems.push(`licenses/tools/${f} describes no Tool of tools.json`);
  for (const e of entries) {
    const file = join(dir, `${e.id}.md`);
    if (!existsSync(file)) {
      problems.push(`licenses/tools/${e.id}.md is missing (the ${e.label.toLowerCase()}'s notice)`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    for (const [what, words] of [['name', e.name], ['version', e.version], ['publisher', e.publisher], ['download host', new URL(e.url).hostname]]) {
      if (!text.includes(words)) problems.push(`licenses/tools/${e.id}.md does not name its ${what} (${words}): update it with tools.json`);
    }
  }
  return problems;
}

// ——— Archives: found, downloaded, hashed, extracted ———

/** The archive of `url` in a folder of archives: `<dir>/<file name of the URL>`, or one folder below (the installer's rule). */
export function archiveIn(dir, url) {
  const name = basename(new URL(url).pathname);
  if (existsSync(join(dir, name))) return join(dir, name);
  for (const sub of readdirSync(dir, { withFileTypes: true })) if (sub.isDirectory() && existsSync(join(dir, sub.name, name))) return join(dir, sub.name, name);
  return null;
}

function hashOf(file, algo, encoding = 'hex') {
  return new Promise((ok, fail) => {
    const h = createHash(algo);
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', fail)
      .on('end', () => ok(h.digest(encoding)));
  });
}

/**
 * GET `url` into `<dir>/<file name of the URL>` for a recording: every hop on the Tools' hosts (the installer's getTool),
 * no content encoding, at most RECORD_MAX_BYTES. Returns the file; the chain of hops is logged.
 */
export async function fetchForRecord(url, dir, { fetch, hosts, log = () => {} }) {
  const e = await engineTools();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, basename(new URL(url).pathname));
  const hops = [];
  const res = await e.getTool({ fetch: (u, init) => (hops.push(u), fetch(u, init)), ...(hosts ? { hosts } : {}) }, url, 0);
  if (res.status !== 200) throw new ToolsError(`${url} answered ${res.status}`);
  const enc = res.headers.get('content-encoding');
  if (enc && enc.toLowerCase() !== 'identity') throw new ToolsError(`${url} came with Content-Encoding ${enc}: the bytes hashed must be the bytes sent`);
  const fd = openSync(file, 'w');
  let n = 0;
  try {
    for await (const chunk of res.body) {
      n += chunk.length;
      if (n > RECORD_MAX_BYTES) throw new ToolsError(`${url} sent more than ${RECORD_MAX_BYTES} bytes`);
      writeSync(fd, chunk);
    }
  } finally {
    closeSync(fd);
  }
  log(`${url}: ${n} bytes${hops.length > 1 ? ` (through ${hops.join(' → ')})` : ''}`);
  return file;
}

/** The paths of `dir` a PRUNE pattern names (relative, `/`-separated), never through a link. */
export function pruneMatches(dir, pattern) {
  let level = [''];
  for (const part of pattern.split('/')) {
    const re = new RegExp(`^${part.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    level = level.flatMap((rel) => {
      const at = join(dir, ...rel.split('/').filter(Boolean));
      const st = lstatSync(at, { throwIfNoEntry: false });
      if (!st?.isDirectory()) return [];
      return readdirSync(at)
        .filter((n) => re.test(n))
        .map((n) => (rel ? `${rel}/${n}` : n));
    });
  }
  return level.filter((rel) => lstatSync(join(dir, ...rel.split('/'))).isFile()).sort();
}

const within = (dir, p) => {
  const rel = relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Record one Tool from its archive: size, sha256 (the compositor's sha512 must be the lockfile's integrity), extracted by
 * the installer's code into `scratch`, the tree rules, PRUNE removed, then the tree digest and size. Returns the entry.
 */
async function recordOne(id, archive, want, scratch) {
  const d = TOOL_DEFS[id];
  const core = coreTools();
  const e = await engineTools();
  const bytes = statSync(archive).size;
  const sha256 = await hashOf(archive, 'sha256');
  if (want.integrity) {
    const got = `sha512-${await hashOf(archive, 'sha512', 'base64')}`;
    if (got !== want.integrity) throw new ToolsError(`${archive} is not the ${COMPOSITOR_PACKAGE} pnpm-lock.yaml pins (integrity ${got}, pinned ${want.integrity})`);
  }
  const into = join(scratch, id);
  await e.extractArchive({ archive: d.archive, ...(d.root ? { root: d.root } : {}) }, archive, into);
  const bad = e.treeProblem(into);
  if (bad) throw new ToolsError(`${archive}: the extracted tree is refused: ${bad}`);
  const prune = [];
  for (const pattern of d.prune) {
    const found = pruneMatches(into, pattern);
    if (!found.length) throw new ToolsError(`${archive}: nothing matches the pruned ${pattern} (has the layout changed? update TOOL_DEFS in apps/desktop/scripts/tools.mjs)`);
    prune.push(...found);
  }
  const real = realpathSync(into);
  for (const rel of prune) {
    const p = join(into, ...rel.split('/'));
    if (!within(real, realpathSync(dirname(p)))) throw new ToolsError(`${rel}: its folder lies outside the tree`);
    rmSync(p);
  }
  const markers = d.markers ?? [];
  const executable = d.executable(into);
  const program = executable === '.' ? into : join(into, ...executable.split('/'));
  const st = lstatSync(program, { throwIfNoEntry: false });
  if (!st || (executable !== '.' && !(st.isFile() && st.mode & 0o111))) throw new ToolsError(`${archive}: no program at ${executable}`);
  const entry = {
    id,
    label: d.label,
    name: d.name,
    version: want.version,
    publisher: d.publisher,
    licence: d.licence,
    folder: want.folder,
    url: want.url,
    archive: d.archive,
    bytes,
    sha256,
    ...(want.integrity ? { integrity: want.integrity } : {}),
    ...(d.root ? { root: d.root } : {}),
    ...(prune.length ? { prune } : {}),
    tree: await core.treeDigest(into, markers),
    disk: core.treeSummary(into, markers).bytes,
    executable,
    ...(d.markers ? { markers: d.markers } : {}),
  };
  rmSync(into, { recursive: true, force: true });
  return entry;
}

/** What tools.json says of itself. */
export const TOOLS_ABOUT =
  "The Tools this version of the app downloads on the person's click into <RETAKE_HOME>/tools (DESIGN §4p) instead of carrying them: per platform, each archive's publisher URL, size and sha256 (checked before anything is extracted; the compositor's npm integrity is the lockfile's), and the tree digest of the extracted folder once its `prune` paths are removed (checked after extraction, and by Check again). Recorded from the real archives with `node apps/desktop/scripts/bundle.mjs record-tools --from <folder of archives>`; `check-tools` checks this file against the repository's playwright-core and pnpm-lock.yaml.";

/**
 * Record tools.json (`out`, default the committed file) from a folder of archives (`from`) or from the publishers
 * (`fetchInto`: a folder the archives are downloaded to, with `fetch`). `pins`: what the repository pins (repoPins;
 * tests hand their own, with `hosts`). The result is checked before it is written (core's parser, toolsProblems) and
 * after (checkArchives). Returns the entries.
 */
export async function recordTools({ from, fetchInto, fetch = globalThis.fetch, pins = repoPins(), out = TOOLS_FILE, hosts, log = () => {} }) {
  if (!from === !fetchInto) throw new ToolsError('record-tools --from <folder of archives> | --fetch <folder to download them to>');
  const want = wantedTools(pins);
  const scratch = mkdtempSync(join(tmpdir(), 'retake-record-tools-'));
  try {
    const entries = [];
    for (const id of TOOL_ORDER) {
      let archive;
      if (from) {
        archive = archiveIn(resolve(from), want[id].url);
        if (!archive) throw new ToolsError(`${from} holds no ${basename(new URL(want[id].url).pathname)} (the ${TOOL_DEFS[id].label.toLowerCase()} of ${want[id].url})`);
      } else archive = await fetchForRecord(want[id].url, resolve(fetchInto), { fetch, hosts, log });
      const entry = await recordOne(id, archive, want[id], scratch);
      log(`${id}: ${entry.bytes} bytes, sha256 ${entry.sha256}, tree ${entry.tree}, ${entry.disk} bytes extracted`);
      entries.push(entry);
    }
    coreChecked(() => coreTools().parseToolEntries(entries, 'record-tools', hosts));
    const problems = toolsProblems(entries, pins);
    if (problems.length) throw new ToolsError(`the recorded Tools do not match the pins:\n  ${problems.join('\n  ')}`);
    const after = await checkArchives(entries, from ? resolve(from) : resolve(fetchInto));
    if (after.length) throw new ToolsError(`the recorded Tools fail their own check:\n  ${after.join('\n  ')}`);
    writeFileSync(out, `${JSON.stringify({ v: 1, about: TOOLS_ABOUT, platforms: { [TOOLS_PLATFORM]: entries } }, null, 1)}\n`);
    return entries;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Each entry's archive in `dir` is the recorded one and installs as the installer would install it: size, sha256 (and
 * a tarball's integrity) first, then extracted by the installer's code and checked by its verifyTree (tree rules,
 * prune, tree digest). Returns the problems ([]: all pass).
 */
export async function checkArchives(entries, dir) {
  const e = await engineTools();
  const problems = [];
  const scratch = mkdtempSync(join(tmpdir(), 'retake-check-tools-'));
  try {
    for (const entry of entries) {
      const archive = archiveIn(dir, entry.url);
      if (!archive) {
        problems.push(`${entry.id}: no ${basename(new URL(entry.url).pathname)} in ${dir}`);
        continue;
      }
      const bytes = statSync(archive).size;
      if (bytes !== entry.bytes) {
        problems.push(`${entry.id}: ${archive} is ${bytes} bytes, tools.json records ${entry.bytes}`);
        continue;
      }
      const sha = await hashOf(archive, 'sha256');
      if (sha !== entry.sha256) {
        problems.push(`${entry.id}: ${archive} has sha256 ${sha}, tools.json records ${entry.sha256}`);
        continue;
      }
      if (entry.integrity && `sha512-${await hashOf(archive, 'sha512', 'base64')}` !== entry.integrity) {
        problems.push(`${entry.id}: ${archive} is not the tarball of integrity ${entry.integrity}`);
        continue;
      }
      const into = join(scratch, entry.id);
      try {
        await e.extractArchive(entry, archive, into);
        await e.verifyTree(entry, into, { now: () => Date.now() });
      } catch (err) {
        problems.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        e.makeWritable(into);
        rmSync(into, { recursive: true, force: true });
      }
    }
    return problems;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Download each entry's archive into `dir` with the installer's own downloader (the allow-list per hop, the recorded
 * size as the cap, no content encoding, resumed when cut), then `checkArchives`. Returns the problems.
 */
export async function fetchAndCheck(entries, dir, { fetch = globalThis.fetch, hosts } = {}) {
  const e = await engineTools();
  mkdirSync(dir, { recursive: true });
  const problems = [];
  for (const entry of entries) {
    try {
      const part = await e.downloadArchive({ entry, partial: dir, fetch, ...(hosts ? { hosts } : {}), clock: { monotonic: () => performance.now() } });
      // Under the URL's file name (what checkArchives looks for); the downloader's own record is not needed here.
      renameSync(part, join(dir, basename(new URL(entry.url).pathname)));
      rmSync(`${part}.json`, { force: true });
    } catch (err) {
      problems.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (problems.length) return problems;
  return checkArchives(entries, dir);
}
