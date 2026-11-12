/**
 * Who drives the engine, and every decision the engine takes from it — one policy module. A caller is its client (the
 * process that opened the engine: `cli` — a `retake` command —, `mcp` — the MCP server —, `ui` — the Studio's server —,
 * `test`), the channel it speaks through (`cli`, `studio`, `mcp`: the wording of a refusal, the author of a comment) and
 * the trust its work gets (`author`: a person at a terminal, whose files' trust flags count; `mcp`: an agent or a page,
 * whose they do not). The vocabularies of the layers below are this one caller seen from there:
 *
 * - `EngineClient` (here) is `JobClient` (jobs/job-input.ts; core's until L7.35): the `submitted_by` of a job; what
 *   is decided from a job's submitter (its refusals' wording `submitterChannel`, a Studio recording
 *   `submittedInStudio`) is decided here too.
 * - `AgentChannel` (here; core's until L7.35) is the channel of a caller that is not the CLI's (the CLI's refusals are
 *   worded as MCP's). Core and the adapters are handed its words only, as a `Confinement` (`confinementOf`): the domain
 *   names no channel (audit 2026-11-10 D6).
 * - `CallerTrust` is defined here; core's `HookTrust`, the editor's `PlanTrust` and the brand files' `BrandTrust` are
 *   held to it. The engine holds every job and a theme made from a brand to `mcp` whoever calls it (ENGINE_TRUST, used
 *   by every job module): a queued job is never a person at a terminal.
 * - the `agent?: boolean` options of the engine's reads and writes are `agentChecks(caller)`.
 *
 * `test` is the engine's tests: the agent's channel and trust, but neither the agent's checks of a scenario nor the
 * admission rules, and it may drive the Studio's Record screen (tests drive every screen).
 */
import { AGENT_CONFINEMENT } from '@retake/core/model';
import type { Confinement } from '@retake/core/model';
import type { HookTrust } from '@retake/core/hooks';
import type { CommentVia } from '@retake/core/comments';
import type { JobClient } from './jobs/job-input.js';
import type { PlanTrust } from '@retake/editor';

/** Who drives the engine: recorded with what it starts (a job's `submitted_by`). */
export type EngineClient = JobClient;
/**
 * The channel agent work comes through, for the wording of a refusal: `mcp` (the MCP server: "through MCP"), `studio`
 * (the Studio web app, L4.2: "from the Studio"). The rules are the same. Handed down as its `Confinement`.
 */
export type AgentChannel = 'mcp' | 'studio';

/**
 * The words of each channel's refusals (core Confinement): the MCP server's are core's AGENT_CONFINEMENT (what core
 * says when no confinement is given); the Studio's name no MCP tool and say it cannot approve hooks yet.
 */
export const CONFINEMENTS: Readonly<Record<AgentChannel, Confinement>> = Object.freeze({
  mcp: AGENT_CONFINEMENT,
  studio: Object.freeze({ words: 'from the Studio', approval: ' and the Studio cannot approve hooks yet — run it in a terminal' }),
});

/** The confinement core and the adapters are handed for a channel's work. */
export function confinementOf(channel: AgentChannel): Confinement {
  return CONFINEMENTS[channel];
}

/** The channel a caller speaks through: a comment's `author.via`. */
export type CallerChannel = CommentVia;
/**
 * The trust a caller's work gets: `author` (a person at a terminal) or `mcp` (an agent or a page). Defined here; core's
 * `HookTrust`, the editor's `PlanTrust` and the brand files' `BrandTrust` are held to it.
 */
export type CallerTrust = 'author' | 'mcp';

export interface Caller {
  readonly client: EngineClient;
  readonly channel: CallerChannel;
  readonly trust: CallerTrust;
}

// The vocabularies below agree with the caller's (checked when this file compiles).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const VOCABULARIES_AGREE: Same<HookTrust, CallerTrust> & Same<PlanTrust, CallerTrust> & Same<AgentChannel, Exclude<CallerChannel, 'cli'>> = true;
void VOCABULARIES_AGREE;

