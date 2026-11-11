import { AUTH_KEYS, PERSONA_NONE, SLUG_RE, loginPatternForm, resolveEnvironment, resolvePersonas } from '@retake/core';
import { checkNewProject, listProjects, listTemplates, retakeHome } from '@retake/core/io';
import type { AuthConfig, LoadedProject, PersonaConfig, ProjectConfig, WorkPolicy } from '@retake/core';
import { personScope, writeNewProject } from '@retake/engine';
import { EXIT, UsageError, errorMessage } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { plural } from '../ui.js';
import { cliPorts, openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { loginCommandFor, signInPersona } from './auth.js';

export interface NewOptions {
  name?: string;
  theme?: string;
  /** `--template`, the hidden name of `--theme` from before the glossary. */
  template?: string;
  /** Repeatable: "staging=console:https://console.staging.example.com,shop:https://shop.staging.example.com". */
  env?: string[];
}

/** Parse `--env name=key:url,key:url` values into project environments. */
export function parseEnvOptions(values: readonly string[]): ProjectConfig['environments'] {
  const out: ProjectConfig['environments'] = {};
  for (const value of values) {
    const eq = value.indexOf('=');
    if (eq <= 0) throw new UsageError(`--env "${value}": expected name=key:url[,key:url…]`);
    const name = value.slice(0, eq).trim();
    const pages: Record<string, string> = {};
    for (const item of value.slice(eq + 1).split(',')) {
      const colon = item.indexOf(':');
      const key = colon > 0 ? item.slice(0, colon).trim() : '';
      const url = colon > 0 ? item.slice(colon + 1).trim() : '';
      if (!key || !/^https?:\/\//i.test(url)) {
        throw new UsageError(`--env "${value}": "${item}" is not key:url (e.g. app:https://app.staging.example.com)`);
      }
      pages[key] = url;
    }
    out[name] = { ...out[name], ...pages };
  }
  return out;
}

/**
 * `retake new <slug>`: create a project. On a terminal without `--env`, it asks for the environments and, for each one,
 * the personas (the accounts the videos are filmed as) and offers to sign each one in (R-AUTH-08) — the slug, the
 * folder and the theme are checked before the first question.
 */
export async function newCommand(ui: Ui, global: GlobalOptions, slug: string, opts: NewOptions): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  let environments = parseEnvOptions(opts.env ?? []);
  let auth: Record<string, AuthConfig> | undefined;
  const interactive = ui.io.canPrompt && ui.io.ask !== undefined && ui.io.confirm !== undefined && !opts.env?.length;
  if (opts.theme !== undefined && opts.template !== undefined && opts.theme !== opts.template) throw new UsageError(`--theme ${opts.theme} and --template ${opts.template}: give the theme once (--template is the old name of --theme)`);
  const base = { name: opts.name ?? slug, slug, template: opts.theme ?? opts.template };
  if (interactive) {
    await checkNewProject(ws.root, base);
    ({ environments, auth } = await askSetup(ui));
  }
  const project = await writeNewProject(ws.root, { ...base, environments, ...(auth ? { auth } : {}) }, personScope(ws.root, cliPorts));
  const c = ui.c;
  ui.ok(`created project ${c.bold(project.slug)} in ${ui.path(project.dir)}`);
  ui.line(c.dim('  README.md     what the product is, audience, goals, tone, accounts (by reference)'));
  ui.line(c.dim(`  project.yaml  environments, capture size, theme (template:), personas${auth ? '' : ' (commented example)'}`));
  ui.line(c.dim('  scenarios/    one <name>.yaml per video'));
  ui.line(c.dim('  hooks/        sql / http / js / sh files used by setup and teardown'));
  if (Object.keys(environments).length === 0) ui.warn('no environment yet: add one under `environments:` in project.yaml');
  // Signed in with the workspace's browser settings (retake.yaml `browser`), as `retake login` would.
  const code = auth ? await offerSignIn(ui, global, await openProject(ws, project.dir), auth, ws.policy) : EXIT.ok;
  ui.line(`next: write scenarios/<name>.yaml, then ${c.bold(`retake validate ${project.slug} <name>`)}`);
  return code;
}

