/**
 * Human approval of hooks through MCP elicitation (L3.1, R-MCP-35). The engine's preflight lists the hooks of the work
 * submitted that need a human (destructive ones whatever `confirm: true` says, every shell hook); this asks the client's
 * user once, in form mode, with an explicit timeout — and so are a site extraction's URL and an agent's prune. Only `accept` with `approve: true` approves. A decline, a dismissed
 * form, no answer in time or a failed question refuse the submit; a client without form elicitation cannot ask anyone
 * (the engine then refuses with the `retake` command a human runs in a terminal).
 */
import { approvalItemTitle, formatBytes, pruneKindsText } from '@retake/engine';
import type { ApprovalOutcome, ApprovalRequest, Approver, PruneApprovalRequest, SiteApprovalRequest } from '@retake/engine';
import { isTimeoutError } from './server.js';
import type { CallContext, ElicitForm } from './server.js';

/** How long a human has to answer (ms): 10 min; RETAKE_MCP_APPROVAL_TIMEOUT_MS overrides it. */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export function approvalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.RETAKE_MCP_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : APPROVAL_TIMEOUT_MS;
}

/**
 * The question the user reads: what runs, where, and each hook in full — its heading (where it stands, its name, its
 * kind, why it needs them), then every field on a line of its own as it will run (the engine's ApprovalItem.lines:
 * templated, secrets as `***`, hidden characters written out), its rollback's too — and the terminal path.
 */
export function approvalMessage(req: ApprovalRequest): string {
  const env = `${req.env.name}${req.env.production ? ' (production)' : ''}, ${req.env.access}`;
  return [
    `Retake: the agent asks to run ${req.what} in project ${req.project}, environment ${env}.`,
    `${req.items.length === 1 ? 'This hook needs' : `These ${req.items.length} hooks need`} your approval before ${req.items.length === 1 ? 'it runs' : 'they run'} ("confirm: true" in a file written through MCP does not count). Each is shown in full, as it will run:`,
    ...req.items.flatMap((i, n) => [`${n + 1}. ${approvalItemTitle(i)} — ${i.reason}`, ...i.lines.map((l) => `   ${l}`)]),
    'Approve to run them now (once, exactly as listed). Decline to refuse: nothing runs.',
    `Instead, you can run it yourself in a terminal: ${req.fix}`,
  ].join('\n');
}

export function approvalForm(req: ApprovalRequest): ElicitForm {
  return {
    message: approvalMessage(req),
    requestedSchema: {
      type: 'object',
      properties: {
        approve: {
          type: 'boolean',
          title: req.items.length === 1 ? 'Run this hook' : `Run these ${req.items.length} hooks`,
          description: 'Check to approve the hooks listed above for this one job.',
          default: false,
        },
      },
      required: ['approve'],
    },
  };
}

/**
 * The question of a site extraction (L3.5): the canonical URL as it opens (percent-encoded path, punycode host — never
 * the decoded path, which is the agent's text) and the host in Unicode on its own line.
 */
export function siteApprovalMessage(req: SiteApprovalRequest): string {
  return [
    'Retake: the agent asks to open a website and extract its colours, font names and logos for a new theme.',
    `URL: ${req.href}`,
    `Host: ${req.unicode_host}${req.unicode_host !== req.host ? ` (written ${req.host})` : ''}`,
    'It opens once in a clean headless browser on this machine: no profile and no saved sign-in, page loads only (GET requests to public addresses; no form is sent, nothing is clicked or typed). A screenshot and logo images go to .retake/site/; no theme is written.',
    'Approve to open exactly this URL. Decline to refuse: nothing opens.',
    `Instead, you can run it yourself in a terminal: ${req.fix}`,
  ].join('\n');
}

export function siteApprovalForm(req: SiteApprovalRequest): ElicitForm {
  return {
    message: siteApprovalMessage(req),
    requestedSchema: {
      type: 'object',
      properties: {
        approve: { type: 'boolean', title: 'Open this URL', description: 'Check to let this one extraction open the URL shown above.', default: false },
      },
      required: ['approve'],
    },
  };
}

/**
 * The question of an agent's prune: how many items of which project, how much they free, by kind, the first items
 * (PRUNE_FORM_MAX_LINES, every character visible) and how many more, and the terminal command.
 */
export function pruneApprovalMessage(req: PruneApprovalRequest): string {
  const items = `${req.count} item${req.count === 1 ? '' : 's'}`;
  return [
    `Retake: the agent asks to delete ${items} from project ${req.project}'s runs/, renders/ and review/, freeing ${formatBytes(req.bytes)}: ${pruneKindsText(req)}.`,
    `Kept: the last good take of each scenario, the last ${req.keep_renders} renders of each scenario and variant, whatever a kept render, a comment thread or a queued or running job uses; exports/ is not touched.`,
    req.more ? `The first ${req.lines.length}:` : `${req.count === 1 ? 'It' : 'They'}:`,
    ...req.lines.map((l) => `- ${l}`),
    ...(req.more ? [`… and ${req.more} more (in the totals above).`] : []),
    `Approve to delete ${req.count === 1 ? 'it' : 'them'} now: only ${req.count === 1 ? 'this item' : `these ${items}`}, and only if nothing uses ${req.count === 1 ? 'it' : 'them'} by then. Decline to refuse: nothing is deleted.`,
    `Instead, you can run it yourself in a terminal: ${req.fix}`,
  ].join('\n');
}

export function pruneApprovalForm(req: PruneApprovalRequest): ElicitForm {
  return {
    message: pruneApprovalMessage(req),
    requestedSchema: {
      type: 'object',
      properties: {
        approve: { type: 'boolean', title: `Delete ${req.count === 1 ? 'this item' : `these ${req.count} items`}`, description: 'Check to delete what is listed above, once.', default: false },
      },
      required: ['approve'],
    },
  };
}

async function ask(elicit: NonNullable<CallContext['elicit']>, form: ElicitForm, timeoutMs: number): Promise<ApprovalOutcome> {
  try {
    const answer = await elicit(form, { timeoutMs });
    if (answer.action === 'accept') return answer.content?.approve === true ? { approved: true } : { approved: false, reason: 'declined' };
    return { approved: false, reason: answer.action === 'decline' ? 'declined' : 'cancelled' };
  } catch (e) {
    if (isTimeoutError(e)) return { approved: false, reason: 'timeout' };
    return { approved: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** The approver of a call whose client declared form elicitation (undefined otherwise: the engine refuses). */
export function elicitationApprover(elicit: CallContext['elicit'], timeoutMs = approvalTimeoutMs()): Approver | undefined {
  if (!elicit) return undefined;
  return {
    approve: (req: ApprovalRequest) => ask(elicit, approvalForm(req), timeoutMs),
    approveSite: (req: SiteApprovalRequest) => ask(elicit, siteApprovalForm(req), timeoutMs),
    approvePrune: (req: PruneApprovalRequest) => ask(elicit, pruneApprovalForm(req), timeoutMs),
  };
}
