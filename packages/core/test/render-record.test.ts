/**
 * The render record (L7.6b): the tolerant parser — three members decide, every other is read leniently — the two
 * transitions, and the pure rules laid over the entries of renders/: a record of its file, a render of its scenario,
 * what a message may quote, the order, the previous render, the two `latest`, why a file is no render, a renamed
 * record whose video is another render's, what a named use needs.
 */
import { describe, expect, it } from 'vitest';
import {
  completeRender,
  finishedRender,
  latestNamedRender,
  latestProjectRender,
  namedRenderProblem,
  orderRenders,
  parseRenderRecord,
  parseRunRecord,
  previousRender,
  projectRenderOf,
  quotableRender,
  renamedProblem,
  renderAttempt,
  renderLackWords,
  renderNot,
  renderNotWords,
  renderOfFile,
  sameRender,
} from '../src/index.js';
import type { RenderEntry, RenderFields, RenderNot, RenderPolicy, RenderRead, StoredRenderRecord } from '../src/index.js';
import { recordFixture } from './fixtures/records/build.js';
import { RENDER_STATES, renderRecordText } from './fixtures/records/build-renders.js';
import type { RenderFileSpec } from './fixtures/records/build-renders.js';

const VARS = { dir: '/w/projects/p', project: 'p', old: '20261001-100000-quote', new: '20261002-100000-quote' };
/** The value a file of the fixtures' kind holds (`raw`: parsed when it is JSON). */
const value = (spec: RenderFileSpec): unknown => JSON.parse(renderRecordText(spec, VARS) ?? 'null') as unknown;
const at = (m: number): string => `2026-10-02T09:${String(m).padStart(2, '0')}:00.000Z`;
const entry = (spec: RenderFileSpec, o: { link?: boolean } = {}): RenderEntry => ({ name: spec.file, link: o.link ?? false, read: parseRenderRecord(value(spec)) });
const problem = (name: string, p: 'not-a-file' | 'too-big' | 'not-json' | 'unreadable', link = false): RenderEntry => ({ name, link, read: { ok: false, problem: p } });
const good = (n: number, more: Partial<RenderFileSpec> = {}): RenderEntry => entry({ file: `quote-v${n}`, at: at(n), ...more });
const ok = (r: RenderRead): Extract<RenderRead, { ok: true }> => {
  if (!r.ok) throw new Error(`not read: ${r.problem}`);
  return r;
};
const said = (r: RenderRead): string => (r.ok ? `ok${r.lacks.length ? ` lacks ${r.lacks.join(',')}` : ''}${r.notes.length ? ` notes ${r.notes.join(',')}` : ''}` : `${r.problem}${'detail' in r && r.detail ? ` at ${r.detail}` : ''}${r.problem === 'unknown-status' && r.lacks.length ? ` lacks ${r.lacks.join(',')}` : ''}`);

