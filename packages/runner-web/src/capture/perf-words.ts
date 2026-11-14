/**
 * What a take says of its own filming (L1.3, L5.7, R-FLD-24 / 28): the loads the recorder held at their limit, the
 * motion warnings and their measured cause, the run folder's size and the disk's free space.
 */
import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunPerf, RunPerfCpu } from '@retake/core/model';
import { HOLD_MAX_MS } from '../hold.js';
import type { ScreencastRecorder } from '../recorder.js';
import type { LogLevel } from '../runtime.js';
import type { GpuInfo } from '../session.js';
import type { MotionCapture, TimelineBuilder } from '../timeline.js';
import { bestEffort } from '@retake/core/base';

/**
 * A hold the recorder ended at its time limit (R-ISS-08): a page load that painted nothing within HOLD_MAX_MS, or a
 * fresh tab left blank that long — from then on the page is filmed as it is. Names the page and the capture time,
 * never the URL.
 */
export function warnLimitedLoads(rec: ScreencastRecorder, timeline: TimelineBuilder, log: (level: LogLevel, message: string) => void): void {
  const limit = HOLD_MAX_MS / 1000;
  for (const l of rec.limitedLoads()) {
    const message =
      l.kind === 'blank'
        ? `page ${l.page ?? '?'}: a new page stayed blank from ${l.t.toFixed(1)} s for ${limit} s (nothing opened in it) — it is filmed blank from then on: give it \`open\``
        : `page ${l.page ?? '?'}: a page load at ${l.t.toFixed(1)} s painted nothing within ${limit} s — its blank or loading frames are in the capture from then on`;
    timeline.warn(message);
    log('warn', message);
  }
}

/**
 * Run warnings about the motion a capture shows: moves below `minFps` (slow rendering) and stalls — the capture froze
 * ≥ STALL_MIN_S (150 ms) while the cursor moved or a click ripple played (L1.3). Null (cursor hidden): nothing can be
 * judged.
 */
export function motionWarnings(motion: MotionCapture | null, minFps: number, prefix: string, cause?: string): string[] {
  if (!motion) return [];
  const out: string[] = [];
  if (motion.slow > 0 && motion.worst) {
    out.push(
      `${prefix}${motion.slow} of ${motion.moves} cursor moves were captured below ${Math.round(minFps)} fps ` +
        `(lowest ${motion.worst.fps.toFixed(0)} fps at ${motion.worst.t.toFixed(1)} s), so motion will look choppy` +
        (cause ? ` — ${cause}` : ''),
    );
  }
  if (motion.stalls.length) {
    const worst = motion.stalls.reduce((a, b) => (b.ms > a.ms ? b : a));
    const where = motion.stalls.slice(0, 4).map((s) => `${s.t.toFixed(1)} s (${s.ms} ms, ${s.during === 'move' ? 'cursor moving' : 'click ripple'})`);
    out.push(
      `${prefix}the capture froze ${motion.stalls.length === 1 ? 'once' : `${motion.stalls.length} times`} while the cursor moved or a click ripple played ` +
        `(longest ${worst.ms} ms): ${where.join(', ')}${motion.stalls.length > 4 ? ', …' : ''} — the frames show a stop, then a jump` +
        (motion.stalls.some((s) => s.during === 'ripple')
          ? '; a freeze during a click ripple is usually a closing dialog whose overlay has a backdrop-filter (Chromium stops drawing ≈ 0.26 s): the edit cuts the frozen part'
          : ''),
    );
  }
  return out;
}

/**
 * Why cursor moves were filmed below the frame rate (L5.7, R-FLD-24), from what the take measured: the GPU, the
 * machine's load, Chromium's CPU, the frame-rate limiter, several browsers. The most likely cause first, then the
 * figures it rests on.
 */
