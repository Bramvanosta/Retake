/** The façade's `info()` (engine_info): the API version, this process, the features, the entitlements. */
import { hostname } from 'node:os';
import { RETAKE_VERSION } from '@retake/core';
import { entitlements } from '../entitlements.js';
import type { EngineContext } from './context.js';
import type { Engine } from './types.js';

export const ENGINE_API_VERSION = 1;

/** engine.info(): what this engine is and can do (engine_info). */
export function infoOf(ctx: EngineContext): Engine['info'] {
  const { opts, ws } = ctx;
  return () => ({
    api: ENGINE_API_VERSION,
    version: RETAKE_VERSION,
    node: process.versions.node,
    client: opts.client,
    root: ws.root,
    projects_dir: ws.projectsDir,
    host: hostname(),
    pid: process.pid,
    features: [
      'projects',
      'projects.board',
      'scenarios',
      'scenarios.from_script',
      'scenarios.view',
      'scenarios.edit',
      'runs.read',
      'runs.thumbs',
      'runs.dry',
      'runs.capture',
      'runs.pause',
      'runs.live',
      'jobs',
      'hooks',
      'env.reset',
      'approvals',
      'auth.status',
      'auth.login',
      'auth.for_scenario',
      'auth.cancel_sign_in',
      'sandbox.status',
      'sandbox.up',
      'sandbox.reset',
      'renders',
      'renders.plan',
      'renders.of_scenario',
      'renders.frame',
      'renders.outline',
      'timeline.view',
      'reviews',
      'reviews.image',
      'exports',
      'templates.read',
      'templates.preview',
      'templates.create',
      'templates.from_site',
      'templates.edit',
      'components.read',
      'components.create',
      'components.preview',
      'components.library',
      'inspect',
      'record',
      'record.studio',
      'comments',
      'comments.studio',
      'comments.anchor',
      'comments.counts',
      'comments.proposals',
      'comments.apply',
      'history',
    ],
    entitlements: entitlements(),
  });
}
