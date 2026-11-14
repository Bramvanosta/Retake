/**
 * The shell and sql hooks of a scenario an agent wrote, as a person's own command sees them (L7.27, L7.33: an agent's
 * sql hook is treated like its shell hooks). The rule: when the hooks `retake run` (or `retake hooks run
 * <scenario>:setup|teardown`) is about to run were written by an agent, it lists every shell and sql hook as it will
 * run and asks the person before any of them runs (work submitted through MCP or the
 * Studio has its own approvals: trust `mcp`).
 *
 * **What decides — the hook surface.** A scenario's executable surface is what its hooks run and are rendered with:
 * `setup`, `teardown`, its named `hooks`, the names its `hook:` steps run, its `vars` and its `env` (scenarioHookSurface,
 * a sha256 of their canonical JSON — no value is kept). Every scenario write of Retake (engine scenarios.ts) adds a line
 * to the project's own record, `<project>/.retake/scenario-writes.jsonl` (it travels with the project): the file, the
 * bytes' sha256, the surface written, the surface the file had before, and the caller. The surface the command read
 * belongs to the newest line with that surface that is a person's (trust `author`) or an agent's that brought it (its
 * surface differed from the file's before). A write that left the surface as it was (a caption edited in the Studio)
 * changes nobody's hooks; an edit by hand that leaves the hooks as they were keeps them whose they were.
 *
 * The record read is that of the project holding the scenario file (the nearest folder above it with a project.yaml),
 * whichever project the command opened.
 *
 * **Before these records** (and when one could not be written): the workspace journals (store/journal.ts) of the
 * workspace the command opened and of the one found upward from the project's folder — the newest successful write of
 * that file with exactly these bytes decides. Otherwise, when the journals hold an agent's write of that file the
 * record does not, who brought the surface cannot be told apart: asked.
 *
 * **A person's trust binds the files the hooks read** (`retake hooks trust`, L7.39). Its record line also holds the sha256
 * of every file the scenario's hooks read — code (an sql / js file and its rollback's, a shell command's own script)
 * and data (the other files a shell command names, when they exist) — as the hooks package's resolver sorts them
 * (hookTrustFiles, through the HookRunner port). When that line decides, whatever the kinds of the hooks the command
 * runs, their files are read again: a code file changed, newly read or unreadable, or a data file changed or
 * unreadable, makes the hooks asked again, the listing naming each file. The files read then go to the run
 * (HookContext.trustedFiles), which refuses a hook whose files are no longer those (core trustedFileChanges). A later
 * line of the person's that leaves the surface as it was and holds no files does not drop that binding. A line without
 * files (a person's own write) decides as before.
 *
 * **Asked when it cannot be known** (fails closed): a record or journal that exists but cannot be read, no bytes or no
 * parsed scenario, or — with no line to decide — a project outside the projects folder of every workspace looked at.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { canonicalJson, interpolate } from '@retake/core/base';
import { resolveEnvironment } from '@retake/core/environment';
import { hookStepNames, sqlSource, usedNamedHooks } from '@retake/core/hooks';
import { PROJECT_FILE, PROJECT_SCENARIO_WRITES_FILE, STATE_DIR, projectPath, statePath } from '@retake/core/project';
import type { TemplateContext } from '@retake/core/base';
import type { HookStep, LoadedProject, Scenario, WorkFileFacts } from '@retake/core/model';
import { UNREADABLE_FILE, trustedFileChanges } from '@retake/core/hooks';
import type { HookFileChange, TrustedHookFiles } from '@retake/core/hooks';
import { findWorkspaceUpward, loadScenario, loadWorkspaceConfig, reserveRunId } from '@retake/core/io';
import type { Caller } from './caller.js';
import { stampOf } from './clock.js';
import { EngineError } from './errors.js';
import type { Clock } from './clock.js';
import type { HookRunner } from './hook-run/runner.js';
import type { ProjectStores } from './store/store.js';
import { journalFile } from './store/journal.js';
import type { JournalBy } from './store/journal.js';

// ── The hook surface ─────────────────────────────────────────────────────────

type SurfaceOf = Pick<Scenario, 'setup' | 'teardown' | 'hooks' | 'vars' | 'env' | 'scenes'>;

/** The sha256 of what a scenario's hooks run and are rendered with (setup, teardown, named hooks, `hook:` step names, vars, env). */
export function scenarioHookSurface(sc: SurfaceOf): string {
  const surface = { setup: sc.setup ?? [], teardown: sc.teardown ?? [], hooks: sc.hooks ?? {}, steps: hookStepNames(sc), vars: sc.vars ?? {}, env: sc.env ?? null };
  return createHash('sha256').update(canonicalJson(surface)).digest('hex');
}

/** The project's record of scenario writes (its state folder: core layout PROJECT_SCENARIO_WRITES_FILE). */
export function scenarioWritesFile(projectDir: string): string {
  return statePath(projectDir, undefined, PROJECT_SCENARIO_WRITES_FILE);
}

