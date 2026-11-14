/**
 * The lines of a `--project` in `retake doctor`: the project, its browser, its profiles and personas' sessions (and
 * where they live: a git work tree), its sandboxes, its hosts — and the docker-compose sandboxes that make Docker
 * needed. A persona's session is read through the capture runner's sessions (its lock, its last status; no browser).
 */
import { dirname, join, relative } from 'node:path';
import { errorMessage } from '@retake/core/base';
import { resolveAuth, resolveEnvironment } from '@retake/core/environment';
import { sandboxAdvice, sandboxAdviceText, sandboxNames } from '@retake/core/sandbox';
import { retakeHome } from '@retake/core/io';
import type { LoadedProject } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import { checkedText, loginCommandAt, projectPersonaStates, tildePath } from '../auth.js';
import type { PersonaState, PersonaStateReads } from '../auth.js';
import { formatMs } from '../format.js';
import { openProject } from '../workspace.js';
import type { OpenedWorkspace } from '../workspace.js';
import { HOST_TIMEOUT_MS, agentJobsCheck } from './machine-checks.js';
import type { DockerNeed, DoctorCheck, DoctorProbes } from './types.js';

/** What the lines of a project read beside the probes: the time a last check is seen at, and the personas' sessions. */
export interface ProjectCheckPorts {
  /** Now, in epoch ms (the composition root's clock). */
  now: number;
  sessions: PersonaStateReads;
}

/** What the checks of a `--project` read: the loaded project, its environments, how its hints' commands are written. */
interface ProjectContext {
  p: DoctorProbes;
  ws: OpenedWorkspace;
  project: LoadedProject;
  slug: string;
  /** How the hints' commands start (`retake`, or `retake -C <root>` when the command line named the workspace root). */
  retake: string;
  /** The `retake login` commands of the hints. */
  loginCommand: ReturnType<typeof loginCommandAt>;
  ports: ProjectCheckPorts;
  envNames: string[];
  /** The environment a run picks without --env (else the first declared). */
  defaultEnv: string | undefined;
  /** The project's sandbox environments. */
  sandboxes: Set<string>;
}

/** The lines of a `--project`, in display order: the project, its browser, profiles, sessions, sandboxes, hosts. */
export async function projectChecks(p: DoctorProbes, ws: OpenedWorkspace, slug: string, retake: string, ports: ProjectCheckPorts): Promise<DoctorCheck[]> {
  const loginCommand = loginCommandAt(retake);
  let project: LoadedProject;
  try {
    project = await openProject(ws, slug);
  } catch (e) {
    return [{ status: 'fail', name: `Project ${slug}`, detail: errorMessage(e).split('\n')[0], hint: 'retake list shows the projects of the workspace' }];
  }
  const envNames = Object.keys(project.config.environments ?? {});
  // Sandboxes: one line each — their accounts sign in off camera at every take and their hosts are up only
  // while the sandbox runs, so neither gets a line of its own.
  const x: ProjectContext = { p, ws, project, slug, retake, loginCommand, ports, envNames, defaultEnv: defaultEnvOf(project, envNames), sandboxes: new Set(sandboxNames(project)) };
  const out: DoctorCheck[] = [{ status: 'ok', name: `Project ${slug}`, detail: project.dir }];
  const browser = projectBrowserCheck(x);
  if (browser) out.push(browser);
  const profiles = await profileChecks(x);
  out.push(...profiles);
  out.push(...(await sessionChecks(x, profiles.length > 0)));
  for (const env of x.sandboxes) out.push(await sandboxCheck(p, project, env, retake, ws.policy));
  const advice = sandboxAdviceCheck(x);
  if (advice) out.push(advice);
  out.push(...(await hostChecks(x)));
  return out;
}

/** The environment a run picks without --env; the first declared when that cannot be told. */
function defaultEnvOf(project: LoadedProject, envNames: string[]): string | undefined {
  try {
    return resolveEnvironment(project).name;
  } catch {
    return envNames[0];
  }
}

/** The project's browser (retake.yaml's merged in): only what the workspace line does not say already. */
function projectBrowserCheck({ ws, project, slug }: ProjectContext): DoctorCheck | null {
  const own = project.config.browser;
  if (!own || (own.executable === ws.browser?.executable && (own.args?.length ?? 0) === (ws.browser?.args?.length ?? 0))) return null;
  return agentJobsCheck(
    {},
    ws,
    { ...(own.executable !== ws.browser?.executable ? { executable: own.executable } : {}), args: own.args?.slice(ws.browser?.args?.length ?? 0) ?? [] },
    `Project ${slug}: Studio and MCP jobs`,
  );
}

