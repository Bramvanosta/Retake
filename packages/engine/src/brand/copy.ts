/**
 * "Copy to edit" (R-UI-07): a new theme — the project's own when one is named, else the workspace's — that is a
 * copy of a listed one (a starter, a workspace theme, a theme of the project), so a
 * starter — read-only — can be edited from the Studio. The source's regular files are copied verbatim (dot entries left
 * out: a source's own provenance file is not the copy's); only `name:` changes (a splice). Like brand/create.ts: the
 * name checks (lower-case, never a starter's, never an existing folder's — without case), refused when templates_dir
 * lies inside the Retake package (a workspace target: theme-target.ts), the folder built hidden with this tool's provenance file written first (`copy_of`,
 * trust `author`: the person made it in the Studio — never replaced through MCP), validated (schema, loader, files
 * inside the folder, the registry resolving its components), then renamed into place; a failure removes it. A source
 * holding a symbolic link, a hard link or a special file is refused whole (a copy would serve a file from elsewhere);
 * at most THEME_COPY_MAX_FILES files and THEME_COPY_MAX_BYTES bytes.
 */
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RETAKE_VERSION, parseYaml } from '@retake/core/base';
import { setMapPath, StepEditError } from '@retake/core/scenario';
import { TEMPLATE_FILE, parseTemplateYaml } from '@retake/core/theme';
import type { LoadedTemplate } from '@retake/core/theme';
import { projectRegistry } from '../components.js';
import { EngineError, toEngineError } from '../errors.js';
import { sha256Hex } from '../storage.js';
import type { StoreScope } from '../store/store.js';
import { dateOf } from '../clock.js';
import { checkNewThemeName, checkTemplateName, themeAssetProblems } from '../templates.js';
import { THEME_PROVENANCE_FILE, checkNewName, projectShadowCheck, removeStale } from './create.js';
import type { BrandTrust } from './files.js';
import { themeTarget } from '../theme-target.js';
import type { ThemeTarget } from '../theme-target.js';
import type { NewThemeName } from '@retake/core/ids';
import type { OpenedWorkspace } from '../workspace.js';

export const THEME_COPY_MAX_FILES = 2_000;
export const THEME_COPY_MAX_BYTES = 25 * 1024 * 1024;

export interface ThemeCopied {
  name: string;
  /** The theme it copies. */
  from: string;
  /** Files written, relative to the new folder. */
  files: string[];
  /** The project whose own theme it is (absent: a workspace theme). */
  project?: string;
  /** A project theme hiding a workspace theme of its name, said once. */
  warnings?: string[];
}

/** Every regular file of a folder (relative, `/`), dot entries left out; a link or a special file refuses the copy. */
async function sourceFiles(dir: string, from: string): Promise<string[]> {
  const out: string[] = [];
  let bytes = 0;
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new EngineError('refused', `theme ${from} holds a symbolic link (${r}): a copy would serve a file from elsewhere — copy it by hand`);
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) {
        const st = await lstat(join(dir, r));
        // A hard link is another name of a file that may live anywhere: its copy would be a fresh file of the theme's
        // own, served where the source never may serve it (theme-edit.ts themeFileProblem names the same rule).
        if (st.nlink > 1) throw new EngineError('refused', `theme ${from} holds a file with another name (a hard link: ${r}): a copy would serve bytes from elsewhere — copy it by hand`);
        bytes += st.size;
        out.push(r);
        if (out.length > THEME_COPY_MAX_FILES) throw new EngineError('refused', `theme ${from} holds more than ${THEME_COPY_MAX_FILES} files: copy it by hand`);
        if (bytes > THEME_COPY_MAX_BYTES) throw new EngineError('refused', `theme ${from} is larger than ${THEME_COPY_MAX_BYTES / 1024 / 1024} MB: copy it by hand`);
      } else throw new EngineError('refused', `theme ${from} holds a special file (${r}): copy it by hand`);
    }
  };
  await walk('');
  return out;
}

/** template.yaml with `name:` set to the copy's (a splice: comments and everything else kept). */
function renamedText(text: string, name: string, from: string): string {
  const root = parseYaml(text).value;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new EngineError('refused', `theme ${from}: template.yaml is not a map of settings`);
  if ((root as Record<string, unknown>).name === name) return text;
  try {
    return setMapPath(text, root as Record<string, unknown>, ['name'], name, { insertBefore: 'colors', keepComments: true, what: 'the name', byHand: 'copy it by hand' }).text;
  } catch (e) {
    if (e instanceof StepEditError) throw new EngineError('refused', `theme ${from}: ${e.message}`);
    throw e;
  }
}

/** Copy a listed theme into a new theme `name` (see the header): the project's own when `project` is named, else the workspace's. */
export async function copyTheme(ws: OpenedWorkspace, req: { from: string; name: string; project?: string }, o: { scope: StoreScope; trust: BrandTrust }): Promise<ThemeCopied> {
  const from = checkTemplateName(req?.from);
  const name = checkNewThemeName(req?.name);
  const target = await themeTarget(ws, req?.project, 'a copy');
  let source: LoadedTemplate;
  try {
    // A project's copy may take one of the project's own themes (found first, as its work names them).
    source = await ws.reads.loadTemplate(from, ws.root, { files: ws.reads.fileFacts(ws.policy), ...(target.project ? { projectDir: target.project.dir } : {}) });
  } catch (e) {
    throw toEngineError(e);
  }
  const warnings: string[] = [];
  // The Studio's copy as its New theme: a project copy of a workspace theme's name is refused (trust mcp), a person's warned.
  await projectShadowCheck(ws, target, name, o.trust, warnings);
  const files = await copyThemeFolder(ws, { source, from }, target, name, { provenance: 'new', scope: o.scope });
  return { name, from, files, ...(target.project ? { project: target.project.slug } : {}), ...(warnings.length ? { warnings } : {}) };
}

