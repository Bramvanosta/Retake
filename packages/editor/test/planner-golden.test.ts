/**
 * The planner's golden output: `planEdit` on every fixture timeline, with the three starter themes, the built-in
 * component library, a range of render overrides and the other inputs (the project files it is given, an old timeline
 * with its scenario, the run's environment, the run folder), held byte for byte (its JSON, key order included) against the
 * digests of fixtures/planner-golden.json. A refactor of the planner keeps every digest; a change of what the planner
 * decides (or of a component manifest, a starter theme or the fixture project it reads) changes some. After an intended
 * change: RETAKE_WRITE_SNAPSHOTS=1 on this file, then review the diff. RETAKE_PLAN_DUMP=<folder> writes each case's plan
 * there, to compare two versions of the planner with a diff tool.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import type { LoadedProject, LoadedTemplate, Scenario, Timeline } from '@retake/core';
import { planEdit } from '@retake/editor/plan';
import type { EditOverrides, PlanEditInput, PlanInputFile } from '@retake/editor/plan';
import { FIXTURES, REPO, fixtureProject, template } from './helpers.js';

const FILE = join(FIXTURES, 'planner-golden.json');
const TIMELINES = ['catalogue', 'highlights', 'live-quote', 'phone-and-desktop', 'quote-artefacts', 'quote', 'signup-tutorial', 'signup'] as const;
type TimelineName = (typeof TIMELINES)[number];
type ThemeName = 'editorial' | 'motion' | 'default';

interface GoldenCase {
  name: string;
  timeline: TimelineName;
  theme: ThemeName;
  overrides?: EditOverrides;
  musicDuration_s?: number;
  /** The other inputs of planEdit. */
  input?: Pick<PlanEditInput, 'files' | 'scenario' | 'env' | 'runDir'>;
  /** A change of the fixture timeline (on a copy). */
  edit?: (t: Timeline) => void;
}

/** The quote with the project's own files: an intro video, an end card image, a Lottie chapter card. */
const ownFiles = (t: Timeline) => {
  t.video = { ...t.video!, intro: { video: 'assets/intro.mp4' }, outro: { ...t.video!.outro, image: 'assets/end-card.png', duration: 3 } };
  t.scenes.find((x) => x.card)!.card = { lottie: 'assets/cup-steam.json', params: { colors: { '#ff5a1f': 'accent' } } };
};
const FILES: Record<string, PlanInputFile> = {
  'assets/intro.mp4': {
    file: '/media/intro.mp4',
    width: 1920,
    height: 1080,
    video: { container: 'mov,mp4', codec: 'h264', width: 1920, height: 1080, duration_s: 4, fps: 30, audio: true, alpha: false },
  },
  'assets/end-card.png': { file: '/media/end-card.png', width: 1920, height: 1080 },
  'assets/cup-steam.json': { file: '/media/cup-steam.json', width: 600, height: 500, lottie: { version: '5.7.4', width: 600, height: 500, fps: 30, frames: 96, duration_s: 3.2, external_images: 0 } },
};
/** The same files missing or unusable: no image, a video ffprobe cannot read, a Lottie file not given at all. */
const MISSING_FILES: Record<string, PlanInputFile> = {
  'assets/intro.mp4': { file: '/media/intro.mp4', error: 'not a video ffprobe reads' },
  'assets/end-card.png': { file: '/media/end-card.png', missing: true },
};
/** A scenario as an old run's caller passes it (edit info of a timeline without a `video` block). */
const OLD_SCENARIO = {
  version: 1,
  video: 'old-quote',
  title: { kicker: 'Before L2.1', text: 'From the scenario' },
  outro: { tagline: 'The scenario’s own outro.' },
  frame: 'browser',
  scenes: [],
} as unknown as Scenario;
const noVideo = (t: Timeline) => {
  delete t.video;
};

