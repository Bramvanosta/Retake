/**
 * L5.2b — the page's half of the quit question, without a browser: `unsavedItems()` (drafts.ts) names the drafts with
 * unsaved text and the marks of component-local text — kinds and names only — and the reporter (unsaved-report.ts)
 * sends on a change (one call in flight, the latest state after it), nothing while nothing was ever unsaved, the
 * visibility while the set is not empty, an empty report with keepalive on pagehide (a report never outlives its tab
 * session), a retry after a failed call, and stops when the session ends; a name that is none is left out before
 * sending, the item kept (review A L4). The real tab (typing in the README editor and
 * the comments composer, a reload) is studio-e2e-unsaved.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { getDraft, readmeKey, scenarioKey, setDraft, setMark, unsavedItems } from '../src/app/drafts.js';
import type { UnsavedItem } from '../src/app/drafts.js';
import { RETRY_MS, newTabId, reportable, startUnsavedReport } from '../src/app/unsaved-report.js';
import type { ReportArgs, ReportDeps } from '../src/app/unsaved-report.js';
import { SessionEnded } from '../src/app/session.js';

const base = (text: string) => ({ text, base: { text: 'saved', hash: null, eol: '\n' as const } });

describe('unsavedItems: drafts with unsaved text and marks', () => {
  it('names a README and a scenario YAML draft, the marks, deduplicated; a clean draft or a cleared mark is not named', () => {
    setDraft(readmeKey('shop'), base('typed'));
    setDraft(scenarioKey('shop', 'quote'), base('typed'));
    setDraft(readmeKey('clean'), base('saved'));
    const a = Symbol('a');
    const b = Symbol('b');
    setMark(a, { kind: 'comment', project: 'shop', scenario: 'quote' });
    setMark(b, { kind: 'comment', project: 'shop', scenario: 'quote' });
    expect(unsavedItems()).toEqual([
      { kind: 'comment', project: 'shop', scenario: 'quote' },
      { kind: 'readme', project: 'shop' },
      { kind: 'yaml_draft', project: 'shop', scenario: 'quote' },
    ]);
    setMark(a, null);
    setMark(b, null);
    setDraft(readmeKey('shop'), undefined);
    setDraft(scenarioKey('shop', 'quote'), undefined);
    setDraft(readmeKey('clean'), undefined);
    expect(getDraft(readmeKey('shop'))).toBeUndefined();
    expect(unsavedItems()).toEqual([]);
  });

  it('a tab id is 22 base64url characters', () => {
    expect(newTabId(new Uint8Array(16).fill(255))).toBe('_____________________w');
    expect(newTabId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

function fake() {
  let items: UnsavedItem[] = [];
  let hidden = false;
  const sent: Array<{ args: ReportArgs; keepalive: boolean; resolve: () => void; reject: (e: unknown) => void }> = [];
  const listeners = new Map<string, () => void>();
  let change: () => void = () => undefined;
  const timers: Array<{ f: () => void; ms: number; off: boolean }> = [];
  const deps: ReportDeps = {
    send: (args, keepalive) => new Promise((resolve, reject) => sent.push({ args, keepalive, resolve: () => resolve(undefined), reject })),
    items: () => items,
    subscribe: (f) => {
      change = f;
      return () => (change = () => undefined);
    },
    hidden: () => hidden,
    listen: (event, f) => {
      listeners.set(event, f);
      return () => listeners.delete(event);
    },
    timer: (f, ms) => {
      const t = { f, ms, off: false };
      timers.push(t);
      return () => (t.off = true);
    },
    tabId: () => 'T'.repeat(22),
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    deps,
    sent,
    timers,
    listeners,
    flush,
    set(next: UnsavedItem[], h = hidden) {
      items = next;
      hidden = h;
      change();
    },
    event(e: string, h?: boolean) {
      if (h !== undefined) hidden = h;
      listeners.get(e)?.();
    },
  };
}

const README: UnsavedItem = { kind: 'readme', project: 'shop' };
const COMMENT: UnsavedItem = { kind: 'comment', project: 'shop', scenario: 'quote' };

describe('the reporter (fake page)', () => {
  it('nothing sent while nothing was unsaved; a change sends at once; one call in flight, the latest state after it', async () => {
    const f = fake();
    const stop = startUnsavedReport(f.deps);
    f.event('visibilitychange', true);
    expect(f.sent).toHaveLength(0);
    f.set([README], false);
    expect(f.sent.map((s) => s.args)).toEqual([{ tab: 'T'.repeat(22), hidden: false, items: [README] }]);
    f.set([README, COMMENT]);
    f.set([COMMENT]);
    expect(f.sent).toHaveLength(1);
    f.sent[0]!.resolve();
    await f.flush();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.args.items).toEqual([COMMENT]);
    f.sent[1]!.resolve();
    await f.flush();
    // The same state again: nothing.
    f.set([COMMENT]);
    expect(f.sent).toHaveLength(2);
    // Hidden while not empty: the flag is sent (the server keeps a hidden tab's report).
    f.event('visibilitychange', true);
    expect(f.sent[2]!.args).toMatchObject({ hidden: true, items: [COMMENT] });
    f.sent[2]!.resolve();
    await f.flush();
    // The set empties: an empty report clears the tab.
    f.set([]);
    expect(f.sent[3]!.args.items).toEqual([]);
    f.sent[3]!.resolve();
    await f.flush();
    stop();
    f.set([README]);
    expect(f.sent).toHaveLength(4);
  });

  it('a name that fails the rule (no slug, past 100 characters) is left out before sending; the item and the other items stay (review A L4)', async () => {
    const f = fake();
    startUnsavedReport(f.deps);
    f.set([{ kind: 'readme', project: 'a'.repeat(101) }, { kind: 'comment', project: 'shop', scenario: 'Not a name' }, { kind: 'theme_draft', project: 'Shop' }, README]);
    expect(f.sent[0]!.args.items).toEqual([{ kind: 'readme' }, { kind: 'comment', project: 'shop' }, { kind: 'theme_draft' }, README]);
    expect(reportable({ kind: 'step_form', project: 'a'.repeat(100), scenario: `Q${'x'.repeat(99)}` })).toEqual({ kind: 'step_form', project: 'a'.repeat(100), scenario: `Q${'x'.repeat(99)}` });
    // A scenario is named only with its project.
    expect(reportable({ kind: 'step_form', scenario: 'quote' })).toEqual({ kind: 'step_form' });
  });

  it('pagehide: an empty report with keepalive (only when something was reported); pageshow reports again', async () => {
    const f = fake();
    startUnsavedReport(f.deps);
    f.event('pagehide');
    expect(f.sent).toHaveLength(0);
    f.event('pageshow');
    expect(f.sent).toHaveLength(0);
    f.set([README]);
    f.sent[0]!.resolve();
    await f.flush();
    f.event('pagehide');
    expect(f.sent[1]).toMatchObject({ args: { hidden: true, items: [] }, keepalive: true });
    f.sent[1]!.resolve();
    await f.flush();
    // The unload's visibilitychange (after pagehide) and a late change send nothing: the empty report stays the last.
    f.event('visibilitychange', true);
    f.set([README, COMMENT]);
    expect(f.sent).toHaveLength(2);
    f.set([README], false);
    f.event('pageshow');
    expect(f.sent[2]).toMatchObject({ args: { items: [README] }, keepalive: false });
  });

  it('pagehide while a call is in flight: still the empty report, and its late answer does not hide it from pageshow', async () => {
    const f = fake();
    startUnsavedReport(f.deps);
    f.set([README]);
    f.event('pagehide');
    expect(f.sent[1]).toMatchObject({ args: { items: [] }, keepalive: true });
    f.sent[0]!.resolve();
    await f.flush();
    f.event('pageshow');
    expect(f.sent[2]).toMatchObject({ args: { items: [README] } });
  });

  it(`a failed call is tried again after ${RETRY_MS} ms; the session ended stops it`, async () => {
    const f = fake();
    startUnsavedReport(f.deps);
    f.set([README]);
    f.sent[0]!.reject(new Error('offline'));
    await f.flush();
    expect(f.timers.map((t) => t.ms)).toEqual([RETRY_MS]);
    f.timers[0]!.f();
    expect(f.sent).toHaveLength(2);
    f.sent[1]!.reject(new SessionEnded());
    await f.flush();
    f.set([COMMENT]);
    f.event('pagehide');
    expect(f.sent).toHaveLength(2);
    expect(f.listeners.size).toBe(0);
  });
});