/**
 * A theme folder copied whole into `target` as `name` (copyTheme; project-adopt.ts): its regular files verbatim (a link,
 * a hard link or a special file refuses it; size caps), template.yaml's `name:` set to `name`, validated as a render
 * will load it, through the target's store (staged, rechecked, journaled). `provenance`: `new` writes this tool's
 * record (`copy_of`, trust `author`: a person's copy); `keep` copies the source's own record as it is (an adopted
 * theme stays what it was: one MCP made can still be updated through MCP, a person's never). Returns the files written.
 */
export async function copyThemeFolder(
  ws: OpenedWorkspace,
  src: { source: LoadedTemplate; from: string },
  target: ThemeTarget,
  name: NewThemeName,
  o: { provenance: 'new' | 'keep'; scope: StoreScope; keepStarterName?: boolean },
): Promise<string[]> {
  const { source, from } = src;
  // Stamped by the scope's clock (its provenance), which also dates the stale stages swept.
  const now = dateOf(o.scope.clock);
  const templatesDir = target.dir;
  const leaks = themeAssetProblems(source);
  if (leaks.length) throw new EngineError('refused', `theme ${from}: ${leaks.join('; ')}`);
  const files = await sourceFiles(source.dir, from);
  if (!files.includes(TEMPLATE_FILE)) throw new EngineError('refused', `theme ${from} has no template.yaml of its own`);
  const kept = o.provenance === 'keep' ? await keptProvenance(source.dir, from) : undefined;
  await mkdir(templatesDir, { recursive: true });
  await removeStale(templatesDir, now.getTime());
  const isProject = target.project !== undefined;
  await checkNewName(templatesDir, name, false, 'author', { noun: target.noun, project: isProject, ...(o.keepStarterName ? { keepStarterName: true } : {}) });
  const text = renamedText(await readFile(join(source.dir, TEMPLATE_FILE), 'utf8'), name, from);
  const hashes: Record<string, string> = {};
  for (const f of files) hashes[f] = f === TEMPLATE_FILE ? sha256Hex(text) : sha256Hex(await readFile(join(source.dir, ...f.split('/'))));
  try {
    await target.store(o.scope).createFolder(templatesDir, name, {
      what: 'theme',
      build: async (stage) => {
        // The provenance file first: a crash leaves a folder the next create recognises as this tool's (removeStale).
        if (kept !== undefined) await stage.write(THEME_PROVENANCE_FILE, kept);
        else if (o.provenance === 'new') {
          const provenance = { version: 1, made_by: 'retake', tool_version: RETAKE_VERSION, created_at: now.toISOString(), name, base: from, copy_of: from, trust: 'author', files: hashes };
          await stage.write(THEME_PROVENANCE_FILE, `${JSON.stringify(provenance, null, 2)}\n`);
        }
        for (const f of files) {
          if (f === TEMPLATE_FILE) await stage.write(f, text);
          else {
            await stage.copy(f, join(source.dir, ...f.split('/')));
            // Copied bytes are the ones hashed (a source file changed meanwhile refuses the copy).
            if (sha256Hex(await readFile(join(stage.dir, ...f.split('/')))) !== hashes[f]) throw new EngineError('conflict', `theme ${from}: ${f} changed while it was copied — try again`);
          }
        }
        const parsed = parseTemplateYaml(text, { dir: stage.dir, files: ws.reads.fileFacts(ws.policy) });
        const errors = parsed.issues.filter((i) => i.severity === 'error');
        if (errors.length) throw new EngineError('invalid', `the copy does not validate: ${errors.map((i) => i.message).join('; ')}`);
        const loaded = await ws.reads.loadTemplate(stage.dir, undefined, { files: ws.reads.fileFacts(ws.policy) });
        const outside = themeAssetProblems(loaded);
        if (outside.length) throw new EngineError('refused', outside.join('; '));
        try {
          // A project's copy picks among the project's own components too.
          (await projectRegistry(ws, target.project)).resolveTheme(loaded.template);
        } catch (e) {
          throw new EngineError('invalid', `the copy's components do not resolve: ${toEngineError(e).message}`);
        }
      },
      recheck: () => checkNewName(templatesDir, name, false, 'author', { noun: target.noun, project: isProject, ...(o.keepStarterName ? { keepStarterName: true } : {}) }),
    });
  } catch (e) {
    throw toEngineError(e);
  }
  return [...files, ...(kept !== undefined || o.provenance === 'new' ? [THEME_PROVENANCE_FILE] : [])];
}

/** The source's own provenance record, as written (a regular file of its folder, no link), or undefined when it has none. */
async function keptProvenance(dir: string, from: string): Promise<string | undefined> {
  const file = join(dir, THEME_PROVENANCE_FILE);
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(file);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.nlink > 1) throw new EngineError('refused', `theme ${from}: its ${THEME_PROVENANCE_FILE} is not a regular file of its own — copy it by hand`);
  if (st.size > 1024 * 1024) throw new EngineError('refused', `theme ${from}: its ${THEME_PROVENANCE_FILE} is larger than 1 MB — copy it by hand`);
  return readFile(file, 'utf8');
}
