/**
 * The render queue's words and rules (L4.5 part E), pure — no React, no call: what a render job is doing, a review's
 * verdict in words, whether a render shows the version on screen, and which events make the render list read again.
 * Every value here is a trusted word (ids, phases, numbers); untrusted text (a failure's message, a finding's message)
 * stays with the caller, shown through Txt.
 */
import type { RenderReviewSummary, ScenarioRenderJobView, ScenarioRenderView, ScenarioRendersView } from '@retake/engine';
import type { StudioEvent } from './events.js';

/** Why Render is off on a proposal's preview (Edit and the status bar say it the same, in every state of Edit). */
export const PROPOSAL_RENDER = 'Previewing a proposal: apply it (Apply and re-render renders it)';

/** "v3" of "quote-v3", "v3 vertical" of "quote-v3-vertical" (the id itself when it is not one). */
export function versionWords(renderId: string): string {
  const m = /-v(\d+)(?:-(vertical|square))?$/.exec(renderId);
  return m ? `v${m[1]}${m[2] ? ` ${m[2]}` : ''}` : renderId;
}

/** The render's stages (editor RenderStage) and the review's (review package), as the job's progress names them. */
const PHASES: Record<string, string> = {
  planning: 'planning',
  bundling: 'preparing the components',
  rendering: 'rendering',
  encoding: 'encoding',
  done: 'writing the record',
  'review:loading': 'reading the render',
  'review:frames': 'taking frames',
  'review:capture': 'reading the capture',
  'review:previous': 'comparing with the previous render',
  'review:checks': 'checking the frames',
  'review:sheets': 'making the contact sheets',
  'review:writing': 'writing the report',
  'review:done': 'writing the report',
};

/** A job's phase in words ("review:sheets" → "reviewing: making the contact sheets"); an unknown phase keeps its word. */
export function phaseWords(phase: string | undefined): string {
  if (!phase) return 'starting';
  if (PHASES[phase]) return phase.startsWith('review:') ? `reviewing: ${PHASES[phase]}` : PHASES[phase];
  if (phase.startsWith('review:')) return `reviewing${phase.length > 7 ? `: ${phase.slice(7).replace(/[^a-z0-9 _-]/gi, '')}` : ''}`;
  return phase.replace(/[^a-z0-9 _-]/gi, '');
}

/** "about 12 s left", "about 2 min left", or ''. */
export function etaWords(s: number | undefined): string {
  if (s === undefined || !Number.isFinite(s) || s < 0) return '';
  if (s < 60) return `about ${Math.max(1, Math.round(s))} s left`;
  return `about ${Math.round(s / 60)} min left`;
}

/** What a queued or running render job is doing, in one line (its queue position, phase, percentage, time left). */
export function jobWords(j: ScenarioRenderJobView): string {
  const v = versionWords(j.render_id);
  if (j.cancel_requested) return `${v} · stopping…`;
  if (j.state === 'queued') {
    const ahead = j.queue?.ahead ?? 0;
    const r = j.queue?.running;
    // L5.14: a render a take holds does not start before the take ends, whatever its place.
    const first = j.queue?.held_by === 'take' ? 'waiting for a take to finish' : ahead === 0 ? 'next in the queue' : `${ahead} ${ahead === 1 ? 'job' : 'jobs'} before it`;
    const running = r ? ` (a ${r.kind.replace(/_/g, ' ')} is running${r.fraction !== undefined ? `, ${Math.round(r.fraction * 100)} %` : ''})` : '';
    return `${v} · queued — ${first}${running}`;
  }
  const pct = j.fraction !== undefined && !j.reviewing ? ` ${Math.round(j.fraction * 100)} %` : '';
  const eta = !j.reviewing ? etaWords(j.eta_s) : '';
  return `${v} · ${phaseWords(j.phase)}${pct}${eta ? ` · ${eta}` : ''}`;
}

export type ReviewTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** A review's verdict as a badge: its word(s) and tone (colour is never the only cue). */
export function reviewBadge(r: RenderReviewSummary): { words: string; tone: ReviewTone } {
  switch (r.state) {
    case 'clean':
      return { words: 'clean', tone: 'success' };
    case 'warnings':
      return { words: `${r.counts.warning} ${r.counts.warning === 1 ? 'warning' : 'warnings'}`, tone: 'warning' };
    case 'errors':
      return { words: `${r.counts.error} ${r.counts.error === 1 ? 'error' : 'errors'}`, tone: 'danger' };
    case 'queued':
      return { words: 'review queued', tone: 'info' };
    case 'running':
      return { words: 'reviewing…', tone: 'info' };
    case 'failed':
      return { words: 'review failed', tone: 'danger' };
    case 'cancelled':
      return { words: 'review cancelled', tone: 'warning' };
    default:
      return { words: 'not reviewed', tone: 'neutral' };
  }
}

/** A review with a report to read (render_review answers its findings and sheets). */
export function hasReport(r: RenderReviewSummary): boolean {
  return r.state === 'clean' || r.state === 'warnings' || r.state === 'errors';
}

/**
 * The version a screen shows: the capture (timeline) and the file's hash; the timeline also knows its plan's signature
 * and its theme folder's content hash (timeline_view `plan_sha256`, `theme_sha256`).
 */
