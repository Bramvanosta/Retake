import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYamlText } from 'yaml';
import { checkScenario } from './checks/scenario.js';
import type { ScenarioCheckOptions } from './checks/scenario.js';
import { hasErrors, issuesMessage } from './issues.js';
import { listScenarioNames } from './project.js';
import { SLUG_RE } from './schemas/primitives.js';
import { ScenarioSchema } from './schemas/scenario.js';
import type { LoadedProject, LoadedScenario, Scenario, ValidationIssue } from './types.js';
import { writeTextAtomic } from './util.js';
import { checkYamlDocument } from './validation/document.js';
import { finalizeIssues } from './validation/located.js';
import { suggestion } from './validation/suggest.js';
import { zodIssues } from './validation/zod-issues.js';

export type { ScenarioCheckOptions } from './checks/scenario.js';
export { ARTEFACT_SLOTS, DOCUMENT_FILE_EXTENSIONS, isDocumentPath } from './checks/scenario.js';

/** Thrown when a scenario has error-level issues (or cannot be found / saved). */
export class ScenarioError extends Error {
  constructor(
    message: string,
    public readonly issues: ValidationIssue[] = [],
    public readonly file?: string,
  ) {
    super(message);
    this.name = 'ScenarioError';
  }
}

/**
 * YAML text → syntax → schema (precise per-action messages) → semantic checks. Every issue
 * carries line/col. `scenario` is returned only when there is no error-level issue.
 */
export function parseScenario(text: string, opts: ScenarioCheckOptions = {}): { scenario?: Scenario; issues: ValidationIssue[] } {
  const { value, issues } = checkYamlDocument(text, ScenarioSchema, (v, structural) => checkScenario(v, structural, opts));
  return hasErrors(issues) ? { issues } : { scenario: value as Scenario, issues };
}

/** Validate an already-parsed scenario value (no line/col). */
export function validateScenario(s: unknown, opts: ScenarioCheckOptions = {}): ValidationIssue[] {
  const structural = zodIssues(ScenarioSchema, s);
  return finalizeIssues([...structural, ...checkScenario(s, structural, opts)]);
}

function scenariosDir(project: LoadedProject): string {
  return join(project.dir, 'scenarios');
}

/** "catalogue" → <project>/scenarios/catalogue.yaml; paths are taken relative to the project dir, then the cwd. */
async function resolveScenarioFile(project: LoadedProject, nameOrPath: string): Promise<string> {
  const pathLike = /[\\/]/.test(nameOrPath) || /\.ya?ml$/i.test(nameOrPath);
  const candidates = pathLike
    ? isAbsolute(nameOrPath)
      ? [nameOrPath]
      : [resolve(project.dir, nameOrPath), resolve(nameOrPath)]
    : [join(scenariosDir(project), `${nameOrPath}.yaml`), join(scenariosDir(project), `${nameOrPath}.yml`)];
  const found = candidates.find((c) => existsSync(c));
  if (found) return found;
  const available = await listScenarioNames(project.dir);
  const where = pathLike ? candidates.join(' or ') : scenariosDir(project);
  throw new ScenarioError(
    `scenario "${nameOrPath}" not found in ${where}${suggestion(nameOrPath, available)} (available: ${available.join(', ') || 'none'})`,
  );
}

/** Load and validate a scenario of a project. Throws ScenarioError on any error-level issue. */
export async function loadScenario(
  project: LoadedProject,
  nameOrPath: string,
  opts: Omit<ScenarioCheckOptions, 'project' | 'file'> = {},
): Promise<LoadedScenario> {
  const file = await resolveScenarioFile(project, nameOrPath);
  const text = await readFile(file, 'utf8');
  const { scenario, issues } = parseScenario(text, { ...opts, file, project });
  if (!scenario) throw new ScenarioError(issuesMessage('scenario', issues, file), issues, file);
  return { name: basename(file).replace(/\.ya?ml$/i, ''), file, text, scenario, issues };
}

/**
 * The `env:` a scenario file names, read without validating it (undefined when it names none or cannot be read):
 * `run --sandbox` picks its sandbox from it, then validates the scenario once, against that environment.
 */
export async function scenarioEnvOf(project: LoadedProject, nameOrPath: string): Promise<string | undefined> {
  let value: unknown;
  try {
    value = parseYamlText(await readFile(await resolveScenarioFile(project, nameOrPath), 'utf8'));
  } catch {
    return undefined; // loadScenario reports it
  }
  const env = value && typeof value === 'object' ? (value as { env?: unknown }).env : undefined;
  return typeof env === 'string' ? env : undefined;
}

/**
 * Validate and write <project>/scenarios/<name>.yaml (atomically). Refuses to write when there is
 * an error-level issue: throws ScenarioError carrying the issues. Returns the warnings otherwise
 * and adds the name to `project.scenarios`.
 */
export async function saveScenario(
  project: LoadedProject,
  name: string,
  text: string,
): Promise<{ file: string; issues: ValidationIssue[] }> {
  if (!SLUG_RE.test(name)) {
    throw new ScenarioError(`invalid scenario name "${name}": use letters, digits, "-" or "_" (it becomes scenarios/<name>.yaml)`);
  }
  const file = join(scenariosDir(project), `${name}.yaml`);
  const { issues } = parseScenario(text, { file, project });
  if (hasErrors(issues)) {
    throw new ScenarioError(`not saved: ${issuesMessage('scenario', issues, file)}`, issues, file);
  }
  await writeTextAtomic(file, text.endsWith('\n') ? text : `${text}\n`);
  if (!project.scenarios.includes(name)) project.scenarios = [...project.scenarios, name].sort();
  return { file, issues };
}
