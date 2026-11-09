import { execFile } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { ConfigError, agentArgsProblems, agentProgramProblem, workspaceFolders, OLD_DIR, OLD_ENV_PREFIX, OLD_WORKSPACE_FILE, RECREATED_HOME_FILES, UNSAFE_TEST_RESOLVE_ENV, WORKSPACE_FILE, gitignoreFix, gitignoreNamesOldDirOnly, oldDirMove, oldEnvNames, oldHomeDir, oldWorkspaceFileAt, oldWorkspaceFileMessage, WORKSPACE_GITIGNORE, expandHome, resolveEnvironment, sandboxAdvice, sandboxAdviceText, sandboxNames, unsafeTestResolve, RETAKE_VERSION, defaultRetakeHome, statePath, PERSON_POLICY } from '@retake/core';
import { findWorkspaceRoot, listProjects, listTemplates, loadTemplate, retakeHome, bundleInfoOrNull, bundleProblems, resolveMediaTools, clientPath, engineLocation, nodeFileFacts, fileFacts } from '@retake/core/io';
import { CLI_NAME, LAUNCHER_REL, MOVE_TO_APPLICATIONS, cliLinkState, cliOnPath, defaultCliDir, installLocation, installLocationWords, onReadOnlyVolume, readAppSettings, readUpdateChecks, stableNodePath, updateChecksOff, UPDATE_DISABLE_ENV, zshQuote } from '@retake/engine/integrations';
import type { BrowserConfig, LoadedProject, WorkspaceConfig, WorkPolicy } from '@retake/core';
import type { BundleInfo, MediaToolSource, MediaTools } from '@retake/core/io';
import type { ChromiumProbe } from '@retake/runner-web';
import type { OpenedWorkspace } from '@retake/engine';
import { EXIT, errorMessage } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';
import { formatMs } from '../ui.js';
import { openProject, openWorkspace } from '../workspace.js';
import type { GlobalOptions } from '../workspace.js';
import { checkedText, loginCommandFor, projectPersonaStates, retakeCommand, tildePath } from './auth.js';
import type { PersonaState } from './auth.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

/** One line of `retake doctor`. */
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
  chromium(browser: BrowserConfig | undefined, policy: WorkPolicy): Promise<ChromiumProbe>;
  /** HEAD request: an HTTP status (reachable), or the network error. */
  head(url: string, timeoutMs: number): Promise<{ status?: number; error?: string; ms: number }>;
  /** A sandbox of the project, as `retake sandbox status` sees it (L1.8; no lock, nothing started). */
  sandbox?(project: LoadedProject, env: string, policy: WorkPolicy): Promise<SandboxProbe>;
  /** The Node.js running this command (default process.execPath): what `retake mcp --print-config` registers. */
  execPath?: string;
  /**
   * The jobs worker serving a workspace (L3.1), or null. L5.16c: its version and the copy of Retake it runs (`engine`:
   * the worker lock's), to say when it is another copy than this one.
   */
  worker?(root: string): Promise<{ pid: number; since: string; started_by?: string; version?: string; engine?: string } | null>;
  /** L5.16c: this copy of Retake (core engineLocation; default: computed). */
  engine?: string;
  /** L5.16c: is this folder on a read-only volume (the app's location; default core onReadOnlyVolume)? */
  readOnly?(p: string): boolean;
  /** The names in a real folder (not a link), or null: what "Before Retake" counts (pending journals). */
  list?(dir: string): string[] | null;
  /** The text of a small regular file (not a link; ≤ 64 KB), or null: the `.gitignore` files "Before Retake" reads. */
  read?(file: string): string | null;
  /** The app bundle this engine runs from (L5.16, core bundleInfo), or null / absent: a repository checkout. */
  bundle?: BundleInfo | null;
  /** What is wrong with the app bundle (core bundleProblems: a damaged manifest, playwright-core not loading). */
  bundleProblems?(): string[];
  /** The browser renders use (editor renderBrowser): the "Render browser" line; absent, no line. */
  renderBrowser?(): { path: string | null; source: string; note?: string };
  /** L5.14, the "Captures first" line: this user's filming markers on this Mac (nothing made, nothing named); absent, no line. */
  captures?(root: string): Promise<CapturesProbe>;
  /** L5.15, the "Renders" line: the render path a 1080p render takes here (editor probeRenderPath); absent, no line. */
  renders?(policy: WorkPolicy): Promise<RendersProbe>;
}

/** What the "Renders" line reads (editor RenderPathProbe, structurally). */
export interface RendersProbe {
  policy?: {
    gl: { asked: string; resolved: 'angle' | 'software'; source: string };
    encoder: { asked: string; source: string };
    concurrency: number;
    concurrencySource: string;
    platform: string;
  };
  error?: string;
  gpu?: { accelerated: boolean; renderer?: string };
  browserError?: string;
  gl?: 'angle' | 'software';
  videotoolbox?: { ok: boolean; error?: string };
  encoder?: 'h264_videotoolbox' | 'libx264';
  concurrency?: number;
}

/** What doctor shows of captures first (L5.14). */
export interface CapturesProbe {
  /** The markers' folder: per user on this Mac (or RETAKE_CAPTURES_DIR: `override`). */
  dir: string;
  override: boolean;
  /** The folder exists (the first take makes it). */
  exists: boolean;
  /** Why it is not used (captures first is then off). */
  problem?: string;
  /** The takes filming now: in this workspace or elsewhere, paused, past the cap, and whether a Retake process owns each. */
  takes: Array<{ here: boolean; paused: boolean; capped: boolean; retake: boolean }>;
  /** Background priority (taskpolicy) is available: a running heavy job is slowed during a take, not only made to wait. */
  qos: boolean;
  capMin: number;
}

/** The largest file the `read` probe reads (a `.gitignore`). */
const READ_MAX_BYTES = 64 * 1024;

