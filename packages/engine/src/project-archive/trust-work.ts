/**
 * `retake project trust <slug> [--list] [--discard]`: a person reads what of an imported project runs, then trusts it,
 * or discards the import. A person's acts only (trust `author`): no MCP tool, no Studio route.
 *
 * The listing (projectTrustView): the code files of the project as it is now (code-files.ts, computed from its files —
 * never from an archive's manifest), each with its size, the first 12 hex of its sha256 and whether it changed or is
 * new since the import (the mark's table); the files removed since; what project.yaml asks of this machine; the saved
 * sessions this machine holds for the slug. Every path and value is shown with its hidden characters written out.
 *
 * Trust (trustImportedProject) signs the files listed (the trust module's mark); a folder moved or copied in from
 * elsewhere (its marker but no mark here) gets a mark of its own first. Discard (discardImport) sets the folder of an
 * import nobody trusted aside under `.retake/imports/discarded/<stamp>-<slug>/` (never deleted: a person removes it)
 * and removes its mark.
 */
import { join, relative } from 'node:path';
import { RETAKE_VERSION, pathInside, showHiddenCharsLine } from '@retake/core/base';
import { stateRef } from '@retake/core/project';
import type { CallerTrust } from '../caller.js';
import type { EngineEnv } from '../env.js';
import { EngineError } from '../errors.js';
import { checkProjectSlug } from '../refs.js';
import type { StoreScope } from '../store/store.js';
import type { OpenedWorkspace } from '../workspace.js';
import { codeFileTable, projectCodeFiles, savedSessionsOf, settingsNotes } from './code-files.js';
import type { CodeFile } from './code-files.js';
import { importTrust, projectPlace, readImportMark, readImportMarker, removeImportMark, writeImportMark, writeTrust } from './trust.js';
import type { ImportMark } from './trust.js';

/** One code file as the trust listing shows it. */
export interface TrustListed extends CodeFile {
  since: 'same' | 'changed' | 'new';
}

export interface ProjectTrustView {
  project: string;
  state: 'untrusted' | 'trusted';
  /** Why it is not trusted (fixed words). */
  why?: string;
  files: TrustListed[];
  /** Code files of the import no longer there. */
  removed: string[];
  settings: string[];
  sessions_here: string[];
}

const personOnly = (trust: CallerTrust): void => {
  if (trust !== 'author') throw new EngineError('refused', "a person trusts an imported project's code after reading the list, in a terminal: retake project trust <slug>");
};

/** The mark of an import, or a refusal: a project that was not imported has nothing to trust. */
async function stateOf(ws: OpenedWorkspace, slug: string, env: EngineEnv) {
  const at = projectPlace(ws, checkProjectSlug(slug));
  const t = await importTrust(at, env);
  if (t.state === 'none') throw new EngineError('invalid', `nothing to trust: ${showHiddenCharsLine(slug)} was not imported from a project archive (it holds no import marker, and this workspace no mark of it)`);
  return { at, t };
}

/** The trust listing of an imported project (see the header). */
export async function projectTrustView(ws: OpenedWorkspace, slug: string, o: { trust: CallerTrust; env: EngineEnv }): Promise<ProjectTrustView> {
  personOnly(o.trust);
  const { at, t } = await stateOf(ws, slug, o.env);
  const was = t.mark?.code_files ?? {};
  const code = await projectCodeFiles(at.dir);
  const files = code.map((f): TrustListed => {
    const before = was[f.path];
    const now = f.why === 'link' ? 'link' : f.sha256;
    return { ...f, path: showHiddenCharsLine(f.path), since: before === undefined ? 'new' : before === now ? 'same' : 'changed' };
  });
  const here = new Set(code.map((f) => f.path));
  return {
    project: slug,
    state: t.state === 'trusted' ? 'trusted' : 'untrusted',
    ...(t.state === 'untrusted' ? { why: t.why } : {}),
    files,
    removed: Object.keys(was)
      .filter((p) => !here.has(p))
      .map(showHiddenCharsLine),
    settings: await settingsNotes(at.dir),
    sessions_here: await savedSessionsOf(slug, o.env),
  };
}

/**
 * Trust an imported project: sign the code files listed now (`listed`: the view the person read — refused when the
 * files changed since, the person reads the list again). Answers the view as trusted.
 */
export async function trustImportedProject(ws: OpenedWorkspace, slug: string, listed: ProjectTrustView, o: { trust: CallerTrust; env: EngineEnv; now: string }): Promise<ProjectTrustView> {
  personOnly(o.trust);
  const { at } = await stateOf(ws, slug, o.env);
  const code = await projectCodeFiles(at.dir);
  const table = codeFileTable(code);
  const shownNow = codeFileTable(listed.files);
  const same = Object.keys(table).length === Object.keys(shownNow).length && code.every((c) => shownNow[showHiddenCharsLine(c.path)] === table[c.path]);
  if (!same) throw new EngineError('conflict', `the code files of ${showHiddenCharsLine(slug)} changed while you read them: nothing trusted — run retake project trust ${showHiddenCharsLine(slug)} again`);
  let mark = await readImportMark(ws.root, slug);
  if (typeof mark !== 'object') {
    // A folder moved or copied here (its marker, no mark of this workspace) or a mark that does not read: a new mark.
    const marker = await readImportMarker(at.dir);
    if (typeof marker !== 'object') throw new EngineError('invalid', `${showHiddenCharsLine(slug)} holds no import marker that reads: nothing to trust`);
    const fresh: Omit<ImportMark, 'v' | 'trusted'> = { slug, import_id: marker.import_id, imported_at: o.now, archive: { name: '(a folder moved here)', sha256: '0'.repeat(64) }, from_retake: RETAKE_VERSION, code_files: table };
    await writeImportMark(ws.root, fresh);
    mark = { v: 1, ...fresh };
  }
  await writeTrust(at, mark, table, o.now, o.env);
  return { ...listed, state: 'trusted', files: listed.files.map((f) => ({ ...f })) };
}

/** Where a discarded import's folder is set aside (a ref of the workspace's store). */
function discardedRef(slug: string, now: string): string {
  return stateRef('imports', 'discarded', `${now.replace(/[^0-9]/g, '').slice(0, 14)}-${slug}`);
}

/** Discard an import nobody trusted (see the header): answers where its folder went. */
export async function discardImport(ws: OpenedWorkspace, slug: string, o: { trust: CallerTrust; env: EngineEnv; now: string; scope: StoreScope }): Promise<{ project: string; moved_to: string }> {
  personOnly(o.trust);
  const { at, t } = await stateOf(ws, slug, o.env);
  if (t.state === 'trusted') throw new EngineError('refused', `${showHiddenCharsLine(slug)} is trusted: it is an ordinary project now — remove it by hand if you no longer want it`);
  const store = o.scope.stores.at(ws.root, o.scope);
  const to = discardedRef(slug, o.now);
  const moved = pathInside(at.dir, ws.root)
    ? await store.moveAside(relative(ws.root, at.dir).split('\\').join('/'), to, { what: 'project' })
    : await store.takeIn(at.dir, to, { what: 'project' });
  await removeImportMark(ws.root, slug);
  return { project: slug, moved_to: moved.to ?? join(ws.root, to) };
}
