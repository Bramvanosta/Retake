/**
 * The machine's lines of `retake doctor`: Node.js, the capture browser (its sandbox, its GPU), the render browser and
 * the render path, ffmpeg / ffprobe and the capture encoder, the display, the secrets, the notifications, the unsafe
 * test resolver, Docker — and what Studio and MCP jobs would refuse of the tools named. Each reads the probes only
 * (types.ts DoctorProbes).
 */
import { homedir } from 'node:os';
import { errorMessage, expandHome } from '@retake/core/base';
import { agentArgsProblems, agentProgramProblem, workspaceFolders } from '@retake/core/policy';
import { UNSAFE_TEST_RESOLVE_ENV, unsafeTestResolve } from '@retake/core/theme';
import { nodeFileFacts, resolveMediaTools } from '@retake/core/io';
import type { BrowserConfig, WorkspaceConfig } from '@retake/core/project';
import type { BundleInfo, MediaToolSource, MediaTools } from '@retake/core/io';
import type { ChromiumProbe } from '@retake/runner-web/types';
import { formatMs } from '../format.js';
import type { Sandboxes } from '../sandboxes/sandboxes.js';
import { firstLine } from './types.js';
import type { DockerNeed, DoctorCheck, DoctorProbes, RendersProbe } from './types.js';

export const MIN_NODE_MAJOR = 22;
/** Oldest ffmpeg / ffprobe the tools work with (`-fps_mode`). */
export const MIN_FFMPEG = [5, 1] as const;
export const HOST_TIMEOUT_MS = 5000;

/** How a doctor line names where a tool comes from (every tool line says it). */
export const SOURCE_WORDS: Record<MediaToolSource, string> = { 'retake.yaml': 'retake.yaml', RETAKE_FFMPEG: '$RETAKE_FFMPEG', RETAKE_FFPROBE: '$RETAKE_FFPROBE', bundled: 'bundled', PATH: 'PATH' };

/**
 * The ffmpeg / ffprobe doctor checks: core resolveMediaTools with the probes' environment (or `env`: what another
 * process gets) and bundle; a refused setting (a relative $RETAKE_FFMPEG) as its message.
 */
