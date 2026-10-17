/** Scenarios of a project for clients outside the CLI: read with a hash, validate text, save with `if_match`. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ScenarioError, agentTrustProblems, hasErrors, issuesMessage, loadProjectTemplate, parseScenario } from '@demo-studio/core';
import type { LoadedProject, Scenario, Template, ValidationIssue } from '@demo-studio/core';
import { EngineError } from './errors.js';
import { checkScenarioName } from './refs.js';
import { LocalStorage } from './storage.js';

export interface ScenarioText {
  name: string;
  /** Project-relative ref (scenarios/<name>.yaml or .yml). */
  file: string;
  path: string;
  yaml: string;
  /** sha256 of the file's bytes: the `if_match` of a save. */
  hash: string;
}

/** The file of a scenario name: scenarios/<name>.yaml, else an existing scenarios/<name>.yml. */
function scenarioRef(project: LoadedProject, name: string): string {
  const yml = `scenarios/${name}.yml`;
  if (!existsSync(join(project.dir, 'scenarios', `${name}.yaml`)) && existsSync(join(project.dir, yml))) return yml;
  return `scenarios/${name}.yaml`;
}

export async function getScenario(project: LoadedProject, name: string): Promise<ScenarioText> {
  checkScenarioName(name);
  const storage = new LocalStorage(project.dir);
  const ref = scenarioRef(project, name);
  const read = await storage.readText(ref);
  if (!read) {
    throw new EngineError('not_found', `scenario "${name}" not found in ${project.slug} (scenarios: ${project.scenarios.join(', ') || 'none'})`);
  }
  return { name, file: ref, path: storage.resolve(ref), yaml: read.text, hash: read.sha256 };
}

/** The project's template, for the checks that need it (theme slots, components); undefined when it does not load. */
async function templateOf(project: LoadedProject): Promise<Template | undefined> {
  try {
    return (await loadProjectTemplate(project)).template;
  } catch {
    return undefined;
  }
}

export interface ValidateResult {
  ok: boolean;
  /** Errors and warnings, each with line / col in the given text when known. */
  issues: ValidationIssue[];
}

/**
 * What an agent may not write in a scenario (work submitted through MCP, core agent-trust): secret references, files
 * outside the project, code from agent-writable files — as error issues.
 */
function agentIssues(project: LoadedProject, scenario: Scenario | undefined): ValidationIssue[] {
  return scenario ? agentTrustProblems(project, scenario).map((message) => ({ severity: 'error' as const, path: [], message })) : [];
}

/**
 * Validate scenario text against the project (pages, personas, template), without saving it. `agent` (the MCP
 * server's engine): what work submitted through MCP may not use is an error too.
 */
export async function validateScenarioText(
  project: LoadedProject,
  yaml: string,
  opts: { env?: string; until?: string; name?: string; agent?: boolean } = {},
): Promise<ValidateResult> {
  if (opts.name !== undefined) checkScenarioName(opts.name);
  const file = join(project.dir, 'scenarios', `${opts.name ?? 'untitled'}.yaml`);
  const { scenario, issues: parsed } = parseScenario(yaml, {
    file,
    project,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.until !== undefined ? { until: opts.until } : {}),
    template: await templateOf(project),
  });
  const issues = opts.agent ? [...parsed, ...agentIssues(project, scenario)] : parsed;
  return { ok: !hasErrors(issues), issues };
}

export interface SaveResult {
  name: string;
  file: string;
  path: string;
  /** sha256 of the bytes written (a final newline is added when missing). */
  hash: string;
  created: boolean;
  warnings: ValidationIssue[];
}

/**
 * Validate and write scenarios/<name>.yaml. Error-level issues refuse the save (ScenarioError, as core saveScenario).
 * `ifMatch`: required when the file exists (its hash from scenario_get: a conflict otherwise, naming the current hash);
 * null (or absent) for a new file, which must not exist when written. An existing scenarios/<name>.yml is refused
 * (a new .yaml would shadow it).
 */
export async function saveScenarioText(project: LoadedProject, name: string, yaml: string, opts: { ifMatch?: string | null; agent?: boolean } = {}): Promise<SaveResult> {
  checkScenarioName(name);
  const ref = `scenarios/${name}.yaml`;
  if (existsSync(join(project.dir, 'scenarios', `${name}.yml`))) {
    throw new EngineError('conflict', `scenarios/${name}.yml exists: a scenarios/${name}.yaml would shadow it — rename or remove the .yml file first (by hand)`);
  }
  const storage = new LocalStorage(project.dir);
  const path = storage.resolve(ref);
  const { scenario, issues: parsed } = parseScenario(yaml, { file: path, project, template: await templateOf(project) });
  const issues = opts.agent ? [...parsed, ...agentIssues(project, scenario)] : parsed;
  if (hasErrors(issues)) throw new ScenarioError(`not saved: ${issuesMessage('scenario', issues, path)}`, issues, path);
  const current = await storage.readText(ref);
  if (current && (opts.ifMatch === undefined || opts.ifMatch === null)) {
    throw new EngineError('conflict', `${ref} exists: pass if_match with the hash you read (scenario_get), so a change made meanwhile is not lost`, {
      details: { current: current.sha256 },
      fix: `if_match: "${current.sha256}"`,
    });
  }
  const text = yaml.endsWith('\n') ? yaml : `${yaml}\n`;
  const res = await storage.writeText(ref, text, { ifMatch: opts.ifMatch ?? null });
  if (!project.scenarios.includes(name)) project.scenarios = [...project.scenarios, name].sort();
  return { name, file: res.ref, path: res.path, hash: res.sha256, created: !current, warnings: issues };
}
