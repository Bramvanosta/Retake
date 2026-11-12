/**
 * L4.6 (T2): the thread schema's L4.6 additions (core comments.ts) — the `studio` channel, the `apply` entry, Claude's
 * proposal in a reply (critique B1 / B10 / B13: hunks sorted, separated, none empty; lines without hidden characters,
 * ≤ 2,000 UTF-16 units; ≤ 200 changed lines and 30,000 characters; edit-only) — and `proposalStates` (critique B4:
 * applied, undone, superseded, stale, pending, from today's file first; only the newest pending or undone proposal is
 * actionable). ⚑ marks the rules a mutation check reverted. Fixes after the reviews: a lone surrogate is refused (review
 * A L6); an older proposal reads applied only when an apply names it (review B L6).
 */
import { describe, expect, it } from 'vitest';
import { CommentEntrySchema, CommentThreadSchema, PROPOSAL_CHANGED_LINES_MAX, PROPOSAL_CHARS_MAX, PROPOSAL_LINE_MAX, proposalHunksProblem, proposalLineProblem, proposalStates } from '../src/index.js';
import type { CommentEntry } from '../src/index.js';

const T0 = '2026-10-27T09:00:00.000Z';
const H = (c: string) => c.repeat(64);
const thread = (entries: unknown[] = []) => ({
  version: 1,
  id: 'c_01JABCDEFGHJKMNPQRSTVWXYZ0',
  scenario: 'quote',
  render: { id: 'quote-v1', created_at: '2026-10-27T08:50:00.000Z', run_id: '20261027-084026-quote', variant: 'landscape', fps: 30, frames: 300, width: 1920, height: 1080 },
  frame: 120,
  time_s: 4,
  text: 'The caption is too long.',
  author: { via: 'studio', name: 'Reviewer' },
  created_at: T0,
  anchor: { segment: 's1', kind: 'clip' },
  entries,
});
const proposal = (o: Record<string, unknown> = {}) => ({
  base_sha256: H('a'),
  result_sha256: H('b'),
  eol: 'lf',
  delta: 'edit',
  hunks: [{ at: 3, del: ['    caption: A very long caption'], add: ['    caption: Short'] }],
  ...o,
});
const reply = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `r_01JABCDEFGHJKMNPQRSTVWXYZ${n}`,
  kind: 'reply',
  author: { via: 'mcp', name: 'agent' },
  text: 'Shorter caption proposed.',
  created_at: T0,
  ...extra,
});
const apply = (n: number, applies: number, extra: Record<string, unknown> = {}) => ({
  id: `r_01JABCDEFGHJKMNPQRSTVWXYZ${n}`,
  kind: 'apply',
  author: { via: 'studio', name: 'Reviewer' },
  text: '',
  created_at: T0,
  applies: `r_01JABCDEFGHJKMNPQRSTVWXYZ${applies}`,
  scenario_sha256: H('b'),
  ...extra,
});
const ok = (v: unknown) => CommentThreadSchema.safeParse(v).success;
const why = (v: unknown) => JSON.stringify(CommentThreadSchema.safeParse(v).error?.issues ?? []);

