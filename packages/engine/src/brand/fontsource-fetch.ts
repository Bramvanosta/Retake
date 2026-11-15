/**
 * A font fetch (R-FLD-45, R-SEC-42): `font_fetch {refs}` through MCP, after a person's approval, and `retake theme
 * fetch-font <ref>…`, the person's own act — the only code that downloads a font, and the only writer of the
 * workspace's font store (fontsource-store.ts). A theme's create, update and the Studio never fetch: they read the store.
 *
 * What is fetched, from where: a fontsource package, `@fontsource/<id>`, from the font registry port (the product's:
 * https://registry.npmjs.org, fonts/npm-registry.ts) — at most FETCH_MAX_PACKAGES packages and FETCH_MAX_BYTES bytes in
 * one call, under one deadline. For each package:
 * 1. the version's manifest (≤ 1 MB): its name is the package's; its version an exact one (the one asked when pinned —
 *    else the registry's `latest`, resolved now and recorded); its licence exactly OFL-1.1 or Apache-2.0, as the
 *    publisher declares it (no expression); its tarball URL exactly the one the registry's base and the layout give
 *    (compared as text, never followed as given); its integrity a sha512 SRI — equal to the one the store recorded when
 *    that version was fetched before;
 * 2. the tarball (≤ 30 MB), whose sha512 is compared with the integrity before a byte of it is parsed;
 * 3. its archive read in memory (tar.ts: unpacked ≤ 200 MB, ≤ 20 000 entries), keeping only package.json (its name,
 *    version and licence agreeing with the manifest), the LICENSE (required: it goes into every theme that uses the
 *    font) and the latin WOFF2 of each face asked — a face the package lacks is `invalid`, its latin faces listed;
 * 4. each WOFF2 checked as a font (files.ts sniffFont), then the package's folder written into the store.
 * A pinned version whose every face asked is stored already is not fetched again (no network, no question).
 *
 * Through MCP (and any agent caller) a person approves in a form BEFORE any network contact: the registry as it is
 * (the test hatch's loopback one said as such), each package and the version asked, the faces, and that nothing else
 * is fetched (fontsource-approval.ts). The CLI is the person's own act: no form.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stampOf } from '../clock.js';
import type { Clock } from '../clock.js';
import { FONTSOURCE_LICENCES, FONTSOURCE_VERSION_RE, formatFontsourceRef, fontsourcePackage, fontsourceRefProblem, parseFontsourceRef } from '@retake/core/theme';
import type { FontsourceRef } from '@retake/core/theme';
import { stateRef } from '@retake/core/project';
import { showHiddenCharsLine } from '@retake/core/base';
import { EngineError } from '../errors.js';
import type { Approver } from '../approvals.js';
import type { JobClient } from '../jobs/job-input.js';
import { FONTSOURCE_LAYOUT } from '../fonts/fontsource-layout.js';
import type { FontRegistry } from '../fonts/font-registry.js';
import { sha256Hex } from '../storage.js';
import type { OpenedWorkspace } from '../workspace.js';
import { FONT_MAX_BYTES, sniffFont } from './files.js';
import { takeFontsApproval } from './fontsource-approval.js';
import type { FontsApprovalRequest } from './fontsource-approval.js';
import { LICENCE_FILE, LICENCE_MAX_BYTES, fetchCommand, readStoreFile, readStoreRecord, storeFaceFile, writeStorePackage } from './fontsource-store.js';
import type { StoreRecord } from './fontsource-store.js';
import { readTarGz } from './tar.js';

export const FETCH_MAX_PACKAGES = 3;
export const FETCH_MAX_REFS = 32;
export const FETCH_MAX_BYTES = 60 * 1024 * 1024;
export const MANIFEST_MAX_BYTES = 1024 * 1024;
export const TARBALL_MAX_BYTES = 30 * 1024 * 1024;
export const UNPACKED_MAX_BYTES = 200 * 1024 * 1024;
export const ARCHIVE_MAX_ENTRIES = 20_000;
export const PACKAGE_JSON_MAX_BYTES = 64 * 1024;
export const FETCH_DEADLINE_MS = 120_000;

export const FontFetchInputSchema = z.strictObject({
  refs: z
    .array(
      z
        .string()
        .max(120)
        .superRefine((v, ctx) => {
          const p = fontsourceRefProblem(v);
          if (p) ctx.addIssue({ code: 'custom', message: p });
        }),
    )
    .min(1)
    .max(FETCH_MAX_REFS)
    .describe('fontsource:<id>[@<version>][:<weight>[italic]] — one per face (default weight 400), e.g. ["fontsource:inter@5.2.1:400", "fontsource:inter@5.2.1:600"].'),
});

export interface FontFetchFace {
  /** The reference to give a theme (`fonts.display` / `fonts.body`), version pinned. */
  ref: string;
  weight: number;
  italic: boolean;
  bytes: number;
  /** Fetched by this call, or stored already. */
  state: 'fetched' | 'stored';
}

