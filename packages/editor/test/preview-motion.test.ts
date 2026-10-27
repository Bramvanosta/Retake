/**
 * L4.7 motion mode of component previews (pure, no render): the still spec of every transition stays exactly as before
 * in three starter themes (frame, length, no `motion`), a motion spec wraps the transition in a lead-in on the
 * outgoing scene and a hold on the settled card, every other kind's motion spec is its still spec, and the frames a
 * loop covers (15 fps, at most 6 s).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTemplate } from '@demo-studio/core';
import type { LoadedTemplate } from '@demo-studio/core';
import { loadComponentRegistry, themeTokens } from '@demo-studio/components';
import type { ComponentRegistry } from '@demo-studio/components';
import { LOOP_FORMAT, PREVIEW_MOTION, buildComponentPreview, loadPreviewSamples, loopFrames } from '@demo-studio/editor';
import type { PreviewSamples } from '@demo-studio/editor';
import { REPO } from './render-helpers.js';

let root: string;
let registry: ComponentRegistry;
let samples: PreviewSamples;
const themes: Record<string, LoadedTemplate> = {};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'demo-studio-preview-motion-'));
  await writeFile(join(root, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  registry = await loadComponentRegistry({ root });
  samples = loadPreviewSamples();
  for (const name of ['editorial', 'motion', 'default']) themes[name] = await loadTemplate(name, root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function build(id: string, template: LoadedTemplate, motion?: boolean) {
  const info = registry.get(id);
  const tokens = themeTokens(template, { logo: 'http://a/logo.svg', fonts: { display: 'http://a/d.ttf', body: ['http://a/b.ttf'] } });
  return buildComponentPreview({
    target: { id, manifest: info.manifest },
    template,
    tokens,
    registry,
    samples,
    sampleUrl: (f) => `http://a/${f.split('/').pop()}`,
    ...(motion ? { motion: true } : {}),
  });
}

/** The still specs of the transitions before L4.7 (frame, composition length, transition length, kind). */
const STILL: Record<string, [number, number, number, 'crossfade' | 'fade-black']> = {
  'studio/transition-crossfade': [5, 11, 11, 'crossfade'],
  'studio/transition-fade-black': [2, 12, 12, 'fade-black'],
  'studio/transition-tap-open': [11, 24, 24, 'crossfade'],
};

describe('motion mode of component previews', () => {
  it('the still spec of every transition is unchanged in three themes (same frame and length, no motion)', () => {
    const transitions = registry.list('transition').map((i) => i.manifest.id).sort();
    expect(transitions).toEqual(Object.keys(STILL).sort());
    for (const theme of Object.keys(themes)) {
      for (const id of transitions) {
        const p = build(id, themes[theme]);
        const [frame, length, n, kind] = STILL[id];
        expect([p.spec.frame, p.spec.durationInFrames, p.spec.main.durationInFrames, p.spec.transitionKind], `${theme} ${id}`).toEqual([frame, length, n, kind]);
        expect(p.spec.motion, `${theme} ${id}`).toBeUndefined();
        expect(p.spec.incoming?.id).toBe('studio/card-title');
      }
    }
  });

  it('a motion spec plays the transition between a lead-in on the scene and a hold on the card', () => {
    const lead = Math.round(PREVIEW_MOTION.lead_s * 30);
    const tail = Math.round(PREVIEW_MOTION.tail_s * 30);
    expect([lead, tail]).toEqual([18, 30]);
    for (const theme of Object.keys(themes)) {
      for (const id of Object.keys(STILL)) {
        const still = build(id, themes[theme]);
        const moving = build(id, themes[theme], true);
        const n = still.spec.main.durationInFrames;
        expect(moving.spec.motion, `${theme} ${id}`).toEqual({ lead, tail });
        expect(moving.spec.durationInFrames).toBe(lead + n + tail);
        expect(moving.spec.frame).toBe(still.spec.frame + lead);
        // Nothing else moves: the scene, the incoming card, the transition's own length and kind.
        const { motion: _m, frame: _f, durationInFrames: _d, ...rest } = moving.spec;
        const { frame: _sf, durationInFrames: _sd, ...stillRest } = still.spec;
        expect(rest, `${theme} ${id}`).toEqual(stillRest);
        expect(moving.components).toEqual(still.components);
      }
    }
  });

  it('every other kind already animates over its duration: its motion spec is its still spec', () => {
    const editorial = themes.editorial;
    for (const info of registry.list()) {
      if (info.manifest.kind === 'transition') continue;
      const id = info.manifest.id;
      expect(build(id, editorial, true), id).toEqual(build(id, editorial));
    }
  });

  it('a loop covers the spec at 15 fps, at most its first 6 s', () => {
    const intro = build('studio/intro-stack', themes.editorial, true).spec;
    expect(intro.durationInFrames).toBe(96);
    expect(loopFrames(intro)).toEqual({ frames: [0, 95], everyNthFrame: 2, count: 48, fps: 15 });
    const progress = build('studio/overlay-progress', themes.editorial, true).spec;
    expect(progress.durationInFrames).toBe(360);
    expect(loopFrames(progress)).toEqual({ frames: [0, LOOP_FORMAT.max_s * 30 - 1], everyNthFrame: 2, count: 90, fps: 15 });
    const xf = build('studio/transition-crossfade', themes.editorial, true).spec;
    expect(loopFrames(xf)).toEqual({ frames: [0, 58], everyNthFrame: 2, count: 30, fps: 15 });
  });
});