interface ScenarioWriteLine {
  v: 1;
  at: string;
  /** The file, project-relative POSIX. */
  path: string;
  sha256: string;
  surface: string;
  /** The surface the file had before the write (null: a new file, or one that did not parse). */
  prev_surface: string | null;
  by: JournalBy;
  /**
   * A person's trust only (`retake hooks trust`): every file the hooks read, code and data, project-relative POSIX →
   * sha256 of its bytes (`unreadable` when it could not be read): scenarioHookFiles.
   */
  files?: TrustedHookFiles;
}

/** How often a record that cannot be written is said on stderr. */
let lastWarn = Number.NEGATIVE_INFINITY;

/**
 * Add the line of a scenario write that succeeded (engine scenarios.ts, after the project store wrote it), through the
 * write's stores (ProjectStores.appendRecord: owner-only, never through a symbolic link, a torn last line closed first,
 * synced; a memory workspace's lands in its Map); a failure never fails the write (it is done): it is said on stderr,
 * and the workspace journal's line of the write still decides for it.
 */
export async function recordScenarioWrite(
  project: Pick<LoadedProject, 'dir'>,
  w: { file: string; sha256: string; scenario: SurfaceOf; before?: SurfaceOf | null; caller: Pick<Caller, 'client' | 'channel' | 'trust'>; clock: Clock; stores: ProjectStores },
): Promise<void> {
  await appendScenarioWrite(project, w).catch((e: unknown) => {
    const now = w.clock.now();
    if (now - lastWarn < 60_000) return;
    lastWarn = now;
    process.stderr.write(`retake: the project's record of scenario writes (${STATE_DIR}/${PROJECT_SCENARIO_WRITES_FILE}) could not be written: ${(e as Error).message}\n`);
  });
}

/** The record line of a write (or of a person's trust): appended, or the error that stopped it. */
async function appendScenarioWrite(
  project: Pick<LoadedProject, 'dir'>,
  w: {
    file: string;
    sha256: string;
    scenario: SurfaceOf;
    before?: SurfaceOf | null;
    caller: Pick<Caller, 'client' | 'channel' | 'trust'>;
    clock: Clock;
    stores: ProjectStores;
    files?: TrustedHookFiles;
  },
): Promise<void> {
  const line: ScenarioWriteLine = {
    v: 1,
    at: stampOf(w.clock),
    path: relative(project.dir, w.file).split(sep).join('/'),
    sha256: w.sha256,
    surface: scenarioHookSurface(w.scenario),
    prev_surface: w.before ? scenarioHookSurface(w.before) : null,
    by: { client: w.caller.client, channel: w.caller.channel, trust: w.caller.trust },
    ...(w.files ? { files: w.files } : {}),
  };
  await w.stores.appendRecord(project.dir, PROJECT_SCENARIO_WRITES_FILE, `${JSON.stringify(line)}\n`);
}

// ── Reading, closed on failure ───────────────────────────────────────────────

/** The parsed lines of a JSON-lines file, streamed (any size); `missing` when there is none; `unreadable` otherwise on error. */
async function jsonLines(file: string): Promise<{ lines: unknown[] } | { missing: true } | { unreadable: string }> {
  if (!existsSync(file)) return { missing: true };
  try {
    if (!statSync(file).isFile()) return { unreadable: `${file} is not a file` };
    const out: unknown[] = [];
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const l of rl) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        // a torn line (a crash mid-write): skipped
      }
    }
    return { lines: out };
  } catch (e) {
    return { unreadable: `${file}: ${(e as Error).message}` };
  }
}

