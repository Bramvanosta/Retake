/**
 * The Review report's words and rules (L5.12a, R-UI-46), pure — no React, no call:
 * - the check families a finding belongs to (Video length, Scene lengths, Captions, Cursor, Camera and zoom, Transitions
 *   and speed, Targets on screen, Blank or loading screens, Text slots, Capture and media, Changes since the previous
 *   render, Other) — a table over every code a check writes (a test keeps it total over the review package's
 *   FINDING_CODES); a code it does not know (a newer review) is Other;
 * - the counts in words — never "passed": a review records what it found, not which checks ran (BL-132), so a family
 *   with nothing found is not listed and one quiet line says "Nothing else found";
 * - the command a person types to export the raw capture, built only from a project slug and a run id that pass their
 *   rules (a path-free answer's one path-like text is a command, never a value that could carry an argument);
 * - "2 h ago" as a plain string (a select's option cannot hold a <time>), and the time of day where two renders would
 *   read the same (L5.12a fixes, review B-L2).
 */
import type { RenderReviewSummary, ReviewFindingView } from '@demo-studio/engine';
import type { StudioEvent } from './events.js';
import type { MarkState } from './ui-kit/index.js';
import { reviewBadge, versionWords } from './render-words.js';

export interface CheckFamily {
  id: string;
  label: string;
  codes: readonly string[];
}

/** Every family and the codes it holds (each code once; Other last, for codes a newer review writes). */
export const CHECK_FAMILIES: readonly CheckFamily[] = [
  { id: 'length', label: 'Video length', codes: ['video-length', 'duration-mismatch'] },
  { id: 'scenes', label: 'Scene lengths', codes: ['scene-length', 'scene-too-short', 'long-scene', 'card-too-short', 'long-wait', 'empty-segment'] },
  {
    id: 'captions',
    label: 'Captions',
    codes: ['caption-missing', 'caption-not-visible', 'caption-overlap', 'caption-overlaps-brandmark', 'caption-scene-mismatch', 'caption-shrunk', 'caption-too-long', 'caption-truncated'],
  },
  { id: 'cursor', label: 'Cursor', codes: ['cursor-hidden', 'cursor-offscreen', 'cursor-outside-reframe', 'cursor-outside-view'] },
  { id: 'camera', label: 'Camera and zoom', codes: ['camera-jump', 'reframe-jump', 'zoom-clamped', 'zoom-count', 'zoom-not-slow', 'zoom-reset', 'theme-zoom-count', 'theme-zoom-cut', 'theme-zoom-real'] },
  { id: 'transitions', label: 'Transitions and speed', codes: ['slow-transition', 'transition-on-click'] },
  {
    id: 'targets',
    label: 'Targets on screen',
    codes: ['target-cut', 'target-outside-view', 'overlay-covers-target', 'tutorial-skipped', 'tutorial-stale-target', 'tutorial-target-cut', 'url-hidden', 'local-url-text'],
  },
  { id: 'blank', label: 'Blank or loading screens', codes: ['blank-scene-start', 'blank-screen', 'loading-scene-start', 'near-uniform-screen', 'artefact-before-step'] },
  { id: 'slots', label: 'Text slots', codes: ['text-slot-empty', 'text-slot-overflow'] },
  {
    id: 'media',
    label: 'Capture and media',
    codes: ['capture-missing', 'capture-unreadable', 'frames-missing', 'media-missing', 'timeline-missing', 'size-mismatch', 'component-missing', 'registry-unavailable', 'render-failed', 'write-blocked'],
  },
  { id: 'diff', label: 'Changes since the previous render', codes: ['diff-duration', 'diff-frames', 'diff-segment', 'previous-unreadable'] },
  { id: 'other', label: 'Other', codes: ['plan-warning'] },
];

const FAMILY_OF = new Map<string, string>(CHECK_FAMILIES.flatMap((f) => f.codes.map((c) => [c, f.id] as [string, string])));

/** The family of a finding's code (Other for a code this table does not know). */
export function familyOf(code: string): string {
  return FAMILY_OF.get(code) ?? 'other';
}

export interface FamilyGroup {
  family: CheckFamily;
  /** The findings of this family: their index in the review's list (its messages share it). */
  items: Array<{ index: number; finding: ReviewFindingView }>;
}

const SEVERITY_ORDER: Record<ReviewFindingView['severity'], number> = { error: 0, warning: 1, info: 2 };

