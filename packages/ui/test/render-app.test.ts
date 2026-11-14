/**
 * L4.5 part E: the render queue's pure rules (app/render-words.ts) — ⚑ which events make the render list read again
 * (only what it shows: its jobs, a job never seen, its project's renders/ folder, a reconnection — never another
 * project, a README, a known job of another kind progressing), whether a render shows the version on screen, and the
 * words of a job and of a review's verdict; review B H1: on the timeline "this version" is the same plan signature and
 * theme files (a render with other options, fps, variant or theme files never seeks the preview).
 */
import { describe, expect, it } from 'vitest';
import type { ScenarioRenderJobView, ScenarioRendersView } from '@retake/engine';
import { renderNotWords } from '@retake/core';
import type { RenderNot } from '@retake/core';
import {
  RENDER_NOT_WORDS,
  findingAt,
  findingFrame,
  heldShortWords,
  heldWords,
  jobVersionNote,
  jobWords,
  notShownWords,
  phaseWords,
  rendersEventAction,
  reviewBadge,
  sameVersion,
  shownJobsOf,
  versionNote,
  versionWords,
  yieldWords,
} from '../src/app/words/render-words.js';

const H = 'a'.repeat(64);
const job = (o: Partial<ScenarioRenderJobView> = {}): ScenarioRenderJobView => ({
  id: 'j_1',
  render_id: 'quote-v3',
  run_id: 'r1',
  state: 'running',
  created_at: '2026-01-01T00:00:00.000Z',
  submitted_by: 'ui',
  reviewing: false,
  cancel_requested: false,
  ...o,
});

describe('render list events (re-read only what is shown)', () => {
  it('⚑ its jobs, a job never seen, its renders/ folder, a reconnection — nothing else', () => {
    const shown = new Set(['j_mine']);
    const seen = new Set<string>(['j_capture']);
    expect(rendersEventAction({ type: 'resync' }, 'demo', shown, seen)).toBe(true);
    expect(rendersEventAction({ type: 'jobs', changed: ['j_mine'] }, 'demo', shown, seen)).toBe(true);
    // A known job the list does not show (a capture progressing): nothing.
    expect(rendersEventAction({ type: 'jobs', changed: ['j_capture'] }, 'demo', shown, seen)).toBe(false);
    // A job never seen (a render Claude queued?): once, then it is known.
    expect(rendersEventAction({ type: 'jobs', changed: ['j_new'] }, 'demo', shown, seen)).toBe(true);
    expect(rendersEventAction({ type: 'jobs', changed: ['j_new'] }, 'demo', shown, seen)).toBe(false);
    expect(rendersEventAction({ type: 'workspace', projects: ['demo'], readme: [], renders: ['demo'] }, 'demo', shown, seen)).toBe(true);
    expect(rendersEventAction({ type: 'workspace', projects: ['other'], readme: [], renders: ['other'] }, 'demo', shown, seen)).toBe(false);
    expect(rendersEventAction({ type: 'workspace', projects: ['demo'], readme: ['demo'] }, 'demo', shown, seen)).toBe(false);
    expect(rendersEventAction({ type: 'workspace', projects: ['demo'], readme: [], scenarios: ['demo/quote'] }, 'demo', shown, seen)).toBe(false);
    expect(rendersEventAction({ type: 'index', generation: 3 }, 'demo', shown, seen)).toBe(false);
    const v = { jobs: [job({ id: 'j_a' })], renders: [], last_failed: { job: 'j_b', render_id: 'quote-v2', run_id: 'r1', state: 'failed' } } as unknown as ScenarioRendersView;
    expect([...shownJobsOf(v)].sort()).toEqual(['j_a', 'j_b']);
  });
});