describe('parseRenderRecord: what decides, and nothing else', () => {
  it('every state of render-states.json: a record, what it lacks, or the typed problem', () => {
    const got: Record<string, string> = {};
    for (const [id, state] of Object.entries(RENDER_STATES.states)) {
      const spec = state.files.at(-1) ?? RENDER_STATES.base[0]!;
      if (spec.only) continue;
      let v: unknown;
      try {
        v = value(spec);
      } catch {
        got[id] = '(not JSON: the reader of the folder says so)';
        continue;
      }
      got[id] = said(parseRenderRecord(v));
    }
    expect(got).toEqual({
      ctl: 'ok',
      v2: 'ok',
      'no-created': 'ok lacks created_at',
      'created-5': 'ok lacks created_at notes created_at-dropped',
      'renamed-newest': 'ok',
      'renamed-fixed': 'ok',
      'renamed-old': 'ok',
      'renamed-reused': 'ok',
      copy: 'ok',
      'copy-backup': 'ok',
      'video-gone': 'ok',
      'scenario-other': 'ok',
      'scenario-7': 'ok lacks scenario notes scenario-dropped',
      'no-scenario': 'ok lacks scenario',
      'no-variant': 'ok',
      paused: 'unknown-status',
      failed: 'ok',
      'variant-cube': 'ok',
      'version-2': 'newer-format',
      link: 'ok',
      'out-name': 'ok',
      'no-plan': 'ok lacks plan',
      'cut-short': '(not JSON: the reader of the folder says so)',
      array: 'invalid at (root)',
      null: 'invalid at (root)',
      'no-status': 'invalid at status',
      'no-run-id': 'ok',
      'empty-id': 'ok',
      'file-outside': 'ok',
      'keep-json': 'ok',
      'keep-json-without': 'ok',
      'final-files': 'ok',
    });
  });

  it('a record a version wrote is handed on as the file holds it: the same object, nothing noted — the four past shapes too', () => {
    const v = value({ file: 'quote-v1', at: at(1) });
    const r = ok(parseRenderRecord(v));
    expect([r.value === v, r.notes, r.lacks]).toEqual([true, [], []]);
    for (const f of ['render-l24.json', 'render-l55.json', 'render-l515.json', 'render-l73.json']) {
      const past = recordFixture(`past/${f}`);
      const read = ok(parseRenderRecord(past));
      expect([f, read.value === (past as unknown), read.notes, read.lacks], f).toEqual([f, true, [], []]);
    }
  });

  it('the deciding set is the format version, the status and the id: each refused at its own name, in that order; a newer format first', () => {
    const base = value({ file: 'quote-v1', at: at(1) }) as Record<string, unknown>;
    const without = (k: string) => Object.fromEntries(Object.entries(base).filter(([x]) => x !== k));
    expect(said(parseRenderRecord(without('version')))).toBe('invalid at version');
    expect(said(parseRenderRecord({ ...base, version: '1' }))).toBe('invalid at version');
    expect(said(parseRenderRecord({ ...base, version: 0 }))).toBe('invalid at version');
    expect(said(parseRenderRecord(without('status')))).toBe('invalid at status');
    expect(said(parseRenderRecord({ ...base, status: 3 }))).toBe('invalid at status');
    expect(said(parseRenderRecord(without('id')))).toBe('invalid at id');
    expect(said(parseRenderRecord({ ...base, id: 7 }))).toBe('invalid at id');
    expect(said(parseRenderRecord({ version: 1 }))).toBe('invalid at status');
    // A newer format is said before anything else is looked at, with its sentence and what the object says.
    const newer = parseRenderRecord({ version: 2, id: 'quote-v2', scenario: 'quote', run_id: 'r', created_at: at(2), status: 9 });
    expect(newer).toEqual({ ok: false, problem: 'newer-format', message: 'this render record is version 2: it was made for a newer Retake (this one reads version 1) — update Retake', said: { id: 'quote-v2', scenario: 'quote', run_id: 'r', created_at: at(2) } });
    // What a file that is no record says all the same: texts only.
    expect(parseRenderRecord({ ...without('status'), run_id: 5 })).toMatchObject({ problem: 'invalid', detail: 'status', said: { id: 'quote-v1', scenario: 'quote', created_at: at(1) } });
    expect((parseRenderRecord({ ...without('status'), run_id: 5 }) as { said: object }).said).not.toHaveProperty('run_id');
  });

  it('`created_at`, `scenario` and `plan` decide nothing: the record reads and says what it lacks (decision iii)', () => {
    const base = value({ file: 'quote-v1', at: at(1) }) as Record<string, unknown>;
    for (const [member, bad, empty] of [['created_at', 5, ''], ['scenario', ['x'], ''], ['plan', 5, undefined], ['plan', [1], undefined], ['plan', null, undefined]] as const) {
      const r = ok(parseRenderRecord({ ...base, [member]: bad }));
      expect([member, r.lacks, (r.value as unknown as Record<string, unknown>)[member]], member).toEqual([member, [member], empty]);
      expect(member in r.value, member).toBe(empty !== undefined);
    }
    const bare = ok(parseRenderRecord({ version: 1, id: 'x', status: 'succeeded' }));
    expect(bare.lacks).toEqual(['scenario', 'created_at', 'plan']);
    // Every member every record holds reads as its empty value; nothing else is invented.
    expect(bare.value).toEqual({ version: 1, id: 'x', status: 'succeeded', project: '', scenario: '', run_id: '', run_dir: '', template: '', overrides: {}, file: '', record: '', created_at: '', finished_at: '', duration_s: 0, frames: 0, fps: 0, width: 0, height: 0, size_bytes: 0, warnings: [] });
    expect(bare.notes).toEqual([]);
  });

  it('a variant that is absent stays absent (never an empty value); a word this version does not know is kept as text', () => {
    const base = value({ file: 'quote-v1', at: at(1) }) as Record<string, unknown>;
    const { variant: _v, ...noVariant } = base;
    const r = ok(parseRenderRecord(noVariant));
    expect(['variant' in r.value, r.value.variant, r.lacks, r.notes]).toEqual([false, undefined, [], []]);
    const odd = ok(parseRenderRecord({ ...base, variant: 7 }));
    expect(['variant' in odd.value, odd.notes]).toEqual([false, ['variant-dropped']]);
    const words = ok(parseRenderRecord(value({ file: 'quote-v2', at: at(2), set: { variant: 'cube', 'encoding.audio': 'voice', 'browser.source': 'system', 'policy.gl.used': 'metal', 'edit.from': 'draft' } })));
    expect([words.value.variant, words.value.encoding?.audio, words.value.browser?.source, words.value.policy?.gl.used, words.value.edit?.from, words.notes]).toEqual(['cube', 'voice', 'system', 'metal', 'draft', []]);
  });

  it('a block that does not read is dropped whole and noted; unknown keys are kept at every level', () => {
    const base = value({ file: 'quote-v1', at: at(1) }) as Record<string, unknown>;
    const r = ok(parseRenderRecord({ ...base, policy: 'fast', encoding: { codec: 'h264' }, timings: { plan_ms: 'x' }, probe: 5, later: { a: 1 }, bundle: { hash: 'h', cached: true, ms: 1, more: 2 } }));
    expect(r.notes.sort()).toEqual(['encoding-dropped', 'policy-dropped', 'probe-dropped', 'timings-dropped']);
    expect([r.value.policy, r.value.encoding, r.value.timings, r.value.probe, (r.value as unknown as { later: unknown }).later, r.value.bundle]).toEqual([undefined, undefined, undefined, undefined, { a: 1 }, { hash: 'h', cached: true, ms: 1, more: 2 }]);
  });

  it('what a state never has decides nothing: an error on a succeeded record, a probe on a failed one — dropped, noted; a failed record\'s error reads leniently', () => {
    const base = value({ file: 'quote-v1', at: at(1) }) as Record<string, unknown>;
    const withError = ok(parseRenderRecord({ ...base, error: 'x' }));
    expect([withError.value.status, 'error' in withError.value, withError.notes]).toEqual(['succeeded', false, ['error-dropped']]);
    const failed = ok(parseRenderRecord({ ...base, status: 'failed', probe: { duration_s: 1, width: 1, height: 1, fps: 30, audio_streams: 0 } }));
    expect([failed.value.status, failed.value.error, 'probe' in failed.value, failed.notes]).toEqual(['failed', '', false, ['probe-dropped']]);
    expect(ok(parseRenderRecord({ ...base, status: 'cancelled', error: 'stopped' })).value).toMatchObject({ status: 'cancelled', error: 'stopped' });
  });

  it('a status Retake never writes: said as that, with the record read leniently and what it lacks', () => {
    const base = value({ file: 'quote-v1', at: at(1) }) as Record<string, unknown>;
    const { plan: _p, ...noPlan } = base;
    const r = parseRenderRecord({ ...noPlan, status: 'paused', created_at: 5 });
    if (r.ok || r.problem !== 'unknown-status') throw new Error('expected unknown-status');
    expect([r.record.status, r.record.id, r.record.created_at, r.lacks]).toEqual(['paused', 'quote-v1', '', ['created_at', 'plan']]);
  });

  it('the run record\'s reader still holds its own tables: its scenario decides, where a render record\'s does not', () => {
    // (the shared lenient read takes each parser's tables: a run record without its scenario is no record)
    const run = { version: 1, id: '20261002-100000-quote', project: 'p', mode: 'capture', status: 'succeeded', started_at: 'a', finished_at: 'b', dir: '/d', env: 'local', options: { hooks: 'run', headed: false }, steps_total: 1, steps_done: 1, screenshots: [], hooks: { setup: 'none', teardown: 'none' }, warnings: [] };
    expect(parseRunRecord(run)).toMatchObject({ ok: false, problem: 'invalid', detail: 'scenario' });
    expect(parseRunRecord({ ...run, scenario: 'quote', warnings: 5 })).toMatchObject({ ok: true, notes: ['warnings-dropped'], value: { warnings: [] } });
    expect(parseRunRecord({ ...run, scenario: 'quote', error: 'x' })).toMatchObject({ ok: false, problem: 'invalid', detail: 'error' });
  });
});