export interface FontFetchPackage {
  package: string;
  /** The registry this package's stored files came from (the store's record), and whether it is a test one. */
  registry: string;
  test_registry: boolean;
  id: string;
  version: string;
  /** `latest` resolved by this call (the version is the registry's now; pin it next time). */
  resolved: boolean;
  licence: (typeof FONTSOURCE_LICENCES)[number];
  integrity: string;
  tarball: string;
  /** The package's folder in the store, relative to the workspace. */
  dir: string;
  faces: FontFetchFace[];
  /** This call downloaded its tarball (false: every face asked was stored already). */
  downloaded: boolean;
}

export interface FontFetched {
  registry: string;
  test_registry: boolean;
  packages: FontFetchPackage[];
  /** Every reference asked, pinned: what a theme names. */
  refs: string[];
  bytes_downloaded: number;
  warnings: string[];
}

interface Group {
  id: string;
  version?: string;
  faces: FontsourceRef[];
}

function parseRefs(raw: unknown): Group[] {
  const parsed = FontFetchInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EngineError('invalid', `invalid font fetch: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`);
  }
  const groups = new Map<string, Group>();
  const versions = new Map<string, Set<string>>();
  for (const text of parsed.data.refs) {
    const r = parseFontsourceRef(text)!;
    const key = `${r.id}@${r.version ?? ''}`;
    const g = groups.get(key) ?? { id: r.id, ...(r.version ? { version: r.version } : {}), faces: [] };
    if (!g.faces.some((f) => f.weight === r.weight && f.italic === r.italic)) g.faces.push(r);
    groups.set(key, g);
    (versions.get(r.id) ?? versions.set(r.id, new Set()).get(r.id)!).add(r.version ?? '');
  }
  for (const [id, v] of versions) {
    if (v.has('') && v.size > 1) throw new EngineError('invalid', `fontsource:${id} is asked both pinned and unpinned: give one version of ${fontsourcePackage(id)} per call`);
  }
  if (groups.size > FETCH_MAX_PACKAGES) throw new EngineError('invalid', `${groups.size} packages asked: at most ${FETCH_MAX_PACKAGES} per call (fetch the others in another call)`);
  return [...groups.values()];
}

/** Registry text in a message: quoted, cut, every hidden character written out (the registry's, not the tool's words). */
const quoted = (v: unknown, n: number) => (typeof v === 'string' ? `"${showHiddenCharsLine(v.slice(0, n))}"` : v === undefined || v === null ? 'null' : `a ${typeof v}`);

