/** The façade's `templates` (themes: read, create, from a site, edit, copy, preview) and `components` (read, validate, create, preview, the library) (createEngine). */
import { libraryStatesOf, submitPreviewJob } from '../jobs/preview-job.js';
import { componentCreate, componentGet, componentList, componentValidate } from '../components.js';
import { templateGet, templateList } from '../templates.js';
import { editTemplate, templateView } from '../theme-edit.js';
import { copyTheme } from '../brand/copy.js';
import { brandFileList } from '../brand/file-list.js';
import { siteList } from '../site-list.js';
import { createThemeFromBrand } from '../brand/create.js';
import { readSite, submitSiteJob } from '../jobs/site-job.js';
import { ENGINE_TRUST } from '../caller.js';
import type { EngineContext } from './context.js';
import type { Engine } from './types.js';

/** engine.templates. */
export function templatesApi(ctx: EngineContext): Engine['templates'] {
  const { opts, ws, scope, submitCtx, startWorker } = ctx;
  return {
    list: (o = {}) => templateList(ws, o.project),
    get: (o) => templateGet(ws, o),
    create: (input) => createThemeFromBrand(ws, input, { trust: ENGINE_TRUST, scope }),
    fromSite: async (req, o = {}) => {
      const r = await submitSiteJob(submitCtx, req, o.approver);
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
    site: (siteId, url) => readSite(ws, siteId, url),
    view: (name) => templateView(ws, name),
    edit: (name, req) => editTemplate(ws, name, req, { client: opts.client, scope }),
    copy: (req) => copyTheme(ws, req, { scope }),
    files: (kind) => brandFileList(ws, kind),
    sites: () => siteList(ws),
    preview: async (req) => {
      const r = await submitPreviewJob(submitCtx, { project: req.project, ...(req.template !== undefined ? { template: req.template } : {}), target: { kind: 'theme' } });
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
  };
}

/** engine.components. */
export function componentsApi(ctx: EngineContext): Engine['components'] {
  const { ws, scope, submitCtx, startWorker } = ctx;
  return {
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
