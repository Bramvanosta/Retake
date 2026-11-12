/**
 * The read operations the shells share (moved from the MCP server in L7.13): scenario_validate.
 */
import { z } from 'zod';
import { READ } from './annotations.js';
import { defineOperation } from './define.js';
import { envName, projectSlug, scenarioName } from './schema.js';
import { issueLine, plural } from './words.js';

export const scenarioValidate = defineOperation({
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