const SRI_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** The manifest's fields the fetch relies on (FONTSOURCE_LAYOUT.manifest), checked; refused with what differs. */
function checkManifest(json: unknown, g: Group, registry: FontRegistry): { version: string; licence: (typeof FONTSOURCE_LICENCES)[number]; tarball: string; integrity: string } {
  const pkg = fontsourcePackage(g.id);
  const f = FONTSOURCE_LAYOUT.manifest;
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const dist = (o[f.dist] && typeof o[f.dist] === 'object' ? o[f.dist] : {}) as Record<string, unknown>;
  const no = (why: string) => new EngineError('refused', `${pkg}: ${why} — nothing was fetched`);
  if (o[f.name] !== pkg) throw no(`the registry's manifest names another package (${quoted(o[f.name], 80)})`);
  const version = o[f.version];
  if (typeof version !== 'string' || !FONTSOURCE_VERSION_RE.test(version)) throw no('the manifest gives no exact version');
  if (g.version !== undefined && version !== g.version) throw no(`the manifest is of version ${version}, not ${g.version}`);
  const licence = o[f.licence];
  if (typeof licence !== 'string' || !(FONTSOURCE_LICENCES as readonly string[]).includes(licence)) {
    throw no(`its publisher declares the licence ${quoted(licence, 80)}: only ${FONTSOURCE_LICENCES.join(' or ')} (exactly) are fetched`);
  }
  const tarball = registry.base + FONTSOURCE_LAYOUT.tarballPath(g.id, version);
  if (dist[f.tarball] !== tarball) throw no(`the manifest's tarball is ${quoted(dist[f.tarball], 200)}, not ${tarball}: it is never followed`);
  const integrity = dist[f.integrity];
  if (typeof integrity !== 'string' || !SRI_RE.test(integrity)) throw no('the manifest gives no sha512 integrity');
  return { version, licence: licence as (typeof FONTSOURCE_LICENCES)[number], tarball, integrity };
}

function jsonOf(b: Buffer, what: string): unknown {
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    throw new EngineError('refused', `${what} is not JSON — nothing was fetched`);
  }
}

/** The faces a store folder holds already (verified), by file: kept when the package is written again. */
async function storedFaces(ws: OpenedWorkspace, id: string, version: string): Promise<{ record: StoreRecord; files: Map<string, Buffer> } | null> {
  const r = await readStoreRecord(ws, id, version);
  if (!r) return null;
  const files = new Map<string, Buffer>();
  for (const name of Object.keys(r.record.files)) files.set(name, await readStoreFile(r.dir, r.record, name, name === LICENCE_FILE ? LICENCE_MAX_BYTES : FONT_MAX_BYTES));
  return { record: r.record, files };
}

/** The approval form's request: the registry, each package and version asked, its faces, the command a person runs. */
export function fontsApprovalRequest(groups: Group[], registry: FontRegistry, fix: string): FontsApprovalRequest {
  return {
    what: 'fonts',
    registry: registry.base,
    test_registry: registry.test,
    packages: groups.map((g) => ({
      package: fontsourcePackage(g.id),
      version: g.version ?? null,
      faces: g.faces.map((f) => `${f.weight}${f.italic ? ' italic' : ''}`),
    })),
    fix,
  };
}

const dirOf = (id: string, version: string) => stateRef('fonts', 'fontsource', `${id}@${version}`);

/** A pinned version stored with every face asked: its answer from the store (no network, no question); else null. */
/**
 * A pinned version stored — from this same registry — with every face asked and its LICENSE, all as recorded: its answer
 * from the store (no network, no question); else null (fetched, where a broken stored package is refused with how to
 * clear it).
 */
async function fromStore(ws: OpenedWorkspace, g: Group, registry: FontRegistry): Promise<FontFetchPackage | null> {
  try {
    const stored = g.version !== undefined ? await readStoreRecord(ws, g.id, g.version) : null;
    if (!stored || stored.record.registry !== registry.base || !g.faces.every((f) => stored.record.files[storeFaceFile(f.weight, f.italic)])) return null;
    const rec = stored.record;
    await readStoreFile(stored.dir, rec, LICENCE_FILE, LICENCE_MAX_BYTES);
    const faces = await Promise.all(
      g.faces.map(async (f) => {
        const b = await readStoreFile(stored.dir, rec, storeFaceFile(f.weight, f.italic), FONT_MAX_BYTES);
        return { ref: formatFontsourceRef({ ...f, version: rec.package_version }), weight: f.weight, italic: f.italic, bytes: b.length, state: 'stored' as const };
      }),
    );
    return {
      package: rec.package,
      registry: rec.registry,
      test_registry: rec.test_registry,
      id: g.id,
      version: rec.package_version,
      resolved: false,
      licence: rec.licence,
      integrity: rec.integrity,
      tarball: rec.tarball,
      dir: dirOf(g.id, rec.package_version),
      faces,
      downloaded: false,
    };
  } catch {
    return null;
  }
}

