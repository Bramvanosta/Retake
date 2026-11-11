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
  state?: 'unknown' | 'off' | 'idle' | 'updated' | 'checking' | 'available' | 'downloading' | 'waiting' | 'installing' | 'failed';
  current?: string;
  version?: string | null;
  jobs?: number;
  /** BL-167: while downloading, the bytes received and the announced size (null: none). */
  received?: number;
  total?: number | null;
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

/** "152 MB" (one decimal under 10 MB). */
export function megabytes(n: number): string {
  const mb = n / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** BL-167: the download's figure — its whole percent (undefined: no size announced) and its words. */
export function downloadFigure(s: UpdateStatus): { percent?: number; text: string } | null {
  if (s.state !== 'downloading') return null;
  const received = s.received ?? 0;
  const total = s.total ?? null;
  if (!total) return { text: received > 0 ? `${megabytes(received)} so far` : 'Starting…' };
  const percent = Math.min(100, Math.floor((Math.min(received, total) * 100) / total));
  return { percent, text: `${megabytes(Math.min(received, total))} of ${megabytes(total)} · ${percent} %` };
}

/** Every byte arrived: the plugin checks the signature before the download ends. */
export function verifying(s: UpdateStatus): boolean {
  return s.state === 'downloading' && !!s.total && (s.received ?? 0) >= s.total;
}

/** The status bar's button: shown while an update is known, under way, or failed for a version (review d A-M3: a
 * refusal such as "not writable" keeps its words in the bar and the sheet); null otherwise (nothing in the bar). */
export function badgeWords(s: UpdateStatus | null): string | null {
  if (s?.available && s.state === 'updated' && s.current) return `Updated to v${s.current}`;
  if (!s?.available || !s.version) return null;
  switch (s.state) {
    case 'available':
      return `Update available · v${s.version}`;
    case 'downloading': {
      if (verifying(s)) return `Checking v${s.version}…`;
      const pct = downloadFigure(s)?.percent;
      return pct === undefined ? `Downloading v${s.version}…` : `Downloading v${s.version} · ${pct} %`;
    }
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
      if (verifying(s)) return { state: 'running', title: 'Checking the signature', text: `${APP_NAME} checks the update against the key it was built with.` };
      return { state: 'running', title: `Downloading v${s.version}`, text: `${APP_NAME} downloads the update, then checks its signature against the key it was built with. Later stops it.` };
    case 'waiting':
      return { state: 'running', title: `Waiting for ${s.jobs === 1 ? 'a job' : `${s.jobs} jobs`}`, text: `${APP_NAME} restarts once ${s.jobs === 1 ? 'the job' : `the ${s.jobs} jobs`} of this workspace end. Later stops waiting.` };
    case 'installing':
      return {
        state: 'running',
        title: `Installing v${s.version}`,
        text: `${APP_NAME} quits, installs it and opens again by itself: its window is gone for a few seconds (its Dock icon shows ↻ meanwhile). Answer its question if it asks one.`,
      };
    case 'updated':
      return { state: 'ok', title: `Updated to v${s.current}`, text: `${APP_NAME} installed the update and opened again. Workspaces, projects and sign-ins are as you left them.` };
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

export type StepState = 'done' | 'running' | 'next' | 'failed';
export interface InstallStep {
  id: 'download' | 'signature' | 'jobs' | 'install';
  label: string;
  state: StepState;
}
/** A step's state: its mark and its word (the word is shown: never a colour alone). */
export const STEP_MARKS: Record<StepState, { mark: MarkState; word: string }> = {
  done: { mark: 'ok', word: 'done' },
  running: { mark: 'running', word: 'running' },
  next: { mark: 'idle', word: 'pending' },
  failed: { mark: 'fail', word: 'failed' },
};

/**
 * BL-167: Install and Restart's steps, each said in turn — the download, the signature, the wait for this workspace's
 * jobs, the quit that installs and restarts — and the one that failed; null before the click and on a failure that is
 * no step's (the feed, a folder it cannot write).
 */
export function installSteps(s: UpdateStatus): InstallStep[] | null {
  const jobs = s.state === 'waiting' && s.jobs ? (s.jobs === 1 ? 'Wait for a job of this workspace' : `Wait for ${s.jobs} jobs of this workspace`) : "Wait for this workspace's jobs";
  const labels: Array<[InstallStep['id'], string]> = [
    ['download', 'Download the update'],
    ['signature', 'Check its signature'],
    ['jobs', jobs],
    ['install', `Quit, install and restart ${APP_NAME}`],
  ];
  let at: number;
  let failed = false;
  switch (s.state) {
    case 'downloading':
      at = verifying(s) ? 1 : 0;
      break;
    case 'waiting':
      at = 2;
      break;
    case 'installing':
      at = 3;
      break;
    case 'failed':
      if (s.failure !== 'download' && s.failure !== 'install') return null;
      // A download that failed may be its signature: the shell says one failure for both (update_flow Failure::Download).
      at = s.failure === 'download' ? 0 : 3;
      failed = true;
      break;
    default:
      return null;
  }
  return labels.map(([id, label], i) => ({ id, label, state: i < at ? 'done' : i === at ? (failed ? 'failed' : 'running') : 'next' }));
}

/** "Last checked: …" in the person's own time (null: never). */
export function checkedWords(checked: number | null | undefined): string {
  if (!checked) return 'Not checked yet.';
  return `Last checked ${new Date(checked * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`;
}
