/** Save a Studio recording as a new scenario (record-studio.ts): the draft the person saw, byte for byte. */
import type { VersionLedger } from './version-ledger.js';
import { firstHiddenChar, hiddenCharName, parseScenario } from '@retake/core/scenario';
import { draftInvalidIssue } from '@retake/core/run';
import type { LoadedProject } from '@retake/core/project';
import type { WorkFileFacts } from '@retake/core/model';
import type { DraftIssue, RecordAnnotations } from '@retake/core/run';
import { stampOf } from './clock.js';
import { EngineError, toEngineError } from './errors.js';
import { checkScenarioName } from './refs.js';
import { saveScenarioText } from './scenarios.js';
import type { StoreScope } from './store/store.js';
import { sha256Hex } from './storage.js';
import type { WorkspaceReads } from './workspace-reads/reads.js';
import { TAMPERED_WORDS, checkedFolder, lockRecording, readRecordEvents, writeAnnotations } from './record-folder.js';
import { FINAL_STATES, annotationsOrRefuse, checkOpen, checkRev, requireStudio, situation } from './record-situation.js';
import type { RecordStudioContext } from './record-situation.js';
import { draftOf } from './record-view.js';

export interface RecordSaved {
  name: string;
  /** scenarios/<name>.yaml */
  file: string;
  hash: string;
  rev: number;
  /** The scenario's validation warnings, counted (their text is page-derived). */
  warnings: number;
  untrusted: { issues: DraftIssue[] };
}

