/**
 * Where a new or re-made theme is written (R-SHR-12): the project's own themes folder (`<project>/templates/`)
 * when the call names a project, else the workspace's templates_dir — the one rule of every theme writer (a theme made
 * from brand files, from a site or from tokens, a copy, an update, a project adopting a workspace theme). A project
 * target writes through the project's store (journaled with its slug); the workspace target through the store of
 * templates_dir (`<templates_dir>`), refused when it lies inside the Retake package (the repository as a workspace: a
 * theme would land among the committed starters). A project of the repository's own fixture lies inside the package
 * too: its target is refused only when it IS the starters' folder.
 */
import { insideFolder } from '@retake/core/scenario';
import { projectLibraryDir } from '@retake/core/project';
import type { LoadedProject } from '@retake/core/project';
import { STARTER_TEMPLATES_DIR, nodeFileFacts } from '@retake/core/io';
import { realPathOf } from '@retake/core/policy';
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { EngineError } from './errors.js';
import { openProjectBySlug } from './projects.js';
import { checkProjectSlug } from './refs.js';
import type { ProjectStore, StoreScope } from './store/store.js';
import type { OpenedWorkspace } from './workspace.js';

/** Whether a path is a symbolic link (lstat; a missing path is not). */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The Retake package (the repository, or its install folder): no workspace theme is ever written inside it. */
export const PACKAGE_ROOT = dirname(STARTER_TEMPLATES_DIR);

/** The folder a theme writer writes into, its store, and how its words name it. */
export interface ThemeTarget {
  /** The folder new themes are made in (`<project>/templates` or templates_dir). */
  dir: string;
  /** The project, when the target is its own themes folder. */
  project?: LoadedProject;
  /** How a refusal names the folder ("the project's templates/", "templates_dir"). */
  noun: string;
  /** The store the writes of `scope` go through. */
  store(scope: StoreScope): ProjectStore;
}

/** The workspace's templates_dir as a target (refused inside the Retake package: see the header). */
export function workspaceThemeTarget(ws: OpenedWorkspace, what = 'a new theme'): ThemeTarget {
  const dir = ws.templatesDir;
  if (insideFolder(PACKAGE_ROOT, dir, nodeFileFacts)) {
    throw new EngineError('refused', `the workspace's templates_dir (${dir}) lies inside the Retake folder (${PACKAGE_ROOT}): ${what} would land among its starter themes`, {
      fix: 'work in a workspace of your own: set RETAKE_ROOT, or a retake.yaml whose templates_dir is outside the Retake folder',
    });
  }
  return { dir, noun: 'templates_dir', store: (scope) => scope.stores.at(dir, scope, { label: '<templates_dir>' }) };
}

/** A project's own themes folder as a target (refused when it is the starters' folder, or the workspace's templates_dir: then name no project). */
export function projectThemeTarget(ws: OpenedWorkspace, project: LoadedProject, what = 'a new theme'): ThemeTarget {
  const dir = projectLibraryDir(project.dir, 'templates');
  // The project's own folder, never through a link: a writer lands in the project, not where a link leads.
  if (isSymlink(dir)) {
    throw new EngineError('refused', `project ${project.slug}'s templates/ is a symbolic link: ${what} is written only into the project's own folder — replace the link with a folder`);
  }
  const real = realPathOf(dir, nodeFileFacts);
  if (!insideFolder(realPathOf(project.dir, nodeFileFacts), real, nodeFileFacts)) {
    throw new EngineError('refused', `project ${project.slug}'s templates/ leads out of the project folder: ${what} is written only into the project's own folder`);
  }
  if (real === realPathOf(STARTER_TEMPLATES_DIR, nodeFileFacts)) throw new EngineError('refused', `project ${project.slug}'s templates/ is the starter themes' folder: ${what} would land among them`);
  if (real === realPathOf(ws.templatesDir, nodeFileFacts)) {
    throw new EngineError('refused', `project ${project.slug}'s templates/ is the workspace's templates_dir: its themes are the workspace's — make ${what} without naming the project`);
  }
  return { dir, project, noun: `project ${project.slug}'s templates/`, store: (scope) => scope.stores.of(project, scope) };
}

/** The target of a theme writer: the named project's themes folder, else the workspace's templates_dir. */
export async function themeTarget(ws: OpenedWorkspace, projectSlug: string | undefined, what?: string): Promise<ThemeTarget> {
  if (projectSlug === undefined) return workspaceThemeTarget(ws, what);
  return projectThemeTarget(ws, await openProjectBySlug(ws, checkProjectSlug(projectSlug)), what);
}