describe('the two transitions', () => {
  const fields = (): RenderFields<{ a: 1 }, { theme?: string }> => {
    const { status: _s, policy: _p, plan: _plan, ...rest } = value({ file: 'quote-v1', at: at(1) }) as Record<string, unknown>;
    return { ...rest, plan: { a: 1 } } as unknown as RenderFields<{ a: 1 }, { theme?: string }>;
  };
  const policy = (value({ file: 'quote-v1', at: at(1) }) as { policy: NonNullable<StoredRenderRecord['policy']> }).policy as never;

  it('a finished render: its status after `variant`, then — after the plan — its policy and its probe; no error', () => {
    const probe = { duration_s: 1, width: 1, height: 1, fps: 30, audio_streams: 0 };
    const r = finishedRender(fields(), { policy, probe });
    const keys = Object.keys(r);
    expect(keys.slice(keys.indexOf('variant'), keys.indexOf('variant') + 3)).toEqual(['variant', 'status', 'file']);
    expect(keys.slice(-3)).toEqual(['plan', 'policy', 'probe']);
    expect([r.status, 'error' in r]).toEqual(['succeeded', false]);
    expect(Object.keys(finishedRender(fields())).slice(-1)).toEqual(['plan']);
    // What it makes is what the reader takes whole.
    expect(ok(parseRenderRecord(JSON.parse(JSON.stringify(r)))).notes).toEqual([]);
  });

  it('an attempt: its status after `variant`, then — after the plan — its error and the policy it tried; never a probe', () => {
    const r = renderAttempt(fields(), { status: 'cancelled', error: 'stopped', policy });
    const keys = Object.keys(r);
    expect(keys.slice(keys.indexOf('variant'), keys.indexOf('variant') + 2)).toEqual(['variant', 'status']);
    expect(keys.slice(-3)).toEqual(['plan', 'error', 'policy']);
    expect([r.status, r.error, 'probe' in r]).toEqual(['cancelled', 'stopped', false]);
    expect(Object.keys(renderAttempt(fields(), { status: 'failed', error: 'x' })).slice(-2)).toEqual(['plan', 'error']);
  });

  it('a state is never made from another state: an attempt handed to `finishedRender` (or a finished render to `renderAttempt`) does not compile, and throws an internal error — never a "finished" record that failed (L7.6b fix pass)', () => {
    const failed = renderAttempt(fields(), { status: 'failed', error: 'boom' });
    const finished = finishedRender(fields());
    const withPolicy = { ...fields(), policy: (value({ file: 'quote-v1', at: at(1) }) as { policy: RenderPolicy }).policy };
    const made = [
      // @ts-expect-error — wrong on purpose: an attempt (its status, its error) is no render's fields
      () => finishedRender(failed),
      // @ts-expect-error — wrong on purpose: a finished render (its status) is no render's fields
      () => renderAttempt(finished, { status: 'cancelled', error: 'x' }),
      // @ts-expect-error — wrong on purpose: a policy is what the end adds, never a field
      () => finishedRender(withPolicy),
    ];
    for (const make of made) expect(make).toThrow(/^internal: a render record is made from its fields only, and these hold "status"|^internal: a render record is made from its fields only, and these hold "policy"/);
    expect(() => finishedRender(failed as never)).toThrow('internal: a render record is made from its fields only, and these hold "status", "error"');
  });
});