export interface ShownVersion {
  run?: string;
  hash?: string;
  theme?: string;
  plan_sha256?: string;
  theme_sha256?: string;
}

type RenderVersion = Pick<ScenarioRenderView, 'run_id' | 'edit' | 'theme'> & Partial<Pick<ScenarioRenderView, 'variant' | 'overrides' | 'plan_sha256' | 'theme_sha256'>>;

/**
 * Whether a render shows the version on screen (review B H1: its findings then seek the preview at their frames):
 * - the timeline (it knows its plan): the render's plan is this plan (the same signature: the same capture, edit,
 *   options, fps, variant and theme settings) and its theme files are these (the same content hash);
 * - a screen without a plan (the scenario screen): the same capture, the edit planned from the same file bytes, the same
 *   theme, landscape, no option beyond the files' (`--no-intro`, `--scale`… make another video).
 * A render "as captured" (no edit sha256) never matches an edited file.
 */
export function sameVersion(r: RenderVersion, shown: ShownVersion): boolean {
  if (!shown.hash || !r.edit.sha256 || r.edit.sha256 !== shown.hash) return false;
  if (shown.run && r.run_id !== shown.run) return false;
  if (shown.theme && r.theme !== shown.theme) return false;
  if (shown.plan_sha256 !== undefined) {
    if (r.plan_sha256 !== shown.plan_sha256) return false;
    if (shown.theme_sha256 !== undefined && r.theme_sha256 !== shown.theme_sha256) return false;
    return true;
  }
  return (r.variant ?? 'landscape') === 'landscape' && (r.overrides ?? []).length === 0;
}

/** "from this version" / "from an earlier version" / "as captured" — a render's edit against the screen's. */
export function versionNote(r: RenderVersion, shown: ShownVersion): { words: string; same: boolean } {
  if (sameVersion(r, shown)) return { words: 'from this version', same: true };
  if (r.edit.from === 'run') return { words: 'the take as captured', same: false };
  if (shown.run && r.run_id !== shown.run) return { words: 'of another capture', same: false };
  if (r.edit.sha256 && r.edit.sha256 === shown.hash && ((r.overrides ?? []).length > 0 || (r.variant ?? 'landscape') !== 'landscape')) return { words: 'with other options', same: false };
  if (r.edit.sha256 && r.edit.sha256 === shown.hash) return { words: 'with other theme or project settings', same: false };
  return { words: 'from an earlier version', same: false };
}

/** A render job's edit against the screen's (a switch made while it waits: it renders the version it was sent with). */
export function jobVersionNote(j: Pick<ScenarioRenderJobView, 'run_id' | 'edit_sha256'>, shown: ShownVersion): string {
  if (!j.edit_sha256) return 'the take as captured';
  if (shown.hash && j.edit_sha256 === shown.hash && (!shown.run || j.run_id === shown.run)) return 'this version';
  return 'an earlier version';
}

/**
 * Which events make a render list read again (critique: re-read only what is shown): a reconnection; a `workspace` event
 * naming the project's renders/ folder; a `jobs` event naming a job the list shows, or a job this tab never saw (a new
 * render or review may have been queued — Claude, another tab). Never another project's renders, never a README.
 * `seen` collects the job ids met in events (the caller keeps it).
 */
export function rendersEventAction(e: StudioEvent, slug: string, shownJobs: ReadonlySet<string>, seen: Set<string>): boolean {
  if (e.type === 'resync') return true;
  if (e.type === 'workspace') return Array.isArray(e.renders) && e.renders.includes(slug);
  if (e.type !== 'jobs') return false;
  let reread = false;
  for (const id of e.changed) {
    if (shownJobs.has(id)) reread = true;
    else if (!seen.has(id)) reread = true;
    seen.add(id);
  }
  return reread;
}

/** The jobs a render list shows (unfinished ones and the last failed one), for rendersEventAction. */
export function shownJobsOf(v: ScenarioRendersView): Set<string> {
  const s = new Set(v.jobs.map((j) => j.id));
  if (v.last_failed) s.add(v.last_failed.job);
  return s;
}

/** A finding's place, in words: "at 0:03.2 · segment a" (render frames at `fps`). */
export function findingAt(at: { frame?: number; time?: number; segment?: string; scene?: string; step?: number } | undefined, fps: number): string {
  if (!at) return '';
  const parts: string[] = [];
  const t = at.time ?? (at.frame !== undefined ? at.frame / fps : undefined);
  if (t !== undefined) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    parts.push(`at ${m}:${s.toFixed(1).padStart(4, '0')}`);
  }
  if (at.segment) parts.push(`segment ${at.segment}`);
  else if (at.scene) parts.push(`scene ${at.scene}`);
  if (at.step !== undefined) parts.push(`step ${at.step + 1}`);
  return parts.join(' · ');
}

/** The frame of the plan a finding points at, or undefined (frames of the same plan: only when the render matches). */
export function findingFrame(at: { frame?: number; time?: number } | undefined, fps: number): number | undefined {
  if (!at) return undefined;
  if (at.frame !== undefined && Number.isFinite(at.frame)) return Math.max(0, Math.round(at.frame));
  if (at.time !== undefined && Number.isFinite(at.time)) return Math.max(0, Math.round(at.time * fps));
  return undefined;
}

/** "1.2 MB", "820 KB". */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