async function realOr(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/** The project holding a scenario file: the nearest folder above it with a project.yaml (its slug the folder's name), else `fallback`. */
function projectOfFile(file: string, fallback: Pick<LoadedProject, 'slug' | 'dir'>): Pick<LoadedProject, 'slug' | 'dir'> {
  for (let d = dirname(file); ; d = dirname(d)) {
    if (existsSync(join(d, PROJECT_FILE))) return d === fallback.dir ? fallback : { slug: basename(d), dir: d };
    if (dirname(d) === d) return fallback;
  }
}

/** Who wrote the hooks the command read. */
export type HooksAuthor =
  /** An agent's write brought them. */
  | { agent: true; by: JournalBy; at: string }
  /** Cannot be known (a record unreadable, no bytes, a project of no workspace looked at): asked, as an agent's. */
  | { agent: true; unknown: string }
  /** A person trusted them (`at`), but a file they read changed since, was added, or cannot be read: asked again. */
  | { agent: true; files: HookFileChange[]; at: string }
  | { agent: false; why: 'record' | 'journal' | 'unjournaled' };

export type { HookFileChange } from '@retake/core/hooks';

interface JournalScenarioWrite {
  at: string;
  by: JournalBy;
  path: string;
  project?: string;
  sha256: string;
}

/** The absolute file a journal line names (undefined: a store outside the workspace other than this project's). */
function fileOfLine(root: string, project: Pick<LoadedProject, 'slug' | 'dir'>, e: JournalScenarioWrite): string | undefined {
  const label = '<project>/';
  if (e.path.startsWith(label)) return e.project === project.slug ? join(project.dir, e.path.slice(label.length)) : undefined;
  if (e.path.startsWith('<')) return undefined;
  return join(root, e.path);
}

/**
 * The person's trust of `surface` older than `records[from]`, reached through lines that kept the surface (a person's
 * without files, or an agent's that did not bring it); undefined at the first line that brought it, or none.
 */
function olderTrust(records: readonly ScenarioWriteLine[], from: number, surface: string): ScenarioWriteLine | undefined {
  for (let k = from - 1; k >= 0; k--) {
    const r = records[k] as ScenarioWriteLine;
    if (r.surface !== surface) continue;
    if (r.prev_surface !== surface) return r.by.trust !== 'mcp' && r.files !== undefined ? r : undefined;
    if (r.by.trust !== 'mcp' && r.files !== undefined) return r;
  }
  return undefined;
}

const isBy = (b: unknown): b is JournalBy => !!b && typeof b === 'object' && typeof (b as JournalBy).trust === 'string';

/**
 * Who wrote the hook surface of `loaded` (the bytes a command read once and runs): see the module comment. `wsRoot`:
 * the workspace the command opened. `o.files`: the files the hooks the command runs read now (scenarioHookFiles), read
 * only when a person's trust decides; without it such a trust cannot be checked: asked.
 */
export async function hooksWrittenBy(
  wsRoot: string,
  opened: Pick<LoadedProject, 'slug' | 'dir'>,
  loaded: { file: string; sha256?: string; scenario?: SurfaceOf },
  o: { files?: () => Promise<TrustedHookFiles>; trusted?: (files: unknown) => void } = {},
): Promise<HooksAuthor> {
  if (loaded.sha256 === undefined || !loaded.scenario) return { agent: true, unknown: 'its bytes were not read from a file' };
  // The record of the project that holds the file, whichever project the command opened.
  const project = projectOfFile(loaded.file, opened);
  const surface = scenarioHookSurface(loaded.scenario);
  const real = await realOr(loaded.file);
  const sameFile = async (abs: string | undefined) => abs !== undefined && (await realOr(abs)) === real;

  // 1. The project's record.
  const rec = await jsonLines(scenarioWritesFile(project.dir));
  if ('unreadable' in rec) return { agent: true, unknown: `the project's record of scenario writes cannot be read (${rec.unreadable})` };
  const records: ScenarioWriteLine[] = [];
  for (const l of 'lines' in rec ? rec.lines : []) {
    const r = l as Partial<ScenarioWriteLine>;
    if (r?.v !== 1 || typeof r.path !== 'string' || typeof r.surface !== 'string' || typeof r.sha256 !== 'string' || !isBy(r.by)) continue;
    if (await sameFile(join(project.dir, r.path))) records.push(r as ScenarioWriteLine);
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.surface !== surface) continue;
    if (r.by.trust !== 'mcp') {
      // A person's line that kept the surface and binds no files: an older trust of this surface still binds its files.
      const trust = r.files === undefined && r.prev_surface === surface ? olderTrust(records, i, surface) : r.files !== undefined ? r : undefined;
      if (!trust) return { agent: false, why: 'record' };
      // A person's trust: the files the hooks read now, against those it bound.
      if (!o.files) return { agent: true, unknown: 'the files its hooks read were not checked against the trust given to them' };
      let now: TrustedHookFiles;
      try {
        now = await o.files();
      } catch (e) {
        return { agent: true, unknown: `the files its hooks read cannot be listed (${(e as Error).message})` };
      }
      o.trusted?.(trust.files);
      const changes = trustedFileChanges(trust.files, now);
      return changes.length ? { agent: true, files: changes, at: trust.at } : { agent: false, why: 'record' };
    }
    if (r.prev_surface !== surface) return { agent: true, by: r.by, at: r.at };
  }

  // 2. The workspace journals (writes the record does not hold: from before it, or a line it lost).
  const roots = [...new Set([wsRoot, findWorkspaceUpward(project.dir)].filter((r): r is string => r !== undefined))];
  const recorded = new Set(records.map((r) => r.sha256));
  const writes: JournalScenarioWrite[] = [];
  let placed = false;
  const realProject = await realOr(project.dir);
  for (const root of roots) {
    try {
      const cfg = await loadWorkspaceConfig(root);
      if ((await realOr(dirname(realProject))) === (await realOr(cfg.projectsDir))) placed = true;
    } catch {
      // a retake.yaml that does not load: this workspace does not place the project
    }
    const j = await jsonLines(journalFile(root));
    if ('unreadable' in j) return { agent: true, unknown: `the workspace journal cannot be read (${j.unreadable})` };
    for (const l of 'lines' in j ? j.lines : []) {
      const e = l as Partial<JournalScenarioWrite> & { v?: number; op?: string; what?: string; outcome?: string };
      if (e?.v !== 1 || e.op !== 'write' || e.what !== 'scenario' || e.outcome !== 'ok' || typeof e.sha256 !== 'string' || typeof e.path !== 'string' || typeof e.at !== 'string' || !isBy(e.by))
        continue;
      if (recorded.has(e.sha256)) continue;
      if (await sameFile(fileOfLine(root, project, e as JournalScenarioWrite))) writes.push(e as JournalScenarioWrite);
    }
  }
  writes.sort((a, b) => a.at.localeCompare(b.at));
  const exact = [...writes].reverse().find((e) => e.sha256 === loaded.sha256);
  if (exact) return exact.by.trust === 'mcp' ? { agent: true, by: exact.by, at: exact.at } : { agent: false, why: 'journal' };
  // An agent wrote the file in a write the record does not hold (before it began, or a line it lost): who brought the
  // surface is not known.
  if (writes.some((e) => e.by.trust === 'mcp')) {
    return { agent: true, unknown: 'an agent wrote this scenario in a write whose hook surface Retake did not record' };
  }
  if (!records.length && !placed) return { agent: true, unknown: 'the project is in the projects folder of no workspace looked at, so its journal is not known' };
  return { agent: false, why: 'unjournaled' };
}

