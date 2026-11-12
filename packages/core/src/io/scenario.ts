/**
 * The scenario readers: a scenario name or path resolved in a project, its file read once (hashed, compared with an
 * expected sha256) and validated.
 */
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { ScenarioCheckOptions } from '../checks/scenario.js';
import type { WorkFileFacts, WorkspaceDisk } from '../file-facts.js';
import { projectPath } from '../layout.js';
import { relativeInside } from '../path-inside.js';
import { ScenarioChangedError, ScenarioError, parseScenarioSource, scenarioSourceEnv } from '../scenario.js';
import type { ScenarioSource } from '../scenario.js';
import type { LoadedProject, LoadedScenario } from '../types.js';
import { suggestion } from '../validation/suggest.js';
import { nodeWorkspaceDisk } from './file-facts.js';
import { listScenarioNamesOn } from './project.js';

function scenariosDir(project: Pick<LoadedProject, 'dir'>): string {
  return projectPath(project.dir, 'scenarios');
}

/** The files a scenario name stands for, in the order they are looked up: scenarios/<name>.yaml, then .yml. */
function scenarioNameFiles(project: Pick<LoadedProject, 'dir'>, name: string): string[] {
  return [join(scenariosDir(project), `${name}.yaml`), join(scenariosDir(project), `${name}.yml`)];
}

/** "catalogue" → <project>/scenarios/catalogue.yaml; paths are taken relative to the project dir, then the cwd. */
async function resolveScenarioFile(disk: WorkspaceDisk, project: LoadedProject, nameOrPath: string): Promise<string> {
  const pathLike = /[\\/]/.test(nameOrPath) || /\.ya?ml$/i.test(nameOrPath);
  const candidates = pathLike ? (isAbsolute(nameOrPath) ? [nameOrPath] : [resolve(project.dir, nameOrPath), resolve(nameOrPath)]) : scenarioNameFiles(project, nameOrPath);
  const found = candidates.find((c) => disk.facts.kind(c) !== undefined);
  if (found) return found;
  const available = await listScenarioNamesOn(disk, project.dir);
  const where = pathLike ? candidates.join(' or ') : scenariosDir(project);
  throw new ScenarioError(`scenario "${nameOrPath}" not found in ${where}${suggestion(nameOrPath, available)} (available: ${available.join(', ') || 'none'})`);
}

/** How a scenario file is read: once, hashed, and compared with an expected sha256 before it is parsed. */
export interface ScenarioReadOptions {
  /** sha256 (lower-case hex) the file's bytes must have; other bytes throw ScenarioChangedError, unparsed. */
  expectSha256?: string;
  /** Reads the file's bytes (default: the disk's readFile; a test seam). Called once per load. */
  readFile?: (file: string) => Promise<Uint8Array>;
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
  return readScenarioSourceOn(nodeWorkspaceDisk, project, nameOrPath, o);
}

/** readScenarioSource on a disk. */
export async function readScenarioSourceOn(disk: WorkspaceDisk, project: LoadedProject, nameOrPath: string, o: ScenarioReadOptions = {}): Promise<ScenarioSource> {
  const file = await resolveScenarioFile(disk, project, nameOrPath);
  const bytes = await (o.readFile ? o.readFile(file) : disk.readFile(file));
  const sha256 = sha256Of(bytes);
  if (o.expectSha256 !== undefined && o.expectSha256 !== sha256) {
    const shown = relativeInside(file, project.dir, { self: false, dotDotPrefix: true })?.split(sep).join('/') ?? basename(file);
    throw new ScenarioChangedError(file, o.expectSha256, sha256, shown);
  }
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  return { name: basename(file).replace(/\.ya?ml$/i, ''), file, text, sha256 };
}

/**
 * Load and validate a scenario of a project, from one read of its file (readScenarioSource: `expectSha256` pins its
 * bytes). `files` looks at the files it names (core FileFacts; fileFacts(policy) of the work that loads it, whose
 * VideoProber checks its video files) — always given, never a default. Throws ScenarioError on any error-level issue,
 * ScenarioChangedError on other bytes than expected.
 */
export async function loadScenario(project: LoadedProject, nameOrPath: string, opts: ScenarioLoadOptions): Promise<LoadedScenario> {
  return loadScenarioOn(nodeWorkspaceDisk, project, nameOrPath, opts);
}

/** How loadScenario checks and reads a scenario: its checks' options, its read's, and its checks' FileFacts. */
export type ScenarioLoadOptions = Omit<ScenarioCheckOptions, 'project' | 'file' | 'files'> & ScenarioReadOptions & { files: WorkFileFacts };

/** loadScenario on a disk. */
export async function loadScenarioOn(disk: WorkspaceDisk, project: LoadedProject, nameOrPath: string, opts: ScenarioLoadOptions): Promise<LoadedScenario> {
  const { expectSha256, readFile: read, ...check } = opts;
  const src = await readScenarioSourceOn(disk, project, nameOrPath, { ...(expectSha256 !== undefined ? { expectSha256 } : {}), ...(read ? { readFile: read } : {}) });
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