export function doctorMediaTools(p: DoctorProbes, configured: string | undefined, env: NodeJS.ProcessEnv = p.env): MediaTools | { error: string } {
  try {
    return resolveMediaTools({ configured: configured ? expandHome(configured) : undefined, env, bundle: p.bundle ?? null, exists: p.exists });
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

/** Where to get an ffmpeg, said the way this install can act on it (an app never sends the person to Homebrew). */
export function ffmpegHint(p: DoctorProbes): string {
  return p.bundle
    ? 'this app carries no ffmpeg of its own: set "ffmpeg: /path/to/ffmpeg" in retake.yaml, or $RETAKE_FFMPEG (an ffmpeg 5.1+ with libx264 or VideoToolbox)'
    : 'install ffmpeg (macOS: brew install ffmpeg · Debian/Ubuntu: apt install ffmpeg), or set "ffmpeg: /path/to/ffmpeg" in retake.yaml';
}

/**
 * ffmpeg / ffprobe, in the resolver's order (core bundle.ts): retake.yaml `ffmpeg` (ffprobe next to it) →
 * $RETAKE_FFMPEG / $RETAKE_FFPROBE → the app's own → PATH; the line names the source.
 */
export async function mediaTool(p: DoctorProbes, name: 'ffmpeg' | 'ffprobe', configured: string | undefined): Promise<DoctorCheck> {
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

export function nodeCheck(p: DoctorProbes): DoctorCheck {
  const major = Number(p.nodeVersion.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { status: 'ok', name: 'Node.js', detail: p.nodeVersion }
    : { status: 'fail', name: 'Node.js', detail: `${p.nodeVersion} (needs ${MIN_NODE_MAJOR}+)`, hint: `install Node.js ${MIN_NODE_MAJOR} or later (e.g. nvm install ${MIN_NODE_MAJOR})` };
}

/** How a doctor line names a browser's source. */
export function browserSource(source: string): string {
  return source === 'playwright' ? 'Playwright cache' : source === 'env' ? 'RETAKE_CHROMIUM_HEADLESS_SHELL' : source;
}

export function chromiumCheck(c: ChromiumProbe, browser: BrowserConfig | undefined, bundle?: BundleInfo | null): DoctorCheck {
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
  if (!c.sandbox)
    return { status: 'warn', name, detail: 'the capture browser did not report its command line', hint: 'open chrome://version in that Chromium: its command line must not hold --no-sandbox' };
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

/** The browser renders use: its source; an app without its headless shell is broken (FAIL). */
export async function renderBrowserCheck(p: DoctorProbes): Promise<DoctorCheck | null> {
  const b = await p.renderBrowser?.();
  if (!b) return null;
  const name = 'Render browser';
  if (b.path) return { status: b.note ? 'warn' : 'ok', name, detail: `${b.path} · ${browserSource(b.source)}`, ...(b.note ? { hint: b.note } : {}) };
  if (p.bundle) return { status: 'fail', name, detail: "the app's headless shell is missing", hint: 'reinstall Retake' };
  // Remotion never downloads a browser of its own: no render starts without one.
  return {
    status: 'fail',
    name,
    detail: 'no headless shell: renders do not start',
    hint: 'pnpm --filter @retake/runner-web exec playwright-core install chromium-headless-shell — or point $RETAKE_CHROMIUM_HEADLESS_SHELL at one',
  };
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

/**
 * Is the capture browser GPU-accelerated? Chromium's own report of the browser `retake doctor` just
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

const RENDER_VARS: Record<string, string> = { gl: 'RETAKE_RENDER_GL', encoder: 'RETAKE_RENDER_ENCODER', concurrency: 'RETAKE_RENDER_CONCURRENCY', ffmpeg: 'RETAKE_RENDER_FFMPEG' };
function settingWhere(source: string, key: string): string {
  return source === 'retake.yaml' ? `retake.yaml render.${key}` : source === 'env' ? `$${RENDER_VARS[key]}` : source;
}

/**
 * How renders run here: the GPU path (ANGLE, the render browser's GPU, VideoToolbox) or the software
 * one, the encoder and the frames at a time a 1080p render gets — from the checks a render makes. WARN when `auto`
 * found no GPU or VideoToolbox does not work (renders in software cost ≈ 2.5× the CPU); FAIL when every render would
 * fail (a setting that cannot work here). The encoder names the ffmpeg that encodes the frames when it is this
 * machine's ("VideoToolbox H.264 (this machine's ffmpeg 7.1)": `auto` takes it on the GPU path only, `own` on any), and
 * says why the rendering library's does when ours was wanted there — a WARN only when `render.ffmpeg: own` asked for it
 * by name (renders work either way). Where `auto` keeps the library's by its rule (the software path, the desktop
 * app) the line is the one of before.
 */
export function rendersCheck(r: RendersProbe): DoctorCheck {
  const name = 'Renders';
  const p = r.policy;
  if (!p) return { status: 'fail', name, detail: r.error ?? 'the render settings cannot be read', hint: 'fix retake.yaml render: or the RETAKE_RENDER_* variables' };
  const set = (['gl', 'encoder', 'concurrency', 'ffmpeg'] as const)
    .map((k) => {
      const source = k === 'concurrency' ? p.concurrencySource : (p[k]?.source ?? 'default');
      if (source === 'default' || source === 'option') return null;
      const value = k === 'concurrency' ? p.concurrency : p[k]?.asked;
      return `${k} ${value} (${settingWhere(source, k)})`;
    })
    .filter((x): x is string => !!x);
  const frames = `${r.concurrency ?? p.concurrency} frames at a time`;
  const f = r.ffmpeg;
  const by = f?.used === 'own' ? ` (this machine's ffmpeg${f.version ? ` ${f.version}` : ''})` : f?.note && !f.byRule ? ` (the rendering library's ffmpeg: ${f.note})` : '';
  const encoder = `${r.encoder === 'h264_videotoolbox' ? 'VideoToolbox H.264' : 'libx264 CRF 16'}${by}`;
  const tail = set.length ? ` · set: ${set.join(', ')}` : '';
  if (r.error) return { status: 'fail', name, detail: `${r.error}${tail}`, hint: 'every render would fail: change retake.yaml render: or the RETAKE_RENDER_* variables' };
  if (r.gl === 'angle') {
    const gpu = r.gpu?.accelerated ? `GPU (${r.gpu.renderer ?? 'ANGLE'})` : `ANGLE without a GPU (${r.gpu?.renderer ?? r.browserError ?? 'no GPU status'})`;
    if (!r.gpu?.accelerated)
      return { status: 'warn', name, detail: `${gpu} · ${encoder} · ${frames}${tail}`, hint: 'render gl: gpu is set, but the render browser found no GPU: renders may fail or crawl (set it to auto)' };
    if (r.videotoolbox && !r.videotoolbox.ok && p.encoder.asked === 'auto') {
      return {
        status: 'warn',
        name,
        detail: `${gpu} · VideoToolbox does not work here (${r.videotoolbox.error ?? 'its probe failed'}): ${encoder} · ${frames}${tail}`,
        hint: 'renders encode with libx264 (more CPU): a Mac VM often has no media engine',
      };
    }
    return ownAsked({ status: 'ok', name, detail: `${gpu} · ${encoder} · ${frames}${tail}` }, r);
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
  return ownAsked({ status: 'ok', name, detail: `software${why} · ${encoder} · ${frames}${tail}` }, r);
}

/** `render.ffmpeg: own` asked by name and the rendering library's ffmpeg encodes: a WARN on a line that was fine (renders work). */
function ownAsked(check: DoctorCheck, r: RendersProbe): DoctorCheck {
  if (r.policy?.ffmpeg?.asked !== 'own' || r.ffmpeg?.used !== 'library' || !r.ffmpeg.note) return check;
  return {
    ...check,
    status: 'warn',
    hint: "render ffmpeg: own is set and this machine's ffmpeg does not encode renders here: they use the rendering library's (set it to auto, or see the ffmpeg line)",
  };
}

/** The encoder captures feed during the take: the Mac's hardware H.264 encoder through ffmpeg, else libx264. */
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

export function displayCheck(p: DoctorProbes): DoctorCheck {
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

export function secretsCheck(p: DoctorProbes): DoctorCheck {
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

export function notifyCheck(p: DoctorProbes): DoctorCheck {
  const tool = p.platform === 'darwin' ? 'osascript' : p.platform === 'linux' ? 'notify-send' : null;
  if (tool && p.which(tool)) return { status: 'ok', name: 'Notifications', detail: `${tool} (notify steps)` };
  return {
    status: 'warn',
    name: 'Notifications',
    detail: tool ? `${tool} not found: notify steps are only logged` : `no desktop notifications on ${p.platform}: notify steps are only logged`,
    hint: p.platform === 'linux' ? 'install libnotify-bin (notify-send) for desktop notifications' : undefined,
  };
}

/** The unsafe test resolver of site extractions: a warning whenever it is set (tests only). */
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

/**
 * Docker: only docker-compose sandboxes need it. OK with the daemon's and Compose's versions and the context;
 * WARN when it is missing, too old or its daemon is down — a FAIL only when the --project's default sandbox (the one
 * `retake sandbox up` / `run --sandbox` pick without --env) is a docker-compose one.
 */
export async function dockerCheck(p: DoctorProbes, places: Sandboxes['dockerPlaces'], need: DockerNeed | null = null): Promise<DoctorCheck> {
  const name = 'Docker';
  const bad = (detail: string, hint: string): DoctorCheck => ({
    status: need?.required ? 'fail' : 'warn',
    name,
    detail: need ? `${detail} — needed by ${need.by}` : `${detail} — only needed by docker-compose sandboxes`,
    hint,
  });
  // The places the sandbox package looks in (PATH first, then Docker Desktop's, OrbStack's, Homebrew's…).
  const bin = p.env.RETAKE_DOCKER ?? p.which('docker') ?? (await places(p.env.HOME ?? homedir())).find((x) => p.exists(x)) ?? null;
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
  if (info?.code !== 0 || !server) {
    return bad(`Compose ${compose}, but the daemon is not running${info?.stderr ? ` (${firstLine(info.stderr)})` : ''}`, 'start Docker Desktop or OrbStack');
  }
  const ctx = await p.exec(bin, ['context', 'show'], 5000);
  const context = ctx && ctx.code === 0 ? firstLine(ctx.stdout) : '';
  return { status: 'ok', name, detail: `${server} · Compose ${compose}${context ? ` · context ${context}` : ''} · ${bin}` };
}
