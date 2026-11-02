/**
 * L5.10b: the storyboard's pure parts (unit-tested) — the keys of the frame grids and a scene's intrinsic height.
 *
 * Keys (plan §4.2, critique L3): the frames of every scene are one sequence the arrows walk; ← / → the step before /
 * after (across scenes), ↑ / ↓ the frame in the same column of the row above / below — into the scene before's last
 * row or the next scene's first row, the column clamped —, Home / End the first / last step, Page Up / Page Down three
 * rows. Pure index arithmetic on the scenes' step counts and the grid's columns: never a measure of a frame on screen
 * (a scene off screen is skipped by `content-visibility`, its frames have no box).
 *
 * L5.10b fixes: a frame's title words and a scene's length words (pure, unit-tested).
 */
import type { StepBlock } from '@demo-studio/core';
import { verbWords } from './scenario-words.js';

/** Where a step is: its scene (among the scenes with steps, in order) and its index in it. */
export interface FramePos {
  scene: number;
  index: number;
}

/** The keys that move the selection (Alt+arrows, Delete and the rest are the caller's). */
export const GRID_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'] as const;

/** The position the key leads to, or null (not a grid key, or no step at all). `counts`: each scene's steps (0 allowed). */
export function gridMove(counts: readonly number[], at: FramePos, key: string, columns: number): FramePos | null {
  const cols = Math.max(1, Math.floor(columns));
  const flat: FramePos[] = [];
  counts.forEach((n, scene) => {
    for (let index = 0; index < n; index++) flat.push({ scene, index });
  });
  if (flat.length === 0) return null;
  const cur = Math.max(0, flat.findIndex((p) => p.scene === at.scene && p.index === at.index));
  const clamp = (i: number) => flat[Math.max(0, Math.min(flat.length - 1, i))];
  const n = counts[at.scene] ?? 0;
  const col = at.index % cols;
  const filled = (from: number, dir: 1 | -1): number => {
    for (let s = from; s >= 0 && s < counts.length; s += dir) if (counts[s] > 0) return s;
    return -1;
  };
  switch (key) {
    case 'ArrowLeft':
      return clamp(cur - 1);
    case 'ArrowRight':
      return clamp(cur + 1);
    case 'Home':
      return flat[0];
    case 'End':
      return flat[flat.length - 1];
    case 'PageDown':
    case 'PageUp': {
      let p = flat[cur];
      for (let r = 0; r < 3; r++) p = gridMove(counts, p, key === 'PageDown' ? 'ArrowDown' : 'ArrowUp', cols) ?? p;
      return p;
    }
    case 'ArrowDown': {
      const row = Math.floor(at.index / cols);
      const lastRow = Math.floor((n - 1) / cols);
      if (row < lastRow) return { scene: at.scene, index: Math.min(n - 1, at.index + cols) };
      const next = filled(at.scene + 1, 1);
      return next < 0 ? flat[cur] : { scene: next, index: Math.min(col, counts[next] - 1) };
    }
    case 'ArrowUp': {
      if (at.index - cols >= 0) return { scene: at.scene, index: at.index - cols };
      const prev = filled(at.scene - 1, -1);
      if (prev < 0) return flat[cur];
      const m = counts[prev];
      const lastRowStart = Math.floor((m - 1) / cols) * cols;
      return { scene: prev, index: Math.min(m - 1, lastRowStart + col) };
    }
    default:
      return null;
  }
}

/** A frame's height in a row of the grid (picture, two lines, the gap): the intrinsic size a skipped scene keeps. */
export const FRAME_ROW_PX = 236;

/**
 * The height a scene is laid out at while `content-visibility` skips it (critique L1: per scene, rows × the row height,
 * so the scroll bar and the scroll anchoring do not jump after End): its header and its rows of frames. The board passes
 * the columns and the row height it measures on a rendered scene (review A L4: they follow the board's width); the
 * defaults are the 3-column board's.
 */
export function sceneIntrinsicPx(steps: number, columns = 3, rowPx = FRAME_ROW_PX): number {
  return 120 + Math.max(1, Math.ceil(steps / Math.max(1, columns))) * Math.max(1, rowPx);
}

/**
 * A frame's title (review B L7): the verb — the action's own words when they start with it ("Wait for", never "Wait
 * wait for") —, then the target, else what it does (`summary`: "Wait 1.6 s", "Press Enter"); the summary is the meta
 * line's note only when the title shows the target.
 */
export function frameTitle(step: Pick<StepBlock, 'category' | 'label' | 'target' | 'summary'>): { verb: string; rest?: string; note?: string } {
  const base = verbWords(step.category);
  const label = step.label.trim();
  const own = label.toLowerCase().startsWith(`${base.toLowerCase()} `) || label.toLowerCase() === base.toLowerCase();
  const verb = own ? label.charAt(0).toUpperCase() + label.slice(1) : base;
  if (step.target) return { verb, rest: step.target, ...(step.summary ? { note: step.summary } : {}) };
  if (step.summary) return { verb, rest: step.summary };
  return own || label === '' ? { verb } : { verb, rest: label };
}

/**
 * A scene's length beside its number (review A L5): a capture's seconds; else why there are none — "not shot yet" (no
 * run with pictures), "no capture yet" (the pictures are a dry run's: only a capture gives a scene its length) or "not
 * captured" (the capture shown did not reach it).
 */
export function sceneLengthWords(capturedS: number | undefined, sourceMode: string | undefined): string {
  if (capturedS !== undefined) return `${capturedS.toFixed(1)} s`;
  return sourceMode === undefined ? 'not shot yet' : sourceMode === 'dry' ? 'no capture yet' : 'not captured';
}