// ── The shell and sql hooks, as they will run ──────────────────────────────────────────────────────────────────────

/** A text as it will run: rendered, with what is not known before the run said so. */
export interface RenderedText {
  /** As the file writes it. */
  written: string;
  /** Rendered as the run will: secret tokens kept as tokens; a response-filled value marked (`unknown`). */
  shown: string;
  /** Tokens filled at run time from an earlier hook's response (`{{hooks.…}}`, `{{response.…}}`): unknown now. */
  unknown: string[];
}

/** Where a shell or sql hook of a scenario's run is declared and everything it runs with. */
export interface ScenarioShellHook {
  /** A shell command, or sql statements (an agent's sql hook is asked about like its shell hooks, L7.33). */
  kind: 'shell' | 'sql';
  /** `setup`, `teardown`, or `step` (a named hook a `hook:` step runs). */
  phase: 'setup' | 'teardown' | 'step';
  /** Its position in its list, from 1 (a step hook: in its named hook's entries). */
  position: number;
  name?: string;
  /** A step hook: the named hook the step runs, and where it is declared. */
  named?: { name: string; source: 'scenario' | 'project' };
  /** A shell hook's command; an sql hook's statements (its file's text when it names one). */
  run: RenderedText;
  /** An sql hook: the file its statements are read from, and its rollback's (as written). */
  file?: string;
  rollbackFile?: string;
  /** An sql hook: the database key it names (`db`; absent: the environment's first database) — never its URL. */
  db?: string;
  cwd?: RenderedText;
  /** Its own environment entries, in the file's order. */
  env: Array<{ name: string; value: RenderedText }>;
  rollback?: RenderedText;
}

/** The phases a command runs: a whole run, or one `hooks run <scenario>:<phase>`. */
export type ScenarioHookPhases = ReadonlyArray<ScenarioShellHook['phase']>;

const ALL_PHASES: ScenarioHookPhases = ['setup', 'teardown', 'step'];
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** A secret, or a sandbox account's value: kept as its token (never resolved for a listing). */
const KEPT = /^(?:env|keychain|secret|compose_env):|^accounts(?:\.|$)/;
const RESPONSE = /^(?:hooks|response)(?:\.|$)/;

/** What the listing renders with: the run's own template context (pages, vars, run) — never a secret. */
export interface ListingContext {
  pages: Record<string, string>;
  vars: Record<string, unknown>;
  /** The run's id and folder (`hooks run`: an id only, as its context has). */
  run: { id: string; dir?: string };
}

/** Render one text as the run will (core interpolate, token by token): see RenderedText. */
export function renderForListing(text: string, tpl: ListingContext): RenderedText {
  const unknown: string[] = [];
  const ctx: TemplateContext = { pages: tpl.pages, vars: tpl.vars, run: tpl.run, hooks: {} };
  const shown = text.replace(TOKEN, (_m, raw: string) => {
    // Read as core's lookup reads a path (each segment trimmed): `{{ hooks . x . body }}` is `hooks.x.body`.
    const expr = raw.trim().replace(/\s*\.\s*/g, '.');
    if (KEPT.test(expr)) return `{{${expr}}}`;
    if (RESPONSE.test(expr)) {
      unknown.push(`{{${expr}}}`);
      return `<unknown until the run: {{${expr}}}>`;
    }
    try {
      return interpolate(`{{${expr}}}`, ctx);
    } catch {
      return `<unknown key: {{${expr}}}>`;
    }
  });
  return { written: text, shown, unknown };
}

