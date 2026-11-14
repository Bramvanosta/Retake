/**
 * The take, and the rules every reader of a project's runs shares: whether a capture can be edited (`takeOf`), which
 * run `latest` names (`orderRuns`, `latestTake`), and which captures prune keeps (`pruneKeeper`). A run named by its id
 * or its folder has its own, older rule (`namedRunProblem`): it works whatever its record says.
 *
 * Pure: the rules take facts an adapter read (core/io run-folder.ts), never a path. No I/O, no clock.
 */
import { isRunId, runIdStamp } from './id-grammar.js';
import { printableText } from './printable.js';
import { SLUG_RE } from './schemas/primitives.js';
import type { RunId } from './id-grammar.js';
import { isFilmName } from './run-record.js';
import type { FileProblem, Read, RunRead, StoredRunRecord, TimelineHead } from './run-record.js';

/** What a run folder holds, as an adapter read it. */
export interface RunFolderFacts {
  /** The folder's name. */
  name: string;
  /** A real folder, a symbolic link (nothing behind it is read unless the run was named), gone, or something else. */
  folder: 'dir' | 'link' | 'gone' | 'other';
  record: RunRead;
  /** The timeline's head; `not-read`: the adapter did not open it, because the record alone decides (takeNeedsTimeline). */
  timeline: Read<TimelineHead, { ok: false; problem: 'not-read' }>;
  /** The film the timeline names (`capture.mp4` when it names none, does not read or was not read). */
  film: 'file' | 'link' | 'missing' | 'other';
  /** run.json is a symbolic link. */
  recordLink: boolean;
  /** timeline.json is a symbolic link. */
  timelineLink: boolean;
}

/** The filming of a capture that an edit can work on. */
export interface Take {
  run: RunId;
  scenario: string;
  /** The film's file name in the run folder. */
  film: string;
  finished_at: string;
  /** The capture was stopped by `--until` after this step: a fact the take carries; the rule does not judge it. */
  until?: { scene: string; step: number };
}

/**
 * Why a run folder is not a usable capture: the first that applies, in this order. `not-a-run-id`: its name is not a
 * run id, or it is no folder at all. `outside`: only for work submitted through MCP (takeOf's `outside`).
 */
export type NotUsable =
  | 'not-a-run-id'
  | 'linked'
  | 'outside'
  | 'no-record'
  | 'record-unreadable'
  | 'newer-format'
  | 'unknown-status'
  | 'dry-run'
  | 'not-finished'
  | 'failed'
  | 'cancelled'
  | 'no-timeline'
  | 'timeline-unreadable'
  | 'scenario-mismatch'
  | 'film-outside'
  | 'no-film';

/**
 * A usable take, or why not. `scenario`: the scenario the run's record names, when it reads. `capture`: whether the
 * run is a capture as far as it can be told (a dry run is never "passed over"). `message`: the sentence of a record
 * made for a newer Retake.
 */
export type TakeVerdict = { usable: true; take: Take } | { usable: false; why: NotUsable; scenario?: string; capture: boolean; message?: string };

/**
 * Whether a film that is a symbolic link inside a real run folder makes a take usable: no — as a linked run folder,
 * as the Studio's lists, which never show such a film. (A run named by its id still renders at a terminal.)
 */
const LINKED_FILM_USABLE = false;

/** Whether anything of the run folder the rule reads is a symbolic link. */
function linked(f: RunFolderFacts): boolean {
  return f.folder === 'link' || f.recordLink || f.timelineLink || (f.film === 'link' && !LINKED_FILM_USABLE);
}

/**
 * Where a capture was stopped by `--until`, when it was. Such a capture is usable (it succeeded): the take carries the
 * fact so that whoever names it can say so.
 */
function untilOf(record: StoredRunRecord): Take['until'] {
  return record.stopped_at?.reason === 'until' ? { scene: record.stopped_at.scene, step: record.stopped_at.step } : undefined;
}

/** What a record that reads says against the run being a take, by itself: a dry run, a run that has not ended, or ended badly. */
function recordSays(record: StoredRunRecord): Extract<NotUsable, 'dry-run' | 'not-finished' | 'failed' | 'cancelled'> | null {
  if (record.mode === 'dry') return 'dry-run';
  if (record.status === 'queued' || record.status === 'running') return 'not-finished';
  if (record.status === 'failed') return 'failed';
  if (record.status === 'cancelled') return 'cancelled';
  return null;
}

