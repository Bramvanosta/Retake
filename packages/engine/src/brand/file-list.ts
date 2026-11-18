/**
 * The workspace files a new theme may take as its logo, wordmark or fonts (`brand_files`): what the
 * Studio's New theme form offers to pick from — with a project, the project's own files first. A bounded walk of the workspace (BRAND_LIST_MAX_ENTRIES entries read,
 * BRAND_LIST_MAX_DEPTH folders deep) that leaves out exactly what brand/files.ts refuses as a source under trust `mcp`
 * — hidden folders and files, the components folder, the folders an agent writes in a project (scenarios, runs,
 * renders, review, exports) — plus node_modules; symbolic links are never followed nor listed (counted). Names and
 * sizes only: the bytes are checked when a create reads them (readBrandFile). Fonts also list the faces of the workspace's
 * font store (fontsource-store.ts), as the `fontsource:<id>@<version>:<weight>[italic]` references a create takes.
 */
import { lstat, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { realPathOf } from '@retake/core/policy';
import { nodeFileFacts } from '@retake/core/io';
import { EngineError } from '../errors.js';
import { FONT_EXTENSIONS, FONT_MAX_BYTES, IMAGE_MAX_BYTES, LOGO_EXTENSIONS, SVG_MAX_BYTES, brandSourceProblem } from './files.js';
import { storeFaces } from './fontsource-store.js';
import type { OpenedWorkspace } from '../workspace.js';
import { openProjectBySlug } from '../projects.js';
import { checkProjectSlug } from '../refs.js';

export const BRAND_LIST_MAX_ENTRIES = 5_000;
export const BRAND_LIST_MAX_DEPTH = 6;
/** Files listed, at most. */
export const BRAND_LIST_MAX_FILES = 500;

export interface BrandFileList {
  kind: 'image' | 'font';
  /**
   * Paths (`/`) what a brand input names, with their sizes (fonts: then the font store's faces): with a project, its
   * own files first (relative to the project folder, `origin: 'project'`), then the workspace's (relative to the root,
   * `origin: 'workspace'`; one the project's of the same reference hides left out).
   */
  files: Array<{ ref: string; bytes: number; origin?: 'project' | 'workspace' }>;
  /** The walk stopped at a bound (entries, files): not every file is listed. */
  truncated: boolean;
  /** Symbolic links met (never followed). */
  links: number;
}

/** The workspace's image or font files a theme may take (see the header) — with a project, its own first. */
export async function brandFileList(ws: OpenedWorkspace, kind: 'image' | 'font', projectSlug?: string): Promise<BrandFileList> {
  if (kind !== 'image' && kind !== 'font') throw new EngineError('invalid', 'kind is image or font');
  const project = projectSlug !== undefined ? await openProjectBySlug(ws, checkProjectSlug(projectSlug)) : undefined;
  const exts: readonly string[] = kind === 'font' ? FONT_EXTENSIONS : LOGO_EXTENSIONS;
  const root = realPathOf(resolve(ws.root), nodeFileFacts);
  const out: BrandFileList = { kind, files: [], truncated: false, links: 0 };
  // One budget for both walks.
  let seen = 0;
  const own = project ? { dir: realPathOf(resolve(project.dir), nodeFileFacts), slug: project.slug } : undefined;
  const walk = async (base: string, dir: string, depth: number, origin: 'project' | 'workspace' | undefined, taken: Set<string>): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > BRAND_LIST_MAX_ENTRIES || out.files.length >= BRAND_LIST_MAX_FILES) {
        out.truncated = true;
        return;
      }
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const abs = join(dir, e.name);
      const ref = relative(base, abs).split(sep).join('/');
      if (e.isSymbolicLink()) {
        out.links++;
        continue;
      }
      // The workspace's walk leaves the project's own folder to the project's walk.
      if (origin === 'workspace' && own && abs === own.dir) continue;
      // The source rules of brand/files.ts, on the folder before walking into it and on each file.
      if (brandSourceProblem(ws, ref, abs, origin === 'project' ? own : undefined)) continue;
      if (e.isDirectory()) {
        if (depth < BRAND_LIST_MAX_DEPTH) await walk(base, abs, depth + 1, origin, taken);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase();
      if (!e.name.includes('.') || !exts.includes(ext)) continue;
      const st = await lstat(abs).catch(() => null);
      if (!st?.isFile()) continue;
      const max = kind === 'font' ? FONT_MAX_BYTES : ext === '.svg' ? SVG_MAX_BYTES : IMAGE_MAX_BYTES;
      if (st.size > max) continue;
      // A workspace file whose reference the project's own file of that reference hides (read first by a create).
      if (origin === 'workspace' && taken.has(ref)) continue;
      if (origin === 'project') taken.add(ref);
      out.files.push({ ref, bytes: st.size, ...(origin ? { origin } : {}) });
    }
  };
  const taken = new Set<string>();
  if (own) await walk(own.dir, own.dir, 1, 'project', taken);
  await walk(root, root, 1, own ? 'workspace' : undefined, taken);
  if (kind === 'font') {
    for (const f of await storeFaces(ws)) {
      if (out.files.length >= BRAND_LIST_MAX_FILES) {
        out.truncated = true;
        break;
      }
      out.files.push(f);
    }
  }
  return out;
}
