import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTION_NAMES,
  DEFAULT_TEMPLATE,
  JSON_SCHEMAS,
  RunRecordSchema,
  ScenarioSchema,
  TimelineSchema,
  parseScenario,
  projectJsonSchema,
  scenarioJsonSchema,
  templateJsonSchema,
  timelineJsonSchema,
} from '@demo-studio/core';
import type { RunRecord, Timeline } from '@demo-studio/core';
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
    expect(p.properties.environments.additionalProperties.additionalProperties).toMatchObject({ type: 'string', format: 'uri' });
    const t = templateJsonSchema() as Json;
    expect(t.required).toBeUndefined();
    expect(Object.keys(t.properties)).toEqual(expect.arrayContaining(Object.keys(DEFAULT_TEMPLATE).filter((k) => k !== 'name')));
    const tl = timelineJsonSchema() as Json;
    expect(tl.properties.version).toMatchObject({ const: 1 });
  });

  it('returns fresh copies', () => {
    const a = scenarioJsonSchema() as Json;
    a.title = 'mutated';
    expect((scenarioJsonSchema() as Json).title).toBe('Demo Studio scenario');
  });

  it('packages/core/schema/*.json are up to date (pnpm -F @demo-studio/core gen:schema)', () => {
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
});
