/**
 * L5.16d: the desktop app's update in the Studio — its data (desktop_update_status, ui update-ops.ts) and its words
 * (DESIGN §4p (d), docs/reference/studio-ui.md). "Update available · vX" in the status bar opens the sheet: the
 * release notes (the feed's text: Txt), Later · Install and Restart; then its progress — downloading and checking the
 * signature, waiting for this workspace's jobs, the quit question — or what went wrong. Help › Check for Updates…
 * opens it too when an update is there (the shell's `studio:update` event: update_flow `update_page_js`, a constant).
 */
import { APP_NAME } from '../brand.js';
import type { MarkState } from '../ui-kit/index.js';

export const UPDATE_EVENT = 'studio:update';

export type UpdateFailure = 'check' | 'download' | 'install' | 'not_writable';
export type UpdateOffReason = 'build' | 'disabled' | 'translocated' | 'read_only';

export interface UpdateStatus {
  available: boolean;
  reason?: 'not_supervised' | UpdateOffReason;
  state?: 'unknown' | 'off' | 'idle' | 'checking' | 'available' | 'downloading' | 'waiting' | 'installing' | 'failed';
  current?: string;
  version?: string | null;
  jobs?: number;
  failure?: UpdateFailure;
  checked?: number | null;
  /** A failure the shell may try again (Install and Restart stays live). */
  retry?: boolean;
  installable?: boolean;
  untrusted?: { notes?: string };
}

/** Why the app does not update itself (update_flow Off). */
export const OFF_WORDS: Record<UpdateOffReason, string> = {
  build: 'Updates are off in this build.',
  disabled: 'Update checks are off (RETAKE_DISABLE_UPDATE_CHECK is set).',
  translocated: `${APP_NAME} runs from a temporary copy macOS made: move it to Applications, then open it again.`,
  read_only: `${APP_NAME} runs from a read-only disk: move it to Applications, then open it again.`,
};

/** What went wrong (update_flow Failure). */
export function failureWords(f: UpdateFailure, current: string): string {
  switch (f) {
    case 'check':
      return 'The update feed could not be read.';
    case 'download':
      return 'The update could not be downloaded, or its signature did not match: nothing was installed.';
    case 'install':
      return `The update could not be installed: ${APP_NAME} ${current} was kept.`;
    case 'not_writable':
      return `${APP_NAME} cannot replace itself in its folder (this account may not write there): install the new version from its disk image.`;
  }
}

/** The status bar's button: shown while an update is known, under way, or failed for a version (review d A-M3: a
 * refusal such as "not writable" keeps its words in the bar and the sheet); null otherwise (nothing in the bar). */
export function badgeWords(s: UpdateStatus | null): string | null {
  if (!s?.available || !s.version) return null;
  switch (s.state) {
    case 'available':
      return `Update available · v${s.version}`;
    case 'downloading':
      return `Downloading v${s.version}…`;
    case 'waiting':
      return `Update waits for ${s.jobs === 1 ? 'a job' : `${s.jobs} jobs`}`;
    case 'installing':
      return `Installing v${s.version}…`;
    case 'failed':
      if (s.failure === 'not_writable') return `Update v${s.version}: install it from its disk image`;
      if (s.failure === 'install') return `Update v${s.version} not installed`;
      return `Update v${s.version} failed`;
    default:
      return null;
  }
}

/** The sheet stays open on these states too (a click's answer: off, a check started again) — closed on idle. */
export function sheetShown(s: UpdateStatus | null): boolean {
  return badgeWords(s) !== null || (!!s?.available && (s.state === 'off' || s.state === 'checking' || s.state === 'failed'));
}

/** The sheet's progress: its state mark, a short title and the sentence; null when nothing is under way or failed. */
export function progressWords(s: UpdateStatus): { state: MarkState; title: string; text: string } | null {
  switch (s.state) {
    case 'downloading':
      return { state: 'running', title: `Downloading v${s.version}`, text: `${APP_NAME} downloads the update and checks its signature against the key it was built with.` };
    case 'waiting':
      return { state: 'running', title: `Waiting for ${s.jobs === 1 ? 'a job' : `${s.jobs} jobs`}`, text: `${APP_NAME} restarts once ${s.jobs === 1 ? 'the job' : `the ${s.jobs} jobs`} of this workspace end. Later stops waiting.` };
    case 'installing':
      return { state: 'running', title: `Installing v${s.version}`, text: `${APP_NAME} is quitting to install it: answer its question if it asks one.` };
    case 'checking':
      return { state: 'running', title: 'Checking for updates', text: `${APP_NAME} asks its update feed again.` };
    case 'off':
      return { state: 'fail', title: 'Updates are off', text: s.reason && s.reason !== 'not_supervised' ? OFF_WORDS[s.reason] : OFF_WORDS.build };
    case 'failed':
      return s.failure ? { state: 'fail', title: s.failure === 'not_writable' ? 'The update cannot be installed here' : 'The update did not go through', text: failureWords(s.failure, s.current ?? '') } : null;
    default:
      return null;
  }
}

/** "Last checked: …" in the person's own time (null: never). */
export function checkedWords(checked: number | null | undefined): string {
  if (!checked) return 'Not checked yet.';
  return `Last checked ${new Date(checked * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`;
}
