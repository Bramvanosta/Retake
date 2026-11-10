import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTION_NAMES,
  DEFAULT_TEMPLATE,
  JSON_SCHEMAS,
  CapturePartialSchema,
  DEFAULT_CAPTURE,
  RunRecordSchema,
  perfSummary,
  ScenarioSchema,
  TimelineSchema,
  parseScenario,
  projectJsonSchema,
  scenarioJsonSchema,
  templateJsonSchema,
  timelineJsonSchema,
} from '@retake/core';
import type { RunRecord, Timeline } from '@retake/core';
import { SPEC_EXAMPLE } from './helpers.js';

type Json = Record<string, any>;

describe('JSON Schemas', () => {
  it('scenario: draft 2020-12, strict root, one branch per action', () => {
    const s = scenarioJsonSchema() as Json;
    expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(s.type).toBe('object');
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(['video', 'scenes']);
    const branches = s.$defs.Step.anyOf as Json[];
    expect(branches.map((b) => b.required)).toEqual(ACTION_NAMES.map((a) => [a]));
    for (const b of branches) {
      const action = b.required[0];
      expect(b.additionalProperties, action).toBe(false);
      expect(b.title).toBe(action);
      expect(typeof b.description).toBe('string');
      expect(typeof b.properties[action].description, action).toBe('string');
      for (const common of ['id', 'caption', 'speed', 'camera', 'mark', 'timeout', 'optional']) {
        expect(b.properties, `${action}.${common}`).toHaveProperty(common);
      }
    }
    const hold = branches.find((b) => b.title === 'hold')!;
    expect(hold.properties.hold).toMatchObject({ type: 'number', minimum: 0 });
    expect(s.$defs.TargetObject.properties.text.description).toMatch(/Visible text/);
    expect(s.$defs.TargetObject.properties.in.$ref).toBe('#/$defs/ScopeSpec');
    expect(JSON.stringify(s)).not.toContain('__schema');
    expect(JSON.stringify(s)).not.toContain('9007199254740991');
  });

  it('project, template and timeline schemas', () => {
    const p = projectJsonSchema() as Json;
    expect(p.required).toEqual(['name']);
    // L1.7: an environment is the long form {production, access, pages, read_only} or the page map (short form);
    // a page is a URL or {url, display}.
    expect(p.properties.environments.additionalProperties).toEqual({ $ref: '#/$defs/Environment' });
    const [long, short] = p.$defs.Environment.anyOf;
    expect(long.required).toEqual(['pages']);
    expect(Object.keys(long.properties)).toEqual(['production', 'access', 'pages', 'read_only']);
    expect(short.additionalProperties.anyOf[0]).toMatchObject({ type: 'string', format: 'uri' });
    expect(short.additionalProperties.anyOf[1].required).toEqual(['url']);
    expect(Object.keys(p.properties.clock.anyOf[1].properties)).toEqual(['at', 'freeze']);
    const t = templateJsonSchema() as Json;
    expect(t.required).toBeUndefined();
    expect(Object.keys(t.properties)).toEqual(expect.arrayContaining(Object.keys(DEFAULT_TEMPLATE).filter((k) => k !== 'name')));
    const tl = timelineJsonSchema() as Json;
    expect(tl.properties.version).toMatchObject({ const: 1 });
  });

  it('returns fresh copies', () => {
    const a = scenarioJsonSchema() as Json;
    a.title = 'mutated';
    expect((scenarioJsonSchema() as Json).title).toBe('Retake scenario');
  });

  it('packages/core/schema/*.json are up to date (pnpm -F @retake/core gen:schema)', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
    for (const [name, fn] of Object.entries(JSON_SCHEMAS)) {
      const onDisk = JSON.parse(readFileSync(join(dir, `${name}.schema.json`), 'utf8'));
      expect(onDisk, name).toEqual(fn());
    }
  });
});

