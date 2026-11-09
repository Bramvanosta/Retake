/** The façade's `auth` (createEngine): the personas' stored state, a sign-in job and its cancel, the sessions a scenario's run signs in. */
import { listProjects, parseScenario, projectRef } from '@retake/core';
import type { RunMode } from '@retake/core';
import { projectPersonaStates } from '../auth.js';
import { EngineError, toEngineError } from '../errors.js';
import { getScenario } from '../scenarios.js';
import { cancelSignIn, submitAuthLoginJob } from '../jobs/auth-job.js';
import type { EngineContext } from './context.js';
import { authStatusItem } from './sessions.js';
import type { AuthStatus, AuthStatusItem, Engine, ScenarioSessions } from './types.js';

/** engine.auth. */
export function authApi(ctx: EngineContext): Engine['auth'] {
  const { opts, ws, project, loginCommand, queue, submitCtx, startWorker, sessionsOf } = ctx;
  const forScenario = async (slug: string, name: string, o: { env?: string; mode?: RunMode } = {}): Promise<ScenarioSessions> => {
    const p = await project(slug);
    const text = await getScenario(p, name);
    const { scenario } = parseScenario(text.yaml, { file: text.path, project: p });
    if (!scenario) throw new EngineError('invalid', `${projectRef('scenarios', name)} does not parse: fix it first (scenario_check lists its issues)`);
    return sessionsOf(p, name, scenario, o);
  };
  return {
    status: async (o = {}) => {
      if (o.env !== undefined && o.project === undefined) throw new EngineError('invalid', 'env needs project (environments belong to a project)');
      const errors: AuthStatus['errors'] = [];
      const projects = [];
      if (o.project !== undefined) projects.push(await project(o.project));
      else {
        for (const p of await listProjects(ws.root)) {
          try {
            projects.push(await project(p.slug));
          } catch (e) {
            errors.push({ project: p.slug, error: toEngineError(e).message.split('\n')[0] });
          }
        }
      }
      const personas: AuthStatusItem[] = [];
      for (const p of projects) {
        for (const { state } of await projectPersonaStates(p, loginCommand, o.env)) personas.push(authStatusItem(state));
      }
      return { personas, errors };
    },
    login: async (req) => {
      const r = await submitAuthLoginJob(submitCtx, req);
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
    cancelSignIn: async (id) => {
      const rec = await cancelSignIn(queue, id, opts.client);
      await startWorker();
      return rec;
    },
    forScenario,
  };
}