function shellSpec(h: HookStep): { run: string; cwd?: string; env?: Record<string, unknown>; rollback?: string } | undefined {
  if (!h || typeof h !== 'object' || !Object.hasOwn(h, 'shell')) return undefined;
  const s = (h as { shell: unknown }).shell;
  if (typeof s === 'string') return { run: s };
  if (!s || typeof s !== 'object' || typeof (s as { run?: unknown }).run !== 'string') return undefined;
  const o = s as { run: string; cwd?: unknown; env?: unknown; rollback?: unknown };
  return {
    run: o.run,
    ...(typeof o.cwd === 'string' ? { cwd: o.cwd } : {}),
    ...(o.env && typeof o.env === 'object' ? { env: o.env as Record<string, unknown> } : {}),
    ...(typeof o.rollback === 'string' ? { rollback: o.rollback } : {}),
  };
}

/** An sql source as written: a `.sql` file (core sqlSource) or an inline statement. */
function sqlText(src: unknown, projectDir: string | undefined): { text: string; file?: string } | undefined {
  if (typeof src === 'string') {
    const { file, query } = sqlSource(src);
    return file !== undefined ? { text: fileText(file, projectDir), file } : { text: query ?? '' };
  }
  if (!src || typeof src !== 'object') return undefined;
  const o = src as { file?: unknown; query?: unknown };
  if (typeof o.query === 'string') return { text: o.query };
  if (typeof o.file === 'string') return { text: fileText(o.file, projectDir), file: o.file };
  return undefined;
}

/** A project file's text for the listing, or what stands for it when it cannot be read now. */
function fileText(file: string, projectDir: string | undefined): string {
  if (projectDir === undefined) return `<the text of ${file}>`;
  try {
    return readFileSync(resolve(projectDir, file), 'utf8');
  } catch (e) {
    return `<${file} cannot be read now: ${(e as NodeJS.ErrnoException).code ?? 'error'}>`;
  }
}

function sqlSpec(h: HookStep, projectDir: string | undefined): { run: { text: string; file?: string }; db?: string; rollback?: { text: string; file?: string } } | undefined {
  if (!h || typeof h !== 'object' || !Object.hasOwn(h, 'sql')) return undefined;
  const spec = (h as { sql: unknown }).sql;
  const run = sqlText(spec, projectDir);
  if (!run) return undefined;
  const o = spec && typeof spec === 'object' ? (spec as { db?: unknown; rollback?: unknown }) : {};
  const rollback = o.rollback !== undefined ? sqlText(o.rollback, projectDir) : undefined;
  return { run, ...(typeof o.db === 'string' ? { db: o.db } : {}), ...(rollback ? { rollback } : {}) };
}

/**
 * Every shell and sql hook a run of `sc` executes in `phases` — its setup, its teardown, the named hooks its `hook:`
 * steps run (the scenario's own, else project.yaml's: core usedNamedHooks, as the runner) — rendered with `tpl`
 * (renderForListing): a shell hook with its working folder, its own environment entries and its rollback; an sql hook
 * with its statements (a file's text, read from `projectDir`: the folder a scenario's sql files are read from), its
 * database key and its rollback.
 */
export function scenarioShellHooks(
  sc: Pick<Scenario, 'setup' | 'teardown' | 'scenes' | 'hooks'>,
  project: Pick<LoadedProject, 'config'> & { dir?: string },
  tpl: ListingContext,
  phases: ScenarioHookPhases = ALL_PHASES,
): ScenarioShellHook[] {
  const out: ScenarioShellHook[] = [];
  const add = (h: HookStep, base: Pick<ScenarioShellHook, 'phase' | 'position' | 'named'>) => {
    const q = sqlSpec(h, project.dir);
    if (q) {
      out.push({
        kind: 'sql',
        ...base,
        ...(typeof h.name === 'string' ? { name: h.name } : {}),
        run: renderForListing(q.run.text, tpl),
        ...(q.run.file !== undefined ? { file: q.run.file } : {}),
        ...(q.db !== undefined ? { db: q.db } : {}),
        env: [],
        ...(q.rollback ? { rollback: renderForListing(q.rollback.text, tpl), ...(q.rollback.file !== undefined ? { rollbackFile: q.rollback.file } : {}) } : {}),
      });
      return;
    }
    const s = shellSpec(h);
    if (!s) return;
    out.push({
      kind: 'shell',
      ...base,
      ...(typeof h.name === 'string' ? { name: h.name } : {}),
      run: renderForListing(s.run, tpl),
      ...(s.cwd !== undefined ? { cwd: renderForListing(s.cwd, tpl) } : {}),
      env: Object.entries(s.env ?? {}).map(([name, v]) => ({ name, value: renderForListing(String(v), tpl) })),
      ...(s.rollback !== undefined ? { rollback: renderForListing(s.rollback, tpl) } : {}),
    });
  };
  if (phases.includes('setup')) (sc.setup ?? []).forEach((h, i) => add(h, { phase: 'setup', position: i + 1 }));
  if (phases.includes('teardown')) (sc.teardown ?? []).forEach((h, i) => add(h, { phase: 'teardown', position: i + 1 }));
  if (phases.includes('step')) {
    for (const n of usedNamedHooks(sc, project)) n.hooks.forEach((h, i) => add(h, { phase: 'step', position: i + 1, named: { name: n.name, source: n.source } }));
  }
  return out;
}

