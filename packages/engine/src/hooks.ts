/**
 * Hooks outside a capture (L3.1, moved from the CLI's hooks commands): pick a hooks source, build the context hooks run
 * in (access, js hook browsers per persona, write guard, approvals), run the project's reset. `retake hooks run`,
 * `retake env reset` and `retake hooks rollback` call these with their native options and errors; the jobs worker calls
 * them for `hooks` and `env_reset` jobs (trust `mcp`, approvals from the job). Nothing here prints or installs signal
 * handlers: the caller logs through `log` and handles interrupts.
 */
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ScenarioError, compileWritePolicy, guardsWrites, hasErrors, loginMatchers, matchLoginUrl, newRunId, parseHookFile, planPersonas, resolveEnvironment, resolvePersonas, resolveRunAccess, runAccess, urlOriginPath, pathInside, GUIDE } from '@retake/core';
import { loadScenario, retakeHome, nodeFileFacts } from '@retake/core/io';
import type { AgentChannel, HookStep, HookTrust, LoadedProject, ResolvedPersona, RunAccess, Scenario, ErrorKind, WorkPolicy, WorkFileFacts } from '@retake/core';
import type { HookContext, HookPhase } from '@retake/hooks';
import type { LoginCommandOf } from './auth.js';
import type { Caller } from './caller.js';
import { hookRunRecorder } from './store/journal.js';

/**
 * A hooks source that cannot be used: `usage` — not a hooks source at all (the CLI: a usage error, exit 2); otherwise
 * a source that names nothing to run (no reset hooks, a scenario without that list, a missing file).
 */
export class HooksSourceError extends Error {
  constructor(
    message: string,
    readonly usage: boolean,
  ) {
    super(message);
    this.name = 'HooksSourceError';
  }

  /** What a client outside the CLI is told (core error-kind.ts). */
  get errorKind(): ErrorKind {
    return this.usage ? 'invalid' : 'not_found';
  }

  get errorDocs(): string {
    return GUIDE.scenarios;
  }
}

export interface HookSelection {
  /** "reset", "<scenario>-setup", the file's base name: journal ids and headers. */
  label: string;
  hooks: HookStep[];
  phase: HookPhase;
  vars?: Record<string, string>;
  env?: string;
  /** The scenario of `<scenario>:setup|teardown` (its js hook tabs are bound as in its run). */
  scenario?: Scenario;
  /** `<scenario>:setup|teardown`: sha256 of the scenario file's bytes these hooks were read from (one read). */
  sha256?: string;
}

const SCENARIO_HOOKS_RE = /^([^:/\\]+):(setup|teardown)$/;

/** The scenario name of a `<scenario>:setup|teardown` hooks source (undefined for any other source). */
export function scenarioOfHooksSource(spec: string): string | undefined {
  return SCENARIO_HOOKS_RE.exec(spec)?.[1];
}

/**
 * The hooks of `spec`: `reset` (project.yaml), `<scenario>:setup` / `<scenario>:teardown`, or a YAML file of hooks.
 * `projectFilesOnly` (a client outside the CLI): a file must be `hooks/<name>.yaml` of the project, its real path
 * inside the project — never an absolute path or one relative to the current folder. `expectSha256`: the scenario of
 * `<scenario>:setup|teardown` is read once and parsed only when its bytes have that sha256 (core ScenarioChangedError).
 */