/** Remove the project's and the workspace's absolute paths from a text that leaves the engine. */
function withoutPaths(text: string, dirs: string[]): string {
  let out = text;
  for (const d of dirs.filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(d).join('…');
  return out.replace(/(?:\/[\w.@-]+){3,}/g, '…').slice(0, 400);
}

/** Any string of `v` holding a hidden character: that character. */
function hiddenIn(v: unknown): string | undefined {
  if (typeof v === 'string') return firstHiddenChar(v);
  if (Array.isArray(v)) {
    for (const x of v) {
      const h = hiddenIn(x);
      if (h !== undefined) return h;
    }
    return undefined;
  }
  if (v !== null && typeof v === 'object') return hiddenIn(Object.values(v));
  return undefined;
}

/**
 * A hidden character in a draft (defence in depth — the generator leaves such steps out): where it is, in fixed
 * words (`scene <id>, step <n>` and the character's code), or null.
 */
function hiddenProblem(yaml: string): string | null {
  const h = firstHiddenChar(yaml);
  if (h === undefined) return null;
  const parsed = parseScenario(yaml).scenario as { scenes?: Array<{ id?: unknown; steps?: unknown[] }> } | undefined;
  for (const sc of parsed?.scenes ?? []) {
    for (const [k, st] of (sc.steps ?? []).entries()) {
      const c = hiddenIn(st);
      if (c !== undefined) return `scene ${typeof sc.id === 'string' && /^[\w-]{1,100}$/.test(sc.id) ? sc.id : '?'}, step ${k + 1} holds ${hiddenCharName(c)}`;
    }
  }
  return `the draft holds ${hiddenCharName(h)}`;
}

/**
 * Write a recorded draft as a NEW scenario (the write path of Save, exported for its tests): never a hidden character
 * (the Studio never writes one), agent trust (`via: 'studio'`), never over an existing file (a taken name is a
 * conflict), errors without a path — the validator's text located by scene and step and kept under `details.untrusted`.
 */
export async function saveRecordedDraft(
  project: LoadedProject,
  o: {
    name: string;
    yaml: string;
    sceneIds: readonly string[];
    scope: StoreScope;
    files: WorkFileFacts;
    reads: WorkspaceReads;
    /** The engine's ledger of the scenario versions it showed or wrote (the saved file is one). */
    seen?: VersionLedger | undefined;
  },
): Promise<{ file: string; hash: string; warnings: number }> {
  const { name, yaml, sceneIds, scope, files, reads, seen } = o;
  checkScenarioName(name);
  const hid = hiddenProblem(yaml);
  if (hid !== null)
    throw new EngineError(
      'invalid',
      `not saved: ${hid} — a hidden character (a direction control, a zero-width or line-separator character) reads as something else than it is, and the Studio never writes one`,
    );
  const taken = () => new EngineError('conflict', `scenario ${name} exists: choose another name (a recording never replaces a scenario)`, { fix: 'choose another name' });
  if (project.scenarios.includes(name)) throw taken();
  try {
    const r = await saveScenarioText(project, name, yaml, { ifMatch: null, agent: true, via: 'studio', scope, files, reads, seen });
    return { file: r.file, hash: r.hash, warnings: r.warnings.length };
  } catch (e) {
    if (e instanceof Error && e.name === 'ScenarioError') {
      const issues = ((e as { issues?: Array<{ severity: string; path: Array<string | number>; line?: number; message: string }> }).issues ?? []).filter((x) => x.severity === 'error');
      throw new EngineError('invalid', 'not saved: the draft does not pass the checks a scenario saved from the Studio must pass — its problems are listed by scene and step', {
        details: {
          issues: issues.map((x) => draftInvalidIssue(x, sceneIds, 'not saved')),
          untrusted: { messages: issues.slice(0, 20).map((x) => withoutPaths(x.message, [project.dir])) },
        },
      });
    }
    const err = toEngineError(e);
    if (err.code === 'conflict') throw taken();
    if (err.code === 'invalid' || err.code === 'refused') throw new EngineError(err.code, `not saved: ${withoutPaths(err.message, [project.dir])}`);
    throw new EngineError('internal', 'not saved: the scenario file could not be written');
  }
}

/** Save a finished Studio recording as scenarios/<name>.yaml — the draft the person saw, byte for byte (see the module comment). */
export async function recordSave(ctx: RecordStudioContext, project: LoadedProject, id: string, req: { name: string; rev: number; draft: string }): Promise<RecordSaved> {
  checkScenarioName(req.name);
  if (!Number.isInteger(req.rev) || req.rev < 0) throw new EngineError('invalid', 'rev must be the revision the view returned');
  if (typeof req.draft !== 'string' || !/^[0-9a-f]{64}$/.test(req.draft)) throw new EngineError('invalid', 'draft must be the draft_sha256 the view returned (the draft you saw)');
  const lock = await lockRecording(project, id, 'save');
  try {
    const s = await situation(ctx, project, id);
    requireStudio(s, 'save');
    if (s.state === 'tampered') throw new EngineError('conflict', `save: ${TAMPERED_WORDS}`);
    if (!FINAL_STATES.has(s.state)) throw new EngineError('conflict', `save: the recording is ${s.state.replace('_', ' ')} — save it once it is over`);
    const dir = await checkedFolder(project, id);
    const a = annotationsOrRefuse(s, 'save');
    checkOpen(a, 'save');
    checkRev(a, req.rev);
    const read = readRecordEvents(dir);
    if (!read.ok) throw new EngineError('refused', `save: ${read.problem}`);
    if (s.record && s.record.events_sha256 !== sha256Hex(read.bytes)) {
      throw new EngineError('conflict', "save: the recording's events changed after it was drafted and checked — the draft would not be the one checked; record again");
    }
    if (!read.events.length) throw new EngineError('conflict', 'save: nothing was recorded');
    const made = draftOf(s, read.events, a, ctx.files);
    if ('problem' in made) throw new EngineError('refused', `save: ${made.problem}`);
    const d = made.draft;
    // The draft the person saw, or nothing: its events, project.yaml (pages, vars) and annotations as they were.
    if (sha256Hex(d.yaml) !== req.draft) {
      throw new EngineError('conflict', 'save: the draft changed since you read it (its events, project.yaml or the arrangement): read it again, look at it, then save', {
        fix: 'read the recording again',
      });
    }
    const sceneIds = (d.scenario.scenes as Array<{ id: string }>).map((x) => x.id);
    const errors = d.issues.filter((i) => i.severity === 'error');
    if (errors.length) {
      throw new EngineError('invalid', 'not saved: the draft has errors — they are listed by scene and step', { details: { issues: errors } });
    }
    const w = await saveRecordedDraft(project, {
      name: req.name,
      yaml: d.yaml,
      sceneIds,
      scope: ctx.scope,
      files: ctx.files,
      reads: ctx.reads,
      seen: ctx.seen,
    });
    const next: RecordAnnotations = { ...a, rev: a.rev + 1, saved: { name: req.name, file: w.file, hash: w.hash, at: stampOf(ctx.scope.clock) } };
    await writeAnnotations(dir, next);
    return { name: req.name, file: w.file, hash: w.hash, rev: next.rev, warnings: w.warnings, untrusted: { issues: d.issues } };
  } finally {
    lock.releaseSync();
  }
}
