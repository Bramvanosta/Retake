/**
 * Today's scenario file against a run's snapshot (core filmed.ts compares them): both read as small plain files.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../comments.js';
import { SCENARIO_COMPARE_MAX_BYTES, filmedChanges } from '../filmed.js';
import type { ScenarioSinceRun } from '../filmed.js';
import { projectPath } from '../layout.js';
import type { LoadedProject } from '../types.js';
import { parseYaml } from '../validation/yaml-source.js';
import { readPlainFile } from './plain-file.js';

/**
 * A small regular file read whole, or undefined: missing, a symbolic link, not a regular file (a FIFO or a device
 * would block the reader), over `max` bytes or unreadable (core readPlainFile).
 */
function readSmallPlainFile(file: string, max: number): string | undefined {
  const r = readPlainFile(file, max);
  return r.ok ? r.bytes.toString('utf8') : undefined;
}

/** `scenarios/<name>.yaml`, else `.yml` (as a name resolves). */
function scenarioFileOf(project: Pick<LoadedProject, 'dir'>, scenario: string): string | undefined {
  return [projectPath(project.dir, 'scenarios', `${scenario}.yaml`), projectPath(project.dir, 'scenarios', `${scenario}.yml`)].find((f) => existsSync(f));
}

/**
 * Today's scenario file of a project against a run's snapshot. Undefined when either file is missing, a symbolic link,
 * not a regular file, over SCENARIO_COMPARE_MAX_BYTES or unreadable: a run of a file elsewhere, a scenario since
 * deleted, a run without a snapshot. `scenario` is a name, never a path. `nowText` (L4.5, critique B5): the text of the
 * file as a render job snapshotted it at submit, used instead of today's file (a switch made while the render waited
 * in the queue no longer changes what it renders).
 */
export function scenarioSinceRun(project: Pick<LoadedProject, 'dir'>, runDir: string, scenario: string, nowText?: string): ScenarioSinceRun | undefined {
  if (scenario === '' || /[\\/]/.test(scenario)) return undefined;
  const file = scenarioFileOf(project, scenario) ?? (nowText !== undefined ? projectPath(project.dir, 'scenarios', `${scenario}.yaml`) : undefined);
  if (!file) return undefined;
  const now = nowText !== undefined ? (nowText.length <= SCENARIO_COMPARE_MAX_BYTES ? nowText : undefined) : readSmallPlainFile(file, SCENARIO_COMPARE_MAX_BYTES);
  const then = now === undefined ? undefined : readSmallPlainFile(join(runDir, 'scenario.yaml'), SCENARIO_COMPARE_MAX_BYTES);
  if (now === undefined || then === undefined) return undefined;
  const a = parseYaml(now).value;
  const b = parseYaml(then).value;
  const changed = now !== then && (a === undefined || b === undefined || canonicalJson(a) !== canonicalJson(b));
  const filmed = changed ? filmedChanges(now, then) : [];
  return { file, now, then, changed, ...(filmed !== undefined ? { filmed } : {}) };
}

/**
 * Whether the filmed part of a scenario changed since a run captured it (L5.5): true when it did (or a text no longer
 * parses), false when only the edit changed or nothing did, undefined when either file is missing or unreadable.
 */
export function scenarioChangedSinceRun(project: Pick<LoadedProject, 'dir'>, runDir: string, scenario: string): boolean | undefined {
  const s = scenarioSinceRun(project, runDir, scenario);
  return s === undefined ? undefined : s.filmed === undefined || s.filmed.length > 0;
}
