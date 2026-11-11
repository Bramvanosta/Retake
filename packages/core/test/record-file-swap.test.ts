/**
 * The reader of a listing judges the file it OPENED, never a name it looked at before (L7.6b): core/io record-file.ts
 * reads a record of a listing with readPlainFile — opened without following a link, checked on the descriptor. Here
 * every `lstat` / `stat` of the file swaps it for a link to another file right after it answered: a reader that looks
 * at the name first and reads the name next (`lstat` then a read by path) reads the other file; the reader of the lot
 * never asks, so it reads the file that was there. Deterministic and quick (the pipe of render-folder.test.ts only
 * shows such a reader by hanging on its open).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const swap = vi.hoisted(() => ({ target: '', outside: '', done: false, asked: 0 }));

/** After the real call answered about `p`: the file becomes a link to the outside file (once). */
async function swapped(p: unknown): Promise<void> {
  if (String(p) !== swap.target || swap.done) return;
  swap.asked++;
  swap.done = true;
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  fs.rmSync(swap.target);
  fs.symlinkSync(swap.outside, swap.target);
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    const r = await f(...a);
    await swapped(a[0]);
    return r;
  };
  return { ...real, lstat: wrap(real.lstat), stat: wrap(real.stat) };
});
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const wrap = <A extends unknown[], R>(f: (...a: A) => R) => (...a: A): R => {
    const r = f(...a);
    if (String(a[0]) === swap.target && !swap.done) {
      swap.asked++;
      swap.done = true;
      real.rmSync(swap.target);
      real.symlinkSync(swap.outside, swap.target);
    }
    return r;
  };
  return { ...real, lstatSync: wrap(real.lstatSync), statSync: wrap(real.statSync) };
});

const { NODE_RECORD_FS } = await import('../src/io/record-file.js');
const { readRendersFolder } = await import('../src/io/render-folder.js');
const { renderRecordText } = await import('./fixtures/records/build-renders.js');

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'retake-record-file-swap-'));
  mkdirSync(join(root, 'renders'));
  swap.outside = join(root, 'outside.json');
  writeFileSync(swap.outside, '{"said": "the other file"}');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a record of a listing is judged on the file opened', () => {
  it('the file that was there is read, or refused — never the file a name pointed to after it was looked at', async () => {
    swap.target = join(root, 'renders', 'quote-v1.json');
    swap.done = false;
    writeFileSync(swap.target, '{"said": "the file of the folder"}');
    const r = await NODE_RECORD_FS.text(swap.target, { max: 1024, follow: false });
    expect(r).toEqual({ ok: true, text: '{"said": "the file of the folder"}', link: false });
    // The reader asked nothing of the name before it opened it.
    expect(swap.asked).toBe(0);
  });

  it('the same through a listing of renders/', async () => {
    swap.target = join(root, 'renders', 'quote-v2.json');
    swap.done = false;
    writeFileSync(swap.target, '[]');
    // The file a swapped name would point to is a record that reads (of another id): a reader that looked at the name
    // and then read it would answer that record, not the folder's file — the entry itself tells them apart, not only
    // the counter (L7.6b fix pass).
    writeFileSync(swap.outside, renderRecordText({ file: 'quote-v9', at: '2026-10-02T09:09:00.000Z' }, { dir: root, project: 'p', old: 'OLD', new: 'NEW' })!);
    const entries = await readRendersFolder(join(root, 'renders'), { only: (n) => n === 'quote-v2' });
    expect(entries.map((e) => [e.name, e.link, e.read.ok ? `record ${e.read.value.id}` : e.read.problem])).toEqual([['quote-v2', false, 'invalid']]);
    expect(swap.asked).toBe(0);
  });
});
