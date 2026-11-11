/**
 * L5.16c: the installed app's Set-up sheet — its data (setup_status, ui setup-ops.ts) and its words (DESIGN §4p (c),
 * docs/reference/studio-ui.md). The sheet opens on the first start of an installed app (setup_status `seen` false), on
 * Help › Set Up Retake… / Install / Uninstall the retake Command… (the shell's `studio:setup` event: apps/desktop
 * menu.rs `setup_page_js`, a constant shape) and at `#/setup`. Every step is skippable and happens only on its click.
 */
import { APP_NAME } from '../brand.js';
import type { CliStatus, InstallLocation, SetupStatus } from '../data/ops.js';
import type { MarkState } from '../ui-kit/index.js';

export type { CliStatus, InstallLocation, SetupStatus };

export const SETUP_EVENT = 'studio:setup';
/** The sections a `studio:setup` event may open on (menu.rs SETUP_SECTIONS: a static test compares the two). */
export const SETUP_SECTIONS = ['cli', 'cli-remove'] as const;
export type SetupSection = (typeof SETUP_SECTIONS)[number];

/** The section of a `studio:setup` detail: null (the top), a known section, or undefined for anything else (ignored). */
export function parseSetupDetail(d: unknown): SetupSection | null | undefined {
  if (d === null || d === undefined) return null;
  if (typeof d !== 'object' || Array.isArray(d)) return undefined;
  const keys = Object.keys(d);
  if (keys.length === 0) return null;
  const s = (d as { section?: unknown }).section;
  if (keys.length !== 1 || keys[0] !== 'section' || typeof s !== 'string' || !(SETUP_SECTIONS as readonly string[]).includes(s)) return undefined;
  return s as SetupSection;
}

/** A checklist item's state and its word (a state word the colour-only rule knows: ready, conflict, blocked…). */
export interface StepState {
  state: MarkState;
  word: string;
}

/** This app's command is in another folder than the one shown (a folder chosen since): Uninstall first. */
export function installedElsewhere(c: CliStatus): boolean {
  return c.installed !== null && c.installed !== c.link;
}

export function cliStep(c: CliStatus): StepState {
  if (c.state === 'ours' || installedElsewhere(c)) return { state: 'ok', word: 'Installed' };
  if (c.state === 'foreign') return { state: 'attention', word: 'Blocked: another file is there' };
  if (c.state === 'other_app') return { state: 'attention', word: c.dangling ? 'Broken: its app is gone' : 'Conflict: another copy' };
  return { state: 'idle', word: 'Ready to install' };
}

/** What lies at the command's place, in a sentence. */
export function cliSentence(c: CliStatus): string {
  if (installedElsewhere(c)) return `This app's retake is ${c.installed}. To put it in ${c.dir} instead, Uninstall it first.`;
  switch (c.state) {
    case 'ours':
      return `${c.link} runs this app's retake.`;
    case 'other_app':
      return `${c.link} runs another copy of ${APP_NAME} (${c.target ?? '?'}${c.dangling ? ', which is gone' : ''}). Replace points it at this one.`;
    case 'foreign':
      return `${c.link} already exists and is not ${APP_NAME}'s command (${c.what ?? 'a file'}${c.target ? ` → ${c.target}` : ''}): it is left as it is. Remove or rename it yourself, or choose another folder.`;
    case 'absent':
      return `Install links ${c.link} to the retake inside this app: it always runs the version of the app you have.`;
  }
}

/** The shell's folder panel, in a sentence (only once the shell said it opened: review c A-L7), or null. */
export function panelSentence(c: CliStatus): string | null {
  if (c.panel === 'open') return 'Choose the folder in the panel the app opened.';
  if (c.panel === 'cancelled') return 'No folder was chosen: the panel was cancelled, or it could not open while another question was up. Choose a Folder… again.';
  return null;
}

/** Claude Desktop running, or not known (`ps` failed): the write waits (review c A-L3); null: nothing to say. */
export function runningSentence(running: boolean | null | undefined): string | null {
  if (running === true) return 'Claude Desktop is running: quit it first (⌘Q in Claude), or it may write its settings over the change';
  if (running === null) return `${APP_NAME} could not check whether Claude Desktop is running, so it does not write the file now: quit Claude Desktop and try again, or copy the entry`;
  return null;
}

/** Which `retake` the app's PATH finds — the app cannot see your shell's PATH (a new Terminal window says the truth). */
export function pathSentence(c: CliStatus): string {
  if (!c.on_path) return `${c.dir} is not on the PATH this app was given. If a new Terminal window does not find retake, add this line to ${c.profile}:`;
  if (c.first_is_this) return `${c.dir} is on the PATH this app was given, and its retake comes first.`;
  if (c.first && c.first !== c.link) return `Another retake comes first on the PATH this app was given: ${c.first}.`;
  return `${c.dir} is on the PATH this app was given.`;
}

export function desktopStep(d: NonNullable<SetupStatus['claude_desktop']>): StepState {
  if (d.state === 'same') return { state: 'ok', word: 'Added' };
  if (d.state === 'replace') return { state: 'attention', word: 'Conflict: another entry' };
  if (d.state === 'unreadable') return { state: 'fail', word: 'Invalid settings file' };
  return { state: 'idle', word: 'Ready to add' };
}

export function notificationsStep(n: SetupStatus['notifications']): StepState {
  if (n === 'on') return { state: 'ok', word: 'Allowed' };
  if (n === 'off') return { state: 'attention', word: 'Blocked in System Settings' };
  return { state: 'idle', word: 'Pending: asked at the first one' };
}

/** Why set-up cannot run on this server. */
export function unavailableSentence(reason: SetupStatus['reason']): string {
  return reason === 'not_bundled'
    ? `Set-up is for the installed app. This ${APP_NAME} runs from a repository checkout: retake mcp --print-config prints the registrations, and the command is pnpm retake.`
    : `Set-up is for the installed app: open it from the ${APP_NAME} app.`;
}
