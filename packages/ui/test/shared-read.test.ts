/**
 * The Studio's reads (api.ts sharedRead, behind useCall): identical reads in flight share one request; a caller that
 * leaves gets `cancelled` while the others keep the answer; the request is aborted once every caller has left; a
 * settled read is forgotten (the next one asks again).
 */
import { describe, expect, it } from 'vitest';
import { CallError, sharedRead } from '../src/app/api.js';

/** A request under test: how many were started, their signals, and how to answer the last one. */
function requests() {
  const started: AbortSignal[] = [];
  const answers: Array<(v: unknown) => void> = [];
  const start = (signal: AbortSignal) => {
    started.push(signal);
    return new Promise<unknown>((resolve) => answers.push(resolve));
  };
  return { started, answers, start };
}

const code = (e: unknown) => (e instanceof CallError ? e.error.code : String(e));

describe('sharedRead', () => {
  it('two identical reads in flight share one request and both get its answer; another key makes its own', async () => {
    const r = requests();
    const a = sharedRead('k1', r.start, new AbortController().signal);
    const b = sharedRead('k1', r.start, new AbortController().signal);
    const c = sharedRead('k2', r.start, new AbortController().signal);
    expect(r.started.length).toBe(2);
    r.answers[0]!('one');
    r.answers[1]!('two');
    expect(await Promise.all([a, b, c])).toEqual(['one', 'one', 'two']);
    // Settled: forgotten, the next read asks again.
    void sharedRead('k1', r.start, new AbortController().signal);
    expect(r.started.length).toBe(3);
    r.answers[2]!('three');
  });

  it('a fresh read (a reload after a write) makes its own request; a later read joins the fresh one', async () => {
    const r = requests();
    const a = sharedRead('k1', r.start, new AbortController().signal);
    const b = sharedRead('k1', r.start, new AbortController().signal, true);
    const c = sharedRead('k1', r.start, new AbortController().signal);
    expect(r.started.length).toBe(2);
    r.answers[0]!('old');
    r.answers[1]!('new');
    expect(await Promise.all([a, b, c])).toEqual(['old', 'new', 'new']);
  });

  it('a caller that leaves gets cancelled, the request goes on for the others; aborted once the last one leaves', async () => {
    const r = requests();
    const ca = new AbortController();
    const cb = new AbortController();
    const a = sharedRead('k3', r.start, ca.signal);
    const b = sharedRead('k3', r.start, cb.signal);
    ca.abort();
    expect(code(await a.catch((e: unknown) => e))).toBe('cancelled');
    expect(r.started[0]!.aborted).toBe(false);
    r.answers[0]!('kept');
    expect(await b).toBe('kept');

    const cc = new AbortController();
    const cd = new AbortController();
    const c = sharedRead('k4', r.start, cc.signal);
    const d = sharedRead('k4', r.start, cd.signal);
    cc.abort();
    cd.abort();
    expect([code(await c.catch((e: unknown) => e)), code(await d.catch((e: unknown) => e))]).toEqual(['cancelled', 'cancelled']);
    expect(r.started[1]!.aborted).toBe(true);
    // The aborted request is forgotten at once: a new read starts its own.
    void sharedRead('k4', r.start, new AbortController().signal);
    expect(r.started.length).toBe(3);
    r.answers[2]!(null);
  });

  it('a caller already aborted starts nothing; an error reaches every caller', async () => {
    const r = requests();
    const gone = new AbortController();
    gone.abort();
    expect(code(await sharedRead('k5', r.start, gone.signal).catch((e: unknown) => e))).toBe('cancelled');
    expect(r.started.length).toBe(0);
    const failing = (_s: AbortSignal) => Promise.reject(new CallError(500, { code: 'internal', message: 'no' }));
    const a = sharedRead('k6', failing, new AbortController().signal);
    const b = sharedRead('k6', failing, new AbortController().signal);
    expect([code(await a.catch((e: unknown) => e)), code(await b.catch((e: unknown) => e))]).toEqual(['internal', 'internal']);
  });
});