export async function selectHooks(project: LoadedProject, spec: string, envOpt: string | undefined, o: { projectFilesOnly?: boolean; expectSha256?: string; files: WorkFileFacts }): Promise<HookSelection> {
  if (spec === 'reset') {
    const hooks = project.config.reset ?? [];
    if (!hooks.length) throw new HooksSourceError(`project "${project.slug}" declares no reset hooks (add \`reset:\` to project.yaml)`, false);
    return { label: 'reset', hooks, phase: 'reset' };
  }
  const m = SCENARIO_HOOKS_RE.exec(spec);
  if (m) {
    const [, name, which] = m;
    const loaded = await loadScenario(project, name, { files: o.files, env: envOpt, ...(o.expectSha256 !== undefined ? { expectSha256: o.expectSha256 } : {}) });
    const hooks = (which === 'setup' ? loaded.scenario.setup : loaded.scenario.teardown) ?? [];
    if (!hooks.length) throw new HooksSourceError(`scenario "${loaded.name}" has no ${which} hooks`, false);
    return {
      label: `${loaded.name}-${which}`,
      hooks,
      phase: which as HookPhase,
      vars: loaded.scenario.vars,
      env: loaded.scenario.env,
      scenario: loaded.scenario,
      ...(loaded.sha256 !== undefined ? { sha256: loaded.sha256 } : {}),
    };
  }
  if (/\.ya?ml$/i.test(spec)) {
    let file: string | undefined;
    if (o.projectFilesOnly) {
      if (!/^hooks\/[A-Za-z0-9][A-Za-z0-9_-]*\.ya?ml$/.test(spec)) {
        throw new HooksSourceError(`"${spec}" is not a hooks file of the project: use hooks/<name>.yaml`, true);
      }
      const candidate = resolve(project.dir, spec);
      if (existsSync(candidate)) {
        const realProject = await realpath(project.dir);
        if (!pathInside(await realpath(candidate), realProject, { compare: 'spelling' })) throw new HooksSourceError(`hooks file "${spec}" leads outside the project`, true);
        file = candidate;
      }
      if (!file) throw new HooksSourceError(`hooks file "${spec}" not found (looked in ${candidate})`, false);
    } else {
      const candidates = isAbsolute(spec) ? [spec] : [resolve(project.dir, spec), resolve(spec)];
      file = candidates.find((f) => existsSync(f));
      if (!file) throw new HooksSourceError(`hooks file "${spec}" not found (looked in ${candidates.join(' and ')})`, false);
    }
    const { hooks, issues } = parseHookFile(await readFile(file, 'utf8'), { file, project, files: nodeFileFacts });
    if (!hooks || hasErrors(issues)) throw new ScenarioError(`hooks file ${file} is invalid`, issues, file);
    const base = file.replace(/^.*[\\/]/, '').replace(/\.ya?ml$/i, '');
    return { label: base, hooks, phase: 'setup' };
  }
  throw new HooksSourceError(`"${spec}" is not a hooks source: use <scenario>:setup, <scenario>:teardown, reset, or a .yaml file of hooks`, true);
}

/**
 * The access of a hooks command (L1.7): its environment's, with `allowWrites` (core AccessError on a read-only
 * environment), and the hosts of the project's read-only environments it must not write to. Journal replays judge each
 * entry by its own environment (`accessOf`).
 */
export function hooksAccess(project: LoadedProject, env: ReturnType<typeof resolveEnvironment>, allowWrites: boolean): { access: RunAccess; accessOf: (name: string) => RunAccess | undefined } {
  const access = resolveRunAccess(env, { allowWrites, project });
  const accessOf = (name: string): RunAccess | undefined => {
    try {
      return runAccess(resolveEnvironment(project, name), allowWrites, project);
    } catch {
      return undefined; // an environment no longer in project.yaml: the command's access
    }
  };
  return { access, accessOf };
}

export interface HookContextOptions {
  /** What the work runs under (core WorkPolicy): the hooks' shell environment and js-hook browser. */
  policy: WorkPolicy;
  env?: string;
  /** Let hooks write to a production environment whose project.yaml sets `access: read-write` (CLI only). */
  allowWrites?: boolean;
  /** Describe and security-check without executing. */
  dry?: boolean;
  /** A scenario's own vars (over project.yaml's): with trust `mcp`, the variables the agent wrote (HookContext.agentVars). */
  vars?: Record<string, string>;
  runId?: string;
  scenario?: Scenario;
  /** Default `author` (the CLI); `mcp` for jobs submitted through the MCP server. */
  trust?: HookTrust;
  /** The channel trust-`mcp` work came through, for the wording of refusals (`studio`: the Studio; default `mcp`). */
  via?: AgentChannel;
  /** Every message of the hooks (redacted by them). */
  log: HookContext['log'];
  /** Approves a hook that needs a human (CLI: --yes or the prompt; the worker: the job's approvals). */
  confirm?: HookContext['confirmDestructive'];
  /** The command that signs a persona in again, as messages print it. */
  loginCommand: LoginCommandOf;
  /** Stops the hooks (a running shell command, the next hooks): a job's cancel. */
  signal?: AbortSignal;
  /** L5.14, CLI only: asks about each rollback whose journal entry Retake did not sign for its journal (hooks journal.ts). */
  replayUnsigned?: HookContext['replayUnsigned'];
  /** Who runs these hooks: each hook and rollback run is a line of the workspace journal, as this caller's (absent: none). */
  recordAs?: Caller;
}

/**
 * A hook context for hooks outside a capture; js hooks get a headless browser opened on first use — signed in as the
 * persona of their page (L1.6: a copy of its session, as in a run; a tab landing on its sign-in page fails the hook),
 * one browser per persona. A scenario's hooks bind their tabs as its run does (core planPersonas: the persona its
 * scenes film the page with, `none` included). `closeSessions` closes those browsers (their copies hold a persona's
 * cookies). Throws core AccessError for `allowWrites` on a read-only environment, before anything is opened.
 */