describe('the rules over the entries of renders/', () => {
  it('a record of its file (D-10), a complete record, a render of its scenario', () => {
    const table: Array<[string, RenderEntry, [ofFile: boolean, complete: boolean, project: boolean]]> = [
      ['a render', good(2), [true, true, true]],
      ['renamed', entry({ file: 'quote-final', id: 'quote-v2', at: at(2) }), [false, true, false]],
      ['a copy', entry({ file: 'quote-v2 copy', id: 'quote-v2', at: at(2) }), [false, true, false]],
      ['--out', entry({ file: 'quote-final', at: at(2) }), [true, true, false]],
      ['another scenario inside', good(2, { set: { scenario: 'other' } }), [true, true, false]],
      ['no scenario', good(2, { unset: ['scenario'] }), [true, false, false]],
      ['no creation time', good(2, { unset: ['created_at'] }), [true, false, false]],
      ['no plan', good(2, { unset: ['plan'] }), [true, false, false]],
      ['failed', good(2, { set: { status: 'failed', error: 'x' } }), [true, true, true]],
      ['unknown status', good(2, { set: { status: 'paused' } }), [false, false, false]],
      ['newer', good(2, { set: { version: 2 } }), [false, false, false]],
      ['a link', problem('quote-v2', 'not-a-file', true), [false, false, false]],
    ];
    for (const [name, e, want] of table) expect([name, renderOfFile(e) !== null, completeRender(e) !== null, projectRenderOf(e) !== null], name).toEqual([name, ...want]);
    expect(projectRenderOf(good(2))?.id).toBe('quote-v2');
    expect(projectRenderOf(entry({ file: 'other-v3-vertical', at: at(3), set: { scenario: 'other', variant: 'vertical' } }))?.id).toBe('other-v3-vertical');
  });

  it('what a message may quote: a render of its scenario with a slug scenario, an ISO creation time and a variant the tool writes', () => {
    const q = (e: RenderEntry) => {
      const r = projectRenderOf(e);
      return r ? quotableRender(r) : 'no render';
    };
    expect(q(good(2))).toBe(true);
    expect(q(good(2, { set: { variant: 'cube' } }))).toBe(false);
    expect(q(good(2, { unset: ['variant'] }))).toBe(false);
    expect(q(good(2, { at: 'yesterday' }))).toBe(false);
    expect(q(good(2, { set: { scenario: 'other' } }))).toBe('no render');
    expect(q(entry({ file: 'quote-final', id: 'quote-v2', at: at(2) }))).toBe('no render');
  });

  it('the order of renders: creation time, then id, both as text; no creation time is the oldest', () => {
    const list = [{ id: 'quote-v9', created_at: at(5) }, { id: 'quote-v10', created_at: at(5) }, { id: 'quote-v2', created_at: at(9) }, { id: 'quote-v3', created_at: '' }, { id: 'quote-v1', created_at: at(1) }];
    expect(orderRenders(list).map((r) => r.id)).toEqual(['quote-v3', 'quote-v1', 'quote-v10', 'quote-v9', 'quote-v2']);
    expect(list[0]!.id).toBe('quote-v9');
  });

  it('the previous render: succeeded, same scenario and variant, another video, earlier by creation time then by version, its video there — the last of the order', () => {
    const rec = (n: number, m: number, more: Partial<RenderFileSpec> = {}) => ok(entry({ file: `quote-v${n}`, at: at(m), ...more }).read).value;
    const all = [rec(1, 1), rec(2, 2), rec(3, 3, { set: { status: 'failed', error: 'x' } }), rec(4, 4, { set: { variant: 'vertical' } }), rec(5, 5, { set: { scenario: 'other' } }), rec(6, 6), rec(9, 10), rec(10, 10), rec(11, 10)];
    const prev = (n: number, exists: (f: string) => boolean = () => true) => previousRender(all, all.find((r) => r.id === `quote-v${n}`)!, exists)?.id ?? 'none';
    expect([prev(1), prev(2), prev(6), prev(4)]).toEqual(['none', 'quote-v1', 'quote-v2', 'none']);
    expect(prev(6, (f) => !f.endsWith('quote-v2.mp4'))).toBe('quote-v1');
    // One creation time: a lower version is "before"; among several, the last by id AS TEXT (v9 after v10): v11's previous is v9.
    expect([prev(11), prev(10), prev(9)]).toEqual(['quote-v9', 'quote-v9', 'quote-v6']);
    // A render named without its creation time has none (never a throw).
    expect(previousRender(all, { ...rec(6, 6), created_at: '' }, () => true)).toBeUndefined();
  });

  it('why an entry is no succeeded render of its scenario: a closed list with fixed words', () => {
    const table: Array<[RenderEntry, RenderNot | null]> = [
      [good(2), null],
      [problem('quote-v2', 'not-a-file', true), 'linked'],
      [problem('quote-v2', 'not-a-file'), 'unreadable'],
      [problem('quote-v2', 'too-big'), 'too-big'],
      [problem('quote-v2', 'not-json'), 'unreadable'],
      [good(2, { unset: ['status'] }), 'unreadable'],
      [good(2, { set: { version: 2 } }), 'newer-format'],
      [good(2, { set: { status: 'paused' } }), 'unknown-status'],
      [entry({ file: 'quote-final', id: 'quote-v2', at: at(2) }), 'renamed'],
      [good(2, { unset: ['plan'] }), 'incomplete'],
      [good(2, { set: { scenario: 'other' } }), 'another-scenario'],
      [entry({ file: 'quote-final', at: at(2) }), 'other-name'],
      [good(2, { set: { status: 'failed', error: 'x' } }), 'not-succeeded'],
    ];
    expect(table.map(([e]) => renderNot(e))).toEqual(table.map(([, w]) => w));
    expect(renderNot(entry({ file: 'other-v1', at: at(1), set: { scenario: 'other' } }), { scenario: 'quote' })).toBe('another-scenario');
    expect(renderNot(entry({ file: 'other-v1', at: at(1), set: { scenario: 'other' } }))).toBeNull();
    expect((['linked', 'too-big', 'unreadable', 'newer-format', 'unknown-status', 'renamed', 'incomplete', 'another-scenario', 'other-name', 'not-succeeded'] as const).map(renderNotWords)).toEqual([
      'its record is a link',
      'its record is too big to read',
      'its record does not read',
      'written by a newer Retake',
      'its status is not one Retake writes',
      'its record says another id',
      'its record lacks its scenario, its creation time or its plan',
      'its record says another scenario',
      'its name is not a render id of its scenario',
      'failed or cancelled',
    ]);
    expect((['scenario', 'created_at', 'plan'] as const).map(renderLackWords)).toEqual(['no scenario', 'no creation time', 'no plan']);
  });
});

