/**
 * The gate below the catalogue: the product's adapters of the ports that run a project's code — the hook runner, the
 * sandboxes, the capture runner (every browser it launches: a run, a recording, a sign-in or a session's check, a js
 * hook's page) and the renderer (videos, stills, component previews) — refuse an imported project not trusted
 * (trust.ts importTrust), whoever calls them: an operation the allow-list missed, a CLI command, a later caller, a
 * check of the machine (`retake doctor`'s sandbox probe). Defence in depth: the operations, the worker and the CLI
 * refuse first, in their own words.
 *
 * Each port is wrapped in a Proxy, so the adapter keeps its own members and its `this`; only the members that start
 * something check first. A sandbox of an untrusted project still opens (nothing runs to open one) and still stops
 * (`down`, `killStartedSync`): every other member refuses. A renderer request is judged by every folder it names —
 * its registry's project components, the plan's capture and assets, a preview's component folders — each checked
 * against the import marks of the project folder holding it (a folder with a project.yaml or an import marker).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { showHiddenCharsLine } from '@retake/core/base';
import { PROJECT_SLUG_RE, sandboxImagesOverride } from '@retake/core/project';
import { sandboxNames } from '@retake/core/sandbox';
import type { LoadedProject } from '@retake/core/project';
import type { EngineEnv } from '../env.js';
import { EngineError } from '../errors.js';
import type { ProductAdapters } from '../ports.js';
import type { Renderer, RenderRequestBase } from '../render/renderer.js';
import type { SandboxHandle } from '../sandboxes/sandboxes.js';
import { checkProjectTrusted, importMarkFile, importMarkerFile, importTrust, signedLoaded, untrustedError } from './trust.js';
import type { ImportMark } from './trust.js';
import { readSandboxSubset, subsetProblems } from './compose-read.js';

type Project = Pick<LoadedProject, 'root' | 'dir' | 'slug'>;

/** Throws when `p` is an imported project not trusted. */
async function checkProject(p: Project | undefined, env: EngineEnv): Promise<void> {
  if (p && typeof p.dir === 'string' && typeof p.root === 'string') await checkProjectTrusted({ root: p.root, dir: p.dir, slug: p.slug }, env);
}