/** Every timeline with every starter theme, then overrides over the main code paths of the planner. */
const CASES: GoldenCase[] = [
  ...TIMELINES.flatMap((timeline) => (['editorial', 'motion', 'default'] as const).map((theme) => ({ name: `${timeline}/${theme}`, timeline, theme }))),
  ...(['catalogue', 'quote', 'live-quote', 'phone-and-desktop', 'signup-tutorial'] as const).flatMap((timeline) =>
    (['vertical', 'square'] as const).map((variant) => ({ name: `${timeline}/editorial/${variant}`, timeline, theme: 'editorial' as const, overrides: { variant } })),
  ),
  { name: 'quote/motion/vertical', timeline: 'quote', theme: 'motion', overrides: { variant: 'vertical' } },
  { name: 'quote/editorial/fps-scale', timeline: 'quote', theme: 'editorial', overrides: { fps: 60, scale: 2 } },
  {
    name: 'quote/editorial/bad-values',
    timeline: 'quote',
    theme: 'editorial',
    overrides: { fps: 500, scale: 9, idle_threshold: -1, transition_duration: 9, speeds: { request: 40, nowhere: 2 }, variant: 'diagonal' as never, components: { nothing: 'studio/caption-below' } },
  },
  { name: 'quote/editorial/no-trim', timeline: 'quote', theme: 'editorial', overrides: { trim_idle: false } },
  { name: 'catalogue/editorial/idle-threshold', timeline: 'catalogue', theme: 'editorial', overrides: { idle_threshold: 0.4 } },
  { name: 'catalogue/motion/no-camera', timeline: 'catalogue', theme: 'motion', overrides: { camera: false } },
  { name: 'quote/editorial/bare', timeline: 'quote', theme: 'editorial', overrides: { intro: false, outro: false, captions: false } },
  { name: 'signup/editorial/forced', timeline: 'signup', theme: 'editorial', overrides: { intro: true, outro: true } },
  { name: 'quote/editorial/fade-black', timeline: 'quote', theme: 'editorial', overrides: { transition: 'fade-black', transition_duration: 0.8 } },
  { name: 'catalogue/editorial/cut', timeline: 'catalogue', theme: 'editorial', overrides: { transition: 'cut' } },
  { name: 'quote/editorial/speeds', timeline: 'quote', theme: 'editorial', overrides: { speeds: { discover: 2, proposal: 0.75 } } },
  { name: 'quote/editorial/frame-raw', timeline: 'quote', theme: 'editorial', overrides: { frame: 'raw' } },
  { name: 'quote/editorial/frame-browser', timeline: 'quote', theme: 'editorial', overrides: { frame: 'browser' } },
  {
    name: 'quote/editorial/components',
    timeline: 'quote',
    theme: 'editorial',
    overrides: {
      components: { layout: 'studio/layout-browser', caption: 'studio/caption-overlay', discover: { id: 'studio/layout-card', params: { width: 1400 } }, transition: 'studio/transition-fade-black' },
    },
  },
  { name: 'signup-tutorial/editorial/tutorial-off', timeline: 'signup-tutorial', theme: 'editorial', overrides: { tutorial: false } },
  { name: 'signup/editorial/tutorial-on', timeline: 'signup', theme: 'editorial', overrides: { tutorial: true } },
  { name: 'quote/editorial/tutorial-switches', timeline: 'quote', theme: 'editorial', overrides: { tutorial: { steps: true, spotlight: 'steps', shortcuts: true, loupe: true, progress: true } } },
  { name: 'phone-and-desktop/editorial/tutorial-off', timeline: 'phone-and-desktop', theme: 'editorial', overrides: { tutorial: false } },
  { name: 'quote/editorial/music-loop', timeline: 'quote', theme: 'editorial', overrides: { music: 'assets/music.mp3' }, musicDuration_s: 7 },
  { name: 'quote/editorial/music-long', timeline: 'quote', theme: 'editorial', overrides: { music: 'assets/music.mp3' }, musicDuration_s: 400 },
  { name: 'quote/editorial/music-off', timeline: 'quote', theme: 'editorial', overrides: { music: false } },
  { name: 'quote/editorial/theme-mismatch', timeline: 'quote', theme: 'editorial', overrides: { theme: 'motion' } },
  { name: 'quote/editorial/own-files', timeline: 'quote', theme: 'editorial', edit: ownFiles, input: { files: FILES } },
  { name: 'quote/editorial/own-files-missing', timeline: 'quote', theme: 'editorial', edit: ownFiles, input: { files: MISSING_FILES } },
  { name: 'quote/editorial/old-timeline', timeline: 'quote', theme: 'editorial', edit: noVideo },
  { name: 'quote/motion/old-timeline-scenario', timeline: 'quote', theme: 'motion', edit: noVideo, input: { scenario: OLD_SCENARIO } },
  { name: 'quote/editorial/env', timeline: 'quote', theme: 'editorial', input: { env: 'local' } },
  { name: 'quote-artefacts/editorial/run-dir', timeline: 'quote-artefacts', theme: 'editorial', input: { runDir: '/runs/r1' } },
];

let registry: ComponentRegistry;
let project: LoadedProject;
const themes = {} as Record<ThemeName, LoadedTemplate>;
const timelines = {} as Record<TimelineName, Timeline>;

beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
  project = await fixtureProject();
  for (const name of ['editorial', 'motion', 'default'] as const) themes[name] = await template(name);
  for (const name of TIMELINES) timelines[name] = JSON.parse(readFileSync(join(FIXTURES, `${name}.timeline.json`), 'utf8')) as Timeline;
});

/** The plan as JSON, with this checkout's folder replaced (the digests hold on every machine). */
function planText(c: GoldenCase): string {
  const timeline = structuredClone(timelines[c.timeline]);
  c.edit?.(timeline);
  const plan = planEdit({
    timeline,
    template: themes[c.theme],
    project,
    registry,
    captureFile: '/captures/run/capture.mp4',
    ...(c.overrides ? { overrides: c.overrides } : {}),
    ...(c.musicDuration_s !== undefined ? { musicDuration_s: c.musicDuration_s } : {}),
    ...c.input,
  });
  return JSON.stringify(plan).split(REPO.replace(/\/$/, '')).join('<repo>');
}

describe('the planner (golden output)', () => {
  it('plans every case exactly as fixtures/planner-golden.json records it', () => {
    const now: Record<string, { sha256: string; bytes: number }> = {};
    const dump = process.env.RETAKE_PLAN_DUMP?.trim();
    if (dump) mkdirSync(dump, { recursive: true });
    for (const c of CASES) {
      const text = planText(c);
      now[c.name] = { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
      if (dump) writeFileSync(join(dump, `${c.name.replace(/\//g, '__')}.json`), `${JSON.stringify(JSON.parse(text), null, 1)}\n`);
    }
    const text = `${JSON.stringify(now, null, 1)}\n`;
    if (process.env.RETAKE_WRITE_SNAPSHOTS === '1') writeFileSync(FILE, text);
    expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(FILE, 'utf8')));
    expect(text).toBe(readFileSync(FILE, 'utf8'));
    expect(Object.keys(now)).toHaveLength(CASES.length);
  });

  it('is deterministic: the same input planned twice gives the same bytes', () => {
    for (const c of CASES.slice(0, 4)) expect(planText(c)).toBe(planText(c));
  });
});