describe('the thread schema in L4.6 (T2)', () => {
  it('accepts the studio channel on the thread and on entries (core comments.ts COMMENT_VIAS)', () => {
    expect(ok(thread()), why(thread())).toBe(true);
    expect(ok(thread([{ ...reply(1), author: { via: 'studio', name: 'Reviewer' } }]))).toBe(true);
    expect(ok({ ...thread(), author: { via: 'ui', name: 'Reviewer' } })).toBe(false);
  });

  it('a proposal only on a reply; an apply names an earlier reply holding one and the file written (both), its text may be empty', () => {
    const t = thread([reply(1, { proposal: proposal() }), apply(2, 1)]);
    expect(ok(t), why(t)).toBe(true);
    for (const kind of ['resolve', 'reopen']) expect(ok(thread([reply(1, { kind, text: 'x', proposal: proposal() })])), kind).toBe(false);
    expect(ok(thread([reply(1, { proposal: proposal() }), apply(2, 1, { applies: undefined })]))).toBe(false);
    expect(ok(thread([reply(1, { proposal: proposal() }), apply(2, 1, { scenario_sha256: undefined })]))).toBe(false);
    expect(ok(thread([reply(1, { proposal: proposal() }), apply(2, 1, { scenario_sha256: 'nope' })]))).toBe(false);
    // An apply naming a reply without a proposal, a later entry, or nothing in the thread.
    expect(ok(thread([reply(1), apply(2, 1)]))).toBe(false);
    expect(ok(thread([apply(2, 3), reply(3, { proposal: proposal() })]))).toBe(false);
    expect(ok(thread([reply(1, { proposal: proposal() }), apply(2, 9)]))).toBe(false);
    // Only an apply names what it applied.
    expect(ok(thread([reply(1, { applies: 'r_01JABCDEFGHJKMNPQRSTVWXYZ1', scenario_sha256: H('b') })]))).toBe(false);
    expect(CommentEntrySchema.safeParse(apply(2, 1, { text: '' })).success).toBe(true);
    expect(CommentEntrySchema.safeParse(reply(1, { text: '' })).success).toBe(false);
  });

  it('⚑ hunks: sorted, separated by an unchanged line, none empty, at least one; base ≠ result; edit-only; strict keys', () => {
    const p = (o: Record<string, unknown>) => ok(thread([reply(1, { proposal: proposal(o) })]));
    expect(p({})).toBe(true);
    expect(p({ hunks: [] })).toBe(false);
    expect(
      p({
        hunks: [
          { at: 4, del: ['d'], add: ['D'] },
          { at: 2, del: ['b'], add: ['B'] },
        ],
      }),
    ).toBe(false);
    expect(
      p({
        hunks: [
          { at: 2, del: ['b'], add: ['B'] },
          { at: 3, del: ['c'], add: ['C'] },
        ],
      }),
    ).toBe(false);
    expect(p({ hunks: [{ at: 2, del: [], add: [] }] })).toBe(false);
    expect(p({ hunks: [{ at: 0, del: [], add: ['x'] }] })).toBe(false);
    expect(
      p({
        hunks: [
          { at: 2, del: ['b'], add: ['B'] },
          { at: 4, del: ['d'], add: ['D'] },
        ],
      }),
    ).toBe(true);
    expect(p({ result_sha256: H('a') })).toBe(false);
    expect(p({ delta: 'filmed' })).toBe(false);
    expect(p({ eol: 'cr' })).toBe(false);
    expect(p({ extra: 1 })).toBe(false);
    expect(p({ hunks: [{ at: 1, del: [], add: ['x'], context: ['y'] }] })).toBe(false);
  });

  it('⚑ lines: no control (a tab is fine), direction, invisible or tag character, no BOM, no line break; ≤ 2,000 UTF-16 units (emoji count twice)', () => {
    const line = (l: string) => ok(thread([reply(1, { proposal: proposal({ hunks: [{ at: 1, del: [], add: [l] }] }) })]));
    expect(line('\tcaption: tabbed')).toBe(true);
    expect(line('caption: 👩‍💻 fine')).toBe(true);
    for (const c of ['\u0007', '‮', '⁦', '​', '⁠', '\u{e0041}', '﻿', '­', ' ', '\r', '\n', '\u0085']) {
      expect(line(`caption: x${c}y`), `U+${c.codePointAt(0)!.toString(16)}`).toBe(false);
      expect(ok(thread([reply(1, { proposal: proposal({ hunks: [{ at: 1, del: [`a${c}`], add: ['b'] }] }) })])), `del U+${c.codePointAt(0)!.toString(16)}`).toBe(false);
    }
    expect(proposalLineProblem('x‮y')).toMatch(/U\+202E \(a direction control\)/);
    // Half a character (review A L6): written as UTF-8 it would be U+FFFD; a whole pair is fine.
    expect(proposalLineProblem('says \ud800 much')).toBe('half of a character (a lone UTF-16 surrogate)');
    expect(proposalLineProblem('says \udfff')).toBe('half of a character (a lone UTF-16 surrogate)');
    expect(line('caption: \ud83d')).toBe(false);
    expect(proposalLineProblem('says 😀 much')).toBeNull();
    expect(line('x'.repeat(PROPOSAL_LINE_MAX))).toBe(true);
    expect(line('x'.repeat(PROPOSAL_LINE_MAX + 1))).toBe(false);
    // 1,001 emoji: 1,001 code points but 2,002 UTF-16 units — what a 2,000-unit cut would truncate (critique B1 d).
    expect(line('😀'.repeat(1000))).toBe(true);
    expect(line('😀'.repeat(1001))).toBe(false);
    expect(proposalLineProblem('😀'.repeat(1001))).toMatch(/2002 characters \(UTF-16 units\)/);
  });

  it('⚑ caps (critique B13): 200 changed lines (removed + added), 30,000 characters', () => {
    const adds = (n: number, len = 10) => [{ at: 1, del: [], add: Array.from({ length: n }, (_, i) => `l${i}`.padEnd(len, 'x')) }];
    expect(proposalHunksProblem(adds(PROPOSAL_CHANGED_LINES_MAX))).toBeNull();
    expect(proposalHunksProblem(adds(PROPOSAL_CHANGED_LINES_MAX + 1))).toMatch(/201 changed lines/);
    expect(proposalHunksProblem([{ at: 1, del: Array.from({ length: 100 }, () => 'a'), add: Array.from({ length: 101 }, () => 'b') }])).toMatch(/201 changed lines/);
    expect(proposalHunksProblem(adds(15, 2000))).toBeNull();
    expect(proposalHunksProblem(adds(16, 2000))).toMatch(/32,000 characters/);
    expect(PROPOSAL_CHARS_MAX).toBe(30_000);
    expect(ok(thread([reply(1, { proposal: proposal({ hunks: adds(16, 2000) }) })]))).toBe(false);
  });
});