/**
 * Whether rule 1 needs a run's timeline: only when its record reads and does not by itself say the run is no take —
 * of `scenario`, when one is asked. An adapter that walks many runs asks this before it opens a timeline (megabytes,
 * for four members): the record of a failed take, a dry run or another scenario's capture is the whole answer.
 */
export function takeNeedsTimeline(record: RunRead, scenario?: string): boolean {
  return record.ok && recordSays(record.value) === null && (scenario === undefined || record.value.scenario === scenario);
}

/**
 * Rule 1 — a usable capture: a real folder (not a link) whose name is a run id; a run.json that reads, is not a link
 * and says a capture that succeeded; a timeline.json whose head reads whole (with its run id and its film's name), is
 * not a link and says a capture of the same scenario as the record; the film it names (`capture.mp4` when the name is
 * empty) a regular file of the folder. Only the head is looked at: a take whose timeline's lists are no lists is
 * refused, in one sentence, by the command that reads the whole timeline.
 *
 * `o.outside`: the adapter found that the folder — a real one — does not lie in the project once links above it are
 * followed (`runs/` itself is a link to another disk), and the work is an agent's: through MCP such a run is no take,
 * as naming it is refused (namedRunProblem). A terminal never sets it.
 */
export function takeOf(facts: RunFolderFacts, o: { outside?: boolean } = {}): TakeVerdict {
  const no = (why: NotUsable, o: { scenario?: string; capture?: boolean; message?: string } = {}): TakeVerdict => ({
    usable: false,
    why,
    ...(o.scenario !== undefined ? { scenario: o.scenario } : {}),
    capture: o.capture ?? false,
    ...(o.message !== undefined ? { message: o.message } : {}),
  });
  if (!isRunId(facts.name)) return no('not-a-run-id');
  const r = facts.record;
  // What the record says of itself, for the notice — also when the run is refused for a link.
  const said = r.ok ? { scenario: r.value.scenario, capture: r.value.mode === 'capture' } : r.problem === 'unknown-status' ? { scenario: r.record.scenario, capture: r.record.mode === 'capture' } : {};
  if (linked(facts)) return no('linked', said);
  if (o.outside) return no('outside', said);
  // Not a run folder at all (a plain file of runs/, an entry gone since it was listed): never counted, never named.
  if (facts.folder !== 'dir') return no('not-a-run-id');
  if (!r.ok) {
    // No run.json: a folder that holds a timeline is a run folder without its record (someone can name it; `latest`
    // counts it); one with neither file is no run folder at all — an empty folder, one being made: never counted.
    if (r.problem === 'missing') return no(!facts.timeline.ok && facts.timeline.problem === 'missing' ? 'not-a-run-id' : 'no-record');
    // A record of a newer format says its scenario and its kind leniently: a dry run is never a capture passed over.
    if (r.problem === 'newer-format') return no('newer-format', { ...(r.scenario !== undefined ? { scenario: r.scenario } : {}), capture: r.dry !== true, message: r.message });
    if (r.problem === 'unknown-status') return no('unknown-status', said);
    return no('record-unreadable');
  }
  const record = r.value;
  const says = recordSays(record);
  if (says || record.status !== 'succeeded') return no(says ?? 'not-finished', said);
  const t = facts.timeline;
  // `not-read` cannot be met here by an adapter that asked takeNeedsTimeline; if one did not, the run is no take.
  if (!t.ok) return no(t.problem === 'missing' ? 'no-timeline' : 'timeline-unreadable', said);
  if (t.value.mode === 'dry') return no('dry-run', said);
  // A head that lacks its run id or its film's name is a timeline no runner wrote: someone may name the run.
  if (t.value.lacks !== undefined) return no('timeline-unreadable', said);
  if (t.value.scenario !== record.scenario) return no('scenario-mismatch', said);
  if (!isFilmName(t.value.film)) return no('film-outside', said);
  if (facts.film !== 'file') return no('no-film', said);
  const until = untilOf(record);
  return { usable: true, take: { run: facts.name, scenario: record.scenario, film: t.value.film, finished_at: record.finished_at, ...(until ? { until } : {}) } };
}