/**
 * The caller of a client: the CLI is a person at a terminal (`author`), the Studio a page (`studio`), every other an
 * agent. Frozen (L7.13 review): the engine hands this one object to its operations, its store scope and its worker's
 * environment, so nobody may change who drives it.
 */
export function callerOf(client: EngineClient): Caller {
  return Object.freeze({ client, channel: client === 'cli' ? 'cli' : client === 'ui' ? 'studio' : 'mcp', trust: client === 'cli' ? 'author' : 'mcp' });
}

/**
 * The trust the engine holds what it queues or writes from a brand to, whoever calls it: every job (hooks, plans,
 * exports in the worker) and a theme made from a brand (engine templates.create). A person's own `retake` commands,
 * which do not go through the engine, run as `author`.
 */
export const ENGINE_TRUST = 'mcp' as const satisfies CallerTrust;

/**
 * The agent's checks (core agent-trust) of what a caller validates, saves, edits, views and submits: every caller whose
 * trust is `mcp` (the MCP server, the Studio), the engine's tests excepted. The `agent?: boolean` options.
 */
export function agentChecks(c: Caller): boolean {
  return c.trust === 'mcp' && c.client !== 'test';
}

/** The process-wide agent policy of the workspace (openWorkspace `agent`): every caller but a person at a terminal. */
export function agentWorkspace(c: Caller): boolean {
  return c.trust === 'mcp';
}

/** The wording channel of a caller's refusals: "from the Studio", else "through MCP" (the CLI's included). */
export function refusalChannel(c: Caller): AgentChannel {
  return c.channel === 'studio' ? 'studio' : 'mcp';
}

/** The wording channel of a job's refusals, by who submitted it (refusalChannel of its caller; unknown: MCP's). */
export function submitterChannel(by: EngineClient | undefined): AgentChannel {
  return by === undefined ? 'mcp' : refusalChannel(callerOf(by));
}

/** A person channel (a terminal, the Studio) creates and reopens threads and applies proposals; an agent replies. */
export function speaksAsPerson(c: Caller): boolean {
  return c.channel !== 'mcp';
}

/** Every caller but the CLI acts on the version of a thread it read (`if_match`). */
export function needsIfMatch(c: Caller): boolean {
  return c.channel !== 'cli';
}

/** Only an agent channel's reply may carry a proposal (the MCP server; tests). */
export function proposes(c: Caller): boolean {
  return c.channel === 'mcp';
}

/** The Studio adds a thread on the version of the render it showed (`render_created_at`). */
export function anchorsOnShownRender(c: Caller): boolean {
  return c.channel === 'studio';
}

/** The Record screen's operations (arrange, annotate, stop, discard, save a recording): the Studio's, and tests'. */
export function drivesRecordScreen(c: Caller): boolean {
  return c.channel === 'studio' || c.client === 'test';
}

/** The Studio's recordings start one at a time in its server (they share one window). */
export function chainsRecordings(c: Caller): boolean {
  return c.channel === 'studio';
}

/** A worker this caller starts gets a clean environment (unless the caller hands it one): every caller but the CLI. */
export function cleansWorkerEnv(c: Caller): boolean {
  return c.trust === 'mcp';
}

/** The MCP client never cancels a recording the person started in the Studio while it is open (it would discard it). */
export function guardsStudioRecordings(c: Caller): boolean {
  return c.client === 'mcp';
}

/** Themes are never edited through MCP: a person edits them in the Studio or by hand. */
export function editsThemes(c: Caller): boolean {
  return c.client !== 'mcp';
}

/**
 * The engine's admission rules (admission.ts: one run and one render of a scenario at a time, the sessions
 * acknowledgement of a capture, the export cap) hold for the Studio and MCP. A person's `retake` commands run in their
 * own process and queue nothing; the engine's tests submit freely.
 */
export function admits(c: Caller): boolean {
  return c.client === 'mcp' || c.client === 'ui';
}

/** A job submitted through the Studio (its recordings and runs are worded and settled as the Studio's). */
export function submittedInStudio(job: { input: { submitted_by: JobClient } } | { submitted_by?: JobClient }): boolean {
  const by = 'input' in job ? job.input.submitted_by : job.submitted_by;
  return by !== undefined && callerOf(by).channel === 'studio';
}