/** The wanted entries of a package's verified tarball, checked: package.json agreeing, the LICENSE, every face missing. */
async function readPackage(tgz: Buffer, g: Group, version: string, licenceId: string, missing: FontsourceRef[]): Promise<{ licence: Buffer; faces: Map<string, Buffer> }> {
  const pkg = fontsourcePackage(g.id);
  const L = FONTSOURCE_LAYOUT;
  const wanted = new Map(missing.map((f) => [L.fontFile(g.id, f.weight, f.italic), f]));
  const latin = new Set<string>();
  const pattern = L.fontFilePattern(g.id);
  const entries = await readTarGz(tgz, {
    maxUnpacked: UNPACKED_MAX_BYTES,
    maxEntries: ARCHIVE_MAX_ENTRIES,
    want: (name) => {
      const m = pattern.exec(name);
      if (m) latin.add(`${m[1]}${m[2] === 'italic' ? ' italic' : ''}`);
      if (name === L.packageJson) return PACKAGE_JSON_MAX_BYTES;
      if (name === L.licenceFile) return LICENCE_MAX_BYTES;
      return wanted.has(name) ? FONT_MAX_BYTES : undefined;
    },
  });
  const pj = entries.get(L.packageJson);
  const p = (pj ? jsonOf(pj, `${pkg}'s package.json`) : null) as Record<string, unknown> | null;
  if (!p || p[L.manifest.name] !== pkg || p[L.manifest.version] !== version || p[L.manifest.licence] !== licenceId) {
    throw new EngineError('refused', `${pkg}@${version}: the package's own package.json does not agree with the registry's manifest (name, version, licence) — nothing was stored`);
  }
  const licence = entries.get(L.licenceFile);
  if (!licence) throw new EngineError('refused', `${pkg}@${version} has no LICENSE file: its licence text could not go with the fonts — nothing was stored`);
  const absent = missing.filter((m) => !entries.has(L.fontFile(g.id, m.weight, m.italic)));
  if (absent.length) {
    throw new EngineError('invalid', `${pkg}@${version} has no latin ${absent.map((a) => `${a.weight}${a.italic ? ' italic' : ''}`).join(', ')}: its latin faces are ${[...latin].sort().join(', ') || 'none'} — nothing was stored`);
  }
  const faces = new Map<string, Buffer>();
  for (const [name, face] of wanted) {
    const bytes = entries.get(name)!;
    sniffFont({ ref: formatFontsourceRef(face), ext: '.woff2', bytes }, `${pkg} ${face.weight}${face.italic ? ' italic' : ''}`);
    faces.set(storeFaceFile(face.weight, face.italic), bytes);
  }
  return { licence, faces };
}

