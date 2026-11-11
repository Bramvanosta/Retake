/**
 * The engine facade (L3.1 part A, read side): one typed, in-process API over a workspace for clients other than the
 * CLI's own commands — the MCP server now, the jobs worker and the local HTTP API later. Inputs are slugs and ids, never
 * paths; results carry project refs + local paths; text the filmed site controls is kept under `untrusted`.
 * Nothing here opens a browser or starts a capture: long tasks (runs, hooks, resets, sign-ins, sandboxes) become jobs the
 * workspace's worker runs in a process of its own.
 *
 * createEngine assembles the façade: one context per engine (src/facade/context.ts: the caller, the workspace, the
 * queue, the worker starter, the admission rules, the shared caches), then one builder per sub-API
 * (src/facade/*-api.ts); its types live in src/facade/types.ts and are re-exported here.
 */
import { agentChecks, callerOf } from './caller.js';
import type { EngineClient } from './caller.js';
import { thumbnail } from './reviews.js';
import { usageCounts } from './history.js';
import { FileJobQueue } from './jobs/queue.js';
import { enginePorts } from './ports.js';
import { authApi } from './facade/auth-api.js';
import { commentsApi } from './facade/comments-api.js';
import { engineContext } from './facade/context.js';
import { infoOf } from './facade/info.js';
import { envApi, hooksApi, jobsApi, sandboxApi } from './facade/jobs-api.js';
import { componentsApi, templatesApi } from './facade/library-api.js';
import { projectsApi } from './facade/projects-api.js';
import { inspectApi, recordApi } from './facade/record-api.js';
import { exportsApi, rendersApi, reviewsApi, timelineApi } from './facade/renders-api.js';
import { runsApi } from './facade/runs-api.js';
import { scenariosApi } from './facade/scenarios-api.js';
import type { Engine, EngineOptions } from './facade/types.js';

export { ENGINE_API_VERSION } from './facade/info.js';
export type {
  AuthStatus,
  AuthStatusItem,
  CompactRunStatus,
  Engine,
  EngineInfo,
  EngineOptions,
  InspectSubmitted,
  PreviewSubmitted,
  RecordSubmitted,
  RunJobView,
  RunListItem,
  RunStatusWithJob,
  ScenarioCheck,
  ScenarioSessions,
  WaitOptions,
} from './facade/types.js';

/**
 * Who drives the engine (caller.ts: the caller of a client and every decision taken from it). `ui` is the Studio web
 * app: the server cannot tell a person's click from script running in the page, so the ops it allows run under the
 * agent's trust, with no approver. Comments are a channel, not presence: `ui` writes as `studio` and, like the CLI,
 * creates and reopens threads — on the thread and render versions it showed.
 */
export type { EngineClient } from './caller.js';

/** The agent's checks (core agent-trust) for a client: every client but the CLI (a person at a terminal) and tests. */
export function agentTrust(client: EngineClient): boolean {
  return agentChecks(callerOf(client));
}

export async function createEngine(opts: EngineOptions): Promise<Engine> {
  // The façade's composition root: the ports a test hands, else the product's (the MCP server and the Studio hand none).
  const ports = enginePorts(opts.ports);
  const ctx = await engineContext(opts, ports, (root, cli) => {
    const queue = new FileJobQueue(root, cli, ports.clock);
    return { queue, files: queue.files };
  });
  const { ws, queue, jobFiles, studio } = ctx;
  return {
    root: ws.root,
    queue,
    jobFiles,
    workspace: ws,
    cli: studio,
    info: infoOf(ctx),
    usage: () => usageCounts(ws.root),
    projects: projectsApi(ctx),
    scenarios: scenariosApi(ctx),
    runs: runsApi(ctx),
    jobs: jobsApi(ctx),
    hooks: hooksApi(ctx),
    env: envApi(ctx),
    auth: authApi(ctx),
    renders: rendersApi(ctx),
    timeline: timelineApi(ctx),
    reviews: reviewsApi(ctx),
    exports: exportsApi(ctx),
    templates: templatesApi(ctx),
    components: componentsApi(ctx),
    inspect: inspectApi(ctx),
    record: recordApi(ctx),
    thumbnail: (file, maxPx) => thumbnail(ws, file, maxPx),
    comments: commentsApi(ctx),
    sandbox: sandboxApi(ctx),
  };
}
