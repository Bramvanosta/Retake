/**
 * L5.10a: the Project screen's words, pure (no React) — a production's state as a shape AND a word (StatusMark: never
 * colour alone) and its smart group (Ready to render · Needs a shoot · Failed), from `project_board`'s facts. The
 * render rule is the scenario screen's own (render-words sameVersion: the same capture, the edit planned from the same
 * file bytes, the theme a render would use today (L5.10a fixes, review B-L2), landscape, no override — critique M3),
 * "the capture" the board's (the newest succeeded capture with its video). First match wins; every row of the table has a test (board-words.test.ts).
 */
import type { AuthStatusItem, BoardRun, BoardScenario, RenderReviewSummary } from '@demo-studio/engine';
import type { MarkState } from './ui-kit/index.js';
import { sameVersion } from './render-words.js';
import { STORED_WORDS } from './Sessions.js';

export type BoardGroup = 'ready' | 'shoot' | 'failed';
export const BOARD_GROUPS: BoardGroup[] = ['ready', 'shoot', 'failed'];
export const GROUP_LABEL: Record<BoardGroup, string> = { ready: 'Ready to render', shoot: 'Needs a shoot', failed: 'Failed' };

export interface ProductionState {
  state: MarkState;
  word: string;
  group: BoardGroup | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const MODE: Record<BoardRun['mode'], string> = { dry: 'Dry run', capture: 'Capture' };

/** A render's review as a state and its words ("clean", "2 warnings", "not reviewed"…). */
export function reviewState(r: RenderReviewSummary): { state: MarkState; words: string } {
  switch (r.state) {
    case 'clean':
      return { state: 'ok', words: 'clean' };
    case 'warnings':
      return { state: 'warn', words: plural(r.counts.warning, 'warning') };
    case 'errors':
      return { state: 'attention', words: plural(r.counts.error, 'error') };
    case 'queued':
    case 'running':
      return { state: 'running', words: 'review running' };
    case 'failed':
    case 'cancelled':
      return { state: 'warn', words: 'review stopped' };
    case 'none':
      return { state: 'waiting', words: 'review pending' };
  }
}

/** A running take: "Capture · step 7 of 18", "Dry run · starting", "Queued". */
export function runningWords(r: Pick<BoardRun, 'mode' | 'status' | 'steps_done' | 'steps_total'>): string {
  if (r.status === 'queued') return `${MODE[r.mode]} · queued`;
  if (r.steps_total > 0) return `${MODE[r.mode]} running · step ${Math.min(r.steps_done + 1, r.steps_total)} of ${r.steps_total}`;
  return `${MODE[r.mode]} running · starting`;
}

/** The render that shows today's file on the capture with today's theme (sameVersion; review B-L2), or undefined. */
function currentRender(s: BoardScenario) {
  return s.render && s.capture && s.hash && sameVersion(s.render, { run: s.capture.id, hash: s.hash, ...(s.theme ? { theme: s.theme } : {}) }) ? s.render : undefined;
}

/** The production's state, word and smart group (first match wins). */
export function productionState(s: BoardScenario): ProductionState {
  if (s.file.unreadable) return { state: 'attention', word: 'Broken file: cannot be read', group: null };
  if (!s.file.parsed || s.file.errors > 0) return { state: 'attention', word: 'File has errors', group: null };
  if (s.running) return { state: 'running', word: runningWords(s.running), group: null };
  if (s.render_job) {
    const j = s.render_job;
    const word = j.state === 'queued' ? 'Render queued' : j.reviewing ? 'Review running' : j.fraction !== undefined ? `Render running · ${Math.round(j.fraction * 100)} %` : 'Render running';
    return { state: 'running', word, group: null };
  }
  const cap0 = s.capture;
  const last = s.last_run;
  // A take that failed after the capture (or with none): the failure is what to see.
  if (last && (!cap0 || last.id > cap0.id)) {
    if (last.status === 'failed') return { state: 'fail', word: cap(last.partial ?? 'failed'), group: 'failed' };
    if (last.status === 'interrupted') return { state: 'fail', word: 'Interrupted', group: 'failed' };
    if (last.status === 'unknown') return { state: 'attention', word: 'Last take: status invalid', group: null };
  }
  if (s.render_failed && (!cap0 || s.render_failed.at > (cap0.finished_at ?? ''))) return { state: 'fail', word: 'Render failed', group: 'failed' };
  if (cap0) {
    if (cap0.current === false) return { state: 'warn', word: 'Script changed since the shoot', group: 'shoot' };
    const r = currentRender(s);
    if (r) {
      const rv = reviewState(r.review);
      return { state: rv.state, word: `Rendered · ${rv.words}`, group: null };
    }
    if (cap0.current === null) return { state: 'idle', word: 'Ready to render · cannot tell if current', group: 'ready' };
    if (s.render) return { state: 'warn', word: 'Render outdated', group: 'ready' };
    return { state: 'waiting', word: 'Shot · ready to render', group: 'ready' };
  }
  if (last?.status === 'cancelled') return { state: 'idle', word: 'Last take cancelled · not shot', group: 'shoot' };
  if (s.dry) return { state: 'idle', word: 'Dry run passed · not shot', group: 'shoot' };
  return { state: 'idle', word: 'Draft · not shot yet', group: 'shoot' };
}

/** How many productions each smart group holds. */
export function groupCounts(list: readonly BoardScenario[]): Record<BoardGroup, number> {
  const out: Record<BoardGroup, number> = { ready: 0, shoot: 0, failed: 0 };
  for (const s of list) {
    const g = productionState(s).group;
    if (g) out[g]++;
  }
  return out;
}

/** `65.04` → "1:05.0" (minutes, seconds and tenths; the poster's length, mono). */
export function lengthWords(seconds: number): string {
  const t = Math.max(0, Math.round(seconds * 10));
  const m = Math.floor(t / 600);
  const s = Math.floor((t % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${t % 10}`;
}

/** "4 scenes · 2 cards · 25 steps" (cards and interstitials together; hooks apart). */
export function contentWords(c: BoardScenario['content']): string {
  const parts = [plural(c.scenes, 'scene'), ...(c.cards + c.interstitials > 0 ? [plural(c.cards + c.interstitials, 'card')] : []), plural(c.steps, 'step')];
  return parts.join(' · ');
}

/** The last take in words: "Capture succeeded", "Dry run failed at step 3 of proposal", "Capture interrupted". */
export function lastTakeWords(r: BoardRun): { state: MarkState; words: string } {
  const what = MODE[r.mode];
  switch (r.status) {
    case 'succeeded':
      return { state: 'ok', words: r.partial ? `${what} stopped ${r.partial}` : `${what} succeeded` };
    case 'failed':
      return { state: 'fail', words: `${what} ${r.partial ?? 'failed'}` };
    case 'cancelled':
      return { state: 'idle', words: `${what} cancelled` };
    case 'interrupted':
      return { state: 'fail', words: `${what} interrupted` };
    case 'queued':
    case 'running':
      return { state: 'running', words: runningWords(r) };
    default:
      return { state: 'attention', words: `${what}: status invalid` };
  }
}

/** The title a poster shows: the video's title from the file, else the scenario's name (both text: Txt). */
export function posterTitle(s: BoardScenario): string {
  return s.untrusted.title || s.name;
}

export type BoardSort = 'activity' | 'name' | 'length';
export const SORT_LABEL: Record<BoardSort, string> = { activity: 'Last activity', name: 'Name', length: 'Length' };

/** The newest moment something happened to a production (a take, a render), ISO or ''. */
function lastActivity(s: BoardScenario): string {
  return [s.running?.started_at, s.last_run?.finished_at ?? s.last_run?.started_at, s.render?.created_at, s.render_failed?.at].filter((x): x is string => typeof x === 'string').sort().at(-1) ?? '';
}

/** The productions a search keeps (name or title, every word), sorted. */
export function filterSort(list: readonly BoardScenario[], query: string, sort: BoardSort): BoardScenario[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = list.filter((s) => {
    const hay = `${s.name} ${s.untrusted.title ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  const byName = (a: BoardScenario, b: BoardScenario) => a.name.localeCompare(b.name);
  if (sort === 'name') return kept.sort(byName);
  if (sort === 'length') return kept.sort((a, b) => (b.length?.seconds ?? -1) - (a.length?.seconds ?? -1) || byName(a, b));
  return kept.sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)) || byName(a, b));
}

/** An environment's flags in words: "default · production · read-only · sandbox" (empty: none). */
export function envFlagWords(e: { production: boolean; access: 'read-only' | 'read-write'; sandbox: boolean }, isDefault: boolean): string {
  return [...(isDefault ? ['default'] : []), ...(e.production ? ['production'] : []), ...(e.access === 'read-only' ? ['read-only'] : []), ...(e.sandbox ? ['sandbox'] : [])].join(' · ');
}

/** The one flag a browser row has room for (production, read-only, sandbox, default — the riskiest first). */
export function envFlagWord(e: { production: boolean; access: 'read-only' | 'read-write'; sandbox: boolean }, isDefault: boolean): string {
  return e.production ? 'production' : e.access === 'read-only' ? 'read-only' : e.sandbox ? 'sandbox' : isDefault ? 'default' : '';
}

/** A persona's stored session as a shape and a word (the Sessions panel's words: STORED_WORDS; a sandbox account apart). */
export function castState(p: Pick<AuthStatusItem, 'status' | 'sandbox'>): { state: MarkState; word: string } {
  if (p.sandbox && p.status === 'never') return { state: 'idle', word: 'Sandbox · ready' };
  // The Sessions panel's words, but "never signed in" says the session is missing (a state word: the checker's rule).
  const word = p.status === 'never' ? 'Missing session' : cap(STORED_WORDS[p.status]?.[0] ?? 'invalid');
  const state: MarkState = p.status === 'valid' ? 'ok' : p.status === 'expired' || p.status === 'error' ? 'fail' : p.status === 'never' ? 'warn' : 'idle';
  return { state, word };
}
