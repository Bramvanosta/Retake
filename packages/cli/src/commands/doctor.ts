import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { WORKSPACE_FILE, expandHome, listProjects, listTemplates, loadTemplate, resolveEnvironment } from '@demo-studio/core';
import type { BrowserConfig, LoadedProject, WorkspaceConfig } from '@demo-studio/core';
import type { ChromiumProbe } from '@demo-studio/runner-web';
import { EXIT, errorMessage } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { formatMs } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';

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

async function projectChecks(p: DoctorProbes, ws: WorkspaceConfig, slug: string): Promise<DoctorCheck[]> {
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
  // Browser profile(s): global auth, or one per environment.
  const { resolveAuth } = await import('@demo-studio/runner-web');
  const seen = new Set<string>();
  for (const env of envNames.length ? envNames : ['']) {
    const auth = resolveAuth(project, env);
    const label = envNames.length > 1 ? `Profile (${env})` : 'Profile';
    if (auth.profileDir && !seen.has(auth.profileDir)) {
      seen.add(auth.profileDir);
      if (!p.exists(auth.profileDir)) {
        out.push({ status: 'warn', name: label, detail: `${auth.profileDir} does not exist yet`, hint: `sign in once: studio login ${slug}${env ? ` --env ${env}` : ''}` });
      } else if (p.exists(join(auth.profileDir, 'SingletonLock'))) {
        out.push({ status: 'warn', name: label, detail: `${auth.profileDir} is in use by a browser`, hint: 'close the login window (or the other run) before capturing' });
      } else {
        out.push({ status: 'ok', name: label, detail: auth.profileDir });
      }
    }
    if (auth.storageState && !seen.has(auth.storageState)) {
      seen.add(auth.storageState);
      out.push(
        p.exists(auth.storageState)
          ? { status: 'ok', name: label.replace('Profile', 'Storage state'), detail: auth.storageState }
          : { status: 'fail', name: label.replace('Profile', 'Storage state'), detail: `${auth.storageState} not found`, hint: 'export it again, or use auth.profile + studio login' },
      );
    }
  }
  if (!seen.size) out.push({ status: 'ok', name: 'Profile', detail: 'none configured (a fresh temporary profile per run)' });

  // Hosts of every environment page: HEAD with a 5 s timeout. An unreachable default environment is a failure.
  for (const env of envNames) {
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

/** Every doctor check, in display order. */
export async function doctorChecks(probes: DoctorProbes, ws: WorkspaceConfig, opts: { project?: string } = {}): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [nodeCheck(probes)];
  out.push(await chromiumCheck(probes, ws.browser));
  out.push(await mediaTool(probes, 'ffmpeg', ws.ffmpeg));
  out.push(await mediaTool(probes, 'ffprobe', ws.ffmpeg));
  out.push(displayCheck(probes), secretsCheck(probes), notifyCheck(probes));
  out.push(...(await workspaceChecks(probes, ws)));
  if (opts.project) out.push(...(await projectChecks(probes, ws, opts.project)));
  return out;
}

export interface DoctorOptions {
  project?: string;
  json?: boolean;
}

/** `studio doctor [--project slug]`: check the machine, the workspace and optionally a project. Exit 1 on any FAIL. */
export async function doctorCommand(ui: Ui, global: GlobalOptions, opts: DoctorOptions, probes: DoctorProbes = systemProbes()): Promise<ExitCode> {
  const ws = await openWorkspace(global);
  const checks = await doctorChecks(probes, ws, { project: opts.project });
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