describe('the two `latest` (D-11: two rules, on purpose)', () => {
  const project = (entries: RenderEntry[], o: Parameters<typeof latestProjectRender>[1] = { status: 'succeeded', scenario: 'quote' }) => {
    const r = latestProjectRender(entries, o);
    return { pick: r.pick?.id ?? '-', passed: r.passed.map((p) => `${p.file}: ${p.why}`), more: r.passed_more, not_considered: r.not_considered };
  };
  const named = (entries: RenderEntry[], scenario: string | null = 'quote') => {
    const r = latestNamedRender(entries, scenario !== null ? { scenario } : {});
    return { pick: r.pick ? `${r.pick.entry.name}.json${r.pick.renamed ? ` (says ${r.pick.record.id || 'an empty id'})` : ''}` : '-', passed: r.passed.map((p) => `${p.file}: ${p.why}`), not_considered: r.not_considered };
  };

  it('held apart by the `--out` state: a terminal takes quote-final, the engine quote-v1 and says the file it passed over', () => {
    const entries = [good(1), entry({ file: 'quote-final', at: at(2) })];
    expect(named(entries).pick).toBe('quote-final.json');
    expect(project(entries)).toEqual({ pick: 'quote-v1', passed: ['quote-final.json: other-name'], more: 0, not_considered: 0 });
  });

  it('the engine\'s: a render of its scenario only — a renamed, linked, incomplete, newer, unknown or failed newer file is passed over and said', () => {
    const newer: Array<[RenderEntry, string]> = [
      [entry({ file: 'quote-final', id: 'quote-v2', at: at(2) }), 'quote-final.json: renamed'],
      [problem('quote-v2', 'not-a-file', true), 'quote-v2.json: linked'],
      [problem('quote-v2', 'too-big'), 'quote-v2.json: too-big'],
      [good(2, { unset: ['created_at'] }), 'quote-v2.json: incomplete'],
      [good(2, { unset: ['plan'] }), 'quote-v2.json: incomplete'],
      [good(2, { set: { version: 2 } }), 'quote-v2.json: newer-format'],
      [good(2, { set: { status: 'paused' } }), 'quote-v2.json: unknown-status'],
      [good(2, { set: { status: 'failed', error: 'x' } }), 'quote-v2.json: not-succeeded'],
      [good(2, { unset: ['status'] }), 'quote-v2.json: unreadable'],
      [good(2, { set: { scenario: 7 } }), 'quote-v2.json: incomplete'],
    ];
    for (const [e, line] of newer) expect(project([good(1), e]), line).toEqual({ pick: 'quote-v1', passed: [line], more: 0, not_considered: 0 });
    // A file that says nothing and whose name is no render id: counted, never named.
    expect(project([good(1), problem('notes', 'not-json'), problem('x', 'not-a-file', true)])).toEqual({ pick: 'quote-v1', passed: [], more: 0, not_considered: 2 });
    // Older than the pick, or of another scenario: not "passed over".
    expect(project([good(3), good(2, { set: { status: 'failed', error: 'x' } }), entry({ file: 'other-v9', at: at(9), set: { scenario: 'other' } }), good(4, { set: { scenario: 'other' } })]).passed).toEqual([]);
    // Nothing to take: everything of the scenario is said.
    expect(project([good(2, { set: { status: 'failed', error: 'x' } })])).toEqual({ pick: '-', passed: ['quote-v2.json: not-succeeded'], more: 0, not_considered: 0 });
  });

  it('the engine\'s options: without a scenario, of a variant, of any status (a status Retake never writes included: a status question), quotable', () => {
    const vertical = entry({ file: 'quote-v3-vertical', at: at(3), set: { variant: 'vertical' } });
    const other = entry({ file: 'other-v4', at: at(4), set: { scenario: 'other' } });
    const failed = good(5, { set: { status: 'failed', error: 'x' } });
    const paused = good(6, { set: { status: 'paused' } });
    const cube = good(7, { set: { variant: 'cube' } });
    const all = [good(1), vertical, other, failed, paused, cube];
    expect(project(all, { status: 'succeeded' }).pick).toBe('quote-v7');
    expect(project(all, { status: 'succeeded', scenario: 'quote', variant: 'vertical' }).pick).toBe('quote-v3-vertical');
    expect(project(all, { status: 'succeeded', scenario: 'quote', variant: 'landscape' }).pick).toBe('quote-v1');
    expect(project(all, { status: 'succeeded', scenario: 'quote', quotable: true }).pick).toBe('quote-v3-vertical');
    expect(project(all, { status: 'succeeded', scenario: 'other' }).pick).toBe('other-v4');
    // Any status: the newest record of the scenario, whatever it says of itself.
    expect(project(all, { status: 'any', scenario: 'quote' })).toEqual({ pick: 'quote-v7', passed: [], more: 0, not_considered: 0 });
    const any = latestProjectRender([good(1), failed, paused], { status: 'any', scenario: 'quote' });
    expect(any.pick && 'unknown' in any.pick ? [any.pick.id, any.pick.unknown.status] : any.pick?.id).toEqual(['quote-v6', 'paused']);
    expect(project([good(1), failed], { status: 'any', scenario: 'quote' }).pick).toBe('quote-v5');
    // … but never a file that is no record, a renamed one or an incomplete one.
    expect(project([good(1), good(2, { unset: ['status'] }), good(3, { set: { status: 'paused' }, unset: ['plan'] })], { status: 'any', scenario: 'quote' })).toEqual({ pick: 'quote-v1', passed: ['quote-v3.json: unknown-status', 'quote-v2.json: unreadable'], more: 0, not_considered: 0 });
  });

  it('more than five passed over: five are named, newest first (those that say no creation time first), the rest counted, every one in the reasons', () => {
    const entries = [good(1), ...[2, 3, 4, 5, 6, 7].map((n) => good(n, { set: { status: 'failed', error: 'x' } })), problem('quote-v8', 'not-a-file', true)];
    const r = latestProjectRender(entries, { status: 'succeeded', scenario: 'quote' });
    expect([r.passed.map((p) => p.file), r.passed_more, r.reasons]).toEqual([['quote-v8.json', 'quote-v7.json', 'quote-v6.json', 'quote-v5.json', 'quote-v4.json'], 2, [{ why: 'linked', count: 1 }, { why: 'not-succeeded', count: 6 }]]);
  });

  it('a terminal\'s: the newest succeeded complete record whatever its file is called and whatever id it says — the command acts on the file', () => {
    // The lead's ruling: a renamed newest record is picked (by its file), not passed over; so is one with an empty id.
    expect(named([good(1), entry({ file: 'quote-final', id: 'quote-v2', at: at(2) })])).toEqual({ pick: 'quote-final.json (says quote-v2)', passed: [], not_considered: 0 });
    expect(named([good(1), entry({ file: 'x', id: '', at: at(2) })]).pick).toBe('x.json (says an empty id)');
    // A copy made at the same time as its original: the record of its own file wins.
    expect(named([entry({ file: 'quote-v1 copy', id: 'quote-v1', at: at(1) }), good(1)]).pick).toBe('quote-v1.json');
    expect(named([good(1), entry({ file: 'quote-v1 copy', id: 'quote-v1', at: at(1) })]).pick).toBe('quote-v1.json');
    // Never a record that did not succeed, of an unknown status, incomplete, of a newer format, or a file that is none: said.
    expect(named([good(1), good(2, { set: { status: 'paused' } })])).toEqual({ pick: 'quote-v1.json', passed: ['quote-v2.json: unknown-status'], not_considered: 0 });
    expect(named([good(1), good(2, { set: { status: 'failed', error: 'x' } })]).passed).toEqual(['quote-v2.json: not-succeeded']);
    expect(named([good(1), good(2, { unset: ['created_at'] })]).passed).toEqual(['quote-v2.json: incomplete']);
    expect(named([good(1), good(2, { set: { version: 2 } })]).passed).toEqual(['quote-v2.json: newer-format']);
    expect(named([good(1), good(2, { unset: ['status'] }), problem('notes', 'not-json')])).toEqual({ pick: 'quote-v1.json', passed: ['quote-v2.json: unreadable'], not_considered: 1 });
    // Of the scenario asked, by what the record says; without one: any.
    expect(named([good(1), good(2, { set: { scenario: 'other' } })]).pick).toBe('quote-v1.json');
    expect(named([good(1), good(2, { set: { scenario: 'other' } })], null).pick).toBe('quote-v2.json');
    expect(named([]).pick).toBe('-');
  });
});

