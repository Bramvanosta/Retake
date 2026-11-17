/**
 * After an iOS take: the recording probed (its size checked against the device's, its frame times) and put on the
 * capture clock (its start stamp's lateness, record-video.ts), each tap's touch-down read from the video
 * (touch-track.ts), the touches written to the timeline — always, even when the overlay is not burnt (`--cursor none`)
 * —, the overlay drawn and the conversion run (convert.ts) into capture.mp4; then the recording and the overlay's
 * pictures deleted.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkPolicy } from '@retake/core/policy';
import type { TimelineBuilder } from '@retake/runner-web/types';
import { convertTake, fromCaptureStart, onCaptureClock, probeMov, readCrops, takeFrames, touchBox } from './convert.js';
import type { MovProbe } from './convert.js';
import { movieDuration } from './mov-box.js';
import { recordingLateness } from './record-video.js';
import { writeOverlay } from './overlay.js';
import type { Rgba } from './touch-look.js';
import type { Touch, TouchRecord } from './touch-track.js';
import { TOUCH_DETECT, searchWindow, settleTouch, touchDownFrom, writeTouches } from './touch-track.js';

export interface TakeInput {
  policy: WorkPolicy;
  mov: string;
  /** The run's `.ios/` folder (the overlay's pictures go under it). */
  dir: string;
  out: string;
  endT: number;
  fps: number;
  crf: number;
  screen: { width: number; height: number; scale: number };
  touches: TouchRecord[];
  /** Burn the touch overlay into the video (false: `--cursor none`; the touches still reach the timeline). */
  burn: boolean;
  /** The recording's start stamp and SIGINT (process.hrtime ns): the start stamp's lateness. */
  recording: { startedNs: bigint | null; stopNs: bigint | null };
  ripple: Rgba;
  timeline: Pick<TimelineBuilder, 'sampleCursor' | 'cursorEffect'>;
  log: (level: 'info' | 'debug' | 'warn', m: string) => void;
  signal?: AbortSignal;
  /** Keep the recording (RETAKE_IOS_KEEP_RECORDING=1: a diagnosis of the touch-down search). */
  keepMov?: boolean;
}

export interface TakeOutput {
  frames: number;
  frameTimes: number[];
  idleFrameTimes: number[];
  touches: Touch[];
  /** The start stamp's lateness applied (s; 0 when the movie gave none). */
  lateness: number;
  /** Milliseconds: the touch-down search, the overlay's pictures, the encode. */
  ms: { detect: number; overlay: number; encode: number };
}

/** Why a recording cannot make the take: not the device's size (its screen changed), no frame. Pure. */
export function recordingProblem(probe: Pick<MovProbe, 'width' | 'height' | 'frameTimes'>, screen: { width: number; height: number; scale: number }): string | null {
  const w = Math.round(screen.width * screen.scale);
  const h = Math.round(screen.height * screen.scale);
  if (probe.width !== w || probe.height !== h) return `the recording is ${probe.width}×${probe.height} px, not the device's ${w}×${h}: the simulator's screen changed during the take`;
  if (!probe.frameTimes.length) return 'the recording holds no frame';
  return null;
}

/**
 * The times the edit reads idle spans from: the recording's frames and every change of the touch overlay — a touch on
 * a still screen is no idle span (the edit would cut the disc). Pure.
 */
export function idleTimes(frameTimes: readonly number[], overlayChanges: readonly number[]): number[] {
  return [...new Set([...frameTimes, ...overlayChanges])].sort((a, b) => a - b);
}

/** How many touch-down searches (one ffmpeg each) run at once. */
export const SEARCHES_AT_ONCE = 3;

/** The recording's frames on the capture clock: probed, and shifted by its start stamp's lateness (logged). */
export async function capturedProbe(input: Pick<TakeInput, 'policy' | 'mov' | 'recording' | 'log' | 'signal'>): Promise<{ probe: MovProbe; lateness: number }> {
  const raw = await probeMov(input.policy, input.mov, input.signal);
  const movieS = await movieDuration(input.mov);
  const lateness = recordingLateness({ ...input.recording, movieS });
  if (lateness === null) input.log('warn', `the recording's start could not be timed from its duration (${movieS === null ? 'none' : `${movieS.toFixed(3)} s`}): its first frame is taken as capture time 0`);
  else input.log('info', `the recording's first frame is ${(lateness * 1000).toFixed(1)} ms before capture time 0 (its start was read late by that): the film and its times are shifted by it`);
  return { probe: onCaptureClock(raw, lateness ?? 0), lateness: lateness ?? 0 };
}

