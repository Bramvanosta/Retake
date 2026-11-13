/** Scenarios of a project for clients outside the CLI: read with a hash, validate text, save with `if_match`. */
import { existsSync, readdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { hasErrors, issuesMessage, parseYaml, pathInside } from '@retake/core/base';
import { resolveEnvironment } from '@retake/core/environment';
import { projectPath, projectRef, scenarioFile, scenarioRef } from '@retake/core/project';
import {
  SCENARIO_EDIT_MAX_CHARS,
  ScenarioError,
  StepEditError,
  agentTrustProblemsAt,
  applyFieldEdit,
  applyStepEdit,
  changedHookInputs,
  changedHookSections,
  filmedChangesOf,
  hookInputsChangedMessage,
  hooksChangedMessage,
  newHiddenCharProblem,
  parseScenario,
  textEol,
  verifyEditText,
} from '@retake/core/scenario';
import { nodeFileFacts } from '@retake/core/io';
import type { LoadedProject, Scenario, Template, ValidationIssue, WorkFileFacts } from '@retake/core/model';
import type { AgentTrustEnvironment, FieldEdit, PositionedTrustProblem, StepEdit } from '@retake/core/scenario';
import type { AgentChannel } from './caller.js';
import type { ComponentRegistry } from '@retake/components';
import { recordScenarioWrite } from './agent-written.js';
import { components } from './components.js';
import { EngineError } from './errors.js';
import { fieldFitProblem } from './field-options.js';
import { checkScenarioName } from './refs.js';
import { LocalStorage, sha256Hex } from './storage.js';
import { storeOf } from './store/store.js';
import type { StoreScope } from './store/store.js';
import { confinementOf } from './caller.js';
import type { WorkspaceReads } from './workspace-reads/reads.js';

export interface ScenarioText {
  name: string;
  /** Project-relative ref (scenarios/<name>.yaml or .yml). */
  file: string;
  path: string;
  yaml: string;
  /** sha256 of the file's bytes: the `if_match` of a save. */
  hash: string;
  /** Its bytes are valid UTF-8 (when not, `yaml` has U+FFFD in place of what could not be decoded: never saved back). */
  utf8: boolean;
  /**
   * Set when the file is a symbolic link to a file of the project outside scenarios/ (its project-relative path): the
   * Studio never writes through it (review A L1: a scenario linked to a hook script would be written into the script).
   */
  linked_to?: string;
}

/**
 * The entry of scenarios/ that `ref` names on a case-insensitive disk when it is not spelt `ref`'s way ("quote.yaml"
 * for scenarios/QUOTE.yaml), else null (review A M1: two spellings of one file were two names — two write locks, and a
 * save renamed the file).
 */
function caseTwin(project: LoadedProject, ref: string): string | null {
  const want = basename(ref);
  let names: string[];
  try {
    names = readdirSync(projectPath(project.dir, 'scenarios'));
  } catch {
    return null;
  }
  if (names.includes(want)) return null;
  return names.find((n) => n.toLowerCase() === want.toLowerCase()) ?? null;
}

// The versions of each scenario file this process showed (getScenario) or wrote (review A L3): undo / redo `restore`
// only these — an earlier version the person had on disk may hold a hidden character today's file no longer has.
const VERSIONS_PER_FILE = 128;
const VERSION_FILES = 256;
const versions = new Map<string, string[]>();

function rememberVersion(path: string, hash: string): void {
  const list = versions.get(path) ?? [];
  versions.delete(path);
  const at = list.indexOf(hash);
  if (at !== -1) list.splice(at, 1);
  list.push(hash);
  if (list.length > VERSIONS_PER_FILE) list.shift();
  versions.set(path, list);
  if (versions.size > VERSION_FILES) versions.delete(versions.keys().next().value!);
}

/** Whether this process showed or wrote that version of the file (`path`: getScenario's). */
export function knownScenarioVersion(path: string, hash: string): boolean {
  return versions.get(path)?.includes(hash) ?? false;
}

/** The file of a scenario name: scenarios/<name>.yaml, else an existing scenarios/<name>.yml. */
function existingScenarioRef(project: LoadedProject, name: string): string {
  const yml = scenarioRef(name, '.yml');
  if (!existsSync(scenarioFile(project.dir, name)) && existsSync(scenarioFile(project.dir, name, '.yml'))) return yml;
  return scenarioRef(name);
}

export async function getScenario(project: LoadedProject, name: string): Promise<ScenarioText> {
  checkScenarioName(name);
  const storage = new LocalStorage(project.dir);
  const ref = existingScenarioRef(project, name);
  const twin = caseTwin(project, ref);
  if (twin) throw new EngineError('not_found', `scenario "${name}" not found in ${project.slug}: the file is scenarios/${twin} (scenario names are case-sensitive)`);
  const read = await storage.readText(ref);
  if (!read) {
    throw new EngineError('not_found', `scenario "${name}" not found in ${project.slug} (scenarios: ${project.scenarios.join(', ') || 'none'})`);
  }
  const path = storage.resolve(ref);
  const [realScenarios, real, realProject] = await Promise.all([realpath(projectPath(project.dir, 'scenarios')), realpath(path), realpath(project.dir)]);
  rememberVersion(path, read.sha256);
  return {
    name,
    file: ref,
    path,
    yaml: read.text,
    hash: read.sha256,
    utf8: read.utf8,
    ...(pathInside(real, realScenarios, { dotDotPrefix: true }) ? {} : { linked_to: relative(realProject, real).split('\\').join('/') }),
  };
}

/** The project's template, for the checks that need it (theme slots, components); undefined when it does not load. */
async function templateOf(project: LoadedProject, o: { reads: WorkspaceReads; files: WorkFileFacts }): Promise<Template | undefined> {
  try {
    return (await o.reads.loadProjectTemplate(project, undefined, { files: o.files })).template;
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
 * What an agent may not write in a scenario (work submitted through MCP or from the Studio, core agent-trust): secret
 * references, files outside the project, code from agent-writable files — as error issues placed at their line (L4.3,
 * critique B11), worded for the channel (`via`: "through MCP" / "from the Studio"). With `env` (a validation that
 * knows the environment), a URL on another origin than its pages too, as the run would refuse it; a save has none.
 */
function agentIssues(project: LoadedProject, scenario: Scenario | undefined, text: string, via: AgentChannel | undefined, env?: AgentTrustEnvironment): ValidationIssue[] {
  return scenario ? agentTrustProblemsAt(project, scenario, text, { files: nodeFileFacts, ...(via ? { via: confinementOf(via) } : {}), ...(env ? { env } : {}) }).map((p) => trustIssue(p)) : [];
}

/** The environment a validation names (its `env`, else the scenario's own `env:`), resolved; undefined when none or unknown. */
function knownEnvironment(project: LoadedProject, scenario: Scenario | undefined, env: string | undefined): AgentTrustEnvironment | undefined {
  const name = env ?? (typeof scenario?.env === 'string' ? scenario.env : undefined);
  if (name === undefined) return undefined;
  try {
    return resolveEnvironment(project, name);
  } catch {
    return undefined;
  }
}

function trustIssue(p: PositionedTrustProblem): ValidationIssue {
  return { severity: 'error', path: p.path, message: p.message, ...(p.line !== undefined ? { line: p.line, col: p.col ?? 1 } : {}) };
}

/**
 * Validate scenario text against the project (pages, personas, template), without saving it. `agent` (the MCP
 * server's engine): what work submitted through MCP may not use is an error too.
 */
export async function validateScenarioText(
  project: LoadedProject,
  yaml: string,
  opts: { files: WorkFileFacts; reads: WorkspaceReads; env?: string; until?: string; name?: string; agent?: boolean; via?: AgentChannel; filesRead?: Set<string> },
): Promise<ValidateResult> {
  if (opts.name !== undefined) checkScenarioName(opts.name);
  const file = scenarioFile(project.dir, opts.name ?? 'untitled');
  const { scenario, issues: parsed } = parseScenario(yaml, {
    files: opts.files,
    file,
    project,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.until !== undefined ? { until: opts.until } : {}),
    template: await templateOf(project, opts),
    ...(opts.agent ? { confined: confinementOf(opts.via ?? 'mcp') } : {}),
    ...(opts.filesRead ? { filesRead: opts.filesRead } : {}),
  });
  const issues = opts.agent ? [...parsed, ...agentIssues(project, scenario, yaml, opts.via, knownEnvironment(project, scenario, opts.env))] : parsed;
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
export async function saveScenarioText(
  project: LoadedProject,
  name: string,
  yaml: string,
  opts: { ifMatch?: string | null; agent?: boolean; via?: AgentChannel; scope: StoreScope; files: WorkFileFacts; reads: WorkspaceReads },
): Promise<SaveResult> {
  checkScenarioName(name);
  const ref = scenarioRef(name);
  if (existsSync(scenarioFile(project.dir, name, '.yml'))) {
    throw new EngineError('conflict', `${scenarioRef(name, '.yml')} exists: a ${ref} would shadow it — rename or remove the .yml file first (by hand)`);
  }
  const twin = caseTwin(project, ref);
  if (twin) {
    throw new EngineError('conflict', `${projectRef('scenarios', twin)} exists: on this disk ${ref} is the same file under another spelling — save it as "${twin.replace(/\.ya?ml$/, '')}"`);
  }
  const store = storeOf(project, opts.scope);
  const path = store.resolve(ref);
  if (opts.agent) {
    const linked = await realpath(path).then(
      async (real) => (pathInside(real, await realpath(projectPath(project.dir, 'scenarios')), { dotDotPrefix: true }) ? null : real),
      () => null,
    );
    if (linked) throw new EngineError('refused', `${ref} is a symbolic link to a file outside scenarios/: an agent writes scenarios only inside scenarios/ — edit it in your editor`);
  }
  const { scenario, issues: parsed } = parseScenario(yaml, {
    files: opts.files,
    file: path,
    project,
    template: await templateOf(project, opts),
    ...(opts.agent ? { confined: confinementOf(opts.via ?? 'mcp') } : {}),
  });
  const issues = opts.agent ? [...parsed, ...agentIssues(project, scenario, yaml, opts.via)] : parsed;
  if (hasErrors(issues)) throw new ScenarioError(`not saved: ${issuesMessage('scenario', issues, path)}`, issues, path);
  const current = await store.readText(ref);
  if (current && (opts.ifMatch === undefined || opts.ifMatch === null)) {
    throw new EngineError('conflict', `${ref} exists: pass if_match with the hash you read (scenario_get), so a change made meanwhile is not lost`, {
      details: { current: current.sha256 },
      fix: `if_match: "${current.sha256}"`,
    });
  }
  const text = yaml.endsWith('\n') ? yaml : `${yaml}\n`;
  const res = await store.writeText(ref, text, { ifMatch: opts.ifMatch ?? null, what: 'scenario' });
  rememberVersion(path, res.sha256);
  // L7.27: the project's record of what this write did to the scenario's hook surface, and who made it.
  if (scenario) {
    const before = current?.utf8 ? parseScenario(current.text, { files: opts.files, file: path, project, template: await templateOf(project, opts) }).scenario : undefined;
    await recordScenarioWrite(project, { file: res.path, sha256: res.sha256, scenario, before: before ?? null, caller: opts.scope.caller, clock: opts.scope.clock, stores: opts.scope.stores });
  }
  if (!project.scenarios.includes(name)) project.scenarios = [...project.scenarios, name].sort();
  return { name, file: res.ref, path: res.path, hash: res.sha256, created: !current, warnings: issues };
}

/** One edit of a saved scenario: one of core SCENARIO_EDIT_KINDS (scenario-edit.ts holds the rules every kind obeys). */
export type ScenarioEdit =
  /** The YAML view's text: written as given, with a final line break added when it has none (as scenario_save). */
  | { kind: 'replace_text'; text: string }
  /** Undo / redo: the exact bytes of an earlier version (`text_hash`: their sha256, checked), no line break added. */
  | { kind: 'restore'; text: string; text_hash: string }
  /** The Blocks tab: move, delete, duplicate, change or add a step (core step-edits.ts: text splices, verified). */
  | StepEdit
  /** The timeline (L4.5): one edit value of the video, a scene, a card or an interstitial (core field-edits.ts, verified). */
  | FieldEdit;

/** engine.scenarios.edit: one edit of a saved scenario, applied to the version the client showed (`hash`). */
export interface ScenarioEditRequest {
  /** sha256 of the file as the client read it (scenario_blocks / scenario_get): a conflict otherwise, naming the current one. */
  hash: string;
  edit: ScenarioEdit;
}

export interface ScenarioEditResult {
  name: string;
  /** The file written: the one the view read (scenarios/<name>.yaml, or an existing .yml — never a new file). */
  file: string;
  path: string;
  /** sha256 of the bytes written: the next edit's `hash` (and undo's `hashAfter`). */
  hash: string;
  /** What was done, for the screen and its undo stack: "Saved the YAML", "Restored an earlier version". */
  label: string;
  /** The step to select after the edit ("<scene>.<index>": the moved step, its copy, the delete's neighbour), or null. */
  select: string | null;
  warnings: ValidationIssue[];
  notices: string[];
  /**
   * A block or field edit's kind of change (L5.5's rule): `filmed` (what the browser does: a dry run shows it, a capture
   * films it) or `edit` (a caption, a speed, a mark, a layout: a render of the same run re-plans it). Absent for the YAML
   * tab and undo. A field edit (`set_field`, L4.5) is always `edit`.
   */
  change?: 'filmed' | 'edit';
}

/**
 * Why the Studio (an agent channel) may not save this file at all, with each problem's line (critique B3: the YAML view
 * read-only when the file is blocked; B11 lines), or null: not UTF-8 (a save would replace bytes with U+FFFD), larger
 * than SCENARIO_EDIT_MAX_CHARS, holding a carriage return without a line feed (review A M2), a link to a file outside
 * scenarios/ (review A L1, agent channels), or holding what agent trust refuses (a secret reference, an outside file,
 * code in an agent-writable file, a template folder) — the person edits such a file in their editor.
 */
export function scenarioEditBlocker(
  project: LoadedProject,
  file: Pick<ScenarioText, 'file' | 'yaml' | 'utf8' | 'linked_to'>,
  scenario: Scenario | undefined,
  o: { agent: boolean; via: AgentChannel },
): { why: string; problems: Array<{ line?: number; message: string }> } | null {
  if (!file.utf8) {
    return { why: `${file.file} is not UTF-8 text: saving it here would replace the bytes that cannot be read with U+FFFD — edit it in your editor`, problems: [] };
  }
  if (file.yaml.length > SCENARIO_EDIT_MAX_CHARS) {
    return {
      why: `${file.file} holds ${file.yaml.length.toLocaleString('en')} characters: the Studio edits scenarios of at most ${SCENARIO_EDIT_MAX_CHARS.toLocaleString('en')} — edit it in your editor`,
      problems: [],
    };
  }
  const cr = /\r(?!\n)/.exec(file.yaml);
  if (cr) {
    // Review A M2: a text editor (the YAML view's textarea included) shows a line break where YAML reads none — the
    // file's text and what it runs differ, and a save from the tab would turn a comment into a step.
    const line = file.yaml.slice(0, cr.index).split('\n').length;
    return {
      why: `${file.file} holds a carriage return without a line feed (line ${line}): an editor shows a line break there, YAML reads none — fix its line breaks in your editor (LF or CR LF); the Studio shows it read-only.`,
      problems: [{ line, message: 'a carriage return without a line feed (CR): an editor shows a line break here, YAML reads none' }],
    };
  }
  if (!o.agent) return null;
  if (file.linked_to !== undefined) {
    return {
      why: `${file.file} is a symbolic link to ${file.linked_to}, outside scenarios/: the Studio writes scenarios only inside scenarios/ — edit it in your editor; the Studio shows it read-only.`,
      problems: [],
    };
  }
  if (!scenario) return null;
  const problems = agentTrustProblemsAt(project, scenario, file.yaml, { via: confinementOf(o.via), files: nodeFileFacts });
  if (!problems.length) return null;
  const first = problems[0];
  return {
    why:
      `${file.file} holds what the Studio never writes${first.line !== undefined ? ` (line ${first.line}${problems.length > 1 ? ` and ${problems.length - 1} more` : ''})` : ''}: ` +
      'a secret reference, a file outside the project or code an agent can write. Edit this file in your editor (move a secret to project.yaml); the Studio shows it read-only.',
    problems: problems.map((p) => ({ ...(p.line !== undefined ? { line: p.line } : {}), message: p.message })),
  };
}

/**
 * Apply one edit to a saved scenario for the Studio (L4.3; MCP writes with scenario_save): the file the view read, its
 * hash as if_match (a conflict otherwise, naming the current hash), refused whole when the file itself is blocked
 * (scenarioEditBlocker), the new text checked — no hidden character added (critique B9), hooks and mocks unchanged
 * (critique B3, agent channels), the scenario validated against the project with agent trust worded for the channel
 * (errors refuse the save with their lines, warnings come back) — then written atomically, keeping the file's mode,
 * under the write lock (storage writeText). `replace_text` adds a final line break (the file's own) when missing;
 * `restore` writes the bytes given, which must have `text_hash` (undo / redo: byte-exact); a step edit (move, delete,
 * duplicate, a form's field changes, a new step from the palette: core applyStepEdit) splices the file and is refused unless the result re-parses to exactly the intended
 * value (core verifyEditText) — a step no longer where the edit says (its guard), or a field no longer holding what the
 * form showed (critique B2), is a conflict with `details.stale`.
 */
export async function editScenario(
  project: LoadedProject,
  name: string,
  req: ScenarioEditRequest,
  o: { agent: boolean; via: AgentChannel; registry?: () => Promise<ComponentRegistry>; scope: StoreScope; files: WorkFileFacts; reads: WorkspaceReads },
): Promise<ScenarioEditResult> {
  const p = await prepareScenarioEdit(project, name, req, o);
  const res = await storeOf(project, o.scope).writeText(p.base.file, p.text, { ifMatch: req.hash, what: 'scenario' });
  rememberVersion(p.base.path, res.sha256);
  // L7.27: the project's record of what this write did to the scenario's hook surface, and who made it.
  if (p.scenario)
    await recordScenarioWrite(project, { file: res.path, sha256: res.sha256, scenario: p.scenario, before: p.before ?? null, caller: o.scope.caller, clock: o.scope.clock, stores: o.scope.stores });
  return { name, file: p.base.file, path: res.path, hash: res.sha256, label: p.label, select: p.select, warnings: p.warnings, notices: p.notices, ...(p.change ? { change: p.change } : {}) };
}

/** An edit checked and built, not written (prepareScenarioEdit): the file it applies to and the text it would write. */
export interface PreparedScenarioEdit {
  /** The file as read (its hash is the edit's `hash`). */
  base: ScenarioText;
  /** The bytes the edit writes. */
  text: string;
  label: string;
  select: string | null;
  warnings: ValidationIssue[];
  notices: string[];
  change?: 'filmed' | 'edit';
  /** The new text parsed, and the file as it was (L7.27: the record of the write's hook surface). */
  scenario?: Scenario;
  before?: Scenario;
}

/**
 * Everything editScenario does before the write (L4.6 split): the file read with the edit's hash, the file not blocked,
 * the edit built and verified, the size, no hidden character added, hooks and mocks unchanged (and vars / env while
 * there are some, agent channels), the text validated with agent trust worded for the channel — nothing written, no
 * version remembered (a text that is only checked never becomes a version `restore` accepts: critique B9). Used by
 * editScenario and to check a proposal before it is stored, previewed or applied.
 */
export async function prepareScenarioEdit(
  project: LoadedProject,
  name: string,
  req: ScenarioEditRequest,
  o: { agent: boolean; via: AgentChannel; registry?: () => Promise<ComponentRegistry>; files: WorkFileFacts; reads: WorkspaceReads },
): Promise<PreparedScenarioEdit> {
  const base = await getScenario(project, name);
  if (base.hash !== req.hash) {
    throw new EngineError('conflict', `${base.file} changed since it was read (its hash is no longer the one the edit was made on): read it again`, {
      details: { current: base.hash },
    });
  }
  const tplt = await templateOf(project, o);
  // The file as it is (its trust problems block it whole, below); the new text as an agent's work (confined: a file
  // outside the project is said to be outside, never looked at).
  const baseParsed = base.utf8 ? parseScenario(base.yaml, { files: o.files, file: base.path, project, template: tplt }) : { scenario: undefined, issues: [] };
  const checkOpts = { files: o.files, file: base.path, project, template: tplt, ...(o.agent ? { confined: confinementOf(o.via) } : {}) };
  const blocked = scenarioEditBlocker(project, base, baseParsed.scenario, o);
  if (blocked) {
    throw new EngineError('refused', blocked.why, {
      ...(blocked.problems.length ? { details: { problems: blocked.problems } } : {}),
    });
  }
  const edit = req.edit;
  let text: string;
  let label: string;
  let select: string | null = null;
  let notices: string[] = [];
  let change: 'filmed' | 'edit' | undefined;
  switch (edit.kind) {
    case 'replace_text':
      text = edit.text.endsWith('\n') || edit.text === '' ? edit.text : `${edit.text}${textEol(edit.text)}`;
      label = 'Saved the YAML';
      break;
    case 'restore':
      if (sha256Hex(edit.text) !== edit.text_hash) {
        throw new EngineError('invalid', 'the text to restore is not the version named by text_hash: nothing written', { details: { argument: 'edit.text_hash' } });
      }
      // Review A L3: only a version of this file the Studio showed or wrote (undo / redo), never any text a page makes up.
      if (!knownScenarioVersion(base.path, edit.text_hash)) {
        throw new EngineError('refused', `the text to restore is not a version of ${base.file} the Studio showed or wrote: nothing written — read the file again`, {
          details: { argument: 'edit.text_hash' },
        });
      }
      text = edit.text;
      label = 'Restored an earlier version';
      break;
    case 'move_step':
    case 'delete_step':
    case 'duplicate_step':
    case 'set_step':
    case 'insert_step': {
      let applied: ReturnType<typeof applyStepEdit>;
      try {
        applied = applyStepEdit(base.yaml, edit);
      } catch (e) {
        if (!(e instanceof StepEditError)) throw e;
        // stale: the step the edit names is no longer at that place in this version (critique B2: never edit a neighbour).
        const field = e.field !== undefined ? { field: e.field } : {};
        if (e.code === 'stale') throw new EngineError('conflict', `not saved: ${e.message}`, { details: { current: base.hash, stale: true, ...field } });
        throw new EngineError(e.code === 'invalid' ? 'invalid' : 'refused', `not saved: ${e.message}`, e.field !== undefined ? { details: field } : {});
      }
      // The verify (plan §3.1.4): the spliced text, re-parsed, must be exactly the edit applied to the file's value.
      const wrong = verifyEditText(applied.text, applied.intended);
      if (wrong) throw new EngineError('refused', `not saved: ${wrong}`);
      ({ text, label, select, notices } = applied);
      // L5.5's rule, said after each block edit: a step edit is a filmed change (a new capture films it), a caption,
      // speed or mark alone is an edit change (a render of the same run re-plans it).
      change = filmedChangesOf(applied.intended, parseYaml(base.yaml).value).length ? 'filmed' : 'edit';
      break;
    }
    case 'set_field': {
      // L4.5: one edit value of the video, a scene, a card or an interstitial (core applyFieldEdit: allow-list, from /
      // guard, splice), refused when the component or frame does not fit the use (critique B7: the inspector shows such
      // an option disabled with the same reason).
      let applied: ReturnType<typeof applyFieldEdit>;
      try {
        applied = applyFieldEdit(base.yaml, edit);
      } catch (e) {
        if (!(e instanceof StepEditError)) throw e;
        const field = e.field !== undefined ? { field: e.field } : {};
        if (e.code === 'stale') throw new EngineError('conflict', `not saved: ${e.message}`, { details: { current: base.hash, stale: true, ...field } });
        throw new EngineError(e.code === 'invalid' ? 'invalid' : 'refused', `not saved: ${e.message}`, e.field !== undefined ? { details: field } : {});
      }
      const wrong = verifyEditText(applied.text, applied.intended);
      if (wrong) throw new EngineError('refused', `not saved: ${wrong}`);
      const c = await components();
      const registry = await (o.registry ? o.registry() : c.loadComponentRegistry({ root: project.root }));
      const misfit = fieldFitProblem(registry, c.componentFit, parseYaml(base.yaml).value, edit);
      if (misfit) throw new EngineError('invalid', `not saved: ${misfit}`, { details: { field: edit.field } });
      // L4.7 (critique B1): a scenario's theme is a theme the workspace lists (by name, never a path).
      if (edit.field === 'template' && typeof edit.to === 'string') {
        const names = (await o.reads.listTemplates(project.root)).map((t) => t.name);
        if (!names.includes(edit.to)) {
          throw new EngineError('invalid', `not saved: "${edit.to}" is not a theme of this workspace (themes: ${names.join(', ') || 'none'})`, { details: { field: edit.field } });
        }
      }
      // Defence: every path of the allow-list is an edit value — a field edit never changes what a take films.
      const filmed = filmedChangesOf(applied.intended, parseYaml(base.yaml).value);
      if (filmed.length) throw new EngineError('refused', `not saved: this edit would change the filmed part (${filmed.slice(0, 3).join('; ')})`);
      ({ text, label } = applied);
      change = 'edit';
      break;
    }
    default:
      throw new EngineError('invalid', `unknown edit kind "${String((edit as { kind?: unknown }).kind).slice(0, 40)}"`);
  }
  if (text.length > SCENARIO_EDIT_MAX_CHARS) {
    throw new EngineError('invalid', `the scenario would hold ${text.length.toLocaleString('en')} characters: the Studio writes at most ${SCENARIO_EDIT_MAX_CHARS.toLocaleString('en')}`, {
      fix: 'shorten it, or edit it in your editor',
    });
  }
  // A restored version was on disk once (knownScenarioVersion): its hidden characters are the person's own.
  const hidden = edit.kind === 'restore' ? null : newHiddenCharProblem(text, base.yaml);
  if (hidden) throw new EngineError('invalid', `not saved: ${hidden}`);
  if (o.agent) {
    const before = base.utf8 ? parseYaml(base.yaml).value : undefined;
    const after = parseYaml(text).value;
    const changed = changedHookSections(before, after);
    if (changed.length) throw new EngineError('refused', `not saved: ${hooksChangedMessage(changed)}`, { details: { sections: changed } });
    const inputs = changedHookInputs(before, after);
    if (inputs.length) throw new EngineError('refused', `not saved: ${hookInputsChangedMessage(inputs)}`, { details: { sections: inputs } });
  }
  const { scenario, issues: parsed } = parseScenario(text, checkOpts);
  const issues = o.agent ? [...parsed, ...agentIssues(project, scenario, text, o.via)] : parsed;
  if (hasErrors(issues)) throw new ScenarioError(`not saved: ${issuesMessage('scenario', issues, base.path)}`, issues, base.path);
  return { base, text, label, select, warnings: issues, notices, ...(change ? { change } : {}), ...(scenario ? { scenario } : {}), ...(baseParsed.scenario ? { before: baseParsed.scenario } : {}) };
}