/** Browser profile(s) of the single-account form (auth.profile / storage_state): global, or one per environment; one line each. */
async function profileChecks({ p, project, slug, loginCommand, envNames, ports }: ProjectContext): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const seen = new Set<string>();
  for (const env of envNames.length ? envNames : ['']) {
    const auth = resolveAuth(project, env);
    const label = envNames.length > 1 ? `Profile (${env})` : 'Profile';
    if (auth.profileDir && !seen.has(auth.profileDir)) {
      seen.add(auth.profileDir);
      const lock = p.exists(auth.profileDir) ? await ports.sessions.lock(auth.profileDir) : null;
      if (!lock) {
        out.push({ status: 'warn', name: label, detail: `${auth.profileDir} does not exist yet`, hint: `sign in once: ${loginCommand({ project: slug, env })}` });
      } else if (lock.state === 'live') {
        out.push({
          status: 'warn',
          name: label,
          detail: `${auth.profileDir} is in use by a browser${lock.pid ? ` (pid ${lock.pid})` : ''}`,
          hint: 'close the login window (or the other run) before capturing',
        });
      } else {
        out.push((await gitPlacement(p, auth.profileDir, true, label, auth.profileDir)) ?? { status: 'ok', name: label, detail: auth.profileDir });
      }
    }
    if (auth.storageState && !seen.has(auth.storageState)) {
      seen.add(auth.storageState);
      const name = label.replace('Profile', 'Storage state');
      out.push(
        p.exists(auth.storageState)
          ? ((await gitPlacement(p, auth.storageState, false, name, auth.storageState)) ?? { status: 'ok', name, detail: auth.storageState })
          : { status: 'fail', name, detail: `${auth.storageState} not found`, hint: 'export it again, or name the account in auth.personas + retake login' },
      );
    }
  }
  return out;
}

/**
 * Personas: their sessions live under the Retake home, never in the project — the home's line, then one per
 * persona (not a sandbox's). Without any, and without a profile line (`profiles`), the one "none configured" line.
 */
async function sessionChecks({ p, project, slug, retake, loginCommand, sandboxes, ports }: ProjectContext, profiles: boolean): Promise<DoctorCheck[]> {
  const home = retakeHome(p.env as NodeJS.ProcessEnv);
  const personas = (await projectPersonaStates(project, loginCommand, ports.sessions, undefined, home)).filter((x) => !x.state.legacy && !sandboxes.has(x.state.env));
  if (!personas.length) return profiles ? [] : [{ status: 'ok', name: 'Profile', detail: 'none configured (a fresh temporary profile per run)' }];
  const where = `${tildePath(home)}${p.env.RETAKE_HOME ? ' (RETAKE_HOME)' : ''}`;
  const out: DoctorCheck[] = [(await gitPlacement(p, home, true, 'Session home', where)) ?? { status: 'ok', name: 'Session home', detail: `${where} · outside any git work tree` }];
  for (const { state } of personas) out.push(await personaCheck(p, state, home, `${retake} auth status --project ${slug} --check`, ports.now));
  return out;
}

/** A local environment with a database, a mailbox or reset hooks and no sandbox: point to one. */
function sandboxAdviceCheck({ project, slug, retake }: ProjectContext): DoctorCheck | null {
  const advice = sandboxAdvice(project);
  return advice ? { status: 'warn', name: 'Sandbox', ...sandboxAdviceText(advice, slug, retake) } : null;
}

/** Hosts of every environment page but a sandbox's: HEAD with a 5 s timeout. An unreachable default environment is a failure. */
async function hostChecks({ p, project, envNames, defaultEnv, sandboxes }: ProjectContext): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const env of envNames) {
    if (sandboxes.has(env)) continue;
    for (const [key, url] of Object.entries(project.config.environments[env] ?? {})) {
      const r = await p.head(url, HOST_TIMEOUT_MS);
      const name = `Host ${env}·${key}`;
      if (r.status !== undefined) {
        out.push({ status: 'ok', name, detail: `${url} → HTTP ${r.status} (${formatMs(r.ms)})` });
      } else {
        out.push({
          status: env === defaultEnv ? 'fail' : 'warn',
          name,
          detail: `${url} unreachable: ${r.error ?? 'no answer'}`,
          hint: /localhost|127\.0\.0\.1/.test(url)
            ? p.bundle
              ? 'start the app first'
              : 'start the app first (the bundled fixture: pnpm fixture)'
            : 'check the URL, your VPN / network, or the environment status',
        });
      }
    }
  }
  return out;
}

/**
 * One sandbox: up and healthy (OK), or not running / partly (WARN, with the command that starts it — `run
 * --sandbox` starts it too). Never a failure: a sandbox is started on demand.
 */