export async function createHookContext(project: LoadedProject, o: HookContextOptions): Promise<{ ctx: HookContext; access: RunAccess; closeSessions: () => Promise<void> }> {
  const env = resolveEnvironment(project, o.env);
  const { access, accessOf } = hooksAccess(project, env, o.allowWrites === true);
  const personas = resolvePersonas(project, env.name, { home: retakeHome() });
  const sessions = new Map<string, Promise<import('@retake/runner-web').BrowserSession>>();
  const command = o.loginCommand;
  const runId = o.runId ?? newRunId('hooks');
  const planned = o.scenario ? planPersonas(o.scenario, { env: env.name, envPages: env.pages, personas, hooks: true }).hookPages : undefined;
  // A read-only command (L1.7): a js hook's tab stops its writes (never mocked); its browser is guarded like a run's.
  // Any command: writes to the hosts of the project's read-only environments (production) are stopped too.
  const policy = compileWritePolicy(env, { access });
  const writes = guardsWrites(policy) ? { policy, onWrite: (w: { label: string; outcome: string }) => ctx.log('debug', `js hook tab: ${w.label} ${w.outcome}`) } : undefined;
  /**
   * The persona a js hook tab of page `key` is signed in as: the scenario's binding of that page, else the one whose
   * pages list it, else the legacy one (undefined: none).
   */
  const personaOf = (key: string): ResolvedPersona | undefined => {
    if (planned?.has(key)) {
      const name = planned.get(key);
      return name === null ? undefined : personas.find((p) => p.name === name);
    }
    return personas.find((p) => !p.legacy && p.pages.includes(key)) ?? personas.find((p) => p.legacy);
  };
  const open = async (persona: ResolvedPersona | undefined) => {
    const rw = await import('@retake/runner-web');
    const capture = project.config.capture;
    const prepared = persona
      ? await rw.prepareSessions([persona], { runId, log: (level, msg) => ctx.log(level, msg), failure: `js hooks cannot use the saved session of persona ${persona.name}:` })
      : [];
    return rw.openSession({
      policy: o.policy,
      width: capture.width,
      height: capture.height,
      scale: capture.scale,
      kit: rw.kitConfigFor(undefined),
      browser: rw.projectBrowser(project),
      log: (level, msg) => ctx.log(level, msg),
      ...(writes ? { writes: { policy: writes.policy } } : {}),
      ...(persona ? { realms: prepared.map((p) => p.realm), hookRealmOf: () => persona.name } : {}),
    });
  };
  const ctx: HookContext = {
    project,
    policy: o.policy,
    env,
    vars: { ...(project.config.vars ?? {}), ...(o.vars ?? {}) },
    runId: o.runId,
    dryRun: o.dry === true,
    saved: {},
    access,
    accessOf,
    log: o.log,
    ...(o.confirm ? { confirmDestructive: o.confirm } : {}),
    ...(o.trust ? { trust: o.trust } : {}),
    // Trust `mcp`: a scenario's vars are the agent's — a project hook rendered with them counts as the agent's too.
    ...(o.trust === 'mcp' && o.vars && Object.keys(o.vars).length ? { agentVars: Object.keys(o.vars) } : {}),
    ...(o.via ? { via: o.via } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.replayUnsigned !== undefined && o.trust !== 'mcp' ? { replayUnsigned: o.replayUnsigned } : {}),
    ...(o.recordAs ? { recordRun: hookRunRecorder(project.root, o.recordAs, { project: project.slug, run: runId }) } : {}),
    evalInPage: async (pageKey, code) => {
      const rw = await import('@retake/runner-web');
      if (!Object.keys(env.pages).length) throw new Error(`environment "${env.name}" declares no pages for the js hook to run in`);
      const persona = personaOf(pageKey ?? Object.keys(env.pages)[0]);
      let session = sessions.get(persona?.name ?? '');
      if (!session) {
        session = open(persona);
        sessions.set(persona?.name ?? '', session);
      }
      const matchers = persona ? loginMatchers(persona.loginPatterns, env.pages) : [];
      const loginLanding = (key: string, url: string): string | null =>
        persona && matchLoginUrl(url, matchers)
          ? `js hook page "${key}" (persona ${persona.name}) landed on the sign-in page (${urlOriginPath(url)}): its session expired — sign in again: ${command({ project: project.slug, env: env.name, ...(persona.legacy ? {} : { persona: persona.name }) })}`
          : null;
      // The guarded hook tab of that page (hosts outside the allow-list are blocked), reused by later js hooks.
      return rw.evalHookInPage(await session, { project, env, log: (level, msg) => ctx.log(level, msg), ...(persona ? { loginLanding } : {}), ...(writes ? { writes } : {}) }, pageKey, code);
    },
  };
  const closeSessions = async () => {
    for (const s of sessions.values()) await (await s.catch(() => null))?.close();
  };
  return { ctx, access, closeSessions };
}