describe('a render\'s identity (sameRender, L7.6c)', () => {
  it('its id and its creation time: the same id made at another time is another render; a record without its creation time is none a caller read', () => {
    const now = { id: 'quote-v2', created_at: '2026-10-02T09:02:00.000Z' };
    expect(sameRender(now, { id: 'quote-v2', created_at: '2026-10-02T09:02:00.000Z' })).toBe(true);
    expect(sameRender(now, { id: 'quote-v2', created_at: '2026-10-02T09:03:00.000Z' })).toBe(false);
    expect(sameRender(now, { id: 'quote-v3', created_at: '2026-10-02T09:02:00.000Z' })).toBe(false);
    // Compared as the texts the files hold (no date parsing: another spelling of the same instant is another text).
    expect(sameRender(now, { id: 'quote-v2', created_at: '2026-10-02T09:02:00Z' })).toBe(false);
    expect(sameRender({ id: 'quote-v2', created_at: '' }, { id: 'quote-v2', created_at: '' })).toBe(false);
  });
});

describe('a render someone named', () => {
  it('decision iv: a renamed record is refused only when the video it names is now another render\'s', () => {
    const renamed = entry({ file: 'quote-final', id: 'quote-v1', at: at(0) });
    const newV1 = good(1);
    expect(renamedProblem(renamed, newV1)).toEqual({ why: 'video-of-another-render', id: 'quote-v1', other: 'quote-v1' });
    // A copy beside its original (the same creation time); a record whose `file` was corrected (beside it: itself); a video with no record beside; a record of its own file.
    expect(renamedProblem(entry({ file: 'quote-v1 copy', id: 'quote-v1', at: at(1) }), newV1)).toBeNull();
    expect(renamedProblem(renamed, renamed)).toBeNull();
    expect(renamedProblem(renamed, entry({ file: 'quote-final', id: 'quote-v1', at: at(5) }))).toBeNull();
    expect(renamedProblem(renamed, null)).toBeNull();
    expect(renamedProblem(newV1, good(2))).toBeNull();
    // Beside the video: a file that is no record of its own file (another renamed record, a broken file) owns nothing.
    expect(renamedProblem(renamed, entry({ file: 'quote-v1', id: 'quote-v7', at: at(3) }))).toBeNull();
    expect(renamedProblem(renamed, problem('quote-v1', 'not-json'))).toBeNull();
  });

  it('decision iii: a named render works with what it has; a use that needs a member the record lacks says which', () => {
    const noPlan = good(2, { unset: ['plan', 'created_at'] });
    expect(namedRenderProblem(noPlan, [])).toBeNull();
    expect(namedRenderProblem(noPlan, ['scenario'])).toBeNull();
    expect(namedRenderProblem(noPlan, ['plan'])).toEqual({ why: 'lacks', member: 'plan' });
    expect(namedRenderProblem(noPlan, ['scenario', 'created_at', 'plan'])).toEqual({ why: 'lacks', member: 'created_at' });
    expect(namedRenderProblem(good(2), ['scenario', 'created_at', 'plan'])).toBeNull();
    expect(namedRenderProblem(good(2, { set: { status: 'paused' }, unset: ['plan'] }), ['plan'])).toEqual({ why: 'lacks', member: 'plan' });
  });
});