function readSmallFile(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > READ_MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
    list: (dir) => {
      try {
        return lstatSync(dir).isDirectory() ? readdirSync(dir) : null;
      } catch {
        return null;
      }
    },
    read: readSmallFile,
    sandbox: async (project, env, policy) => {
      const { openSandbox } = await import('@retake/sandbox');
      try {
        const st = await openSandbox(project, env, policy).status();
        const problems = st.services
          .filter((x) => !x.orphan && (x.state !== 'running' || x.healthy === false))
          .map((x) => `${x.name}: ${x.state === 'stopped' ? 'not running' : x.state === 'starting' ? 'starting' : `not healthy (${x.health})`}`);
        return { state: st.state, provider: st.provider, problems, services: st.services.filter((x) => !x.orphan).length, ...(st.seed ? { seed: st.seed.hash } : {}) };
      } catch (e) {
        return { state: 'down', provider: project.sandboxes?.[env]?.manifest.provider ?? '?', problems: [], services: 0, error: errorMessage(e) };
      }
    },
    chromium: async (browser, policy) => (await import('@retake/runner-web')).probeChromium(browser, { policy }),
    execPath: process.execPath,
    bundle: bundleInfoOrNull(),
    bundleProblems,
    renderBrowser: systemRenderBrowser,
    renders: async (policy) => (await import('@retake/editor')).probeRenderPath({ workPolicy: policy }),
    captures: async (root) => {
      const e = await import('@retake/engine');
      const loc = e.capturesLocation(process.env);
      const exists = existsSync(loc.dir);
      // Nothing is made: an absent folder is read as "no take yet" (capturesDir would make it).
      const usable = exists ? e.capturesDir(process.env) : { dir: null, ...(loc.problem ? { problem: loc.problem } : {}) };
      const st = usable.dir ? await new e.FilmingWatch({ root }).scan() : { takes: [] };
      const takes = [];
      for (const t of st.takes) {
        const cmd = await new Promise<string>((r) => execFile('ps', ['-ww', '-o', 'command=', '-p', String(t.pid)], { timeout: 5000, encoding: 'utf8' }, (err, out) => r(err ? '' : String(out))));
        // Review A L3: a Retake worker or `retake run` only (any other node process is not one).
        takes.push({ here: t.here, paused: t.paused, capped: t.capped, retake: e.isTakeOwnerCommand(cmd.trim()) });
      }
      return { dir: loc.dir, override: loc.override, exists, ...(usable.problem ? { problem: usable.problem } : {}), takes, qos: process.platform === 'darwin' && existsSync('/usr/sbin/taskpolicy'), capMin: e.capMinutes(process.env) };
    },
    worker: async (root) => {
      const w = await (await import('@retake/engine')).liveWorker(root);
      return w ? { pid: w.pid, since: w.since, ...(w.started_by ? { started_by: w.started_by } : {}), version: w.version, ...(w.engine ? { engine: w.engine } : {}) } : null;
    },
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

/** How a doctor line names where a tool comes from (L5.16: every tool line says it). */
const SOURCE_WORDS: Record<MediaToolSource, string> = { 'retake.yaml': 'retake.yaml', RETAKE_FFMPEG: '$RETAKE_FFMPEG', RETAKE_FFPROBE: '$RETAKE_FFPROBE', bundled: 'bundled', PATH: 'PATH' };

/**
 * The ffmpeg / ffprobe doctor checks: core resolveMediaTools with the probes' environment (or `env`: what another
 * process gets) and bundle; a refused setting (a relative $RETAKE_FFMPEG) as its message.
 */
function doctorMediaTools(p: DoctorProbes, configured: string | undefined, env: NodeJS.ProcessEnv = p.env): MediaTools | { error: string } {
  try {
    return resolveMediaTools({ configured: configured ? expandHome(configured) : undefined, env, bundle: p.bundle ?? null, exists: p.exists });
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

/** Where to get an ffmpeg, said the way this install can act on it (an app never sends the person to Homebrew). */
function ffmpegHint(p: DoctorProbes): string {
  return p.bundle
    ? 'this app carries no ffmpeg of its own: set "ffmpeg: /path/to/ffmpeg" in retake.yaml, or $RETAKE_FFMPEG (an ffmpeg 5.1+ with libx264 or VideoToolbox)'
    : 'install ffmpeg (macOS: brew install ffmpeg · Debian/Ubuntu: apt install ffmpeg), or set "ffmpeg: /path/to/ffmpeg" in retake.yaml';
}

/**
 * ffmpeg / ffprobe, in the resolver's order (core bundle.ts): retake.yaml `ffmpeg` (ffprobe next to it) →
 * $RETAKE_FFMPEG / $RETAKE_FFPROBE → the app's own → PATH; the line names the source.
 */
async function mediaTool(p: DoctorProbes, name: 'ffmpeg' | 'ffprobe', configured: string | undefined): Promise<DoctorCheck> {
  const tools = doctorMediaTools(p, configured);
  if ('error' in tools) return { status: 'fail', name, detail: tools.error, hint: 'make it an absolute path (or unset it)' };
  const cmd = name === 'ffmpeg' ? tools.ffmpeg : tools.ffprobe;
  const source = SOURCE_WORDS[name === 'ffmpeg' ? tools.ffmpegSource : tools.ffprobeSource];
  const where = cmd.includes('/') ? cmd : p.which(cmd);
  const res = where ? await p.exec(where, ['-version'], 10_000) : null;
  if (!where || !res) {
    return {
      status: 'fail',
      name,
      detail: `${cmd} not found (${source})`,
      hint: p.bundle && source === 'bundled' ? `the app's ${name} is missing: reinstall Retake, or set "ffmpeg: /path/to/ffmpeg" in retake.yaml` : ffmpegHint(p),
    };
  }
  if (res.code !== 0) return { status: 'fail', name, detail: `${where} -version failed (${source}): ${firstLine(res.stderr) || `exit ${res.code}`}` };
  const version = /version\s+(\S+)/.exec(res.stdout)?.[1] ?? firstLine(res.stdout);
  // `-fps_mode` (the review, the raw export) needs 5.1+; snapshot builds ("N-…", "2025-…-git") are not judged.
  const m = /^n?(\d+)\.(\d+)/.exec(version);
  if (m && (Number(m[1]) < MIN_FFMPEG[0] || (Number(m[1]) === MIN_FFMPEG[0] && Number(m[2]) < MIN_FFMPEG[1]))) {
    return {
      status: 'fail',
      name,
      detail: `${version} · ${where} · ${source} (needs ${MIN_FFMPEG.join('.')}+)`,
      hint: p.bundle
        ? `point retake.yaml "ffmpeg:" / $RETAKE_FFMPEG at an ffmpeg ${MIN_FFMPEG.join('.')}+, or remove it to use the app's own`
        : 'upgrade ffmpeg (macOS: brew upgrade ffmpeg · Debian/Ubuntu: a release with ffmpeg 5.1 or later)',
    };
  }
  return { status: 'ok', name, detail: `${version} · ${where} · ${source}` };
}

function nodeCheck(p: DoctorProbes): DoctorCheck {
  const major = Number(p.nodeVersion.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { status: 'ok', name: 'Node.js', detail: p.nodeVersion }
    : { status: 'fail', name: 'Node.js', detail: `${p.nodeVersion} (needs ${MIN_NODE_MAJOR}+)`, hint: `install Node.js ${MIN_NODE_MAJOR} or later (e.g. nvm install ${MIN_NODE_MAJOR})` };
}

/** How a doctor line names a browser's source. */
function browserSource(source: string): string {
  return source === 'playwright' ? 'Playwright cache' : source === 'env' ? 'RETAKE_CHROMIUM_HEADLESS_SHELL' : source;
}

function chromiumCheck(c: ChromiumProbe, browser: BrowserConfig | undefined, bundle?: BundleInfo | null): DoctorCheck {
  const src = browserSource(c.source);
  const fromApp = !!bundle && c.source === 'bundled';
  if (!c.path || !c.exists) {
    return {
      status: 'fail',
      name: 'Chromium',
      detail: c.path ? `not found at ${c.path} (${src})` : 'no Chromium known to Playwright',
      hint: fromApp
        ? "the app's Chromium is missing: reinstall Retake — or point $RETAKE_CHROMIUM / browser.executable at a Chromium or Chrome binary"
        : bundle
          ? "point $RETAKE_CHROMIUM / browser.executable at a Chromium or Chrome binary that exists, or remove it to use the app's own"
          : 'pnpm --filter @retake/runner-web exec playwright-core install chromium — or point $RETAKE_CHROMIUM / browser.executable at a Chromium or Chrome binary',
    };
  }
  if (!c.launched) {
    return {
      status: 'fail',
      name: 'Chromium',
      detail: `${c.path} (${src}) did not launch headless: ${c.error ?? 'no page rendered'}`,
      hint: /as root|crbug\.com\/638180/i.test(c.error ?? '')
        ? 'Chromium does not run sandboxed as root, and Retake never turns its sandbox off: run Retake as a regular user (in a container, a USER that is not root)'
        : /sandbox/i.test(c.error ?? '')
        ? "Chromium's sandbox could not start (Retake always runs it sandboxed): on Linux it needs unprivileged user namespaces (kernel.unprivileged_userns_clone=1, or AppArmor's restriction lifted for that binary)"
        : fromApp
          ? 'reinstall Retake (its Chromium did not start)'
          : bundle
            ? "check that binary, or remove $RETAKE_CHROMIUM / browser.executable to use the app's own"
            : 'reinstall it (playwright-core install chromium); on Linux install its system libraries (playwright-core install-deps chromium)',
    };
  }
  const mode = browser?.channel === 'headless-shell' ? 'headless shell' : 'new headless';
  return { status: 'ok', name: 'Chromium', detail: `${c.version ?? '?'} · ${c.path} · ${src} · ${mode} launch ${formatMs(c.ms ?? 0)}` };
}

/**
 * Does the capture browser run sandboxed? Read from the command line of the browser `retake doctor` just launched, as
 * captures launch it (Chromium's own report: the switches a wrapper executable adds included).
 */
export function chromiumSandboxCheck(c: ChromiumProbe): DoctorCheck | null {
  if (!c.launched) return null;
  const name = 'Chromium sandbox';
  if (!c.sandbox) return { status: 'warn', name, detail: 'the capture browser did not report its command line', hint: 'open chrome://version in that Chromium: its command line must not hold --no-sandbox' };
  if (c.sandbox.on) return { status: 'ok', name, detail: "on · read from the capture browser's command line" };
  const own = c.source === 'browser.executable' || c.source === 'RETAKE_CHROMIUM';
  return {
    status: 'fail',
    name,
    detail: `off: the capture browser runs with ${c.sandbox.off.join(' ')}`,
    hint: own
      ? `the executable of ${c.source === 'RETAKE_CHROMIUM' ? '$RETAKE_CHROMIUM' : 'browser.executable'} adds them itself: point it at a Chromium or Chrome binary (not a wrapper that adds switches), or remove it`
      : 'reinstall Retake (its Chromium starts without its sandbox)',
  };
}

/** The browser renders use (L5.16): its source; an app without its headless shell is broken (FAIL). */
function renderBrowserCheck(p: DoctorProbes): DoctorCheck | null {
  const b = p.renderBrowser?.();
  if (!b) return null;
  const name = 'Render browser';
  if (b.path) return { status: b.note ? 'warn' : 'ok', name, detail: `${b.path} · ${browserSource(b.source)}`, ...(b.note ? { hint: b.note } : {}) };
  if (p.bundle) return { status: 'fail', name, detail: "the app's headless shell is missing", hint: 'reinstall Retake' };
  // Remotion never downloads a browser of its own: no render starts without one.
  return { status: 'fail', name, detail: 'no headless shell: renders do not start', hint: 'pnpm --filter @retake/runner-web exec playwright-core install chromium-headless-shell — or point $RETAKE_CHROMIUM_HEADLESS_SHELL at one' };
}

/**
 * What jobs of the Studio, the desktop app or an MCP client would refuse (core agent-policy.ts, whose rules a command
 * typed in a terminal does not follow): a program named inside the workspace or by a relative path (`browser`'s
 * executable, retake.yaml's ffmpeg, the tool variables — PLAYWRIGHT_BROWSERS_PATH's browser folder included), a
 * `browser.args` entry that is not a switch or not one of the switches such jobs may pass. A WARN line naming each, or
 * none. Bare command names are not looked up (the worker's PATH holds no folder of
 * the workspace).
 */
export function agentJobsCheck(env: NodeJS.ProcessEnv, ws: WorkspaceConfig, browser: BrowserConfig | undefined, name = 'Studio and MCP jobs'): DoctorCheck | null {
  const folders = workspaceFolders(ws);
  const noLookup = { path: '', exists: () => false, files: nodeFileFacts };
  const programs: Array<[string | undefined, string]> = [
    [browser?.executable, 'browser.executable'],
    [env.RETAKE_CHROMIUM, '$RETAKE_CHROMIUM'],
    [env.RETAKE_CHROMIUM_HEADLESS_SHELL, '$RETAKE_CHROMIUM_HEADLESS_SHELL'],
    [ws.ffmpeg, '`ffmpeg:` of retake.yaml'],
    [env.RETAKE_FFMPEG, '$RETAKE_FFMPEG'],
    [env.RETAKE_FFPROBE, '$RETAKE_FFPROBE'],
    [env.RETAKE_DOCKER, '$RETAKE_DOCKER'],
    [env.PLAYWRIGHT_BROWSERS_PATH, '$PLAYWRIGHT_BROWSERS_PATH'],
  ];
  const problems = [
    ...programs.flatMap(([p, what]) => (p?.trim() ? [agentProgramProblem(p, what, folders, noLookup)] : [])).filter((m): m is string => m !== null),
    ...agentArgsProblems(browser?.args ?? []).map((a) => `browser.args[${a.index}]: ${a.message}`),
  ];
  if (!problems.length) return null;
  return { status: 'warn', name, detail: `would refuse: ${problems.join(' · ')}`, hint: 'change what each says; a run typed in a terminal (retake run, retake render) is not affected' };
}

/** editor's renderBrowser, loaded when doctor runs (the editor is not loaded for every command). */
let renderBrowserFn: (() => { path: string | null; source: string; note?: string }) | undefined;
function systemRenderBrowser(): { path: string | null; source: string; note?: string } {
  return renderBrowserFn ? renderBrowserFn() : { path: null, source: 'none' };
}

/**
 * Is the capture browser GPU-accelerated (L5.7, R-FLD-24)? Chromium's own report of the browser `retake doctor` just
 * launched, as captures launch it: without the GPU, motion is filmed choppy and Chromium's CPU climbs.
 */
export function gpuCheck(c: ChromiumProbe, browser: BrowserConfig | undefined): DoctorCheck | null {
  if (!c.launched) return null;
  if (!c.gpu) return { status: 'warn', name: 'GPU', detail: 'the capture browser did not report its GPU status', hint: 'open chrome://gpu in that Chromium to see it' };
  if (c.gpu.accelerated) return { status: 'ok', name: 'GPU', detail: `hardware accelerated · ${c.gpu.renderer ?? 'GPU'}` };
  return {
    status: 'warn',
    name: 'GPU',
    detail: `the capture browser renders in software · ${c.gpu.renderer ?? '?'}${c.gpu.software?.length ? ` · in software: ${c.gpu.software.join(', ')}` : ''}`,
    hint:
      browser?.channel === 'headless-shell'
        ? 'browser.channel: headless-shell has no GPU — remove it (new headless uses the GPU)'
        : 'captures will look choppy and cost more CPU: check the machine has a GPU Chromium can use (a VM or a remote session often has none)',
  };
}

const RENDER_VARS: Record<string, string> = { gl: 'RETAKE_RENDER_GL', encoder: 'RETAKE_RENDER_ENCODER', concurrency: 'RETAKE_RENDER_CONCURRENCY' };
function settingWhere(source: string, key: string): string {
  return source === 'retake.yaml' ? `retake.yaml render.${key}` : source === 'env' ? `$${RENDER_VARS[key]}` : source;
}

/**
 * How renders run here (L5.15, R-RND-13): the GPU path (ANGLE, the render browser's GPU, VideoToolbox) or the software
 * one, the encoder and the frames at a time a 1080p render gets — from the checks a render makes. WARN when `auto`
 * found no GPU or VideoToolbox does not work (renders in software cost ≈ 2.5× the CPU); FAIL when every render would
 * fail (a setting that cannot work here).
 */
export function rendersCheck(r: RendersProbe): DoctorCheck {
  const name = 'Renders';
  const p = r.policy;
  if (!p) return { status: 'fail', name, detail: r.error ?? 'the render settings cannot be read', hint: 'fix retake.yaml render: or the RETAKE_RENDER_* variables' };
  const set = (['gl', 'encoder', 'concurrency'] as const)
    .map((k) => {
      const source = k === 'concurrency' ? p.concurrencySource : p[k].source;
      if (source === 'default' || source === 'option') return null;
      const value = k === 'concurrency' ? p.concurrency : p[k].asked;
      return `${k} ${value} (${settingWhere(source, k)})`;
    })
    .filter((x): x is string => !!x);
  const frames = `${r.concurrency ?? p.concurrency} frames at a time`;
  const encoder = r.encoder === 'h264_videotoolbox' ? 'VideoToolbox H.264' : 'libx264 CRF 16';
  const tail = set.length ? ` · set: ${set.join(', ')}` : '';
  if (r.error) return { status: 'fail', name, detail: `${r.error}${tail}`, hint: 'every render would fail: change retake.yaml render: or the RETAKE_RENDER_* variables' };
  if (r.gl === 'angle') {
    const gpu = r.gpu?.accelerated ? `GPU (${r.gpu.renderer ?? 'ANGLE'})` : `ANGLE without a GPU (${r.gpu?.renderer ?? r.browserError ?? 'no GPU status'})`;
    if (!r.gpu?.accelerated) return { status: 'warn', name, detail: `${gpu} · ${encoder} · ${frames}${tail}`, hint: 'render gl: gpu is set, but the render browser found no GPU: renders may fail or crawl (set it to auto)' };
    if (r.videotoolbox && !r.videotoolbox.ok && p.encoder.asked === 'auto') {
      return { status: 'warn', name, detail: `${gpu} · VideoToolbox does not work here (${r.videotoolbox.error ?? 'its probe failed'}): ${encoder} · ${frames}${tail}`, hint: 'renders encode with libx264 (more CPU): a Mac VM often has no media engine' };
    }
    return { status: 'ok', name, detail: `${gpu} · ${encoder} · ${frames}${tail}` };
  }
  if (p.gl.resolved === 'angle') {
    return {
      status: 'warn',
      name,
      detail: `no GPU found for renders (${r.gpu?.renderer ?? r.browserError ?? 'the render browser reported none'}): software · ${encoder} · ${frames}${tail}`,
      hint: 'renders in software cost ≈ 2.5× the CPU: a VM or a remote session often has no GPU Chromium can use',
    };
  }
  const why = p.gl.asked === 'software' ? '' : ` (no GPU path on ${p.platform})`;
  return { status: 'ok', name, detail: `software${why} · ${encoder} · ${frames}${tail}` };
}

/** The encoder captures feed during the take (L5.7): the Mac's hardware H.264 encoder through ffmpeg, else libx264. */
export async function captureEncoderCheck(p: DoctorProbes, configured: string | undefined): Promise<DoctorCheck | null> {
  if (p.platform !== 'darwin') return { status: 'ok', name: 'Capture encoder', detail: 'libx264 (preset veryfast) during the take' };
  const tools = doctorMediaTools(p, configured);
  if ('error' in tools) return null;
  const cmd = tools.ffmpeg.includes('/') ? tools.ffmpeg : (p.which(tools.ffmpeg) ?? null);
  if (!cmd) return null;
  const res = await p.exec(cmd, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30', '-frames:v', '2', '-c:v', 'h264_videotoolbox', '-f', 'null', '-'], 15_000);
  if (res && res.code === 0) return { status: 'ok', name: 'Capture encoder', detail: 'hardware H.264 (VideoToolbox) during the take' };
  return {
    status: 'warn',
    name: 'Capture encoder',
    detail: `ffmpeg cannot encode with VideoToolbox here${res ? ` (${firstLine(res.stderr) || `exit ${res.code}`})` : ''}: captures encode with libx264 during the take (more CPU)`,
    hint: p.bundle ? 'reinstall Retake, or set "ffmpeg:" in retake.yaml to an ffmpeg with VideoToolbox' : 'a Homebrew ffmpeg has VideoToolbox (brew install ffmpeg)',
  };
}

function displayCheck(p: DoctorProbes): DoctorCheck {
  if (p.platform === 'darwin') return { status: 'ok', name: 'Display', detail: 'macOS desktop (needed by --headed and retake login)' };
  const d = p.env.WAYLAND_DISPLAY ? `WAYLAND_DISPLAY=${p.env.WAYLAND_DISPLAY}` : p.env.DISPLAY ? `DISPLAY=${p.env.DISPLAY}` : null;
  if (d) return { status: 'ok', name: 'Display', detail: `${d} (needed by --headed and retake login)` };
  return {
    status: 'warn',
    name: 'Display',
    detail: 'none: DISPLAY / WAYLAND_DISPLAY are not set',
    hint: 'headless captures work; --headed and retake login need a desktop session (or xvfb-run)',
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

/** The unsafe test resolver of site extractions (L3.5): a warning whenever it is set (tests only). */
export function unsafeTestResolveCheck(p: DoctorProbes): DoctorCheck | null {
  const v = p.env[UNSAFE_TEST_RESOLVE_ENV];
  if (!v) return null;
  const { map, ignored } = unsafeTestResolve(p.env as NodeJS.ProcessEnv);
  return {
    status: 'warn',
    name: 'Site extraction',
    detail: `${UNSAFE_TEST_RESOLVE_ENV} is set: ${[...map.keys()].join(', ') || 'no valid entry'} reach loopback ports and their self-signed certificates are accepted${ignored.length ? ` (${ignored.length} entries ignored)` : ''}`,
    hint: `unset ${UNSAFE_TEST_RESOLVE_ENV}: it is for the test suite only (an MCP server and its worker started with it keep it)`,
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
 * `retake sandbox up` / `run --sandbox` pick without --env) is a docker-compose one.
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
  const { dockerPlaces } = await import('@retake/sandbox');
  const bin = p.env.RETAKE_DOCKER ?? p.which('docker') ?? dockerPlaces(p.env.HOME ?? homedir()).find((x) => p.exists(x)) ?? null;
  if (!bin) return bad('not found', 'install Docker Desktop or OrbStack (or set RETAKE_DOCKER to the docker binary)');
  const v = await p.exec(bin, ['compose', 'version', '--short'], 10_000);
  if (!v) return bad(`${bin} could not be run`, 'install Docker Desktop or OrbStack (or set RETAKE_DOCKER to the docker binary)');
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

async function workspaceChecks(p: DoctorProbes, ws: OpenedWorkspace): Promise<DoctorCheck[]> {
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
          hint: 'cd into your workspace, pass --root <dir>, set $RETAKE_ROOT, or create a project with retake new <slug>',
        },
  );
  const templates = await listTemplates(ws.root).catch(() => []);
  if (!templates.length) {
    // The check names `Templates` / `Template <name>` stay (`retake doctor --json` reads them; docs/GLOSSARY.md).
    out.push({ status: 'warn', name: 'Templates', detail: `no themes in ${ws.templatesDir}`, hint: p.bundle ? "the app's starter themes are missing: reinstall Retake" : "copy a starter from the repository's templates/ folder" });
  }
  for (const t of templates) {
    try {
      const loaded = await loadTemplate(t.dir, ws.root, { files: fileFacts(ws.policy) });
      const fonts = [loaded.assets.display, ...loaded.assets.body];
      const from = t.source === 'starter' ? ' · starter theme' : '';
      out.push({ status: 'ok', name: `Template ${t.name}`, detail: `fonts present (${fonts.length} file${fonts.length === 1 ? '' : 's'})${from}` });
    } catch (e) {
      out.push({ status: 'fail', name: `Template ${t.name}`, detail: errorMessage(e).split('\n')[0], hint: `add the missing files to ${t.dir} or fix template.yaml` });
    }
  }
  return out;
}

async function projectChecks(p: DoctorProbes, ws: OpenedWorkspace, slug: string, global: GlobalOptions): Promise<DoctorCheck[]> {
  // The commands of the hints, with `-C <root>` when the command line named the workspace root.
  const loginCommand = loginCommandFor(global);
  let project: LoadedProject;
  try {
    project = await openProject(ws, slug);
  } catch (e) {
    return [{ status: 'fail', name: `Project ${slug}`, detail: errorMessage(e).split('\n')[0], hint: 'retake list shows the projects of the workspace' }];
  }
  const out: DoctorCheck[] = [{ status: 'ok', name: `Project ${slug}`, detail: project.dir }];
  // The project's browser (retake.yaml's merged in): only what the workspace line does not say already.
  const own = project.config.browser;
  if (own && (own.executable !== ws.browser?.executable || (own.args?.length ?? 0) !== (ws.browser?.args?.length ?? 0))) {
    const jobs = agentJobsCheck({}, ws, { ...(own.executable !== ws.browser?.executable ? { executable: own.executable } : {}), args: own.args?.slice(ws.browser?.args?.length ?? 0) ?? [] }, `Project ${slug}: Studio and MCP jobs`);
    if (jobs) out.push(jobs);
  }
  const envNames = Object.keys(project.config.environments ?? {});
  const defaultEnv = (() => {
    try {
      return resolveEnvironment(project).name;
    } catch {
      return envNames[0];
    }
  })();
  // Browser profile(s) of the single-account form (auth.profile / storage_state): global, or one per environment.
  const rw = await import('@retake/runner-web');
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
          : { status: 'fail', name, detail: `${auth.storageState} not found`, hint: 'export it again, or name the account in auth.personas + retake login' },
      );
    }
  }
  // Sandboxes (L1.8): one line each — their accounts sign in off camera at every take and their hosts are up only
  // while the sandbox runs, so neither gets a line of its own.
  const sandboxes = new Set(sandboxNames(project));
  // Personas (L1.6): their sessions live under the Retake home, never in the project.
  const home = retakeHome(p.env as NodeJS.ProcessEnv);
  const personas = (await projectPersonaStates(project, loginCommand, undefined, home)).filter((x) => !x.state.legacy && !sandboxes.has(x.state.env));
  if (personas.length) {
    const where = `${tildePath(home)}${p.env.RETAKE_HOME ? ' (RETAKE_HOME)' : ''}`;
    out.push((await gitPlacement(p, home, true, 'Session home', where)) ?? { status: 'ok', name: 'Session home', detail: `${where} · outside any git work tree` });
    for (const { state } of personas) out.push(await personaCheck(p, state, home, `${retakeCommand(global)} auth status --project ${slug} --check`));
  } else if (!seen.size) {
    out.push({ status: 'ok', name: 'Profile', detail: 'none configured (a fresh temporary profile per run)' });
  }

  for (const env of sandboxes) out.push(await sandboxCheck(p, project, env, global, ws.policy));
  // L5.8 (R-FLD-30): a local environment with a database, a mailbox or reset hooks and no sandbox: point to one.
  const advice = sandboxAdvice(project);
  if (advice) out.push({ status: 'warn', name: 'Sandbox', ...sandboxAdviceText(advice, slug, retakeCommand(global)) });
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
          hint: /localhost|127\.0\.0\.1/.test(url) ? (p.bundle ? 'start the app first' : 'start the app first (the bundled fixture: pnpm fixture)') : 'check the URL, your VPN / network, or the environment status',
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
async function sandboxCheck(p: DoctorProbes, project: LoadedProject, env: string, global: GlobalOptions, policy: WorkPolicy): Promise<DoctorCheck> {
  const name = `Sandbox ${env}`;
  const envFlag = sandboxNames(project)[0] === env ? '' : ` --env ${env}`;
  const studio = retakeCommand(global);
  if (!p.sandbox) return { status: 'ok', name, detail: 'not checked' };
  const s = await p.sandbox(project, env, policy);
  if (s.error) return { status: 'warn', name, detail: `${s.provider} · ${s.error.split('\n')[0]}` };
  const seed = s.seed ? ` · seed ${s.seed}` : '';
  if (s.state === 'up') return { status: 'ok', name, detail: `${s.provider} · up, ${s.services === 1 ? 'its service is' : `its ${s.services} services are`} healthy${seed}` };
  if (s.state === 'down') {
    return { status: 'warn', name, detail: `${s.provider} · not running`, hint: `${studio} sandbox up ${project.slug}${envFlag} (retake run … --sandbox starts it too)` };
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
 * A session (a profile, a snapshot, the Retake home) in a git work tree (R-AUTH-02): a WARN when git does not ignore
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
    hint: name === 'Session home' ? 'set RETAKE_HOME to a folder outside any repository (or ignore it in that repository)' : 'keep sessions outside repositories: name the account in auth.personas (its session then lives in ~/.retake), or ignore the path',
  };
}

/** One persona's line: its saved session (never signed in, expired, in use…), its last check, a nested work tree. */
async function personaCheck(p: DoctorProbes, s: PersonaState, home: string, recheck: string): Promise<DoctorCheck> {
  const name = `Persona ${s.env}·${s.persona}`;
  const where = s.session === 'profile' ? 'profile' : 'snapshot';
  if (s.status === 'never') return { status: 'warn', name, detail: 'never signed in', hint: `sign in once: ${s.command}` };
  if (s.in_use) {
    return { status: 'warn', name, detail: `its profile is in use by a browser${s.in_use.pid ? ` (pid ${s.in_use.pid})` : ''}`, hint: 'close the retake login window (or the other browser) before capturing' };
  }
  if (s.status === 'expired') return { status: 'warn', name, detail: `expired · ${checkedText(s)}${s.detail ? `: ${s.detail}` : ''}`, hint: `sign in again: ${s.command}` };
  if (s.status === 'error') return { status: 'warn', name, detail: `could not be checked · ${checkedText(s)}${s.detail ? `: ${s.detail}` : ''}`, hint: `is the app running? Then sign in again if needed: ${s.command}` };
  const detail = s.status === 'valid' ? `valid · ${checkedText(s)} · ${where}` : `${where} saved, not checked yet (${recheck})`;
  // A git work tree nested in the Retake home (the home itself is reported once).
  const file = s.session === 'profile' ? s.profile : s.snapshot;
  if (file && gitWorkTree(p, file) !== gitWorkTree(p, home)) {
    const nested = await gitPlacement(p, file, s.session === 'profile', name, detail);
    if (nested) return nested;
  }
  return { status: 'ok', name, detail };
}

/**
 * The MCP line (L3.1): the Node.js a registration names (`retake mcp --print-config`: a stable alias of it where one
 * exists, so a patch upgrade does not break it), the PATH a GUI client gets from it finds ffmpeg, the jobs worker, and
 * the workspace's `.retake/` (its job queue and history) git-ignored when the workspace is a git work tree.
 */
/**
 * L5.16c — the installed app (DESIGN §4p (c)): where it runs from (critique H1: a translocated copy, its disk image or
 * /Volumes — every path recorded then breaks) and the `retake` command's link (`<home>/app.json`'s, else
 * ~/.local/bin/retake): a link to an app that is gone, a file in its place that is not Retake's, another `retake` first
 * on this shell's PATH. From a repository checkout: only a dangling link is said.
 */
/** A path for a command line to paste (review c A-L7): `~/` kept outside, the rest single-quoted unless plain. */
export function pastePath(p: string): string {
  const t = tildePath(p);
  const plain = (s: string) => /^[A-Za-z0-9._/@%+,=-]+$/.test(s);
  if (t.startsWith('~/')) return `~/${plain(t.slice(2)) ? t.slice(2) : zshQuote(t.slice(2))}`;
  return plain(t) ? t : zshQuote(t);
}

/** A worker lock's text shown in this terminal (review c A-L4): controls and invisible characters out, capped. */
function lockText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '?').slice(0, 300);
}

/**
 * The `App updates` line: what the desktop app remembers of its checks (core readUpdateChecks). `build`: what the
 * app's launch.json says of its build (bundle.mjs `launchJson`: `updates` on / off; null for a build from before it) —
 * a build made without a feed and a key never checks (review d A-L9).
 */
export function updateCheck(env: Record<string, string | undefined>, home: string, now = Date.now(), build: 'on' | 'off' | null = null): DoctorCheck {
  const name = 'App updates';
  if (build === 'off') return { status: 'ok', name, detail: 'updates are off in this build (made without an update feed): a newer version comes from its disk image' };
  let checks;
  try {
    checks = readUpdateChecks(env.RETAKE_HOME?.trim() ? retakeHome(env as NodeJS.ProcessEnv) : defaultRetakeHome(home));
  } catch {
    checks = { checked: null, failed: null };
  }
  const off = updateChecksOff(env[UPDATE_DISABLE_ENV]) ? ` · ${UPDATE_DISABLE_ENV} is set here (the app started from this shell checks nothing)` : '';
  if (checks.failed && checks.failed.failure === 'install') return { status: 'warn', name, detail: `the update to ${checks.failed.version} could not be installed: the app kept this version${off}`, hint: 'open the app: Help › Check for Updates… tries again, or install the new version from its disk image' };
  if (checks.checked === null) return { status: 'ok', name, detail: `not checked yet — the app checks at launch, at most once a day (Help › Check for Updates…)${off}` };
  const when = new Date(checks.checked * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const days = Math.floor((now / 1000 - checks.checked) / 86_400);
  return days > 30 ? { status: 'warn', name, detail: `last successful check ${when} UTC, ${days} days ago${off}`, hint: 'open the app (it checks at launch), or Help › Check for Updates… — a feed that cannot be read says so there' } : { status: 'ok', name, detail: `last successful check ${when} UTC${off}` };
}

export function appChecks(p: DoctorProbes): DoctorCheck[] {
  const out = appCommandChecks(p);
  // L5.16d (critique L7): an installed app's update checks — the last successful one, an install that failed, off.
  const home = p.env.HOME?.trim();
  if (p.bundle?.sealed.endsWith('.app') && home) out.push(updateCheck(p.env, home, Date.now(), launchUpdates((p.read ?? readSmallFile)(join(p.bundle.root, 'launch.json')))));
  return out;
}

/** launch.json's `updates` (bundle.mjs: "on" in a build with an update feed, "off" otherwise); null when absent. */
export function launchUpdates(text: string | null): 'on' | 'off' | null {
  try {
    const u = (JSON.parse(text ?? 'null') as { updates?: unknown } | null)?.updates;
    return u === 'on' || u === 'off' ? u : null;
  } catch {
    return null;
  }
}

function appCommandChecks(p: DoctorProbes): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const b = p.bundle ?? null;
  const app = b && b.sealed.endsWith('.app') ? b : null;
  if (app) {
    const loc = installLocation(app.sealed, { readOnly: (p.readOnly ?? onReadOnlyVolume)(app.sealed) });
    out.push(loc === 'ok' ? { status: 'ok', name: 'App location', detail: tildePath(app.sealed) } : { status: 'warn', name: 'App location', detail: `${installLocationWords(loc)} (${app.sealed}): the command and the Claude registrations would point into a folder that goes away`, hint: MOVE_TO_APPLICATIONS });
  }
  // The command's place is under the HOME of the probes' environment (a shell always has one).
  const home = p.env.HOME?.trim();
  if (!home) return out;
  let link = join(defaultCliDir(home), CLI_NAME);
  // The app's own record of where it put the link (a checkout reads nothing of the Retake home here).
  if (app) {
    try {
      link = readAppSettings(p.env.RETAKE_HOME?.trim() ? retakeHome(p.env as NodeJS.ProcessEnv) : defaultRetakeHome(home)).cli?.path ?? link;
    } catch {
      /* a RETAKE_HOME refused elsewhere: the default place */
    }
  }
  const launcher = app ? join(app.root, LAUNCHER_REL) : '';
  const st = cliLinkState(link, launcher);
  const name = 'retake command';
  const first = cliOnPath(dirname(link), p.env.PATH ?? '').first;
  const firstNote = first && first !== link ? ` · ${tildePath(first)} comes first on this PATH` : '';
  if (st.state === 'other_app' && st.dangling) {
    out.push({ status: 'warn', name, detail: `${tildePath(link)} points to a Retake app that is gone (${st.target}): the command fails`, hint: `install it again from the app (Help › Install the retake Command…), or remove it: rm ${pastePath(link)}` });
  } else if (!app) {
    return out;
  } else if (st.state === 'ours') {
    out.push(firstNote ? { status: 'warn', name, detail: `${tildePath(link)} → this app${firstNote}`, hint: `that one runs when you type retake: remove it, or put ${tildePath(dirname(link))} before it on your PATH` } : { status: 'ok', name, detail: `${tildePath(link)} → this app` });
  } else if (st.state === 'other_app') {
    out.push({ status: 'warn', name, detail: `${tildePath(link)} runs another copy of Retake (${st.target})`, hint: 'point it at this one: Help › Install the retake Command… (Replace)' });
  } else if (st.state === 'foreign') {
    out.push({ status: 'warn', name, detail: `${tildePath(link)} is not Retake's command (${st.what}${st.target ? ` → ${st.target}` : ''}): the app leaves it as it is`, hint: 'remove or rename it yourself to install the command from the app, or choose another folder there' });
  } else {
    out.push({ status: 'ok', name, detail: `not installed${first ? ` (${tildePath(first)} is on this PATH)` : ''} · the app's Help › Install the retake Command… links it` });
  }
  return out;
}

async function mcpCheck(p: DoctorProbes, ws: WorkspaceConfig): Promise<DoctorCheck> {
  const name = 'MCP';
  const exec = p.execPath ?? process.execPath;
  const node = stableNodePath(exec, p.exists);
  const parts = [`node ${tildePath(node)}`];
  const warns: Array<{ detail: string; hint: string }> = [];
  if (Number(p.nodeVersion.split('.')[0]) < MIN_NODE_MAJOR) {
    warns.push({ detail: `the registration would name Node.js ${p.nodeVersion}`, hint: `run retake mcp --print-config with Node.js ${MIN_NODE_MAJOR}+` });
  } else if (node === exec && /\/v?\d+\.\d+\.\d+\//.test(node)) {
    warns.push({ detail: `${tildePath(node)} names a patch version: an upgrade of Node.js removes it`, hint: 'register again after an upgrade (retake mcp --print-config), or point it at a version manager alias' });
  }
  // What the MCP client's server gets: the registration's PATH and RETAKE_HOME only (the integrations' config snippet)
  // — never the shell's $RETAKE_FFMPEG / $RETAKE_FFPROBE.
  const path = clientPath(node, p.env.PATH ?? '', p.exists);
  const served = doctorMediaTools(p, ws.ffmpeg, { PATH: path });
  if (!('error' in served) && served.ffmpegSource === 'PATH') {
    if (whichOnPath('ffmpeg', { PATH: path }, p.platform)) parts.push('ffmpeg on the PATH it registers');
    else {
      const shellOnly = p.env.RETAKE_FFMPEG?.trim() ? ' ($RETAKE_FFMPEG is set in this shell only: the registration does not carry it)' : '';
      warns.push({ detail: `ffmpeg is not on the PATH a GUI client gets from the registration${shellOnly}`, hint: p.bundle ? 'set ffmpeg: in retake.yaml' : 'install ffmpeg (Homebrew), or set ffmpeg: in retake.yaml' });
    }
  }
  const worker = p.worker ? await p.worker(ws.root).catch(() => null) : null;
  parts.push(worker ? `worker running (pid ${worker.pid}${worker.started_by ? `, started by ${lockText(worker.started_by)}` : ''})` : 'worker idle (a client starts it with its first job)');
  // L5.16c (critique M6): the workspace's worker runs another copy of Retake — jobs submitted here run with its tools.
  const self = p.engine ?? engineLocation(p.bundle ?? null);
  if (worker && ((worker.engine !== undefined && worker.engine !== self) || (worker.version !== undefined && worker.version !== RETAKE_VERSION))) {
    warns.push({
      detail: `this workspace's worker runs another copy of Retake (${lockText(worker.version ?? '?')}${worker.engine ? `, ${lockText(tildePath(worker.engine))}` : ''}) than this one (${RETAKE_VERSION}, ${tildePath(self)})`,
      hint: 'jobs submitted now run with that copy\'s browsers and tools: let it finish, it exits a minute after its last job — the next submit starts this copy\'s',
    });
  }
  const tree = gitWorkTree(p, ws.root);
  if (tree) {
    const rel = relative(tree, statePath(ws.root));
    const res = await p.exec('git', ['-C', tree, 'check-ignore', '-q', `${rel}/`], 5000);
    if (!res || res.code !== 0) warns.push({ detail: `${tildePath(statePath(ws.root))} (the job queue and history of this machine) is not ignored by git`, hint: `add ${WORKSPACE_GITIGNORE.join(', ')} to the workspace's .gitignore` });
  }
  if (warns.length) return { status: 'warn', name, detail: [...warns.map((w) => w.detail), ...parts].join(' · '), hint: warns.map((w) => w.hint).join('; ') };
  return { status: 'ok', name, detail: `${parts.join(' · ')} · register: retake mcp --print-config` };
}

/**
 * L5.14 — "Captures first": the takes filming now on this Mac for this user (counted, never named: in this workspace or
 * elsewhere), the markers' folder, whether a running render can be slowed (background priority) or only made to wait,
 * the cap. WARN when the folder cannot be used (captures first is off) or a marker's owner is not a Retake process (it
 * holds renders up to the cap).
 */
export function capturesCheck(c: CapturesProbe): DoctorCheck {
  const name = 'Captures first';
  const live = c.takes.filter((t) => !t.paused);
  const here = live.filter((t) => t.here).length;
  const where = [...(here ? [`${here} in this workspace`] : []), ...(live.length - here ? [`${live.length - here} elsewhere on this Mac`] : [])].join(', ');
  const capped = live.filter((t) => t.capped).length;
  const filming = live.length
    ? `${live.length === 1 ? '1 take films' : `${live.length} takes film`} now (${where}): renders, reviews, exports and previews wait for ${live.length === 1 ? 'it' : 'them'}${c.qos ? ' and run at background priority meanwhile' : ''}${capped ? ` — ${capped} past the ${c.capMin}-min cap, which hold${capped === 1 ? 's' : ''} nothing any more` : ''}`
    : 'no take films now';
  const paused = c.takes.length - live.length;
  const parts = [
    filming,
    ...(paused ? [`${paused} paused (holding nothing)`] : []),
    `markers: ${tildePath(c.dir)} (${c.override ? 'set by RETAKE_CAPTURES_DIR' : 'this user on this Mac'}${c.exists ? '' : '; made by the first take'})`,
    c.qos ? 'a render running when a take starts is slowed (background priority)' : 'no background priority here: a running render is not slowed, new heavy jobs only wait',
    `cap ${c.capMin} min (RETAKE_CAPTURE_HOLD_MAX_MIN)`,
  ];
  if (c.problem) return { status: 'warn', name, detail: [c.problem, ...parts.slice(1)].join(' · '), hint: 'captures first is off until the folder is a directory of this user, mode 0700 (or set RETAKE_CAPTURES_DIR to one)' };
  const foreign = c.takes.filter((t) => !t.retake).length;
  if (foreign) {
    return {
      status: 'warn',
      name,
      detail: [`${foreign === 1 ? 'a filming marker whose owner is' : `${foreign} filming markers whose owners are`} not a Retake process`, ...parts].join(' · '),
      hint: `such a marker holds renders for up to ${c.capMin} min; if no take films, remove the k_*.json files in ${tildePath(c.dir)}`,
    };
  }
  return { status: 'ok', name, detail: parts.join(' · ') };
}

const BEFORE = 'Before Retake';

/**
 * L5.13 — what is left from before the rename, each line with the exact command; no line when nothing is.
 * Stats, folder listings and the workspace's and projects' own `.gitignore` files, through the probes (nothing under
 * the old home is read, nothing is written):
 * the old home's sign-ins (the folder the old home variable names when it is set: core oldHomeDir; not looked at when
 * RETAKE_HOME is set — the person chose a home — nor without a HOME), the old variables in the
 * environment, the old workspace file (`refused`: the load failed on it), the old tool folders of the workspace and its
 * projects with their pending rollback journals (critique L9), a `.gitignore` that ignores the old folder and not
 * `.retake/` (review B M1). Hooks, components and the MCP registration that still
 * name an old name are the grep commands of the upgrade guide (docs/guide/upgrading.md).
 */
export function beforeRetakeChecks(p: DoctorProbes, ws: WorkspaceConfig, refused?: string): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  // The probes' HOME only (never this process's): a mocked environment without one looks at no home at all.
  const home = p.env.HOME?.trim();
  // The old home, or the folder the old home variable names when it is set (the old build kept the sign-ins there:
  // core oldHomeDir).
  const where = home ? oldHomeDir(p.env, home) : null;
  if (home && where && where.dir !== defaultRetakeHome(home)) {
    const signIns = (dir: string) => p.exists(join(dir, 'profiles')) || p.exists(join(dir, 'sessions'));
    const old = where.byVar ? `${where.shown} (set by ${where.byVar})` : where.shown;
    const oldDir = where.dir;
    const newDir = defaultRetakeHome(home);
    if (p.exists(oldDir)) {
      const stop = 'stop the Studio, the desktop app, MCP clients and the worker first';
      // With the variable: keeping that folder as the home is the other way (RETAKE_HOME names it).
      const orVar = where.byVar ? `set RETAKE_HOME to ${where.word} where ${where.byVar} is set, or move it: ` : '';
      if (!signIns(oldDir)) {
        out.push({ status: 'warn', name: `${BEFORE}: home`, detail: `${where.byVar ? `${where.shown} (set by ${where.byVar}, from before the rename)` : `${old} (from before the rename)`} is not read; it holds no sign-ins`, hint: `remove it once you have checked it holds nothing you need` });
      } else if (signIns(newDir)) {
        out.push({ status: 'warn', name: `${BEFORE}: home`, detail: `${old} and ~/.retake both hold sign-ins: only ~/.retake is read`, hint: `merge by hand: move the profiles/<project>/<env>/<persona> and sessions/ entries you still need from ${where.shown} into ~/.retake (${stop}), then remove ${where.shown}` });
      } else if (p.exists(newDir)) {
        out.push({
          status: 'warn',
          name: `${BEFORE}: home`,
          detail: `${old} holds the sign-ins from before the rename and is not read; ~/.retake holds only files the tool recreated by itself (${RECREATED_HOME_FILES.join(', ')})`,
          hint: `${orVar}${stop}, then: mv ~/.retake ~/.retake.after-upgrade && mv ${where.word} ~/.retake`,
        });
      } else {
        out.push({ status: 'warn', name: `${BEFORE}: home`, detail: `${old} holds the sign-ins from before the rename and is not read`, hint: `${orVar}${stop}, then: mv ${where.word} ~/.retake` });
      }
    }
  }
  const vars = oldEnvNames(p.env);
  if (vars.length) {
    out.push({
      status: 'warn',
      name: `${BEFORE}: variables`,
      detail: `${vars.slice(0, 5).join(', ')}${vars.length > 5 ? `, … (${vars.length})` : ''} set: not read any more`,
      hint: `rename them RETAKE_* (${OLD_ENV_PREFIX}HOME → RETAKE_HOME…) where they are set: your shell profile, the env of an MCP registration`,
    });
  }
  if (refused) {
    const m = oldWorkspaceFileMessage(ws.root);
    out.push({ status: 'fail', name: `${BEFORE}: workspace file`, detail: m.message, hint: m.fix });
  } else if (p.exists(join(ws.root, WORKSPACE_FILE)) && oldWorkspaceFileAt(ws.root, homedir(), nodeFileFacts)) {
    out.push({ status: 'warn', name: `${BEFORE}: workspace file`, detail: `${join(ws.root, OLD_WORKSPACE_FILE)} (from before the rename) lies next to ${WORKSPACE_FILE}: not read`, hint: `copy what it still holds into ${WORKSPACE_FILE}, then remove it` });
  }
  const dirs = [ws.root, ...(p.list?.(ws.projectsDir) ?? []).sort().map((slug) => join(ws.projectsDir, slug))];
  const label = (dir: string) => (dir === ws.root ? 'workspace' : `project ${relative(ws.projectsDir, dir)}`);
  for (const dir of dirs) {
    // Review B M1: a .gitignore the tool wrote names the old folder only — moved, `.retake/` would be committed.
    const ignore = join(dir, '.gitignore');
    const text = p.read?.(ignore);
    if (text && gitignoreNamesOldDirOnly(text)) {
      out.push({ status: 'warn', name: `${BEFORE}: ${label(dir)} .gitignore`, detail: `${ignore} ignores ${OLD_DIR}/ but not .retake/ (the tool's state of this machine)`, hint: `add it: ${gitignoreFix(ignore)}` });
    }
    if (!p.exists(join(dir, OLD_DIR))) continue;
    const journals = (p.list?.(join(dir, OLD_DIR, 'journals')) ?? []).filter((f) => f.endsWith('.json')).length;
    // L5.14 review B L2: written before journals were signed, they are replayed only by a person in a terminal.
    const slug = dir === ws.root ? '<project>' : relative(ws.projectsDir, dir);
    const pending = journals
      ? ` · ${journals} pending rollback journal${journals === 1 ? '' : 's'} (retake env reset finds them only once moved; written before this version, a person replays them from a terminal: retake env reset ${slug} --replay-unsigned, asked about each)`
      : '';
    const both = p.exists(statePath(dir));
    out.push({
      status: 'warn',
      name: `${BEFORE}: ${dir === ws.root ? 'workspace folder' : label(dir)}`,
      detail: `${join(dir, OLD_DIR)} (the tool's folder from before the rename) is not read${both ? ', next to .retake/' : ''}${pending}`,
      hint: both ? `move what you still need from it (journals/, records/…) into ${statePath(dir)} by hand, then remove it` : `stop the Studio, the worker and the project's sandboxes, then: ${oldDirMove(dir)}`,
    });
  }
  return out;
}

/** Every doctor check, in display order. */
export async function doctorChecks(probes: DoctorProbes, ws: OpenedWorkspace, opts: { project?: string; global?: GlobalOptions; refused?: string } = {}): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [nodeCheck(probes)];
  const damaged = probes.bundleProblems?.() ?? [];
  if (damaged.length) out.push({ status: 'fail', name: 'App bundle', detail: damaged.join(' · '), hint: 'reinstall Retake' });
  out.push(...appChecks(probes));
  const chromium = await probes.chromium(ws.browser, ws.policy);
  out.push(chromiumCheck(chromium, ws.browser, probes.bundle));
  const sandbox = chromiumSandboxCheck(chromium);
  if (sandbox) out.push(sandbox);
  if (probes.renderBrowser === systemRenderBrowser) renderBrowserFn = (await import('@retake/editor')).renderBrowser;
  const render = renderBrowserCheck(probes);
  if (render) out.push(render);
  const gpu = gpuCheck(chromium, ws.browser);
  if (gpu) out.push(gpu);
  if (probes.renders) out.push(rendersCheck(await probes.renders(ws.policy)));
  const ffmpeg = await mediaTool(probes, 'ffmpeg', ws.ffmpeg);
  out.push(ffmpeg);
  out.push(await mediaTool(probes, 'ffprobe', ws.ffmpeg));
  const encoder = ffmpeg.status === 'ok' ? await captureEncoderCheck(probes, ws.ffmpeg) : null;
  if (encoder) out.push(encoder);
  out.push(displayCheck(probes), secretsCheck(probes), notifyCheck(probes));
  const resolve = unsafeTestResolveCheck(probes);
  if (resolve) out.push(resolve);
  // Docker: a failure only when the --project's default sandbox is a docker-compose one.
  const need = opts.project ? await composeSandboxOf(ws, opts.project) : null;
  out.push(await dockerCheck(probes, need));
  out.push(...(await workspaceChecks(probes, ws)));
  const jobs = agentJobsCheck(probes.env, ws, ws.browser);
  if (jobs) out.push(jobs);
  out.push(await mcpCheck(probes, ws));
  if (probes.captures) out.push(capturesCheck(await probes.captures(ws.root)));
  if (opts.project) out.push(...(await projectChecks(probes, ws, opts.project, opts.global ?? {})));
  out.push(...beforeRetakeChecks(probes, ws, opts.refused));
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

/** `retake doctor [--project slug]`: check the machine, the workspace and optionally a project. Exit 1 on any FAIL. */
export async function doctorCommand(ui: Ui, global: GlobalOptions, opts: DoctorOptions, probes: DoctorProbes = systemProbes()): Promise<ExitCode> {
  let ws: OpenedWorkspace;
  let refused: string | undefined;
  try {
    ws = await openWorkspace(global);
  } catch (e) {
    // The workspace file from before L5.13 alone: a "Before Retake" line says to rename it; the rest is still checked.
    const root = global.root ? resolve(global.root) : findWorkspaceRoot();
    if (!(e instanceof ConfigError) || probes.exists(join(root, WORKSPACE_FILE)) || !oldWorkspaceFileAt(root, homedir(), nodeFileFacts)) throw e;
    ws = { root, projectsDir: join(root, 'projects'), templatesDir: join(root, 'templates'), componentsDir: join(root, 'components'), policy: PERSON_POLICY };
    refused = errorMessage(e);
  }
  const checks = await doctorChecks(probes, ws, { project: opts.project, global, refused });
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  if (opts.json) {
    ui.result(JSON.stringify({ ok: fails === 0, failures: fails, warnings: warns, checks }, null, 2));
  } else {
    const c = ui.c;
    const tag = { ok: c.green('OK  '), warn: c.yellow('WARN'), fail: c.red('FAIL') } as const;
    const width = Math.max(...checks.map((x) => x.name.length));
    ui.line(c.bold('retake doctor'));
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
