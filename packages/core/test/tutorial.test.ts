/**
 * L2.10 contracts in core: tutorial switches (scenario → scene → step, `resolveTutorial`), the `capture_text` action and
 * its `text` artefact, frame references (`before:` / `after:` slots), data and image files of card slots.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TUTORIAL_COMPONENTS, TimelineSchema, applyTutorial, parseFrameRef, parseProjectYaml, parseScenario, resolveTutorial, timelineVideo, tutorialOff } from '@retake/core';
import type { LoadedProject, Scenario, Timeline, ValidationIssue } from '@retake/core';
import { errors, warnings } from './helpers.js';

const errs = (issues: ValidationIssue[]) => errors(issues).map((i) => `${i.path.join('.')}: ${i.message}`);
const warns = (issues: ValidationIssue[]) => warnings(issues).map((i) => `${i.path.join('.')}: ${i.message}`);

function project(): LoadedProject {
  const dir = mkdtempSync(join(tmpdir(), 'ds-tutorial-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'assets', 'before.png'), 'png');
  writeFileSync(join(dir, 'assets', 'logo.svg'), '<svg/>');
  writeFileSync(join(dir, 'data', 'orders.csv'), 'month,orders\nJan,12\n');
  const { config } = parseProjectYaml(['name: Demo', 'environments:', '  local:', '    shop: http://localhost:4402', ''].join('\n'));
  return { slug: 'demo', dir, root: dir, config: config!, readme: null, scenarios: [], file: join(dir, 'project.yaml') };
}

const scenario = (head: string[], steps: string[], tail: string[] = []) =>
  ['video: demo', ...head, 'scenes:', '  - id: signup', '    page: shop', '    open: /', '    steps:', ...steps.map((l) => `      ${l}`), ...tail, ''].join('\n');

describe('tutorial switches (R-TUT-01…05)', () => {
  it('resolve scenario → scene → step, the most specific level winning', () => {
    const off = tutorialOff();
    expect(Object.values(off).every((f) => !f.on)).toBe(true);
    expect(off.spotlight.mode).toBe('steps');
    expect(off.progress.mode).toBe('scenes');
    expect(off.shortcuts.component).toBe(TUTORIAL_COMPONENTS.shortcuts);

    const all = resolveTutorial(true);
    expect(Object.values(all).every((f) => f.on)).toBe(true);

    const r = resolveTutorial(
      { shortcuts: { params: { platform: 'windows' } }, spotlight: 'clicks', steps: true, loupe: true, progress: 'cards' },
      { loupe: false },
      { spotlight: false, steps: { params: { size: 30 } } },
    );
    expect(r.shortcuts).toMatchObject({ on: true, params: { platform: 'windows' } });
    expect(r.spotlight).toMatchObject({ on: false, mode: 'clicks' });
    expect(r.steps).toMatchObject({ on: true, params: { size: 30 } });
    expect(r.loupe.on).toBe(false);
    expect(r.progress).toMatchObject({ on: true, mode: 'cards' });

    // `false` on a scene turns every overlay off there; a step can turn one back on (params kept).
    const s = resolveTutorial({ shortcuts: { params: { platform: 'linux' } } }, false, { shortcuts: true });
    expect(s.shortcuts).toMatchObject({ on: true, params: { platform: 'linux' } });
    expect(s.spotlight.on).toBe(false);
    // progress is read at the scenario level only.
    expect(applyTutorial(tutorialOff(), true, 'scene').progress.on).toBe(false);
    expect(resolveTutorial({ progress: true }, false).progress.on).toBe(true);
    // A component swap.
    expect(resolveTutorial({ spotlight: { on: 'clicks', component: 'acme/focus', params: { dim: 0.7 } } }).spotlight).toEqual({
      on: true,
      component: 'acme/focus',
      params: { dim: 0.7 },
      mode: 'clicks',
    });
  });

  it('validate on scenarios, scenes and steps', () => {
    const p = project();
    const ok = parseScenario(
      scenario(['tutorial: {shortcuts: true, spotlight: clicks, steps: true, loupe: true, progress: scenes}'], ['- type: {into: Email, text: a@b.c}', '  tutorial: {spotlight: false}', '- press: Tab', '  tutorial: {shortcuts: {params: {platform: mac}}}'], ['    tutorial: {loupe: false}']),
      { project: p },
    );
    expect(errs(ok.issues)).toEqual([]);
    expect(warns(ok.issues)).toEqual([]);
    expect(ok.scenario?.tutorial).toMatchObject({ spotlight: 'clicks' });

    expect(errs(parseScenario(scenario(['tutorial: {spotlight: always}'], ['- wait: 1']), { project: p }).issues).join('\n')).toMatch(/tutorial\.spotlight/);
    expect(errs(parseScenario(scenario(['tutorial: {zoom: true}'], ['- wait: 1']), { project: p }).issues).join('\n')).toMatch(/zoom/);
    expect(errs(parseScenario(scenario(['tutorial: {steps: {component: Bad}}'], ['- wait: 1']), { project: p }).issues).join('\n')).toMatch(/namespace\/name/);

    const w = warns(parseScenario(scenario([], ['- wait: 1', '  tutorial: {shortcuts: true, loupe: true, progress: true}', '- press: Enter', '  tutorial: {spotlight: true}']), { project: p }).issues).join('\n');
    expect(w).toMatch(/steps\.0\.tutorial\.shortcuts: shortcuts shows the keys of `press` steps: nothing to show on this wait step/);
    expect(w).toMatch(/steps\.0\.tutorial\.loupe: loupe magnifies the field/);
    expect(w).toMatch(/steps\.0\.tutorial\.progress: `progress` is a video-wide switch/);
    expect(w).toMatch(/steps\.1\.tutorial\.spotlight: spotlight follows the target of a step: nothing to show on this press step/);
  });

  it('timelineVideo carries the scenario switches', () => {
    const s = parseScenario(scenario(['tutorial: {steps: true}'], ['- wait: 1'])).scenario as Scenario;
    expect(timelineVideo(s, { frame: 'card', template: 'editorial' }).tutorial).toEqual({ steps: true });
  });
});

describe('capture_text and text artefacts (R-STO-01)', () => {
  it('parses, checks the pattern and the capture references', () => {
    const p = project();
    const card = (slots: string) => ['  - card: {component: studio/card-figure, slots: ' + slots + '}'];
    const r = parseScenario(scenario([], ['- capture_text: {target: {testid: total}, as: total, pattern: "/€\\\\s?([\\\\d.,]+)/"}'], card('{capture: total, label: Total}')), { project: p });
    expect(errs(r.issues)).toEqual([]);
    expect(errs(parseScenario(scenario([], ['- capture_text: {target: Total, as: t, pattern: "("}']), { project: p }).issues).join('\n')).toMatch(/invalid regular expression/);
    expect(errs(parseScenario(scenario([], ['- capture_text: {target: {nth: 1}, as: t}']), { project: p }).issues).join('\n')).toMatch(/target needs at least one of/);
    const unknown = errs(parseScenario(scenario([], ['- capture_text: {target: Total, as: total}'], card('{capture: totl}')), { project: p }).issues).join('\n');
    expect(unknown).toMatch(/unknown capture "totl": no capture_text step captures it as `as: totl` \(did you mean "total"\?\)/);
    expect(errs(parseScenario(scenario([], ['- capture_text: {target: A, as: x}', '- capture_text: {target: B, as: x}']), { project: p }).issues).join('\n')).toMatch(/text "x" is already captured/);
  });

  it('the timeline schema accepts text artefacts', () => {
    const tl: Timeline = {
      version: 1,
      run_id: 'r',
      project: 'p',
      scenario: 's',
      created_at: '2026-10-12T00:00:00Z',
      mode: 'capture',
      capture: { file: 'capture.mp4', width: 1920, height: 1080, scale: 1, fps: 30, duration: 10, t0_wall: 0, frames: 300 },
      video: { tutorial: { spotlight: 'clicks' } },
      scenes: [{ id: 'a', index: 0, kind: 'scene', t_start: 0, t_end: 10, tutorial: false, status: 'ok' }],
      events: [{ scene: 'a', scene_index: 0, step: 0, action: 'capture_text', t_start: 1, t_end: 1, tutorial: { steps: false }, status: 'ok' }],
      markers: [],
      pages: [],
      cursor: [],
      idle: [],
      artefacts: [{ kind: 'text', name: 'total', t: 1, file: 'artefacts/texts/total.json', value: '720.00', text: 'Total €720.00', target: 'testid "total"', bbox: { x: 1, y: 2, w: 3, h: 4 }, pattern: '[\\d.]+' }],
      warnings: [],
    };
    expect(TimelineSchema.safeParse(tl).success).toBe(true);
  });
});

describe('frame references, data and image files of card slots (R-STO-03/04/06)', () => {
  it('parseFrameRef', () => {
    expect(parseFrameRef('import-done')).toEqual({ kind: 'mark', name: 'import-done' });
    expect(parseFrameRef('mark:reveal')).toEqual({ kind: 'mark', name: 'reveal' });
    expect(parseFrameRef('start:import')).toEqual({ kind: 'scene', at: 'start', scene: 'import' });
    expect(parseFrameRef('end:import')).toEqual({ kind: 'scene', at: 'end', scene: 'import' });
    expect(parseFrameRef('12.5s')).toEqual({ kind: 'time', t: 12.5 });
    expect(parseFrameRef('assets/before.png')).toEqual({ kind: 'file', path: 'assets/before.png' });
    expect(parseFrameRef('two words')).toBeUndefined();
  });

  it('checks marks, scenes, files and data', () => {
    const p = project();
    const card = (slots: string) => ['  - card: {component: studio/card-before-after, slots: ' + slots + '}'];
    const steps = ['- wait: 1', '  mark: done'];
    expect(errs(parseScenario(scenario([], steps, card('{before: start:signup, after: done}')), { project: p }).issues)).toEqual([]);
    expect(errs(parseScenario(scenario([], steps, card('{before: assets/before.png, after: 3.5s}')), { project: p }).issues)).toEqual([]);
    const e = errs(parseScenario(scenario([], steps, card('{before: dne, after: end:nope}')), { project: p }).issues).join('\n');
    expect(e).toMatch(/slots\.before: unknown mark "dne"/);
    expect(e).toMatch(/slots\.after: unknown scene "nope"/);
    expect(errs(parseScenario(scenario([], steps, card('{before: assets/missing.png, after: "two words"}')), { project: p }).issues).join('\n')).toMatch(/not found[\s\S]*is not a frame/);
    const chart = (slots: string) => ['  - card: {component: studio/card-chart, slots: ' + slots + '}'];
    expect(errs(parseScenario(scenario([], steps, chart('{data: data/orders.csv}')), { project: p }).issues)).toEqual([]);
    expect(errs(parseScenario(scenario([], steps, chart('{data: data/orders.xlsx}')), { project: p }).issues).join('\n')).toMatch(/must be a \.csv or \.tsv file/);
    expect(errs(parseScenario(scenario([], steps, chart('{data: data/none.csv}')), { project: p }).issues).join('\n')).toMatch(/not found/);
    const quote = (slots: string) => ['  - card: {component: studio/card-testimonial, slots: ' + slots + '}'];
    expect(errs(parseScenario(scenario([], steps, quote('{quote: Hi, logo: assets/logo.svg}')), { project: p }).issues)).toEqual([]);
    expect(errs(parseScenario(scenario([], steps, quote('{quote: Hi, logo: "https://cdn.example.com/x.png"}')), { project: p }).issues)).toEqual([]);
    expect(errs(parseScenario(scenario([], steps, quote('{quote: Hi, logo: assets/logo.txt}')), { project: p }).issues).join('\n')).toMatch(/an image must be/);
  });
});
