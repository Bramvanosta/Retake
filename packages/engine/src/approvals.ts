/**
 * Human approvals of hooks for work submitted through MCP (L3.1, R-MCP-35). The agent that drives the MCP server can
 * write the scenario files it runs (scenario_save), so their trust flags do not count: `confirm: true` is ignored, every
 * shell hook and every destructive hook needs a human, and a shell hook always counts as writing (trust `mcp`).
 *
 * At submit, a preflight that executes nothing (a dry run of the hooks with trust `mcp`: templated, secrets as `***`,
 * security-checked) lists the hooks that need approval and the ones a safety rule refuses. The client's approver (MCP
 * elicitation) is asked once for the whole list; an accept becomes the job's `approvals`: fingerprints of the raw
 * hooks, written once with the job. The worker runs a hook that needs approval only when its fingerprint is listed.
 */
import { agentTrustProblems, channelWords, hookApprovalReason, hookKind, showHiddenCharsLine } from '@retake/core';
import type { AgentTrustEnvironment } from '@retake/core';
import type { AgentChannel, HookStep, JobApproval, JobClient, LoadedProject, Scenario } from '@retake/core';
import type { HookPhase, HookResult } from '@retake/hooks';
import { EngineError } from './errors.js';
import { createHookContext } from './hooks.js';
import { formatBytes } from './prune.js';
import type { PruneItem, PruneResult } from './prune.js';

/**
 * The wording channel of a client's refusals (L4.2, critique B2): the Studio (`ui`) is told "from the Studio" and to
 * run the command in a terminal, never that "this MCP client" cannot ask; every other client gets the MCP wording.
 */
export function agentChannel(client: JobClient | undefined): AgentChannel {
  return client === 'ui' ? 'studio' : 'mcp';
}

/** Why the client cannot ask its human, for a `needs_approval` refusal. */
function cannotAsk(client: JobClient | undefined): string {
  return agentChannel(client) === 'studio' ? 'The Studio cannot approve hooks yet: run it in a terminal' : 'This MCP client cannot ask its user (no elicitation support): a human runs it in a terminal';
}

/** One hook a human is asked to approve. */
export interface ApprovalItem {
  fingerprint: string;
  phase: HookPhase;
  index: number;
  name?: string;
  kind?: string;
  /** Templated (secrets as `***`): the request and its host, the command, the SQL and its database — and its rollback. */
  description: string;
  /** Its rollback (a setup hook's), templated: approving the hook approves it too (it runs later without asking). */
  rollback?: string;
  /** Why it needs a human: destructive (and why), a shell command, its rollback (destructive, shell or js). */
  reason: string;
  /**
   * What runs, in full: one line per field, templated (secrets as `***`, every hidden character written out), then its
   * rollback's (`rollback …`) — hooks shown.ts. The form shows these lines; the hook's name is in its heading only.
   */
  lines: string[];
}

/** The longest hook a form shows (its lines, in characters): a longer one is refused before anyone is asked. */
export const APPROVAL_HOOK_MAX_CHARS = 4_000;
/** The longest form (every hook's lines, the work and the command): a longer one is refused before anyone is asked. */
export const APPROVAL_FORM_MAX_CHARS = 16_000;

/** The heading of a hook in an approval: where it stands, its name, its kind. */
export function approvalItemTitle(i: Pick<ApprovalItem, 'phase' | 'index' | 'name' | 'kind'>): string {
  return `${i.phase} hook ${i.index + 1}${i.name ? ` "${showHiddenCharsLine(i.name)}"` : ''}${i.kind ? ` (${i.kind})` : ''}`;
}

/** A hook's text in a form (approvalFormText): its numbered heading with why it needs a human, then its lines. */
function itemText(i: ApprovalItem, n: number): string {
  return [`${n + 1}. ${approvalItemTitle(i)} — ${i.reason}`, ...i.lines.map((l) => `   ${l}`)].join('\n');
}

/**
 * The question a person reads before hooks run (the MCP form's message): what runs, where, and each hook in full — its
 * heading (where it stands, its name, its kind, why it needs them), then every field on a line of its own as it will run
 * (ApprovalItem.lines: templated, secrets as `***`, hidden characters written out), its rollback's too — and the
 * terminal path. Its length is what APPROVAL_FORM_MAX_CHARS limits.
 */
