/**
 * The workspace loaders bound to one disk (core file-facts.ts WorkspaceDisk): what a workspace, its projects, scenarios
 * and themes are, read by the loaders' own code (workspace.ts, project.ts, scenario.ts, template.ts, sandbox.ts) on
 * the disk given — their refusals, words and order are the same whatever answers the reads. `nodeWorkspaceReader` is
 * this machine's (the loaders' public names are it); `workspaceReader(memoryDisk(…))` reads maps (the engine's
 * MemoryWorkspace). The engine's WorkspaceReads port is this shape.
 */
import type { WorkPolicy } from '../agent-policy.js';
import type { WorkFileFacts, WorkspaceDisk } from '../file-facts.js';
import type { CreateProjectInput, NewProjectPlan } from '../project.js';
import type { ScenarioSource } from '../scenario.js';
import type { TemplateEntry } from '../template.js';
import type { LoadedProject, WorkspaceConfig } from '../types/project.js';
import type { LoadedScenario } from '../types/scenario.js';
import type { LoadedTemplate } from '../types/theme.js';
import { nodeWorkspaceDisk } from './file-facts.js';
import { listProjectsOn, loadProjectOn, planNewProjectOn } from './project.js';
import { loadScenarioOn, readScenarioSourceOn } from './scenario.js';
import type { ScenarioLoadOptions, ScenarioReadOptions } from './scenario.js';
import {
  listTemplatesOn,
  loadProjectTemplateOn,
  loadTemplateOn,
  projectTemplateFolderIdOn,
  projectTemplateFolderOn,
  sameTemplateFolderOn,
  templateFolderIdOn,
  templateFolderMatcherOn,
} from './template.js';
import type { TemplateLoadOptions, ThemeScope } from './template.js';
import { fileFacts } from './work-files.js';
import { findWorkspaceRootOn, findWorkspaceUpwardOn, loadWorkspaceConfigOn } from './workspace.js';

/** The workspace loaders on one disk (each as its namesake of `@retake/core/io` does on node:fs). */
export interface WorkspaceReader {
  /** The disk they read. */
  readonly disk: WorkspaceDisk;
  /** The FileFacts the checks of a work on this disk use, its videos probed under `policy` (io work-files.ts fileFacts). */
  fileFacts(policy: WorkPolicy): WorkFileFacts;
  findWorkspaceRoot(start?: string): string;
  findWorkspaceUpward(start: string): string | undefined;
  loadWorkspaceConfig(root: string): Promise<WorkspaceConfig>;
  listProjects(root: string): Promise<Array<{ slug: string; name: string; dir: string }>>;
  loadProject(dirOrSlug: string, root?: string): Promise<LoadedProject>;
  planNewProject(root: string, input: CreateProjectInput): Promise<NewProjectPlan>;
  readScenarioSource(project: LoadedProject, nameOrPath: string, o?: ScenarioReadOptions): Promise<ScenarioSource>;
  loadScenario(project: LoadedProject, nameOrPath: string, opts: ScenarioLoadOptions): Promise<LoadedScenario>;
  /** With `scope.projectDir`, the project's own themes first (core io template.ts listTemplates). */
  listTemplates(root: string, scope?: ThemeScope): Promise<TemplateEntry[]>;
  loadTemplate(nameOrDir: string, root: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate>;
  loadProjectTemplate(project: LoadedProject, override: string | undefined, o: TemplateLoadOptions): Promise<LoadedTemplate>;
  projectTemplateFolderId(project: Pick<LoadedProject, 'root' | 'dir'>, ref: string | undefined): Promise<string | undefined>;
  /** A theme folder's identity, as a render record holds it (`template_folder`: template.ts templateFolderId). */
  templateFolderId(dir: string, root: string, projectDir?: string): string;
  /** Whether a recorded theme folder id names today's (template.ts sameTemplateFolder: older ids read too). */
  sameTemplateFolder(recorded: string, current: string, project: Pick<LoadedProject, 'root' | 'dir'>): boolean;
  /** sameTemplateFolder for many recorded ids against one `current` (the real paths read once). */
  templateFolderMatcher(current: string, project: Pick<LoadedProject, 'root' | 'dir'>): (recorded: string) => boolean;
  /** The folder a project's work would load for a theme reference, and how it was found (template.ts projectTemplateFolder). */
  projectTemplateFolder(project: Pick<LoadedProject, 'root' | 'dir'>, ref: string): Promise<{ dir: string; via: 'path' | 'project' | 'workspace' | 'starter' }>;
}

/**
 * The loaders on `disk`. `facts` (default: node's fileFacts(policy)) gives the checks' FileFacts of a policy: a disk
 * that is not this machine's hands its own (its table and its videos).
 */
export function workspaceReader(disk: WorkspaceDisk, facts: (policy: WorkPolicy) => WorkFileFacts = fileFacts): WorkspaceReader {
  return Object.freeze({
    disk,
    fileFacts: facts,
    findWorkspaceRoot: (start?: string) => findWorkspaceRootOn(disk, start),
    findWorkspaceUpward: (start: string) => findWorkspaceUpwardOn(disk, start),
    loadWorkspaceConfig: (root: string) => loadWorkspaceConfigOn(disk, root),
    listProjects: (root: string) => listProjectsOn(disk, root),
    loadProject: (dirOrSlug: string, root?: string) => loadProjectOn(disk, dirOrSlug, root),
    planNewProject: (root: string, input: CreateProjectInput) => planNewProjectOn(disk, root, input),
    readScenarioSource: (project: LoadedProject, nameOrPath: string, o?: ScenarioReadOptions) => readScenarioSourceOn(disk, project, nameOrPath, o),
    loadScenario: (project: LoadedProject, nameOrPath: string, opts: ScenarioLoadOptions) => loadScenarioOn(disk, project, nameOrPath, opts),
    listTemplates: (root: string, scope?: ThemeScope) => listTemplatesOn(disk, root, scope),
    loadTemplate: (nameOrDir: string, root: string | undefined, o: TemplateLoadOptions) => loadTemplateOn(disk, nameOrDir, root, o),
    loadProjectTemplate: (project: LoadedProject, override: string | undefined, o: TemplateLoadOptions) => loadProjectTemplateOn(disk, project, override, o),
    projectTemplateFolderId: (project: Pick<LoadedProject, 'root' | 'dir'>, ref: string | undefined) => projectTemplateFolderIdOn(disk, project, ref),
    templateFolderId: (dir: string, root: string, projectDir?: string) => templateFolderIdOn(disk, dir, root, projectDir),
    sameTemplateFolder: (recorded: string, current: string, project: Pick<LoadedProject, 'root' | 'dir'>) => sameTemplateFolderOn(disk, recorded, current, project),
    templateFolderMatcher: (current: string, project: Pick<LoadedProject, 'root' | 'dir'>) => templateFolderMatcherOn(disk, current, project),
    projectTemplateFolder: (project: Pick<LoadedProject, 'root' | 'dir'>, ref: string) => projectTemplateFolderOn(disk, project, ref),
  });
}

/** This machine's workspace reader: the loaders on node:fs (nodeWorkspaceDisk), the checks' FileFacts fileFacts(policy). */
export const nodeWorkspaceReader: WorkspaceReader = workspaceReader(nodeWorkspaceDisk);
