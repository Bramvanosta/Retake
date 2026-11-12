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
export function parseProjectYaml(text: string, file?: undefined, files?: FileFacts): { config?: ProjectConfig; issues: ValidationIssue[] };
/** With its path: `files` is required (FilesWith, L7.34) — the hook files it names are looked at through it. */
export function parseProjectYaml(text: string, file: string | undefined, files: FileFacts): { config?: ProjectConfig; issues: ValidationIssue[] };
export function parseProjectYaml(text: string, file?: string, files?: FileFacts): { config?: ProjectConfig; issues: ValidationIssue[] } {
  const projectDir = file ? dirname(resolve(file)) : undefined;
  const { value, issues } = checkYamlDocument(
    text,
    ProjectFileSchema,
    (v, structural) => checkProject(v, structural, projectDir === undefined ? (files ? { files } : {}) : ({ projectDir, files } as { projectDir: string; files: FileFacts })),
    {},
    {
      formatVersion: { file: PROJECT_FILE, supported: FORMAT_VERSIONS.project },
    },
  );
  if (hasErrors(issues)) return { issues };
  return { config: applyProjectDefaults(value as ProjectFile), issues };
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  /** Full README.md content (default: a skeleton with the expected sections). */
  readme?: string;
  /** Environment name → its pages: page key → base URL, or `{url, display}` (the URL the browser frame shows). */
  environments?: Record<string, Record<string, string | { url: string; display?: string }>>;
  /** The environment used when a scenario does not say (default: the first one). */
  default_env?: string;
  /** Personas (L1.6): global, or keyed by environment name. */
  auth?: ProjectConfig['auth'];
  template?: string;
  capture?: Partial<CaptureSettings>;
  frame?: FrameStyle;
}

/** The pages a new project is created with, as readmeSkeleton takes them: the URLs, and the display URLs given. */
export function createdPages(environments: CreateProjectInput['environments'] = {}): [ProjectConfig['environments'], ProjectConfig['environment_settings']] {
  const urls: ProjectConfig['environments'] = {};
  const settings: NonNullable<ProjectConfig['environment_settings']> = {};
  for (const [env, pages] of Object.entries(environments)) {
    urls[env] = {};
    for (const [page, spec] of Object.entries(pages)) {
      urls[env][page] = typeof spec === 'string' ? spec : spec.url;
      if (typeof spec !== 'string' && spec.display !== undefined) settings[env] = { ...settings[env], display: { ...settings[env]?.display, [page]: spec.display } };
    }
  }
  return [urls, settings];
}

/** One line of a README's "Environments & links" section, as the skeleton writes it. */
function environmentLink(env: string, page: string, url: string, display?: string): string {
  return `- ${env} · ${page}: ${url}${display ? ` (shown as ${display})` : ''}`;
}

/**
 * One line of the "Environments & links" section that names an environment and its pages (hotfix v0.2.6, field point
 * 26): `- env · page: url`, as the skeleton writes it, and the forms a person writes — the name in bold or code
 * (`**stg**`), a note in parentheses after it (`(default)`), several pages on one line (`· console: <url> · admin:
 * <url>`), a description after the URLs. Null for any other line (a wrapped line's continuation included).
 */
export function readmeEnvironmentLine(line: string): { env: string; pages: string[] } | null {
  const plain = line.replace(/[*_`]/g, '');
  const m = /^\s*[-*]\s+([A-Za-z0-9][\w.-]*)\s*(?:\([^)]*\)\s*)?·\s*(.*)$/.exec(plain);
  if (!m) return null;
  const pages = [...m[2].matchAll(/(?:^|·)\s*([A-Za-z0-9][\w.-]*)\s*:\s*<?https?:\/\//g)].map((x) => x[1]);
  return pages.length ? { env: m[1], pages } : null;
}

/**
 * What a README's "## Environments & links" section no longer says about the project's environments (hotfix v0.2.2: the
 * section is written once, when the project is created, and environments are added to project.yaml later). `missing`:
 * pages whose URL the section does not mention; `gone`: lines in the skeleton's own form (`- env · page: url`) for an
 * environment or a page that no longer exists. Null when there is no such section, or nothing to say.
 */
export function readmeEnvironmentsDrift(readme: string, pages: ReadonlyArray<{ env: string; page: string; url: string; display?: string }>): { missing: string[]; gone: string[] } | null {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Environments\b/i.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  // A display URL ("shown as …") is not the page's own: another environment may live at that address.
  const text = section.join('\n').replace(/\(shown as [^)]*\)/g, '');
  const missing = pages.filter((p) => !text.includes(p.url.replace(/\/+$/, ''))).map((p) => environmentLink(p.env, p.page, p.url, p.display));
  const gone: string[] = [];
  for (const l of section) {
    const line = readmeEnvironmentLine(l);
    if (!line) continue;
    const known = pages.filter((p) => p.env === line.env);
    if (!known.length || line.pages.some((page) => !known.some((p) => p.page === page))) gone.push(l);
  }
  return missing.length || gone.length ? { missing, gone } : null;
}

/**
 * README.md skeleton: what an agent needs to write good scenarios for the product. `settings` (ProjectConfig
 * environment_settings) adds the display URL a page is shown as.
 */
export function readmeSkeleton(name: string, environments: ProjectConfig['environments'] = {}, settings: ProjectConfig['environment_settings'] = {}): string {
  const links = Object.entries(environments).flatMap(([env, pages]) =>
    Object.entries(pages).map(([page, url]) => {
      return environmentLink(env, page, url, settings[env]?.display?.[page]);
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
