/**
 * What work submitted through MCP may reference (L3.1, trust `mcp`, core HookTrust). The agent that drives the MCP
 * server writes the scenarios it runs (scenario_save), a project's README.md (project_update_readme) and new projects
 * (project_create), and reads what a run returns (error messages, screenshots). So, for that work:
 *
 * - a scenario never names a secret: no `{{env:…}}` / `{{keychain:…}}` (nor a sandbox's `{{compose_env:…}}` /
 *   `{{accounts.<persona>.password}}`; an http hook acts as an account with `auth: {persona}`) anywhere in it (its steps, hooks, vars) nor in a
 *   code file it runs — only what a human wrote in project.yaml resolves them (personas' login steps, databases,
 *   mailbox, reset hooks) and the project's own hooks files;
 * - a file it references (drop_file.path, eval.file, a hook's sql / js file or a file its shell command names) is a
 *   file of the project folder: relative, never `..` out of it, never through a symbolic link that leaves it;
 * - a file it runs as code (eval.file, a hook's sql / js file, a script its shell command names) is not one the agent
 *   can write itself (README.md, scenarios/, comments/ — L3.6: an agent appends replies and resolutions to frame comment
 *   threads —, and the folders runs and the tools write: runs/, renders/, review/, exports/, .retake/), nor a
 *   brand source of a theme (engine brand files).
 *
 * L3.2, renders: every file a render reads (card / overlay images, `data:` CSV slots, own media, music) is a file of the
 * project folder, a Lottie file counts as code (lottie-web evaluates the expressions it holds), and a theme is named,
 * never a folder — except the project's own `template:` of project.yaml, which a human wrote (renderFileProblems,
 * templateRefProblem; the editor's planRun applies them before any file is read, then checks every file the plan
 * serves).
 *
 * Navigation: with the environment a run opens, every absolute URL the scenario opens has the exact origin of one of
 * the environment's pages (core navigationProblem; a person adds another origin as a page in project.yaml).
 *
 * A `retake` command typed by a human (trust `author`) is not concerned.
 */
import { isAbsolute, resolve, sep } from 'node:path';
import { sqlSource } from './destructive.js';
import { LOTTIE_FILE_EXTENSIONS, fileExtension } from './media.js';
import { listSteps } from './steps.js';
import { resolvePersonas } from './auth.js';
import { collectSandboxRefs, collectSecretRefs } from './templating.js';
import { agentWritable, canonicalOrigin, realPathOf, scenarioNavigationProblems } from './agent-policy.js';
import { confinementOrDefault, confinementWords } from './confinement.js';
import type { Confinement } from './confinement.js';
import { needFiles } from './file-facts.js';
import type { FileFacts } from './file-facts.js';
import { formatPath } from './issues.js';
import { pathInside, relativeInside } from './path-inside.js';
import type { IssuePath } from './issues.js';
import { locateOffset, parseYaml } from './validation/yaml-source.js';
import type { HookStep, JsHookSpec, LoadedProject, Scenario, SqlHookSpec } from './types.js';

/** Whether `p` is `dir` or inside it, once symbolic links are followed on both (pathInside with `real`: realPathOf of each, resolved against the current folder). */
export function insideFolder(dir: string, p: string, files: FileFacts): boolean {
  return pathInside(p, dir, { real: (x: string): string => realPathOf(resolve(x), files) });
}

/**
 * Why a file reference of work submitted through MCP is refused, or null. `ref` is relative to `baseDir` (default the
 * project folder; a sandbox seed's: its sandbox.yaml folder) and must stay inside the project folder once symbolic
 * links are followed. `code`: the file is run (or sent to a database) — it must not be one an agent can write.
 */
