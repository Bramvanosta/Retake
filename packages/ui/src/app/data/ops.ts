/**
 * L6.12: StudioOps — every op the Studio serves, with its arguments and its result: `call` / `useCall` (api.ts) are
 * typed by it, so an op the Studio does not serve, an argument its input refuses or a result read as another type is a
 * compile error.
 *
 * Both are derived from the Studio's op table (L6.12–L6.13 fixes; types only — this module imports nothing at run
 * time): `StudioTools` (server/studio.ts) is each op as `/v1/call/<op>` runs it — the MCP tool or the Studio's own op,
 * its pinned arguments applied — and the operation contract keeps each one's types (`ToolDef<S, D, N>`). An op's
 * arguments are its input schema's input type (read-only: a call never changes them), its result the data its handler
 * answers. NARROWED lists the ops whose arguments and result the app holds narrower than the op's own, each with its
 * reason (ratchet-style: packages/ui/test/studio-ops.test.ts holds the list).
 */
import type { CompactRunStatus } from '@retake/engine';
import type { StudioOpName, ToolArgs, ToolData } from '@retake/engine/contract';
import type { StudioTools } from '../../server/studio.js';

/** An op the Studio serves (`POST /v1/call/<op>`): the catalogue's (UI_OPS). */
export type StudioOp = StudioOpName;

/** What a page sends: the arguments read-only all the way down (a call never changes them; a page may pass constants). */
export type Sent<T> = T extends object ? { readonly [K in keyof T]: Sent<T[K]> } : T;

/**
 * The ops the app calls with narrower arguments than the op takes, and so reads a narrower result (the reason of each):
 * - run_status: the Studio never asks `detail: "full"` (the answer with every screenshot and output, for Claude); it
 *   reads the compact status (L5.8: `duration_s`, `files`; no `outputs`, `screenshots` or `duration_ms`).
 */
interface Narrowed {
  run_status: { args: Omit<ToolArgs<StudioTools['run_status']>, 'detail'> & { detail?: 'compact' }; result: CompactRunStatus };
}

/** Every op the Studio serves: its arguments and its result, derived from the op table (NARROWED for the few held narrower). */
export type StudioOps = {
  [K in StudioOp]: K extends keyof Narrowed
    ? { args: Sent<Narrowed[K]['args']>; result: Narrowed[K]['result'] }
    : { args: Sent<ToolArgs<StudioTools[K]>>; result: ToolData<StudioTools[K]> };
};

/** The narrowed result is one of the op's own answers (a compile-time check: never a type the op does not answer). */
export type NarrowedResultsAreAnswers = AllTrue<{ [K in keyof Narrowed]: Narrowed[K]['result'] extends ToolData<StudioTools[K]> ? true : false }>;
/** The narrowed arguments are arguments the op takes. */
export type NarrowedArgsAreArgs = AllTrue<{ [K in keyof Narrowed]: Narrowed[K]['args'] extends ToolArgs<StudioTools[K]> ? true : false }>;
type AllTrue<T extends Record<string, true>> = T;

// ── Names of the results the screens use (each an op's own answer, or a part of one) ─────────────────────────────────

type Result<K extends StudioOp> = StudioOps[K]['result'];

/** engine_info: the engine's version and root, its worker (and the other copy of Retake it runs), held work, legacy notes. */
export type EngineInfoAnswer = Result<'engine_info'>;
/** project_list: the workspace's projects. */
export type ProjectList = Result<'project_list'>;
/** scenario_blocks: the scenario screen's view, and the language's hint of each action the file uses. */
export type ScenarioBlocksView = Result<'scenario_blocks'>;
/** run_thumbs: base64 JPEGs of a run's steps, by the run's own step keys, and the keys without one. */
export type ThumbAnswer = Result<'run_thumbs'>;
/** A job of the queue, as job_list shows it (the Cast's sessions panel); auth_login and sign_in_cancel answer one. */
export type JobLite = Result<'job_list'>['jobs'][number];
/** frame_anchor: a frame's anchor for a new thread (its step at that frame now). */
export type AnchorAnswer = Result<'frame_anchor'>;
/** render_frame: one frame of a render as a JPEG. */
export type FrameAnswer = Result<'render_frame'>;
/** render_outline: a render's frames, its step markers and its threads' pins. */
export type Outline = Result<'render_outline'>;
/** review_image and thread_still: one picture as a JPEG. */
export type StillAnswer = Result<'review_image'>;
/** brand_files: the workspace's brand images or fonts. */
export type BrandFiles = Result<'brand_files'>;
/** theme_create: the theme made, the palette's adjustments. */
export type ThemeCreated = Result<'theme_create'>;
/** setup_status: the Set-up sheet (shell/setup.ts). */
export type SetupStatus = Result<'setup_status'>;
/** desktop_update_status: the update (shell/update.ts). */
export type UpdateStatus = Result<'desktop_update_status'>;
/** setup_status's retake command. */
export type CliStatus = NonNullable<SetupStatus['cli']>;
/** Where the installed app runs from (setup_status `location`). */
export type InstallLocation = NonNullable<SetupStatus['location']>;
/** What went wrong with an update (desktop_update_status `failure`). */
export type UpdateFailure = NonNullable<UpdateStatus['failure']>;
/** Why the app does not update itself (desktop_update_status `reason`, the server's own left out). */
export type UpdateOffReason = Exclude<NonNullable<UpdateStatus['reason']>, 'not_supervised'>;
