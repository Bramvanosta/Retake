/**
 * The plan signatures of render records, held for the process (renders.ts memoPlanSignature): a record never changes
 * once written, but two projects can hold records of one id and times — each keeps its own plan's signature.
 */
import { describe, expect, it } from 'vitest';
import type { StoredRenderRecord } from '@retake/core/render';
import { memoPlanSignature } from '../src/renders.js';
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
    expect(memoPlanSignature(a)).toBe(planSignature(a.plan));
    expect(memoPlanSignature(b)).toBe(planSignature(b.plan));
    expect(memoPlanSignature(a)).not.toBe(memoPlanSignature(b));
  });
});