/** A name the questions take for an environment or a persona: letters, digits, "-" and "_" (core SLUG_RE). */
const NAME_RE = SLUG_RE;

/** The questions of `retake new` on a terminal: environments, then the personas of each one. */
async function askSetup(ui: Ui): Promise<{ environments: ProjectConfig['environments']; auth?: Record<string, AuthConfig> }> {
  const ask = ui.io.ask!;
  const confirm = ui.io.confirm!;
  const c = ui.c;
  ui.line(`${c.bold('Environments')} ${c.dim('— where the product runs: a name, then its pages as key:url, comma-separated')}`);
  const environments: ProjectConfig['environments'] = {};
  for (;;) {
    const first = Object.keys(environments).length === 0;
    const name = await ask(first ? '  Environment name (e.g. staging; empty to skip)' : '  Another environment (empty to finish)');
    if (name === '') break;
    if (!NAME_RE.test(name) || AUTH_KEYS.includes(name) || Object.hasOwn(environments, name)) {
      ui.warn(
        Object.hasOwn(environments, name)
          ? `"${name}" is already an environment`
          : AUTH_KEYS.includes(name)
            ? `"${name}" is a word of \`auth\`: pick another name`
            : `"${name}": letters, digits, "-" or "_", starting with a letter or digit`,
      );
      continue;
    }
    for (;;) {
      const pages = await ask(`  Pages of ${name} (e.g. app:https://app.${name}.example.com)`);
      try {
        if (pages === '') throw new UsageError('give at least one page');
        Object.assign(environments, parseEnvOptions([`${name}=${pages}`]));
        break;
      } catch (e) {
        ui.warn(errorMessage(e).replace(/^--env "[^"]*": /, ''));
      }
    }
  }
  if (Object.keys(environments).length === 0) return { environments };

  ui.line(`${c.bold('Personas')} ${c.dim('— the accounts the videos are filmed as; their sessions stay on this computer (~/.retake), never a password in the project')}`);
  const auth: Record<string, AuthConfig> = {};
  for (const [env, pages] of Object.entries(environments)) {
    const keys = Object.keys(pages);
    if (!(await confirm(`  Does ${env} need a sign-in?`))) continue;
    let loginUrl = '';
    for (;;) {
      loginUrl = await ask('  Its sign-in page (a path such as /login; empty if you do not know)');
      if (loginUrl === '' || loginPatternForm(loginUrl, keys).kind !== 'invalid') break;
      ui.warn(`"${loginUrl}" is not a sign-in page: write a path ("/login"), "<page>:<path>" or a URL`);
    }
    const personas: Record<string, PersonaConfig> = {};
    const owner = new Map<string, string>();
    for (;;) {
      const first = Object.keys(personas).length === 0;
      const name = await ask(first ? '  Persona name (the account, e.g. admin; empty to skip)' : '  Another persona (empty to finish)');
      if (name === '') break;
      const clash = Object.keys(personas).find((n) => n.toLowerCase() === name.toLowerCase());
      if (!NAME_RE.test(name) || name === PERSONA_NONE || clash) {
        ui.warn(clash ? `"${clash}" is already a persona` : name === PERSONA_NONE ? `"${PERSONA_NONE}" is reserved (a page without persona)` : `"${name}": letters, digits, "-" or "_", starting with a letter or digit`);
        continue;
      }
      const free = keys.filter((k) => !owner.has(k));
      let list: string[] = [];
      for (;;) {
        // Every page has its persona already: this one films none by default (empty), a scene picks it.
        const question = `  Pages ${name} is signed into (${keys.join(', ')}${free.length ? '' : '; each has a persona already: empty for none'})`;
        list = (await ask(question, free[0] ?? '')).split(/[\s,]+/).filter(Boolean);
        const unknown = list.find((k) => !keys.includes(k));
        const taken = list.find((k) => owner.has(k));
        if ((list.length > 0 || free.length === 0) && !unknown && !taken) break;
        ui.warn(unknown ? `"${unknown}" is not a page of ${env} (${keys.join(', ')})` : taken ? `${taken} is already signed in as ${owner.get(taken)}: a page belongs to one persona` : 'give at least one page');
      }
      for (const k of list) owner.set(k, name);
      if (list.length === 0) ui.line(c.dim(`  ${name} films no page by default: a scene picks it with \`persona: ${name}\` (on a page id of its own)`));
      const text = await ask(`  A text only visible when ${name} is signed in (the account name…; empty to skip)`);
      if (text === '' && loginUrl === '') ui.warn(`without a sign-in page or a signed-in text, an expired session of ${name} is noticed only when a step fails (edit check: in project.yaml)`);
      personas[name] = { ...(list.length ? { pages: list } : {}), check: { url: `${list[0] ?? keys[0]}:/`, ...(text ? { expect_text: text } : {}) } };
    }
    if (Object.keys(personas).length) auth[env] = { ...(loginUrl ? { login_url: loginUrl } : {}), personas };
  }
  return { environments, ...(Object.keys(auth).length ? { auth } : {}) };
}

/**
 * After `retake new`: sign each persona in now (a browser window), or say how to later. No answer (Ctrl-C at the
 * question, the end of the input) or Ctrl-C in a window: that persona and the next ones later; EXIT.interrupted then.
 */
async function offerSignIn(ui: Ui, global: GlobalOptions, project: LoadedProject, auth: Record<string, AuthConfig>, policy: WorkPolicy): Promise<ExitCode> {
  const later: string[] = [];
  const command = loginCommandFor(global);
  let asking = true;
  let code: ExitCode = EXIT.ok;
  for (const [env, block] of Object.entries(auth)) {
    for (const name of Object.keys(block.personas ?? {})) {
      const cmd = command({ project: project.slug, env, persona: name });
      let now = false;
      if (asking) {
        try {
          now = await ui.io.confirm!(`Sign ${name} in on ${env} now? A browser window opens`);
        } catch {
          asking = false;
        }
      }
      if (!now) {
        later.push(cmd);
        continue;
      }
      const persona = resolvePersonas(project, env, { home: retakeHome() }).find((p) => p.name === name)!;
      try {
        const r = await signInPersona(ui, global, project, resolveEnvironment(project, env), persona, { policy });
        if (r === EXIT.interrupted) {
          asking = false;
          code = r;
        }
        if (r !== EXIT.ok) later.push(cmd);
      } catch (e) {
        ui.error(errorMessage(e));
        later.push(cmd);
      }
    }
  }
  for (const cmd of later) ui.line(`sign in later: ${ui.c.bold(cmd)}`);
  return code;
}

export async function listCommand(ui: Ui, global: GlobalOptions, opts: { json?: boolean }): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const projects = await listProjects(ws.root);
  const templates = await listTemplates(ws.root);
  const detailed = await Promise.all(
    projects.map(async (p) => {
      try {
        const loaded = await openProject(ws, p.dir);
        return { ...p, scenarios: loaded.scenarios, environments: Object.keys(loaded.config.environments), error: undefined };
      } catch (e) {
        return { ...p, scenarios: [] as string[], environments: [] as string[], error: (e as Error).message.split('\n')[0] };
      }
    }),
  );
  if (opts.json) {
    ui.result(JSON.stringify({ root: ws.root, projects: detailed, templates }, null, 2));
    return EXIT.ok;
  }
  const c = ui.c;
  ui.result(`${c.bold('Projects')} ${c.dim(ui.path(ws.projectsDir))}`);
  if (detailed.length === 0) ui.result(c.dim('  none yet — create one with `retake new <slug>`'));
  const width = Math.max(0, ...detailed.map((p) => p.slug.length));
  for (const p of detailed) {
    const info = p.error
      ? c.red(p.error)
      : `${p.name}  ${c.dim(`${plural(p.scenarios.length, 'scenario')}${p.scenarios.length ? `: ${p.scenarios.join(', ')}` : ''}`)}`;
    ui.result(`  ${c.bold(p.slug.padEnd(width))}  ${info}`);
  }
  ui.result(`${c.bold('Themes')} ${c.dim(ui.path(ws.templatesDir))}`);
  ui.result(templates.length ? `  ${templates.map((t) => (t.source === 'starter' ? `${t.name} ${c.dim('(starter)')}` : t.name)).join(', ')}` : c.dim('  none'));
  return EXIT.ok;
}
