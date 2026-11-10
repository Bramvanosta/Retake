/**
 * The ids of the domain, one grammar each: a run id (a folder name of runs/), a render id
 * (`<scenario>-v<N>[-vertical|-square]`), the ULID ids (job, preview, inspection, site, recording, comment thread and
 * entry, capture marker) and a theme name (a theme that exists; a new theme). Their length caps, parsers and formatters
 * live here and nowhere else; their generators and zod helpers are in ids.ts.
 *
 * Pure: no clock, no randomness, no module state, no `node:` import.
 *
 * Rules of use:
 * - A capped id is tested with `is…` / `parse…`, never with `…_RE.test(x)` and a length beside it. The `…_RE`
 *   constants are exported for schemas (their `.source` is published as a JSON-schema `pattern`), for the Studio's
 *   mirror and for file-name patterns: a cap or a bound is never written into a source. A schema helper of ids.ts
 *   refuses what its predicate here refuses (`zRenderId` holds the version's bound in a refinement the published
 *   pattern cannot say).
 * - A branded type (`RunId`, `RenderId`, `JobId`, `ThemeName`, `NewThemeName`) comes from a predicate or a parse of
 *   this file only. Generators and formatters return plain strings: `formatRunId` of a long scenario name is not a
 *   run id, and `formatRenderId` takes any scenario text a timeline holds.
 * - A name is never rebuilt from a parsed id: `quote-v007` parses to version 7 and `formatRenderId('quote', 7)` is
 *   `quote-v7`. A path is built from the id string. One exception: a render worker rebuilds the file name from the
 *   parsed version of the render id it was submitted, which `formatRenderId` made.
 */
import { SLUG_RE } from './schemas/primitives.js';

declare const idBrand: unique symbol;
/** A string that passed the parse of its kind. */
export type Id<K extends string> = string & { readonly [idBrand]: K };
export type RunId = Id<'run'>;
export type RenderId = Id<'render'>;
export type JobId = Id<'job'>;
/** The name of any listed theme. */
export type ThemeName = Id<'theme'>;
declare const newThemeBrand: unique symbol;
/** A name a new theme may take (also a theme name). */
export type NewThemeName = ThemeName & { readonly [newThemeBrand]: true };

// ── Run ids ──────────────────────────────────────────────────────────────────

/** Longest run id. */
export const RUN_ID_MAX = 200;
/**
 * A folder name of runs/ ("20261017-142233-quote", or any other name of letters, digits, ".", "_" and "-" that starts
 * with a letter or a digit): one path segment, never a path. No length here: `isRunId`.
 */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Whether `v` is a run id: the folder grammar, at most RUN_ID_MAX characters. */
export function isRunId(v: unknown): v is RunId {
  return typeof v === 'string' && v.length <= RUN_ID_MAX && RUN_ID_RE.test(v);
}

/** `v` as a run id, or null. */
export function parseRunId(v: unknown): RunId | null {
  return isRunId(v) ? v : null;
}

const RUN_STAMP_RE = /^(\d{8})-(\d{6})-([\s\S]*)$/;
const MADE_REST_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The stamp a made run id starts with (`<yyyymmdd>-<hhmmss>-`) and what follows it (any text, empty included), or null. */
export function runIdStamp(id: string): { date: string; time: string; rest: string } | null {
  const m = RUN_STAMP_RE.exec(id);
  return m ? { date: m[1], time: m[2], rest: m[3] } : null;
}

/** Whether `id` is a run id of the shape the tool makes: a stamp, then lower-case letters, digits and dashes. */
export function isMadeRunId(id: string): id is RunId {
  const s = runIdStamp(id);
  return s !== null && MADE_REST_RE.test(s.rest) && isRunId(id);
}

