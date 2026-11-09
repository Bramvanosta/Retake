/** The sessions a run of a scenario signs in and a persona's state as a client sees it (the façade's auth and admission). */
import { workspaceFolders } from '@retake/core';
import type { LoadedProject, RunMode, Scenario, WorkspaceConfig } from '@retake/core';
import { personaStateView, scenarioPersonaStates } from '../auth.js';
import type { PersonaState } from '../auth.js';
import { cleansWorkerEnv } from '../caller.js';
import type { Caller } from '../caller.js';
import { cleanWorkerEnv } from '../jobs/worker-env.js';
import type { AuthStatusItem, EngineOptions, ScenarioSessions } from './types.js';

/** What the sessions of a scenario are read with: the client's options, its caller, the workspace, its login command. */
export interface SessionsDeps {
  opts: Pick<EngineOptions, 'workerEnv'>;
  caller: Caller;
  ws: WorkspaceConfig;
  loginCommand: (p: { project: string; env: string; persona?: string }) => string;
}

/**
 * The sessions of a parsed scenario on an environment: the Run screen's panel (engine.auth.forScenario) and the
 * capture's sessions acknowledgement (the admission rules, on the scenario and environment the run submit settled).
 */
export async function scenarioSessions(d: SessionsDeps, p: LoadedProject, name: string, scenario: Scenario, o: { env?: string; mode?: RunMode }): Promise<ScenarioSessions> {
  const { opts, caller, ws, loginCommand } = d;
  // The secrets of the login steps are looked for where the worker this client starts finds them.
  const workerEnv = opts.workerEnv ?? (cleansWorkerEnv(caller) ? cleanWorkerEnv(process.env, ws.root, { folders: workspaceFolders(ws) }) : process.env);
  const r = await scenarioPersonaStates(p, scenario, loginCommand, { ...(o.env !== undefined ? { env: o.env } : {}), hooks: (o.mode ?? 'capture') === 'capture', workerEnv });
  return {
    project: p.slug,
    scenario: name,
    env: r.env,
    personas: r.personas.map((x) => ({
      ...authStatusItem(x.state),
      auto: x.auto,
      has_check: x.has_check,
      ...(x.login_env_missing ? { login_env_missing: x.login_env_missing } : {}),
      ...(x.login_keychain ? { login_keychain: x.login_keychain } : {}),
    })),
    issues: r.issues,
  };
}

/** A persona's state for a client: no path; the last check's message and page under `untrusted`. */
export function authStatusItem(state: PersonaState): AuthStatusItem {
  const { detail, at, ...rest } = personaStateView(state);
  return { ...rest, ...(detail !== undefined || at !== undefined ? { untrusted: { ...(detail !== undefined ? { detail } : {}), ...(at !== undefined ? { at } : {}) } } : {}) };
}