describe('proposalStates (critique B4)', () => {
  const p1 = proposal({ base_sha256: H('a'), result_sha256: H('b') });
  const p2 = proposal({ base_sha256: H('a'), result_sha256: H('c') });
  const entries = (...e: unknown[]) => e as CommentEntry[];

  it('⚑ pending, applied (by the file — an apply entry or not), undone (Undo apply: the file is the base again), superseded, stale', () => {
    const one = entries(reply(1, { proposal: p1 }));
    expect(proposalStates(one, H('a'))).toEqual([{ entry: 'r_01JABCDEFGHJKMNPQRSTVWXYZ1', state: 'pending', actionable: true, applied_by: [] }]);
    // Applied without an apply entry (the entry failed to append, or the same bytes were written): the file says it.
    expect(proposalStates(one, H('b'))[0]).toMatchObject({ state: 'applied', actionable: false });
    expect(proposalStates(one, H('d'))[0]).toMatchObject({ state: 'stale', actionable: false });
    expect(proposalStates(one, null)[0]).toMatchObject({ state: 'stale', actionable: false });
    const applied = entries(reply(1, { proposal: p1 }), apply(2, 1));
    expect(proposalStates(applied, H('b'))[0]).toMatchObject({ state: 'applied', actionable: false, applied_by: ['r_01JABCDEFGHJKMNPQRSTVWXYZ2'] });
    // Undo apply: the file is the base again — no stale "applied"; it can be applied again.
    expect(proposalStates(applied, H('a'))[0]).toMatchObject({ state: 'undone', actionable: true });
    // Applied, then the file moved on: stale.
    expect(proposalStates(applied, H('d'))[0]).toMatchObject({ state: 'stale', actionable: false });
  });

  it('only the newest proposal is actionable: an older one is superseded (or applied / undone by the file)', () => {
    const two = entries(reply(1, { proposal: p1 }), reply(3), reply(4, { proposal: p2 }));
    expect(proposalStates(two, H('a')).map((s) => [s.state, s.actionable])).toEqual([
      ['superseded', false],
      ['pending', true],
    ]);
    // The file holds the older one's result but no apply names it: superseded, never "applied" (review B L6)…
    expect(proposalStates(two, H('b')).map((s) => [s.state, s.actionable])).toEqual([
      ['superseded', false],
      ['stale', false],
    ]);
    // …so two proposals with one result, the newer applied: only the newer reads applied.
    const same = entries(reply(1, { proposal: p1 }), reply(4, { proposal: proposal({ base_sha256: H('a'), result_sha256: H('b') }) }), apply(5, 4));
    expect(proposalStates(same, H('b')).map((s) => s.state)).toEqual(['superseded', 'applied']);
    // An apply naming the older one: applied.
    const olderApplied = entries(reply(1, { proposal: p1 }), apply(2, 1), reply(4, { proposal: p2 }));
    expect(proposalStates(olderApplied, H('b')).map((s) => s.state)).toEqual(['applied', 'stale']);
    const undoneOld = entries(reply(1, { proposal: p1 }), apply(2, 1), reply(4, { proposal: p2 }));
    expect(proposalStates(undoneOld, H('a')).map((s) => [s.state, s.actionable])).toEqual([
      ['undone', false],
      ['pending', true],
    ]);
    expect(proposalStates(entries(reply(1)), H('a'))).toEqual([]);
  });
});
