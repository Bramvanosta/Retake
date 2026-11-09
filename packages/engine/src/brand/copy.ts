/**
 * "Copy to edit" (L4.7, R-UI-07; plan D8): a new workspace theme that is a copy of a listed one (a starter, a workspace
 * theme), so a starter — read-only — can be edited from the Studio. The source's regular files are copied verbatim
 * (dot entries left out: a source's own provenance file is not the copy's); only `name:` changes (a splice). Like
 * brand/create.ts: the name checks (lower-case, never a starter's, never an existing folder's — without case), refused
 * when templates_dir lies inside the Retake package, the folder built hidden with this tool's provenance file
 * written first (`copy_of`, trust `author`: the person made it in the Studio — never replaced through MCP, L4.7 review
 * A N4), validated (schema, loader, files inside the folder,
 * the registry resolving its components), then renamed into place; a failure removes it. A source holding a symbolic
 * link, a hard link or a special file is refused whole (a copy would serve a file from elsewhere); at most THEME_COPY_MAX_FILES files
 * and THEME_COPY_MAX_BYTES bytes.
 */
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { RETAKE_VERSION, TEMPLATE_FILE, THEME_NAME_RE, insideFolder, parseTemplateYaml, parseYaml, setMapPath, StepEditError } from '@retake/core';
import { loadTemplate, nodeFileFacts, fileFacts } from '@retake/core/io';
import { workspaceRegistry } from '../components.js';
import { EngineError, toEngineError } from '../errors.js';
import { sha256Hex } from '../storage.js';
import { ProjectStore } from '../store/project-store.js';
import type { StoreScope } from '../store/project-store.js';
import { checkTemplateName, themeAssetProblems } from '../templates.js';
import { PACKAGE_ROOT, THEME_PROVENANCE_FILE, checkNewName, removeStale } from './create.js';
import type { OpenedWorkspace } from '../workspace.js';

export const THEME_COPY_MAX_FILES = 2_000;
export const THEME_COPY_MAX_BYTES = 25 * 1024 * 1024;

export interface ThemeCopied {
  name: string;
  /** The theme it copies. */
  from: string;
  /** Files written, relative to the new folder. */
  files: string[];
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

/** Copy a listed theme into a new workspace theme `name` (see the header). */
export async function copyTheme(ws: OpenedWorkspace, req: { from: string; name: string }, o: { now?: Date; scope: StoreScope }): Promise<ThemeCopied> {
  const from = checkTemplateName(req?.from);
  const name = req?.name;
  if (typeof name !== 'string' || !THEME_NAME_RE.test(name) || name.length > 64) {
    throw new EngineError('invalid', `invalid theme name "${String(name).slice(0, 80)}": lower-case letters, digits and dashes (e.g. my-brand)`);
  }
  const now = o.now ?? new Date();
  const templatesDir = ws.templatesDir;
  if (insideFolder(PACKAGE_ROOT, templatesDir, nodeFileFacts)) {
    throw new EngineError('refused', `the workspace's templates_dir (${templatesDir}) lies inside the Retake folder (${PACKAGE_ROOT}): a copy would land among its starter themes`, {
      fix: 'work in a workspace of your own: set RETAKE_ROOT, or a retake.yaml whose templates_dir is outside the Retake folder',
    });
  }
  let source;
  try {
    source = await loadTemplate(from, ws.root, { files: fileFacts(ws.policy) });
  } catch (e) {
    throw toEngineError(e);
  }
  const leaks = themeAssetProblems(source);
  if (leaks.length) throw new EngineError('refused', `theme ${from}: ${leaks.join('; ')}`);
  const files = await sourceFiles(source.dir, from);
  if (!files.includes(TEMPLATE_FILE)) throw new EngineError('refused', `theme ${from} has no template.yaml of its own`);
  await mkdir(templatesDir, { recursive: true });
  await removeStale(templatesDir, now.getTime());
  await checkNewName(templatesDir, name, false, 'author');
  const text = renamedText(await readFile(join(source.dir, TEMPLATE_FILE), 'utf8'), name, from);
  const hashes: Record<string, string> = {};
  for (const f of files) hashes[f] = f === TEMPLATE_FILE ? sha256Hex(text) : sha256Hex(await readFile(join(source.dir, ...f.split('/'))));
  try {
    await new ProjectStore(templatesDir, o.scope, undefined, '<templates_dir>').createFolder(templatesDir, name, {
      what: 'theme',
      build: async (stage) => {
        // The provenance file first: a crash leaves a folder the next create recognises as this tool's (removeStale).
        const provenance = { version: 1, made_by: 'retake', tool_version: RETAKE_VERSION, created_at: now.toISOString(), name, base: from, copy_of: from, trust: 'author', files: hashes };
        await stage.write(THEME_PROVENANCE_FILE, `${JSON.stringify(provenance, null, 2)}\n`);
        for (const f of files) {
          if (f === TEMPLATE_FILE) await stage.write(f, text);
          else {
            await stage.copy(f, join(source.dir, ...f.split('/')));
            // Copied bytes are the ones hashed (a source file changed meanwhile refuses the copy).
            if (sha256Hex(await readFile(join(stage.dir, ...f.split('/')))) !== hashes[f]) throw new EngineError('conflict', `theme ${from}: ${f} changed while it was copied — try again`);
          }
        }
        const parsed = parseTemplateYaml(text, { dir: stage.dir, files: fileFacts(ws.policy) });
        const errors = parsed.issues.filter((i) => i.severity === 'error');
        if (errors.length) throw new EngineError('invalid', `the copy does not validate: ${errors.map((i) => i.message).join('; ')}`);
        const loaded = await loadTemplate(stage.dir, undefined, { files: fileFacts(ws.policy) });
        const outside = themeAssetProblems(loaded);
        if (outside.length) throw new EngineError('refused', outside.join('; '));
        try {
          (await workspaceRegistry(ws)).resolveTheme(loaded.template);
        } catch (e) {
          throw new EngineError('invalid', `the copy's components do not resolve: ${toEngineError(e).message}`);
        }
      },
      recheck: () => checkNewName(templatesDir, name, false, 'author'),
    });
  } catch (e) {
    throw toEngineError(e);
  }
  return { name, from, files: [...files, THEME_PROVENANCE_FILE] };
}
