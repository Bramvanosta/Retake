/** The façade's `templates` (themes: read, create, from a site, edit, copy, preview) and `components` (read, validate, create, preview, the library) (createEngine). */
import { libraryStatesOf, submitPreviewJob } from '../jobs/preview-job.js';
import { componentCreate, componentGet, componentList, componentValidate } from '../components.js';
import { templateGet, templateList } from '../templates.js';
import { editTheme, themeEditView, themeEditList } from '../theme-edit.js';
import { buildThemePreview } from '../views/theme-preview.js';
import { copyTheme } from '../brand/copy.js';
import { brandFileList } from '../brand/file-list.js';
import { siteList } from '../views/site-list.js';
import { createThemeFromBrand } from '../brand/create.js';
import { updateThemeFromBrand } from '../brand/update.js';
import { readSite, siteHostConflicts, submitSiteJob } from '../jobs/site-job.js';
import { fetchFonts } from '../brand/fontsource-fetch.js';
import { tokensDraft } from '../brand/tokens.js';
import { ENGINE_TRUST } from '../caller.js';
import type { EngineContext } from './context.js';
import type { Engine } from './types.js';

/** engine.templates. */
export function templatesApi(ctx: EngineContext): Engine['templates'] {
  const { opts, ws, scope, submitCtx, startWorker, ports, caches, caller, agent } = ctx;
  return {
    list: (o = {}) => templateList(ws, o.project),
    get: (o) => templateGet(ws, o),
    // Who makes it is recorded (made_via): through MCP only a theme made through MCP is replaced or updated.
    create: (input) => createThemeFromBrand(ws, input, { trust: ENGINE_TRUST, via: caller.channel, scope }),
    update: (input) => updateThemeFromBrand(ws, input, { via: caller.channel, scope }),
    fromSite: async (req, o = {}) => {
      const r = await submitSiteJob(submitCtx, req, o.approver);
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
    site: (siteId, url) => readSite(ws, siteId, url, scope.clock),
    fromTokens: (req) => tokensDraft(ws, req, { trust: ENGINE_TRUST, clock: scope.clock }),
    // An agent's fetch is asked of a person first (fontsource-approval.ts), before any network contact.
    fetchFonts: (req, o = {}) => fetchFonts(ws, req, { registry: ports.fontRegistry, clock: scope.clock, ask: agent, ...(o.approver ? { approver: o.approver } : {}), client: opts.client }),
    view: (name, o = {}) => themeEditView(ws, name, caches.themeEdit, o.project),
    editList: (project) => themeEditList(ws, project, caches.themeEdit),
    edit: (name, req, o = {}) => editTheme(ws, name, req, { client: opts.client, scope, memos: caches.themeEdit, ...(o.project !== undefined ? { project: o.project } : {}) }),
    // As create: the engine's agent trust (a copy into a project never hides a workspace theme of its name).
    copy: (req) => copyTheme(ws, req, { scope, trust: ENGINE_TRUST }),
    files: (kind, o = {}) => brandFileList(ws, kind, o.project),
    sites: () => siteList(ws),
    siteConflicts: (host) => siteHostConflicts(ws, ports.hosts, host),
    previewSpec: (req, o) => buildThemePreview(ws, req, { start: o.start, registry: caches.registry, samples: caches.previewSamples }),
    preview: async (req) => {
      const r = await submitPreviewJob(submitCtx, { project: req.project, ...(req.template !== undefined ? { template: req.template } : {}), target: { kind: 'theme' } });
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
  };
}

/** engine.components. */
export function componentsApi(ctx: EngineContext): Engine['components'] {
  const { ws, scope, submitCtx, startWorker, caches } = ctx;
  return {
    registry: async () => (await caches.registry.get(ws)).registry,
    list: (kind) => componentList(ws, kind),
    get: (id) => componentGet(ws, id),
    validate: (id) => componentValidate(ws, id),
    create: (req) => componentCreate(ws, req, scope),
    preview: async (req) => {
      const r = await submitPreviewJob(submitCtx, {
        project: req.project,
        ...(req.template !== undefined ? { template: req.template } : {}),
        target: {
          kind: 'component',
          component: req.component,
          ...(req.slots ? { slots: req.slots } : {}),
          ...(req.params ? { params: req.params } : {}),
          ...(req.at_s !== undefined ? { at_s: req.at_s } : {}),
        },
      });
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
    library: async (req) => libraryStatesOf(ws, req),
    libraryRender: async (req) => {
      const r = await submitPreviewJob(submitCtx, {
        project: req.project,
        ...(req.template !== undefined ? { template: req.template } : {}),
        target: { kind: 'library', items: req.items, ...(req.retry ? { retry: true } : {}) },
      });
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
  };
}