describe('zod schemas', () => {
  it('ScenarioSchema accepts the spec example', () => {
    const { scenario } = parseScenario(SPEC_EXAMPLE);
    expect(ScenarioSchema.safeParse(scenario).success).toBe(true);
  });

  it('Timeline and RunRecord round-trip', () => {
    const timeline: Timeline = {
      version: 1,
      run_id: '20261011-142233-catalogue',
      project: 'northfield',
      scenario: 'catalogue',
      created_at: '2026-10-11T14:22:33.000Z',
      mode: 'capture',
      capture: { file: 'capture.mp4', width: 1920, height: 1080, scale: 1, fps: 30, duration: 12.5, t0_wall: 1791728553000, frames: 375 },
      scenes: [{ id: 'import', index: 0, kind: 'scene', t_start: 0, t_end: 12.5, status: 'ok', caption: { text: 'Import' } }],
      events: [
        {
          scene: 'import',
          scene_index: 0,
          step: 1,
          action: 'click',
          t_start: 2,
          t_end: 3.1,
          t_click: 2.9,
          target: { desc: 'text="New import"', bbox: { x: 10, y: 20, w: 100, h: 30 } },
          point: { x: 60, y: 35 },
          camera: { zoom: 1.2, target: { text: 'Awards' }, bbox: { x: 0, y: 0, w: 10, h: 10 } },
          status: 'ok',
          strategy: 'real',
          popup_opened: true,
        },
      ],
      markers: [{ name: 'reveal', t: 8, scene: 'import', step: 3 }],
      pages: [{ id: 'console', t_start: 0, t_end: 12.5, url: 'https://console.staging.example.com/imports' }],
      cursor: [{ t: 0, x: 1, y: 2, visible: true }],
      idle: [{ t_start: 4, t_end: 5 }],
      warnings: [],
    };
    expect(TimelineSchema.safeParse(timeline).success).toBe(true);
    expect(TimelineSchema.safeParse({ ...timeline, extra: 1 }).success).toBe(false);
    const run: RunRecord = {
      id: timeline.run_id,
      project: 'northfield',
      scenario: 'catalogue',
      mode: 'dry',
      status: 'running',
      started_at: timeline.created_at,
      dir: '/tmp/runs/x',
      env: 'staging',
      options: { hooks: 'skip', headed: false },
      steps_total: 20,
      steps_done: 3,
      screenshots: [],
      hooks: { setup: 'skipped', teardown: 'none' },
      warnings: [],
    };
    expect(RunRecordSchema.safeParse(run).success).toBe(true);
  });

  it('Timeline: page loads the capture held (R-ISS-08), on capture and on a track', () => {
    const base = {
      version: 1 as const,
      run_id: 'r',
      project: 'p',
      scenario: 's',
      created_at: '2026-10-12T20:00:00.000Z',
      mode: 'capture' as const,
      capture: { file: 'capture.mp4', width: 800, height: 600, scale: 1, fps: 30, duration: 9, t0_wall: 1, frames: 10 },
      scenes: [],
      events: [],
      markers: [],
      pages: [],
      cursor: [],
      idle: [],
      warnings: [],
    };
    const loading = [{ t_start: 2.1, t_end: 3.3, page: 'app', until: 'paint' as const, held_frames: 70 }];
    const track = { id: 'app', file: 'capture-app.mp4', frames_file: 'frames-app.jsonl', width: 800, height: 600, scale: 1, fps: 30, frames: 5, recording: [], pages: [], cursor: [] };
    const timeline: Timeline = { ...base, loading, tracks: [{ ...track, loading: [{ t_start: 1, t_end: 1.4, until: 'load', held_frames: 0 }] }] };
    expect(TimelineSchema.safeParse(timeline).success).toBe(true);
    // Older timelines have none.
    expect(TimelineSchema.safeParse(base).success).toBe(true);
    expect(TimelineSchema.safeParse({ ...base, loading: [{ ...loading[0], url: 'https://x.test' }] }).success).toBe(false);
    expect(TimelineSchema.safeParse({ ...base, loading: [{ ...loading[0], until: 'later' }] }).success).toBe(false);
    expect(TimelineSchema.safeParse({ ...base, tracks: [{ ...track, loading: [{ t_start: 1, t_end: 2, until: 'paint', held_frames: -1 }] }] }).success).toBe(false);
  });

  it('L5.7: timeline stalls and busy spans, run.json perf, the capture encoder and prewarm', () => {
    const base = {
      version: 1 as const,
      run_id: 'r',
      project: 'p',
      scenario: 's',
      created_at: '2026-10-26T14:00:00.000Z',
      mode: 'capture' as const,
      capture: { file: 'capture.mp4', width: 800, height: 600, scale: 1, fps: 30, duration: 9, t0_wall: 1, frames: 10 },
      scenes: [],
      events: [],
      markers: [],
      pages: [],
      cursor: [],
      idle: [],
      warnings: [],
    };
    const timeline: Timeline = { ...base, stalls: [{ t_start: 2.1, t_end: 2.37, during: 'ripple' }], busy: [{ t_start: 3.4, t_end: 4.8, click: 3.2 }] };
    expect(TimelineSchema.safeParse(timeline).success).toBe(true);
    expect(TimelineSchema.safeParse({ ...base, stalls: [{ t_start: 1, t_end: 2, during: 'scroll' }] }).success).toBe(false);
    const run: RunRecord = {
      id: 'r',
      project: 'p',
      scenario: 's',
      mode: 'capture',
      status: 'succeeded',
      started_at: base.created_at,
      dir: '/tmp/runs/r',
      env: 'local',
      options: { hooks: 'run', headed: false },
      steps_total: 2,
      steps_done: 2,
      screenshots: [],
      hooks: { setup: 'ok', teardown: 'ok' },
      warnings: [],
      perf: {
        seconds: 47.2,
        cpu: { browser: 21.6, gpu: 5.5, renderer: 3, chromium_other: 0.2, retake: 7, encoder: 7.4, product: 0.1, total: 44.8, cores: 0.95, browsers: [{ persona: 'buyer', cpu: 20 }, { cpu: 1 }] },
        machine: { cpus: 10, load_mean: 2.1, load_max: 3 },
        gpu: { accelerated: true, renderer: 'ANGLE Metal' },
        frame_rate_limit: true,
        frames: { received: 1624, fps: 34.4, motion_fps_min: 55, dropped: 8, kicked: 9 },
        stalls: [],
        transitions: { measured: 15, slow: [{ t: 6.1, ms: 1875, scene: 'reports', step: 1, target: 'link "October 2026"' }] },
        encode: { codec: 'h264_videotoolbox', quality: 'q:v 85', finish_ms: 28, late_frames: 0 },
        disk: { run_mb: 20.3, frames_kept: false, free_gb: 107 },
      },
    };
    expect(RunRecordSchema.safeParse(run).success).toBe(true);
    expect(RunRecordSchema.safeParse({ ...run, perf: { ...run.perf, frames: { ...run.perf!.frames, extra: 1 } } }).success).toBe(false);
    expect(perfSummary(run.perf!)).toBe('0.95 cores (Chromium 0.64, encoder 0.16, retake 0.15, product 0.00) · 34.4 fps (moves ≥ 55) · no freeze · 1 slow transition: reports.1 1.9 s · 20 MB');
    expect(perfSummary({ ...run.perf!, cpu: undefined, gpu: { accelerated: false }, stalls: [{ t: 1, ms: 250, during: 'ripple' }], transitions: undefined, disk: undefined, frame_rate_limit: false })).toBe(
      'no GPU · 34.4 fps (moves ≥ 55) · 1 freeze (cut by the edit) · frame-rate limiter off',
    );
    // L5.14b: what ran beside the take (captures first) is recorded and said.
    const beside = { ...run.perf!, machine: { ...run.perf!.machine, takes_beside: 1, heavy_slowed: true as const } };
    expect(RunRecordSchema.safeParse({ ...run, perf: beside }).success).toBe(true);
    expect(RunRecordSchema.safeParse({ ...run, perf: { ...beside, machine: { ...beside.machine, heavy_slowed: false } } }).success).toBe(false);
    expect(perfSummary(beside)).toMatch(/ · another take filmed beside it · heavy work \(a render, review or export\) was slowed during it$/);
    expect(DEFAULT_CAPTURE).toMatchObject({ quality: 90, keep_frames: false });
    expect(CapturePartialSchema.safeParse({ encoder: 'videotoolbox', prewarm: true, keep_frames: true }).success).toBe(true);
    expect(CapturePartialSchema.safeParse({ encoder: 'nvenc' }).success).toBe(false);
  });
});
