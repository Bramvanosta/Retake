/** The façade's `projects` (createEngine): list, read, create, the README, prune (an agent's deletion asked first), the board. */
import { createProjectFromRequest, listProjectSummaries, projectView, updateProjectReadme } from '../projects.js';
import { pruneApprovalRequest, takePruneApproval } from '../approvals.js';
import { changeProjectEnvironment } from '../project-env.js';
import type { EnvironmentChangeContext } from '../project-env.js';
import { DEFAULT_KEEP_RENDERS, pruneKey, pruneProject } from '../prune.js';
import type { EngineContext } from './context.js';
import type { Engine } from './types.js';

/** engine.projects. */
import { adoptIntoProject } from '../project-adopt.js';
import { fileSha256 } from '../project-archive/code-files.js';
import { exportProjectArchive } from '../project-archive/export.js';
import { importProjectArchive } from '../project-archive/import.js';
import { discardImport, projectTrustView, trustImportedProject } from '../project-archive/trust-work.js';

export function projectsApi(ctx: EngineContext): Engine['projects'] {
  const { opts, agent, ws, scope, project, studio, queue, boards, ports } = ctx;
  const envContext = (approver: EnvironmentChangeContext['approver']): EnvironmentChangeContext => ({
    ws,
    scope,
    hosts: ports.hosts,
    agent,
    cli: studio,
    ...(approver ? { approver } : {}),
    ...(opts.client ? { client: opts.client } : {}),
  });
  return {
    list: () => listProjectSummaries(ws),
    get: async (slug) => {
      const p = await project(slug);
      return projectView(p, scope.stores.folder(p.dir));
    },
    create: async (input) => {
      const p = await createProjectFromRequest(ws, input, scope, ports.hosts);
      return projectView(p, scope.stores.folder(p.dir));
    },
    updateReadme: async (slug, markdown, ifMatch) => updateProjectReadme(await project(slug), markdown, ifMatch, scope),
    prune: async (slug, req = {}, o = {}) => {
      const p = await project(slug);
      // What a queued or running job names (its run, its render) stays: read again right before each pass.
      const busy = async (): Promise<(id: string) => boolean> => {
        const active = await queue.list({ states: ['queued', 'running'] });
        const named = active.map((j) => JSON.stringify(j.input)).join('\n');
        return (id) => named.includes(`"${id}"`);
      };
      const base = { ...(req.keep_renders !== undefined ? { keep_renders: req.keep_renders } : {}) };
      if (req.dry_run !== false || !agent) return pruneProject({ outputs: ws.outputs, stores: scope.stores }, p, { ...base, dry_run: req.dry_run !== false, busy: await busy() });
      // An agent's deletion: the person is asked about what would go; the items in the approval that can still go then
      // go, each with the files it had when listed.
      const listed = await pruneProject({ outputs: ws.outputs, stores: scope.stores }, p, { ...base, dry_run: true, busy: await busy() });
      if (!listed.items.length) return { ...listed, dry_run: false, skipped: [], not_asked: 0 };
      const keep = listed.keep_renders !== DEFAULT_KEEP_RENDERS ? ` --keep-renders ${listed.keep_renders}` : '';
      await takePruneApproval(pruneApprovalRequest(listed, `${studio} prune ${p.slug}${keep} --yes`), o.approver, opts.client);
      return pruneProject({ outputs: ws.outputs, stores: scope.stores }, p, { ...base, dry_run: false, busy: await busy(), only: new Map(listed.items.map((i) => [pruneKey(i), i.paths])) });
    },
    setEnvironment: async (slug, env, change, o = {}) => changeProjectEnvironment(envContext(o.approver), await project(slug), { kind: 'set', mode: o.mode ?? 'upsert', env, change }),
    removeEnvironment: async (slug, env, o = {}) => changeProjectEnvironment(envContext(o.approver), await project(slug), { kind: 'remove', env }),
    board: (slug) => boards.board(slug),
    // MCP (agent trust) copies themes and components only; a person's CLI moves, copies and adopts brand files (project-adopt.ts).
    adopt: (req) =>
      adoptIntoProject(ws, req, {
        scope,
        trust: scope.caller.trust,
        activeJobs: async () => (await queue.list({ states: ['queued', 'running'] })).map((j) => `${j.input.kind} ${j.id}`),
        env: ports.env,
      }),
    // A project archive (project-archive/): export by anyone (MCP: no runs, no --out), import and trust by a person only.
    exportArchive: async (req, o = {}) =>
      exportProjectArchive(ws, await project(req.project), req, { trust: scope.caller.trust, env: ports.env, now: new Date(ports.clock.now()), ...(o.onFile ? { onFile: o.onFile } : {}) }),
    importArchive: async (file, o = {}) =>
      importProjectArchive(ws, file, {
        ...(o.as !== undefined ? { as: o.as } : {}),
        trust: scope.caller.trust,
        scope,
        env: ports.env,
        now: new Date(ports.clock.now()).toISOString(),
        archiveSha256: await fileSha256(file),
      }),
    trustView: (slug) => projectTrustView(ws, slug, { trust: scope.caller.trust, env: ports.env }),
    trust: (slug, listed) => trustImportedProject(ws, slug, listed, { trust: scope.caller.trust, env: ports.env, now: new Date(ports.clock.now()).toISOString() }),
    discardImport: (slug) => discardImport(ws, slug, { trust: scope.caller.trust, env: ports.env, now: new Date(ports.clock.now()).toISOString(), scope }),
  };
}
