import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  canonicalJson,
  collectSecretRefs,
  homeKey,
  homeKeyFile,
  homeSign,
  homeSigned,
  interpolateDeep,
  readHomeKey,
  readOnlyHookMessage,
  rollbackWriteReason,
  sandboxOf,
  writeJson,
  projectPath,
} from '@retake/core';
import { HookSecurityError, JournalError, errorMessage } from './errors.js';
import { actionLines, fieldLines, shownRollback } from './shown.js';
import { executeRollback } from './kinds/index.js';
import { recordHookRun } from './record.js';
import { logger, redactText } from './secrets.js';
import type { HookContext, HookResult, JournalEntry, JournalFile, NewJournalEntry, RollbackAction } from './types.js';
import { isRecord, nowIso } from './util.js';

export const JOURNAL_FILE = 'hooks-journal.json';
/**
 * Journals of hooks run outside a capture (`retake hooks run`, `retake env reset`), relative to the project dir:
 * `<project>/.retake/journals/<id>.json` — kept out of runs/ so they never look like runs (git-ignored).
 */
export const JOURNALS_DIR = '.retake/journals';

export interface JournalLocations {
  /** Default `<projectDir>/runs`: run journals are `<runsDir>/<run-id>/hooks-journal.json`. */
  runsDir?: string;
  /** Default `<projectDir>/.retake/journals`: standalone journals are `<journalsDir>/<id>.json`. */
  journalsDir?: string;
}

/** Journal file of a standalone hooks run (`retake hooks run`, `retake env reset`). */
export function standaloneJournalFile(projectDir: string, id: string, opts: JournalLocations = {}): string {
  return join(opts.journalsDir ?? join(projectDir, JOURNALS_DIR), `${id}.json`);
}

/** The journal of `id`: a run's `runs/<id>/hooks-journal.json`, else `.retake/journals/<id>.json`; null when neither exists. */
export function findJournal(projectDir: string, id: string, opts: JournalLocations = {}): string | null {
  const run = join(opts.runsDir ?? projectPath(projectDir, 'runs'), id, JOURNAL_FILE);
  if (existsSync(run)) return run;
  const standalone = standaloneJournalFile(projectDir, id, opts);
  return existsSync(standalone) ? standalone : null;
}

/** Id of a journal file: the run id (`runs/<id>/hooks-journal.json`) or the file name (`journals/<id>.json`). */
export function journalId(file: string): string {
  return basename(file) === JOURNAL_FILE ? basename(dirname(file)) : basename(file).replace(/\.json$/i, '');
}

const KINDS = new Set(['http', 'sql', 'shell', 'js']);
const PHASES = new Set(['setup', 'teardown', 'reset', 'seed', 'step']);
const STATUSES = new Set(['ok', 'failed', 'rolled_back']);

/** Executed, with a rollback action that has not succeeded yet (and was not superseded by a sandbox reset). */
export function isPending(e: JournalEntry): boolean {
  return e.status === 'ok' && e.rollback !== undefined && e.superseded === undefined;
}

function validate(value: unknown, file: string): JournalFile {
  const bad = (why: string) => new JournalError(`hooks journal ${file} is malformed: ${why}`, file);
  if (!isRecord(value)) throw bad('expected a JSON object');
  if (value.version !== 1) throw bad(`unsupported version ${JSON.stringify(value.version)} (expected 1)`);
  if (!Array.isArray(value.entries)) throw bad('`entries` must be an array');
  value.entries.forEach((e: unknown, i: number) => {
    if (!isRecord(e)) throw bad(`entries[${i}] is not an object`);
    if (typeof e.seq !== 'number') throw bad(`entries[${i}].seq must be a number`);
    if (!KINDS.has(e.kind as string)) throw bad(`entries[${i}].kind ${JSON.stringify(e.kind)} is unknown`);
    if (!PHASES.has(e.phase as string)) throw bad(`entries[${i}].phase ${JSON.stringify(e.phase)} is unknown`);
    if (!STATUSES.has(e.status as string)) throw bad(`entries[${i}].status ${JSON.stringify(e.status)} is unknown`);
    if (e.rollback !== undefined && (!isRecord(e.rollback) || !KINDS.has(e.rollback.kind as string))) {
      throw bad(`entries[${i}].rollback is invalid`);
    }
  });
  const now = nowIso();
  return {
    version: 1,
    created_at: typeof value.created_at === 'string' ? value.created_at : now,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : now,
    entries: value.entries as JournalEntry[],
  };
}

