import { parse as parseYamlText, parseDocument } from 'yaml';
import { checkScenario } from './checks/scenario.js';
import { FORMAT_VERSIONS, newerFormatMessage } from './formats.js';
import type { ScenarioCheckFields, ScenarioCheckOptions } from './checks/scenario.js';
import type { CheckFiles } from './file-facts.js';
import { hasErrors, issuesMessage } from './issues.js';
import { ScenarioSchema } from './schemas/scenario.js';
import type { LoadedProject, LoadedScenario, Scenario, ValidationIssue } from './types.js';
import { checkYamlDocument } from './validation/document.js';
import { finalizeIssues } from './validation/located.js';
import { zodIssues } from './validation/zod-issues.js';
import { canonicalJson } from './canonical-json.js';
import { GUIDE, missingOrInvalid } from './error-kind.js';
import type { ErrorKind } from './error-kind.js';

export type { ScenarioCheckFields, ScenarioCheckOptions } from './checks/scenario.js';
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

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return missingOrInvalid(this.message, this.issues);
  }

  get errorDocs(): string {
    return GUIDE.scenarios;
  }
}

/**
 * Thrown when a scenario file's bytes are not the ones expected (`expectSha256`): nothing of them was parsed. Its message
 * names the file as `shown` (project-relative: `scenarios/quote.yaml`); `file` keeps the absolute path.
 */
export class ScenarioChangedError extends ScenarioError {
  constructor(
    file: string,
    public readonly expected: string,
    public readonly actual: string,
    shown: string = file,
  ) {
    super(`${shown} changed: its bytes have sha256 ${actual}, expected ${expected}`, [], file);
    this.name = 'ScenarioChangedError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  override get errorKind(): ErrorKind {
    return 'conflict';
  }

  /** The message a client gets: it may submit the work again. */
  get clientMessage(): string {
    return `${this.message}: submit it again`;
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

/** The data of a YAML text as canonical JSON (keys sorted, arrays in order); undefined when it does not parse cleanly. */
function yamlData(text: string): string | undefined {
  try {
    const doc = parseDocument(text);
    return doc.errors.length ? undefined : canonicalJson(doc.toJS());
  } catch {
    return undefined;
  }
}

/**
 * Whether two scenario texts (today's file, a run's snapshot) differ as data —
 * comments, blank lines, quoting, indentation and key order are no change; the text when either does not parse.
 * Undefined when there is no snapshot.
 */
export function scenarioTextChanged(now: string, then: string | undefined): boolean | undefined {
  if (then === undefined) return undefined;
  if (now === then) return false;
  const a = yamlData(now);
  const b = a === undefined ? undefined : yamlData(then);
  return a !== undefined && b !== undefined ? a !== b : true;
}

/** A scenario file as read: its bytes' sha256 and their text, from one read. */
export interface ScenarioSource {
  name: string;
  /** Absolute path of the YAML file. */
  file: string;
  text: string;
  /** sha256 (hex) of the bytes `text` was decoded from. */
  sha256: string;
}

/** The `env:` a scenario text names, read without validating it (undefined when it names none or does not parse). */
export function scenarioSourceEnv(text: string): string | undefined {
  let value: unknown;
  try {
    value = parseYamlText(text);
  } catch {
    return undefined; // the validation reports it
  }
  const env = value && typeof value === 'object' ? (value as { env?: unknown }).env : undefined;
  return typeof env === 'string' ? env : undefined;
}

/** Validate a scenario source of a project (its files looked at through `opts.files`). Throws ScenarioError on any error-level issue. */
export function parseScenarioSource(project: LoadedProject, src: ScenarioSource, opts: Omit<ScenarioCheckFields, 'project' | 'file' | 'files'> & { files: CheckFiles }): LoadedScenario {
  const { scenario, issues } = parseScenario(src.text, { ...opts, file: src.file, project });
  if (!scenario) throw new ScenarioError(issuesMessage('scenario', issues, src.file), issues, src.file);
  return { name: src.name, file: src.file, text: src.text, sha256: src.sha256, scenario, issues };
}
