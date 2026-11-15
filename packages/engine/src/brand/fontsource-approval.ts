/**
 * The question a person answers before an agent's font fetch (fontsource-fetch.ts), asked before any network contact:
 * the registry as it is (the test hatch's loopback one said to be a test registry), each package and the version asked
 * (or the registry's latest, resolved then and recorded), the faces, and the command the person runs instead — the
 * MCP form (mcp/src/approval.ts fontsApprovalForm) words it. Every value in it is a checked slug, version or weight.
 * No client support → `needs_approval` with that command; a decline, no answer or a failed question → `refused`.
 */
import { errorMessage } from '@retake/core/base';
import { agentChannel, outcomeText } from '../approvals.js';
import type { ApprovalOutcome, Approver, FontsApprovalRequest } from '../approvals.js';
import { EngineError } from '../errors.js';
import type { JobClient } from '../jobs/job-input.js';

export type { FontsApprovalRequest } from '../approvals.js';

/**
 * Ask the client's person to approve a font fetch. Returns when they approved; throws `needs_approval` when the client
 * cannot ask anyone, `refused` when they declined, did not answer in time or the question failed — each with the
 * `retake theme fetch-font` command. Nothing is downloaded before it returns.
 */
export async function takeFontsApproval(req: FontsApprovalRequest, approver: Approver | undefined, client?: JobClient): Promise<void> {
  const what = `downloading ${req.packages.map((p) => `${p.package}${p.version ? `@${p.version}` : ''}`).join(', ')}`;
  const details = { registry: req.registry, packages: req.packages.map((p) => ({ package: p.package, version: p.version })) };
  if (!approver?.approveFonts) {
    throw new EngineError(
      'needs_approval',
      `${what} needs the user's approval, and ${agentChannel(client) === 'studio' ? 'the Studio cannot approve it: run it in a terminal' : 'this MCP client cannot ask its user (no elicitation support): a human runs it in a terminal'}. Nothing was downloaded`,
      { fix: req.fix, details },
    );
  }
  let outcome: ApprovalOutcome;
  try {
    outcome = await approver.approveFonts(req);
  } catch (e) {
    outcome = { approved: false, reason: 'error', message: errorMessage(e) };
  }
  if (!outcome.approved) {
    throw new EngineError('refused', `nothing was downloaded: ${outcomeText(outcome)} — ${what}. Do not retry on your own: ask the user, or let them run it in a terminal`, {
      fix: req.fix,
      details: { ...details, outcome: outcome.reason },
    });
  }
}
