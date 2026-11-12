/**
 * L5.12a: the Review report's pure rules (review-words.ts, route.ts, shell/modes.ts):
 * - ⚑ the check families are total over the review package's FINDING_CODES (each code in exactly one family; a code the
 *   table does not know is Other) and keep the table's order, errors first inside a family;
 * - ⚑ never "passed": the counts in words say what the review found; no source of the report, the renders, Edit's status
 *   bar, the scenario card or the palette writes the word (a review does not record which checks ran: BL-132);
 * - ⚑ the raw capture's export command is built only from a project slug and a run id that pass their rules (a space, a
 *   quote, a `;`, a path give no command) — L5.12a fixes (review B-L7): the unused MP4 command is gone (Export video is
 *   the review_export job);
 * - ⚑ the review route: a render id of a render id's shape (the same as core's RENDER_ID_RE) or not found; hrefTo drops
 *   another; Review's mode opens the view this tab used last, the report first.
 * - L5.12a fixes: two renders that read the same "when" show their time (B-L2); the export part reads the activity on
 *   its own project's jobs only (A-L1); a pending Show in Edit is dropped by a route elsewhere (A-L6).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RENDER_ID_RE } from '@retake/core';
import { FINDING_CODES } from '../../review/src/types.js';
import { REPO } from '../../engine/test/helpers.js';
import { CHECK_FAMILIES, NOTHING_ELSE, agoWords, clockWords, countWords, exportReadsOn, familyOf, groupFindings, rawExportCommand, reportHint, sharedWhen, severityMark, stepKeyOf, whereWords } from '../src/app/review/review-words.js';
import { RENDER_ID, hrefTo, parseRoute } from '../src/app/route.js';
import { modeOf, modeTarget, noteReviewView, reviewView } from '../src/app/shell/modes.js';
import { editSeekRouteChanged, seekInEdit, takeEditSeek } from '../src/app/edit/edit-handoff.js';

const APP = join(REPO, 'packages', 'ui', 'src', 'app');

describe('the Review report (L5.12a)', () => {
  it('⚑ the check families: total over FINDING_CODES, each code once, an unknown code is Other', () => {
    const all = CHECK_FAMILIES.flatMap((f) => f.codes);
    expect(new Set(all).size, 'each code in one family').toBe(all.length);
    expect([...FINDING_CODES].filter((c) => !all.includes(c)), 'codes no family holds').toEqual([]);
    expect(all.filter((c) => !FINDING_CODES.has(c)), 'codes no check writes').toEqual([]);
    expect(CHECK_FAMILIES.at(-1)!.id).toBe('other');
    expect(familyOf('caption-too-long')).toBe('captions');
    expect(familyOf('a-code-from-a-newer-review')).toBe('other');
    // The table's order; errors first inside a family, then the review's order.
    const g = groupFindings([
      { severity: 'info', code: 'caption-shrunk' },
      { severity: 'warning', code: 'video-length' },
      { severity: 'error', code: 'caption-missing' },
      { severity: 'warning', code: 'brand-new-code' },
    ]);
    expect(g.map((x) => [x.family.id, x.items.map((i) => i.index)])).toEqual([
      ['length', [1]],
      ['captions', [2, 0]],
      ['other', [3]],
    ]);
  });

  it('⚑ never "passed": the counts say what was found; no source of the report, the renders, Edit, the card or the palette says it', async () => {
    expect(countWords({ error: 0, warning: 2, info: 1 })).toBe('0 errors, 2 warnings, 1 note');
    expect(countWords({ error: 1, warning: 1, info: 0 })).toBe('1 error, 1 warning, 0 notes');
    expect(NOTHING_ELSE).toBe('Nothing else found.');
    for (const s of ['error', 'warning', 'info'] as const) expect(severityMark(s).word).not.toMatch(/pass/i);
    // L5.12b: the palette's "Review report — last render vN · <words>" row says what the review found, never "passed".
    expect(reportHint({ render_id: 'bits-v2', review: { state: 'clean', counts: { error: 0, warning: 0, info: 0 } } })).toBe('last render v2 · clean');
    expect(reportHint({ render_id: 'bits-v2', review: { state: 'warnings', counts: { error: 0, warning: 2, info: 0 } } })).toBe('last render v2 · 2 warnings');
    expect(reportHint(undefined)).toBe('no render yet');
    // L5.12b fixes (review B-L2): a render without a review is said so — never "no render yet"; failed ones only, too.
    expect(reportHint({ render_id: 'bits-v1', review: { state: 'none' } })).toBe('last render v1 · not reviewed');
    expect(reportHint(undefined, 2)).toBe('no finished render yet');
    for (const state of ['clean', 'warnings', 'errors', 'queued', 'running', 'failed', 'cancelled', 'none']) expect(reportHint({ render_id: 'x-v3', review: { state, counts: { error: 1, warning: 1, info: 1 } } as never }), state).not.toMatch(/\bpass(?:ed|es)?\b|no render/i);
    for (const f of ['review/ReviewScreen.tsx', 'review/review-words.ts', 'review/Renders.tsx', 'words/render-words.ts', 'edit/EditStatus.tsx', 'script/ScenarioScreen.tsx', 'shell/AppShell.tsx', 'shell/command-bus.ts', 'ui-kit/CommandPalette.tsx', 'review/CommentsScreen.tsx', 'edit/TimelineScreen.tsx']) {
      const text = (await readFile(join(APP, f), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(/\bpass(?:ed|es)?\b/i.test(text), `${f} says "passed"`).toBe(false);
    }
  });

  it('⚑ export commands only from ids that pass their rules', () => {
    expect(rawExportCommand('northfield-fixture', '20261028-083853-quote')).toBe('retake export-capture northfield-fixture 20261028-083853-quote');
    for (const [slug, run] of [
      ['demo', 'a b'],
      ['demo', 'x;rm -rf ~'],
      ['demo', '../x'],
      ['demo', '-v'],
      ['demo', "it's"],
      ['demo', '$(id)'],
      ['de mo', 'r1'],
      ['Demo', 'r1'],
      ['demo/x', 'r1'],
      ['demo', 'a'.repeat(201)],
    ]) {
      expect(rawExportCommand(slug, run), `${slug} ${run}`).toBeNull();
    }
  });

  it('⚑ the review route: a render id of a render id\'s shape or not found; hrefTo drops another; the mode opens the view used last', () => {
    for (const id of ['quote-v1', 'quote-v12-vertical', 'a_b-v3-square', 'x-v0']) expect(RENDER_ID.test(id) && RENDER_ID_RE.test(id), id).toBe(true);
    for (const id of ['quote', 'quote-v', 'quote-v1-tall', '../quote-v1', '<b>-v1', '-v1', 'quote-v1/x', '20260101-120000-quote']) expect(RENDER_ID.test(id) || RENDER_ID_RE.test(id), id).toBe(false);
    expect(parseRoute('#/p/demo/s/quote/review')).toEqual({ name: 'review', slug: 'demo', scenario: 'quote' });
    expect(parseRoute('#/p/demo/s/quote/review/quote-v3')).toEqual({ name: 'review', slug: 'demo', scenario: 'quote', render: 'quote-v3' });
    for (const bad of ['../x', '%3Cb%3E', '20260101-120000-quote', 'quote-v3%2F..', 'quote-v3/x']) expect(parseRoute(`#/p/demo/s/quote/review/${bad}`), bad).toMatchObject({ name: 'not-found' });
    for (const scenario of ['quote', '<img src=x>', 'a/b']) {
      const r = { name: 'review' as const, slug: 'p/q', scenario, render: 'quote-v2' };
      expect(parseRoute(hrefTo(r))).toEqual(r);
    }
    expect(hrefTo({ name: 'review', slug: 'demo', scenario: 'quote', render: '../x' })).toBe('#/p/demo/s/quote/review');
    // Review's two views: the report first, then whichever this tab used last.
    const ctx = { slug: 'demo', scenario: 'quote' };
    expect(modeOf({ name: 'review', slug: 'demo', scenario: 'quote' }, ctx)).toBe('review');
    expect(reviewView()).toBe('report');
    expect(modeTarget('review', ctx)).toEqual({ name: 'review', slug: 'demo', scenario: 'quote' });
    noteReviewView({ name: 'comments', slug: 'demo', scenario: 'quote' });
    expect(modeTarget('review', ctx)).toEqual({ name: 'comments', slug: 'demo', scenario: 'quote' });
    noteReviewView({ name: 'timeline', slug: 'demo', scenario: 'quote' });
    expect(reviewView()).toBe('comments');
    noteReviewView({ name: 'review', slug: 'demo', scenario: 'quote' });
    expect(reviewView()).toBe('report');
  });

  it('words: where a finding is, its step key, a time ago', () => {
    expect(whereWords({ scene: 'delivery', step: 5, frame: 3 })).toBe('scene delivery · step 6');
    expect(whereWords({ segment: 'intro' })).toBe('segment intro');
    expect(whereWords({ scene: 'a', step: -1 })).toBe('scene a · its opening still');
    expect(stepKeyOf({ scene: 'a', step: 2 })).toBe('a.2');
    expect(stepKeyOf({ scene: 'a', step: -1 })).toBeUndefined();
    expect(stepKeyOf({ segment: 'a' })).toBeUndefined();
    const now = Date.parse('2026-11-02T12:00:00.000Z');
    expect(agoWords('2026-11-02T11:59:30.000Z', now)).toBe('just now');
    expect(agoWords('2026-11-02T10:00:00.000Z', now)).toBe('2 h ago');
    expect(agoWords('not a date', now)).toBe('not a date');
  });

  it('⚑ L5.12a fixes (review B-L2): two renders that read the same "when" show their time of day; one alone does not', () => {
    const now = Date.parse('2026-11-02T12:00:00.000Z');
    const items = [
      { id: 'q-v3', at: '2026-01-01T12:30:00.000Z' },
      { id: 'q-v2', at: '2026-01-01T12:00:00.000Z' },
      { id: 'q-v1', at: '2025-12-30T11:00:00.000Z' },
      { id: 'q-v4', at: '2026-11-02T11:59:50.000Z' },
    ];
    expect([...sharedWhen(items, now)].sort()).toEqual(['q-v2', 'q-v3']);
    expect(sharedWhen(items.slice(2), now).size).toBe(0);
    expect(clockWords('2026-01-01T12:30:00.000Z')).toMatch(/^\d{2}:\d{2}$/);
    expect(clockWords('2026-01-01T12:30:00.000Z')).not.toBe(clockWords('2026-01-01T12:00:00.000Z'));
    expect(clockWords('not a date')).toBe('');
  });

  it('⚑ L5.12a fixes (review A-L1): the export part reads the activity again on its own project\'s jobs only (and a reconnection)', () => {
    expect(exportReadsOn({ type: 'resync' }, 'demo')).toBe(true);
    expect(exportReadsOn({ type: 'jobs', changed: ['j_1'], projects: ['demo'] }, 'demo')).toBe(true);
    expect(exportReadsOn({ type: 'jobs', changed: ['j_1'], projects: ['other', 'demo'] }, 'demo')).toBe(true);
    expect(exportReadsOn({ type: 'jobs', changed: ['j_1'], projects: ['other'] }, 'demo')).toBe(false);
    // An older server names no project: read (it may be ours).
    expect(exportReadsOn({ type: 'jobs', changed: ['j_1'] }, 'demo')).toBe(true);
  });

  it('⚑ L5.12a fixes (review A-L6): a pending Show in Edit lives only on the way to that scenario\'s Edit — a route elsewhere drops it', () => {
    const ask = { slug: 'demo', scenario: 'quote', render_id: 'quote-v2', frame: 30 };
    seekInEdit(ask);
    editSeekRouteChanged('#/p/demo/s/quote/timeline/20260101-120000-quote');
    expect(takeEditSeek('demo', 'quote')).toEqual(ask);
    expect(takeEditSeek('demo', 'quote')).toBeNull();
    // Another scenario's Edit, the report again, the project: dropped.
    for (const hash of ['#/p/demo/s/other/timeline', '#/p/demo/s/quote/review', '#/p/demo']) {
      seekInEdit(ask);
      editSeekRouteChanged(hash);
      expect(takeEditSeek('demo', 'quote'), hash).toBeNull();
    }
  });
});
