/**
 * The Record screen's words and rules (L4.8, R-UI-20 / 21 / 22) — pure, no React: states, who started a recording,
 * the window note, the check, the target flags, the inserts, the secret placeholders, the time left, the preflight
 * refusal that a Sign in answers, and the insert values the Studio sends. Every function takes enums, numbers and the
 * Studio's own values: none of them puts page text into a sentence (the screen renders page text through `Txt` only).
 * The caps and defaults mirror core record-annotations.ts (the app imports no runtime code from core; the server
 * validates every value again).
 */
import type { DraftSource, RecordInsert, RecordInsertAt, SecretFieldKind } from '@retake/core/run';
import type { JobClient } from '@retake/engine';
import type { RecordCheckView, RecordState } from '@retake/engine';

/** Quick inserts' defaults (core RECORD_HOLD_S.default) and caps; the zoom's factor comes with the view (the theme's max_zoom). */
export const HOLD_DEFAULT_S = 2;
export const HOLD_MIN_S = 0.5;
export const HOLD_MAX_S = 10;
export const CAPTION_MAX = 200;
export const KICKER_MAX = 60;
export const WAIT_TEXT_MAX = 120;
export const MARK_MAX = 40;
export const NAME_MAX = 100;

/** How often the view is read while the recording is live (queued → check), and once it is over (ms). */
export const LIVE_POLL_MS = 700;
export const DONE_POLL_MS = 3000;

/** core SLUG_RE: a scenario or mark name. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** States in which the window, the draft or the check is still on its way. */
export const LIVE_STATES: ReadonlySet<RecordState> = new Set(['queued', 'preflight', 'recording', 'draft', 'check']);

/** A state's tone (the kit's StatusMark state is chosen from it; its word always beside it). */
export type RecordTone = 'neutral' | 'danger' | 'warning' | 'info' | 'success';

/** A state in a few words, and its tone. */
export const STATE_WORDS: Record<RecordState, [string, RecordTone]> = {
  queued: ['waiting for the worker', 'info'],
  preflight: ['opening the window', 'info'],
  recording: ['recording', 'info'],
  draft: ['making the draft', 'info'],
  check: ['checking the draft', 'info'],
  done: ['recorded', 'success'],
  interrupted: ['interrupted', 'warning'],
  tampered: ['cannot be verified', 'danger'],
  nothing_recorded: ['nothing recorded', 'neutral'],
  failed: ['failed', 'danger'],
  cancelled: ['cancelled', 'warning'],
  discarded: ['discarded', 'neutral'],
  missing: ['not found', 'neutral'],
};

/** Said before Start: what opens, and why full size (B17: never "side by side" — a narrow window lays the site out for a tablet). */
export const WINDOW_NOTE = 'A browser window opens full size on this Mac: the desktop layout is what the video films, so keep it that size.';

/** While the window is open. */
export const WINDOW_OPEN =
  'The browser window is open on this Mac, full size: click through the product there. It may be behind this one — switch with Cmd-Tab, or keep the Studio on a second screen. Come back to the window by its title bar: a click in the page is recorded.';

/** A state in one sentence (the screen's header). */
export function stateSentence(state: RecordState): string {
  switch (state) {
    case 'queued':
      return 'Waiting for the worker: the window opens when the job ahead of it ends.';
    case 'preflight':
      return 'Opening the window (the persona is signed in first when its session needs it).';
    case 'recording':
      return WINDOW_OPEN;
    case 'draft':
      return 'The window closed: making the draft.';
    case 'check':
      return 'Checking the draft: a headless replay of the recorded steps on a fresh page (it stops before a step that writes).';
    case 'done':
      return 'Recorded.';
    case 'interrupted':
      return 'The worker stopped while the window was open: what was recorded up to then is kept, unchecked.';
    case 'tampered':
      return 'The recording’s files were changed after its job wrote them: it cannot be verified, so it cannot be saved — discard it and record again.';
    case 'nothing_recorded':
      return 'The window closed with nothing recorded.';
    case 'failed':
      return 'The recording did not start or did not finish.';
    case 'cancelled':
      return 'Cancelled: nothing was recorded.';
    case 'discarded':
      return 'Discarded: the recording is gone. A scenario saved from it is never touched.';
    case 'missing':
      return 'No such recording here: discarded, pruned (the 20 newest are kept, and unsaved Studio ones for 7 days) or never started.';
  }
}