/**
 * Where a capture stopped by `--until` ends, in words that can be repeated: the scene when it reads as a scene id (a
 * slug of at most 100 characters) with a whole step — run.json is a file anyone may write, and only such words are
 * said, at a terminal as through MCP. Null: only "it stops early" can be said.
 */
export function untilStep(until: { scene: unknown; step: unknown }): { scene: string; step: number } | null {
  const said = typeof until.scene === 'string' && until.scene.length <= 100 && SLUG_RE.test(until.scene) && typeof until.step === 'number' && Number.isInteger(until.step) && until.step >= 0;
  return said ? { scene: until.scene as string, step: until.step as number } : null;
}

/** A text a file holds (a timeline's scenario, the film it names), made printable on one line and cut short, for a sentence. */
const fileText = (s: string): string => {
  const shown = printableText(s);
  return shown.length > 200 ? `${shown.slice(0, 200)}…` : shown;
};

/** Why a run named by its id or its folder cannot be worked on. */
export type NamedProblem =
  | { why: 'linked-outside' }
  | { why: 'outside' }
  | { why: 'linked-files' }
  | { why: 'film-outside' }
  | { why: 'newer-format'; message: string }
  | { why: 'no-timeline' }
  | { why: 'timeline-unreadable'; problem: Exclude<FileProblem, 'missing'> }
  | { why: 'scenario-mismatch'; scenario: string; asked: string }
  | { why: 'dry-run' }
  | { why: 'no-film'; film: string };

/**
 * What a timeline that did not read means for a run someone named: null when it read. The one mapping every shell
 * uses, for the head (RunFolderFacts.timeline) and for the whole timeline (a head that reads under lists that are none).
 */
export function timelineProblem(read: Read<unknown, { ok: false; problem: 'not-read' }>): Extract<NamedProblem, { why: 'no-timeline' | 'timeline-unreadable' }> | null {
  if (read.ok) return null;
  if (read.problem === 'missing') return { why: 'no-timeline' };
  return { why: 'timeline-unreadable', problem: read.problem === 'not-read' ? 'unreadable' : read.problem };
}

/**
 * The named run: null unless — through MCP, the folder does not lie in the project once links are followed (the
 * adapter resolves: `inside`), whether the folder is a link itself or a folder above it is; through MCP, its run.json
 * or its timeline.json is a link; its record is of a newer format; its timeline is missing or does not read; through
 * MCP, the film its timeline names is not a file of the run folder (isFilmName: one path segment — said before
 * anything is told of that file) or is a link; `asked.scenario` is given and differs from the timeline's; it is a dry
 * run; its film is missing. It does not look at the record's status or the folder's name, and at a terminal not at
 * what is a link either: a run named by a person works whatever its record says, with a timeline made by hand too
 * (no run id in it, no film named: the film is `capture.mp4`), and its film is where its timeline says.
 */
export function namedRunProblem(facts: RunFolderFacts, asked: { scenario?: string; trust: 'author' | 'mcp'; inside: boolean }): NamedProblem | null {
  const mcp = asked.trust === 'mcp';
  // (A folder that is gone, or no folder, is said as what it lacks: there is nothing there to be outside.)
  if (mcp && !asked.inside && (facts.folder === 'link' || facts.folder === 'dir')) return { why: facts.folder === 'link' ? 'linked-outside' : 'outside' };
  if (mcp && (facts.recordLink || facts.timelineLink)) return { why: 'linked-files' };
  if (!facts.record.ok && facts.record.problem === 'newer-format') return { why: 'newer-format', message: facts.record.message };
  const t = facts.timeline;
  if (!t.ok) return timelineProblem(t);
  if (mcp && !isFilmName(t.value.film)) return { why: 'film-outside' };
  if (mcp && facts.film === 'link') return { why: 'linked-files' };
  if (asked.scenario !== undefined && t.value.scenario !== asked.scenario) return { why: 'scenario-mismatch', scenario: t.value.scenario, asked: asked.scenario };
  if (t.value.mode === 'dry') return { why: 'dry-run' };
  if (facts.film === 'missing') return { why: 'no-film', film: t.value.film };
  return null;
}

/**
 * Rule 2's order — the names that are run ids: dated ids first (the stamp the runner writes), newest first (they sort
 * chronologically), then the other names, descending. A folder named to sort above every date is never before a
 * dated run.
 */
