import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYamlText, parseDocument } from 'yaml';
import { checkScenario } from './checks/scenario.js';
import { FORMAT_VERSIONS, newerFormatMessage } from './formats.js';
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
  const { value, issues } = checkYamlDocument(text, ScenarioSchema, (v, structural) => checkScenario(v, structural, opts), {}, { formatVersion: SCENARIO_FORMAT });
  return hasErrors(issues) ? { issues } : { scenario: value as Scenario, issues };
}

const SCENARIO_FORMAT = { file: 'scenario', supported: FORMAT_VERSIONS.scenario };

/** Validate an already-parsed scenario value (no line/col). */
export function validateScenario(s: unknown, opts: ScenarioCheckOptions = {}): ValidationIssue[] {
  const newer = newerFormatMessage(s, SCENARIO_FORMAT);
  if (newer) return [{ severity: 'error', path: ['version'], message: newer }];
  const structural = zodIssues(ScenarioSchema, s);
  return finalizeIssues([...structural, ...checkScenario(s, structural, opts)]);
}

function scenariosDir(project: Pick<LoadedProject, 'dir'>): string {
  return join(project.dir, 'scenarios');
}

/** The files a scenario name stands for, in the order they are looked up: scenarios/<name>.yaml, then .yml. */
function scenarioNameFiles(project: Pick<LoadedProject, 'dir'>, name: string): string[] {
  return [join(scenariosDir(project), `${name}.yaml`), join(scenariosDir(project), `${name}.yml`)];
}

/** "catalogue" → <project>/scenarios/catalogue.yaml; paths are taken relative to the project dir, then the cwd. */
async function resolveScenarioFile(project: LoadedProject, nameOrPath: string): Promise<string> {
  const pathLike = /[\\/]/.test(nameOrPath) || /\.ya?ml$/i.test(nameOrPath);
  const candidates = pathLike
    ? isAbsolute(nameOrPath)
      ? [nameOrPath]
      : [resolve(project.dir, nameOrPath), resolve(nameOrPath)]
    : scenarioNameFiles(project, nameOrPath);
  const found = candidates.find((c) => existsSync(c));
  if (found) return found;
  const available = await listScenarioNames(project.dir);
  const where = pathLike ? candidates.join(' or ') : scenariosDir(project);
  throw new ScenarioError(
    `scenario "${nameOrPath}" not found in ${where}${suggestion(nameOrPath, available)} (available: ${available.join(', ') || 'none'})`,
  );
}

/** The largest scenario file or snapshot scenarioChangedSinceRun compares (a scenario_save takes 500,000 characters). */
export const SCENARIO_COMPARE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * A small regular file read whole, or undefined: missing, a symbolic link, not a regular file (a FIFO or a device
 * would block the reader), over `max` bytes or unreadable. Opened without following a link and without blocking, then
 * checked on the open descriptor (no swap between the check and the read).
 */
function readSmallPlainFile(file: string, max: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return undefined;
    const text = readFileSync(fd, 'utf8');
    return Buffer.byteLength(text) > max ? undefined : text;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** JSON with object keys sorted (arrays keep their order): two YAML texts with the same data give the same string. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The data of a YAML text as canonical JSON; undefined when it does not parse cleanly. */
function yamlData(text: string): string | undefined {
  try {
    const doc = parseDocument(text);
    return doc.errors.length ? undefined : canonicalJson(doc.toJS());
  } catch {
    return undefined;
  }
}

/**
 * Whether a project's scenario changed since a run captured it (L3.8). A render reads the run — its timeline and its
 * snapshot `<run>/scenario.yaml` —, never the current file: a change to the scenario (steps, captions, timing, title,
 * intro / outro, template) shows only in a new capture. Compares `scenarios/<name>.yaml` (else `.yml`, as a name
 * resolves) with the snapshot by their data (comments, blank lines, quoting, indentation and key order are no change;
 * the text when either does not parse). Undefined when either file is missing, a symbolic link, not a regular file,
 * over SCENARIO_COMPARE_MAX_BYTES or unreadable: a run of a file elsewhere, a scenario since deleted, a run without a
 * snapshot.
 */
export function scenarioChangedSinceRun(project: Pick<LoadedProject, 'dir'>, runDir: string, scenario: string): boolean | undefined {
  if (scenario === '' || /[\\/]/.test(scenario)) return undefined;
  const file = scenarioNameFiles(project, scenario).find((f) => existsSync(f));
  if (!file) return undefined;
  const now = readSmallPlainFile(file, SCENARIO_COMPARE_MAX_BYTES);
  const then = now === undefined ? undefined : readSmallPlainFile(join(runDir, 'scenario.yaml'), SCENARIO_COMPARE_MAX_BYTES);
  if (now === undefined || then === undefined) return undefined;
  if (now === then) return false;
  const a = yamlData(now);
  const b = a === undefined ? undefined : yamlData(then);
  return a !== undefined && b !== undefined ? a !== b : true;
}

/**
 * What a plan or a render of a run says when its scenario changed since the capture: the render shows the run as
 * captured, `recapture` (the tool call or the command that films the scenario again) films the change. It names only
 * the scenario and the run id.
 */
export function scenarioChangedMessage(scenario: string, runId: string, recapture: string): string {
  return `scenario ${scenario} changed since run ${runId} was captured: a render shows the run as captured — a change to the scenario (steps, captions, timing, title, intro/outro, template) shows only in a new capture: ${recapture}, then render`;
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