/** Who started a recording, in words. */
export function startedByWords(c: JobClient | null): string {
  switch (c) {
    case 'ui':
      return 'the Studio';
    case 'mcp':
      return 'Claude';
    case 'cli':
      return 'a terminal';
    case 'test':
      return 'a test';
    default:
      return 'someone unknown';
  }
}

/** Why a recording is shown read-only (Q5: a recording Claude or a terminal started; its job saved it). */
export function readOnlyWords(c: JobClient | null): string {
  return `Started by ${startedByWords(c)}: shown read-only here. Its job saves the draft itself; arrange it in the scenario screen once saved.`;
}

/** The time left before the recording stops by itself ("12:05 left"), or null. */
export function timeLeft(endsAt: string | null, now: number): string | null {
  if (!endsAt) return null;
  const t = Date.parse(endsAt);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((t - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
}

/** A target's fragility flags (kit `fragile`), in words. */
export const FRAGILE_WORDS: Record<string, string> = {
  css: 'depends on the page’s code (a CSS selector)',
  dynamic_text: 'holds a number or a date that may change',
  broader: 'matches a wider text than its own',
};

export function fragileWords(flags: readonly string[]): string[] {
  return flags.map((f) => FRAGILE_WORDS[f] ?? 'may be fragile');
}

/** A secret placeholder's kind, in words. */
export const PLACEHOLDER_WORDS: Record<SecretFieldKind, string> = {
  password: 'a password',
  one_time_code: 'a one-time code',
  card_number: 'a card number',
  card_code: 'a card security code',
  card_expiry: 'a card expiry date',
  iban: 'a bank account number',
  national_id: 'a national ID number',
  pin: 'a PIN',
  api_key: 'an API key',
  secret: 'a secret',
};

/** The insert kinds (a quick insert's button and its row or chip). */
export const INSERT_KIND_WORDS: Record<RecordInsert['kind'], string> = { hold: 'Hold', wait_for: 'Wait for', caption: 'Caption', mark: 'Mark', camera: 'Zoom' };

/** An insert in words — its kind and its numbers or choices only (a caption's text and a mark's name are shown apart, through Txt). */
export function insertWords(i: RecordInsert): string {
  switch (i.kind) {
    case 'hold':
      return `Hold ${i.seconds} s`;
    case 'wait_for':
      return i.until === 'next_target' ? 'Wait for the next target' : i.until === 'idle' ? 'Wait until the page is idle' : 'Wait for a text';
    case 'caption':
      return 'Caption';
    case 'mark':
      return 'Mark';
    case 'camera':
      return `Zoom ${i.zoom}× until the ${i.until === 'scene_end' ? 'scene' : 'step'} ends`;
  }
}

/** The Studio's text of an insert (a caption, its kicker, the text waited for, a mark's name), shown through Txt. */
export function insertText(i: RecordInsert): string | null {
  if (i.kind === 'caption') return i.kicker ? `${i.kicker} — ${i.text}` : i.text;
  if (i.kind === 'wait_for' && i.until === 'text') return i.text ?? null;
  if (i.kind === 'mark') return i.name;
  return null;
}

/** An issue's severity: a glyph and a word (never colour alone). */
export const SEVERITY_WORDS: Record<'error' | 'warning' | 'info', [string, RecordTone]> = {
  error: ['✖ error', 'danger'],
  warning: ['⚠ warning', 'warning'],
  info: ['ℹ note', 'info'],
};

const CHECK_SKIPPED: Record<string, string> = {
  disabled: 'the check replay was off',
  stopped: 'the worker stopped (a worker signal skips it)',
  nothing_recorded: 'nothing was recorded',
  invalid_draft: 'the draft does not validate',
  first_step_writes: 'the first step writes (the check never writes twice)',
};

/**
 * The check replay's result. It replayed the RECORDED draft — the recorder's own steps, without your picks and inserts
 * (B7; review B-M4): its counts are recorded steps, never the rows on screen. `title` and `tone` for its notice,
 * `detail` the sentence under it.
 */
export function checkWords(c: RecordCheckView): { title: string; tone: 'info' | 'warning' | 'danger'; detail: string } {
  if (c.events_changed) {
    return { title: 'The check no longer holds', tone: 'danger', detail: 'The recording’s events changed after the check: the draft cannot be saved from this Studio.' };
  }
  const steps = `${c.steps_passed} of ${c.steps_total} recorded step${c.steps_total === 1 ? '' : 's'}`;
  switch (c.status) {
    case 'passed':
      return c.scope === 'until_write'
        ? { title: 'Check passed up to the first write', tone: 'info', detail: `${steps} replayed on a fresh page, without your picks and inserts; it stopped before the step that writes, so nothing was written twice.` }
        : { title: 'Check passed', tone: 'info', detail: `${steps} replayed on a fresh page, without your picks and inserts.` };
    case 'failed':
      return { title: 'Check failed', tone: 'warning', detail: `${steps} replayed (without your picks and inserts) before one failed: look at that step’s target — another one you pick is replayed by a rehearsal after Save.` };
    case 'skipped':
      return { title: 'Check skipped', tone: 'warning', detail: `Not replayed: ${CHECK_SKIPPED[c.reason ?? ''] ?? 'it could not run'}.` };
    case 'cancelled':
      return { title: 'Check stopped', tone: 'warning', detail: `${steps} replayed before it stopped.` };
  }
}

/** What the check covers, said under it (B7; review B-M4). */
export const CHECK_SCOPE_NOTE =
  'The check replays the draft as it was recorded, without your picks and inserts — none of them is checked, whenever you made it. Targets you pick were verified when you pressed them; save, then rehearse the scenario to replay everything.';

/**
 * Where the check failed, for the screen: the row on screen (`failed_row`, mapped by the engine through the steps'
 * events), else the step of the recorded draft — `recorded`: it is not a row on screen ("recorded step N"). Null
 * without a failure.
 */
export function checkFailedAt(c: { failed_at?: { scene: string; step: number }; failed_row?: { scene: string; step: number } | null } | undefined): { scene: string; step: number; recorded: boolean } | null {
  if (!c?.failed_at) return null;
  if (c.failed_row) return { scene: c.failed_row.scene, step: c.failed_row.step, recorded: false };
  return { scene: c.failed_at.scene, step: c.failed_at.step, recorded: true };
}

/**
 * A preflight refusal that a Sign in answers (L3.4: a persona with no valid session and no `login:` steps): the job's
 * error is `refused`, saying the persona is not signed in (on an environment) or could not be. The persona and the
 * environment are the view's, else the engine's message names them (a refusal before the folder exists: no meta.json).
 * Null for anything else.
 */
export function preflightSignIn(v: { job: { error?: { code: string; message: string } } | null; persona: string | null; env: string | null }): { persona: string; env: string } | null {
  const e = v.job?.error;
  if (!e || e.code !== 'refused') return null;
  const m = /^persona ([A-Za-z0-9][A-Za-z0-9_-]*) (?:is not signed in on ([A-Za-z0-9][A-Za-z0-9_-]*) |could not be signed in)/.exec(e.message);
  if (!m) return null;
  const persona = v.persona ?? m[1];
  const env = v.env ?? m[2] ?? null;
  return env ? { persona, env } : null;
}

/** Why a scenario (or mark) name is refused before it is sent, or null. */
export function nameProblem(name: string, max = NAME_MAX): string | null {
  if (!name) return 'A name is needed.';
  if (name.length > max) return `At most ${max} characters.`;
  if (!NAME_RE.test(name)) return 'Letters, digits, "-" or "_" only, starting with a letter or digit (no space, no slash).';
  return null;
}

/** Why a caption, kicker or text to wait for is refused before it is sent (core's studioText rules), or null. */
export function textProblem(text: string, max: number): string | null {
  if (!text.trim()) return 'It is empty.';
  if (text.length > max) return `At most ${max} characters.`;
  if (text.includes('{{')) return 'It may not hold "{{" (a scenario would read it as a template).';
  // Line breaks, tabs, controls, format characters (zero-width, direction controls) and the BOM: one line of visible text.
  if (/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/.test(text)) return 'One line of visible text only (no line break, tab or hidden character).';
  return null;
}

/** The hold seconds typed, or why not. */
export function holdSeconds(text: string): number | string {
  const n = Number(text);
  if (!text.trim() || !Number.isFinite(n)) return 'A number of seconds.';
  if (n < HOLD_MIN_S || n > HOLD_MAX_S) return `Between ${HOLD_MIN_S} and ${HOLD_MAX_S} seconds.`;
  return Math.round(n * 10) / 10;
}

/** The writes the window sent, in a sentence, with L3.4's reset advice when the draft would write again. */
export function writesWords(w: { total: number; by_steps: number; ambient: number }, access: 'read-only' | 'read-write' | null): string | null {
  if (w.total === 0) return null;
  const n = `${w.total} write${w.total === 1 ? '' : 's'}`;
  if (access === 'read-only') return `The window sent ${n}: stopped or answered by a mock (a read-only environment) — the draft writes nothing either.`;
  return `The window sent ${n} (${w.by_steps} from steps, ${w.ambient} by the page itself): what was created or changed stays, and every run of the draft does it again — add a reset hook so each take starts from the same data.`;
}

/**
 * Why Save waits, or null when it can go (L5.11b fixes, review B-M2): while the window is open (or about to), after
 * Stop; while the draft is made and checked, once the check is over; else the recording cannot be saved, the name needs
 * fixing, or there is no draft. `name` is the Studio's own field (a slug: nameProblem rejects anything else).
 */
export function saveWhyWords(v: { state: RecordState; can: { save: boolean }; draft_sha256: string | null }, name: string, problem: string | null): string | null {
  if (!v.can.save) {
    if (v.state === 'queued' || v.state === 'preflight' || v.state === 'recording') return `Saving opens after Stop. It writes a new file, scenarios/${problem === null && name ? name : '<name>'}.yaml.`;
    if (v.state === 'draft' || v.state === 'check') return 'Saving opens once the check is over.';
    return 'This recording cannot be saved.';
  }
  if (problem) return 'The name needs fixing first.';
  if (!v.draft_sha256) return 'There is no draft to save.';
  return null;
}

/** The one polite status line: said only when the state (or the saved flag) changes. */
export function statusLine(state: RecordState, saved: boolean): string {
  if (saved) return 'Saved as a scenario.';
  switch (state) {
    case 'recording':
      return 'The window is open: recording.';
    case 'draft':
      return 'Stopped: making the draft.';
    case 'check':
      return 'Checking the draft.';
    case 'done':
      return 'Recorded: the draft is ready to save.';
    default:
      return `Recording ${STATE_WORDS[state][0]}.`;
  }
}

/**
 * Where the next insert goes when the cursor is on this row (by its identity, never its index — review B-H1): right
 * after an insert row, right after the recorder's wait (between it and its action), else after the row's last event (an
 * action, or the recorder's scroll: after the scroll, before its action).
 */
export function insertAnchor(src: Pick<DraftSource, 'role' | 'helper' | 'seqs' | 'insert'>): RecordInsertAt {
  if (src.role === 'insert' && src.insert !== undefined) return { after_insert: src.insert };
  if (src.role === 'helper' && src.helper === 'wait') return { after_step_seq: src.seqs[1], row: 'wait' };
  return { after_step_seq: src.seqs[1] };
}

/** Is `incoming` a view to show over `current`? Never an older revision of the annotations (a poll sent before a change). */
export function newerView(current: { rev: number } | null, incoming: { rev: number; unchanged?: true }): boolean {
  if (!current) return true;
  if (incoming.unchanged) return false;
  return incoming.rev >= current.rev;
}

/** What a done annotate tells the status line (said once, politely). */
export function annotatedWords(change: { op: 'choose' | 'insert' | 'remove'; insert?: { kind: RecordInsert['kind'] } }, where: string | null): string {
  if (change.op === 'choose') return 'Target picked.';
  if (change.op === 'remove') return 'Insert removed.';
  const kind = INSERT_KIND_WORDS[change.insert?.kind ?? 'hold'];
  return where ? `${kind} added after ${where}.` : `${kind} added at the end.`;
}

/**
 * Why Start is refused for a persona before anything is queued (review B-L5), or null: a persona whose session is not
 * valid, with no `login:` steps and no sandbox — the recording's preflight would refuse it. The answer is Sign in.
 */
export function personaProblem(p: { status: string | null; login_steps: boolean; sandbox: boolean } | undefined): string | null {
  if (!p || p.status === 'valid' || p.status === 'unchecked' || p.login_steps || p.sandbox) return null;
  return 'This persona is not signed in and has no login steps: sign it in first (Sign in above), then start.';
}

/** The answers record_annotate refuses with, in the screen's words (the server's message otherwise). */
export function annotateErrorWords(status: number, code: string, message: string): string {
  if (status === 409 && /revision|rev:/i.test(message)) return 'The draft changed meanwhile (another tab?): it was read again — do it once more.';
  if (status === 423 || code === 'busy') return 'Another change is being written: try again in a moment.';
  return message;
}