export function approvalFormText(req: ApprovalRequest): string {
  const env = `${req.env.name}${req.env.production ? ' (production)' : ''}, ${req.env.access}`;
  return [
    `Retake: the agent asks to run ${req.what} in project ${req.project}, environment ${env}.`,
    `${req.items.length === 1 ? 'This hook needs' : `These ${req.items.length} hooks need`} your approval before ${req.items.length === 1 ? 'it runs' : 'they run'} ("confirm: true" in a file written through MCP does not count). Each is shown in full, as it will run:`,
    ...req.items.map((i, n) => itemText(i, n)),
    'Approve to run them now (once, exactly as listed). Decline to refuse: nothing runs.',
    `Instead, you can run it yourself in a terminal: ${req.fix}`,
  ].join('\n');
}

/**
 * Why `req` cannot be put to a person in a form, or null: a hook's text over APPROVAL_HOOK_MAX_CHARS, or the whole form
 * (approvalFormText) over APPROVAL_FORM_MAX_CHARS — nobody reads that much before saying yes.
 */
function tooLongForAForm(req: ApprovalRequest): string | null {
  const n = (x: number) => x.toLocaleString('en-US');
  const long = req.items.flatMap((i, k) => (itemText(i, k).length > APPROVAL_HOOK_MAX_CHARS ? [{ i, length: itemText(i, k).length }] : []));
  if (long.length) {
    return long.map(({ i, length }) => `${approvalItemTitle(i)} is ${n(length)} characters long (a form shows at most ${n(APPROVAL_HOOK_MAX_CHARS)} per hook)`).join('; ');
  }
  const total = approvalFormText(req).length;
  return total > APPROVAL_FORM_MAX_CHARS ? `its ${req.items.length} hooks make a form of ${n(total)} characters (at most ${n(APPROVAL_FORM_MAX_CHARS)})` : null;
}

/** What a human is asked: the hooks, where they run, and the command a human can run in a terminal instead. */
export interface ApprovalRequest {
  /** "capture of scenario catalogue", "hooks reset", "environment reset". */
  what: string;
  project: string;
  env: { name: string; production: boolean; access: 'read-only' | 'read-write' };
  items: ApprovalItem[];
  /** The `retake` command a human runs for the same work. */
  fix: string;
}

export type ApprovalOutcome =
  | { approved: true }
  | { approved: false; reason: 'declined' | 'cancelled' | 'timeout' | 'error'; message?: string };

/**
 * What a human is asked before a site extraction (L3.5, R-MCP-12): open exactly this URL in a clean browser. `href` is
 * the canonical URL (percent-encoded path, punycode host) — what opens and what the approval's fingerprint covers;
 * `unicode_host` is the same host as a person reads it. The decoded path is never shown (agent text).
 */
export interface SiteApprovalRequest {
  what: 'site extraction';
  href: string;
  host: string;
  unicode_host: string;
  /** sha256("site\n" + href): the approval written with the job. */
  fingerprint: string;
  /** The `retake` command a human runs for the same extraction. */
  fix: string;
}

/** The lines of a prune form: the first items, one line each; the rest are counted in the totals. */
export const PRUNE_FORM_MAX_LINES = 20;

/**
 * What a human is asked before an agent's prune deletes anything: how many items, how much they weigh, by kind, the
 * first PRUNE_FORM_MAX_LINES items (`lines`) and how many more there are, and the `retake prune` command a human runs
 * instead.
 */
export interface PruneApprovalRequest {
  what: 'prune';
  project: string;
  keep_renders: number;
  count: number;
  bytes: number;
  by_kind: Array<{ kind: PruneItem['kind']; count: number; bytes: number }>;
  /** "take 20261020-110000-quote — failed take, 12 MB": every character visible. */
  lines: string[];
  /** Items the lines leave out (in the totals). */
  more: number;
  /** The `retake prune … --yes` command a human runs for the same deletion. */
  fix: string;
}