/** One tap's touch-down: from the video, else the measured constant. */
async function settleTap(input: Pick<TakeInput, 'policy' | 'mov' | 'screen' | 'log' | 'signal'>, probe: MovProbe, r: TouchRecord): Promise<Touch> {
  const w = searchWindow(probe.frameTimes, r.t_act, r.t_end);
  let down: ReturnType<typeof touchDownFrom> = { t: r.t_act + TOUCH_DETECT.fallback, how: 'fallback', why: 'no frame before the touch' };
  if (w) {
    const times = probe.frameTimes.filter((t) => t >= w.from && t <= w.to);
    const box = touchBox(r.x, r.y, input.screen.scale, { width: probe.width, height: probe.height });
    const crops = await readCrops(input.policy, { mov: input.mov, first: probe.first, shift: probe.shift, times, box, scale: input.screen.scale, ...(input.signal ? { signal: input.signal } : {}) });
    down = crops ? touchDownFrom(crops, r.t_act, r.t_end) : { ...down, why: 'the recording could not be read there' };
  }
  if (down.how === 'fallback') input.log('debug', `touch at ${r.t_act.toFixed(3)} s: touch-down not seen in the video (${down.why}): t_act + ${TOUCH_DETECT.fallback * 1000} ms`);
  return settleTouch(r, down);
}

/** Each touch's touch-down (a tap's from the video, a swipe's the measured constant), SEARCHES_AT_ONCE searches at once. */
export async function settleTouches(input: Pick<TakeInput, 'policy' | 'mov' | 'screen' | 'touches' | 'log' | 'signal'>, probe: MovProbe): Promise<Touch[]> {
  const out: Touch[] = new Array(input.touches.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < input.touches.length; i = next++) {
      const r = input.touches[i];
      out[i] = r.kind === 'tap' ? await settleTap(input, probe, r) : settleTouch(r, { t: r.t_act + TOUCH_DETECT.fallback, how: 'fallback', why: 'a swipe' });
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEARCHES_AT_ONCE, input.touches.length) }, worker));
  return out;
}

/** The take made into capture.mp4 (see the module comment). The recording and the pictures are deleted after. */
export async function finishTake(input: TakeInput): Promise<TakeOutput> {
  const { probe, lateness } = await capturedProbe(input);
  const want = { width: Math.round(input.screen.width * input.screen.scale), height: Math.round(input.screen.height * input.screen.scale) };
  const problem = recordingProblem(probe, input.screen);
  if (problem) throw new Error(problem);
  const t0 = Date.now();
  const touches = await settleTouches(input, probe);
  const t1 = Date.now();
  writeTouches(
    input.timeline,
    touches.map((touch, i) => ({ touch, record: input.touches[i] })),
  );
  const frames = takeFrames(input.endT, input.fps);
  const overlayDir = join(input.dir, 'touches');
  await mkdir(overlayDir, { recursive: true });
  try {
    const overlay = await writeOverlay({ touches: input.burn ? touches : [], frames, fps: input.fps, screen: input.screen, ripple: input.ripple, dir: overlayDir });
    const t2 = Date.now();
    await convertTake(input.policy, {
      mov: input.mov,
      list: overlay.list,
      out: input.out,
      endT: input.endT,
      fps: input.fps,
      width: want.width,
      height: want.height,
      crf: input.crf,
      shift: probe.shift,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const t3 = Date.now();
    const frameTimes = fromCaptureStart(probe.frameTimes).filter((t) => t <= input.endT);
    const idleFrameTimes = idleTimes(frameTimes, overlay.changes);
    input.log(
      'info',
      `iOS take converted: ${frames} frames, ${touches.length} touches (${touches.filter((t) => t.how !== 'fallback').length} timed from the video), ${overlay.pictures} overlay pictures`,
    );
    return { frames, frameTimes, idleFrameTimes, touches, lateness, ms: { detect: t1 - t0, overlay: t2 - t1, encode: t3 - t2 } };
  } finally {
    await rm(overlayDir, { recursive: true, force: true }).catch(() => undefined);
    if (!input.keepMov) await rm(input.mov, { force: true }).catch(() => undefined);
  }
}