export function projectFileProblem(projectDir: string, ref: string, o: { baseDir?: string; code?: boolean; via?: Confinement; files: FileFacts }): string | null {
  const through = confinementWords(o.via);
  if (isAbsolute(ref) || /^~(?:[\\/]|$)/.test(ref)) {
    return `${ref} is an absolute path: ${through} a file is referenced relative to the project folder, inside it`;
  }
  const files = needFiles(o.files, 'projectFileProblem');
  const root = realPathOf(resolve(projectDir), files);
  const target = realPathOf(resolve(o.baseDir ?? projectDir, ref), files);
  const rel = relativeInside(target, root);
  if (rel === undefined) {
    // Never the target itself: a path outside the project is not the agent's to learn (L4.1 review A).
    return `${ref} resolves outside the project folder: ${through} only files of the project folder are read`;
  }
  if (o.code && agentWritable(rel)) {
    const writes = confinementOrDefault(o.via).writesThrough;
    return `${ref} is a file an agent can write${writes ? ` ${writes}` : ''} (${rel.split(sep).join('/')}): ${through} code is only run from files a human put elsewhere in the project (hooks/, assets/…)`;
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
  // Named hooks (L5.8): what `hook:` steps run during the take.
  for (const [name, v] of Object.entries(sc.hooks && typeof sc.hooks === 'object' ? sc.hooks : {})) {
    (Array.isArray(v) ? v : [v]).forEach((hook, i, all) => {
      for (const f of hookFileRefs(hook)) out.push({ ref: f.ref, where: `hook "${name}"${all.length > 1 ? ` entry ${i + 1}` : ''} (${f.what})`, code: true });
    });
  }
  return out;
}

/** The refusal of secret references in what an agent wrote or runs (trust `mcp`). */
export function secretRefsProblem(refs: Iterable<string>, where: string, via?: Confinement): string | null {
  const list = [...new Set(refs)];
  if (!list.length) return null;
  return (
    `${where} uses ${list.map((r) => `{{${r}}}`).join(', ')}: ${confinementWords(via)} a scenario never resolves a secret — ` +
    "only project.yaml (personas' login steps, databases, mailbox, reset and named hooks) and the project's hooks files do; a human runs it in a terminal"
  );
}

/** A template reference that names a folder (absolute, `./…`, `../…`, or with a separator) rather than a theme name. */
export function isTemplatePath(ref: string): boolean {
  return isAbsolute(ref) || ref.startsWith('.') || ref.startsWith('~') || /[\\/]/.test(ref);
}

/**
 * Why a theme reference of work submitted through MCP is refused, or null: a theme is named (a folder of the
 * workspace's templates_dir or a starter), never a folder — except the project's own `template:` of project.yaml
 * (`projectTemplate`), written by a human. `where`: "the scenario's template", "the run's theme"…
 */
export function templateRefProblem(ref: string | undefined, projectTemplate: string | undefined, where: string, via?: Confinement): string | null {
  if (ref === undefined || !isTemplatePath(ref) || ref === projectTemplate) return null;
  const lists = confinementOrDefault(via).themeList;
  return (
    `${where} is a folder (${ref}): ${confinementWords(via)} a theme is named${lists ? ` (${lists} names them)` : ''} — a theme folder is used only ` +
    "when project.yaml's own template: names it (a human edits project.yaml)"
  );
}

/** A file a render reads, with where it is named ("scene intro card, slot logo"). */
export interface RenderFileRef {
  ref: string;
  where: string;
}

/**
 * Why the files a render reads are refused (trust `mcp`): each must be a file of the project folder (relative, no
 * `..`, no symbolic link out of it), and a Lottie file (code: lottie-web evaluates its expressions) not one an agent
 * can write. One positioned message per file.
 */
export function renderFileProblems(projectDir: string, refs: readonly RenderFileRef[], files: FileFacts): string[] {
  const out: string[] = [];
  for (const f of refs) {
    const code = LOTTIE_FILE_EXTENSIONS.includes(fileExtension(f.ref));
    const p = projectFileProblem(projectDir, f.ref, { code, files });
    if (p) out.push(`${f.where}: ${code ? `${p} (a Lottie file is code: its expressions run in the render)` : p}`);
  }
  return out;
}

/** The environment a run of agent work opens (core ResolvedEnvironment): its name and its pages. */
export interface AgentTrustEnvironment {
  name: string;
  pages: Readonly<Record<string, string>>;
}

/** What agentTrustProblems(At) is given besides the scenario. */
export interface AgentTrustOptions {
  /** The words of the work's confinement (the rules are the same; AGENT_CONFINEMENT when absent). */
  via?: Confinement;
  /**
   * The environment the run opens, when it is known (a submit, the worker): every absolute URL the scenario opens must
   * have the exact origin of one of its pages (core navigationProblem with `origins`). Without it (a save), the URLs
   * get the scheme rule of the validation only.
   */
  env?: AgentTrustEnvironment;
  /** How the files it names are looked at (core FileFacts): real paths. */
  files: FileFacts;
}

/**
 * The navigation problems of agent work on a known environment (AgentTrustOptions.env), each with where it is: the part
 * of agentTrustProblems about the URLs it opens (the Studio words them apart: "opens another site").
 */
export function navigationTrustProblems(sc: Scenario, o: Omit<AgentTrustOptions, 'files'>): Array<{ path: IssuePath; message: string }> {
  if (!o.env) return [];
  const origins = [
    ...new Set(
      Object.values(o.env.pages)
        .map(canonicalOrigin)
        .filter((x): x is string => x !== null),
    ),
  ];
  return scenarioNavigationProblems(sc, { origins, pageKeys: Object.keys(o.env.pages), envName: o.env.name, ...(o.via ? { via: o.via } : {}) }).map((p) => ({
    path: p.path,
    message: `${formatPath(p.path)}: ${p.message}`,
  }));
}

/** The origins of the pages a persona signs in to on an environment: its `pages`, as that environment's URLs. */
export function personaPageOrigins(pages: readonly string[], envPages: Readonly<Record<string, string>>): string[] {
  const out = new Set<string>();
  for (const k of pages) {
    const o = Object.hasOwn(envPages, k) ? canonicalOrigin(envPages[k]) : null;
    if (o) out.add(o);
  }
  return [...out];
}

/**
 * Trust `mcp`: an http hook acting as a persona (`auth: {persona}`) sends that persona's session only to the persona's
 * own pages — the origin of `url` must be the origin of a page the persona signs in to (`allowed`: personaPageOrigins).
 * One sentence when it is not (`url` null: its origin cannot be told before it runs); null when it is.
 */
export function personaAuthOriginProblem(persona: string, url: string | null, allowed: readonly string[], via?: Confinement): string | null {
  const origin = url === null ? null : canonicalOrigin(url);
  if (origin !== null && allowed.includes(origin)) return null;
  return (
    `${confinementWords(via)} an http hook acting as persona ${persona} (\`auth: {persona}\`) sends its session only to that persona's own pages ` +
    `(${allowed.join(', ') || 'none'}): ${origin ?? "its URL's origin cannot be told before it runs"}${origin ? ' is not one of them' : ''}`
  );
}

const TEMPLATE_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * The origin a hook URL template has on an environment: its page tokens (`{{app}}`) filled with the environment's URLs;
 * null when another token could change the origin (a variable in the host) or the result is not an http(s) URL.
 */
function templateOrigin(url: string, envPages: Readonly<Record<string, string>>): string | null {
  const fill = (other: string) => url.replace(TEMPLATE_TOKEN, (_m, expr: string) => (Object.hasOwn(envPages, expr) ? envPages[expr].replace(/\/+$/, '') : other));
  const a = canonicalOrigin(fill('a'));
  return a !== null && a === canonicalOrigin(fill('b')) ? a : null;
}

/**
 * Agent trust for the http hooks of a scenario that act as a persona (`auth: {persona}`, their rollbacks too): on every
 * environment of the project (only `o.env`'s when it is known) where the persona is declared, the hook's URL must have
 * the origin of one of the persona's own pages (personaAuthOriginProblem). Needs the loaded project (its environments
 * and personas); the hooks runner holds the same rule on the rendered URL.
 */
export function personaAuthTrustProblems(project: { dir: string; slug?: string; config?: object }, sc: Scenario, o: Omit<AgentTrustOptions, 'files'>): Array<{ path: IssuePath; message: string }> {
  const full = project as Partial<Pick<LoadedProject, 'slug' | 'config' | 'sandboxes'>> & { dir: string };
  const environments = full.config && 'environments' in full.config ? full.config.environments : undefined;
  if (!full.slug || !full.config || !environments) return [];
  const loaded = full as Pick<LoadedProject, 'slug' | 'dir' | 'config'> & Partial<Pick<LoadedProject, 'sandboxes'>>;
  const envs = o.env ? [{ name: o.env.name, pages: o.env.pages }] : Object.entries(environments).map(([name, pages]) => ({ name, pages }));
  const out: Array<{ path: IssuePath; message: string }> = [];
  const check = (h: unknown, path: IssuePath) => {
    if (!h || typeof h !== 'object' || !('http' in h)) return;
    const http = (h as { http: unknown }).http;
    if (!http || typeof http !== 'object') return;
    const rb = (http as { rollback?: unknown }).rollback;
    for (const [req, rp] of [
      [http, [...path, 'http']],
      [rb, [...path, 'http', 'rollback']],
    ] as Array<[unknown, IssuePath]>) {
      if (!req || typeof req !== 'object') continue;
      const { auth, url } = req as { auth?: { persona?: unknown }; url?: unknown };
      const persona = auth && typeof auth === 'object' ? auth.persona : undefined;
      if (typeof persona !== 'string' || typeof url !== 'string') continue;
      for (const env of envs) {
        const p = resolvePersonas(loaded, env.name, { home: '/' }).find((x) => x.name === persona);
        if (!p) continue;
        const origin = templateOrigin(url, env.pages);
        const problem = personaAuthOriginProblem(persona, origin, personaPageOrigins(p.pages, env.pages), o.via);
        if (problem) {
          out.push({ path: [...rp, 'url'], message: `${formatPath([...rp, 'url'])}: ${problem}${envs.length > 1 ? ` (environment ${env.name})` : ''}` });
          break;
        }
      }
    }
  };
  const list = (v: unknown, path: IssuePath) => (Array.isArray(v) ? v.forEach((h, i) => check(h, [...path, i])) : check(v, path));
  list(sc.setup ?? [], ['setup']);
  list(sc.teardown ?? [], ['teardown']);
  const own = sc.hooks && typeof sc.hooks === 'object' ? (sc.hooks as Record<string, unknown>) : {};
  for (const [name, v] of Object.entries(own)) list(v, ['hooks', name]);
  return out;
}

/**
 * Why a scenario cannot run as work submitted through MCP (trust `mcp`): its secret references, and the files it
 * references outside the project folder or, run as code, in files an agent can write; with the project's config, a
 * theme it names by folder (`template:`); with the environment it runs on (`o.env`), a URL it opens on another origin
 * than the environment's pages. Empty: nothing found.
 */
export function agentTrustProblems(project: { dir: string; config?: { template?: string } }, sc: Scenario, o: AgentTrustOptions): string[] {
  const problems: string[] = [];
  if (project.config && typeof sc.template === 'string') {
    const t = templateRefProblem(sc.template, project.config.template, "the scenario's template", o.via);
    if (t) problems.push(t);
  }
  const secrets = secretRefsProblem([...collectSecretRefs(sc), ...collectSandboxRefs(sc)], 'the scenario', o.via);
  if (secrets) problems.push(secrets);
  for (const f of scenarioFileRefs(sc)) {
    const p = projectFileProblem(project.dir, f.ref, { code: f.code, ...(o.via ? { via: o.via } : {}), files: o.files });
    if (p) problems.push(`${f.where}: ${p}`);
  }
  for (const p of navigationTrustProblems(sc, o)) problems.push(p.message);
  for (const p of personaAuthTrustProblems(project, sc, o)) problems.push(p.message);
  return problems;
}

/** A problem of agentTrustProblems with where it is in the file: its data path, and line / column when known. */
export interface PositionedTrustProblem {
  message: string;
  path: IssuePath;
  line?: number;
  col?: number;
}

/** Every string of a parsed YAML value with its path (`note` fields skipped: never templated). */
function stringLeaves(v: unknown, path: IssuePath, out: Array<{ path: IssuePath; text: string }>): void {
  if (typeof v === 'string') out.push({ path, text: v });
  else if (Array.isArray(v)) v.forEach((x, i) => stringLeaves(x, [...path, i], out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'note') stringLeaves(x, [...path, k], out);
}

/**
 * agentTrustProblems with where each one is in `text`, the file `sc` was parsed from (L4.3, critique B11: "line 42 uses
 * {{env:SHOP_TOKEN}}"): one problem per string holding a secret reference (its path, line and column), a file
 * reference at the string that names it, a template folder at `template`. The same rules; a problem that cannot be
 * placed keeps an empty path and no line.
 */
export function agentTrustProblemsAt(project: { dir: string; config?: { template?: string } }, sc: Scenario, text: string, o: AgentTrustOptions): PositionedTrustProblem[] {
  const parsed = parseYaml(text);
  const at = (message: string, path: IssuePath): PositionedTrustProblem => {
    const off = path.length && parsed.value !== undefined ? locateOffset(parsed.source, path) : undefined;
    if (off === undefined) return { message, path };
    const { line, col } = parsed.source.lineCounter.linePos(off);
    return { message, path, line, col };
  };
  const out: PositionedTrustProblem[] = [];
  if (project.config && typeof sc.template === 'string') {
    const t = templateRefProblem(sc.template, project.config.template, "the scenario's template", o.via);
    if (t) out.push(at(t, ['template']));
  }
  const leaves: Array<{ path: IssuePath; text: string }> = [];
  stringLeaves(parsed.value, [], leaves);
  let placed = 0;
  for (const leaf of leaves) {
    const p = secretRefsProblem([...collectSecretRefs(leaf.text), ...collectSandboxRefs(leaf.text)], 'the scenario', o.via);
    if (!p) continue;
    out.push(at(p, leaf.path));
    placed++;
  }
  if (!placed) {
    // Never fewer refusals than agentTrustProblems: a reference the walk did not see is still reported, unplaced.
    const p = secretRefsProblem([...collectSecretRefs(sc), ...collectSandboxRefs(sc)], 'the scenario', o.via);
    if (p) out.push({ message: p, path: [] });
  }
  for (const f of scenarioFileRefs(sc)) {
    const p = projectFileProblem(project.dir, f.ref, { code: f.code, ...(o.via ? { via: o.via } : {}), files: o.files });
    if (!p) continue;
    const named = leaves.filter((l) => l.text === f.ref || (l.text.includes(f.ref) && f.ref.length > 2));
    const leaf = named.find((l) => ['path', 'file', 'drop_file', 'eval', 'sql', 'js'].includes(String(l.path[l.path.length - 1]))) ?? named[0];
    out.push(at(`${f.where}: ${p}`, leaf?.path ?? []));
  }
  for (const p of navigationTrustProblems(sc, o)) out.push(at(p.message, p.path));
  for (const p of personaAuthTrustProblems(project, sc, o)) out.push(at(p.message, p.path));
  return out;
}
