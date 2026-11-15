/**
 * One preview session (./preview.ts): the specs built with the asset server's URLs, one bundle (the components shown, or
 * the whole registry), one renderer, and the caller's step per item.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { errorKindOf, errorMessage } from '@retake/core/base';
import type { LoadedTemplate } from '@retake/core/theme';
import type { RenderSettings } from '@retake/core/model';
import type { WorkPolicy } from '@retake/core/policy';
import { paramDefaults, themeTokens } from '@retake/components';
import type { ComponentRegistry, JsonSchemaNode } from '@retake/components';
import { buildComponentPreview, loadPreviewSamples } from '../preview.js';
import type { BuiltPreview, PreviewSamples } from '../preview.js';
import type { PreviewComponentTarget } from '../work-types.js';
import { startAssetServer } from './asset-server.js';
import { registryBundleComponents, scaffoldComponents } from './bundle.js';
import type { BundleComponent } from './bundle.js';
import { handedDriver } from './driver-guard.js';
import type { DriverPreviewBundle, DriverPreviewSession, RenderDriver } from './driver-types.js';
import type { BrowserProcessInfo } from './network-guard.js';
import { REMOTION_PREVIEW_BACKEND, previewDriver } from './preview-backend.js';
import type { PreviewBackend } from './preview-backend.js';
import { handedRegistry } from './registry-source.js';
import type { RenderNetwork } from './render.js';
import { RenderCancelledError, RenderDiskFullError, RenderError, isDiskFullError } from './types.js';

/** Which components a preview session bundles. */
export type PreviewBundleMode =
  /** The targets and the context components their specs use (one bundle per set: the default). */
  | 'used'
  /** Every usable registry component and the scaffolds: one bundle per registry state, whatever the targets. */
  | 'registry';

/** What every preview session takes. */
export interface PreviewSessionOptions {
  /** What the work runs under (core WorkPolicy): which ffmpeg and render browser, its workspace's render settings. */
  workPolicy: WorkPolicy;
  /** Workspace root (bundle cache). */
  root: string;
  /** Theme of the previews (the committed built-in previews use the editorial theme). */
  template: LoadedTemplate;
  /** Context components (the theme's layout, caption, card) come from it: required, a preview loads no registry by itself. */
  registry: ComponentRegistry;
  cacheDir?: string;
  samples?: PreviewSamples;
  /** Checked between previews: an abort stops before the next one (RenderCancelledError). */
  signal?: AbortSignal;
  /** `guard`: the previews' Chromium loads only the asset and bundle servers (network-guard.ts; the jobs worker). */
  network?: RenderNetwork;
  /** Called once the browser runs, with its process (the jobs worker records it to kill it after a crash). */
  onBrowser?: (b: BrowserProcessInfo) => void;
  /** Receives the guard's blocked-origin warnings once the previews are done. */
  onWarnings?: (warnings: string[]) => void;
  /** Bundle the components shown (default) or the whole registry. */
  bundle?: PreviewBundleMode;
  /** What renders the previews (no such key: this package's driver — Remotion, with `cacheDir`; with one, `cacheDir` and `backend` are refused: driver-guard.ts). */
  renderer?: Pick<RenderDriver, 'previews'>;
  /** Tests of this package, standalone: render with this instead of Remotion. Never beside `renderer` (refused). */
  backend?: PreviewBackend;
  /** Render settings over the process's (./policy.ts). */
  settings?: RenderSettings;
}

/** A component of a session that could not be built or rendered. `reason` may carry the component's own words: untrusted text. */
export interface PreviewFailure {
  id: string;
  reason: string;
}

function bundleComponentOf(t: Pick<PreviewComponentTarget, 'id' | 'dir' | 'entry' | 'manifest'>): BundleComponent {
  return { id: t.id, kind: t.manifest.kind, dir: t.dir, entry: t.entry, defaults: paramDefaults(t.manifest.params as JsonSchemaNode | undefined) };
}

/**
 * The bundle components of the previews: every component shown (targets + context) and the per-kind scaffolds. A target
 * that IS a package scaffold (same id, same folder) is bundled once, as the scaffold (flagged: the bundle guard's
 * "belongs to no component" holder check does not apply to the package's own kit imports); any other target — a
 * workspace component reusing a scaffold's id from another folder — stays unflagged, under the holder check. Exported
 * for its test (editor preview-scaffold.test.ts).
 */
