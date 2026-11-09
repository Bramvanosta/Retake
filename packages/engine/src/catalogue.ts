/**
 * The operation catalogue: every operation of Retake once, as data — its name, its kind, and for each shell (the
 * `retake` command, the MCP server, the Studio) whether it serves it, and when it does not, why. The Studio's entry
 * also holds the arguments it pins (a page asks for less than Claude may) and the operation's own HTTP statuses.
 *
 * An operation is named by the MCP tool or Studio op that serves it; one served by the CLI only is named after its
 * command. A CLI command may serve several operations (`retake run` is a dry run or a capture). The shells' own lists
 * are held to this one by tests: MCP `TOOLS`, the Studio's `UI_OPS` and its own ops, and the commander tree of the CLI.
 * Nothing here runs an operation: it says who serves it.
 */
import type { EngineErrorCode } from './errors.js';

/**
 * What an operation does, the strongest that applies: `read` reads only; `write` writes authored files or the state
 * of a job (a cancel, a pause) at once; `job` is long work the MCP server and the Studio queue for the workspace's
 * worker (a dry run, a capture, a render, a review, an export, a preview, a sign-in, a recording) and the CLI runs in
 * its process; `runs_code` runs the project's own commands (hooks, sandbox seed steps and services, an external
 * program); `destructive` removes data a person made (pruned runs, a replaced theme, a discarded recording).
 */
