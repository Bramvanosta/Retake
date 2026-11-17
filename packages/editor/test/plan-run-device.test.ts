/**
 * A device's take (an iOS environment) re-planned from today's scenario (render/plan-run.ts editOfToday): the run's
 * snapshot is read with its project, so its deep links (`open: northfield://…`) and iOS steps validate — read alone, as
 * a web scenario, it would not, and every render would fall back to the edit as captured with a warning. Today's
 * scenario is read with the take's environment too (a project whose default environment is a web one); a frame
 * written or removed today decides whether the default (phone) frame applies.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERSON_POLICY } from '@retake/core/policy';
import { afterAll, describe, expect, it } from 'vitest';
import { fileFacts, loadProject } from '@retake/core/io';
import { deviceTimeline } from '@retake/test-support/timeline';
import { editOfToday } from '../src/render/plan-run.js';

const root = mkdtempSync(join(tmpdir(), 'retake-plan-device-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SCENARIO = ['version: 1', 'video: buyer', 'scenes:', '  - id: main', '    open: "northfield://catalogue"', '    steps:', '      - click: Anchor bolts', ''].join('\n');

describe("a device take's edit of today", () => {
  it("the snapshot of an iOS run validates with its project: today's caption change is re-planned, no warning", async () => {
    const dir = join(root, 'projects', 'buyer');
    mkdirSync(join(dir, 'scenarios'), { recursive: true });
    writeFileSync(join(dir, 'project.yaml'), 'name: Buyer\nenvironments:\n  simulator:\n    ios: {app: com.example.buyer, device: iPhone 17 Pro, schemes: [northfield]}\n');
    const run = join(dir, 'runs', 'device');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'scenario.yaml'), SCENARIO);
    writeFileSync(join(dir, 'scenarios', 'buyer.yaml'), SCENARIO.replace('  - id: main\n', '  - id: main\n    caption: Find a product\n'));
    const project = await loadProject(dir);
    const captured = { ...deviceTimeline(), scenario: 'buyer', environment: { name: 'simulator', access: 'read-write' as const } };
    const r = editOfToday({ project, run: { id: 'device', dir: run }, captured, envName: undefined, editText: undefined, files: fileFacts(PERSON_POLICY) });
    expect(r.warnings).toEqual([]);
    expect(r.edit).toMatchObject({ from: 'scenario' });
    expect(r.timeline.scenes[0].caption).toEqual({ text: 'Find a product' });
  });

  it("a project whose default environment is a web one: today's scenario is read on the take's iOS environment", async () => {
    const dir = join(root, 'projects', 'mixed');
    mkdirSync(join(dir, 'scenarios'), { recursive: true });
    writeFileSync(
      join(dir, 'project.yaml'),
      'name: Mixed\ndefault_env: web\nenvironments:\n  web:\n    pages: {app: "https://app.example.com"}\n  simulator:\n    ios: {app: com.example.buyer, device: iPhone 17 Pro, schemes: [northfield]}\n',
    );
    const run = join(dir, 'runs', 'device');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'scenario.yaml'), SCENARIO);
    writeFileSync(join(dir, 'scenarios', 'buyer.yaml'), SCENARIO.replace('  - id: main\n', '  - id: main\n    caption: Find a product\n'));
    const project = await loadProject(dir);
    const captured = { ...deviceTimeline(), scenario: 'buyer', environment: { name: 'simulator', access: 'read-write' as const } };
    const r = editOfToday({ project, run: { id: 'device', dir: run }, captured, envName: undefined, editText: undefined, files: fileFacts(PERSON_POLICY) });
    expect(r.warnings).toEqual([]);
    expect(r.edit).toMatchObject({ from: 'scenario' });
    expect(r.timeline.scenes[0].caption).toEqual({ text: 'Find a product' });
  });

  it('a frame written today is no default any more; one removed today is the default again (framed as a phone)', async () => {
    const dir = join(root, 'projects', 'framed');
    mkdirSync(join(dir, 'scenarios'), { recursive: true });
    writeFileSync(join(dir, 'project.yaml'), 'name: Framed\nenvironments:\n  simulator:\n    ios: {app: com.example.buyer, device: iPhone 17 Pro, schemes: [northfield]}\n');
    const project = await loadProject(dir);
    const today = async (then: string, now: string, frame?: 'card') => {
      const run = join(dir, 'runs', `device-${frame ?? 'none'}`);
      mkdirSync(run, { recursive: true });
      writeFileSync(join(run, 'scenario.yaml'), then);
      writeFileSync(join(dir, 'scenarios', 'buyer.yaml'), now);
      const captured = { ...deviceTimeline(frame ? { frame } : {}), scenario: 'buyer', environment: { name: 'simulator', access: 'read-write' as const } };
      const r = editOfToday({ project, run: { id: 'device', dir: run }, captured, envName: undefined, editText: undefined, files: fileFacts(PERSON_POLICY) });
      expect(r.warnings).toEqual([]);
      return r.timeline.video;
    };
    const written = SCENARIO.replace('video: buyer\n', 'video: buyer\nframe: card\n');
    const card = await today(SCENARIO, written);
    expect(card).toMatchObject({ frame: 'card' });
    expect(card?.frame_default).toBeUndefined();
    expect((await today(written, SCENARIO, 'card'))?.frame_default).toBe(true);
  });
});