export function choppyCause(m: { gpu?: GpuInfo; cpu?: RunPerfCpu; machine: RunPerf['machine']; seconds: number; frameRateLimit: boolean }): string {
  const figures: string[] = [];
  if (m.gpu) figures.push(m.gpu.accelerated ? `GPU hardware accelerated${m.gpu.renderer ? ` (${m.gpu.renderer})` : ''}` : `no GPU acceleration (${m.gpu.renderer ?? 'software'})`);
  figures.push(`machine load up to ${m.machine.load_max.toFixed(1)} on ${m.machine.cpus} cores`);
  if (m.machine.takes_beside) figures.push(`${m.machine.takes_beside === 1 ? 'another take' : `${m.machine.takes_beside} other takes`} filming beside it`);
  if (m.machine.heavy_slowed) figures.push('heavy work (a render, review or export) slowed during the take');
  const cores = (x: number) => (x / Math.max(0.001, m.seconds)).toFixed(2);
  if (m.cpu) figures.push(`Chromium ${cores(m.cpu.browser + m.cpu.gpu + m.cpu.renderer + m.cpu.chromium_other)} cores (renderer ${cores(m.cpu.renderer)}, GPU process ${cores(m.cpu.gpu)})`);
  let why: string;
  if (m.gpu && !m.gpu.accelerated) why = 'the browser renders in software: run `retake doctor` (browser.channel: headless-shell has no GPU)';
  else if ((m.machine.takes_beside ?? 0) > 0) why = 'another take filmed at the same time on this Mac: film one take at a time';
  else if (m.machine.load_max > m.machine.cpus) why = 'the machine was busy with other work: film when it is quiet';
  else if (m.cpu && m.cpu.renderer / Math.max(0.001, m.seconds) > 0.8) why = "the page's own rendering is heavy (large blurs or shadows, animations): its renderer stayed busy";
  else if (m.cpu?.browsers && m.cpu.browsers.length > 1 && m.cpu.browsers.some((b) => b.cpu / Math.max(0.001, m.seconds) > 0.5)) why = 'several browsers (one per persona) rendered at once';
  else if (!m.frameRateLimit) why = 'browser.frame_rate_limit: false makes Chromium draw back to back';
  else why = 'no load measured: the page itself drew slowly at those moments';
  return `measured: ${why} (${figures.join(', ')})`;
}

/** Size of a folder in MB (files only; never fails). */
export async function folderMB(dir: string): Promise<number> {
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await bestEffort(readdir(d, { withFileTypes: true }), 'a folder that cannot be listed adds nothing to the measure', [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) bytes += (await stat(p).catch(() => null))?.size ?? 0;
    }
  };
  await walk(dir);
  return Math.round((bytes / 1e6) * 10) / 10;
}

/** Free space below which a capture warns (R-FLD-28): this many GB, or this share of the disk. */
export const DISK_FREE_MIN_GB = 10;
export const DISK_FREE_MIN_SHARE = 0.05;

/** Free GB on the disk of `dir` and the warning when it is low (undefined: not measurable).
 *  `RETAKE_DISK_WARN=off` keeps the measure but drops the warning (the test suite sets it: a full disk is the
 *  machine's state, not a regression). */
export async function diskCheck(dir: string, project: string, env: NodeJS.ProcessEnv = process.env): Promise<{ free_gb?: number; warning?: string }> {
  try {
    const f = await statfs(dir);
    const free = (f.bavail * f.bsize) / 1e9;
    const total = (f.blocks * f.bsize) / 1e9;
    const free_gb = Math.round(free * 10) / 10;
    if (env.RETAKE_DISK_WARN === 'off') return { free_gb };
    if (free < DISK_FREE_MIN_GB || free < total * DISK_FREE_MIN_SHARE) {
      return { free_gb, warning: `only ${free_gb} GB left on this disk: \`retake prune ${project}\` removes failed takes, dry runs and old renders (it says how much first)` };
    }
    return { free_gb };
  } catch {
    return {};
  }
}
