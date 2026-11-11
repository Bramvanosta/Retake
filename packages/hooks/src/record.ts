/** The hook runs a context reports (HookContext.recordRun): the workspace journal's hook lines. */
import type { HookContext, HookResult } from './types.js';

/**
 * Report one executed (or refused) hook or rollback to `ctx.recordRun`: never for a dry run or a dry result, never
 * failing the run it reports. `run`: the run (or hooks journal) id it ran for when it is not the context's — a rollback
 * replays the journal of an earlier run (journal.ts journalId).
 */
export async function recordHookRun(ctx: HookContext, result: HookResult, run?: string): Promise<void> {
  if (!ctx.recordRun || ctx.dryRun || result.status === 'dry') return;
  try {
    await (run !== undefined ? ctx.recordRun(result, run) : ctx.recordRun(result));
  } catch {
    // the hook ran: its report is best effort
  }
}
