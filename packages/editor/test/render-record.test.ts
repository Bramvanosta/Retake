/**
 * The one place a plan read from a disk becomes an edit plan (L7.6b): `withPlan`. It asks what was always asked — the
 * record has a plan, and it is an object — and nothing of the plan's inside.
 */
import { describe, expect, it } from 'vitest';
import { parseRenderRecord } from '@retake/core';
import type { StoredRenderRecord } from '@retake/core';
import { withPlan } from '@retake/editor/plan';
import type { FinishedRender, RenderAttempt, RenderRecord, StoredRender } from '@retake/editor/plan';
import { renderRecordText } from '../../core/test/fixtures/records/build-renders.js';

const VARS = { dir: '/w/projects/p', project: 'p', old: 'OLD', new: 'NEW' };
const stored = (more: object = {}): StoredRenderRecord => {
  const r = parseRenderRecord(JSON.parse(renderRecordText({ file: 'quote-v1', at: '2026-10-02T09:01:00.000Z', ...more }, VARS)!));
  if (!r.ok) throw new Error(r.problem);
  return r.value;
};

describe('withPlan', () => {
  it('a record with its plan: the same object, its plan typed as an edit plan', () => {
    const r = stored();
    const p = withPlan(r);
    if (!p.ok) throw new Error('expected a plan');
    expect(p.value).toBe(r);
    const render: StoredRender = p.value;
    expect([render.plan.fps, render.plan.durationInFrames, render.id]).toEqual([30, 30, 'quote-v1']);
  });

  it('a record without a plan, or whose plan is no object, is refused naming the member — never taken with a plan that is not there', () => {
    expect(withPlan(stored({ unset: ['plan'] }))).toEqual({ ok: false, detail: 'plan' });
    expect(withPlan(stored({ set: { plan: 5 } }))).toEqual({ ok: false, detail: 'plan' });
    // Whatever handed the value: a list or null under `plan` is no plan either.
    for (const plan of [[1], null, 'x']) expect(withPlan({ ...stored(), plan } as unknown as StoredRenderRecord)).toEqual({ ok: false, detail: 'plan' });
  });

  it('the names of the states: the flat record is still a finished render\'s members, and a stored render compares with one (the seam of the review)', () => {
    const written = stored() as unknown as RenderRecord;
    const finished: Pick<FinishedRender, 'id' | 'status'> = { id: written.id, status: 'succeeded' };
    const attempt: Pick<RenderAttempt, 'status' | 'error'> = { status: 'failed', error: 'x' };
    const current: Pick<StoredRender, 'id' | 'file' | 'scenario' | 'variant' | 'created_at' | 'render_version'> = written;
    expect([finished.status, attempt.error, current.id]).toEqual(['succeeded', 'x', 'quote-v1']);
  });
});
