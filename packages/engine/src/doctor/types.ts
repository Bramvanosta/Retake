/**
 * What a check of the machine, the workspace and a project is made of (`retake doctor`): its lines, and everything it
 * reads of the machine — the probes, injected so the checks can be tested with a machine that is not this one. The
 * product's probes are machine-probes.ts `machineProbes(ports)`: the system's (its PATH, its programs, its files, the
 * network) and the ports' (the capture browser, the render path and browser, the sandboxes).
 */
import type { BrowserConfig, LoadedProject } from '@retake/core/project';
import type { WorkPolicy } from '@retake/core/policy';
import type { BundleInfo } from '@retake/core/io';
import type { ChromiumProbe } from '@retake/runner-web/types';
import type { RenderBrowserProbe, RenderPathProbe } from '../render/renderer.js';

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

/** The jobs worker serving a workspace: its lock (its version and the copy of Retake it runs, `engine`). */
export interface WorkerProbe {
  pid: number;
  since: string;
  started_by?: string;
  version?: string;
  engine?: string;
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
  /** A sandbox of the project, as `retake sandbox status` sees it (no lock, nothing started). */
  sandbox?(project: LoadedProject, env: string, policy: WorkPolicy): Promise<SandboxProbe>;
  /** The Node.js running this command (default process.execPath): what `retake mcp --print-config` registers. */
  execPath?: string;
  /** The jobs worker serving a workspace, or null: its version and the copy of Retake it runs, to say when it is another copy than this one. */
  worker?(root: string): Promise<WorkerProbe | null>;
  /** This copy of Retake (core engineLocation; default: computed). */
  engine?: string;
  /** Is this folder on a read-only volume (the app's location; default core onReadOnlyVolume)? */
  readOnly?(p: string): boolean;
  /** The names in a real folder (not a link), or null. */
  list?(dir: string): string[] | null;
  /** The text of a small regular file (not a link; ≤ 64 KB), or null. */
  read?(file: string): string | null;
  /** The app bundle this engine runs from (core bundleInfo), or null / absent: a repository checkout. */
  bundle?: BundleInfo | null;
  /** What is wrong with the app bundle (core bundleProblems: a damaged manifest, playwright-core not loading). */
  bundleProblems?(): string[];
  /** The browser renders use: the "Render browser" line; absent, no line. */
  renderBrowser?(): RenderBrowserProbe | Promise<RenderBrowserProbe>;
  /** The "Captures first" line: this user's filming markers on this Mac (nothing made, nothing named); absent, no line. */
  captures?(root: string): Promise<CapturesProbe>;
  /** The "Renders" line: the render path a 1080p render takes here; absent, no line. */
  renders?(policy: WorkPolicy): Promise<RendersProbe>;
}

/** What the "Renders" line reads: the renderer's probe of the render path (render/renderer.ts). */
export type RendersProbe = RenderPathProbe;

/** What doctor shows of captures first. */
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

/** Who needs Docker: the docker-compose sandboxes of the --project, and whether one is its default sandbox. */
export interface DockerNeed {
  /** "the docker-compose sandbox sandbox-docker of project northfield-fixture". */
  by: string;
  /** The project's default sandbox (default_env, else the first declared) is one: a FAIL instead of a WARN. */
  required: boolean;
}

/** The first line of a program's output that holds something, trimmed. */
export const firstLine = (s: string): string =>
  s
    .split('\n')
    .find((l) => l.trim())
    ?.trim() ?? '';