/** The families that have findings, in the table's order; inside one, errors first, then the review's order. */
export function groupFindings(findings: readonly ReviewFindingView[]): FamilyGroup[] {
  const by = new Map<string, FamilyGroup['items']>();
  findings.forEach((finding, index) => {
    const id = familyOf(finding.code);
    by.set(id, [...(by.get(id) ?? []), { index, finding }]);
  });
  return CHECK_FAMILIES.filter((f) => by.has(f.id)).map((family) => ({ family, items: [...by.get(family.id)!].sort((a, b) => SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] || a.index - b.index) }));
}

/** A severity as a mark and its word. */
export function severityMark(s: ReviewFindingView['severity']): { state: MarkState; word: string } {
  return s === 'error' ? { state: 'fail', word: 'Error' } : s === 'warning' ? { state: 'warn', word: 'Warning' } : { state: 'idle', word: 'Note' };
}

const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en')} ${count === 1 ? one : many}`;

/** "0 errors, 2 warnings, 4 notes" — what the review found (never what passed: it does not record which checks ran). */
export function countWords(c: { error: number; warning: number; info: number }): string {
  return `${n(c.error, 'error')}, ${n(c.warning, 'warning')}, ${n(c.info, 'note')}`;
}

/** The quiet line under the families that found something (no number: the review does not record which checks ran). */
export const NOTHING_ELSE = 'Nothing else found.';

/** A project slug (core PROJECT_SLUG_RE). */
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** A run id (engine RUN_ID_RE): letters, digits, dots, underscores and dashes, never starting with a dot or a dash. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The raw capture's export, as a command to copy (`studio export-capture <project> <run>`): null unless the slug and the
 * run id pass their rules (≤ 200 characters each) — a value with a space, a quote or a `;` never becomes a command.
 */
export function rawExportCommand(slug: string, runId: string): string | null {
  if (slug.length > 200 || runId.length > 200 || !PROJECT_SLUG.test(slug) || !RUN_ID.test(runId)) return null;
  return `studio export-capture ${slug} ${runId}`;
}

/**
 * Whether an event makes the export part read the activity again (L5.12a fixes, review A-L1): a reconnection, or a jobs
 * event of this project (an older server's, which names no project, too) — never another project's busy queue.
 */
export function exportReadsOn(e: StudioEvent, slug: string): boolean {
  return e.type === 'resync' || (e.type === 'jobs' && (!e.projects || e.projects.includes(slug)));
}

/** "just now", "12 min ago", "3 h ago", "yesterday", or the date (When's words, as a string). */
export function agoWords(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.round((now - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86_400 ? `${Math.floor(s / 3600)} h ago` : s < 172_800 ? 'yesterday' : new Date(t).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "12:30" — the time of day of an instant, in the viewer's zone ('' when it is not a date). */
export function clockWords(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
}

/** The ids whose "when" words (agoWords) another item shares: those show their time of day too (review B-L2). */
export function sharedWhen(items: ReadonlyArray<{ id: string; at: string }>, now = Date.now()): Set<string> {
  const by = new Map<string, string[]>();
  for (const i of items) {
    const w = agoWords(i.at, now);
    by.set(w, [...(by.get(w) ?? []), i.id]);
  }
  return new Set([...by.values()].filter((ids) => ids.length > 1).flat());
}

/** "0:36.1" of a time in seconds. */
export function shortTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** Where a finding is, in words: "scene delivery · step 6" / "segment intro" (no time). */
export function whereWords(at: ReviewFindingView['at']): string {
  if (!at) return '';
  const parts: string[] = [];
  if (at.scene) parts.push(`scene ${at.scene}`);
  else if (at.segment) parts.push(`segment ${at.segment}`);
  if (at.step !== undefined) parts.push(at.step < 0 ? 'its opening still' : `step ${at.step + 1}`);
  return parts.join(' · ');
}

/** The step key a finding points at (`<scene>.<step>`, the run's own keys), or undefined. */
export function stepKeyOf(at: ReviewFindingView['at']): string | undefined {
  return at?.scene && at.step !== undefined && at.step >= 0 ? `${at.scene}.${at.step}` : undefined;
}

/**
 * L5.12b: the ⌘K palette's Review report hint — the newest finished render and its review in the badge's words ("last
 * render v2 · clean", "last render v2 · 2 warnings", "last render v1 · not reviewed": L5.12b fixes, review B-L2 — a render
 * without a review is never "no render yet"); "no finished render yet" when only failed ones exist, "no render yet" with
 * none. Never "passed" (a test).
 */
export function reportHint(newest: { render_id: string; review: RenderReviewSummary } | undefined, renders = newest ? 1 : 0): string {
  if (newest) return `last render ${versionWords(newest.render_id)} · ${reviewBadge(newest.review).words}`;
  return renders > 0 ? 'no finished render yet' : 'no render yet';
}
