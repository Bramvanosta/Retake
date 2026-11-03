/**
 * Choreography helpers (L1.2): the trigger re-click (R-CHO-10), row-action triggers (R-CHO-13), adaptive typing
 * (R-CHO-14), the React-safe clear (R-CHO-15), parking (R-CHO-18/21) and the `date` action (R-CHO-24), on static pages
 * in a real browser (dry runs, fast pacing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import type { Pacing, Scene, TimelineEvent } from '@retake/core';
import { runScenario } from '../src/index.js';
import { cursorCovers } from '../src/scene-cursor.js';
import { CALENDAR_PAGE, CHOREO_PAGE, DESIGN_FRAME, EDITOR_PAGE, PICKERS_PAGE, POPOVER_PAGE, RICH_FRAME } from './pages.js';
import { FAST, makeProject, makeScenario, readTimeline, startServer, tempDir } from './helpers.js';
import type { TestServer } from './helpers.js';

let server: TestServer;
let dir: string;

beforeAll(async () => {
  server = await startServer({
    '/choreo.html': CHOREO_PAGE,
    '/calendar.html': CALENDAR_PAGE,
    '/popover.html': POPOVER_PAGE,
    '/editor.html': EDITOR_PAGE,
    '/rich-frame.html': RICH_FRAME,
    '/design-frame.html': DESIGN_FRAME,
    '/pickers.html': PICKERS_PAGE,
  });
  dir = await tempDir();
});

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

type Click = { role: string; desc: string; t_click: number; bbox?: { x: number; y: number; w: number; h: number } };
const clicksOf = (e: TimelineEvent) => ((e.data as { clicks?: Click[] } | undefined)?.clicks ?? []);
const roles = (e: TimelineEvent) => clicksOf(e).map((c) => c.role);

async function run(id: string, scenes: Scene[], pacing: Partial<Pacing> = FAST) {
  const rec = await runScenario({
    project: makeProject(dir, { app: server.url }, { width: 1000, height: 700 }),
    mode: 'dry',
    runId: id,
    scenario: makeScenario(id, { pacing, scenes }),
  });
  const tl = await readTimeline(rec.timeline!);
  return { rec, tl, ev: tl.events.filter((e) => e.step >= 0) };
}

describe('trigger re-click (R-CHO-10)', () => {
  it('re-clicks a trigger that opened nothing, never one whose popup is still filling; types a search once', async () => {
    const { rec, ev } = await run('reclick', [
      {
        id: 'lots',
        open: '/choreo.html',
        steps: [
          { menu: { row: 'Norway', item: 'Pause' } },
          { menu: { row: 'Denmark', item: 'Archive' } },
          { select: { combobox: '#late-region', option: 'Highlands', search: 'High' } },
          { select: { combobox: '#origin', option: 'Ethiopia', search: 'Eth' } },
          { assert: { text: 'Norway:Pause' } },
          { assert: { text: 'Denmark:Archive' } },
          { assert: { text: 'region=Highlands' } },
          { assert: { text: 'origin=Ethiopia' } },
        ],
      },
    ]);
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const [norway, denmark, late, origin] = ev;
    // Norway ignored the first click (and its DOM / pointer-sequence fallbacks) while another popup (the tips) was open.
    expect(roles(norway)).toEqual(['trigger', 'trigger', 'item']);
    expect(norway.data).toMatchObject({ retried: true });
    const nc = clicksOf(norway);
    expect(nc[1].t_click - nc[0].t_click).toBeGreaterThan(2.9);
    expect(norway.t_click).toBe(nc[1].t_click);
    // Denmark opened at once but filled its menu after 3.5 s: one trigger click (a second one would close it).
    expect(roles(denmark)).toEqual(['trigger', 'item']);
    expect((denmark.data as { retried?: boolean }).retried).toBeUndefined();
    expect(denmark.t_end - denmark.t_start).toBeGreaterThan(3.4);
    // A listbox that opened late: the search waits for it (no "no search field" failure), typed once after the re-click.
    expect(roles(late)).toEqual(['trigger', 'trigger', 'option']);
    expect(late.data).toMatchObject({ retried: true, option: 'Highlands' });
    // An editable combobox opens on input: typed at once after the click, no 3 s wait, no re-click, no fallback.
    expect(roles(origin)).toEqual(['trigger', 'option']);
    expect((origin.data as { retried?: boolean }).retried).toBeUndefined();
    expect(origin.t_end - origin.t_start).toBeLessThan(2.5);
    expect(rec.warnings.filter((w) => w.includes('#origin'))).toEqual([]);
  }, 60_000);
});

describe('row-action triggers (R-CHO-13)', () => {
  it('hover-only buttons, icon spans and header corners; a clickable row is never its own trigger', async () => {
    const { rec, ev } = await run('rowtrig', [
      {
        id: 'lots',
        open: '/choreo.html',
        steps: [
          { menu: { row: 'Estonia', item: 'Edit' } },
          { menu: { row: 'Finland', item: 'Archive' } },
          { menu: { row: { css: '.panel-head' }, item: 'Export' } },
          { menu: { row: 'Latvia', item: 'Pause' }, optional: true, timeout: 3 },
          { assert: { text: 'Estonia:Edit Finland:Archive Stock report:Export', not_text: 'Latvia-details' } },
        ],
      },
    ]);
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const [estonia, finland, panel, latvia, check] = ev;
    // Estonia: its trigger shows on hover; the visible "View" of an earlier cell is not taken.
    expect(estonia.status).toBe('ok');
    expect(clicksOf(estonia)[0].desc).toContain('Row actions');
    expect(rec.warnings.some((w) => w.includes('Estonia'))).toBe(false);
    // Finland: no button, the icon span at the row's right end (position, last resort, warned).
    expect(finland.status).toBe('ok');
    expect(rec.warnings.some((w) => w.includes('row "Finland"') && w.includes('right end (position, last resort)'))).toBe(true);
    // The card header: its top-right corner icon.
    expect(panel.status).toBe('ok');
    expect(rec.warnings.some((w) => w.includes('top-right corner'))).toBe(true);
    // Latvia: a clickable row (inherited pointer cursor on every cell) has no trigger: the step fails, the row is not opened.
    expect(latvia.status).toBe('failed');
    expect(latvia.error).toContain('give `trigger:`');
    expect(check.status).toBe('ok');
  }, 60_000);
});

describe('typing rate and clear (R-CHO-14, R-CHO-15)', () => {
  type TypeData = { chars: number; cps: number; rate: string; clear?: string; t_type: number; t_typed: number };
  const dataOf = (e: TimelineEvent) => e.data as TypeData;

  it('types search fields at ≤ 10 cps, other fields at type_cps; clears a controlled input through the native setter', async () => {
    const { rec, ev } = await run('typing', [
      {
        id: 'lots',
        open: '/choreo.html',
        steps: [
          { type: { into: '#q', text: 'Highland lots' } },
          { type: { into: { placeholder: 'Filter lots' }, text: 'Kenya' } },
          { type: { into: { aria: 'Lot name' }, text: 'Lot 7', clear: true } },
          { type: { into: { aria: 'Batch' }, text: 'B12', clear: true, cps: 30 } },
          { type: { into: { aria: 'Producer' }, text: 'Finca Quenaro', clear: true } },
          { assert: { text: 'state=Finca Quenaro' } },
          { eval: { js: "if (document.getElementById('controlled').value !== 'Finca Quenaro' || document.getElementById('plain').value !== 'Lot 7') throw new Error('values');" } },
        ],
      },
    ]);
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const [search, filter, plain, empty, controlled] = ev.map(dataOf);
    expect(search).toMatchObject({ rate: 'search', cps: 10, chars: 13 });
    // 13 characters at 10 cps (±30 % per character, deterministic): ≈ 1.3 s.
    expect(search.t_typed - search.t_type).toBeGreaterThan(1.3 * 0.7);
    expect(search.t_typed - search.t_type).toBeLessThan(1.3 * 1.35);
    expect(filter).toMatchObject({ rate: 'search', cps: 10 });
    expect(plain).toMatchObject({ rate: 'default', cps: 60, clear: 'keys' });
    expect(empty).toMatchObject({ rate: 'set', cps: 30, clear: 'empty' });
    // Select-all is blocked and the value tracker ignores a plain `value = ''`: only the native setter clears it.
    expect(controlled).toMatchObject({ rate: 'default', clear: 'setter' });
    expect(rec.warnings.filter((w) => w.includes('clear'))).toEqual([]);
  }, 60_000);

  it("clears editors in frames (contenteditable body, designMode) and an editor's hidden input with the keys", async () => {
    const { rec, ev } = await run('editors', [
      {
        id: 'notes',
        open: '/editor.html',
        steps: [
          { click: { text: 'Old rich text' } },
          { type: { text: 'Fresh rich text', clear: true, cps: 40 } },
          { click: { text: 'Old design text' } },
          { type: { text: 'Fresh design text', clear: true, cps: 40 } },
          { click: { css: '#cm-text' } },
          { type: { text: 'roast(new)', clear: true, cps: 40 } },
          {
            eval: {
              js:
                "const t = (id) => document.getElementById(id).contentDocument.body.textContent.trim(); " +
                "const v = [t('rich'), t('design'), document.getElementById('cm-text').textContent]; " +
                "if (v.join('|') !== 'Fresh rich text|Fresh design text|roast(new)') throw new Error(v.join('|'));",
            },
          },
        ],
      },
    ]);
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const [, rich, , design, , code] = ev;
    // The frame bodies are read (emptied by the keys, checked); the hidden textarea is not: the keys, unchecked.
    expect(dataOf(rich)).toMatchObject({ clear: 'keys', rate: 'set' });
    expect(dataOf(design)).toMatchObject({ clear: 'keys' });
    expect(dataOf(code)).toMatchObject({ clear: 'keys' });
    // A type step without `into` in a frame editor is filmed on the frame (the loupe and the spotlight follow it).
    expect(rich.target?.desc).toContain('iframe');
    expect(rich.target?.bbox?.w).toBeGreaterThan(500);
    expect(rec.warnings.filter((w) => w.includes('clear') || w.includes('not a text field'))).toEqual([]);
  }, 60_000);

  it('long free text speeds up towards 24 cps', async () => {
    const text = 'Light roast for filter, please. Before 9 am.';
    const { rec, ev } = await run('long', [{ id: 'lots', open: '/choreo.html', steps: [{ type: { into: { aria: 'Notes' }, text } }] }], { ...FAST, type_cps: 14 });
    expect(rec.status).toBe('succeeded');
    expect(dataOf(ev[0])).toMatchObject({ rate: 'long', cps: 14.5, chars: text.length });
  }, 30_000);
});

describe('date pickers (R-CHO-24)', () => {
  type DateData = { days: string[]; close: string; quick_runs?: Array<{ t_start: number; t_end: number; clicks: number }>; waited_close_ms?: number; clicks: Click[] };
  const dataOf = (e: TimelineEvent) => e.data as DateData;

  it('pages with the last visible month buttons in quick runs, picks days by label, waits for the previous popover', async () => {
    const { rec, ev } = await run('dates', [
      {
        id: 'cal',
        open: '/calendar.html',
        steps: [
          { date: { field: 'Delivery window', day: ['14 June 2027', '28 June 2027'], close: 'none' } },
          { date: { field: 'Roasting window', day: '2026-11-03' } },
          { date: '1 January 2027' },
          { date: { field: 'Tasting day', day: '14 February 2027' } },
          { assert: { text: 'delivery=2027-06-14..2027-06-28 roasting=2026-11-03.. mini=2027-01-01 tasting=2027-02-14' } },
          { date: { field: 'Delivery window', day: '2 October 2026' }, optional: true },
          { date: { field: 'Tasting day', day: ['2027-02-14', '2027-02-15'] }, optional: true },
        ],
      },
    ]);
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const [delivery, roasting, mini, tasting, check, disabled, nativeRange] = ev;
    // Delivery: October + November 2026 shown → May + June 2027 = 7 month clicks on the popover's visible (right) "Next
    // month", one quick run.
    const d = dataOf(delivery);
    expect(d.days).toEqual(['2027-06-14', '2027-06-28']);
    const navs = d.clicks.filter((c) => c.role === 'nav');
    expect(navs).toHaveLength(7);
    expect(roles(delivery)).toEqual(['trigger', ...navs.map(() => 'nav'), 'day', 'day']);
    const right = navs[0].bbox!;
    for (const c of navs) expect(c.bbox!.x).toBeCloseTo(right.x, 0);
    expect(right.x).toBeGreaterThan(400); // the right month's button, not the hidden one on the left nor the mini calendar's
    for (let i = 2; i < navs.length; i++) expect(navs[i].t_click - navs[i - 1].t_click).toBeLessThan(0.2);
    expect(d.quick_runs).toEqual([{ t_start: navs[0].t_click, t_end: navs[6].t_click, clicks: 7 }]);
    // Roasting: the Delivery popover was still closing (420 ms + fade): waited for; then paged back (Feb → Nov 2026).
    const r = dataOf(roasting);
    expect(r.waited_close_ms).toBeGreaterThan(100);
    expect(r.days).toEqual(['2026-11-03']);
    expect(roles(roasting).filter((x) => x === 'nav')).toHaveLength(3);
    expect(r.quick_runs).toBeUndefined();
    expect(roles(roasting).at(-1)).toBe('outside'); // a range left half open: clicked away after 1.5 s
    // The inline calendar, no field: 1 January (not 11, 21 or 31), by its data-date.
    expect(dataOf(mini).days).toEqual(['2027-01-01']);
    expect(roles(mini)).toEqual(['day']);
    expect(tasting).toMatchObject({ strategy: 'native', data: { days: ['2027-02-14'] } });
    expect(check.status).toBe('ok');
    expect(disabled.status).toBe('failed');
    expect(disabled.error).toContain('"2 October 2026" is disabled');
    expect(nativeRange.status).toBe('failed');
    expect(nativeRange.error).toContain('native date input holds one day');
  }, 90_000);

  it('a second date on the same field waits for its popover to close by itself, then opens it again', async () => {
    const { rec, ev } = await run('samefield', [
      {
        id: 'cal',
        open: '/calendar.html',
        steps: [
          { date: { field: 'Delivery window', day: ['14 June 2027', '28 June 2027'], close: 'none' } },
          { date: { field: 'Delivery window', day: ['5 July 2027', '19 July 2027'] } },
          { assert: { text: 'delivery=2027-07-05..2027-07-19' } },
        ],
      },
    ]);
    expect(rec.error?.message).toBeUndefined();
    const second = ev[1].data as DateData;
    expect(second.waited_close_ms).toBeGreaterThan(300);
    expect(roles(ev[1])[0]).toBe('trigger');
    expect(second.days).toEqual(['2027-07-05', '2027-07-19']);
  }, 60_000);

  it("pages a wizard's inline calendar with its own arrows, never the form's Back / Next; reads every month of a two-month popper", async () => {
    const { rec, ev } = await run('libpickers', [
      {
        id: 'pick',
        open: '/pickers.html',
        steps: [
          { date: '3 December 2026' },
          { date: '2026-09-15' },
          { date: { field: 'Delivery date', day: '20 December 2026' } },
          { date: { field: 'Delivery date', day: '24 December 2026' } },
          { date: { field: 'Delivery date', day: '7 November 2026' } },
          { assert: { text: 'roast=2026-12-03 roast=2026-09-15 delivery=2026-12-20 delivery=2026-12-24 delivery=2026-11-07' } },
          { assert: { not_text: 'wizard-submitted' } },
          { assert: { not_text: 'went-back' } },
        ],
      },
    ]);
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const [dec, sep, d20, d24, nov] = ev;
    // The inline calendar's month arrows are spans classed prev / next above the days; the wizard's buttons are below.
    expect(roles(dec)).toEqual(['nav', 'nav', 'day']);
    expect(roles(sep)).toEqual(['nav', 'nav', 'nav', 'day']);
    const arrows = clicksOf(sep).filter((c) => c.role === 'nav');
    const days = clicksOf(sep).find((c) => c.role === 'day')!;
    for (const a of arrows) expect(a.bbox!.y).toBeLessThan(days.bbox!.y);
    // The popper's month buttons sit outside the per-month listboxes; both shown months are read: 24 December is in the
    // first month of a December + January view (no month click), 7 November one month back.
    expect(roles(d20)).toEqual(['trigger', 'nav', 'day']);
    expect(roles(d24)).toEqual(['trigger', 'day']);
    expect(roles(nov)).toEqual(['trigger', 'nav', 'day']);
    expect(dataOf(d24).days).toEqual(['2026-12-24']);
    expect(rec.warnings).toEqual([]);
  }, 60_000);

  it('fails with the shown days when a label never shows up', async () => {
    const { rec, ev } = await run('nodate', [
      { id: 'cal', open: '/calendar.html', steps: [{ date: { field: 'Delivery window', day: 'Someday 2030' }, optional: true }] },
    ]);
    expect(rec.status).toBe('succeeded');
    expect(ev[0].status).toBe('failed');
    expect(ev[0].error).toMatch(/not found after 36 month clicks; shown: ".*2029" … ".*2029"/);
  }, 60_000);
});

describe('popovers holding a pick (review fix K1)', () => {
  it('a pick inside a floating popover closes its listbox only; click outside closes the innermost layer first', async () => {
    const { rec, ev } = await run('popover', [
      {
        id: 'filters',
        open: '/popover.html',
        steps: [
          { click: 'Filters' },
          { pick: { field: 'Tags', option: ['Washed', 'Honey'] } },
          { assert: { target: { css: '#apply' }, text: 'tags=Washed,Honey' } },
          { assert: { not_text: 'popover-closed' } },
          { type: { into: { label: 'View name' }, text: 'Kenya lots', clear: true } },
          { click: 'Any tag' },
          { click: { outside: true } },
          { assert: { target: { css: '#apply' }, gone: { css: '#tags-list' } } },
          { assert: { not_text: 'popover-closed' } },
          { click: { outside: true } },
          { assert: { text: 'popover-closed', gone: { css: '#apply' } } },
        ],
      },
    ]);
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const [, pick, , , rename, , out1, , , out2] = ev;
    // The listbox closed on the popover's title: the popover stayed open.
    const outside = clicksOf(pick).at(-1)!;
    expect(outside.role).toBe('outside');
    expect(outside.desc).toContain('dialog title');
    // A field of a popover holding a small form is not a search: the default rate.
    expect((rename.data as { rate: string }).rate).toBe('default');
    expect(out1.target?.desc).toContain('dialog title');
    expect(out2.target?.desc).toContain('blank area');
    expect(rec.warnings).toEqual([]);
  }, 60_000);
});

describe('parking (R-CHO-18, R-CHO-21)', () => {
  type Park = { kind: string; how: string; from: { x: number; y: number }; to: { x: number; y: number }; avoided: number; hold_s: number };
  type Box = { x: number; y: number; w: number; h: number };
  const parkOf = (e: TimelineEvent) => (e.data as { park?: Park } | undefined)?.park;
  const PARK = { ...FAST, park_hold: 0.3, park_scroll_hold: 0.3 };
  const boxes = { eval: { js: "return ['save', 'banner', 'toast', 'awards'].map((id) => { const el = document.getElementById(id); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })" } };

  it('parks next to a scroll target (clear of its text), away from what a click changed, and before a hold step', async () => {
    const { rec, ev } = await run(
      'park',
      [
        { id: 'scroll', open: '/choreo.html', steps: [{ scroll: { to: '#awards' }, park: true }, boxes] },
        { id: 'save', open: '/choreo.html', steps: [{ click: 'Save draft', park: true }, boxes] },
        { id: 'later', open: '/choreo.html', steps: [{ click: 'Save draft' }, { wait_for: 'Draft saved' }, { hold: 0.4, park: true }, boxes] },
      ],
      PARK,
    );
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    const [scroll, b1, save, b2, click, , hold, b3] = ev;
    // R-CHO-18: next to the Awards heading, never on its text, within reach; held 0.3 s after the move.
    const sp = parkOf(scroll)!;
    expect(sp).toMatchObject({ kind: 'scroll', how: 'glide', hold_s: 0.3 });
    const awards = (b1.data as { value: Box[] }).value[3];
    const text = { x: awards.x, y: awards.y, w: 80, h: awards.h }; // "Awards" (≈ 60 px) at the left of a full-width h2
    expect(cursorCovers(sp.to, text)).toBe(false);
    expect(Math.hypot(sp.to.x - (text.x + 40), sp.to.y - (awards.y + awards.h / 2))).toBeLessThan(240);
    expect(scroll.hold!.t_start).toBe(scroll.t_end);
    expect(scroll.hold!.t_end - scroll.hold!.t_start).toBeGreaterThan(0.28);
    // R-CHO-21: away from the button, the banner and the toast the click added.
    const cp = parkOf(save)!;
    expect(cp).toMatchObject({ kind: 'result', how: 'glide', hold_s: 0.3 });
    expect(cp.avoided).toBeGreaterThanOrEqual(3);
    for (const b of (b2.data as { value: Box[] }).value.slice(0, 3)) expect(cursorCovers(cp.to, b), JSON.stringify({ to: cp.to, b })).toBe(false);
    expect(save.hold!.t_start).toBe(save.t_end);
    // A hold step parks first, then holds: the click without `park` keeps its cursor.
    expect(parkOf(click)).toBeUndefined();
    const hp = parkOf(hold)!;
    expect(hp).toMatchObject({ kind: 'result', how: 'glide', hold_s: 0 });
    expect(hold.hold!.t_start).toBeGreaterThan(hold.t_start + 0.05);
    expect(hold.hold!.t_end - hold.hold!.t_start).toBeGreaterThan(0.38);
    for (const b of (b3.data as { value: Box[] }).value.slice(0, 3)) expect(cursorCovers(hp.to, b)).toBe(false);
  }, 60_000);

  it('never parks away from a menu the step opened by hovering', async () => {
    const { rec, ev } = await run('hoverpark', [{ id: 'acct', open: '/popover.html', steps: [{ hover: 'Account', park: true }, { assert: { text: 'Sign out' } }] }], PARK);
    expect(rec.error?.message).toBeUndefined();
    expect(rec.status).toBe('succeeded');
    expect(parkOf(ev[0])).toMatchObject({ how: 'skip' });
  }, 30_000);

  it('never parks without `park` (the default): the cursor stays where it clicked', async () => {
    const { rec, ev, tl } = await run('nopark', [{ id: 'save', open: '/choreo.html', steps: [{ click: 'Save draft' }, { hold: 0.3 }] }], PARK);
    expect(rec.status).toBe('succeeded');
    expect(ev.every((e) => parkOf(e) === undefined)).toBe(true);
    const at = ev[0].point!;
    const after = tl.cursor.filter((c) => c.t > ev[0].t_end);
    expect(after.every((c) => c.x === at.x && c.y === at.y)).toBe(true);
  }, 30_000);
});
