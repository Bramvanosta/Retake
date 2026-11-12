/**
 * The product's capture runner: the runner package behind the CaptureRunner port. The package is loaded through the
 * engine's loader (lazy.ts `runnerWeb`) on a member's first call, or by `load()` — which the composition roots await
 * where they imported the package before the port (the jobs worker and the job process at their start, the CLI before
 * it listens to Ctrl-C), so that the two synchronous members work in a signal handler. Each member calls the package's
 * function with the same arguments: what is filmed, recorded, signed in and removed is the package's, unchanged. Made by
 * the composition roots only (ports.ts enginePorts).
 */
import type { RunOptions } from '@retake/runner-web/types';
import { EngineError } from '../errors.js';
import type { HookJournal, HookRunner } from '../hook-run/runner.js';
import { runnerWeb } from '../lazy.js';
import type { CaptureRunner, HookBrowser } from './runner.js';

type RunnerWeb = Awaited<ReturnType<typeof runnerWeb>>;
type Session = RunnerWeb['BrowserSession']['prototype'];

/** The package's browser behind a handle this runner opened (a browser of another runner is refused, never cast). */
function own(rw: RunnerWeb, browser: HookBrowser): Session {
  if (browser instanceof rw.BrowserSession) return browser;
  throw new EngineError('internal', 'a js-hook browser opened by another capture runner was handed to the runner package');
}

/**
 * The engine's HookRunner against the runner's mirror of it (RunOptions.hookRunner), strictly: the mirror declares
 * methods (bivariant, for the journal handle it hands back), so `runScenario(req)` alone would accept a runner whose
 * context, options or results the runner does not read as it writes them. Here each member is a function type of its
 * own (compared contravariantly in its parameters), with `run`'s journal the engine's own handle.
 */
type Mirror = NonNullable<RunOptions['hookRunner']>;
type Strict<F> = F extends (...a: infer P) => infer R ? (...a: P) => R : never;
type OwnJournal<F, J> = F extends (h: infer H, c: infer C, o: infer O) => infer R ? (h: H, c: C, o: Omit<O, 'journal'> & { journal: J }) => R : never;
type Assignable<A extends B, B> = [A, B];
type HookRunnerChecks = [
  Assignable<HookRunner['load'], Strict<Mirror['load']>>,
  Assignable<HookRunner['run'], OwnJournal<Mirror['run'], HookJournal>>,
  Assignable<HookRunner['journals']['open'], Strict<Mirror['journals']['open']>>,
];

export function runnerWebCapture(): CaptureRunner {
  let loaded: RunnerWeb | undefined;
  const load = async (): Promise<RunnerWeb> => (loaded = await runnerWeb());
  /** The package, for a synchronous member: loaded by `load()` (or any member) before. */
  const sync = (member: string): RunnerWeb => {
    if (loaded) return loaded;
    throw new EngineError('internal', `the capture runner's ${member} was called before it was loaded: its composition root awaits capture.load() first`);
  };
  return {
    load: async () => void (await load()),
    // The request is handed on as is: the runner reads its own options (the hook runner is the engine's addition).
    run: async (req) => (await load()).runScenario(req),
    record: async (o) => (await load()).recordSession(o),
    sessions: {
      check: async (o) => (await load()).checkSavedSession(o),
      signIn: async (o) => (await load()).signIn(o),
      lock: async (profileDir) => (await load()).profileLock(profileDir),
      status: async (file) => (await load()).readStatus(file),
    },
    hookPages: {
      // As the hook commands opened it before the port (hooks.ts): a copy of the persona's session, the kit with its
      // defaults, the project's capture size and browser.
      open: async (o): Promise<HookBrowser> => {
        const rw = await load();
        const capture = o.project.config.capture;
        const prepared = o.persona ? await rw.prepareSessions([o.persona], { runId: o.runId, log: o.log, ...(o.failure !== undefined ? { failure: o.failure } : {}) }) : [];
        const persona = o.persona;
        return rw.openSession({
          policy: o.policy,
          width: capture.width,
          height: capture.height,
          scale: capture.scale,
          kit: rw.kitConfigFor(undefined),
          browser: rw.projectBrowser(o.project),
          log: o.log,
          ...(o.writes ? { writes: { policy: o.writes.policy } } : {}),
          ...(persona ? { realms: prepared.map((p) => p.realm), hookRealmOf: () => persona.name } : {}),
        });
      },
      evalIn: async (browser, o, pageKey, code) => {
        const rw = await load();
        return rw.evalHookInPage(own(rw, browser), o, pageKey, code);
      },
      authReader: async (o) => {
        const rw = await load();
        const { browser, ...source } = o;
        return rw.personaAuthReader({ ...source, context: async () => own(rw, await browser()).contextOf(o.persona.name) });
      },
    },
    site: {
      extract: async (o) => (await load()).extractSite(o),
    },
    cancelled: (message) => {
      const { CancelledError } = sync('cancelled');
      return new CancelledError(message);
    },
    cleanupSync: () => sync('cleanupSync').removeSessionCopiesSync(),
  };
}
