/**
 * Versioned file formats (R-PRIN-13): scenarios, project.yaml, template.yaml, retake.yaml and run.json take an optional
 * `version: 1` (absent = 1); a higher version is one positioned error — the file was made for a newer Retake —
 * instead of the unknown keys of a format this one does not know; 0, "1" or 1.5 are plain schema errors.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, RETAKE_VERSION, FORMAT_VERSIONS, RunRecordSchema, newerFormatMessage, parseProjectYaml, parseScenario, parseTemplateYaml, validateScenario } from '@retake/core';
import { loadWorkspaceConfig, readRunRecord } from '@retake/core/io';
import type { ValidationIssue } from '@retake/core';
import { tempDir, writeFiles } from './helpers.js';

const msgs = (issues: ValidationIssue[]) => issues.map((i) => `${i.severity} ${i.line}:${i.col} ${i.path.join('.')}: ${i.message}`);
const newer = (file: string, v = 2) => `this ${file} is version ${v}: it was made for a newer Retake (this one reads version 1) — update Retake`;

const SCENARIO = 'video: demo\nscenes:\n  - id: a\n    steps:\n      - hold: 1\n';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('file format versions (R-PRIN-13)', () => {
  it('every format this Retake reads is version 1', () => {
    expect(FORMAT_VERSIONS).toEqual({ scenario: 1, project: 1, template: 1, workspace: 1, run: 1, render: 1 });
    expect(RETAKE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('project.yaml: 1 or absent loads; 2 is one error at the version, whatever else the file holds', () => {
    const one = parseProjectYaml('version: 1\nname: Northfield\n');
    expect(msgs(one.issues).filter((m) => m.startsWith('error'))).toEqual([]);
    expect(one.config?.version).toBe(1);
    const none = parseProjectYaml('name: Northfield\n');
    expect(none.config?.name).toBe('Northfield');
    expect(none.config?.version).toBeUndefined();
    // A newer format's keys are not reported one by one: the version explains them all.
    const two = parseProjectYaml('# a newer project\nname: Northfield\nversion: 2\nstages: {draft: true}\nenvironments: 3\n');
    expect(two.config).toBeUndefined();
    expect(msgs(two.issues)).toEqual([`error 3:10 version: ${newer('project.yaml')}`]);
  });

  it('a version that is not an integer above 1 is a plain schema error', () => {
    for (const v of ['"1"', '0', '1.5', '-3']) {
      const r = parseProjectYaml(`version: ${v}\nname: Northfield\n`);
      const m = msgs(r.issues).filter((x) => x.startsWith('error'));
      expect(m, v).toHaveLength(1);
      expect(m[0], v).toMatch(/^error 1:10 version: expected 1/);
      expect(m[0], v).not.toContain('newer Retake');
    }
    expect(newerFormatMessage({ version: 2 }, { file: 'x.yaml', supported: 1 })).toBe(newer('x.yaml'));
    expect(newerFormatMessage({ version: 1 }, { file: 'x.yaml', supported: 1 })).toBeUndefined();
    expect(newerFormatMessage([2], { file: 'x.yaml', supported: 1 })).toBeUndefined();
  });

  it('scenario: parsed text and already-parsed values', () => {
    expect(parseScenario(`version: 1\n${SCENARIO}`).scenario?.version).toBe(1);
    expect(parseScenario(SCENARIO).scenario?.video).toBe('demo');
    const two = parseScenario(`version: 3\n${SCENARIO}      - teleport: {to: mars}\n`);
    expect(two.scenario).toBeUndefined();
    expect(msgs(two.issues)).toEqual([`error 1:10 version: ${newer('scenario', 3)}`]);
    expect(validateScenario({ version: 2, video: 'demo', scenes: 'later' })).toEqual([{ severity: 'error', path: ['version'], message: newer('scenario') }]);
    expect(validateScenario({ version: 1, video: 'demo', scenes: [{ id: 'a', steps: [{ hold: 1 }] }] }).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it("template.yaml: the version is the file's, not a section of the merged template", () => {
    const one = parseTemplateYaml('version: 1\nname: brand\ncolors: {accent: "#3b5ec9"}\n');
    expect(msgs(one.issues)).toEqual([]);
    expect(one.template?.name).toBe('brand');
    expect(one.template).not.toHaveProperty('version');
    const two = parseTemplateYaml('version: 2\nname: brand\npalette: {}\n');
    expect(two.template).toBeUndefined();
    expect(msgs(two.issues)).toEqual([`error 1:10 version: ${newer('template.yaml')}`]);
  });

  it('retake.yaml: a newer workspace file stops every command with the one message', async () => {
    const ws = await tempDir();
    cleanups.push(ws.cleanup);
    await writeFiles(ws.dir, { 'retake.yaml': 'version: 1\nprojects_dir: work\n' });
    expect((await loadWorkspaceConfig(ws.dir)).projectsDir).toBe(join(ws.dir, 'work'));
    await writeFile(join(ws.dir, 'retake.yaml'), 'projects_dir: work\nversion: 2\nsync: {remote: x}\n');
    const err = await loadWorkspaceConfig(ws.dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues.map((i) => `${i.line}:${i.col} ${i.message}`)).toEqual([`2:10 ${newer('retake.yaml')}`]);
  });

  it('run.json: absent or 1 is read, a newer one refused; the schema takes version and engine', async () => {
    const run = await tempDir();
    cleanups.push(run.cleanup);
    // The refusal of a run.json a newer Retake wrote, as the one reader of run folders says it (core/io readRunRecord).
    const newerRunMessage = async (dir: string) => {
      const r = await readRunRecord(join(dir, 'run.json'));
      return !r.ok && r.problem === 'newer-format' ? r.message : undefined;
    };
    expect(await newerRunMessage(run.dir)).toBeUndefined(); // no run.json
    await writeFile(join(run.dir, 'run.json'), '{"id": "r", "status": "succeeded"}');
    expect(await newerRunMessage(run.dir)).toBeUndefined(); // a run made before L1.4
    await writeFile(join(run.dir, 'run.json'), '{"version": 2, "id": "r"}');
    expect(await newerRunMessage(run.dir)).toBe(newer('run.json'));
    const base = {
      id: 'r',
      project: 'p',
      scenario: 's',
      mode: 'capture',
      status: 'succeeded',
      started_at: 't',
      finished_at: 't',
      dir: '/r',
      env: 'local',
      options: { hooks: 'run', headed: false },
      steps_total: 0,
      steps_done: 0,
      screenshots: [],
      hooks: { setup: 'none', teardown: 'none' },
      warnings: [],
    };
    expect(RunRecordSchema.safeParse(base).success).toBe(true);
    const engine = { retake: '0.1.0', node: '22.1.0', chromium: '141.0.7390.37', os: 'darwin 25.6.0 arm64', fonts: { files: 3, digest: 'abcdef012345' } };
    expect(RunRecordSchema.safeParse({ version: 1, ...base, engine }).success).toBe(true);
    expect(RunRecordSchema.safeParse({ version: 2, ...base }).success).toBe(false);
  });
});