/** One package fetched (manifest, tarball, archive) and stored, or answered from what is stored of its version. */
async function fetchPackage(ws: OpenedWorkspace, g: Group, c: { registry: FontRegistry; clock: Clock; fix: string; get: (path: string, max: number) => Promise<Buffer> }): Promise<FontFetchPackage> {
  const pkg = fontsourcePackage(g.id);
  const L = FONTSOURCE_LAYOUT;
  const manifest = checkManifest(jsonOf(await c.get(L.manifestPath(g.id, g.version ?? L.latestTag), MANIFEST_MAX_BYTES), `${pkg}'s manifest`), g, c.registry);
  const prior = await storedFaces(ws, g.id, manifest.version);
  if (prior && prior.record.integrity !== manifest.integrity) {
    throw new EngineError('refused', `${pkg}@${manifest.version}: the registry now lists another tarball (integrity) than the one the store recorded when it was fetched — refused, nothing changed`, { fix: c.fix });
  }
  const faceRefs = g.faces.map((f) => ({ ...f, version: manifest.version }));
  // Files stored from another registry (a test one, say) are never kept as this one's: the same integrity, fetched again.
  const kept = prior && prior.record.registry === c.registry.base ? prior.files : new Map<string, Buffer>();
  const missing = faceRefs.filter((f) => !kept.has(storeFaceFile(f.weight, f.italic)));
  const files = new Map(kept);
  if (missing.length) {
    const tgz = await c.get(L.tarballPath(g.id, manifest.version), TARBALL_MAX_BYTES);
    // The integrity before any parse: a tarball that is not the registry's listed one is never read.
    const sri = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    if (sri !== manifest.integrity) throw new EngineError('refused', `${pkg}@${manifest.version}: the tarball's sha512 is not the integrity the registry lists — refused, nothing was read from it`);
    const read = await readPackage(tgz, g, manifest.version, manifest.licence, missing);
    for (const [name, bytes] of read.faces) files.set(name, bytes);
    files.set(LICENCE_FILE, read.licence);
    const hashes = Object.fromEntries([...files].map(([n, b]) => [n, sha256Hex(b)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    await writeStorePackage(
      ws,
      { kind: 'retake-font-package', version: 1, package: pkg, id: g.id, package_version: manifest.version, licence: manifest.licence, registry: c.registry.base, test_registry: c.registry.test, tarball: manifest.tarball, integrity: manifest.integrity, fetched_at: stampOf(c.clock), files: hashes },
      files,
    );
  }
  return {
    package: pkg,
    registry: c.registry.base,
    test_registry: c.registry.test,
    id: g.id,
    version: manifest.version,
    resolved: g.version === undefined,
    licence: manifest.licence,
    integrity: manifest.integrity,
    tarball: manifest.tarball,
    dir: dirOf(g.id, manifest.version),
    faces: faceRefs.map((f) => ({ ref: formatFontsourceRef(f), weight: f.weight, italic: f.italic, bytes: files.get(storeFaceFile(f.weight, f.italic))!.length, state: missing.includes(f) ? 'fetched' : 'stored' })),
    downloaded: missing.length > 0,
  };
}

/** Fetch fontsource packages into the store (see the module comment). `ask`: an agent's call — a person approves first. */
export async function fetchFonts(
  ws: OpenedWorkspace,
  raw: unknown,
  o: { registry: FontRegistry; clock: Clock; ask: boolean; approver?: Approver; client?: JobClient; deadlineMs?: number },
): Promise<FontFetched> {
  const groups = parseRefs(raw);
  const fix = fetchCommand(ws, groups.flatMap((g) => g.faces).map(formatFontsourceRef));
  const warnings: string[] = [];
  const out: FontFetchPackage[] = [];
  const todo: Group[] = [];
  for (const g of groups) {
    const stored = await fromStore(ws, g, o.registry);
    if (stored) {
      out.push(stored);
      if (stored.test_registry) warnings.push(`${stored.package}@${stored.version} in the store was fetched from a TEST registry (${stored.registry}): never use it outside tests`);
    } else todo.push(g);
  }
  const answer = (bytes: number): FontFetched => ({ registry: o.registry.base, test_registry: o.registry.test, packages: out, refs: out.flatMap((p) => p.faces.map((f) => f.ref)), bytes_downloaded: bytes, warnings });
  if (todo.length === 0) return answer(0);

  if (o.registry.problem) throw new EngineError('refused', o.registry.problem, { fix });
  if (o.ask) await takeFontsApproval(fontsApprovalRequest(todo, o.registry, fix), o.approver, o.client);
  if (o.registry.test) warnings.push(`fetched from a TEST registry (${o.registry.base}, RETAKE_UNSAFE_TEST_NPM_REGISTRY): never set outside tests`);

  const signal = AbortSignal.timeout(o.deadlineMs ?? FETCH_DEADLINE_MS);
  let downloaded = 0;
  const get = async (path: string, max: number) => {
    const b = await o.registry.get(path, { max: Math.min(max, FETCH_MAX_BYTES - downloaded), signal });
    downloaded += b.length;
    if (downloaded > FETCH_MAX_BYTES) throw new EngineError('refused', `more than ${FETCH_MAX_BYTES} bytes downloaded in one call`);
    return b;
  };
  for (const g of todo) out.push(await fetchPackage(ws, g, { registry: o.registry, clock: o.clock, fix, get }));
  return answer(downloaded);
}
