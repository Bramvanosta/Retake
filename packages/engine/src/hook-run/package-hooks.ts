/**
 * The product's hook runner: the hooks package behind the HookRunner port. The package is loaded through the engine's
 * loader (lazy.ts `hooks`) on a member's first call — a command that runs no hook never loads it — and each member
 * calls the package's function with the same arguments: what runs, what is journaled and signed, and every approval's
 * fingerprint are the package's, unchanged. Made by the composition roots only (ports.ts enginePorts).
 */
import { projectPath } from '@retake/core';
import type { HookStep } from '@retake/core';
import { EngineError } from '../errors.js';
import { hooks } from '../lazy.js';
import type { HookJournal, HookRunner, PendingHookJournal } from './runner.js';

type Hooks = Awaited<ReturnType<typeof hooks>>;
type Journal = Hooks['Journal']['prototype'];

/** The package's journal behind a handle this runner gave out (a journal of another runner is refused, never cast). */
function own(h: Hooks, journal: HookJournal): Journal {
  if (journal instanceof h.Journal) return journal;
  throw new EngineError('internal', 'a hooks journal opened by another hook runner was handed to the package runner');
}

const pendingOf = (h: Hooks, list: readonly PendingHookJournal[]) => list.map((p) => ({ file: p.file, ...(p.journal ? { journal: own(h, p.journal) } : {}), ...(p.error !== undefined ? { error: p.error } : {}) }));

export function packageHookRunner(): HookRunner {
  return {
    load: async () => void (await hooks()),
    run: async (list, ctx, o) => {
      const h = await hooks();
      const steps: HookStep[] = [...list];
      return h.runHooks(steps, ctx, { phase: o.phase, journal: own(h, o.journal), ...(o.agentWritten !== undefined ? { agentWritten: o.agentWritten } : {}) });
    },
    journals: {
      open: async (file): Promise<HookJournal> => (await hooks()).Journal.open(file),
      standaloneFile: async (projectDir, id) => (await hooks()).standaloneJournalFile(projectDir, id),
      find: async (projectDir, id) => {
        const h = await hooks();
        return { file: h.findJournal(projectDir, id), looked: [projectPath(projectDir, 'runs', id, h.JOURNAL_FILE), h.standaloneJournalFile(projectDir, id)] };
      },
      openPending: async (projectDir): Promise<PendingHookJournal[]> => (await hooks()).openPendingJournals(projectDir),
      rollback: async (list, ctx) => {
        const h = await hooks();
        return h.rollbackJournals(pendingOf(h, list), ctx);
      },
      rollbackPending: async (projectDir, ctx) => (await hooks()).rollbackPendingJournals(projectDir, ctx),
      pruneDone: async () => (await hooks()).pruneDoneRollbacks(),
    },
    approval: {
      fingerprint: async (hook, place) => (await hooks()).hookFingerprint(hook, place),
      files: async (hook, o) => (await hooks()).hookFiles(hook, o),
    },
  };
}
