/**
 * L5.14 (captures first, BL-116): every job kind has a class — captures (a take, what prepares one, a sign-in, a
 * recording, an inspection) and heavy jobs (renders and what re-renders, reviews, previews, site extractions) — and only
 * a capture take films (what holds heavy work).
 */
import { describe, expect, it } from 'vitest';
import { JOB_CLASS, JOB_KINDS, isFilming, jobClass } from '@retake/engine';

describe('job classes (L5.14)', () => {
  it('every kind has a class: the captures and the heavy jobs of BL-116, nothing else', () => {
    expect(Object.keys(JOB_CLASS).sort()).toEqual([...JOB_KINDS].sort());
    const of = (c: string) => JOB_KINDS.filter((k) => JOB_CLASS[k] === c).sort();
    expect(of('capture')).toEqual(['auth_login', 'env_reset', 'hooks', 'inspect', 'record', 'run', 'sandbox_reset', 'sandbox_up']);
    expect(of('heavy')).toEqual(['export', 'preview', 'render', 'review', 'site']);
  });

  it('an unknown kind (a newer client) is a capture, so the worker refuses it in its own process as before', () => {
    expect(jobClass('teleport')).toBe('capture');
    expect(jobClass(undefined)).toBe('capture');
    expect(jobClass('toString')).toBe('capture');
    expect(jobClass('render')).toBe('heavy');
  });

  it('only a capture take films: dry runs, recordings, sign-ins, inspections and hooks do not', () => {
    expect(isFilming({ kind: 'run', mode: 'capture' })).toBe(true);
    expect(isFilming({ kind: 'run', mode: 'dry' })).toBe(false);
    for (const kind of ['record', 'auth_login', 'inspect', 'hooks', 'env_reset', 'sandbox_up', 'render']) expect(isFilming({ kind, mode: 'capture' })).toBe(false);
    expect(isFilming(null)).toBe(false);
  });
});