/** How a client asks its human (MCP: elicitation). Absent: the client cannot ask anyone. */
export interface Approver {
  approve(req: ApprovalRequest): Promise<ApprovalOutcome>;
  /** A site extraction's URL (absent: this client cannot ask about one — refused like no approver). */
  approveSite?(req: SiteApprovalRequest): Promise<ApprovalOutcome>;
  /** An agent's prune (absent: this client cannot ask about one — refused like no approver). */
  approvePrune?(req: PruneApprovalRequest): Promise<ApprovalOutcome>;
}

export interface Preflight {
  env: ApprovalRequest['env'];
  items: ApprovalItem[];
  /** Hooks a safety rule refuses whatever a human says (read-only environment, hosts outside the allow-list). */
  refused: Array<{ phase: HookPhase; index: number; name?: string; description: string; error: string }>;
}

/** Why a hook needs a human, from its file alone (the preflight's backstop when its dry run could not template it). */
function staticReason(hook: HookStep, project: LoadedProject, phase: HookPhase): string | null {
  return hookApprovalReason(hook, phase, { projectDir: project.dir });
}

/**
 * Dry-run `lists` with trust `mcp` and collect what needs a human and what is refused. Executes nothing, opens no
 * browser, reads no keychain item.
 */
export async function preflightHooks(
  project: LoadedProject,
  lists: ReadonlyArray<{ phase: HookPhase; hooks: readonly HookStep[]; agentWritten?: boolean }>,
  o: { env?: string; vars?: Record<string, string>; scenario?: Scenario; journalFile: string; via?: AgentChannel },
): Promise<Preflight> {
  const { runHooks, Journal, hookFingerprint, hookFiles, describeHook, describeRollback, declaredHookLines } = await import('@retake/hooks');
  const { ctx, access } = await createHookContext(project, {
    env: o.env,
    dry: true,
    trust: 'mcp',
    ...(o.via ? { via: o.via } : {}),
    ...(o.vars ? { vars: o.vars } : {}),
    ...(o.scenario ? { scenario: o.scenario } : {}),
    log: () => undefined,
    loginCommand: (p) => `retake login ${p.project}`,
  });
  // A dry run journals nothing: the journal is never written.
  const journal = await Journal.open(o.journalFile);
  const items: ApprovalItem[] = [];
  const refused: Preflight['refused'] = [];
  for (const { phase, hooks, agentWritten } of lists) {
    if (!hooks.length) continue;
    const { results } = await runHooks([...hooks], ctx, { phase, journal, ...(agentWritten ? { agentWritten } : {}) });
    const byIndex = new Map<number, HookResult>(results.map((r) => [r.index, r]));
    hooks.forEach((hook, index) => {
      const r = byIndex.get(index);
      if (r?.status === 'refused') {
        refused.push({ phase, index, ...(hook.name ? { name: hook.name } : {}), description: r.description, error: r.error ?? 'refused' });
        return;
      }
      const reason = r?.approval?.reason ?? (phase === 'seed' ? null : staticReason(hook, project, phase));
      if (!reason) return;
      const description = r?.status === 'dry' ? r.description : describeHook(hook);
      // Its rollback as the dry run templated it, else as its file declares it (a setup hook's only).
      const rollback = r?.status === 'dry' ? r.rollback : phase === 'setup' ? describeRollback(hook) : undefined;
      items.push({
        fingerprint: r?.approval?.fingerprint ?? hookFingerprint(hook, { phase, index, env: ctx.env.name, files: hookFiles(hook, { projectDir: project.dir }).files }),
        phase,
        index,
        ...(hook.name ? { name: hook.name } : {}),
        ...(r?.kind ? { kind: r.kind } : {}),
        description: rollback ? `${description}; rollback: ${rollback}` : description,
        ...(rollback ? { rollback } : {}),
        reason,
        lines: r?.status === 'dry' && r.shown ? r.shown : declaredHookLines(hook, { rollback: phase === 'setup' || phase === 'step' }),
      });
    });
  }
  return { env: { name: ctx.env.name, production: access.production === true, access: access.mode }, items, refused };
}

/** Why a shell seed step needs a human (trust `mcp`). */
export const SHELL_SEED_REASON = 'a shell command (runs local code)';

