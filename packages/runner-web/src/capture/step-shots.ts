/**
 * What the browser driver keeps of a take's pictures: one per step (capture.step_shots, from the kept frames or the
 * video) and, for a take nothing of which is kept, the removal of what it filmed.
 */
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ARTEFACTS_DIR } from '@retake/core';
import type { TimelineEvent } from '@retake/core';
import { runFfmpeg } from '../encode.js';
import { errorMessage } from '../errors.js';
import type { FrameIndexEntry } from '../recorder.js';
import { fileSlug, pad } from '../util.js';

/**
 * capture.step_shots (R-FLD-16): for every step that ran, the last captured frame at or before its end (its page's track
 * in a multi-page scene), copied to screenshots/<scene>-<nn>-<action>.<ext> — the names a dry run gives its pictures.
 */
export async function stepShots(
  events: readonly TimelineEvent[],
  screenshotsDir: string,
  main: { dir: string; frames: FrameIndexEntry[] },
  track: (ev: TimelineEvent) => { dir: string; frames: FrameIndexEntry[] } | null,
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
): Promise<string[]> {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.step < 0 || ev.status === 'skipped') continue;
    const src = track(ev) ?? main;
    let pick: FrameIndexEntry | undefined;
    for (const f of src.frames) {
      if (f.t > ev.t_end + 1e-6) break;
      pick = f;
    }
    if (!pick) continue;
    const ext = extname(pick.file) || '.jpg';
    const file = join(screenshotsDir, `${fileSlug(ev.scene)}-${pad(ev.step, 2)}-${ev.action}${ext}`);
    try {
      await copyFile(join(src.dir, pick.file), file);
      out.push(file);
    } catch (e) {
      log('warn', `step picture of ${ev.scene}.${ev.step} not kept: ${errorMessage(e)}`);
    }
  }
  return out;
}

/**
 * capture.step_shots without kept frames (L5.7): for every step that ran, the frame of its video (capture.mp4, or its
 * page's track) shown at its end — output frame floor(t_end · fps), the CFR schedule's latest captured frame at or before
 * it — read in one ffmpeg pass per video, saved as screenshots/<scene>-<nn>-<action>.jpg.
 */
export async function videoStepShots(
  events: readonly TimelineEvent[],
  screenshotsDir: string,
  videoOf: (ev: TimelineEvent) => { video: string; count: number } | null,
  fps: number,
  ffmpeg: string,
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void,
): Promise<string[]> {
  const byVideo = new Map<string, Array<{ ev: TimelineEvent; n: number }>>();
  for (const ev of events) {
    if (ev.step < 0 || ev.status === 'skipped') continue;
    const src = videoOf(ev);
    if (!src) continue;
    const n = Math.min(src.count - 1, Math.max(0, Math.floor(ev.t_end * fps + 1e-6)));
    let list = byVideo.get(src.video);
    if (!list) byVideo.set(src.video, (list = []));
    list.push({ ev, n });
  }
  const out: string[] = [];
  for (const [video, list] of byVideo) {
    const ns = [...new Set(list.map((x) => x.n))].sort((a, b) => a - b);
    const tmp = join(screenshotsDir, `.step-shots-${process.pid}`);
    try {
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      const select = ns.map((n) => `eq(n\\,${n})`).join('+');
      await runFfmpeg(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-vf', `select='${select}'`, '-fps_mode', 'passthrough', '-q:v', '2', join(tmp, '%05d.jpg')]);
      for (const { ev, n } of list) {
        const file = join(screenshotsDir, `${fileSlug(ev.scene)}-${pad(ev.step, 2)}-${ev.action}.jpg`);
        try {
          await copyFile(join(tmp, `${pad(ns.indexOf(n) + 1, 5)}.jpg`), file);
          out.push(file);
        } catch (e) {
          log('warn', `step picture of ${ev.scene}.${ev.step} not kept: ${errorMessage(e)}`);
        }
      }
    } catch (e) {
      log('warn', `step pictures not kept (${errorMessage(e)})`);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return out.sort();
}

/** Remove what a run filmed: frames (main and per page), their indexes, the screenshots and the artefacts. */
export async function discardCapture(dir: string, screenshotsDir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    /* nothing there */
  }
  for (const n of names) {
    if (n === 'frames' || n === 'frames.jsonl' || n === ARTEFACTS_DIR || /^frames-.+/.test(n) || /^capture(-.+)?\.mp4$/.test(n)) {
      await rm(join(dir, n), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await rm(screenshotsDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(screenshotsDir, { recursive: true }).catch(() => undefined);
}
