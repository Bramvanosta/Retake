/**
 * L4.2 part 1 (BL-79 residue): core readPlainFile, the one reader of files a person or an agent may have replaced —
 * scenarios and README.md through the engine, run snapshots. A FIFO never holds the reader, a link is never followed,
 * a folder or a device is not a file, a file over the cap is refused (also one that grows while read).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readPlainFile } from '@retake/core/io';

const dir = mkdtempSync(join(tmpdir(), 'ds-plain-file-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readPlainFile', () => {
  it('reads a regular file whole, up to and at the cap', () => {
    writeFileSync(join(dir, 'a.yaml'), 'video: a\n');
    const r = readPlainFile(join(dir, 'a.yaml'), 9);
    expect(r.ok && r.bytes.toString()).toBe('video: a\n');
    writeFileSync(join(dir, 'empty'), '');
    const e = readPlainFile(join(dir, 'empty'), 9);
    expect(e.ok && e.bytes.length).toBe(0);
  });

  it('refuses a file over the cap (too_large, with its size)', () => {
    writeFileSync(join(dir, 'big'), 'x'.repeat(10));
    expect(readPlainFile(join(dir, 'big'), 9)).toEqual({ ok: false, reason: 'too_large', size: 10 });
  });

  it('a FIFO with no writer: refused at once (O_NONBLOCK + fstat), never waited on', () => {
    const fifo = join(dir, 'fifo.yaml');
    execFileSync('mkfifo', [fifo]);
    const t0 = Date.now();
    expect(readPlainFile(fifo, 1024)).toEqual({ ok: false, reason: 'not_file' });
    expect(Date.now() - t0).toBeLessThan(1000);
  }, 5000);

  it('a symbolic link is never followed (even to a file next to it); a folder is not a file; a missing file is missing', () => {
    writeFileSync(join(dir, 'target'), 'secret\n');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    expect(readPlainFile(join(dir, 'link'), 1024)).toEqual({ ok: false, reason: 'link' });
    mkdirSync(join(dir, 'folder'));
    expect(readPlainFile(join(dir, 'folder'), 1024)).toMatchObject({ ok: false, reason: 'not_file' });
    expect(readPlainFile(join(dir, 'nope'), 1024)).toEqual({ ok: false, reason: 'missing' });
    expect(readPlainFile(join(dir, 'target', 'below'), 1024)).toEqual({ ok: false, reason: 'missing' });
  });

  it('a device is not a file', () => {
    expect(readPlainFile('/dev/zero', 1024)).toEqual({ ok: false, reason: 'not_file' });
  });
});