/**
 * The seed steps of a sandbox that need a human before a job may run them (trust `mcp`): its shell steps, each bound
 * to its fingerprint (phase `seed`, its position among all the seed steps, the sandbox's environment). A seed's http and
 * sql steps rebuild the sandbox's own data (checked at run time) and an `exec` step runs inside a sandbox container:
 * none of them is asked about.
 */
export async function seedApprovalItems(project: LoadedProject, env: string): Promise<ApprovalItem[]> {
  const { hookFingerprint, hookFiles, describeHook, declaredHookLines } = await import('@retake/hooks');
  const sandbox = project.sandboxes?.[env];
  const steps = sandbox?.manifest.seed ?? [];
  const items: ApprovalItem[] = [];
  steps.forEach((step, index) => {
    if ('exec' in step) return;
    let kind: string;
    try {
      kind = hookKind(step);
    } catch {
      return; // malformed: the seed itself fails on it
    }
    if (kind !== 'shell') return;
    items.push({
      fingerprint: hookFingerprint(step, { phase: 'seed', index, env, files: hookFiles(step, { projectDir: project.dir, ...(sandbox?.dir ? { baseDir: sandbox.dir } : {}) }).files }),
      phase: 'seed',
      index,
      ...(step.name ? { name: step.name } : {}),
      kind,
      description: describeHook(step),
      reason: SHELL_SEED_REASON,
      // As sandbox.yaml declares it (a seed step journals no rollback).
      lines: declaredHookLines(step),
    });
  });
  return items;
}

/**
 * Work submitted through MCP or from the Studio (core agent-trust): a scenario that names a secret or references a file
 * outside the project (or, run as code, one an agent can write) is refused before anything is queued — the worker
 * checks it again. With the environment the job opens (`env`), a URL the scenario opens on another origin than the
 * environment's pages is refused too.
 */
export function checkAgentTrust(project: LoadedProject, sc: Scenario, fix: string, client?: JobClient, env?: AgentTrustEnvironment): void {
  const via = agentChannel(client);
  const problems = agentTrustProblems(project, sc, { via, ...(env ? { env } : {}) });
  if (problems.length) {
    throw new EngineError('refused', `refused ${channelWords(via)}: ${problems.join('; ')}`, { fix, details: { problems } });
  }
}

/** The refusal of a preflight that found hooks a safety rule refuses. */
export function refusedError(p: Preflight, fix: string): EngineError {
  const list = p.refused.map((r) => `${r.phase} hook ${r.index + 1}${r.name ? ` "${r.name}"` : ''}: ${r.error}`).join('; ');
  return new EngineError('refused', `refused before anything runs on environment ${p.env.name}${p.env.production ? ' (production)' : ''}: ${list}`, {
    fix,
    details: { refused: p.refused, env: p.env },
  });
}

function listItems(items: readonly ApprovalItem[]): string {
  return items.map((i) => `${i.phase} hook ${i.index + 1}${i.name ? ` "${i.name}"` : ''} (${i.reason})`).join(', ');
}

/**
 * Ask the client's human to approve `req.items` (none: nothing to ask). Returns the approvals to write with the job;
 * throws `needs_approval` when the client cannot ask anyone, `refused` when the human declined, did not answer in time
 * or the question failed — each with the `retake` command a human runs in a terminal instead. `client` words the
 * refusal for its channel (agentChannel).
 */