export async function previewBundleComponents(targets: readonly PreviewComponentTarget[], ids: readonly string[], registry: ComponentRegistry): Promise<BundleComponent[]> {
  const out = new Map<string, BundleComponent>();
  for (const t of targets) out.set(t.id, bundleComponentOf(t));
  for (const id of ids) {
    if (out.has(id)) continue;
    const info = registry.get(id);
    out.set(id, bundleComponentOf({ id, dir: info.dir, entry: info.entry, manifest: info.manifest }));
  }
  // A scaffold shown as a target is the scaffold itself: once, flagged (its kit imports are the package's own, the
  // first run that previewed every scaffold at once met the bundle guard's "belongs to no component").
  const scaffolds = await scaffoldComponents();
  for (const s of scaffolds) if (out.has(s.id) && resolve(out.get(s.id)!.dir) === resolve(s.dir)) out.delete(s.id);
  return [...out.values(), ...scaffolds];
}

/**
 * The whole registry's bundle components; a target outside the registry (a scaffold, a folder) is added, and a target
 * whose folder differs from its registry entry's replaces it (the bundle then is that set's own).
 */
async function registryPreviewComponents(targets: readonly PreviewComponentTarget[], registry: ComponentRegistry): Promise<BundleComponent[]> {
  const all = await registryBundleComponents(registry);
  const byId = new Map(all.map((c) => [c.id, c]));
  for (const t of targets) {
    const have = byId.get(t.id);
    if (!have || resolve(have.dir) !== resolve(t.dir) || resolve(have.entry) !== resolve(t.entry)) byId.set(t.id, bundleComponentOf(t));
  }
  return [...byId.values()];
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RenderCancelledError();
}

export type Variant = 'still' | 'motion';

export interface SessionJob {
  target: PreviewComponentTarget;
  variants: readonly Variant[];
}

export interface SessionItem<J extends SessionJob> {
  job: J;
  previews: Partial<Record<Variant, BuiltPreview>>;
}

export interface SessionContext {
  renderer: DriverPreviewSession;
  /** A scratch folder of this session (removed at its end). */
  scratch: string;
  /** What the work runs under (core WorkPolicy): the ffmpeg that quantizes a poster. */
  workPolicy: WorkPolicy;
}

/** A failed item of a session and the step it failed at (a `bundle` / `render` failure may be another component's). */
export interface SessionFailure<J> extends PreviewFailure {
  job: J;
  step: 'build' | 'bundle' | 'render';
}

type AssetServer = Awaited<ReturnType<typeof startAssetServer>>;

/** The built previews of each job's variants (the theme's assets served by `server`); a job that does not build is `fail`ed. */
function buildSessionItems<J extends SessionJob>(
  jobs: readonly J[],
  c: { template: LoadedTemplate; registry: ComponentRegistry; samples: PreviewSamples; server: AssetServer },
  fail: (job: J, e: unknown) => void,
): Array<SessionItem<J>> {
  const { template: tpl, registry, samples, server } = c;
  const tokens = themeTokens(tpl, {
    logo: server.urlFor(tpl.assets.logo),
    wordmark: tpl.assets.wordmark ? server.urlFor(tpl.assets.wordmark) : undefined,
    fonts: { display: server.urlFor(tpl.assets.display), body: tpl.assets.body.map((f) => server.urlFor(f)) },
  });
  const built: Array<SessionItem<J>> = [];
  for (const job of jobs) {
    const { target } = job;
    try {
      const previews: SessionItem<J>['previews'] = {};
      for (const v of job.variants) {
        previews[v] = buildComponentPreview({
          target,
          template: tpl,
          tokens,
          registry,
          samples,
          sampleUrl: (f) => server.urlFor(f),
          ...(target.slots ? { slots: target.slots } : {}),
          ...(target.params ? { params: target.params } : {}),
          ...(target.at !== undefined ? { at: target.at } : {}),
          ...(v === 'motion' ? { motion: true } : {}),
        });
      }
      built.push({ job, previews });
    } catch (e) {
      fail(job, e);
    }
  }
  return built;
}

/**
 * One preview session: specs built with the asset server's URLs, one bundle, one renderer; `each` per item. `isolate`:
 * an item that fails to build or render becomes a failure and the next goes on (else the first failure throws) — and
 * the renderer is opened afresh before the next item (a failed composition select can leave its pinned port taken:
 * every later item would fail for that alone); `o.bundleFailure: 'items'`: a bundle that does not build
 * fails every item instead of the session. A full disk and a cancel always stop the session.
 */
