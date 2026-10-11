import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ConfigError, hasErrors, issuesMessage } from './issues.js';
import { WorkspaceFileSchema } from './schemas/project.js';
import type { WorkspaceConfig } from './types.js';
import { expandHome } from './util.js';
import { checkYamlDocument } from './validation/document.js';

export const WORKSPACE_FILE = 'studio.yaml';

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findUp(start: string, test: (dir: string) => boolean): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (test(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * `$DEMO_STUDIO_ROOT` if set, else the nearest ancestor containing studio.yaml, else the nearest
 * ancestor containing a projects/ or templates/ directory, else `start`.
 */
export function findWorkspaceRoot(start: string = process.cwd()): string {
  const env = process.env.DEMO_STUDIO_ROOT;
  if (env && env.trim()) return resolve(expandHome(env.trim()));
  return (
    findUp(start, (d) => existsSync(join(d, WORKSPACE_FILE))) ??
    findUp(start, (d) => isDir(join(d, 'projects')) || isDir(join(d, 'templates'))) ??
    resolve(start)
  );
}

/** Read studio.yaml (optional) and resolve the projects / templates directories. */
export async function loadWorkspaceConfig(root: string): Promise<WorkspaceConfig> {
  const absRoot = resolve(root);
  const file = join(absRoot, WORKSPACE_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(`cannot read ${file}: ${(e as Error).message}`, [], file);
    }
    text = '';
  }
  const { value, issues } = checkYamlDocument(text, WorkspaceFileSchema);
  if (hasErrors(issues)) throw new ConfigError(issuesMessage('workspace config', issues, file), issues, file);
  const cfg = WorkspaceFileSchema.parse(value);
  const dir = (p: string | undefined, fallback: string) => resolve(absRoot, expandHome(p ?? fallback));
  const out: WorkspaceConfig = {
    root: absRoot,
    projectsDir: dir(cfg.projects_dir, 'projects'),
    templatesDir: dir(cfg.templates_dir, 'templates'),
  };
  if (cfg.browser) out.browser = cfg.browser;
  if (cfg.ffmpeg) out.ffmpeg = expandHome(cfg.ffmpeg);
  return out;
}