export interface JournalOptions {
  /**
   * The signing key's file (default the Retake home's, core homeKeyFile). The record of the rollbacks replayed
   * (ROLLBACKS_DONE_DIR) is kept beside it.
   */
  keyFile?: string;
}

/**
 * `<RETAKE_HOME>/rollbacks-done/<sha256 of an entry's identity>`: the signed entries whose rollback was replayed. Its
 * identity — where its journal stands, its seq, its start and its rollback — stays the same through its attempts, so
 * no copy of it, in any state, is replayed after it succeeded once.
 */
export const ROLLBACKS_DONE_DIR = 'rollbacks-done';
/** A signed entry older than this (its `started_at`) is not trusted any more: the record of its replay may be gone. */
export const ROLLBACKS_DONE_KEEP_MS = 365 * 24 * 3600_000;

/**
 * Where a journal stands, as its entries' signatures cover it: the real path of its project's folder (which names the
 * workspace), that folder's own name, the location (`run`: runs/<id>/hooks-journal.json; `journals`:
 * .retake/journals/<id>.json; `file`: any other journal, by its folder) and the journal's path in it. An entry signed in
 * one journal does not verify in another — another project or workspace, the other location, another id.
 */
interface JournalPlace {
  project: string;
  name: string;
  kind: 'run' | 'journals' | 'file';
  rel: string;
}

