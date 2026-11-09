/**
 * The workspace files a new theme may take as its logo, wordmark or fonts (L4.7, plan D7 `brand_files`): what the
 * Studio's New theme form offers to pick from. A bounded walk of the workspace (BRAND_LIST_MAX_ENTRIES entries read,
 * BRAND_LIST_MAX_DEPTH folders deep) that leaves out exactly what brand/files.ts refuses as a source under trust `mcp`
 * — hidden folders and files, the components folder, the folders an agent writes in a project (scenarios, runs,
 * renders, review, exports) — plus node_modules; symbolic links are never followed nor listed (counted). Names and
 * sizes only: the bytes are checked when a create reads them (readBrandFile).
 */
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { realPathOf } from '@retake/core';
import { nodeFileFacts } from '@retake/core/io';
import { EngineError } from '../errors.js';
import { FONT_EXTENSIONS, FONT_MAX_BYTES, IMAGE_MAX_BYTES, LOGO_EXTENSIONS, SVG_MAX_BYTES, brandSourceProblem } from './files.js';
import type { OpenedWorkspace } from '../workspace.js';

export const BRAND_LIST_MAX_ENTRIES = 5_000;
export const BRAND_LIST_MAX_DEPTH = 6;
/** Files listed, at most. */
export const BRAND_LIST_MAX_FILES = 500;

export interface BrandFileList {
  kind: 'image' | 'font';
  /** Workspace-relative paths (`/`), what a brand input names, with their sizes. */
  files: Array<{ ref: string; bytes: number }>;
  /** The walk stopped at a bound (entries, files): not every file is listed. */
  truncated: boolean;
  /** Symbolic links met (never followed). */
  links: number;
}

/** The workspace's image or font files a theme may take (see the header). */
export async function brandFileList(ws: OpenedWorkspace, kind: 'image' | 'font'): Promise<BrandFileList> {
  if (kind !== 'image' && kind !== 'font') throw new EngineError('invalid', 'kind is image or font');
  const exts: readonly string[] = kind === 'font' ? FONT_EXTENSIONS : LOGO_EXTENSIONS;
  const root = realPathOf(resolve(ws.root), nodeFileFacts);
  const out: BrandFileList = { kind, files: [], truncated: false, links: 0 };
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
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
      const ref = relative(root, abs).split(sep).join('/');
      if (e.isSymbolicLink()) {
        out.links++;
        continue;
      }
      // The source rules of brand/files.ts, on the folder before walking into it and on each file.
      if (brandSourceProblem(ws, ref, abs)) continue;
      if (e.isDirectory()) {
        if (depth < BRAND_LIST_MAX_DEPTH) await walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase();
      if (!e.name.includes('.') || !exts.includes(ext)) continue;
      const st = await lstat(abs).catch(() => null);
      if (!st?.isFile()) continue;
      const max = kind === 'font' ? FONT_MAX_BYTES : ext === '.svg' ? SVG_MAX_BYTES : IMAGE_MAX_BYTES;
      if (st.size > max) continue;
      out.files.push({ ref, bytes: st.size });
    }
  };
  await walk(root, 1);
  return out;
}