async function sandboxCheck(p: DoctorProbes, project: LoadedProject, env: string, retake: string, policy: WorkPolicy): Promise<DoctorCheck> {
  const name = `Sandbox ${env}`;
  const envFlag = sandboxNames(project)[0] === env ? '' : ` --env ${env}`;
  const studio = retake;
  if (!p.sandbox) return { status: 'ok', name, detail: 'not checked' };
  const s = await p.sandbox(project, env, policy);
  if (s.error) return { status: 'warn', name, detail: `${s.provider} · ${s.error.split('\n')[0]}` };
  const seed = s.seed ? ` · seed ${s.seed}` : '';
  if (s.state === 'up') return { status: 'ok', name, detail: `${s.provider} · up, ${s.services === 1 ? 'its service is' : `its ${s.services} services are`} healthy${seed}` };
  if (s.state === 'down') {
    return { status: 'warn', name, detail: `${s.provider} · not running`, hint: `${studio} sandbox up ${project.slug}${envFlag} (retake run … --sandbox starts it too)` };
  }
  return {
    status: 'warn',
    name,
    detail: `${s.provider} · partly up: ${s.problems.join('; ')}`,
    hint: `${studio} sandbox status ${project.slug}${envFlag}, then ${studio} sandbox up ${project.slug}${envFlag}`,
  };
}

/** The git work tree a path sits in (walking up from it), or null. */
export function gitWorkTree(p: DoctorProbes, path: string): string | null {
  for (let d = path; ; ) {
    if (p.exists(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * A session (a profile, a snapshot, the Retake home) in a git work tree: a WARN when git does not ignore
 * it — a commit could publish a signed-in session —, an OK naming the work tree when it is ignored; null when it is
 * outside any work tree. `detail` is the line's detail otherwise.
 */
async function gitPlacement(p: DoctorProbes, path: string, dir: boolean, name: string, detail: string): Promise<DoctorCheck | null> {
  const root = gitWorkTree(p, path);
  if (!root) return null;
  const rel = relative(root, path) || '.';
  const res = await p.exec('git', ['-C', root, 'check-ignore', '-q', dir && rel !== '.' ? `${rel}/` : rel], 5000);
  if (res && res.code === 0) return { status: 'ok', name, detail: `${detail} · in the git work tree ${tildePath(root)}, ignored by git` };
  return {
    status: 'warn',
    name,
    detail: `${tildePath(path)} is inside the git work tree ${tildePath(root)}${res ? ', not ignored' : ' (git not found: cannot tell whether it is ignored)'}: a commit could publish a signed-in session`,
    hint:
      name === 'Session home'
        ? 'set RETAKE_HOME to a folder outside any repository (or ignore it in that repository)'
        : 'keep sessions outside repositories: name the account in auth.personas (its session then lives in ~/.retake), or ignore the path',
  };
}

/** One persona's line: its saved session (never signed in, expired, in use…), its last check, a nested work tree. */
async function personaCheck(p: DoctorProbes, s: PersonaState, home: string, recheck: string, now: number): Promise<DoctorCheck> {
  const name = `Persona ${s.env}·${s.persona}`;
  const where = s.session === 'profile' ? 'profile' : 'snapshot';
  if (s.status === 'never') return { status: 'warn', name, detail: 'never signed in', hint: `sign in once: ${s.command}` };
  if (s.in_use) {
    return {
      status: 'warn',
      name,
      detail: `its profile is in use by a browser${s.in_use.pid ? ` (pid ${s.in_use.pid})` : ''}`,
      hint: 'close the retake login window (or the other browser) before capturing',
    };
  }
  if (s.status === 'expired') return { status: 'warn', name, detail: `expired · ${checkedText(s, now)}${s.detail ? `: ${s.detail}` : ''}`, hint: `sign in again: ${s.command}` };
  if (s.status === 'error')
    return { status: 'warn', name, detail: `could not be checked · ${checkedText(s, now)}${s.detail ? `: ${s.detail}` : ''}`, hint: `is the app running? Then sign in again if needed: ${s.command}` };
  const detail = s.status === 'valid' ? `valid · ${checkedText(s, now)} · ${where}` : `${where} saved, not checked yet (${recheck})`;
  // A git work tree nested in the Retake home (the home itself is reported once).
  const file = s.session === 'profile' ? s.profile : s.snapshot;
  if (file && gitWorkTree(p, file) !== gitWorkTree(p, home)) {
    const nested = await gitPlacement(p, file, s.session === 'profile', name, detail);
    if (nested) return nested;
  }
  return { status: 'ok', name, detail };
}

/**
 * The docker-compose sandboxes of a project (null: none, or the project does not load). Required when its default
 * sandbox — `default_env` when it is a sandbox, else the first declared — is one of them; another one (the fixture's
 * optional `sandbox-docker`) only makes a missing Docker a warning.
 */
export async function composeSandboxOf(ws: OpenedWorkspace, slug: string): Promise<DockerNeed | null> {
  try {
    const project = await openProject(ws, slug);
    const names = sandboxNames(project);
    const compose = names.filter((e) => project.sandboxes?.[e]?.manifest.provider === 'docker-compose');
    if (!compose.length) return null;
    const def = project.config.default_env;
    const defaults = new Set([names[0], ...(def !== undefined && names.includes(def) ? [def] : [])]);
    const required = compose.filter((e) => defaults.has(e));
    const shown = required.length ? required : compose;
    return { by: `the docker-compose sandbox${shown.length === 1 ? '' : 's'} ${shown.join(', ')} of project ${project.slug}`, required: required.length > 0 };
  } catch {
    return null;
  }
}