/** The run's template context for a listing: the environment's pages, project.yaml's vars under the scenario's, the run. */
export function listingContext(project: LoadedProject, sc: Pick<Scenario, 'vars'>, env: string | undefined, run: ListingContext['run']): ListingContext {
  return { pages: resolveEnvironment(project, env).pages, vars: { ...(project.config.vars ?? {}), ...(sc.vars ?? {}) }, run };
}

/**
 * Every file the hooks a run of `sc` executes in `phases` read — setup, teardown, the named hooks its `hook:` steps run,
 * of every kind — as the hooks package's resolver sorts them for a person's trust (the HookRunner port's
 * `approval.trustFiles`: code and data, project-relative POSIX → sha256, `unreadable` kept), rendered with `vars`
 * (project.yaml's under the scenario's). What a person's trust binds, and what a run checks it against.
 */
export async function scenarioHookFiles(
  sc: Pick<Scenario, 'setup' | 'teardown' | 'scenes' | 'hooks' | 'vars'>,
  project: Pick<LoadedProject, 'config' | 'dir' | 'root'>,
  hooks: Pick<HookRunner, 'approval'>,
  phases: ScenarioHookPhases = ALL_PHASES,
): Promise<TrustedHookFiles> {
  const vars = { ...(project.config.vars ?? {}), ...(sc.vars ?? {}) };
  const out: TrustedHookFiles = { code: Object.create(null) as Record<string, string>, data: Object.create(null) as Record<string, string> };
  // Every file is bound, a file a hook writes too. Apart: those a writer of this command writes before their first
  // reader (`generated`), which the check before the run does not compare.
  const written = new Set<string>();
  const first = new Set<string>();
  const generated = new Set<string>();
  const list: TrustedHookFiles[] = [];
  for (const { hook, phase } of runOrder(sc, project)) {
    if (phases.includes(phase)) list.push(await hooks.approval.trustFiles(hook, { projectDir: project.dir, workspaceDir: project.root, vars }));
  }
  // A file a hook writes with a plain `>` that a later hook names as code: its writer's inputs are code too — and so,
  // to a fixed point, are the inputs of every writer up the chain (a writer's input an earlier hook wrote).
  const codeOutputs = new Set<string>();
  const writtenBefore: Array<Set<string>> = [];
  const seen = new Set<string>();
  for (const f of list) {
    writtenBefore.push(new Set(seen));
    for (const path of f.generated ?? []) seen.add(path);
  }
  list.forEach((f, k) => {
    for (const path of f.codeNames ?? []) if (writtenBefore[k]?.has(path)) codeOutputs.add(path);
  });
  for (let grown = true; grown; ) {
    grown = false;
    list.forEach((f, k) => {
      if (!(f.generated ?? []).some((p) => codeOutputs.has(p))) return;
      for (const path of [...(f.dataNames ?? []), ...(f.codeNames ?? [])]) {
        if (writtenBefore[k]?.has(path) && !codeOutputs.has(path)) {
          codeOutputs.add(path);
          grown = true;
        }
      }
    });
  }
  for (const listed of list) {
    const f = (listed.generated ?? []).some((p) => codeOutputs.has(p)) ? inputsAsCode(listed) : listed;
    for (const [path, hash] of Object.entries(f.code)) {
      out.code[path] = out.code[path] === UNREADABLE_FILE ? UNREADABLE_FILE : hash;
      delete out.data[path];
    }
    for (const [path, hash] of Object.entries(f.data)) {
      if (Object.hasOwn(out.code, path)) continue;
      out.data[path] = out.data[path] === UNREADABLE_FILE ? UNREADABLE_FILE : hash;
    }
    // Its reads come before its writes: a hook that reads what it writes reads it first.
    for (const path of [...Object.keys(f.code), ...Object.keys(f.data)]) {
      if (first.has(path)) continue;
      first.add(path);
      if (written.has(path)) generated.add(path);
    }
    for (const path of f.generated ?? []) written.add(path);
  }
  if (generated.size) out.generated = [...generated].sort();
  if (codeOutputs.size) out.codeOutputs = [...codeOutputs].sort();
  return out;
}

/** `f` with its data files (and those it names under Retake's folders) moved to code: a writer whose output runs as code. */
function inputsAsCode(f: TrustedHookFiles): TrustedHookFiles {
  const code = Object.assign(Object.create(null) as Record<string, string>, f.quiet ?? {}, f.data, f.code);
  return { ...f, code, data: Object.create(null) as Record<string, string> };
}

/** `f` without the files of `f.generated`, and without that list. */
function withoutGenerated(f: TrustedHookFiles): TrustedHookFiles {
  const skip = new Set(f.generated ?? []);
  const keep = (m: Record<string, string>) => Object.assign(Object.create(null) as Record<string, string>, Object.fromEntries(Object.entries(m).filter(([p]) => !skip.has(p))));
  return { code: keep(f.code), data: keep(f.data), ...(f.codeOutputs ? { codeOutputs: f.codeOutputs } : {}) };
}

