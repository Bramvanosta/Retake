/**
 * Authoring aids (L3.3): a timecoded script table turned into an outline and a draft scenario (core
 * draftScenarioFromScript), the draft then validated against the project like any scenario text. Deterministic, no
 * model call, nothing written: saving stays scenario_save (if_match). The main path is Claude writing the scenario from
 * page inspections; this is a skeleton for when the user hands a table.
 */
import { draftScenarioFromScript, resolveEnvironment } from '@demo-studio/core';
import type { LoadedProject, ScriptIssue, ScriptOutline } from '@demo-studio/core';
import { checkScenarioName } from './refs.js';
import { validateScenarioText } from './scenarios.js';
import type { ValidateResult } from './scenarios.js';

export interface ScriptDraftView {
  project: string;
  /** The environment whose page keys the `page` column was mapped to. */
  env: string;
  /** The draft's video name (the scenario name it is meant to be saved under). */
  name: string;
  outline: ScriptOutline;
  /** The draft scenario ("" when the script has no usable table). */
  yaml: string;
  /** Problems of the script, positioned in the Markdown (line, col). */
  script_issues: ScriptIssue[];
  /** The draft validated against the project (issues positioned in the YAML); not ok when there is no draft. */
  validation: ValidateResult;
}

/** Parse a script, draft a scenario and validate it (`agent`: the MCP server's rules for what an agent writes). */
export async function draftFromScript(
  project: LoadedProject,
  markdown: string,
  opts: { env?: string; name?: string; agent?: boolean } = {},
): Promise<ScriptDraftView> {
  const name = opts.name ?? 'draft';
  checkScenarioName(name);
  const env = resolveEnvironment(project, opts.env);
  const d = draftScenarioFromScript(markdown, { env, video: name });
  const validation = d.yaml
    ? await validateScenarioText(project, d.yaml, { env: env.name, name, ...(opts.agent ? { agent: true } : {}) })
    : { ok: false, issues: [] };
  return { project: project.slug, env: env.name, name, outline: d.outline, yaml: d.yaml, script_issues: d.issues, validation };
}
