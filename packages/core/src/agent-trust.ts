/**
 * What work submitted through MCP may reference (L3.1, trust `mcp`, core HookTrust). The agent that drives the MCP
 * server writes the scenarios it runs (scenario_save), a project's README.md (project_update_readme) and new projects
 * (project_create), and reads what a run returns (error messages, screenshots). So, for that work:
 *
 * - a scenario never names a secret: no `{{env:…}}` / `{{keychain:…}}` anywhere in it (its steps, hooks, vars) nor in a
 *   code file it runs — only what a human wrote in project.yaml resolves them (personas' login steps, databases,
 *   mailbox, reset hooks) and the project's own hooks files;
 * - a file it references (drop_file.path, eval.file, a hook's sql / js file or a file its shell command names) is a
 *   file of the project folder: relative, never `..` out of it, never through a symbolic link that leaves it;
 * - a file it runs as code (eval.file, a hook's sql / js file, a script its shell command names) is not one the agent
 *   can write itself (README.md, scenarios/, and the folders runs and the tools write: runs/, renders/, review/,
 *   exports/, .demo-studio/).
 *
 * A `studio` command typed by a human (trust `author`) is not concerned.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sqlSource } from './destructive.js';
import { listSteps } from './steps.js';
import { collectSecretRefs } from './templating.js';
import type { HookStep, JsHookSpec, Scenario, SqlHookSpec } from './types.js';

/** Paths of a project folder an agent can write through MCP, or that runs and the tools write (relative, `/`). */
export const AGENT_WRITABLE_PATHS: readonly string[] = ['README.md', 'scenarios/', 'runs/', 'renders/', 'review/', 'exports/', '.demo-studio/'];

/** Whether a project-relative path (`/` or the platform separator) is one an agent can write through MCP. */
export function agentWritable(rel: string): boolean {
  const p = rel.split(sep).join('/').replace(/^\.\//, '');
  return AGENT_WRITABLE_PATHS.some((w) => (w.endsWith('/') ? p === w.slice(0, -1) || p.startsWith(w) : p.toLowerCase() === w.toLowerCase()));
}

/** The real path of `p`: its existing part resolved (symbolic links followed), the rest appended. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realPath(parent), basename(p));
  }
}

/**
 * Why a file reference of work submitted through MCP is refused, or null. `ref` is relative to `baseDir` (default the
 * project folder; a sandbox seed's: its sandbox.yaml folder) and must stay inside the project folder once symbolic
 * links are followed. `code`: the file is run (or sent to a database) — it must not be one an agent can write.
 */
export function projectFileProblem(projectDir: string, ref: string, o: { baseDir?: string; code?: boolean } = {}): string | null {
  if (isAbsolute(ref) || /^~(?:[\\/]|$)/.test(ref)) {
    return `${ref} is an absolute path: through MCP a file is referenced relative to the project folder, inside it`;
  }
  const root = realPath(resolve(projectDir));
  const target = realPath(resolve(o.baseDir ?? projectDir, ref));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return `${ref} resolves outside the project folder (${target}): through MCP only files of the project folder are read`;
  }
  if (o.code && agentWritable(rel)) {
    return `${ref} is a file an agent can write through MCP (${rel.split(sep).join('/')}): through MCP code is only run from files a human put elsewhere in the project (hooks/, assets/…)`;
  }
  return null;
}

/** A file a scenario references, with where. */
export interface ScenarioFileRef {
  ref: string;
  /** "scene intro step 2 (drop_file.path)", "setup hook 1 (sql file)". */
  where: string;
  /** Run as code (eval.file, a hook's sql / js file): must not be agent-writable. */
  code: boolean;
}

/** The files a hook names explicitly: its sql file (and its rollback's), its js file. */
export function hookFileRefs(hook: HookStep): Array<{ ref: string; what: string }> {
  const out: Array<{ ref: string; what: string }> = [];
  if (!hook || typeof hook !== 'object') return out;
  if ('sql' in hook) {
    const spec = (hook as { sql: string | SqlHookSpec }).sql;
    const own = sqlSource(spec);
    if (typeof own.file === 'string') out.push({ ref: own.file, what: 'sql file' });
    const rb = typeof spec === 'object' && spec ? spec.rollback : undefined;
    if (rb !== undefined) {
      const src = typeof rb === 'string' ? sqlSource(rb) : rb;
      if (typeof src?.file === 'string') out.push({ ref: src.file, what: 'sql rollback file' });
    }
  } else if ('js' in hook) {
    const spec = (hook as { js: string | JsHookSpec }).js;
    if (spec && typeof spec === 'object' && typeof spec.file === 'string') out.push({ ref: spec.file, what: 'js file' });
  }
  return out;
}

/** The files a scenario references by name (as written: a templated path is checked again when the step runs). */
export function scenarioFileRefs(sc: Scenario): ScenarioFileRef[] {
  const out: ScenarioFileRef[] = [];
  let steps: ReturnType<typeof listSteps> = [];
  try {
    steps = listSteps(sc, { includeSkipped: true });
  } catch {
    /* a malformed step: validation reports it */
  }
  for (const { step, ref } of steps) {
    const args = step.args as { path?: unknown; file?: unknown } | undefined;
    if (step.action === 'drop_file' && typeof args?.path === 'string') out.push({ ref: args.path, where: `step ${ref} (drop_file.path)`, code: false });
    if (step.action === 'eval' && typeof args?.file === 'string') out.push({ ref: args.file, where: `step ${ref} (eval.file)`, code: true });
  }
  for (const phase of ['setup', 'teardown'] as const) {
    (sc[phase] ?? []).forEach((hook, i) => {
      for (const f of hookFileRefs(hook)) out.push({ ref: f.ref, where: `${phase} hook ${i + 1}${hook?.name ? ` "${hook.name}"` : ''} (${f.what})`, code: true });
    });
  }
  return out;
}

/** The refusal of secret references in what an agent wrote or runs (trust `mcp`). */
export function secretRefsProblem(refs: Iterable<string>, where: string): string | null {
  const list = [...new Set(refs)];
  if (!list.length) return null;
  return (
    `${where} uses ${list.map((r) => `{{${r}}}`).join(', ')}: through MCP a scenario never resolves a secret — ` +
    "only project.yaml (personas' login steps, databases, mailbox, reset hooks) and the project's hooks files do; a human runs it in a terminal"
  );
}

/**
 * Why a scenario cannot run as work submitted through MCP (trust `mcp`): its secret references, and the files it
 * references outside the project folder or, run as code, in files an agent can write. Empty: nothing found.
 */
export function agentTrustProblems(project: { dir: string }, sc: Scenario): string[] {
  const problems: string[] = [];
  const secrets = secretRefsProblem(collectSecretRefs(sc), 'the scenario');
  if (secrets) problems.push(secrets);
  for (const f of scenarioFileRefs(sc)) {
    const p = projectFileProblem(project.dir, f.ref, { code: f.code });
    if (p) problems.push(`${f.where}: ${p}`);
  }
  return problems;
}