/** A trust's own hash of `path` (from its record line: anything else in it is not read). */
function trustedHash(trusted: unknown, path: string): string | undefined {
  for (const k of ['code', 'data'] as const) {
    const m = trusted && typeof trusted === 'object' ? (trusted as Record<string, unknown>)[k] : undefined;
    if (m && typeof m === 'object' && Object.hasOwn(m, path) && typeof (m as Record<string, unknown>)[path] === 'string') return (m as Record<string, string>)[path];
  }
  return undefined;
}

/** The hooks of every kind a run of `sc` executes, in the order it runs them: setup, the `hook:` steps' named hooks, teardown. */
function runOrder(sc: Pick<Scenario, 'setup' | 'teardown' | 'scenes' | 'hooks'>, project: Pick<LoadedProject, 'config'>): Array<{ hook: HookStep; phase: ScenarioShellHook['phase'] }> {
  return [
    ...(sc.setup ?? []).map((hook) => ({ hook, phase: 'setup' as const })),
    ...usedNamedHooks(sc, project).flatMap((n) => n.hooks.map((hook) => ({ hook, phase: 'step' as const }))),
    ...(sc.teardown ?? []).map((hook) => ({ hook, phase: 'teardown' as const })),
  ];
}

/** The shell and sql hooks a person is asked about before they run, and who wrote them (or whose trusted files changed). */
export type AgentWrittenShellHooks = { hooks: ScenarioShellHook[] } & ({ by: JournalBy; at: string } | { unknown: string } | { files: HookFileChange[]; at: string });

/** A listing's "who" from a HooksAuthor that is an agent's. */
export function listedAuthor(a: Extract<HooksAuthor, { agent: true }>): { by: JournalBy; at: string } | { unknown: string } | { files: HookFileChange[]; at: string } {
  if ('unknown' in a) return { unknown: a.unknown };
  if ('files' in a) return { files: a.files, at: a.at };
  return { by: a.by, at: a.at };
}

/** What a person's command learns before it runs a scenario's hooks: what to ask about, and the files to hold the run to. */
export interface ScenarioHooksCheck {
  /** The hooks to list and ask about, or null: none. */
  ask: AgentWrittenShellHooks | null;
  /**
   * The files the hooks read, as read now, when a person's trust decided or the person is asked: the run refuses a hook
   * whose files are no longer these (HookContext.trustedFiles). Absent: the person's own hooks, run as before.
   */
  bound?: TrustedHookFiles;
}

/**
 * Before a person's command runs the hooks (in `phases`) of a scenario: the shell and sql hooks to ask about — when an
 * agent wrote them, when their writer cannot be known, or when files they read changed since a person trusted them
 * (whatever the kinds of the hooks: a js file too) — rendered with the context `tpl` gives (asked for only then: a run
 * reserves its id there), and the files read now (`runner`), which the run is held to. Nothing is read for a scenario
 * whose hooks in `phases` are neither shell nor sql and read no file.
 */
export async function scenarioHooksCheck(
  wsRoot: string,
  project: LoadedProject,
  loaded: { file: string; sha256?: string; scenario: Scenario },
  tpl: () => Promise<ListingContext>,
  runner: Pick<HookRunner, 'approval'>,
  phases: ScenarioHookPhases = ALL_PHASES,
): Promise<ScenarioHooksCheck> {
  const listed = scenarioShellHooks(loaded.scenario, project, { pages: {}, vars: {}, run: { id: '' } }, phases).length > 0;
  let files: TrustedHookFiles | undefined;
  const read = async () => (files ??= await scenarioHookFiles(loaded.scenario, project, runner, phases));
  if (!listed) {
    const f = await read();
    if (!Object.keys(f.code).length && !Object.keys(f.data).length) return { ask: null };
  }
  // The reader is called only when a person's trust decides; it compares all but the files a writer of this command
  // writes before their first reader.
  let trust: { files: unknown } | undefined;
  const author = await hooksWrittenBy(wsRoot, project, loaded, {
    files: async () => withoutGenerated(await read()),
    trusted: (t) => void (trust = { files: t }),
  });
  if (!author.agent) return trust ? { ask: null, bound: held(await read(), trust.files) } : { ask: null };
  // An agent's hooks that are neither shell nor sql are not asked about (only a trust's changed files are).
  if (!listed && !('files' in author)) return { ask: null };
  const hooks = scenarioShellHooks(loaded.scenario, project, await tpl(), phases);
  return { ask: { hooks, ...listedAuthor(author) }, bound: held(await read(), trust?.files) };
}

/**
 * What a run is held to: the files as read now — but a file a writer of this command writes before its first reader
 * as the trust holds it (absent when the trust holds none), until a writer that runs changes it. Without a trust (an
 * agent's hooks the person says yes to): the files as read now.
 */
