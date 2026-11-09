import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
import { relativeInside } from './path-inside.js';
import { canonicalJson } from './canonical-json.js';
import { GUIDE, missingOrInvalid } from './error-kind.js';
import type { ErrorKind } from './error-kind.js';

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

/** How a scenario file is read: once, hashed, and compared with an expected sha256 before it is parsed. */
export interface ScenarioReadOptions {
  /** sha256 (lower-case hex) the file's bytes must have; other bytes throw ScenarioChangedError, unparsed. */
  expectSha256?: string;
  /** Reads the file's bytes (default node:fs readFile; a test seam). Called once per load. */
  readFile?: (file: string) => Promise<Uint8Array>;
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

/** sha256 (hex) of some bytes. */
function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Read a scenario file once: its bytes are hashed, compared with `expectSha256` when given (ScenarioChangedError on a
 * difference) and decoded as UTF-8. Whatever uses the result works on those bytes, never on a later read of the file.
 */
export async function readScenarioSource(project: LoadedProject, nameOrPath: string, o: ScenarioReadOptions = {}): Promise<ScenarioSource> {
  const file = await resolveScenarioFile(project, nameOrPath);
  const bytes = await (o.readFile ?? readFile)(file);
  const sha256 = sha256Of(bytes);
  if (o.expectSha256 !== undefined && o.expectSha256 !== sha256) {
    const shown = relativeInside(file, project.dir, { self: false, dotDotPrefix: true })?.split(sep).join('/') ?? basename(file);
    throw new ScenarioChangedError(file, o.expectSha256, sha256, shown);
  }
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  return { name: basename(file).replace(/\.ya?ml$/i, ''), file, text, sha256 };
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

/** Validate a scenario source of a project. Throws ScenarioError on any error-level issue. */
export function parseScenarioSource(project: LoadedProject, src: ScenarioSource, opts: Omit<ScenarioCheckOptions, 'project' | 'file'> = {}): LoadedScenario {
  const { scenario, issues } = parseScenario(src.text, { ...opts, file: src.file, project });
  if (!scenario) throw new ScenarioError(issuesMessage('scenario', issues, src.file), issues, src.file);
  return { name: src.name, file: src.file, text: src.text, sha256: src.sha256, scenario, issues };
}

/**
 * Load and validate a scenario of a project, from one read of its file (readScenarioSource: `expectSha256` pins its
 * bytes). Throws ScenarioError on any error-level issue, ScenarioChangedError on other bytes than expected.
 */
export async function loadScenario(
  project: LoadedProject,
  nameOrPath: string,
  opts: Omit<ScenarioCheckOptions, 'project' | 'file'> & ScenarioReadOptions = {},
): Promise<LoadedScenario> {
  const { expectSha256, readFile: read, ...check } = opts;
  const src = await readScenarioSource(project, nameOrPath, { ...(expectSha256 !== undefined ? { expectSha256 } : {}), ...(read ? { readFile: read } : {}) });
  return parseScenarioSource(project, src, check);
}

/**
 * The `env:` a scenario file names, read without validating it (undefined when it names none or cannot be read).
 */
export async function scenarioEnvOf(project: LoadedProject, nameOrPath: string): Promise<string | undefined> {
  try {
    return scenarioSourceEnv((await readScenarioSource(project, nameOrPath)).text);
  } catch {
    return undefined; // loadScenario reports it
  }
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