export async function takeApprovals(req: ApprovalRequest, approver: Approver | undefined, client?: JobClient): Promise<JobApproval[]> {
  if (!req.items.length) return [];
  const details = { hooks: req.items.map(({ fingerprint: _f, ...rest }) => rest), env: req.env };
  const long = tooLongForAForm(req);
  if (long) {
    throw new EngineError('refused', `${req.what} was not started: ${long} — too long to approve in a form: run it in a terminal`, { fix: req.fix, details: { ...details, too_long: true } });
  }
  if (!approver) {
    throw new EngineError(
      'needs_approval',
      `${req.what} has hooks a human must approve before they run: ${listItems(req.items)}. ${cannotAsk(client)}`,
      { fix: req.fix, details },
    );
  }
  let outcome: ApprovalOutcome;
  try {
    outcome = await approver.approve(req);
  } catch (e) {
    outcome = { approved: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  if (!outcome.approved) {
    const why =
      outcome.reason === 'declined'
        ? 'the user declined'
        : outcome.reason === 'cancelled'
          ? 'the user dismissed the question'
          : outcome.reason === 'timeout'
            ? 'the user did not answer in time'
            : `the question failed${outcome.message ? ` (${outcome.message})` : ''}`;
    throw new EngineError('refused', `${req.what} was not started: ${why} — hooks needing approval: ${listItems(req.items)}. Do not retry on your own: ask the user, or let them run it in a terminal`, {
      fix: req.fix,
      details: { ...details, outcome: outcome.reason },
    });
  }
  const at = new Date().toISOString();
  return req.items.map((i) => ({ fingerprint: i.fingerprint, by: 'human-elicitation' as const, at }));
}

function outcomeText(outcome: Exclude<ApprovalOutcome, { approved: true }>): string {
  return outcome.reason === 'declined'
    ? 'the user declined'
    : outcome.reason === 'cancelled'
      ? 'the user dismissed the question'
      : outcome.reason === 'timeout'
        ? 'the user did not answer in time'
        : `the question failed${outcome.message ? ` (${outcome.message})` : ''}`;
}

/**
 * Ask the client's human to approve opening one site URL. Returns the approval to write with the job; throws
 * `needs_approval` when the client cannot ask anyone, `refused` when the human declined, did not answer in time or the
 * question failed — each with the `retake theme from-site` command a human runs in a terminal instead.
 */
export async function takeSiteApproval(req: SiteApprovalRequest, approver: Approver | undefined, client?: JobClient): Promise<JobApproval[]> {
  const details = { url: req.href, host: req.host };
  if (!approver?.approveSite) {
    throw new EngineError(
      'needs_approval',
      `opening ${req.href} needs a human's approval of that exact URL, and ${agentChannel(client) === 'studio' ? 'the Studio cannot approve it yet: run it in a terminal' : 'this MCP client cannot ask its user (no elicitation support): a human runs it in a terminal'}`,
      { fix: req.fix, details },
    );
  }
  let outcome: ApprovalOutcome;
  try {
    outcome = await approver.approveSite(req);
  } catch (e) {
    outcome = { approved: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  if (!outcome.approved) {
    throw new EngineError('refused', `the site extraction of ${req.href} was not started: ${outcomeText(outcome)}. Do not retry on your own: ask the user, or let them run it in a terminal`, {
      fix: req.fix,
      details: { ...details, outcome: outcome.reason },
    });
  }
  return [{ fingerprint: req.fingerprint, by: 'human-elicitation', at: new Date().toISOString() }];
}

/** The worker's approver: a hook runs only when its fingerprint was approved at submit. */
export function approvalChecker(approvals: readonly JobApproval[] | undefined): (description: string, reason: string, request: { fingerprint: string }) => boolean {
  const approved = new Set((approvals ?? []).map((a) => a.fingerprint));
  return (_description, _reason, request) => approved.has(request.fingerprint);
}

const PRUNE_KIND_WORDS: Record<PruneItem['kind'], [string, string]> = { run: ['take', 'takes'], render: ['render', 'renders'], review: ['review', 'reviews'] };

/** A name as a person reads it in a form: every hidden character written out, a line break too. */
const visibleName = showHiddenCharsLine;

/** The question of an agent's prune, from the dry run it would delete (`listed`) and the command a human runs. */
export function pruneApprovalRequest(listed: PruneResult, fix: string): PruneApprovalRequest {
  const by_kind = (['run', 'render', 'review'] as const)
    .map((kind) => {
      const of = listed.items.filter((i) => i.kind === kind);
      return { kind, count: of.length, bytes: of.reduce((n, i) => n + i.bytes, 0) };
    })
    .filter((k) => k.count > 0);
  const lines = listed.items.slice(0, PRUNE_FORM_MAX_LINES).map((i) => `${PRUNE_KIND_WORDS[i.kind][0]} ${visibleName(i.id)} — ${i.reason}, ${formatBytes(i.bytes)}`);
  return { what: 'prune', project: listed.project, keep_renders: listed.keep_renders, count: listed.items.length, bytes: listed.bytes, by_kind, lines, more: Math.max(0, listed.items.length - PRUNE_FORM_MAX_LINES), fix };
}

/**
 * The question a person reads before an agent's prune (the MCP form's message): how many items of which project, how
 * much they free, by kind, the first items (PRUNE_FORM_MAX_LINES, every character visible) and how many more — all of
 * them go when approved — and the terminal command. Its length is what APPROVAL_FORM_MAX_CHARS limits.
 */
export function pruneApprovalFormText(req: PruneApprovalRequest): string {
  const items = `${req.count} item${req.count === 1 ? '' : 's'}`;
  return [
    `Retake: the agent asks to delete ${items} from project ${req.project}'s runs/, renders/ and review/, freeing ${formatBytes(req.bytes)}: ${pruneKindsText(req)}.`,
    `Kept: the last good take of each scenario, the last ${req.keep_renders} renders of each scenario and variant, whatever a kept render, a comment thread or a queued or running job uses; exports/ is not touched.`,
    req.more ? `The first ${req.lines.length} of the ${items}:` : `${req.count === 1 ? 'It' : 'They'}:`,
    ...req.lines.map((l) => `- ${l}`),
    ...(req.more ? [`… and ${req.more} more, not listed here (counted in the totals above).`] : []),
    `Approve to delete ${req.count === 1 ? 'it' : `all ${items}`} now${req.more ? ` — the ${req.lines.length} listed and the ${req.more} more` : ''}: only ${req.count === 1 ? 'this item' : 'these'}, as they are now, and only if nothing uses ${req.count === 1 ? 'it' : 'them'} by then. Decline to refuse: nothing is deleted.`,
    `Instead, you can run it yourself in a terminal: ${req.fix}`,
  ].join('\n');
}

/** "3 takes (40 MB), 2 renders (12 MB)". */
export function pruneKindsText(req: Pick<PruneApprovalRequest, 'by_kind'>): string {
  return req.by_kind.map((k) => `${k.count} ${PRUNE_KIND_WORDS[k.kind][k.count === 1 ? 0 : 1]} (${formatBytes(k.bytes)})`).join(', ');
}

/**
 * Ask the client's human to approve an agent's prune. Returns when they approved; throws `needs_approval` when the
 * client cannot ask anyone, `refused` when the human declined, did not answer in time or the question failed (or the
 * form would be too long to read) — each with the `retake prune … --yes` command a human runs in a terminal instead.
 * Nothing is deleted before it returns.
 */
export async function takePruneApproval(req: PruneApprovalRequest, approver: Approver | undefined, client?: JobClient): Promise<void> {
  const what = `deleting ${req.count} item${req.count === 1 ? '' : 's'} of ${req.project} (${formatBytes(req.bytes)}: ${pruneKindsText(req)})`;
  const details = { count: req.count, bytes: req.bytes, by_kind: req.by_kind };
  const size = pruneApprovalFormText(req).length;
  if (size > APPROVAL_FORM_MAX_CHARS) {
    throw new EngineError('refused', `nothing was deleted: the list of ${what} makes a form of ${size.toLocaleString('en-US')} characters (at most ${APPROVAL_FORM_MAX_CHARS.toLocaleString('en-US')}) — too long to approve in a form: run it in a terminal`, { fix: req.fix, details: { ...details, too_long: true } });
  }
  if (!approver?.approvePrune) {
    throw new EngineError(
      'needs_approval',
      `${what} needs the user's approval, and ${agentChannel(client) === 'studio' ? 'the Studio cannot approve it yet: run it in a terminal' : 'this MCP client cannot ask its user (no elicitation support): a human runs it in a terminal'}. Nothing was deleted`,
      { fix: req.fix, details },
    );
  }
  let outcome: ApprovalOutcome;
  try {
    outcome = await approver.approvePrune(req);
  } catch (e) {
    outcome = { approved: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  if (!outcome.approved) {
    throw new EngineError('refused', `nothing was deleted: ${outcomeText(outcome)} — ${what}. Do not retry on your own: ask the user, or let them run it in a terminal`, {
      fix: req.fix,
      details: { ...details, outcome: outcome.reason },
    });
  }
}