export function orderRuns(names: readonly string[]): RunId[] {
  return names.filter((n): n is RunId => isRunId(n)).sort((a, b) => Number(runIdStamp(b) !== null) - Number(runIdStamp(a) !== null) || (a < b ? 1 : a > b ? -1 : 0));
}

/** A newer capture of the scenario that `latest` did not take, and why. */
export interface PassedOver {
  run: RunId;
  why: NotUsable;
}

/** How many passed-over runs `latest` names (it counts the others). */
export const PASSED_OVER_MAX = 5;

/** What `latest` answered: the take (none: nothing usable), and what it passed over on the way. */
export interface LatestPick {
  take?: Take;
  /** The newer captures of the scenario it did not take, newest first (at most PASSED_OVER_MAX). */
  passed: PassedOver[];
  /** How many more it passed over. */
  passed_more: number;
  /** Every capture it passed over (the named ones and the others), counted by reason, in the order the reasons were met. */
  reasons: Array<{ why: NotUsable; count: number }>;
  /**
   * Run folders met on the way whose run.json is missing or does not read as a record: never named (nothing says
   * which scenario they are of), only counted — whether or not a take was found.
   */
  without_record: number;
  /**
   * Set when nothing is usable and every capture passed over was written by a newer Retake: the newest one and its
   * sentence (the caller's error is then "update Retake", not "no capture run").
   */
  only_newer?: { run: RunId; message: string };
}

/**
 * Rule 2 — `latest`: the first usable take of `ordered` (orderRuns) whose record names `scenario` (any scenario when
 * undefined). Lazy: `look` is not called for a run older than the pick. On the way it collects the captures it passed
 * over — runs whose readable record names the scenario — and counts the folders without a readable record; a folder's
 * name never says which scenario a run is of.
 */
export async function latestTake(ordered: readonly RunId[], scenario: string | undefined, look: (id: RunId) => Promise<TakeVerdict> | TakeVerdict): Promise<LatestPick> {
  const passed: PassedOver[] = [];
  const reasons: LatestPick['reasons'] = [];
  let more = 0;
  let withoutRecord = 0;
  let newer: { run: RunId; message: string } | undefined;
  let other = false;
  for (const id of ordered) {
    const v = await look(id);
    if (v.usable) {
      if (scenario === undefined || v.take.scenario === scenario) return { take: v.take, passed, passed_more: more, reasons, without_record: withoutRecord };
      continue;
    }
    if (v.why === 'no-record' || v.why === 'record-unreadable') {
      withoutRecord++;
      continue;
    }
    if (!v.capture || v.scenario === undefined || (scenario !== undefined && v.scenario !== scenario)) continue;
    if (v.why === 'newer-format' && v.message !== undefined) newer ??= { run: id, message: v.message };
    else other = true;
    if (passed.length < PASSED_OVER_MAX) passed.push({ run: id, why: v.why });
    else more++;
    const reason = reasons.find((x) => x.why === v.why);
    if (reason) reason.count++;
    else reasons.push({ why: v.why, count: 1 });
  }
  return { passed, passed_more: more, reasons, without_record: withoutRecord, ...(newer && !other ? { only_newer: newer } : {}) };
}

// ── Rule 3 — the captures prune keeps ──────────────────────────────────────

/**
 * Why prune keeps a capture, per scenario as the records name it: `last-capture` — the newest run whose record says a
 * capture that succeeded, whatever its folder still holds; `editable` — the newest usable take (rule 1); `complete` —
 * the newest usable take that was not stopped by `--until`.
 */
export type PruneKeep = 'last-capture' | 'editable' | 'complete';

/**
 * Why prune leaves a run folder alone — kept, never "the last capture" of a scenario, never listed: `linked` — the
 * folder is a symbolic link (nothing behind it is read); `newer-format` — its run.json was written by a newer Retake.
 */
export type PruneAlone = 'linked' | 'newer-format';

/**
 * What a run.json says of its run in the file's own words, for a run prune decides on: read by the one reader, or —
 * for a file the reader does not take as a record — as prune always read it (`scenario` and `mode` are then whatever
 * the file holds).
 */
export interface PruneSaid {
  scenario: unknown;
  mode: unknown;
  status: string;
}

/**
 * What prune's own read of a run.json the reader did not take (a link, a file over the reader's cap) found it to be: a
 * record of a newer Retake — left alone like one the reader met. `scenario`: the one it names, when it is text.
 */
