/** setup_status's answer, by part: the retake command's (cliStatus), Claude Desktop's plan (desktopPlan), and their types. */
import { dirname, join } from 'node:path';
import { errorMessage } from '@retake/core/base';
import type { BundleInfo } from '@retake/core/io';
import { CLI_NAME, LAUNCHER_REL, ZSH_PROFILE, cliLinkState, cliOnPath, defaultCliDir, planDesktopEntry, zshPathLine } from '@retake/engine/integrations';
import type { InstallLocation } from '@retake/engine/integrations';
import { installedLink, recordedLink } from './setup-context.js';
import type { SetupContext, SetupState } from './setup-context.js';

/** The retake command's part of setup_status: the folder shown, its link's state, and where the shell finds it. */
export interface CliStatus {
  dir: string;
  default_dir: string;
  link: string;
  launcher: string;
  state: 'absent' | 'ours' | 'other_app' | 'foreign';
  target?: string;
  dangling?: boolean;
  what?: string;
  chosen: boolean;
  chosen_error?: string;
  /** The shell's folder panel: up (`open`), or no folder came back (`cancelled`: cancelled, or another question was up). */
  panel?: 'open' | 'cancelled';
  /** This app's command (the link the app recorded, else the default folder's), when it runs this app. */
  installed: string | null;
  on_path: boolean;
  first: string | null;
  first_is_this: boolean;
  path_line: string;
  profile: string;
}

/** What setup_status answers (the Studio's Set-up sheet reads it: app/shell/setup.ts), or why there is no set-up. */
export interface SetupStatus {
  available: boolean;
  reason?: 'not_supervised' | 'not_bundled';
  version?: string;
  seen?: boolean;
  location?: InstallLocation;
  location_words?: string;
  workspace?: string;
  home?: string;
  home_from_env?: boolean;
  app?: string;
  cli?: CliStatus;
  claude_code?: { claude: string | null; candidates: string[]; config_dir: string; lines: string[]; plugin: boolean };
  /** `running`: true / false, null when the process list could not be read, absent until it was read. */
  claude_desktop?: { file: string; folder: boolean; state: 'create' | 'add' | 'same' | 'replace' | 'unreadable'; entry: string; running?: boolean | null; backups: string };
  notifications?: 'on' | 'off' | 'unknown';
  untrusted?: { desktop_current?: string; desktop_problem?: string };
}

/** setup_status's `cli`: the folder shown, its link's state, the PATH's word on it (all read now). */
export function cliStatus(ctx: SetupContext, b: BundleInfo, home: string, state: SetupState): CliStatus {
  const launcher = join(b.root, LAUNCHER_REL);
  const defaultDir = defaultCliDir(ctx.home);
  const chosen = state.chosen;
  // The folder shown: a fresh choice, else the one of the link the app made (app.json), else the default.
  const recorded = recordedLink(home, launcher);
  const dir = chosen && 'dir' in chosen ? chosen.dir : recorded ? dirname(recorded) : defaultDir;
  const link = join(dir, CLI_NAME);
  const now = cliLinkState(link, launcher);
  const installed = installedLink(ctx, home, launcher);
  const path = cliOnPath(dir, ctx.env.PATH ?? '', ctx.isExec);
  return {
    dir,
    default_dir: defaultDir,
    link,
    launcher,
    state: now.state,
    ...('target' in now && now.target ? { target: now.target } : {}),
    ...(now.state === 'other_app' ? { dangling: now.dangling } : {}),
    ...(now.state === 'foreign' ? { what: now.what } : {}),
    ...(chosen && 'error' in chosen ? { chosen_error: chosen.error } : {}),
    ...(chosen && 'panel' in chosen ? { panel: chosen.panel } : {}),
    chosen: !!(chosen && 'dir' in chosen),
    installed,
    on_path: path.onPath,
    first: path.first,
    first_is_this: path.first !== null && path.first === link && now.state === 'ours',
    path_line: zshPathLine(dir, ctx.home),
    profile: ZSH_PROFILE,
  };
}

export type DesktopState = NonNullable<SetupStatus['claude_desktop']>['state'];

/** What adding the entry to Claude Desktop's config would do, its current entry, or why the config cannot be read. */
export function desktopPlan(text: string | null, entry: Record<string, unknown>): { state: DesktopState; current?: unknown; problem?: string } {
  try {
    const plan = planDesktopEntry(text, entry);
    return { state: plan.kind, current: plan.current };
  } catch (e) {
    return { state: 'unreadable', problem: errorMessage(e) };
  }
}
