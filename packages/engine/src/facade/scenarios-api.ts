/** The façade's `scenarios` (createEngine): read, validate and check, the scenario screen's view and actions, save and edit, a draft from a script. */
import { editScenario, getScenario, saveScenarioText, validateScenarioText } from '../scenarios.js';
import { draftFromScript } from '../authoring.js';
import { runBlockers } from '../jobs/run-job.js';
import { memoRegistry } from '../timeline-view.js';
import type { EngineContext } from './context.js';
import type { Engine } from './types.js';

/** engine.scenarios: what an agent writes is checked as the work it submits will be. */
export function scenariosApi(ctx: EngineContext): Engine['scenarios'] {
  const { agent, via, ws, scope, project, submitCtx, views } = ctx;
  return {
    get: async (slug, name) => getScenario(await project(slug), name),
    // What an agent (the MCP server, the Studio app) writes is checked as the work it submits will be (core agent-trust).
    validate: async (slug, yaml, o) => validateScenarioText(await project(slug), yaml, { ...o, agent, via }),
    check: async (slug, name, o = {}) => {
      const p = await project(slug);
      const text = await getScenario(p, name);
      const { ok, issues } = await validateScenarioText(p, text.yaml, { name, ...(o.env !== undefined ? { env: o.env } : {}) });
      const run_blockers = await runBlockers(submitCtx, { project: slug, scenario: name, ...(o.env !== undefined ? { env: o.env } : {}) });
      return { ...text, ok, issues, run_blockers };
    },
    view: (slug, name, o = {}) => views.view(slug, name, o),
    actions: (slug, name, o = {}) => views.actions(slug, name, o),
    save: async (slug, name, yaml, o) => saveScenarioText(await project(slug), name, yaml, { ...o, agent, via, scope }),
    edit: async (slug, name, req) => editScenario(await project(slug), name, req, { agent, via, registry: async () => (await memoRegistry(ws)).registry, scope }),
    fromScript: async (slug, markdown, o) => draftFromScript(await project(slug), markdown, { ...o, agent }),
  };
}
