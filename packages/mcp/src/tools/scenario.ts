import { z } from 'zod';
import type { ValidationIssue } from '@retake/core';
import { envName, ifMatch, projectSlug, scenarioName } from '../schema.js';
import { plural } from '../result.js';
import { READ, WRITE_FILES, defineTool } from './define.js';
import type { ToolDef } from './define.js';

/** "7:9 error scenes.0.steps.0: unknown action…" */
export function issueLine(i: ValidationIssue): string {
  const at = i.line !== undefined ? `${i.line}:${i.col ?? 1} ` : '';
  return `${at}${i.severity}${i.path.length ? ` ${i.path.join('.')}` : ''}: ${i.message}`;
}

export const scenarioGet = defineTool({
  name: 'scenario_get',
  title: 'Read a scenario',
  description: 'The YAML of a scenario and its hash (the if_match of scenario_save).',
  input: z.strictObject({ project: projectSlug, name: scenarioName }),
  annotations: READ,
  async run({ project, name }, { engine }) {
    const s = await engine.scenarios.get(project, name);
    return { summary: `${project}/${s.file} (${s.yaml.length} characters, hash ${s.hash}): the YAML is in "yaml".`, data: { project, ...s } };
  },
});

export const scenarioValidate = defineTool({
  name: 'scenario_validate',
  title: 'Validate scenario YAML',
  description:
    'Validate scenario YAML text against the project (page keys, personas, template) without saving it. Every issue has line and col in the given text. `retake schema scenario` / the README describe the scenario language.',
  input: z.strictObject({
    project: projectSlug,
    yaml: z.string().max(500_000).describe('The scenario YAML text.'),
    env: envName.optional().describe('Check page keys against this environment (default: the scenario env, else the project default).'),
    until: z.string().min(1).max(200).optional().describe('Check that this step reference (<scene>.<step id|index>) resolves.'),
    name: scenarioName.optional().describe('The name it will be saved under (only for messages).'),
  }),
  annotations: READ,
  async run({ project, yaml, env, until, name }, { engine }) {
    const r = await engine.scenarios.validate(project, yaml, { env, until, name });
    const errors = r.issues.filter((i) => i.severity === 'error').length;
    const warnings = r.issues.length - errors;
    return {
      summary: r.ok
        ? `Valid${warnings ? ` (${plural(warnings, 'warning')})` : ''}.${warnings ? `\n${r.issues.map(issueLine).join('\n')}` : ''}`
        : `Not valid: ${plural(errors, 'error')}${warnings ? `, ${plural(warnings, 'warning')}` : ''}.\n${r.issues.map(issueLine).join('\n')}`,
      data: { project, ...r },
    };
  },
});

export const scenarioSave = defineTool({
  name: 'scenario_save',
  title: 'Save a scenario',
  description:
    'Validate and write scenarios/<name>.yaml. Refused when the YAML has errors (the issues come back with line/col). Overwriting an existing scenario needs if_match: the hash scenario_get returned (a conflict names the current hash when it changed meanwhile); a new scenario takes if_match null or none.',
  input: z.strictObject({
    project: projectSlug,
    name: scenarioName,
    yaml: z.string().max(500_000).describe('The scenario YAML text.'),
    if_match: ifMatch.describe('Hash from scenario_get when the scenario exists; null or absent for a new one.'),
  }),
  annotations: WRITE_FILES,
  async run({ project, name, yaml, if_match }, { engine }) {
    const r = await engine.scenarios.save(project, name, yaml, { ifMatch: if_match });
    return {
      summary: `${r.created ? 'Created' : 'Saved'} ${r.path} (hash ${r.hash})${r.warnings.length ? ` with ${plural(r.warnings.length, 'warning')}:\n${r.warnings.map(issueLine).join('\n')}` : '.'}`,
      data: { project, ...r },
    };
  },
});

export const SCENARIO_TOOLS: ToolDef[] = [scenarioGet, scenarioValidate, scenarioSave];
