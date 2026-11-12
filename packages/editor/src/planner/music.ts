/** The music bed of an edit: which file, its levels, and how a track of a known length plays over the video. */
import { isAbsolute, join } from 'node:path';
import type { LoadedProject, TimelineVideo } from '@retake/core/model';
import type { EditOverrides, PlanMusic, PlanSegment } from '../plan-types.js';
import { playsSound } from '../remotion/frames.js';
import { round, secs } from '../util.js';
import { MUSIC_DEFAULTS } from './rules.js';
import type { PlanScope } from './scope.js';

/** The music bed of an edit: the scenario's (timeline `video.music`), replaced by `overrides.music` (a file) or removed (`false`). */
export function musicSpecOf(video: Pick<TimelineVideo, 'music'> | undefined, ov: Pick<EditOverrides, 'music'> = {}): TimelineVideo['music'] | undefined {
  if (ov.music === false) return undefined;
  if (typeof ov.music === 'string') return { ...(video?.music ?? {}), file: ov.music };
  return video?.music;
}

/** Absolute path of a music bed file (relative paths are relative to the project). */
export function musicFile(spec: { file: string }, project: Pick<LoadedProject, 'dir'>): string {
  return isAbsolute(spec.file) ? spec.file : join(project.dir, spec.file);
}

/**
 * The plays of a music track of `L` seconds over a video of `total` output frames: one play when the track covers the
 * video or `loop` is false (trimmed by the video's end), else back-to-back loops overlapping by `crossfade_s` (each
 * fades out while the next fades in — equal-power curves in the composition). Frames are output frames.
 */
export function musicPlays(L: number, total: number, fps: number, loop: boolean, crossfadeS: number): Array<{ from: number; frames: number; fadeIn: number; fadeOut: number }> {
  const len = Math.max(1, Math.floor(L * fps));
  if (len >= total || !loop) return [{ from: 0, frames: Math.min(len, total), fadeIn: 0, fadeOut: 0 }];
  const xf = Math.max(0, Math.min(Math.round(crossfadeS * fps), Math.floor(len / 3)));
  const out: Array<{ from: number; frames: number; fadeIn: number; fadeOut: number }> = [];
  for (let from = 0; from < total; from += len - xf) {
    const frames = Math.min(len, total - from);
    out.push({ from, frames, fadeIn: from > 0 ? xf : 0, fadeOut: 0 });
    if (from + len >= total) break;
  }
  for (let i = 0; i < out.length - 1; i++) out[i].fadeOut = xf;
  return out;
}

/** A step of `planEdit`: the plan's music (its asset added last), with notes on how it plays; undefined without one. */
export function planMusic(s: PlanScope, segments: PlanSegment[], durationInFrames: number): PlanMusic | undefined {
  const { ov, video, notes, project, asset, input, outFps } = s;
  let music: PlanMusic | undefined;
  if (ov.music === false && video.music) notes.add('music disabled (overrides.music = false)');
  else if (typeof ov.music === 'string') notes.add(`music: ${ov.music} (overrides.music)`);
  const musicSpec = musicSpecOf(video, ov);
  if (musicSpec) {
    const file = musicFile(musicSpec, project);
    music = {
      url: asset('music', file),
      file,
      volume: musicSpec.volume ?? MUSIC_DEFAULTS.volume,
      duck: musicSpec.duck ?? MUSIC_DEFAULTS.duck,
      duck_ramp_s: MUSIC_DEFAULTS.duck_ramp_s,
      fadeIn_s: MUSIC_DEFAULTS.fadeIn_s,
      fadeOut_s: MUSIC_DEFAULTS.fadeOut_s,
      loop: musicSpec.loop ?? MUSIC_DEFAULTS.loop,
      crossfade_s: MUSIC_DEFAULTS.crossfade_s,
    };
    const L = input.musicDuration_s;
    if (L !== undefined && L > 0) {
      music.duration_s = round(L, 3);
      music.plays = musicPlays(L, durationInFrames, outFps, music.loop, music.crossfade_s);
      const total = secs(durationInFrames / outFps);
      if (L * outFps >= durationInFrames) notes.add(`music: the ${secs(L)} track is trimmed to the video (${total}), faded out over ${secs(music.fadeOut_s)}`);
      else if (!music.loop) notes.add(`music: the ${secs(L)} track plays once (loop: false); the rest of the ${total} video has no music`);
      else notes.add(`music: the ${secs(L)} track loops ${music.plays.length}× over ${total} (seams crossfaded over ${secs(music.crossfade_s)})`);
    }
    const ownSound = segments.some((sg) => sg.kind !== 'clip' && playsSound(sg.component));
    notes.add(`music: volume ${music.volume} on the intro, outro and cards, ×${music.duck} under footage${ownSound ? ' and under your files with sound' : ''}`);
  }
  return music;
}
