/**
 * The plan signatures of render records, held per engine (renders.ts memoPlanSignature, the engine's RenderMemos): a
 * record never changes once written, but two projects can hold records of one id and times — each keeps its own plan's
 * signature; and one engine's memo is not another's.
 */
import { describe, expect, it } from 'vitest';
import type { StoredRenderRecord } from '@retake/core/render';
import { RenderMemos, memoPlanSignature } from '../src/renders.js';
import { planSignature } from '../src/index.js';

const record = (project: string, plan: object): StoredRenderRecord =>
  ({
    id: 'quote-v1',
    project,
    file: `/work/projects/${project}/renders/quote-v1.mp4`,
    created_at: '2026-11-15T10:00:00.000Z',
    finished_at: '2026-11-15T10:01:00.000Z',
    plan,
  }) as unknown as StoredRenderRecord;

describe('memoPlanSignature', () => {
  it("two projects' records of one id and times keep each its own plan's signature", () => {
    const a = record('alpha', { segments: [1] });
    const b = record('beta', { segments: [2] });
    const memos = new RenderMemos();
    expect(memoPlanSignature(memos, a)).toBe(planSignature(a.plan));
    expect(memoPlanSignature(memos, b)).toBe(planSignature(b.plan));
    expect(memoPlanSignature(memos, a)).not.toBe(memoPlanSignature(memos, b));
  });

  it("is one engine's memo: another engine's memos hold none of its signatures", () => {
    const a = record('alpha', { segments: [1] });
    const mine = new RenderMemos();
    const theirs = new RenderMemos();
    memoPlanSignature(mine, a);
    expect(mine.planSigs.size).toBe(1);
    expect(theirs.planSigs.size).toBe(0);
    // A signature held by one is never served to the other (the key is the same record's).
    mine.planSigs.set([...mine.planSigs.keys()][0]!, 'held');
    expect(memoPlanSignature(mine, a)).toBe('held');
    expect(memoPlanSignature(theirs, a)).toBe(planSignature(a.plan));
  });
});