function held(now: TrustedHookFiles, trusted: unknown): TrustedHookFiles {
  const out = withoutGenerated(now);
  if (trusted === undefined) {
    for (const path of now.generated ?? []) {
      if (Object.hasOwn(now.code, path)) out.code[path] = now.code[path] as string;
      else if (Object.hasOwn(now.data, path)) out.data[path] = now.data[path] as string;
    }
    return out;
  }
  for (const path of now.generated ?? []) {
    const h = trustedHash(trusted, path);
    if (h !== undefined) out.code[path] = h;
  }
  return out;
}

/** scenarioHooksCheck's `ask`: the hooks to list and ask about, or null. */
export async function agentWrittenShellHooks(
  wsRoot: string,
  project: LoadedProject,
  loaded: { file: string; sha256?: string; scenario: Scenario },
  tpl: () => Promise<ListingContext>,
  runner: Pick<HookRunner, 'approval'>,
  phases: ScenarioHookPhases = ALL_PHASES,
): Promise<AgentWrittenShellHooks | null> {
  return (await scenarioHooksCheck(wsRoot, project, loaded, tpl, runner, phases)).ask;
}

/**
 * A run id reserved before the listing (core reserveRunId: its folder made), so the listing shows the `{{run.id}}` /
 * `{{run.dir}}` the run will have; `release` removes the folder again when it is still empty (the run did not start).
 */
export async function reserveListedRun(project: Pick<LoadedProject, 'dir'>, scenario: string): Promise<{ id: string; dir: string; release(): Promise<void> }> {
  const { id, dir } = await reserveRunId(projectPath(project.dir, 'runs'), scenario);
  return { id, dir, release: () => rmdir(dir).catch(() => undefined) };
}

// ── A person's trust (`retake hooks trust`) ──────────────────────────────────

/** What `retake hooks trust` shows and settles: the scenario read once, its shell and sql hooks as a run lists them, who wrote them. */
export interface HooksTrustView {
  name: string;
  file: string;
  sha256: string;
  scenario: Scenario;
  /** Every shell and sql hook a run executes, rendered as the run's listing renders them (the run's id and folder not known yet). */
  hooks: ScenarioShellHook[];
  /** Every file those hooks read, as read now (scenarioHookFiles): what a yes binds. */
  files: TrustedHookFiles;
  author: HooksAuthor;
}

/** The run placeholders of a listing made outside a run: what `{{run.id}}` / `{{run.dir}}` will be is not known yet. */
const NO_RUN = { id: "<the run's id>", dir: "<the run's folder>" };

/**
 * Read a scenario once (core loadScenario, validated against `env`) for `retake hooks trust`: its shell and sql hooks as the run
 * lists them, and who wrote them (hooksWrittenBy).
 */
export async function hooksTrustView(
  wsRoot: string,
  project: LoadedProject,
  scenarioRef: string,
  o: { files: WorkFileFacts; env?: string; hooks: Pick<HookRunner, 'approval'> },
): Promise<HooksTrustView> {
  const loaded = await loadScenario(project, scenarioRef, { files: o.files, ...(o.env !== undefined ? { env: o.env } : {}) });
  if (loaded.sha256 === undefined) throw new EngineError('invalid', `scenario ${loaded.name} was not read from a file: nothing to trust`);
  const hooks = scenarioShellHooks(loaded.scenario, project, listingContext(project, loaded.scenario, o.env ?? loaded.scenario.env, NO_RUN));
  const files = await scenarioHookFiles(loaded.scenario, project, o.hooks);
  const author = await hooksWrittenBy(wsRoot, project, loaded, { files: async () => withoutGenerated(files) });
  return { name: loaded.name, file: loaded.file, sha256: loaded.sha256, scenario: loaded.scenario, hooks, files, author };
}

/**
 * A person's yes to the hooks of `view` (`retake hooks trust`, a terminal's caller only): one record line by the person
 * — the bytes read and their surface, the surface before the same, and the sha256 of every file the hooks read
 * (`view.files`) — in the project holding the file, so a run does not ask again until the hooks or one of those files
 * change. A line that cannot be written is an error (nothing was settled).
 */
export async function trustScenarioHooks(project: LoadedProject, view: HooksTrustView, caller: Caller, ports: { clock: Clock; stores: ProjectStores }): Promise<void> {
  if (caller.trust !== 'author' || caller.client !== 'cli') throw new EngineError('refused', 'only a person in a terminal marks hooks as theirs (`retake hooks trust`)');
  const holder = projectOfFile(view.file, project);
  try {
    await appendScenarioWrite(holder, {
      file: view.file,
      sha256: view.sha256,
      scenario: view.scenario,
      before: view.scenario,
      caller,
      clock: ports.clock,
      stores: ports.stores,
      files: { code: view.files.code, data: view.files.data },
    });
  } catch (e) {
    throw new EngineError('internal', `the project's record of scenario writes (${STATE_DIR}/${PROJECT_SCENARIO_WRITES_FILE}) could not be written: ${(e as Error).message} — nothing was settled`);
  }
}