export interface PruneNewer {
  newer: true;
  scenario?: string;
}

/** A run prune decides on: what its record says, and what the rule keeps it for (none: nothing of the rule keeps it). */
export interface PruneRun extends PruneSaid {
  /** The folder's name. */
  id: string;
  keep: PruneKeep[];
}

/**
 * What the rule answers, newest first: the runs prune decides on, the folders it leaves alone, and how many folders
 * hold no run.json that says anything (kept as they always were: counted, never listed).
 */
export interface PruneRuns {
  runs: PruneRun[];
  /** `scenario`: the scenario a newer record names, when it says one (read leniently, for whoever keeps things per scenario). */
  alone: Array<{ id: string; why: PruneAlone; scenario?: string }>;
  unread: number;
}

/**
 * Rule 3 — what prune keeps of the captures: per scenario the newest run whose record says a capture that succeeded
 * AND the newest usable take AND the newest usable take not stopped by `--until` (one run, when it is all three). A
 * linked folder and a record of a newer Retake are left alone: never the last capture of anything, never a run to
 * delete. The rule only adds to what the record alone kept: a run is a candidate exactly when it was one before (a
 * real folder whose run.json says an id and a status), a linked folder and a newer record apart.
 *
 * Fed one run folder at a time, NEWEST FIRST (orderRuns): `add` the facts of each — with `said` for a folder whose
 * run.json the reader does not take as a record (what the file says all the same — or that it is a record of a newer
 * Retake: left alone too —; null: nothing) —; `needsTimeline` is the reader's question for the next one (core/io
 * readRunFolder `timeline`), answered from the record: a timeline is opened only for a capture that succeeded of a
 * scenario whose complete take is not found yet — and, once the scenario's take that can be edited is found, not for
 * a capture its record says was stopped by `--until` (it can be neither) —, so an older run costs its run.json alone.
 */
export function pruneKeeper(): { needsTimeline(record: RunRead): boolean; add(facts: RunFolderFacts, said?: PruneSaid | PruneNewer | null): void; done(): PruneRuns } {
  const runs: PruneRun[] = [];
  const alone: PruneRuns['alone'] = [];
  let unread = 0;
  // The scenarios whose newest of each kind is found (a scenario: what the record holds there, text or not).
  const found: Record<PruneKeep, Set<unknown>> = { 'last-capture': new Set(), editable: new Set(), complete: new Set() };
  return {
    needsTimeline: (record) =>
      record.ok &&
      takeNeedsTimeline(record) &&
      !found.complete.has(record.value.scenario) &&
      // Stopped by `--until`: never the complete take, and the one that can be edited is already found.
      !(found.editable.has(record.value.scenario) && untilOf(record.value) !== undefined),
    add(facts, lenient) {
      const id = facts.name;
      if (facts.folder === 'link') return void alone.push({ id, why: 'linked' });
      const r = facts.record;
      if (facts.folder === 'dir' && !r.ok && r.problem === 'newer-format') return void alone.push({ id, why: 'newer-format', ...(r.scenario !== undefined ? { scenario: r.scenario } : {}) });
      const own = facts.folder !== 'dir' || r.ok || r.problem === 'unknown-status' ? null : (lenient ?? null);
      // A record of a newer Retake behind a run.json the reader did not open: left alone as well.
      if (own && 'newer' in own) return void alone.push({ id, why: 'newer-format', ...(own.scenario !== undefined ? { scenario: own.scenario } : {}) });
      const said: PruneSaid | null = facts.folder !== 'dir' ? null : r.ok ? r.value : r.problem === 'unknown-status' ? r.record : own;
      if (!said) return void unread++;
      const keep: PruneKeep[] = [];
      const first = (why: PruneKeep): void => {
        if (found[why].has(said.scenario)) return;
        found[why].add(said.scenario);
        keep.push(why);
      };
      if (said.mode === 'capture' && said.status === 'succeeded') first('last-capture');
      const verdict = takeOf(facts);
      if (verdict.usable) {
        first('editable');
        if (verdict.take.until === undefined) first('complete');
      }
      runs.push({ id, scenario: said.scenario, mode: said.mode, status: said.status, keep });
    },
    done: () => ({ runs, alone, unread }),
  };
}

/** R-1 (L7.6b): a take kept because a file of renders/ that is no render of its own name says its id. */
export type PruneRenderFile = 'render-file';