/** The real path of `p`: its nearest existing folder resolved (links included), the rest as written. */
async function realPathOf(p: string): Promise<string> {
  const rest: string[] = [];
  let at = resolve(p);
  for (;;) {
    try {
      return join(await realpath(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return join(at, ...rest.reverse());
      rest.push(basename(at));
      at = up;
    }
  }
}

async function placeOf(file: string): Promise<JournalPlace> {
  const abs = resolve(file);
  const dir = dirname(abs);
  if (basename(abs) === JOURNAL_FILE && basename(dirname(dir)) === 'runs') {
    const project = dirname(dirname(dir));
    return { project: await realPathOf(project), name: basename(project), kind: 'run', rel: `runs/${basename(dir)}/${JOURNAL_FILE}` };
  }
  if (basename(dir) === 'journals' && basename(dirname(dir)) === '.retake') {
    const project = dirname(dirname(dir));
    return { project: await realPathOf(project), name: basename(project), kind: 'journals', rel: `${JOURNALS_DIR}/${basename(abs)}` };
  }
  return { project: await realPathOf(dir), name: basename(dir), kind: 'file', rel: basename(abs) };
}

/** What an entry's signature covers: where its journal stands (JournalPlace) and the whole entry (its seq included) but its signature. */
function signedText(place: JournalPlace, e: JournalEntry): string {
  const { sig: _s, ...rest } = e;
  return canonicalJson({ v: 2, journal: place, entry: rest });
}

function doneFile(keyFile: string, place: JournalPlace, e: JournalEntry): string {
  const identity = canonicalJson({ v: 1, journal: place, seq: e.seq, started_at: e.started_at, rollback: e.rollback ?? null });
  return join(dirname(keyFile), ROLLBACKS_DONE_DIR, createHash('sha256').update(identity).digest('hex'));
}

/** Remove the records of rollbacks replayed longer ago than ROLLBACKS_DONE_KEEP_MS (a worker's start). */
export async function pruneDoneRollbacks(keyFile: string = homeKeyFile(), now: number = Date.now()): Promise<void> {
  const dir = join(dirname(keyFile), ROLLBACKS_DONE_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    const st = await stat(join(dir, name)).catch(() => undefined);
    if (st && now - st.mtimeMs > ROLLBACKS_DONE_KEEP_MS) await rm(join(dir, name), { force: true }).catch(() => undefined);
  }
}

/**
 * A rollback action in full, as it would run — its templates filled from the data the entry carries (a secret is never
 * resolved: an action that references one is shown as written) — one line per field, every character visible
 * (shown.ts; L5.14: what a person reads before replaying an entry Retake did not sign).
 */
export function rollbackActionLines(action: RollbackAction): string[] {
  let a: RollbackAction = action;
  if (!collectSecretRefs(action).size) {
    try {
      const d = action.data ?? {};
      a = interpolateDeep(action, { pages: d.pages ?? {}, vars: d.vars ?? {}, hooks: d.hooks ?? {}, run: d.run, extra: d.extra, secrets: () => undefined });
    } catch {
      a = action;
    }
  }
  return [...fieldLines('kind', a.kind), ...actionLines(shownRollback(a))];
}

/**
 * Why an entry Retake did not sign is never replayed, whoever asks, or null: a sql one (it connects with the
 * environment's database URL), a js one (it runs in the environment's signed-in page), one that references a secret, a
 * shell one on a sandbox environment (it would get the sandbox's variables).
 */
function unsignedNever(action: RollbackAction, env: string, ctx: HookContext): string | null {
  const byHand = 'if it is right, run it by hand';
  if (action.kind === 'sql') return `an unsigned sql rollback is never replayed (it would connect with the environment's database): ${byHand}`;
  if (action.kind === 'js') return `an unsigned js rollback is never replayed (it would run in the environment's signed-in page): ${byHand}`;
  if (collectSecretRefs(action).size) return `it references secrets — an unsigned entry is never given secrets: ${byHand}`;
  if (action.kind === 'shell' && sandboxOf(ctx.project, env)) return `it would run with the variables of sandbox ${env} — an unsigned entry is never given them: ${byHand}`;
  return null;
}

/**
 * Rollback journal of executed hooks, persisted atomically as JSON after every change
 * (runs/<id>/hooks-journal.json for captures, .retake/journals/<id>.json for standalone hook runs).
 * Not safe for concurrent use by several processes.
 *
 * L5.14: every entry Retake writes is signed with the Retake home's key (core home-key.ts) over where its journal
 * stands (JournalPlace: project, workspace, location, id) and its whole content (its seq included), signed again on
 * every save. An entry is trusted only with a valid signature, a seq no other entry of its journal has, and a
 * `started_at` within ROLLBACKS_DONE_KEEP_MS; a trusted entry's rollback is replayed once (ROLLBACKS_DONE_DIR: a copy
 * of the entry, as it was before, is not replayed again). An entry read back untrusted — a journal placed or edited by
 * something else, copied or moved from elsewhere, of an older Retake — is never re-signed and never replayed with
 * trust `mcp` (refused, and said); elsewhere only when a person, shown the action in full, says yes to it
 * (`replayUnsigned`: the CLI's `--replay-unsigned`, in a terminal), and never a sql or js one, one that references a
 * secret, or a shell one on a sandbox environment (its variables).
 */
export class Journal {
  private writing: Promise<void> = Promise.resolve();
  private rolling: Promise<unknown> = Promise.resolve();
  /** Entries written by this process or read back with a valid signature: the only ones signed on save. */
  private readonly trusted = new WeakSet<JournalEntry>();

  private constructor(
    readonly file: string,
    private readonly data: JournalFile,
    private readonly keyFile: string,
    private readonly place: JournalPlace,
  ) {}

  /** Load a journal, or start an empty one (the file is created on the first record). */
  static async open(file: string, opts: JournalOptions = {}): Promise<Journal> {
    const keyFile = opts.keyFile ?? homeKeyFile();
    const place = await placeOf(file);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        const now = nowIso();
        return new Journal(file, { version: 1, created_at: now, updated_at: now, entries: [] }, keyFile, place);
      }
      throw new JournalError(`cannot read hooks journal ${file}: ${errorMessage(e)}`, file);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new JournalError(`hooks journal ${file} is not valid JSON: ${errorMessage(e)}`, file);
    }
    const journal = new Journal(file, validate(parsed, file), keyFile, place);
    const key = await readHomeKey(keyFile);
    const seqs = new Map<number, number>();
    for (const e of journal.data.entries) seqs.set(e.seq, (seqs.get(e.seq) ?? 0) + 1);
    const now = Date.now();
    for (const e of journal.data.entries) {
      // A seq repeated in one journal (an entry duplicated) and an entry older than the record of replays: neither is trusted.
      const started = Date.parse(e.started_at);
      if (seqs.get(e.seq) !== 1 || !Number.isFinite(started) || now - started > ROLLBACKS_DONE_KEEP_MS) continue;
      if (homeSigned(key, signedText(place, e), e.sig)) journal.trusted.add(e);
    }
    return journal;
  }

  get entries(): readonly JournalEntry[] {
    return this.data.entries;
  }

  /** Whether Retake wrote this entry with this home (this process, or a valid signature when read). */
  isSigned(entry: JournalEntry): boolean {
    return this.trusted.has(entry);
  }

  /** Append an entry (a fresh `seq` is always assigned) and persist the journal. */
  async record(entry: NewJournalEntry | JournalEntry): Promise<JournalEntry> {
    const stored = this.add(entry);
    await this.save();
    return stored;
  }

  /** Append in memory only (call save()); lets callers keep the entry even when saving fails. */
  add(entry: NewJournalEntry | JournalEntry): JournalEntry {
    const seq = this.data.entries.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
    const { sig: _s, ...rest } = entry as JournalEntry;
    const stored: JournalEntry = { ...rest, seq };
    this.data.entries.push(stored);
    this.trusted.add(stored);
    return stored;
  }

  /** Persist the current state (writes are serialized; each one is atomic). */
  save(): Promise<void> {
    const run = async () => {
      this.data.updated_at = nowIso();
      // Signed again as written (status, attempts…); a key that cannot be made leaves them unsigned (then only a
      // terminal replays them, on request).
      const key = await homeKey(this.keyFile).catch(() => undefined);
      for (const e of this.data.entries) {
        if (!this.trusted.has(e)) continue;
        if (key) e.sig = homeSign(key, signedText(this.place, e));
        else delete e.sig;
      }
      await writeJson(this.file, this.data);
    };
    const next = this.writing.catch(() => undefined).then(run);
    this.writing = next;
    return next.catch((e) => {
      throw new JournalError(`cannot write hooks journal ${this.file}: ${errorMessage(e)}`, this.file);
    });
  }

  /** Executed entries whose rollback has not succeeded yet, in execution order. */
  pending(): JournalEntry[] {
    return this.data.entries.filter(isPending);
  }

  /**
   * Mark the pending entries recorded on environment `env` as superseded (L1.8): a sandbox reset rebuilt that
   * environment's data, so replaying their rollbacks would act on the new data (`DELETE /api/quotes/7` would delete the
   * reseeded quote 7). Persisted when any entry changed; returns how many did.
   */
  async supersede(env: string, by: string, at: string = nowIso()): Promise<number> {
    const hit = this.data.entries.filter((e) => isPending(e) && e.env === env);
    for (const e of hit) e.superseded = { at, by };
    if (hit.length) await this.save();
    return hit.length;
  }

  /** Roll back every pending entry, most recent first. Rolled-back entries are skipped next time. */
  rollbackAll(ctx: HookContext): Promise<HookResult[]> {
    return this.rollbackEntries(
      this.pending().map((e) => e.seq),
      ctx,
    );
  }

  /**
   * Roll back the given entries (by seq) in reverse execution order; entries that are not pending are
   * skipped. Every rollback is attempted even if one fails. With `ctx.dryRun`, only describes them.
   */
  rollbackEntries(seqs: readonly number[], ctx: HookContext): Promise<HookResult[]> {
    const run = async () => {
      const wanted = new Set(seqs);
      const entries = this.data.entries.filter((e) => wanted.has(e.seq) && isPending(e)).sort((a, b) => b.seq - a.seq);
      const results: HookResult[] = [];
      for (const entry of entries) {
        const result = await this.rollbackOne(entry, ctx);
        await recordHookRun(ctx, result);
        results.push(result);
      }
      return results;
    };
    const next = this.rolling.catch(() => undefined).then(run);
    this.rolling = next;
    return next;
  }

  private async rollbackOne(entry: JournalEntry, ctx: HookContext): Promise<HookResult> {
    const log = logger(ctx);
    const action = entry.rollback!;
    const t0 = Date.now();
    const base = {
      index: entry.seq,
      name: entry.name,
      kind: action.kind,
      phase: 'rollback' as const,
      description: action.description,
      journal_seq: entry.seq,
    };
    const label = `rollback of #${entry.seq} (${entry.description})`;
    const refuse = (error: string) => {
      log('error', `${label} refused: ${error}`);
      return { ...base, ok: false, status: 'refused' as const, error, ms: Date.now() - t0 };
    };
    const signed = this.trusted.has(entry);
    // L5.14: an entry Retake did not write here (untrusted) is never replayed with trust `mcp`, and elsewhere only when a
    // person says yes to it, shown in full — never a sql or js one, one with secrets, or a shell one on a sandbox.
    if (!signed) {
      const where = `${journalId(this.file)} #${entry.seq}`;
      const unsigned = `its journal entry (${where}) is not signed by this Retake home for this journal — Retake did not record it here (placed, edited, copied or moved by something else, or written by an older Retake)`;
      if (ctx.trust === 'mcp') return refuse(`not replayed: ${unsigned}; a person can review it and replay it from a terminal`);
      const never = unsignedNever(action, entry.env ?? ctx.env.name, ctx);
      if (ctx.dryRun) {
        const would = never ?? (ctx.replayUnsigned ? 'replayed only if you say yes to it, shown in full' : 'not replayed without --replay-unsigned');
        log('info', `${label} [dry]: not signed by this Retake home: ${would}`);
        return { ...base, ok: true, status: 'dry', message: `not executed (dry run); not signed by this Retake home: ${would}`, ms: Date.now() - t0 };
      }
      if (never) return refuse(`not replayed: ${unsigned}, and ${never}`);
      const asked = typeof ctx.replayUnsigned === 'function' ? await ctx.replayUnsigned(entry, this.file) : ctx.replayUnsigned === true;
      if (!asked) return refuse(`not replayed: ${unsigned}; ${ctx.replayUnsigned ? 'you said no' : 'look at it, then replay it with --replay-unsigned in a terminal'}`);
    }
    // L1.7: a replay writes on the environment the hook ran in — checked against that environment's access, not the
    // command's (`retake env reset` on a read-write environment never replays a production write without --allow-writes).
    const access = (entry.env !== undefined ? ctx.accessOf?.(entry.env) : undefined) ?? ctx.access;
    const writes = access?.mode === 'read-only' ? rollbackWriteReason(action) : null;
    if (access && writes) {
      const error = readOnlyHookMessage(`its rollback: ${writes}`, access);
      log('error', `${label} refused: ${error}`);
      return { ...base, ok: false, status: 'refused', error, ms: Date.now() - t0 };
    }
    // A signed entry's rollback runs once: a copy of the entry as it was before its replay is refused; a failed one may
    // be tried again (its record is removed).
    const done = signed ? doneFile(this.keyFile, this.place, entry) : undefined;
    const twice = 'Retake replayed this rollback before (this journal entry, or a copy of it as it was then): it is not replayed twice';
    if (ctx.dryRun) {
      if (done && existsSync(done)) return refuse(`not replayed: ${twice}`);
      log('info', `${label} [dry]: would run ${action.description}`);
      return { ...base, ok: true, status: 'dry', message: 'not executed (dry run)', ms: Date.now() - t0 };
    }
    if (done) {
      try {
        await mkdir(dirname(done), { recursive: true, mode: 0o700 });
        await writeFile(done, `${JSON.stringify({ at: nowIso() })}\n`, { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return refuse(`not replayed: ${twice}`);
        return refuse(`not replayed: the record of replayed rollbacks (${dirname(done)}) cannot be written: ${errorMessage(e)}`);
      }
    }
    log('info', `${label}: ${action.description}`);
    let message: string;
    try {
      // The entry's own environment: a sql rollback reaches its databases (a sandbox's own), never the command's.
      message = await executeRollback(action, {
        ctx,
        log,
        readOnly: access?.mode === 'read-only',
        ...(entry.env !== undefined ? { env: entry.env } : {}),
        ...(signed ? {} : { unsigned: true }),
      });
    } catch (e) {
      // Not run (or not to the end): it may be tried again.
      if (done) await rm(done, { force: true }).catch(() => undefined);
      const error = redactText(ctx, errorMessage(e));
      entry.rollback_error = error;
      entry.rollback_attempts = (entry.rollback_attempts ?? 0) + 1;
      log('error', `${label} failed: ${error}`);
      const saved = await this.save().then(
        () => '',
        (se: unknown) => `; ${errorMessage(se)}`,
      );
      const status = e instanceof HookSecurityError ? 'refused' : 'failed';
      return { ...base, ok: false, status, error: error + saved, ms: Date.now() - t0 };
    }
    entry.status = 'rolled_back';
    entry.rolled_back_at = nowIso();
    entry.rollback_attempts = (entry.rollback_attempts ?? 0) + 1;
    delete entry.rollback_error;
    log('info', `${label} ok: ${redactText(ctx, message)}`);
    try {
      await this.save();
    } catch (e) {
      const error = `rolled back, but ${errorMessage(e)}`;
      log('error', `${label}: ${error}`);
      return { ...base, ok: false, status: 'failed', message, error, ms: Date.now() - t0 };
    }
    return { ...base, ok: true, status: 'ok', message: redactText(ctx, message), ms: Date.now() - t0 };
  }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && /\.json$/i.test(d.name)).map((d) => d.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Journals with pending rollbacks, from both locations: `<projectDir>/runs/<run-id>/hooks-journal.json` (captures)
 * and `<projectDir>/.retake/journals/<id>.json` (`retake hooks run`, `retake env reset`), most recent first
 * (ids start with a timestamp). Journals that cannot be read are included so the caller surfaces their error when
 * opening them.
 */
export async function findPendingJournals(projectDir: string, opts: JournalLocations = {}): Promise<string[]> {
  const runsDir = opts.runsDir ?? projectPath(projectDir, 'runs');
  const journalsDir = opts.journalsDir ?? join(projectDir, JOURNALS_DIR);
  const candidates: Array<{ id: string; file: string }> = [];
  for (const name of await listDirs(runsDir)) {
    const file = join(runsDir, name, JOURNAL_FILE);
    if (existsSync(file)) candidates.push({ id: name, file });
  }
  for (const name of await listJsonFiles(journalsDir)) candidates.push({ id: name.replace(/\.json$/i, ''), file: join(journalsDir, name) });
  candidates.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const out: string[] = [];
  for (const { file } of candidates) {
    let journal: Journal;
    try {
      journal = await Journal.open(file);
    } catch {
      out.push(file);
      continue;
    }
    if (journal.pending().length) out.push(file);
  }
  return out;
}

/**
 * After a sandbox reset (L1.8): mark every pending rollback recorded on environment `env` as superseded, in both
 * journal locations. Journals that cannot be read are left as they are (their error surfaces when they are replayed).
 * Returns the journals changed and how many entries each.
 */
export async function supersedePendingJournals(
  projectDir: string,
  env: string,
  by: string,
  opts: JournalLocations = {},
): Promise<Array<{ file: string; count: number }>> {
  const out: Array<{ file: string; count: number }> = [];
  const at = nowIso();
  for (const file of await findPendingJournals(projectDir, opts)) {
    let journal: Journal;
    try {
      journal = await Journal.open(file);
    } catch {
      continue;
    }
    const count = await journal.supersede(env, by, at);
    if (count) out.push({ file, count });
  }
  return out;
}

export interface JournalRollback {
  file: string;
  results: HookResult[];
  /** The journal could not be opened. */
  error?: string;
}

/** A journal with pending rollbacks, opened (or why it could not be). */
export interface PendingJournal {
  file: string;
  journal?: Journal;
  error?: string;
}

/** The pending journals of a project, opened once: what a replay will do (the CLI lists it before replaying it). */
export async function openPendingJournals(projectDir: string, opts: JournalLocations & JournalOptions = {}): Promise<PendingJournal[]> {
  const out: PendingJournal[] = [];
  for (const file of await findPendingJournals(projectDir, opts)) {
    try {
      out.push({ file, journal: await Journal.open(file, opts) });
    } catch (e) {
      out.push({ file, error: errorMessage(e) });
    }
  }
  return out;
}

/** Roll back journals opened by openPendingJournals: exactly what was listed, most recent run first. */
export async function rollbackJournals(list: readonly PendingJournal[], ctx: HookContext): Promise<JournalRollback[]> {
  const out: JournalRollback[] = [];
  for (const p of list) {
    if (!p.journal) {
      out.push({ file: p.file, results: [], error: redactText(ctx, p.error ?? 'cannot be opened') });
      continue;
    }
    try {
      out.push({ file: p.file, results: await p.journal.rollbackAll(ctx) });
    } catch (e) {
      out.push({ file: p.file, results: [], error: redactText(ctx, errorMessage(e)) });
    }
  }
  return out;
}

/** env_reset helper: roll back every pending journal of a project, most recent run first. */
export async function rollbackPendingJournals(projectDir: string, ctx: HookContext, opts: JournalLocations & JournalOptions = {}): Promise<JournalRollback[]> {
  return rollbackJournals(await openPendingJournals(projectDir, opts), ctx);
}