export async function previewSession<J extends SessionJob, R>(
  opts: PreviewSessionOptions,
  jobs: readonly J[],
  isolate: boolean,
  each: (ctx: SessionContext, item: SessionItem<J>, index: number) => Promise<R>,
  o: { bundleFailure?: 'throw' | 'items'; onFailure?: (f: SessionFailure<J>) => void } = {},
): Promise<{ results: Array<{ job: J; value: R }>; failed: Array<SessionFailure<J>>; bundle: { hash: string; cached: boolean } | null; warnings: string[] }> {
  const failed: Array<SessionFailure<J>> = [];
  const results: Array<{ job: J; value: R }> = [];
  // A renderer handed renders the previews, alone (with `backend` or `cacheDir` beside it the session is refused:
  // driver-guard.ts); standalone, the previews are this package's, on `backend` when a test hands one.
  const previews = handedDriver('preview', opts, 'previews')?.previews ?? previewDriver(opts.backend ?? REMOTION_PREVIEW_BACKEND, opts.cacheDir ? { cacheDir: opts.cacheDir } : {});
  // The context components come from the registry its caller hands: a preview loads none by itself.
  const registry = handedRegistry(opts.registry, 'preview');
  if (jobs.length === 0) return { results, failed, bundle: null, warnings: [] };
  cancelled(opts.signal);
  const root = resolve(opts.root);
  const samples = opts.samples ?? loadPreviewSamples();
  const server = await startAssetServer();
  const fail = (job: J, e: unknown, what: string, step: SessionFailure<J>['step']): void => {
    const id = job.target.id;
    const reason = `${what}: ${(e as Error)?.message ?? String(e)}`;
    if (!isolate) throw e instanceof RenderError ? e : new RenderError(`preview of ${id}: ${(e as Error)?.message ?? String(e)}`);
    const f = { id, reason, job, step };
    failed.push(f);
    o.onFailure?.(f);
  };
  const built = buildSessionItems(jobs, { template: opts.template, registry, samples, server }, (job, e) => fail(job, e, 'its preview could not be built', 'build'));
  if (built.length === 0) {
    await server.close();
    return { results, failed, bundle: null, warnings: [] };
  }
  let renderer: DriverPreviewSession | undefined;
  const scratch = join(tmpdir(), `retake-preview-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const targets = built.map((b) => b.job.target);
    const components =
      opts.bundle === 'registry'
        ? await registryPreviewComponents(targets, registry)
        : await previewBundleComponents(targets, [...new Set(built.flatMap((b) => Object.values(b.previews).flatMap((p) => p!.components)))], registry);
    let bundle: DriverPreviewBundle;
    try {
      bundle = await previews.bundle({ root, components, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (e) {
      if (o.bundleFailure !== 'items' || errorKindOf(e) === 'cancelled' || opts.signal?.aborted || isDiskFullError(e)) throw e;
      for (const b of built) fail(b.job, e, 'its preview could not be bundled', 'bundle');
      return { results, failed, bundle: null, warnings: [] };
    }
    const open = () =>
      previews.open(bundle, {
        assets: server.prefix,
        ...(opts.network ? { network: opts.network } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onBrowser ? { onProcess: opts.onBrowser } : {}),
        ...(opts.settings ? { settings: opts.settings } : {}),
        workPolicy: opts.workPolicy,
      });
    renderer = await open();
    await mkdir(scratch, { recursive: true });
    const warnings = new Set<string>();
    for (let i = 0; i < built.length; i++) {
      cancelled(opts.signal);
      const item = built[i];
      try {
        results.push({ job: item.job, value: await each({ renderer, scratch, workPolicy: opts.workPolicy }, item, i) });
      } catch (e) {
        if (errorKindOf(e) === 'cancelled' || opts.signal?.aborted) throw new RenderCancelledError();
        if (isDiskFullError(e)) throw new RenderDiskFullError(`preview of ${item.job.target.id}: ${errorMessage(e)}`);
        fail(item.job, e, 'its preview failed', 'render');
        if (i < built.length - 1) {
          for (const w of renderer.warnings()) warnings.add(w);
          const old = renderer;
          renderer = undefined;
          await old.close().catch(() => undefined);
          renderer = await open();
        }
      }
    }
    for (const w of renderer.warnings()) warnings.add(w);
    opts.onWarnings?.([...warnings]);
    return { results, failed, bundle: { hash: bundle.hash, cached: bundle.cached }, warnings: [...warnings] };
  } catch (e) {
    if (e instanceof RenderError) throw e;
    if (opts.signal?.aborted || errorKindOf(e) === 'cancelled') throw new RenderCancelledError();
    if (isDiskFullError(e)) throw new RenderDiskFullError(`component previews: ${errorMessage(e)}`);
    throw new RenderError(`component previews failed: ${errorMessage(e)}`);
  } finally {
    await renderer?.close().catch(() => undefined);
    await server.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