describe('versions and words', () => {
  it('a render shows the version on screen: same capture, same file bytes, same theme', () => {
    const r = { run_id: 'r1', theme: 'editorial', edit: { from: 'scenario' as const, sha256: H } };
    expect(sameVersion(r, { run: 'r1', hash: H, theme: 'editorial' })).toBe(true);
    expect(sameVersion(r, { run: 'r2', hash: H })).toBe(false);
    expect(sameVersion(r, { run: 'r1', hash: 'b'.repeat(64) })).toBe(false);
    expect(sameVersion(r, { run: 'r1', hash: H, theme: 'motion' })).toBe(false);
    expect(sameVersion({ ...r, edit: { from: 'run' } }, { run: 'r1', hash: H })).toBe(false);
    expect(versionNote(r, { run: 'r1', hash: H }).words).toBe('from this version');
    expect(versionNote(r, { run: 'r1', hash: 'b'.repeat(64) }).words).toBe('from an earlier version');
    expect(versionNote({ ...r, edit: { from: 'run' } }, { run: 'r1', hash: H }).words).toBe('the take as captured');
    expect(versionNote(r, { run: 'r2', hash: 'b'.repeat(64) }).words).toBe('of another capture');
    expect(jobVersionNote({ run_id: 'r1', edit_sha256: H }, { run: 'r1', hash: H })).toBe('this version');
    expect(jobVersionNote({ run_id: 'r1', edit_sha256: H }, { run: 'r1', hash: 'b'.repeat(64) })).toBe('an earlier version');
    expect(jobVersionNote({ run_id: 'r1' }, { run: 'r1', hash: H })).toBe('the take as captured');
  });

  it('review B H1: on the timeline, only the same plan and theme files are "this version" (options, variant, fps, theme files differ)', () => {
    const P = 'p'.repeat(24);
    const T = '0123456789abcdef';
    const shown = { run: 'r1', hash: H, theme: 'editorial', plan_sha256: P, theme_sha256: T };
    const r = { run_id: 'r1', theme: 'editorial', edit: { from: 'scenario' as const, sha256: H }, variant: 'landscape', overrides: [] as string[], plan_sha256: P, theme_sha256: T };
    expect(sameVersion(r, shown)).toBe(true);
    // `render --no-intro --scale 0.25` of the same file and capture: another plan — its findings never seek this preview.
    expect(sameVersion({ ...r, overrides: ['intro', 'scale'], plan_sha256: 'q'.repeat(24) }, shown)).toBe(false);
    expect(versionNote({ ...r, overrides: ['intro', 'scale'], plan_sha256: 'q'.repeat(24) }, shown).words).toBe('with other options');
    // Another fps or variant: another plan.
    expect(sameVersion({ ...r, plan_sha256: 'f'.repeat(24) }, shown)).toBe(false);
    // The same plan, other theme files (a logo, a font): not this version either.
    expect(sameVersion({ ...r, theme_sha256: 'fedcba9876543210' }, shown)).toBe(false);
    expect(versionNote({ ...r, theme_sha256: 'fedcba9876543210' }, shown).words).toBe('with other theme or project settings');
    // A record written before the signatures: never "this version" on the timeline.
    const { plan_sha256: _p, theme_sha256: _t, ...old } = r;
    expect(sameVersion(old, shown)).toBe(false);
    // The scenario screen (no plan shown): the same file and capture, landscape, no option beyond the files'.
    const loose = { run: 'r1', hash: H, theme: 'editorial' };
    expect(sameVersion(r, loose)).toBe(true);
    expect(sameVersion({ ...r, overrides: ['intro'] }, loose)).toBe(false);
    expect(sameVersion({ ...r, variant: 'vertical' }, loose)).toBe(false);
  });

  it('a job and a verdict in words', () => {
    expect(versionWords('quote-v12')).toBe('v12');
    expect(versionWords('quote-v3-vertical')).toBe('v3 vertical');
    expect(jobWords(job({ state: 'queued', queue: { ahead: 0 } }))).toBe('v3 · queued — next in the queue');
    // L5.14a fixes (review B M4): a render a take holds is not "next".
    expect(jobWords(job({ state: 'queued', queue: { ahead: 0, held_by: 'take' } }))).toBe('v3 · queued — waiting for a take to finish');
    expect(jobWords(job({ state: 'queued', queue: { ahead: 2, running: { id: 'j_x', kind: 'run', fraction: 0.4 } } }))).toBe('v3 · queued — 2 jobs before it (a run is running, 40 %)');
    expect(jobWords(job({ phase: 'rendering', fraction: 0.431, eta_s: 12.2 }))).toBe('v3 · rendering 43 % · about 12 s left');
    expect(jobWords(job({ phase: 'review:sheets', fraction: 0.5, reviewing: true }))).toBe('v3 · reviewing: making the contact sheets');
    expect(jobWords(job({ cancel_requested: true }))).toBe('v3 · stopping…');
    // L5.14b: what a take does to it — waiting (where), slowed (no time left said: it would be wrong), past the cap.
    expect(jobWords(job({ state: 'queued', queue: { ahead: 0, held_by: 'take' }, yield: { state: 'waiting', cause: 'elsewhere' } }))).toBe(
      'v3 · queued — waiting for a take to finish (elsewhere on this Mac)',
    );
    expect(jobWords(job({ phase: 'rendering', fraction: 0.431, eta_s: 12.2, yield: { state: 'background', cause: 'here', since: '2026-11-04T14:02:00.000Z' } }))).toBe(
      'v3 · rendering 43 % · slowed during a take (in this workspace)',
    );
    expect(jobWords(job({ phase: 'rendering', fraction: 0.5, eta_s: 30, yield: { state: 'past_cap', cause: 'here', cap_min: 60 } }))).toBe(
      'v3 · rendering 50 % · about 30 s left · going on: a take (in this workspace) has held heavy work for over 60 min',
    );
    expect(heldWords({ state: 'background', cause: 'elsewhere', kind: 'render', count: 1 })).toBe('a render is slowed during a take (elsewhere on this Mac)');
    expect(heldWords({ state: 'waiting', cause: 'here', kind: 'review', count: 2 })).toBe('2 jobs wait for a take to finish (in this workspace)');
    // Review B L6: the narrow status bar's short form.
    expect(heldShortWords({ state: 'background', cause: 'elsewhere', kind: 'render', count: 1 })).toBe('a render slowed by a take');
    expect(heldShortWords({ state: 'waiting', cause: 'here', kind: 'review', count: 2 })).toBe('2 jobs wait for a take');
    expect(heldShortWords({ state: 'past_cap', cause: 'here', kind: 'export', count: 1 })).toBe("an export past a take's cap");
    expect(yieldWords({ state: 'waiting', cause: 'here' })).toBe('waiting for a take to finish (in this workspace)');
    expect(phaseWords('<b>odd</b>')).toBe('boddb');
    expect(reviewBadge({ state: 'clean', counts: { error: 0, warning: 0, info: 2 } })).toEqual({ words: 'clean', tone: 'success' });
    expect(reviewBadge({ state: 'warnings', counts: { error: 0, warning: 1, info: 0 } })).toEqual({ words: '1 warning', tone: 'warning' });
    expect(reviewBadge({ state: 'errors', counts: { error: 2, warning: 1, info: 0 } })).toEqual({ words: '2 errors', tone: 'danger' });
    expect(reviewBadge({ state: 'none' }).words).toBe('not reviewed');
    expect(findingAt({ frame: 96, segment: 'a', step: 0 }, 30)).toBe('at 0:03.2 · segment a · step 1');
    expect(findingFrame({ time: 1.5 }, 30)).toBe(45);
    // A finding placed by its segment only (a review finding's `at` carries more than the frame and the time).
    const bySegment: { frame?: number; segment?: string } = { segment: 'a' };
    expect(findingFrame(bySegment, 30)).toBeUndefined();
  });
});

describe('the files of renders/ the list does not show (L7.6b)', () => {
  it("one line per reason, counts and fixed words only; the words are core's", () => {
    expect(notShownWords(undefined)).toEqual([]);
    expect(
      notShownWords({
        count: 3,
        reasons: [
          { why: 'unknown-status', count: 1 },
          { why: 'renamed', count: 2 },
        ],
      }),
    ).toEqual([
      '1 file of renders/ is not shown as a render: its status is not one Retake writes',
      '2 files of renders/ are not shown as renders — for each, its record says another id', // fix pass: "files … its" (review B L-8)
    ]);
    // The mirror of core's words (the app imports core's types only): every reason, word for word.
    for (const why of Object.keys(RENDER_NOT_WORDS) as RenderNot[]) expect(RENDER_NOT_WORDS[why], why).toBe(renderNotWords(why));
    expect(Object.keys(RENDER_NOT_WORDS)).toHaveLength(10);
  });
});
