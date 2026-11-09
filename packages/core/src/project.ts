import { dirname, resolve } from 'node:path';
import type { z } from 'zod';
import { checkProject } from './checks/project.js';
import { FORMAT_VERSIONS } from './formats.js';
import type { FileFacts } from './file-facts.js';
import { normalizeEnvironments } from './env.js';
import { hasErrors } from './issues.js';
import { ProjectFileSchema } from './schemas/project.js';
import { DEFAULT_CAPTURE } from './types.js';
import type { CaptureSettings, FrameStyle, ProjectConfig, ValidationIssue } from './types.js';
import { checkYamlDocument } from './validation/document.js';

export const PROJECT_FILE = 'project.yaml';
export const README_FILE = 'README.md';
/** Project slugs: lower-case, digits and "-" (directory names, CLI arguments). */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export const DEFAULT_FRAME: FrameStyle = 'card';
export const DEFAULT_TEMPLATE_NAME = 'default';
/**
 * Every file Retake reads or writes in a workspace, in three classes (L3.1 guard-rail): `authored` (what a person
 * or Claude writes and keeps in git), `generated` (outputs, rebuilt from the authored files and a capture) and
 * `machine` (tool state of this machine: hook journals, sandbox state, the job queue and its history — never shared).
 * One list for the .gitignore written into a new project, for what `retake doctor` expects a workspace's own
 * .gitignore to name (nothing writes that one), and later for what a sync leaves out.
 * Sessions and secrets are not here: they live outside the workspace (~/.retake, the keychain).
 */
export const WORKSPACE_FILES = {
  workspace: {
    authored: ['retake.yaml', 'templates/', 'components/'],
    generated: [] as string[],
    /** jobs/<id>/ (the queue), workers/worker.lock, history.jsonl. */
    machine: ['.retake/'],
  },
  project: {
    /** comments/: frame comment threads (L3.6; their stills live in .retake/comments/, machine-local). */
    authored: ['project.yaml', 'README.md', 'scenarios/', 'hooks/', 'assets/', 'data/', 'sandbox/', 'comments/', '.gitignore'],
    generated: ['runs/', 'renders/', 'review/', 'exports/', 'frames/'],
    /** journals/ (hooks outside a capture), sandbox/ (sandbox state and logs). */
    machine: ['.retake/'],
  },
} as const;

/**
 * Generated folders of a project and its tool state (`.retake/`: hook journals, the state of its sandboxes) —
 * WORKSPACE_FILES' project `generated` + `machine`.
 */
export const PROJECT_GITIGNORE: readonly string[] = [...WORKSPACE_FILES.project.generated, ...WORKSPACE_FILES.project.machine];

/** What a workspace's own .gitignore names: its `.retake/` (the job queue and history of this machine). */
export const WORKSPACE_GITIGNORE: readonly string[] = [...WORKSPACE_FILES.workspace.generated, ...WORKSPACE_FILES.workspace.machine];

/** project.yaml as written (before defaults). */
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

/**
 * Defaults: capture = DEFAULT_CAPTURE merged, frame 'card', template 'default', environments {}. Environments are
 * normalised (L1.7): `environments` keeps the real page URLs of both forms, `environment_settings` the rest.
 */
export function applyProjectDefaults(file: ProjectFile): ProjectConfig {
  const { environments, settings } = normalizeEnvironments(file.environments);
  return {
    ...file,
    environments,
    ...(settings ? { environment_settings: settings } : {}),
    capture: { ...DEFAULT_CAPTURE, ...file.capture },
    frame: file.frame ?? DEFAULT_FRAME,
    template: file.template ?? DEFAULT_TEMPLATE_NAME,
  };
}

/**
 * Validate project.yaml text. `file` (its path) enables hook-file checks relative to the project dir (through `files`).
 * `config` (defaults applied) is returned only when there is no error-level issue.
 */
export function parseProjectYaml(text: string, file?: string, files?: FileFacts): { config?: ProjectConfig; issues: ValidationIssue[] } {
  const projectDir = file ? dirname(resolve(file)) : undefined;
  const { value, issues } = checkYamlDocument(text, ProjectFileSchema, (v, structural) => checkProject(v, structural, { projectDir, ...(files ? { files } : {}) }), {}, {
    formatVersion: { file: PROJECT_FILE, supported: FORMAT_VERSIONS.project },
  });
  if (hasErrors(issues)) return { issues };
  return { config: applyProjectDefaults(value as ProjectFile), issues };
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  /** Full README.md content (default: a skeleton with the expected sections). */
  readme?: string;
  environments?: ProjectConfig['environments'];
  /** Personas (L1.6): global, or keyed by environment name. */
  auth?: ProjectConfig['auth'];
  template?: string;
  capture?: Partial<CaptureSettings>;
  frame?: FrameStyle;
}

/**
 * README.md skeleton: what an agent needs to write good scenarios for the product. `settings` (ProjectConfig
 * environment_settings) adds the display URL a page is shown as.
 */
export function readmeSkeleton(
  name: string,
  environments: ProjectConfig['environments'] = {},
  settings: ProjectConfig['environment_settings'] = {},
): string {
  const links = Object.entries(environments).flatMap(([env, pages]) =>
    Object.entries(pages).map(([page, url]) => {
      const display = settings[env]?.display?.[page];
      return `- ${env} · ${page}: ${url}${display ? ` (shown as ${display})` : ''}`;
    }),
  );
  return [
    `# ${name}`,
    '',
    '## Product',
    '',
    '<!-- What the product is and does, in a few sentences. Key screens and vocabulary. -->',
    '',
    '## Audience',
    '',
    '<!-- Who the videos are for: role, context, familiarity with the product. -->',
    '',
    '## Goals',
    '',
    '<!-- What each video must make the viewer understand, feel or do. -->',
    '',
    '## Tone',
    '',
    '<!-- Pace, wording of captions, how much motion design (real capture first). -->',
    '',
    '## Environments & links',
    '',
    ...(links.length > 0 ? links : ['<!-- Staging / demo URLs (also declared in project.yaml under environments). -->']),
    '',
    '## Accounts (by reference — never passwords)',
    '',
    '<!-- Which account each scenario uses (the personas of project.yaml) and where its credentials live: password',
    '     manager entry or keychain item (keychain:service/account). `retake login` keeps sessions in ~/.retake. -->',
    '',
    "## Do / Don't",
    '',
    '- Do: ',
    "- Don't: ",
    '',
  ].join('\n');
}

/** A file of a new project: its project-relative ref and text. */
export interface NewProjectFile {
  ref: string;
  text: string;
}

/** What a new project is made of (planNewProject): its folder and its files, in the order they are written. */
export interface NewProjectPlan {
  /** The workspace root. */
  wsRoot: string;
  slug: string;
  /** projects/<slug>/ */
  dir: string;
  files: NewProjectFile[];
}
