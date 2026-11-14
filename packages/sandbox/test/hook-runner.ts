/**
 * The hook runner these tests hand a sandbox (ProviderContext.hookRunner): the hooks package's own functions, as the
 * engine's package hook runner calls them — the sandbox package runs no hook itself.
 */
import type { SandboxHookRunner } from '@retake/core/hooks';
import { Journal, hookFingerprint, runHooks, supersedePendingJournals } from '@retake/hooks';

export const packageHooks: SandboxHookRunner = {
  load: async () => undefined,
  run: async (hooks, ctx, o) => {
    if (!(o.journal instanceof Journal)) throw new Error('a journal of another runner');
    return runHooks([...hooks], ctx, { phase: o.phase, journal: o.journal, ...(o.agentWritten !== undefined ? { agentWritten: o.agentWritten } : {}) });
  },
  journals: {
    open: (file) => Journal.open(file),
    supersede: (projectDir, env, by) => supersedePendingJournals(projectDir, env, by),
  },
  approval: { fingerprint: async (hook, place) => hookFingerprint(hook, place) },
};
