/**
 * `retake init [dir]`: make a folder a workspace — `retake.yaml`, `projects/` and a
 * `.gitignore` naming `.retake/`. A folder that already holds a retake.yaml is left as it is; a folder holding other
 * things (hidden files aside) is refused: a workspace folder is the person's choice, never a guess. The files are
 * written through the project store of the ports given (each created, never over one; journaled in the new
 * workspace's journal), as a person's work.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expandHome } from '@retake/core/base';
import { WORKSPACE_FILE, WORKSPACE_GITIGNORE } from '@retake/core/project';
import { assertOutsideBundle } from '@retake/core/io';
import { EngineError } from './errors.js';
import type { EnginePorts } from './ports.js';
import { personScope } from './store/project-store.js';

/** The retake.yaml `retake init` writes: every key commented, the defaults working as they are. */
export const INIT_WORKSPACE_YAML = `# Retake workspace (docs/guide/workspace.md). Every key is optional.
version: 1
# projects_dir: projects       # one folder per product (retake new <slug>)
# templates_dir: templates     # your themes (the starter themes ship with Retake)
# components_dir: components   # your own components (retake components create)
# ffmpeg: /path/to/ffmpeg      # default: $RETAKE_FFMPEG, the app's own, else ffmpeg on PATH
# browser: {locale: en-GB, timezone: Europe/London}   # defaults for every project (project.yaml wins)
`;

export interface InitResult {
  root: string;
  /** false: the folder already was a workspace (left as it is). */
  created: boolean;
}

/** Make `dir` (`~` expanded, resolved) a workspace; a folder that is not empty and not one is refused (`invalid`). */
export async function initWorkspace(dir: string, ports: Pick<EnginePorts, 'clock' | 'stores'>): Promise<InitResult> {
  const root = resolve(expandHome(dir));
  assertOutsideBundle(root, 'the workspace');
  if (existsSync(join(root, WORKSPACE_FILE))) return { root, created: false };
  if (existsSync(root)) {
    if (!statSync(root).isDirectory()) throw new EngineError('invalid', `${root} is not a folder`);
    const others = readdirSync(root).filter((n) => !n.startsWith('.'));
    if (others.length) throw new EngineError('invalid', `${root} is not empty and is not a workspace (no ${WORKSPACE_FILE}): choose an empty or new folder, or add a ${WORKSPACE_FILE} yourself`);
  }
  await mkdir(join(root, 'projects'), { recursive: true });
  const store = ports.stores.at(root, personScope(root, ports));
  await store.writeText(WORKSPACE_FILE, INIT_WORKSPACE_YAML, { ifMatch: null, what: 'workspace' });
  if (!existsSync(join(root, '.gitignore'))) await store.writeText('.gitignore', `${WORKSPACE_GITIGNORE.join('\n')}\n`, { ifMatch: null, what: 'workspace' });
  return { root, created: true };
}