const PRUNE_KEPT_WORDS: Record<Exclude<PruneKeep, 'last-capture'> | PruneAlone | PruneRenderFile, string> = {
  'render-file': 'a file of renders/ that is no render names it',
  editable: 'the last capture that can be edited',
  complete: 'the last complete capture (a newer one was stopped by --until)',
  linked: 'its folder is a link (left alone)',
  'newer-format': 'written by a newer Retake (left alone)',
};

/** Why prune kept a take that its list would otherwise hold, or left a folder alone: fixed words, never a text read from a file. */
export function pruneKeptWords(why: Exclude<PruneKeep, 'last-capture'> | PruneAlone | PruneRenderFile): string {
  return PRUNE_KEPT_WORDS[why];
}

const REASON_WORDS: Record<NotUsable, string> = {
  'not-a-run-id': 'it is not a run folder',
  linked: 'its files are links',
  outside: 'it lies outside the project',
  'no-record': 'it has no run.json',
  'record-unreadable': 'its run.json does not read as a record',
  'newer-format': 'written by a newer Retake',
  'unknown-status': 'its status is not one Retake writes',
  'dry-run': 'a dry run',
  // A record that says `running` does not say whether its process still is: both are said.
  'not-finished': 'not finished, or interrupted',
  failed: 'failed',
  cancelled: 'cancelled',
  'no-timeline': 'its timeline is missing',
  'timeline-unreadable': 'its timeline does not read',
  'scenario-mismatch': 'its timeline is of another scenario',
  'film-outside': 'its film is not a file of its folder',
  'no-film': 'its film is missing',
};

const TIMELINE_WORDS: Record<Extract<NamedProblem, { why: 'timeline-unreadable' }>['problem'], string> = {
  unreadable: 'timeline.json cannot be read',
  'too-big': 'timeline.json is too big',
  'not-a-file': 'timeline.json is not a regular file',
  'not-json': 'timeline.json is not JSON',
  invalid: 'timeline.json is not a timeline',
};

/**
 * The words of a reason. A `NotUsable`: fixed words for a notice ("failed", "its film is missing") — a closed list,
 * never a message read from a file. A `NamedProblem`: the whole sentence of the refusal of run `o.run` for `o.verb`
 * (`o.dir`: the run folder, named by the sentences that have always named it). A text the run's files hold — the
 * scenario a timeline names, its film — is said printable, on one line (core printableText): never as the file has it.
 */
export function takeWords(why: NotUsable | NamedProblem, o: { run: string; verb: 'render' | 'plan' | 'export'; dir?: string }): string {
  if (typeof why === 'string') return REASON_WORDS[why];
  const dir = o.dir ?? o.run;
  switch (why.why) {
    case 'linked-outside':
      return `run ${o.run} is a link to a folder outside the project: through MCP a ${o.verb === 'render' ? 'render' : o.verb} reads only the runs inside it`;
    case 'outside':
      return `run ${o.run} lies outside the project (its folder, or a folder above it, is a link): through MCP a ${o.verb} reads only the runs inside it`;
    case 'linked-files':
      return `run ${o.run}: its files are links: through MCP a ${o.verb} reads only the files of the run folder itself`;
    case 'film-outside':
      return `run ${o.run}: the film its timeline names is not a file of the run folder: through MCP a ${o.verb === 'render' ? 'render' : o.verb} reads only the film inside it`;
    case 'newer-format':
      return `run ${o.run}: ${why.message}`;
    case 'no-timeline':
      return o.verb === 'export' ? `${dir} has no timeline.json (not a run, or the run did not finish)` : `run ${o.run} has no timeline.json (${dir})`;
    case 'timeline-unreadable':
      return `run ${o.run}: its timeline does not read (${TIMELINE_WORDS[why.problem]})`;
    case 'scenario-mismatch':
      return `run ${o.run} is a run of scenario "${fileText(why.scenario)}", not "${why.asked}"`;
    case 'dry-run':
      return o.verb === 'export' ? `run ${o.run} is a dry run: it has no capture to export` : `run ${o.run} is a dry run: there is no capture to ${o.verb}`;
    case 'no-film':
      return `run ${o.run} has no capture video (${o.dir !== undefined ? `${o.dir}/${fileText(why.film)}` : fileText(why.film)})`;
  }
}
