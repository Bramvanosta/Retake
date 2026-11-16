/**
 * Human approval of hooks through MCP elicitation (R-MCP-35). The engine's preflight lists the hooks of the work
 * submitted that need a human (destructive ones whatever `confirm: true` says, every shell hook); this asks the client's
 * user once, in form mode, with an explicit timeout — and so are a site extraction's URL, an agent's prune, an agent's font fetch and an agent's change of project.yaml's environments. Only `accept` with `approve: true` approves. A decline, a dismissed
 * form, no answer in time or a failed question refuse the submit; a client without form elicitation cannot ask anyone
 * (the engine then refuses with the `retake` command a human runs in a terminal).
 */
import { approvalFormText, projectChangeApprovalFormText, pruneApprovalFormText } from '@retake/engine/shell';
import { FONTSOURCE_LICENCES } from '@retake/core/theme';
import type { ApprovalOutcome, ApprovalRequest, Approver, FontsApprovalRequest, ProjectChangeApprovalRequest, PruneApprovalRequest, SiteApprovalRequest } from '@retake/engine';
import { isTimeoutError } from './server.js';
import type { CallContext, ElicitForm } from './server.js';
import { errorMessage } from '@retake/core/base';

/** How long a human has to answer (ms): 10 min; RETAKE_MCP_APPROVAL_TIMEOUT_MS overrides it. */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export function approvalTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.RETAKE_MCP_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : APPROVAL_TIMEOUT_MS;
}

/** The question the user reads (engine approvalFormText: the text whose length the engine limits). */
export const approvalMessage = approvalFormText;

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
 * The question of a site extraction: the canonical URL as it opens (percent-encoded path, punycode host — never
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

/** The question of an agent's prune (engine pruneApprovalFormText: the text whose length the engine limits). */
export const pruneApprovalMessage = pruneApprovalFormText;

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

/**
 * The question of an agent's font fetch, asked before any network contact: the registry as it is (the test hatch's
 * loopback one said to be a test registry), each package and the version asked, the faces, the latin subset, the
 * licence rule, that nothing else is fetched, and the command the person runs instead.
 */
export function fontsApprovalMessage(req: FontsApprovalRequest): string {
  const host = new URL(req.registry).host;
  return [
    `Retake: the agent asks to download ${req.packages.length === 1 ? 'one open-licence font package' : `${req.packages.length} open-licence font packages`} into this workspace's font store (.retake/fonts/).`,
    `From: ${req.registry}${req.test_registry ? ' — a TEST registry (RETAKE_UNSAFE_TEST_NPM_REGISTRY), never set outside tests' : ''}`,
    ...req.packages.map((p) => `- ${p.package} ${p.version ?? 'latest (resolved now, and recorded)'}: ${p.faces.join(', ')}`),
    `Only these: each package's manifest and its archive from ${host} (no redirect followed), checked against the integrity the registry lists; the latin WOFF2 files of the faces above and the LICENSE are kept, nothing else of the archive. A package is kept only if its publisher declares ${FONTSOURCE_LICENCES.join(' or ')} (the package's own declaration). No theme is written: a theme names these fonts afterwards.`,
    'Approve to download exactly these. Decline to refuse: nothing is downloaded.',
    `Instead, you can run it yourself in a terminal: ${req.fix}`,
  ].join('\n');
}

export function fontsApprovalForm(req: FontsApprovalRequest): ElicitForm {
  return {
    message: fontsApprovalMessage(req),
    requestedSchema: {
      type: 'object',
      properties: {
        approve: { type: 'boolean', title: 'Download these fonts', description: 'Check to let this one fetch download the packages listed above, nothing else.', default: false },
      },
      required: ['approve'],
    },
  };
}

/** The question of an agent's environment change (engine projectChangeApprovalFormText: the text whose length the engine limits). */
export function projectChangeApprovalForm(req: ProjectChangeApprovalRequest): ElicitForm {
  return {
    message: projectChangeApprovalFormText(req),
    requestedSchema: {
      type: 'object',
      properties: {
        approve: { type: 'boolean', title: 'Write this change to project.yaml', description: 'Check to write the change listed above, once.', default: false },
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
    return { approved: false, reason: 'error', message: errorMessage(e) };
  }
}

/** The approver of a call whose client declared form elicitation (undefined otherwise: the engine refuses). */
export function elicitationApprover(elicit: CallContext['elicit'], timeoutMs = approvalTimeoutMs()): Approver | undefined {
  if (!elicit) return undefined;
  return {
    approve: (req: ApprovalRequest) => ask(elicit, approvalForm(req), timeoutMs),
    approveSite: (req: SiteApprovalRequest) => ask(elicit, siteApprovalForm(req), timeoutMs),
    approvePrune: (req: PruneApprovalRequest) => ask(elicit, pruneApprovalForm(req), timeoutMs),
    approveFonts: (req: FontsApprovalRequest) => ask(elicit, fontsApprovalForm(req), timeoutMs),
    approveProjectChange: (req: ProjectChangeApprovalRequest) => ask(elicit, projectChangeApprovalForm(req), timeoutMs),
  };
}
