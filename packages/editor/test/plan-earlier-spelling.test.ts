/**
 * A plan kept in a render record before its asset URLs and font family names took their present spelling (core
 * plan-asset-url.ts) is read as the same plan: its preview, its served URLs, its summary and its served-file checks
 * are those of today's plan, and it renders the same frame. The units on the fixture plan; one real still each (needs
 * ffmpeg / ffprobe and a Chromium headless shell).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EARLIER_PLAN_ASSET_SCHEME, PERSON_POLICY, PLAN_ASSET_SCHEME, planTextInPresentSpelling } from '@retake/core';
import type { Timeline } from '@retake/core';
import { fileFacts, loadProjectTemplate, readJson } from '@retake/core/io';
import { loadComponentRegistry } from '@retake/components';
import type { ComponentRegistry } from '@retake/components';
import { previewPlan, renderStill } from '@retake/editor';
import { planEdit, resolvePlanAssets, summarizePlan } from '../src/plan-entry.js';
import { servedFileProblems } from '../src/render/plan-run.js';
import type { EditPlan } from '@retake/editor';
import { SHARED_CACHE, renderWorkspace } from '@retake/test-support/render';
import type { RenderWorkspace } from '@retake/test-support/render';
import { REPO, hasTool } from '@retake/test-support/repo';
import { FIXTURES, fixtureProject, template } from '@retake/test-support/timeline';

const EARLIER_FONT_PREFIX = EARLIER_PLAN_ASSET_SCHEME.replace(/asset:$/, '');

/** The plan as a render record made before the rename holds it: the earlier asset URLs and font family names. */
function earlier(plan: EditPlan): EditPlan {
  const text = JSON.stringify(plan)
    .replaceAll(`"${PLAN_ASSET_SCHEME}`, `"${EARLIER_PLAN_ASSET_SCHEME}`)
    .replace(/"retake-([a-z0-9-]+)-(display|body)"/g, `"${EARLIER_FONT_PREFIX}$1-$2"`);
  return JSON.parse(text) as EditPlan;
}
const present = (v: unknown) => planTextInPresentSpelling(JSON.stringify(v));

let registry: ComponentRegistry;
const RUN = '/virtual/runs/r';
beforeAll(async () => {
  registry = await loadComponentRegistry({ root: REPO });
});

describe('a plan in the earlier spelling', () => {
  let plan: EditPlan;
  let old: EditPlan;
  beforeAll(async () => {
    const timeline = JSON.parse(readFileSync(join(FIXTURES, 'quote.timeline.json'), 'utf8')) as Timeline;
    plan = planEdit({ timeline, template: await template('editorial'), project: await fixtureProject(), registry, captureFile: `${RUN}/capture.mp4` });
    old = earlier(plan);
  });

  it('is the earlier spelling (the fixture plan holds asset URLs and the theme fonts)', () => {
    const text = JSON.stringify(old);
    expect(text).toContain(`"${EARLIER_PLAN_ASSET_SCHEME}`);
    expect(text).not.toContain(`"${PLAN_ASSET_SCHEME}`);
    expect(old.brand.fonts.display.family.startsWith(EARLIER_FONT_PREFIX)).toBe(true);
    expect(present(old)).toBe(JSON.stringify(plan));
  });

  it("previews, serves, summarises and checks its files as today's plan", () => {
    const urlFor = (_asset: string, file: string) => `http://127.0.0.1:47999/m/x/${file.split('/').pop()}`;
    expect(present(previewPlan(old, { urlFor, forbid: [RUN] }))).toBe(JSON.stringify(previewPlan(plan, { urlFor, forbid: [RUN] })));
    const served = (p: EditPlan) => resolvePlanAssets(p, (_u, file) => `http://127.0.0.1:9/${file.split('/').pop()}`);
    expect(present(served(old))).toBe(present(served(plan)));
    expect(JSON.stringify({ ...served(old), assets: {} })).not.toContain(`"${EARLIER_PLAN_ASSET_SCHEME}`);
    expect(summarizePlan(old)).toEqual(summarizePlan(plan));
    const folders = { project: '/nowhere/p', run: '/nowhere/r', theme: '/nowhere/t' };
    const problems = servedFileProblems(old, folders);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems).toEqual(servedFileProblems(plan, folders));
  });
});

const canRender = hasTool('ffmpeg') && hasTool('ffprobe');

describe.skipIf(!canRender)('a plan in the earlier spelling, rendered', () => {
  let ws: RenderWorkspace;
  beforeAll(async () => {
    ws = await renderWorkspace();
  }, 600_000);
  afterAll(async () => {
    await ws?.cleanup();
  });

  it("renders the same still as today's plan (the intro: the theme's fonts and logo, and the capture)", async () => {
    const timeline = await readJson<Timeline>(join(ws.runDir, 'timeline.json'));
    const reg = await loadComponentRegistry({ root: ws.root });
    const plan = planEdit({
      timeline,
      template: await loadProjectTemplate(ws.project, 'editorial', { files: fileFacts(PERSON_POLICY) }),
      project: ws.project,
      registry: reg,
      captureFile: join(ws.runDir, 'capture.mp4'),
      overrides: { scale: 0.5 },
    });
    const md5 = (f: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'md5', '-'], { encoding: 'utf8' }).trim();
    for (const frame of [10, 45]) {
      const a = join(ws.root, 'stills', `today-${frame}.png`);
      const b = join(ws.root, 'stills', `earlier-${frame}.png`);
      await renderStill({ workPolicy: PERSON_POLICY, plan, frame, out: a, root: ws.root, registry: reg, cacheDir: SHARED_CACHE });
      await renderStill({ workPolicy: PERSON_POLICY, plan: earlier(plan), frame, out: b, root: ws.root, registry: reg, cacheDir: SHARED_CACHE });
      expect(md5(b), `frame ${frame}`).toBe(md5(a));
    }
  }, 600_000);
});
