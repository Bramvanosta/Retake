import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { WORKSPACE_FILE, expandHome, listProjects, listTemplates, loadTemplate, resolveEnvironment, sandboxNames, studioHome } from '@demo-studio/core';
import type { BrowserConfig, LoadedProject, WorkspaceConfig } from '@demo-studio/core';
import type { ChromiumProbe } from '@demo-studio/runner-web';
import { EXIT, errorMessage } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { formatMs } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { checkedText, loginCommandFor, projectPersonaStates, studioCommand, tildePath } from './auth.js';
import type { PersonaState } from './auth.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

/** One line of `studio doctor`. */
export interface DoctorCheck {
  status: CheckStatus;
  /** Short subject: "Node.js", "Chromium", "ffmpeg"… */
  name: string;
  detail: string;
  /** What to do about a WARN / FAIL. */
  hint?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Everything doctor reads from the machine — injected so the checks can be tested with a mocked environment. */
export interface DoctorProbes {
  platform: NodeJS.Platform;
  nodeVersion: string;
  env: Record<string, string | undefined>;
  /** Absolute path of an executable on PATH, or null. */
  which(cmd: string): string | null;
  /** Run a command; null when it cannot be started (not found). */
  exec(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult | null>;
  exists(path: string): boolean;
  chromium(browser: BrowserConfig | undefined): Promise<ChromiumProbe>;
  /** HEAD request: an HTTP status (reachable), or the network error. */
  head(url: string, timeoutMs: number): Promise<{ status?: number; error?: string; ms: number }>;
  /** A sandbox of the project, as `studio sandbox status` sees it (L1.8; no lock, nothing started). */
  sandbox?(project: LoadedProject, env: string): Promise<SandboxProbe>;
}

/** What doctor shows of a sandbox: up / partial / down, its services, its seed. */
export interface SandboxProbe {
  state: 'up' | 'partial' | 'down';
  provider: string;
  /** "fixture: not healthy (GET …: connection refused)" for each service that is not running and healthy. */
  problems: string[];
  services: number;
  seed?: string;
  /** The sandbox cannot be read (a provider this version does not run…). */
  error?: string;
}

export const MIN_NODE_MAJOR = 22;
/** Oldest ffmpeg / ffprobe the tools work with (`-fps_mode`). */
export const MIN_FFMPEG = [5, 1] as const;
export const HOST_TIMEOUT_MS = 5000;

function whichOnPath(cmd: string, env: Record<string, string | undefined>, platform: NodeJS.Platform): string | null {
  if (cmd.includes('/')) return isExecutable(cmd) ? cmd : null;
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (isExecutable(p)) return p;
    }
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Probes bound to this machine. */
export function systemProbes(): DoctorProbes {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    env: process.env,
    which: (cmd) => whichOnPath(cmd, process.env, process.platform),
    exec: (cmd, args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(null);
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
    exists: (p) => existsSync(p),
    sandbox: async (project, env) => {
      const { openSandbox } = await import('@demo-studio/sandbox');
      try {
        const st = await openSandbox(project, env).status();
        const problems = st.services
          .filter((x) => !x.orphan && (x.state !== 'running' || x.healthy === false))
          .map((x) => `${x.name}: ${x.state === 'stopped' ? 'not running' : x.state === 'starting' ? 'starting' : `not healthy (${x.health})`}`);
        return { state: st.state, provider: st.provider, problems, services: st.services.filter((x) => !x.orphan).length, ...(st.seed ? { seed: st.seed.hash } : {}) };
      } catch (e) {
        return { state: 'down', provider: project.sandboxes?.[env]?.manifest.provider ?? '?', problems: [], services: 0, error: errorMessage(e) };
      }
    },
    chromium: async (browser) => (await import('@demo-studio/runner-web')).probeChromium(browser),
    head: async (url, timeoutMs) => {
      const t0 = performance.now();
      try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        return { status: res.status, ms: Math.round(performance.now() - t0) };
      } catch (e) {
        const err = e as Error & { cause?: { code?: string; message?: string } };
        const why = err.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000} s` : (err.cause?.code ?? err.cause?.message ?? err.message);
        return { error: why, ms: Math.round(performance.now() - t0) };
      }
    },
  };
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';

/** ffmpeg / ffprobe: configured path (studio.yaml `ffmpeg`, ffprobe next to it) or PATH. */
async function mediaTool(p: DoctorProbes, name: 'ffmpeg' | 'ffprobe', configured: string | undefined): Promise<DoctorCheck> {
  const ffmpegPath = configured ? expandHome(configured) : undefined;
  const cmd = ffmpegPath ? (name === 'ffmpeg' ? ffmpegPath : join(dirname(ffmpegPath), 'ffprobe')) : name;
  const where = cmd.includes('/') ? cmd : p.which(cmd);
  const res = where ? await p.exec(where, ['-version'], 10_000) : null;
  if (!where || !res) {
    return {
      status: 'fail',
      name,
      detail: `${cmd} not found`,
      hint: `install ffmpeg (macOS: brew install ffmpeg · Debian/Ubuntu: apt install ffmpeg)${name === 'ffmpeg' ? ', or set "ffmpeg: /path/to/ffmpeg" in studio.yaml' : ''}`,
    };
  }
  if (res.code !== 0) return { status: 'fail', name, detail: `${where} -version failed: ${firstLine(res.stderr) || `exit ${res.code}`}` };
  const version = /version\s+(\S+)/.exec(res.stdout)?.[1] ?? firstLine(res.stdout);
  // `-fps_mode` (the review, the raw export) needs 5.1+; snapshot builds ("N-…", "2025-…-git") are not judged.
  const m = /^n?(\d+)\.(\d+)/.exec(version);
  if (m && (Number(m[1]) < MIN_FFMPEG[0] || (Number(m[1]) === MIN_FFMPEG[0] && Number(m[2]) < MIN_FFMPEG[1]))) {
    return {
      status: 'fail',
      name,
      detail: `${version} · ${where} (needs ${MIN_FFMPEG.join('.')}+)`,
      hint: 'upgrade ffmpeg (macOS: brew upgrade ffmpeg · Debian/Ubuntu: a release with ffmpeg 5.1 or later)',
    };
  }
  return { status: 'ok', name, detail: `${version} · ${where}` };
}

function nodeCheck(p: DoctorProbes): DoctorCheck {
  const major = Number(p.nodeVersion.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { status: 'ok', name: 'Node.js', detail: p.nodeVersion }
    : { status: 'fail', name: 'Node.js', detail: `${p.nodeVersion} (needs ${MIN_NODE_MAJOR}+)`, hint: `install Node.js ${MIN_NODE_MAJOR} or later (e.g. nvm install ${MIN_NODE_MAJOR})` };
}

async function chromiumCheck(p: DoctorProbes, browser: BrowserConfig | undefined): Promise<DoctorCheck> {
  const c = await p.chromium(browser);
  const src = c.source === 'playwright' ? 'Playwright' : c.source;
  if (!c.path || !c.exists) {
    return {
      status: 'fail',
      name: 'Chromium',
      detail: c.path ? `not found at ${c.path} (${src})` : 'no Chromium known to Playwright',
      hint: 'pnpm --filter @demo-studio/runner-web exec playwright-core install chromium — or point $DEMO_STUDIO_CHROMIUM / browser.executable at a Chromium or Chrome binary',
    };
  }
  if (!c.launched) {
    return {
      status: 'fail',
      name: 'Chromium',
      detail: `${c.path} (${src}) did not launch headless: ${c.error ?? 'no page rendered'}`,
      hint: 'reinstall it (playwright-core install chromium); on Linux install its system libraries (playwright-core install-deps chromium)',
    };
  }
  const mode = browser?.channel === 'headless-shell' ? 'headless shell' : 'new headless';
  return { status: 'ok', name: 'Chromium', detail: `${c.version ?? '?'} · ${c.path} · ${mode} launch ${formatMs(c.ms ?? 0)}` };
}

function displayCheck(p: DoctorProbes): DoctorCheck {
  if (p.platform === 'darwin') return { status: 'ok', name: 'Display', detail: 'macOS desktop (needed by --headed and studio login)' };
  const d = p.env.WAYLAND_DISPLAY ? `WAYLAND_DISPLAY=${p.env.WAYLAND_DISPLAY}` : p.env.DISPLAY ? `DISPLAY=${p.env.DISPLAY}` : null;
  if (d) return { status: 'ok', name: 'Display', detail: `${d} (needed by --headed and studio login)` };
  return {
    status: 'warn',
    name: 'Display',
    detail: 'none: DISPLAY / WAYLAND_DISPLAY are not set',
    hint: 'headless captures work; --headed and studio login need a desktop session (or xvfb-run)',
  };
}

function secretsCheck(p: DoctorProbes): DoctorCheck {
  const tool = p.platform === 'darwin' ? 'security' : p.platform === 'linux' ? 'secret-tool' : null;
  const store = p.platform === 'darwin' ? 'macOS Keychain' : 'Secret Service';
  if (tool && p.which(tool)) return { status: 'ok', name: 'Secrets', detail: `${store} via ${tool} ({{keychain:service/account}} refs)` };
  return {
    status: 'warn',
    name: 'Secrets',
    detail: tool ? `${tool} not found: {{keychain:service/account}} refs cannot be resolved` : `no keychain support on ${p.platform}`,
    hint: p.platform === 'linux' ? 'install libsecret-tools (secret-tool), or use {{env:VAR}} refs' : 'use {{env:VAR}} refs',
  };
}

function notifyCheck(p: DoctorProbes): DoctorCheck {
  const tool = p.platform === 'darwin' ? 'osascript' : p.platform === 'linux' ? 'notify-send' : null;
  if (tool && p.which(tool)) return { status: 'ok', name: 'Notifications', detail: `${tool} (notify steps)` };
  return {
    status: 'warn',
    name: 'Notifications',
    detail: tool ? `${tool} not found: notify steps are only logged` : `no desktop notifications on ${p.platform}: notify steps are only logged`,
    hint: p.platform === 'linux' ? 'install libnotify-bin (notify-send) for desktop notifications' : undefined,
  };
}

/** Oldest Compose docker-compose sandboxes run (`up --wait-timeout`). */
export const MIN_COMPOSE: readonly number[] = [2, 17, 0];

/** "5.1.2" / "v2.29.1-desktop.1" → [5, 1, 2]. */
function versionOf(text: string): number[] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** a < b, part by part. */
function older(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) < b[i];
  return false;
}

/** Who needs Docker: the docker-compose sandboxes of the --project, and whether one is its default sandbox. */
export interface DockerNeed {
  /** "the docker-compose sandbox sandbox-docker of project northfield-fixture". */
  by: string;
  /** The project's default sandbox (default_env, else the first declared) is one: a FAIL instead of a WARN. */
  required: boolean;
}

/**
 * Docker (L1.8): only docker-compose sandboxes need it. OK with the daemon's and Compose's versions and the context;
 * WARN when it is missing, too old or its daemon is down — a FAIL only when the --project's default sandbox (the one
 * `studio sandbox up` / `run --sandbox` pick without --env) is a docker-compose one.
 */
export async function dockerCheck(p: DoctorProbes, need: DockerNeed | null = null): Promise<DoctorCheck> {
  const name = 'Docker';
  const bad = (detail: string, hint: string): DoctorCheck => ({
    status: need?.required ? 'fail' : 'warn',
    name,
    detail: need ? `${detail} — needed by ${need.by}` : `${detail} — only needed by docker-compose sandboxes`,
    hint,
  });
  // The places the sandbox package looks in (PATH first, then Docker Desktop's, OrbStack's, Homebrew's…).
  const { dockerPlaces } = await import('@demo-studio/sandbox');
  const bin = p.env.DEMO_STUDIO_DOCKER ?? p.which('docker') ?? dockerPlaces(p.env.HOME ?? homedir()).find((x) => p.exists(x)) ?? null;
  if (!bin) return bad('not found', 'install Docker Desktop or OrbStack (or set DEMO_STUDIO_DOCKER to the docker binary)');
  const v = await p.exec(bin, ['compose', 'version', '--short'], 10_000);
  if (!v) return bad(`${bin} could not be run`, 'install Docker Desktop or OrbStack (or set DEMO_STUDIO_DOCKER to the docker binary)');
  if (v.code !== 0) return bad(`docker compose is not available (${firstLine(v.stderr) || `exit ${v.code}`})`, 'install the Compose v2 plugin (Docker Desktop and OrbStack include it)');
  const compose = v.stdout.trim().replace(/^v/, '');
  const cv = versionOf(compose);
  if (cv && older(cv, MIN_COMPOSE)) {
    return bad(`Compose ${compose} (needs ${MIN_COMPOSE.join('.')}+)`, 'update Docker Desktop / OrbStack');
  }
  const info = await p.exec(bin, ['info', '--format', '{{.ServerVersion}}'], 10_000);
  const server = info?.stdout.trim() ?? '';
  if (!info || info.code !== 0 || !server) {
    return bad(`Compose ${compose}, but the daemon is not running${info?.stderr ? ` (${firstLine(info.stderr)})` : ''}`, 'start Docker Desktop or OrbStack');
  }
  const ctx = await p.exec(bin, ['context', 'show'], 5000);
  const context = ctx && ctx.code === 0 ? firstLine(ctx.stdout) : '';
  return { status: 'ok', name, detail: `${server} · Compose ${compose}${context ? ` · context ${context}` : ''} · ${bin}` };
}

async function workspaceChecks(p: DoctorProbes, ws: WorkspaceConfig): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const marker = p.exists(join(ws.root, WORKSPACE_FILE)) ? WORKSPACE_FILE : `no ${WORKSPACE_FILE}`;
  const projects = await listProjects(ws.root).catch(() => []);
  const names = projects.map((x) => x.slug);
  const list = names.length ? `: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}` : '';
  out.push(
    names.length
      ? { status: 'ok', name: 'Workspace', detail: `${ws.root} (${marker}) · ${names.length} project${names.length === 1 ? '' : 's'}${list}` }
      : {
          status: 'warn',
          name: 'Workspace',
          detail: `${ws.root} (${marker}) · no projects in ${ws.projectsDir}`,
          hint: 'cd into your workspace, pass --root <dir>, set $DEMO_STUDIO_ROOT, or create a project with studio new <slug>',
        },
  );
  const templates = await listTemplates(ws.root).catch(() => []);
  if (!templates.length) {
    out.push({ status: 'warn', name: 'Templates', detail: `no templates in ${ws.templatesDir}`, hint: "copy a starter from the repository's templates/ folder" });
  }
  for (const t of templates) {
    try {
      const loaded = await loadTemplate(t.dir, ws.root);
      const fonts = [loaded.assets.display, ...loaded.assets.body];
      const from = t.source === 'starter' ? ' · starter template' : '';
      out.push({ status: 'ok', name: `Template ${t.name}`, detail: `fonts present (${fonts.length} file${fonts.length === 1 ? '' : 's'})${from}` });
    } catch (e) {
      out.push({ status: 'fail', name: `Template ${t.name}`, detail: errorMessage(e).split('\n')[0], hint: `add the missing files to ${t.dir} or fix template.yaml` });
    }
  }
  return out;
}

async function projectChecks(p: DoctorProbes, ws: WorkspaceConfig, slug: string, global: GlobalOptions): Promise<DoctorCheck[]> {
  // The commands of the hints, with `-C <root>` when the command line named the workspace root.
  const loginCommand = loginCommandFor(global);
  let project: LoadedProject;
  try {
    project = await openProject(ws, slug);
  } catch (e) {
    return [{ status: 'fail', name: `Project ${slug}`, detail: errorMessage(e).split('\n')[0], hint: 'studio list shows the projects of the workspace' }];
  }
  const out: DoctorCheck[] = [{ status: 'ok', name: `Project ${slug}`, detail: project.dir }];
  const envNames = Object.keys(project.config.environments ?? {});
  const defaultEnv = (() => {
    try {
      return resolveEnvironment(project).name;
    } catch {
      return envNames[0];
    }
  })();
  // Browser profile(s) of the single-account form (auth.profile / storage_state): global, or one per environment.
  const rw = await import('@demo-studio/runner-web');
  const seen = new Set<string>();
  for (const env of envNames.length ? envNames : ['']) {
    const auth = rw.resolveAuth(project, env);
    const label = envNames.length > 1 ? `Profile (${env})` : 'Profile';
    if (auth.profileDir && !seen.has(auth.profileDir)) {
      seen.add(auth.profileDir);
      const lock = p.exists(auth.profileDir) ? await rw.profileLock(auth.profileDir) : null;
      if (!lock) {
        out.push({ status: 'warn', name: label, detail: `${auth.profileDir} does not exist yet`, hint: `sign in once: ${loginCommand({ project: slug, env })}` });
      } else if (lock.state === 'live') {
        out.push({ status: 'warn', name: label, detail: `${auth.profileDir} is in use by a browser${lock.pid ? ` (pid ${lock.pid})` : ''}`, hint: 'close the login window (or the other run) before capturing' });
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
          : { status: 'fail', name, detail: `${auth.storageState} not found`, hint: 'export it again, or name the account in auth.personas + studio login' },
      );
    }
  }
  // Sandboxes (L1.8): one line each — their accounts sign in off camera at every take and their hosts are up only
  // while the sandbox runs, so neither gets a line of its own.
  const sandboxes = new Set(sandboxNames(project));
  // Personas (L1.6): their sessions live under the studio home, never in the project.
  const home = studioHome(p.env as NodeJS.ProcessEnv);
  const personas = (await projectPersonaStates(project, loginCommand, undefined, home)).filter((x) => !x.state.legacy && !sandboxes.has(x.state.env));
  if (personas.length) {
    const where = `${tildePath(home)}${p.env.DEMO_STUDIO_HOME ? ' (DEMO_STUDIO_HOME)' : ''}`;
    out.push((await gitPlacement(p, home, true, 'Session home', where)) ?? { status: 'ok', name: 'Session home', detail: `${where} · outside any git work tree` });
    for (const { state } of personas) out.push(await personaCheck(p, state, home, `${studioCommand(global)} auth status --project ${slug} --check`));
  } else if (!seen.size) {
    out.push({ status: 'ok', name: 'Profile', detail: 'none configured (a fresh temporary profile per run)' });
  }

  for (const env of sandboxes) out.push(await sandboxCheck(p, project, env, global));
  // Hosts of every environment page: HEAD with a 5 s timeout. An unreachable default environment is a failure.
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
          hint: /localhost|127\.0\.0\.1/.test(url) ? 'start the app first (the bundled fixture: pnpm fixture)' : 'check the URL, your VPN / network, or the environment status',
        });
      }
    }
  }
  return out;
}

/**
 * One sandbox (L1.8): up and healthy (OK), or not running / partly (WARN, with the command that starts it — `run
 * --sandbox` starts it too). Never a failure: a sandbox is started on demand.
 */
async function sandboxCheck(p: DoctorProbes, project: LoadedProject, env: string, global: GlobalOptions): Promise<DoctorCheck> {
  const name = `Sandbox ${env}`;
  const envFlag = sandboxNames(project)[0] === env ? '' : ` --env ${env}`;
  const studio = studioCommand(global);
  if (!p.sandbox) return { status: 'ok', name, detail: 'not checked' };
  const s = await p.sandbox(project, env);
  if (s.error) return { status: 'warn', name, detail: `${s.provider} · ${s.error.split('\n')[0]}` };
  const seed = s.seed ? ` · seed ${s.seed}` : '';
  if (s.state === 'up') return { status: 'ok', name, detail: `${s.provider} · up, ${s.services === 1 ? 'its service is' : `its ${s.services} services are`} healthy${seed}` };
  if (s.state === 'down') {
    return { status: 'warn', name, detail: `${s.provider} · not running`, hint: `${studio} sandbox up ${project.slug}${envFlag} (studio run … --sandbox starts it too)` };
  }
  return { status: 'warn', name, detail: `${s.provider} · partly up: ${s.problems.join('; ')}`, hint: `${studio} sandbox status ${project.slug}${envFlag}, then ${studio} sandbox up ${project.slug}${envFlag}` };
}

/** The git work tree a path sits in (walking up from it), or null. */
function gitWorkTree(p: DoctorProbes, path: string): string | null {
  for (let d = path; ; ) {
    if (p.exists(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * A session (a profile, a snapshot, the studio home) in a git work tree (R-AUTH-02): a WARN when git does not ignore
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
    hint: name === 'Session home' ? 'set DEMO_STUDIO_HOME to a folder outside any repository (or ignore it in that repository)' : 'keep sessions outside repositories: name the account in auth.personas (its session then lives in ~/.demo-studio), or ignore the path',
  };
}

/** One persona's line: its saved session (never signed in, expired, in use…), its last check, a nested work tree. */
async function personaCheck(p: DoctorProbes, s: PersonaState, home: string, recheck: string): Promise<DoctorCheck> {
  const name = `Persona ${s.env}·${s.persona}`;
  const where = s.session === 'profile' ? 'profile' : 'snapshot';
  if (s.status === 'never') return { status: 'warn', name, detail: 'never signed in', hint: `sign in once: ${s.command}` };
  if (s.in_use) {
    return { status: 'warn', name, detail: `its profile is in use by a browser${s.in_use.pid ? ` (pid ${s.in_use.pid})` : ''}`, hint: 'close the studio login window (or the other browser) before capturing' };
  }
  if (s.status === 'expired') return { status: 'warn', name, detail: `expired · ${checkedText(s)}${s.detail ? `: ${s.detail}` : ''}`, hint: `sign in again: ${s.command}` };
  if (s.status === 'error') return { status: 'warn', name, detail: `could not be checked · ${checkedText(s)}${s.detail ? `: ${s.detail}` : ''}`, hint: `is the app running? Then sign in again if needed: ${s.command}` };
  const detail = s.status === 'valid' ? `valid · ${checkedText(s)} · ${where}` : `${where} saved, not checked yet (${recheck})`;
  // A git work tree nested in the studio home (the home itself is reported once).
  const file = s.session === 'profile' ? s.profile : s.snapshot;
  if (file && gitWorkTree(p, file) !== gitWorkTree(p, home)) {
    const nested = await gitPlacement(p, file, s.session === 'profile', name, detail);
    if (nested) return nested;
  }
  return { status: 'ok', name, detail };
}

/** Every doctor check, in display order. */
export async function doctorChecks(probes: DoctorProbes, ws: WorkspaceConfig, opts: { project?: string; global?: GlobalOptions } = {}): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [nodeCheck(probes)];
  out.push(await chromiumCheck(probes, ws.browser));
  out.push(await mediaTool(probes, 'ffmpeg', ws.ffmpeg));
  out.push(await mediaTool(probes, 'ffprobe', ws.ffmpeg));
  out.push(displayCheck(probes), secretsCheck(probes), notifyCheck(probes));
  // Docker: a failure only when the --project's default sandbox is a docker-compose one.
  const need = opts.project ? await composeSandboxOf(ws, opts.project) : null;
  out.push(await dockerCheck(probes, need));
  out.push(...(await workspaceChecks(probes, ws)));
  if (opts.project) out.push(...(await projectChecks(probes, ws, opts.project, opts.global ?? {})));
  return out;
}

/**
 * The docker-compose sandboxes of a project (null: none, or the project does not load). Required when its default
 * sandbox — `default_env` when it is a sandbox, else the first declared — is one of them; another one (the fixture's
 * optional `sandbox-docker`) only makes a missing Docker a warning.
 */
async function composeSandboxOf(ws: WorkspaceConfig, slug: string): Promise<DockerNeed | null> {
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

export interface DoctorOptions {
  project?: string;
  json?: boolean;
}

/** `studio doctor [--project slug]`: check the machine, the workspace and optionally a project. Exit 1 on any FAIL. */
export async function doctorCommand(ui: Ui, global: GlobalOptions, opts: DoctorOptions, probes: DoctorProbes = systemProbes()): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const checks = await doctorChecks(probes, ws, { project: opts.project, global });
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  if (opts.json) {
    ui.result(JSON.stringify({ ok: fails === 0, failures: fails, warnings: warns, checks }, null, 2));
  } else {
    const c = ui.c;
    const tag = { ok: c.green('OK  '), warn: c.yellow('WARN'), fail: c.red('FAIL') } as const;
    const width = Math.max(...checks.map((x) => x.name.length));
    ui.line(c.bold('studio doctor'));
    for (const x of checks) {
      ui.line(`  ${tag[x.status]}  ${x.name.padEnd(width)}  ${x.detail}`);
      if (x.hint && x.status !== 'ok') ui.line(`  ${' '.repeat(4)}  ${' '.repeat(width)}  ${c.dim(`→ ${x.hint}`)}`);
    }
    const summary = `${fails} failure${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}`;
    if (fails) ui.error(summary);
    else ui.ok(summary);
  }
  return fails ? EXIT.failure : EXIT.ok;
}