export const OPERATION_KINDS = ['read', 'write', 'job', 'runs_code', 'destructive'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const SHELLS = ['cli', 'mcp', 'studio'] as const;
export type Shell = (typeof SHELLS)[number];

/** A shell that does not serve an operation, and why (one line). */
export interface NotServed {
  readonly why: string;
}

/**
 * An argument the Studio pins (critique B11 of L4.2: pin what a page can ask): it accepts this one value only —
 * `optional`: absent or this value; `default`: this value when absent — under its own description.
 */
export interface ArgumentPin {
  readonly arg: string;
  readonly value: string | number;
  readonly absent: 'optional' | 'default';
  readonly description: string;
}

/** The Studio serves the operation (`POST /v1/call/<name>`), with these pinned arguments and HTTP statuses. */
export interface StudioServe {
  readonly pins?: readonly ArgumentPin[];
  /** The operation's own HTTP status for an engine error code (instead of the shared ERROR_STATUS). */
  readonly status?: Readonly<Partial<Record<EngineErrorCode, number>>>;
}

export interface Operation {
  readonly name: string;
  readonly kind: OperationKind;
  /** The `retake` commands that serve it (paths such as `hooks run`), or why none does. */
  readonly cli: readonly string[] | NotServed;
  /** An MCP tool of this name serves it, or why none does. */
  readonly mcp: true | NotServed;
  readonly studio: StudioServe | NotServed;
}

const no = (why: string): NotServed => ({ why });
const STUDIO: StudioServe = {};

// Reasons several operations share.
const NO_HOOKS_IN_STUDIO = no("no Studio screen runs hooks: a page's script cannot be told from a person's click, so hooks that need a person are approved in a terminal or by Claude's user");
const NO_SANDBOX_IN_STUDIO = no("no Studio screen manages a sandbox (the Studio's runs never start or reset one): `retake sandbox` in a terminal");
const COMMENT_PAGE = no('a page is never Claude: the Studio answers threads through its own thread ops (the channel studio, never a proposal)');
const DESKTOP_ONLY = no("the desktop app's own server only: between its window and its shell");
const SETUP_ONLY = no('the installed app\'s Set-up sheet only: no MCP tool can install the command or register Retake with Claude');
const SCREEN_READ = no('a read shaped for one Studio screen: a terminal shows the files and the commands\' own output');
const PREVIEW_FRAME = no("the Studio's sandboxed preview frame: a terminal renders stills and videos instead");
const RECORD_PANEL = no("the Record screen's control panel of the window the Studio opened: Claude asks for a recording with scenario_record and follows it with job_status");
const RECORD_CLI = no('`retake record` runs the whole recording in the terminal: its window, its draft and its check');
const LIBRARY_MCP = no('Claude reads components with component_list and component_get and sees them through component_preview');
const THEME_EDIT_MCP = no('MCP never edits a theme: Claude makes a new one with template_create_from_brand, the person edits theirs');
const THREAD_CLI_READ = no('`retake comment list` shows the threads and their entries');
const AGENT_ONLY = no('an aid for Claude, who writes the scenario: no Studio screen');
const TERMINAL_ONLY_MCP = no('a command a person runs in a terminal');
const TERMINAL_ONLY_STUDIO = no('a command a person runs in a terminal: no Studio screen');

/** Every operation, MCP tools first (in the order tools/list gives them), then the Studio's own ops, then the CLI's own. */
export const CATALOGUE: readonly Operation[] = [
  // The MCP tools.
  { name: 'engine_info', kind: 'read', cli: no('`retake --version` and `retake doctor` tell a person the same'), mcp: true, studio: STUDIO },
  { name: 'project_list', kind: 'read', cli: ['list'], mcp: true, studio: STUDIO },
  { name: 'project_get', kind: 'read', cli: no('a person reads README.md and project.yaml'), mcp: true, studio: STUDIO },
  { name: 'project_create', kind: 'write', cli: ['new'], mcp: true, studio: no('no Studio screen creates a project: `retake new` in a terminal') },
  { name: 'project_update_readme', kind: 'write', cli: no('a person edits README.md'), mcp: true, studio: STUDIO },
  { name: 'project_prune', kind: 'destructive', cli: ['prune'], mcp: true, studio: no('no Studio screen frees disk space: `retake prune` in a terminal') },
  { name: 'scenario_get', kind: 'read', cli: no('a person opens scenarios/<name>.yaml'), mcp: true, studio: no('the scenario screen reads the file through scenario_blocks') },
  { name: 'scenario_validate', kind: 'read', cli: ['validate'], mcp: true, studio: STUDIO },
  { name: 'scenario_save', kind: 'write', cli: no('a person edits scenarios/<name>.yaml'), mcp: true, studio: no('one Studio write path for a scenario: scenario_edit') },
  { name: 'page_inspect', kind: 'job', cli: ['inspect'], mcp: true, studio: AGENT_ONLY },
  { name: 'scenario_record', kind: 'job', cli: ['record'], mcp: true, studio: no('a recording from the Studio is record_start, pinned (page and path, no --allow-writes, the check on), and is stopped, discarded and saved through its own ops only') },
  { name: 'scenario_from_script', kind: 'read', cli: no('an aid for Claude, who rewrites the skeleton into real steps'), mcp: true, studio: AGENT_ONLY },
  { name: 'run_list', kind: 'read', cli: no('runs/ holds them; the commands name a run by its id or `latest`'), mcp: true, studio: STUDIO },
  {
    name: 'run_status',
    kind: 'read',
    cli: no('`retake run` follows its run in the foreground; `retake jobs status` follows a job'),
    mcp: true,
    // A page never long-polls: a page waiting 25 s holds one of the browser's 6 connections.
    studio: { pins: [{ arg: 'wait_s', value: 0, absent: 'optional', description: 'Always 0 from the Studio (no long-poll).' }] },
  },
  { name: 'run_dry', kind: 'job', cli: ['run'], mcp: true, studio: no("the Studio's dry run is scenario_run, with pinned arguments: no sandbox, no until, no wait") },
  { name: 'run_capture', kind: 'job', cli: ['run'], mcp: true, studio: no("the Studio's capture is scenario_run, with pinned arguments: no sandbox, no until, no wait") },
  { name: 'run_cancel', kind: 'write', cli: no('Ctrl-C stops `retake run`; `retake jobs cancel` stops a job'), mcp: true, studio: STUDIO },
  { name: 'plan_preview', kind: 'read', cli: ['plan'], mcp: true, studio: no('the timeline screen shows the plan through timeline_view') },
  { name: 'render', kind: 'job', cli: ['render'], mcp: true, studio: no("the Studio's render is scenario_render, with the theme and options of the files") },
  { name: 'render_status', kind: 'read', cli: no('`retake render` renders in the foreground'), mcp: true, studio: no("the Studio's render queue and list are scenario_renders") },
  { name: 'review', kind: 'job', cli: ['review'], mcp: true, studio: no("the Studio's render is reviewed after it (scenario_render)") },
  { name: 'review_get', kind: 'read', cli: no('`retake review` prints the verdict; review/<render>/ holds the report'), mcp: true, studio: no('the Studio reads a review without paths (render_review) and its contact sheets (review_image)') },
  { name: 'export', kind: 'job', cli: ['export'], mcp: true, studio: no("the Studio's export is review_export (MP4 1080p in its fixed folder)") },
  { name: 'comments_list', kind: 'read', cli: ['comment list'], mcp: true, studio: COMMENT_PAGE },
  { name: 'comment_reply', kind: 'write', cli: ['comment reply'], mcp: true, studio: COMMENT_PAGE },
  { name: 'comment_resolve', kind: 'write', cli: ['comment resolve'], mcp: true, studio: COMMENT_PAGE },
  { name: 'template_list', kind: 'read', cli: ['list'], mcp: true, studio: no('the theme screens list themes through theme_list') },
  { name: 'template_preview', kind: 'job', cli: no('`retake still --theme` renders a frame of a video with a theme'), mcp: true, studio: no("the theme editor's live preview is theme_preview, in the sandboxed frame") },
  { name: 'template_from_site', kind: 'job', cli: ['theme from-site'], mcp: true, studio: no("a site extraction needs a person's approval of the URL: the Studio shows the command (site_list)") },
  { name: 'template_create_from_brand', kind: 'destructive', cli: ['theme create'], mcp: true, studio: no('the theme editor makes a new theme through theme_create, never replacing one') },
  { name: 'component_list', kind: 'read', cli: ['components list'], mcp: true, studio: no('the library screen lists components through library_view') },
  { name: 'component_get', kind: 'read', cli: no("`retake components list` lists them; a component's folder holds its manifest and README"), mcp: true, studio: no("the library screen shows a component's detail through library_component") },
  { name: 'component_validate', kind: 'read', cli: ['components validate'], mcp: true, studio: no('no Studio screen checks a component: `retake components validate` in a terminal') },
  { name: 'component_preview', kind: 'job', cli: ['components preview'], mcp: true, studio: no('the library shows posters and loops the worker rendered (library_images, library_render), never component code in the Studio\'s origin') },
  { name: 'component_create', kind: 'write', cli: ['components create'], mcp: true, studio: no('component code is the person\'s: `retake components create` scaffolds one') },
  { name: 'job_list', kind: 'read', cli: ['jobs list'], mcp: true, studio: STUDIO },
  { name: 'job_status', kind: 'read', cli: ['jobs status'], mcp: true, studio: no('the Studio follows jobs through its event stream, run_status and scenario_renders') },
  { name: 'job_cancel', kind: 'write', cli: ['jobs cancel'], mcp: true, studio: no('the Studio cancels a job of its own kind only: run_cancel, render_cancel, sign_in_cancel and the record ops') },
  { name: 'hooks_run', kind: 'runs_code', cli: ['hooks run'], mcp: true, studio: NO_HOOKS_IN_STUDIO },
  { name: 'env_reset', kind: 'runs_code', cli: ['env reset'], mcp: true, studio: NO_HOOKS_IN_STUDIO },
  { name: 'auth_status', kind: 'read', cli: ['auth status'], mcp: true, studio: STUDIO },
  {
    name: 'auth_login',
    kind: 'job',
    cli: ['login'],
    mcp: true,
    // A page script can do no more than open a window the person sees (it closes by itself after RETAKE_SIGNIN_MAX_MIN):
    // `auto` is what every run's preflight does by itself, and the Sessions panel follows the job.
    studio: {
      pins: [
        { arg: 'mode', value: 'headed', absent: 'default', description: 'Always headed from the Studio: a window where the person signs in.' },
        { arg: 'wait_s', value: 0, absent: 'default', description: 'Always 0 from the Studio (the panel follows the job).' },
      ],
    },
  },
  { name: 'sandbox_status', kind: 'read', cli: ['sandbox status'], mcp: true, studio: NO_SANDBOX_IN_STUDIO },
  { name: 'sandbox_up', kind: 'runs_code', cli: ['sandbox up'], mcp: true, studio: NO_SANDBOX_IN_STUDIO },
  { name: 'sandbox_reset', kind: 'runs_code', cli: ['sandbox reset'], mcp: true, studio: NO_SANDBOX_IN_STUDIO },

  // The Studio's own ops.
  { name: 'activity_list', kind: 'read', cli: no('the workspace index is the Studio\'s cache: `retake jobs list` lists jobs'), mcp: no('the workspace index is the Studio\'s cache for its activity feed: Claude lists with job_list and run_list'), studio: STUDIO },
  { name: 'search', kind: 'read', cli: no('the workspace index is the Studio\'s cache: `retake list` lists projects and scenarios'), mcp: no("the workspace index is the Studio's cache for its search: Claude lists with project_list and run_list"), studio: STUDIO },
  { name: 'projects_overview', kind: 'read', cli: SCREEN_READ, mcp: no('the Projects screen\'s cards in one call: Claude reads project_list and project_get'), studio: STUDIO },
  { name: 'project_board', kind: 'read', cli: SCREEN_READ, mcp: no("the Project screen's board: Claude reads project_get, run_list and render_status"), studio: STUDIO },
  { name: 'scenario_blocks', kind: 'read', cli: SCREEN_READ, mcp: no('the scenario screen\'s blocks: Claude reads scenario_get and scenario_validate'), studio: STUDIO },
  { name: 'scenario_actions', kind: 'read', cli: SCREEN_READ, mcp: no("the scenario screen's status bar: Claude's run tools say what stops them"), studio: STUDIO },
  { name: 'run_thumbs', kind: 'read', cli: SCREEN_READ, mcp: no('thumbnails for the scenario screen: Claude reads the screenshots run_status names'), studio: STUDIO },
  { name: 'scenario_forms', kind: 'read', cli: SCREEN_READ, mcp: no("the inspector's and the palette's forms: Claude writes the YAML"), studio: STUDIO },
  { name: 'scenario_run', kind: 'job', cli: ['run'], mcp: no('Claude runs run_dry and run_capture'), studio: STUDIO },
  { name: 'scenario_edit', kind: 'write', cli: no('a person edits scenarios/<name>.yaml'), mcp: no('Claude saves a scenario with scenario_save (if_match)'), studio: STUDIO },
  { name: 'run_pause', kind: 'write', cli: no('`retake run` films in the foreground: no pause'), mcp: no("a pause is the person's, on the Run screen"), studio: STUDIO },
  { name: 'scenario_sessions', kind: 'read', cli: no('`retake auth status` lists the sessions'), mcp: no('Claude reads the sessions with auth_status'), studio: STUDIO },
  { name: 'sign_in_cancel', kind: 'write', cli: no('`retake jobs cancel` stops a job'), mcp: no('Claude cancels a job with job_cancel'), studio: STUDIO },
  { name: 'timeline_view', kind: 'read', cli: no('`retake plan` prints the plan of a capture'), mcp: no('the timeline screen with its preview frame: Claude reads the plan with plan_preview'), studio: STUDIO },
  { name: 'timeline_leave', kind: 'write', cli: PREVIEW_FRAME, mcp: PREVIEW_FRAME, studio: STUDIO },
  { name: 'preview_allow', kind: 'write', cli: PREVIEW_FRAME, mcp: no('only the person allows a workspace component to run in the Studio\'s preview'), studio: STUDIO },
  { name: 'scenario_render', kind: 'job', cli: ['render'], mcp: no('Claude renders with render, then review'), studio: STUDIO },
  { name: 'scenario_renders', kind: 'read', cli: no('renders/ holds them; `retake jobs list` lists the queue'), mcp: no('Claude follows a render with render_status'), studio: STUDIO },
  { name: 'render_cancel', kind: 'write', cli: no('`retake jobs cancel` stops a job'), mcp: no('Claude cancels a job with job_cancel'), studio: STUDIO },
  { name: 'render_review', kind: 'read', cli: no('`retake review` prints the verdict; review/<render>/ holds the report'), mcp: no('Claude reads a review with review_get'), studio: STUDIO },
  { name: 'review_image', kind: 'read', cli: no('review/<render>/ holds the contact sheets'), mcp: no('review_get returns the contact sheets as images'), studio: STUDIO },
  { name: 'review_export', kind: 'job', cli: ['export'], mcp: no('Claude exports with export'), studio: STUDIO },
  { name: 'threads_list', kind: 'read', cli: ['comment list'], mcp: no('Claude reads threads with comments_list'), studio: STUDIO },
  { name: 'threads_counts', kind: 'read', cli: THREAD_CLI_READ, mcp: no('Claude reads threads with comments_list'), studio: STUDIO },
  { name: 'thread_get', kind: 'read', cli: THREAD_CLI_READ, mcp: no('Claude reads a thread with comments_list {comment_id}'), studio: STUDIO },
  { name: 'thread_still', kind: 'read', cli: THREAD_CLI_READ, mcp: no("comments_list returns each thread's still"), studio: STUDIO },
  { name: 'render_outline', kind: 'read', cli: SCREEN_READ, mcp: no('the comment screen\'s outline of a render: Claude reads render_status and comments_list'), studio: STUDIO },
  { name: 'render_frame', kind: 'read', cli: no('`retake still` renders one frame of the planned video'), mcp: no("the comment screen's frames: Claude reads review_get's key frames"), studio: { status: { busy: 429 } } },
  { name: 'frame_anchor', kind: 'read', cli: no('`retake comment add` stores the anchor it computes'), mcp: no("comments_list returns each thread's anchor"), studio: STUDIO },
  { name: 'thread_add', kind: 'write', cli: ['comment add'], mcp: no('only people create threads: in the Studio or with `retake comment add`'), studio: STUDIO },
  { name: 'thread_reply', kind: 'write', cli: ['comment reply'], mcp: no('Claude replies with comment_reply'), studio: STUDIO },
  { name: 'thread_resolve', kind: 'write', cli: ['comment resolve'], mcp: no('Claude resolves with comment_resolve'), studio: STUDIO },
  { name: 'thread_reopen', kind: 'write', cli: ['comment reopen'], mcp: no('only people reopen threads: in the Studio or with `retake comment reopen`'), studio: STUDIO },
  { name: 'thread_apply', kind: 'write', cli: no("a proposal is applied by the person in the Studio, where it is previewed"), mcp: no("only the person applies Claude's proposal, in the Studio"), studio: STUDIO },
  { name: 'library_view', kind: 'read', cli: no('`retake components list` lists the components'), mcp: LIBRARY_MCP, studio: STUDIO },
  { name: 'library_images', kind: 'read', cli: no("a component's folder holds its preview.png"), mcp: LIBRARY_MCP, studio: STUDIO },
  { name: 'library_render', kind: 'job', cli: no('`retake components preview` renders previews'), mcp: LIBRARY_MCP, studio: STUDIO },
  { name: 'library_component', kind: 'read', cli: no("a component's folder holds its manifest and README"), mcp: LIBRARY_MCP, studio: STUDIO },
  { name: 'theme_list', kind: 'read', cli: no('`retake list` lists the themes'), mcp: no('Claude lists themes with template_list'), studio: STUDIO },
  { name: 'theme_view', kind: 'read', cli: no('a person reads templates/<name>/template.yaml'), mcp: no('Claude reads themes with template_list'), studio: STUDIO },
  { name: 'theme_edit', kind: 'write', cli: no('a person edits templates/<name>/template.yaml'), mcp: THEME_EDIT_MCP, studio: STUDIO },
  { name: 'theme_copy', kind: 'write', cli: no('a person copies a theme folder'), mcp: THEME_EDIT_MCP, studio: STUDIO },
  { name: 'theme_create', kind: 'write', cli: ['theme create'], mcp: no('Claude makes a new theme with template_create_from_brand'), studio: STUDIO },
  { name: 'brand_files', kind: 'read', cli: no('a person names the files to `retake theme create`'), mcp: no("Claude asks the user for the brand's files"), studio: STUDIO },
  { name: 'site_list', kind: 'read', cli: no('`retake theme from-site` prints what it extracted'), mcp: no('Claude reads an extraction from template_from_site\'s job'), studio: STUDIO },
  { name: 'theme_preview', kind: 'read', cli: PREVIEW_FRAME, mcp: no('Claude previews a theme with template_preview (stills)'), studio: STUDIO },
  { name: 'record_options', kind: 'read', cli: RECORD_CLI, mcp: RECORD_PANEL, studio: STUDIO },
  { name: 'record_start', kind: 'job', cli: ['record'], mcp: RECORD_PANEL, studio: STUDIO },
  { name: 'record_view', kind: 'read', cli: RECORD_CLI, mcp: RECORD_PANEL, studio: STUDIO },
  { name: 'record_annotate', kind: 'write', cli: RECORD_CLI, mcp: RECORD_PANEL, studio: STUDIO },
  { name: 'record_stop', kind: 'write', cli: RECORD_CLI, mcp: RECORD_PANEL, studio: STUDIO },
  { name: 'record_discard', kind: 'destructive', cli: RECORD_CLI, mcp: RECORD_PANEL, studio: STUDIO },
  { name: 'record_save', kind: 'write', cli: RECORD_CLI, mcp: RECORD_PANEL, studio: STUDIO },
  { name: 'unsaved_report', kind: 'write', cli: DESKTOP_ONLY, mcp: DESKTOP_ONLY, studio: STUDIO },
  { name: 'desktop_answer', kind: 'write', cli: DESKTOP_ONLY, mcp: DESKTOP_ONLY, studio: STUDIO },
  { name: 'setup_status', kind: 'read', cli: no('`retake doctor` checks this machine'), mcp: SETUP_ONLY, studio: STUDIO },
  { name: 'setup_cli_install', kind: 'write', cli: SETUP_ONLY, mcp: SETUP_ONLY, studio: STUDIO },
  { name: 'setup_cli_choose', kind: 'write', cli: SETUP_ONLY, mcp: SETUP_ONLY, studio: STUDIO },
  { name: 'setup_cli_remove', kind: 'destructive', cli: SETUP_ONLY, mcp: SETUP_ONLY, studio: STUDIO },
  { name: 'setup_claude_code_run', kind: 'runs_code', cli: no('`retake mcp --print-config` prints the registration a person runs'), mcp: SETUP_ONLY, studio: STUDIO },
  { name: 'setup_claude_desktop_add', kind: 'write', cli: no('`retake mcp --print-config` prints the entry a person adds'), mcp: SETUP_ONLY, studio: STUDIO },
  { name: 'setup_notifications', kind: 'write', cli: SETUP_ONLY, mcp: SETUP_ONLY, studio: STUDIO },
  { name: 'setup_done', kind: 'write', cli: SETUP_ONLY, mcp: SETUP_ONLY, studio: STUDIO },
  { name: 'desktop_update_status', kind: 'read', cli: DESKTOP_ONLY, mcp: DESKTOP_ONLY, studio: STUDIO },
  { name: 'desktop_update', kind: 'write', cli: DESKTOP_ONLY, mcp: DESKTOP_ONLY, studio: STUDIO },

  // The CLI's own commands.
  { name: 'workspace_init', kind: 'write', cli: ['init'], mcp: TERMINAL_ONLY_MCP, studio: TERMINAL_ONLY_STUDIO },
  { name: 'raw_export', kind: 'job', cli: ['export-capture'], mcp: no('a raw package is for another editing tool: a person exports it in a terminal'), studio: TERMINAL_ONLY_STUDIO },
  { name: 'still', kind: 'job', cli: ['still'], mcp: no('Claude sees frames through review_get and template_preview'), studio: no('the comment screen shows frames of a render (render_frame)') },
  { name: 'hooks_rollback', kind: 'runs_code', cli: ['hooks rollback'], mcp: no('env_reset replays pending rollbacks first'), studio: NO_HOOKS_IN_STUDIO },
  { name: 'sandbox_init', kind: 'write', cli: ['sandbox init'], mcp: no("sandbox.yaml is the person's file, never written through MCP"), studio: NO_SANDBOX_IN_STUDIO },
  { name: 'sandbox_down', kind: 'runs_code', cli: ['sandbox down'], mcp: no('Claude starts and resets a sandbox; a person stops it'), studio: NO_SANDBOX_IN_STUDIO },
  { name: 'sandbox_logs', kind: 'read', cli: ['sandbox logs'], mcp: no("sandbox_status says a sandbox's state; its logs are read in a terminal"), studio: NO_SANDBOX_IN_STUDIO },
  { name: 'doctor', kind: 'read', cli: ['doctor'], mcp: no("engine_info says what Claude needs; the machine's checks are the person's"), studio: no("the Set-up sheet shows the installed app's state (setup_status)") },
  { name: 'schema_print', kind: 'read', cli: ['schema'], mcp: no('each tool publishes its input schema; scenario_validate checks a scenario'), studio: no('the scenario screen\'s forms come from the same schemas (scenario_forms)') },
  { name: 'mcp_serve', kind: 'write', cli: ['mcp'], mcp: no('the MCP server itself'), studio: no('the Set-up sheet registers it with Claude (setup_claude_code_run, setup_claude_desktop_add)') },
  { name: 'studio_serve', kind: 'write', cli: ['ui'], mcp: no('the Studio is the person\'s: Claude never opens it or calls its routes'), studio: no('the Studio\'s server itself') },
  { name: 'worker_run', kind: 'runs_code', cli: ['worker'], mcp: no('the MCP server starts the worker in the background'), studio: no('the Studio starts the worker in the background') },
];

/** Whether a shell serves an operation. */
export function servedBy(op: Operation, shell: Shell): boolean {
  const s = op[shell];
  if (shell === 'cli') return Array.isArray(s);
  return s === true || (typeof s === 'object' && !('why' in s));
}

/** The names of the operations a shell serves, in catalogue order. */
export function servedNames(shell: Shell): string[] {
  return CATALOGUE.filter((o) => servedBy(o, shell)).map((o) => o.name);
}

/** Every command path the catalogue names (each once, in catalogue order). */
export function cliCommandsOf(ops: readonly Operation[] = CATALOGUE): string[] {
  return [...new Set(ops.flatMap((o) => (Array.isArray(o.cli) ? (o.cli as readonly string[]) : [])))];
}

/** The operation of that name, or undefined. */
export function catalogueOperation(name: string): Operation | undefined {
  return CATALOGUE.find((o) => o.name === name);
}

function studioServe(name: string): StudioServe | undefined {
  const op = catalogueOperation(name);
  return op && servedBy(op, 'studio') ? (op.studio as StudioServe) : undefined;
}

/** The arguments the Studio pins on an operation (none: it serves it as it is). */
export function studioPins(name: string): readonly ArgumentPin[] {
  return studioServe(name)?.pins ?? [];
}

/** The Studio's own HTTP status of an operation for an engine error code, if it has one. */
export function studioStatus(name: string, code: EngineErrorCode): number | undefined {
  return studioServe(name)?.status?.[code];
}
