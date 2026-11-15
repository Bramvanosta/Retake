/** A recording session's options, result and limits (record-session.ts). */
import type { Page } from 'playwright-core';
import type { BrowserConfig, LoadedProject } from '@retake/core/project';
import type { ResolvedEnvironment } from '@retake/core/environment';
import type { ResolvedPersona, RunAccess } from '@retake/core/environment';
import type { WorkPolicy } from '@retake/core/policy';
import type { RecordedEvent } from '@retake/core/run';

/** The recording's log. */
export type Log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

/** The longest a recording lasts by default (it stops and keeps what it has). */
export const RECORD_MAX_MS = 30 * 60_000;
/** In-page time budget of one element's suggestion at pointerdown (ms). */
export const RECORD_BUDGET_MS = 150;
/** In-page time budget of its alternative targets (ms, inside RECORD_BUDGET_MS): a press waits for them. */
export const RECORD_ALT_BUDGET_MS = 10;

export interface RecordSessionOptions {
  project: LoadedProject;
  /** What the work runs under (core WorkPolicy): which Chromium and ffmpeg, which switches, under its agent policy. */
  policy: WorkPolicy;

  env: ResolvedEnvironment;
  /** The persona the window is signed in as (its session is copied); null / absent: signed out (a fresh profile). */
  persona?: ResolvedPersona | null;
  /** The page the window opens (an environment page's URL; the caller checks it). */
  url: string;
  /** `--allow-writes` (a production environment that allows writes), as `retake run`. */
  allowWrites?: boolean;
  browser?: BrowserConfig;
  /** Events are appended here as they come (0600; the folder must exist). */
  eventsFile?: string;
  /** Longest recording (default 30 min): it stops and keeps what it has (`max_duration`). */
  maxMs?: number;
  log?: Log;
  /** The window shows its first page (the CLI says what to do). */
  onOpen?: (url: string) => void;
  /** Each event kept (progress: count it, never print page text). */
  onEvent?: (e: RecordedEvent) => void;
  /** Stop and keep (Ctrl-C in the CLI, a worker signal): the pending typing is committed, the window closes. */
  stop?: AbortSignal;
  /** Cancel (job_cancel): the window closes, the events file is removed, throws a CancelledError. */
  signal?: AbortSignal;
  /** Test hook: plays the person in the window (Playwright input is trusted); the recording ends when it closes it. */
  drive?: (page: Page) => Promise<void>;
  /** With `drive`: the "headed" window runs headless (tests without a display). */
  headless?: boolean;
  /** The window's size (tests; default: maximised on the screen). */
  windowSize?: { width: number; height: number };
  /** Test hook: the alternatives' in-page budget per press (default RECORD_ALT_BUDGET_MS; 0: none, said partial). */
  alternativesBudgetMs?: number;
}

export interface RecordSessionResult {
  events: RecordedEvent[];
  stop: 'closed' | 'stopped' | 'max_duration';
  ms: number;
  /** The page's viewport in the window (CSS px), as the recorder saw it first. */
  window: { width: number; height: number } | null;
  capture: { width: number; height: number };
  access: RunAccess['mode'];
  persona: string | null;
  counts: {
    events: number;
    /** Presses, typing, keys, selects, files. */
    actions: number;
    writes: number;
    /** Strings the secret memory masked. */
    redacted: number;
    dropped: { sign_in: number; frame: number; invalid: number; new_page: number };
  };
  /** Never quotes page text or a typed value. */
  warnings: string[];
}
