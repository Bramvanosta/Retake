import { z } from 'zod';
import { OPERATIONS_BY_NAME, issueLine } from '@retake/engine/contract';
import { ifMatch, projectSlug, scenarioName } from '../schema.js';
import { plural } from '../result.js';
import { WRITE_FILES, defineTool } from './define.js';
import type { ToolDef } from './define.js';

const { scenario_get: scenarioGet, scenario_validate: scenarioValidate } = OPERATIONS_BY_NAME;

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

export const SCENARIO_TOOLS = [scenarioGet, scenarioValidate, scenarioSave] as const satisfies readonly ToolDef[];
