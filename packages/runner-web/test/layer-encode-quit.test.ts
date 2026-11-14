/**
 * A cursor layer whose ffmpeg quits while its frames are written (L7.31 review): the write fails on the closed pipe, the
 * frames stop and the layer fails with the tool's exit — an EncodeError — while this process goes on (no unhandled EPIPE).
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import { EncodeError } from '../src/errors.js';
import { encodeCursorLayer } from '../src/raw/layer.js';
import type { CursorFrame } from '../src/raw/cursor.js';

const dir = mkdtempSync(join(tmpdir(), 'rw-layer-quit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('a cursor layer whose ffmpeg quits early (L7.31)', () => {
  it('fails with "exited with code 1 (cursor layer)" and the process survives the closed pipe', async () => {
    // Reads a few bytes of the first frame, says why on stderr and quits: the frames still to come meet a closed pipe.
    const tool = join(dir, 'quits');
    writeFileSync(tool, '#!/bin/sh\nhead -c 64 > /dev/null\necho "stand-in: no more frames" >&2\nexit 1\n');
    chmodSync(tool, 0o755);
    const frames: CursorFrame[] = Array.from({ length: 40 }, (_, f) => ({ f, t: f / 30, x: 0, y: 0, visible: false, down: false, icon: 'arrow', scale: 1, ripples: [] }));
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on('uncaughtException', onError);
    try {
      const err = await encodeCursorLayer({
        atlas: { scale: 1, cursor: { arrow: [], hand: [], ibeam: [] }, ripple: [] },
        frames,
        width: 1280,
        height: 720,
        pxScale: 1,
        fps: 30,
        format: 'prores',
        out: join(dir, 'layer.mov'),
        timecode: '00:00:00:00',
        ffmpeg: tool,
        policy: PERSON_POLICY,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EncodeError);
      expect((err as Error).message).toBe(`${tool} exited with code 1 (cursor layer): stand-in: no more frames`);
      await new Promise((r) => setTimeout(r, 100));
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', onError);
    }
  });
});