/** The part of a made run id after its stamp, for a scenario name. */
function runSlug(scenario: string): string {
  return scenario.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

/**
 * Whether a run id is a run of `scenario`. A stamped id: what follows its stamp EQUALS the scenario's part (a run of
 * "mobile-quote" is not a run of "quote"; nothing after the stamp is a run of no scenario). An id in another format:
 * it ends in "-<scenario>".
 */
export function runIdOfScenario(id: string, scenario: string): boolean {
  const s = runIdStamp(id);
  return s ? s.rest === runSlug(scenario) : id.endsWith(`-${scenario}`);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * "20261011-142233-catalogue": the id of a run of `scenario` started at `date` (local time). A string, not a RunId:
 * a scenario name of more than 184 characters gives more than RUN_ID_MAX.
 */
export function formatRunId(scenario: string, date: Date): string {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}-${runSlug(scenario)}`
  );
}

// ── Render ids ───────────────────────────────────────────────────────────────

/** Longest render id. */
export const RENDER_ID_MAX = 200;
/** Highest version of a render. */
export const RENDER_VERSION_MAX = 999_999;

/** The body of SLUG_RE (a scenario name), to build ids made of one. */
const SLUG_BODY = SLUG_RE.source.replace(/^\^/, '').replace(/\$$/, '');
/**
 * A render id, the base name of renders/<id>.mp4 and .json: "<scenario>-v<N>", plus "-vertical" / "-square" for those
 * variants. Built from SLUG_RE: a scenario name may hold upper-case letters and "_". No length and no bound on the
 * version here: `isRenderId`.
 */
export const RENDER_ID_RE = new RegExp(`^${SLUG_BODY}-v\\d+(?:-vertical|-square)?$`);

/** What a render id ends in, per variant. */
export const RENDER_VARIANT_SUFFIX = { landscape: '', vertical: '-vertical', square: '-square' } as const;
export type RenderVariant = keyof typeof RENDER_VARIANT_SUFFIX;

const RENDER_SUFFIX_RE = /-v(\d+)(?:-(vertical|square))?$/;

/**
 * The last "-v<digits>[-vertical|-square]" a string ends in, and what precedes it (any string: no grammar, no cap, no
 * bound on the digits) — "quote-v2-v1" is stem "quote-v2", digits "1". Null when it does not end so.
 */
export function renderSuffix(s: string): { stem: string; digits: string; variant: RenderVariant } | null {
  const m = RENDER_SUFFIX_RE.exec(s);
  return m ? { stem: s.slice(0, m.index), digits: m[1], variant: m[2] === 'vertical' ? 'vertical' : m[2] === 'square' ? 'square' : 'landscape' } : null;
}

/**
 * `v` as a render id — the grammar, at most RENDER_ID_MAX characters, a version of at most RENDER_VERSION_MAX — with
 * the scenario, version (by value: "v007" is 7) and variant it names; null otherwise.
 */
export function parseRenderId(v: unknown): { id: RenderId; scenario: string; version: number; variant: RenderVariant } | null {
  if (typeof v !== 'string' || v.length > RENDER_ID_MAX || !RENDER_ID_RE.test(v)) return null;
  const s = renderSuffix(v);
  if (!s) return null;
  const version = Number(s.digits);
  if (!(version <= RENDER_VERSION_MAX)) return null;
  return { id: v as RenderId, scenario: s.stem, version, variant: s.variant };
}

/** Whether `v` is a render id. */
export function isRenderId(v: unknown): v is RenderId {
  return parseRenderId(v) !== null;
}

/** `v` as a render id of `scenario`, exactly (a render of "quote-v2" is not a render of "quote"); null otherwise. */
export function renderIdOf(v: unknown, scenario: string): { id: RenderId; version: number; variant: RenderVariant } | null {
  const p = parseRenderId(v);
  return p && p.scenario === scenario ? { id: p.id, version: p.version, variant: p.variant } : null;
}

function checkVersion(version: number): void {
  if (!Number.isInteger(version) || version < 0 || version > RENDER_VERSION_MAX) {
    throw new RangeError(`a render version is a whole number from 0 to ${RENDER_VERSION_MAX}, not ${String(version)}`);
  }
}

/**
 * "<scenario>-v<version>" and the variant's suffix. A string, not a RenderId: the scenario is whatever the caller
 * holds. A version that is not a whole number from 0 to RENDER_VERSION_MAX is a RangeError.
 */
export function formatRenderId(scenario: string, version: number, variant: RenderVariant): string {
  checkVersion(version);
  return `${scenario}-v${version}${RENDER_VARIANT_SUFFIX[variant]}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A reader of the version a file of renders/ takes for `name`: `<name>-v<N>[-vertical|-square]` with `.mp4`, `.json`
 * or `.lock`, with or without a leading dot (a pending lock, a partial file). `name` is read as it is written; the
 * digits are read as a number with no bound (a file that claims a huge version still counts). Null for any other file.
 * One pattern per name: a listing of renders/ takes the reader once and asks it for every file.
 */
export function renderFileVersionOf(name: string): (file: string) => number | null {
  const re = new RegExp(`^\\.?${escapeRe(name)}-v(\\d+)(?:-vertical|-square)?\\.(?:mp4|json|lock)$`);
  return (file) => {
    const m = re.exec(file);
    return m ? Number(m[1]) : null;
  };
}

/** The version one file of renders/ takes for `name` (renderFileVersionOf), or null. */
export function renderFileVersion(file: string, name: string): number | null {
  return renderFileVersionOf(name)(file);
}

/** The name of the lock file that reserves version `version` of `name` (`.<name>-v<N>.lock`); the RangeError of formatRenderId. */
export function renderLockName(name: string, version: number): string {
  checkVersion(version);
  return `.${name}-v${version}.lock`;
}

// ── ULID ids ─────────────────────────────────────────────────────────────────

/** The alphabet of a ULID (Crockford base32: no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A ULID, as a pattern: 26 Crockford base32 characters (10 of time, 16 random). */
export const ULID_BODY = '[0-9A-HJKMNP-TV-Z]{26}';
/** The prefix of each kind of id made of a ULID. */
export const ULID_PREFIXES = { job: 'j_', preview: 'p_', inspect: 'i_', site: 's_', record: 'rec_', comment: 'c_', entry: 'r_', marker: 'k_' } as const;
export type UlidKind = keyof typeof ULID_PREFIXES;

const ulidRe = (kind: UlidKind): RegExp => new RegExp(`^${ULID_PREFIXES[kind]}${ULID_BODY}$`);

/** A job id: "j_" + a ULID, sortable by creation. */
export const JOB_ID_RE = ulidRe('job');
/** A preview id, the folder <workspace>/.retake/previews/<id>/: "p_" + a ULID. */
export const PREVIEW_ID_RE = ulidRe('preview');
/** An inspection id, the folder <project>/.retake/inspect/<id>/: "i_" + a ULID. */
export const INSPECT_ID_RE = ulidRe('inspect');
/** A site extraction id, the folder <workspace>/.retake/site/<id>/: "s_" + a ULID. */
export const SITE_ID_RE = ulidRe('site');
/** A recording id, the folder of one recording: "rec_" + a ULID. */
export const RECORD_ID_RE = ulidRe('record');
/** A comment thread id, the file name comments/<scenario>/<id>.json: "c_" + a ULID. */
export const COMMENT_ID_RE = ulidRe('comment');
/** An entry id of a comment thread: "r_" + a ULID. */
export const COMMENT_ENTRY_ID_RE = ulidRe('entry');

/** The file name of an id of `kind` with the extension `ext` ("json"): `^<prefix><ULID>\.<ext>$`. */
export function ulidFileRe(kind: UlidKind, ext: string): RegExp {
  return new RegExp(`^${ULID_PREFIXES[kind]}${ULID_BODY}\\.${escapeRe(ext)}$`);
}

/** The time a ULID holds (ms, its first 10 characters); NaN when it has fewer or one is not of the alphabet. */
export function ulidTime(body: string): number {
  if (body.length < 10) return NaN;
  let ms = 0;
  for (let i = 0; i < 10; i++) {
    const v = CROCKFORD.indexOf(body[i]);
    if (v < 0) return NaN;
    ms = ms * 32 + v;
  }
  return ms;
}

/** The ULID of a time and 16 values of 0…31 (ids.ts draws them). */
export function formatUlid(ms: number, random: readonly number[]): string {
  let time = '';
  for (let i = 9, v = ms; i >= 0; i--, v = Math.floor(v / 32)) time = CROCKFORD[v % 32] + time;
  return `${time}${random.map((n) => CROCKFORD[n]).join('')}`;
}

/** Whether `v` is a job id. */
export function isJobId(v: unknown): v is JobId {
  return typeof v === 'string' && JOB_ID_RE.test(v);
}

/** `v` as a job id, or null. */
export function parseJobId(v: unknown): JobId | null {
  return isJobId(v) ? v : null;
}

// ── Theme names ──────────────────────────────────────────────────────────────

/** Longest name of a theme that exists (a listed theme; the folder of a theme named by a path). */
export const ANY_THEME_NAME_MAX = 100;
/** Longest name a new theme takes, whatever creates it. */
export const NEW_THEME_NAME_MAX = 60;
/** A theme (template) name: a folder of the workspace's templates_dir or a starter template, never a path (SLUG_RE). */
export const ANY_THEME_NAME_RE = SLUG_RE;
/**
 * A new theme's name: lower-case letters, digits and "-" (compared without case with the starters and the folders of
 * templates_dir). The grammar of a project slug (project.ts PROJECT_SLUG_RE; a test keeps the two the same).
 */
export const NEW_THEME_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Whether `v` is the name of a theme that exists: the any-case grammar, at most ANY_THEME_NAME_MAX characters. One rule
 * for every place that reads a theme by its name — a request names a listed theme with it (never a path), and the
 * folder of a theme a project names by a path is compared (the project board, a render's `theme`) and quoted (the
 * Studio's sentences) by its name only when that name is one. A folder named otherwise still loads and renders; its
 * name is then read nowhere.
 */
export function isThemeName(v: unknown): v is ThemeName {
  return typeof v === 'string' && v.length <= ANY_THEME_NAME_MAX && ANY_THEME_NAME_RE.test(v);
}

/** Whether `v` is a name a new theme may take: the lower-case grammar, at most NEW_THEME_NAME_MAX characters. */
export function isNewThemeName(v: unknown): v is NewThemeName {
  return typeof v === 'string' && v.length <= NEW_THEME_NAME_MAX && NEW_THEME_NAME_RE.test(v);
}