/** The object `target` with the members of `wrap` in place of its own (its other members and `this` kept). */
function overlay<T extends object>(target: T, wrap: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(target, {
    get(t, k, r) {
      if (Object.hasOwn(wrap, k)) return (wrap as Record<string | symbol, unknown>)[k];
      const v = Reflect.get(t, k, r) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/** `f` (a member of `t`) called after `check(args)`. */
function checked<A extends unknown[], R>(t: object, f: (...a: A) => Promise<R>, check: (...a: A) => Promise<void>): (...a: A) => Promise<R> {
  return async (...a: A) => {
    await check(...a);
    return f.apply(t, a);
  };
}

/**
 * Throws when a folder of `paths`, or one above it, is the folder of an imported project not trusted (a folder holding
 * a project.yaml or an import marker, judged against the workspace `root`'s marks). Each folder is looked at once.
 */
export async function checkPathsTrusted(root: string, paths: readonly string[], env: EngineEnv): Promise<void> {
  const seen = new Set<string>();
  for (const p of paths) {
    if (typeof p !== 'string' || p === '') continue;
    let dir = resolve(p);
    for (let i = 0; i < 64 && !seen.has(dir); i++) {
      seen.add(dir);
      const slug = basename(dir);
      const marked = existsSync(importMarkerFile(dir)) || (PROJECT_SLUG_RE.test(slug) && existsSync(join(dir, 'project.yaml')) && existsSync(importMarkFile(root, slug)));
      if (marked) {
        const t = await importTrust({ root, dir, slug }, env);
        if (t.state === 'untrusted') throw untrustedError(slug, t.why);
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
}

/** The folders a render request names: its project's components and the plan's capture, music, tracks and assets. */
function requestPaths(req: RenderRequestBase & { plan?: unknown }): string[] {
  const out: string[] = [];
  if (req.registry?.projectComponentsDir) out.push(req.registry.projectComponentsDir);
  const plan = req.plan as { source?: { file?: unknown }; music?: { file?: unknown }; tracks?: Record<string, { file?: unknown }>; assets?: Record<string, unknown> } | undefined;
  const add = (v: unknown) => typeof v === 'string' && v !== '' && out.push(v);
  add(plan?.source?.file);
  add(plan?.music?.file);
  for (const t of Object.values(plan?.tracks ?? {})) add(t?.file);
  for (const a of Object.values(plan?.assets ?? {})) add(a);
  return out;
}

function guardRenderer(r: Renderer, env: EngineEnv): Renderer {
  const check = (req: RenderRequestBase & { plan?: unknown }) => checkPathsTrusted(req.root, requestPaths(req), env);
  const previews = overlay(r.previews, {
    bundle: checked(r.previews, r.previews.bundle, (o) =>
      checkPathsTrusted(
        o.root,
        o.components.map((c) => c.dir),
        env,
      ),
    ),
  });
  return overlay(r, { video: checked(r, r.video, check), stills: checked(r, r.stills, check), previews });
}

/** The members of a sandbox that only stop what runs (allowed on an untrusted project). */
const SANDBOX_STOPS: readonly (string | symbol)[] = ['down', 'killStartedSync'];
/** The members that start a sandbox's services (refused while its images wait to be loaded). */
const SANDBOX_STARTS: readonly (string | symbol)[] = ['up', 'prepareTake', 'reset'];

/** The handle with its members refused (`refused` says which: every one but the stops by default). */
function refusingHandle(h: SandboxHandle, error: Error, refused: (k: string | symbol) => boolean = (k) => !SANDBOX_STOPS.includes(k)): SandboxHandle {
  return new Proxy(h, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r) as unknown;
      if (typeof v !== 'function') return v;
      if (!refused(k)) return (v as (...a: unknown[]) => unknown).bind(t);
      return async () => {
        throw error;
      };
    },
  });
}

/** The refusal of starting a trusted import's sandbox whose images the archive carried and trust has not loaded yet. */
export function imagesWaitError(slug: string, env: string): EngineError {
  return new EngineError(
    'refused',
    `sandbox ${showHiddenCharsLine(env)} of ${showHiddenCharsLine(slug)} runs the images its project archive carried, and they are not loaded yet: start Docker, then run \`retake project trust ${showHiddenCharsLine(slug)} --images\` in a terminal`,
    { fix: `retake project trust ${showHiddenCharsLine(slug)} --images` },
  );
}

/**
 * What a trusted import's sandbox `env` may do with the images its archive carried: nothing to say (none carried), the
 * override to read (its file and the sha256 the signed mark records), or why its starts are refused — images not
 * loaded, a service whose image is missing, an override gone or changed since trust (it is then not read).
 */
export async function importedSandbox(
  mark: ImportMark,
  project: Pick<LoadedProject, 'dir' | 'slug'>,
  sbEnv: string,
  env: EngineEnv,
  sbFile?: string,
): Promise<{ override?: { file: string; sha256: string; text: string }; refused?: EngineError }> {
  const images = (mark.images ?? []).filter((i) => i.uses.some((u) => u.env === sbEnv));
  // Every imported sandbox runs only within the compose subset, read from its files now (compose-read.ts).
  const sbRel = sbFile;
  if (sbRel) {
    const carried = (e: string, sv: string) => (mark.images ?? []).some((i) => i.uses.some((u) => u.env === e && u.service === sv));
    const read = await readSandboxSubset(project.dir, sbEnv, sbRel, { mode: 'import', carried });
    const p = read ? subsetProblems([read]) : undefined;
    if (p)
      return {
        refused: new EngineError(
          'refused',
          `sandbox ${showHiddenCharsLine(sbEnv)} of ${showHiddenCharsLine(project.slug)} was imported and its compose files are outside the compose subset an archive hands over: it never starts through Retake (${p})`,
        ),
      };
  }
  if (!mark.images?.length) return {};
  const loaded = await signedLoaded(mark, env);
  if (images.some((i) => !loaded?.images[i.id])) return { refused: imagesWaitError(project.slug, sbEnv) };
  const missing = (loaded?.missing ?? []).filter((m) => m.env === sbEnv);
  const slug = showHiddenCharsLine(project.slug);
  if (missing.length)
    return {
      refused: new EngineError(
        'refused',
        `sandbox ${showHiddenCharsLine(sbEnv)} of ${slug} does not start: ${missing.map((m) => `service ${showHiddenCharsLine(m.service)} — ${showHiddenCharsLine(m.why)}`).join('; ')} — build or pull it yourself, then run \`retake project trust ${slug} --images\` again`,
        { fix: `retake project trust ${slug} --images` },
      ),
    };
  const sha256 = loaded?.overrides[sbEnv];
  const file = sandboxImagesOverride(project.dir, sbEnv);
  if (!sha256) return {};
  const text = verifiedOverride(file, sha256);
  if (text === undefined)
    return {
      refused: new EngineError(
        'refused',
        `the compose override of sandbox ${showHiddenCharsLine(sbEnv)} of ${slug} is gone or changed since trust wrote it (it is not read): run \`retake project trust ${slug} --images\` to write it again`,
        { fix: `retake project trust ${slug} --images` },
      ),
    };
  return { override: { file, sha256, text } };
}

/** The file's text when its bytes hash to `sha256` (read once: that very text goes to docker, never the file). */
function verifiedOverride(file: string, sha256: string): string | undefined {
  try {
    const bytes = readFileSync(file);
    return createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes.toString('utf8') : undefined;
  } catch {
    return undefined;
  }
}

function guardSandboxes(s: ProductAdapters['sandboxes'], env: EngineEnv): ProductAdapters['sandboxes'] {
  const share = s.share ? overlay(s.share, { compose: checked(s.share, s.share.compose, (project) => checkProject(project, env)) }) : undefined;
  return overlay(s, {
    open: async (project: LoadedProject, name: string | undefined, policy: Parameters<typeof s.open>[2]) => {
      const t = await importTrust({ root: project.root, dir: project.dir, slug: project.slug }, env);
      if (t.state !== 'trusted') {
        const handle = await s.open(project, name, policy);
        return t.state === 'untrusted' ? refusingHandle(handle, untrustedError(project.slug, t.why)) : handle;
      }
      // A trusted import: its override handed to the provider only from the signed mark, and only while it matches.
      const sbEnv = name ?? sandboxNames(project)[0] ?? '';
      const rel = project.config?.sandboxes?.[sbEnv];
      const at = await importedSandbox(t.mark, project, sbEnv, env, typeof rel === 'string' ? resolve(project.dir, rel) : undefined);
      const sb = project.sandboxes?.[sbEnv];
      const given = at.override && sb ? { ...project, sandboxes: { ...project.sandboxes, [sbEnv]: { ...sb, imagesOverride: at.override } } } : project;
      const handle = await s.open(given, name, policy);
      return at.refused ? refusingHandle(handle, at.refused, (k) => SANDBOX_STARTS.includes(k)) : handle;
    },
    init: checked(s, s.init, (project) => checkProject(project, env)),
    share,
  });
}

function guardHooks(h: ProductAdapters['hooks'], env: EngineEnv): ProductAdapters['hooks'] {
  if (!h.journals) return overlay(h, { run: checked(h, h.run, (_l, ctx) => checkProject(ctx.project, env)) });
  const journals = overlay(h.journals, {
    rollback: checked(h.journals, h.journals.rollback, (_l, ctx) => checkProject(ctx.project, env)),
    rollbackPending: checked(h.journals, h.journals.rollbackPending, (_d, ctx) => checkProject(ctx.project, env)),
  });
  return overlay(h, { run: checked(h, h.run, (_l, ctx) => checkProject(ctx.project, env)), journals });
}

function guardCapture(c: ProductAdapters['capture'], env: EngineEnv): ProductAdapters['capture'] {
  const of = (o: { project?: Project }) => checkProject(o.project, env);
  const sessions = overlay(c.sessions, { check: checked(c.sessions, c.sessions.check, of), signIn: checked(c.sessions, c.sessions.signIn, of) });
  // A js hook's page (its persona's auth reader reads the browser that page opened: gated there).
  const hookPages = overlay(c.hookPages, { open: checked(c.hookPages, c.hookPages.open, of) });
  return overlay(c, { run: checked(c, c.run, of), record: checked(c, c.record, of), sessions, hookPages });
}

/**
 * The product's adapters with the gate of an imported project not trusted on every member that runs its code (`env`:
 * whose Retake home's key judges a trust). The registries and the reviewer run no project code: as they are.
 */
export function guardUntrusted(a: ProductAdapters, env: EngineEnv): ProductAdapters {
  return {
    hooks: guardHooks(a.hooks, env),
    reviewer: a.reviewer,
    capture: guardCapture(a.capture, env),
    sandboxes: guardSandboxes(a.sandboxes, env),
    renderer: guardRenderer(a.renderer, env),
    registries: a.registries,
  };
}
