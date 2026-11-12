/**
 * L4.7 `preview` jobs with a `library` target (engine preview-job.ts + library.ts), run by the worker in this process
 * with an injected backend (no Remotion, no browser: files written by the test's stand-in): the Studio's keys
 * (`components.library`) are the worker's for every registry component in three themes (all cached after the jobs);
 * committed posters only for fresh built-ins in the editorial starter by real path (not a copy of it, not a workspace
 * override of a built-in id); two jobs over disjoint components use one whole-registry bundle; a throwing component gets
 * failed.json (its reason under untrusted) and the others go on, a failed key is left alone without Retry and rendered
 * again with it; a full disk stops the job with "the disk has N MB free" and leaves no entry or temporary folder of the
 * keys it did not finish; the disk gate in the worker; a key the client did not compute is reported, the entry written
 * under the worker's; a loop too large to keep; refusals at submit. ⚑ Review A M3 / B H1: a component that throws at
 * module load fails alone (the others rendered with their own components), its failed.json carries the registry
 * bundle's hash; once the registry changes the failure reads missing and is rendered again without a Retry.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createComponent } from '@retake/components';
import { bundleHash } from '@retake/editor';
import type { ComponentPreviewSpec, PreviewBackend } from '@retake/editor';
import { LIBRARY_FILES, createEngine, editorRenderer, libraryCacheDir, runWorker, withPreviewBackend } from '../src/index.js';
import type { Engine, FreeBytes, JobRecord, LibraryStatesView, PreviewJobResult, WorkerPortsGiven } from '../src/index.js';
import { REPO } from '@retake/test-support/repo';
import { scratchHome } from '@retake/test-support/home';

/** The scaffold's writer in these tests: plain files (the engine's project store in the CLI and the engine). */
const plainWrite = async (file: string, text: string): Promise<void> => {
  nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
  nodeFs.writeFileSync(file, text);
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('poster')]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from('loop')]);

let root: string;
let engine: Engine;
const retakeHome = scratchHome();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-library-job-'));
  retakeHome.use(join(root, '.home'));
  await mkdir(join(root, 'templates'), { recursive: true });
  for (const t of ['editorial', 'motion', 'default']) await cp(join(REPO, 'templates', t), join(root, 'templates', t), { recursive: true });
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  const dir = join(root, 'projects', 'demo');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  await createComponent(root, { write: plainWrite, id: 'acme/thrower', kind: 'card', description: 'A card that throws.' });
  // A workspace override of a built-in id: never the built-in's committed poster.
  await createComponent(root, { write: plainWrite, id: 'studio/card-chart', kind: 'card', description: 'An override.' });
  engine = await createEngine({ root, client: 'test', autoStartWorker: false });
});

afterAll(async () => {
  retakeHome.restore();
  if (root) await rm(root, { recursive: true, force: true });
});

interface Fake extends PreviewBackend {
  calls: string[];
}

/** A stand-in for Remotion: `remotion-<hash>` folders for bundles, small PNG / GIF files for frames. */
function fake(o: { fail?: (spec: ComponentPreviewSpec, what: 'still' | 'gif') => void; gifBytes?: number } = {}): Fake {
  const calls: string[] = [];
  return {
    calls,
    async bundle({ root: r, components }) {
      const hash = await bundleHash(components);
      const dir = join(r, '.retake', 'cache', `remotion-${hash}`);
      await mkdir(dir, { recursive: true });
      return { serveUrl: dir, hash, cached: false };
    },
    async open() {
      return {
        async still(spec, file) {
          calls.push(`still ${spec.main.id}`);
          o.fail?.(spec, 'still');
          await writeFile(file, PNG);
        },
        async gif(spec, file) {
          calls.push(`gif ${spec.main.id}`);
          o.fail?.(spec, 'gif');
          await writeFile(file, o.gifBytes ? Buffer.concat([GIF, Buffer.alloc(o.gifBytes)]) : GIF);
        },
        warnings: () => [],
        close: async () => undefined,
      };
    },
  };
}

const plenty: FreeBytes = async () => 50_000_000_000;

/** The stand-ins of a library job: a preview backend in place of Remotion, the free space the disk gate sees. */
interface LibraryStandIns {
  backend?: PreviewBackend;
  freeBytes?: FreeBytes;
}

/** The worker's ports of these stand-ins (L7.29: the backend draws the previews of the worker's renderer). */
const libraryPorts = (test: LibraryStandIns): WorkerPortsGiven => ({
  ...(test.backend ? { renderer: withPreviewBackend(editorRenderer(), test.backend) } : {}),
  ...(test.freeBytes ? { freeBytes: test.freeBytes } : {}),
});

async function work(test: LibraryStandIns, id: string): Promise<JobRecord> {
  await runWorker({ root, once: true, idleExitMs: 0, pollMs: 20, log: () => undefined, ports: libraryPorts(test) });
  return engine.jobs.get(id);
}

/** Submit and run one library job of these components (poster + loop, the keys of `states`). */
async function renderLibrary(
  states: LibraryStatesView,
  ids: string[],
  test: LibraryStandIns,
  o: { template?: string; retry?: boolean; what?: 'poster' | 'loop' | 'both' } = {},
): Promise<{ job: JobRecord; result: PreviewJobResult }> {
  const what = o.what ?? 'both';
  const items = ids.map((id) => {
    const s = states.items.find((i) => i.component === id)!;
    return { component: id, ...(what !== 'loop' ? { poster: s.poster.key } : {}), ...(what !== 'poster' ? { loop: s.loop.key } : {}) };
  });
  const sub = await engine.components.libraryRender({ project: 'demo', ...(o.template ? { template: o.template } : {}), items, ...(o.retry ? { retry: true } : {}) });
  const job = await work(test, sub.job.id);
  return { job, result: job.result as PreviewJobResult };
}

const cache = () => libraryCacheDir({ root });

describe('library preview jobs (injected backend)', () => {
  it("the Studio's keys are the worker's for every component in three themes; committed posters by real path only", async () => {
    // A copy of the editorial starter (same files, so the same keys) is not the starter: no committed poster.
    await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
    try {
      const copy = await engine.components.library({ project: 'demo', template: 'editorial', components: ['studio/card-title'] });
      expect(copy.theme.editorial_starter).toBe(false);
      expect(copy.items[0].poster.state).toBe('missing');
    } finally {
      await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    }
    for (const template of ['editorial', 'motion', 'default']) {
      const states = await engine.components.library({ project: 'demo', template });
      const ids = states.items.map((i) => i.component);
      expect(ids.length).toBeGreaterThan(40);
      if (template === 'editorial') {
        expect(states.theme.editorial_starter).toBe(true);
        expect(states.items.find((i) => i.component === 'studio/intro-stack')!.poster.state).toBe('committed');
        expect(states.items.find((i) => i.component === 'studio/card-chart')!.poster.state).toBe('missing');
        expect(states.items.find((i) => i.component === 'acme/thrower')!.poster.state).toBe('missing');
      } else expect(states.items.every((i) => i.poster.state === 'missing')).toBe(true);
      expect(states.items.every((i) => i.loop.state === 'missing')).toBe(true);
      const renderable = ids.filter((id) => id !== 'acme/thrower');
      for (let i = 0; i < renderable.length; i += 12) {
        const { job, result } = await renderLibrary(states, renderable.slice(i, i + 12), { backend: fake(), freeBytes: plenty }, { template });
        expect(job.state, job.error?.message).toBe('succeeded');
        expect(result.library!.changed).toBe(0);
        expect(result.library!.entries.every((e) => e.state === 'written')).toBe(true);
      }
      const after = await engine.components.library({ project: 'demo', template });
      for (const it of after.items) {
        if (it.component === 'acme/thrower') continue;
        expect([it.component, it.poster.state, it.loop.state]).toEqual([it.component, 'cached', 'cached']);
      }
      expect(after.items.map((i) => [i.poster.key, i.loop.key])).toEqual(states.items.map((i) => [i.poster.key, i.loop.key]));
    }
  });

  it('two jobs over disjoint components share one whole-registry bundle', async () => {
    await rm(join(root, '.retake', 'cache'), { recursive: true, force: true });
    const states = await engine.components.library({ project: 'demo', template: 'motion' });
    const backend = fake();
    const a = await renderLibrary(states, ['studio/intro-stack'], { backend, freeBytes: plenty }, { template: 'motion', what: 'poster' });
    const b = await renderLibrary(states, ['studio/overlay-callout'], { backend, freeBytes: plenty }, { template: 'motion', what: 'loop' });
    expect([a.job.state, b.job.state]).toEqual(['succeeded', 'succeeded']);
    expect(a.result.library!.bundle!.hash).toBe(b.result.library!.bundle!.hash);
    const bundles = (await readdir(join(root, '.retake', 'cache'))).filter((n) => n.startsWith('remotion-'));
    expect(bundles).toHaveLength(1);
    expect(backend.calls).toEqual(['still studio/intro-stack', 'gif studio/overlay-callout']);
  });

  it('a throwing component gets failed.json and the others go on; no Retry: left alone; Retry: rendered again', async () => {
    const states = await engine.components.library({ project: 'demo', template: 'editorial', components: ['acme/thrower', 'studio/card-title'] });
    const throwing = fake({
      fail: (spec) => {
        if (spec.main.id === 'acme/thrower') throw new Error('thrower exploded \u202e<b>bold</b>');
      },
    });
    const { job, result } = await renderLibrary(states, ['acme/thrower', 'studio/card-title'], { backend: throwing, freeBytes: plenty });
    expect(job.state).toBe('succeeded');
    expect(result.library!.entries.map((e) => [e.component, e.kind, e.state])).toEqual([
      ['acme/thrower', 'poster', 'failed'],
      ['acme/thrower', 'loop', 'failed'],
      ['studio/card-title', 'poster', 'written'],
      ['studio/card-title', 'loop', 'written'],
    ]);
    // The component's words: under untrusted, on one line without the direction override.
    expect(result.untrusted.failures).toEqual([{ component: 'acme/thrower', reason: 'its preview failed: thrower exploded <b>bold</b>' }]);
    const thrower = (await engine.components.library({ project: 'demo', template: 'editorial', components: ['acme/thrower'] })).items[0];
    expect(thrower.poster).toMatchObject({ state: 'failed', untrusted: { reason: 'its preview failed: thrower exploded <b>bold</b>' } });
    expect(existsSync(join(cache(), thrower.poster.key, LIBRARY_FILES.failed))).toBe(true);
    expect(existsSync(join(cache(), thrower.poster.key, LIBRARY_FILES.poster))).toBe(false);

    const quiet = fake();
    const again = await renderLibrary(states, ['acme/thrower'], { backend: quiet, freeBytes: plenty });
    expect(again.result.library!.entries.map((e) => e.state)).toEqual(['kept_failed', 'kept_failed']);
    expect(quiet.calls).toEqual([]);
    const retried = await renderLibrary(states, ['acme/thrower'], { backend: quiet, freeBytes: plenty }, { retry: true });
    expect(retried.result.library!.entries.map((e) => e.state)).toEqual(['written', 'written']);
    expect(quiet.calls).toEqual(['still acme/thrower', 'gif acme/thrower']);
    const now = (await engine.components.library({ project: 'demo', template: 'editorial', components: ['acme/thrower'] })).items[0];
    expect([now.poster.state, now.loop.state]).toEqual(['cached', 'cached']);
  });

  it('⚑ review A M3 / B H1: a component that throws at module load fails alone; fixed, its failure reads missing and renders without Retry', async () => {
    await rm(cache(), { recursive: true, force: true });
    // A stand-in whose page loads every bundled module: a bundle holding acme/thrower throws on every render while broken.
    let broken = true;
    const pages = new Map<string, string[]>();
    const calls: string[] = [];
    const page: PreviewBackend = {
      async bundle({ root: r, components }) {
        const hash = await bundleHash(components);
        const dir = join(r, '.retake', 'cache', `remotion-${hash}`);
        await mkdir(dir, { recursive: true });
        pages.set(
          dir,
          components.map((c) => c.id),
        );
        return { serveUrl: dir, hash, cached: false };
      },
      async open({ serveUrl }) {
        const loads = pages.get(serveUrl)!;
        const draw = async (what: string, spec: ComponentPreviewSpec, file: string, bytes: Buffer) => {
          calls.push(`${what} ${spec.main.id} ${loads.length}`);
          if (broken && loads.includes('acme/thrower')) throw new Error(`boom at load (${root}/components/acme/thrower/index.tsx)`);
          await writeFile(file, bytes);
        };
        return { still: (spec, file) => draw('still', spec, file, PNG), gif: (spec, file) => draw('gif', spec, file, GIF), warnings: () => [], close: async () => undefined };
      },
    };
    const ids = ['studio/card-title', 'acme/thrower', 'studio/intro-stack'];
    const states = await engine.components.library({ project: 'demo', template: 'motion', components: ids });
    const { job, result } = await renderLibrary(states, ids, { backend: page, freeBytes: plenty }, { template: 'motion' });
    expect(job.state, job.error?.message).toBe('succeeded');
    // The built-ins are written (rendered again with their own components), only the broken component failed.
    expect(result.library!.entries.map((e) => [e.component, e.kind, e.state])).toEqual([
      ['studio/card-title', 'poster', 'written'],
      ['studio/card-title', 'loop', 'written'],
      ['acme/thrower', 'poster', 'failed'],
      ['acme/thrower', 'loop', 'failed'],
      ['studio/intro-stack', 'poster', 'written'],
      ['studio/intro-stack', 'loop', 'written'],
    ]);
    // Review A L2: the workspace's part of the path is cut from the reason the job keeps.
    expect(result.untrusted.failures).toEqual([{ component: 'acme/thrower', reason: 'its preview failed: boom at load (components/acme/thrower/index.tsx)' }]);
    const thrower = states.items.find((i) => i.component === 'acme/thrower')!;
    const failure = JSON.parse(await readFile(join(cache(), thrower.poster.key, LIBRARY_FILES.failed), 'utf8'));
    const registryHash = failure.bundle as string;
    expect(registryHash).toMatch(/^[0-9a-f]{16}$/);
    expect((await engine.components.library({ project: 'demo', template: 'motion', components: ['acme/thrower'] })).items[0].poster.state).toBe('failed');
    // Nothing changed: left alone without a Retry.
    const quiet = await renderLibrary(states, ['acme/thrower'], { backend: page, freeBytes: plenty }, { template: 'motion' });
    expect(quiet.result.library!.entries.map((e) => e.state)).toEqual(['kept_failed', 'kept_failed']);

    // The component is fixed: another registry state. Its failure is stale (missing) and renders without a Retry.
    broken = false;
    const entry = join(root, 'components', 'acme', 'thrower', 'index.tsx');
    await writeFile(entry, `${await readFile(entry, 'utf8')}\n// fixed\n`);
    const fixed = await engine.components.library({ project: 'demo', template: 'motion', components: ['acme/thrower'] });
    expect([fixed.items[0].poster.state, fixed.items[0].loop.state]).toEqual(['missing', 'missing']);
    const again = await renderLibrary(fixed, ['acme/thrower'], { backend: page, freeBytes: plenty }, { template: 'motion' });
    expect(again.result.library!.entries.map((e) => e.state)).toEqual(['written', 'written']);
    // A failure recorded under another registry (or by an older Retake, without one) is never kept.
    const stalePoster = (await engine.components.library({ project: 'demo', template: 'motion', components: ['studio/outro-stack'] })).items[0];
    const dir = join(cache(), stalePoster.poster.key);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, LIBRARY_FILES.failed),
      JSON.stringify({
        format: 1,
        key: stalePoster.poster.key,
        kind: 'poster',
        component: 'studio/outro-stack',
        theme: { name: 'motion', hash: 'x' },
        at: new Date().toISOString(),
        reason: 'old',
        bundle: registryHash,
      }),
    );
    expect((await engine.components.library({ project: 'demo', template: 'motion', components: ['studio/outro-stack'] })).items[0].poster.state).toBe('missing');
    const rerun = await renderLibrary({ theme: fixed.theme, items: [stalePoster] }, ['studio/outro-stack'], { backend: page, freeBytes: plenty }, { template: 'motion', what: 'poster' });
    expect(rerun.result.library!.entries.map((e) => e.state)).toEqual(['written']);
  });

  it('a full disk stops the job with what is left; nothing of the keys it did not finish stays; the gate in the worker', async () => {
    await rm(cache(), { recursive: true, force: true });
    const ids = ['studio/intro-stack', 'studio/outro-stack', 'studio/card-title'];
    const states = await engine.components.library({ project: 'demo', template: 'default', components: ids });
    const nospace = fake({
      fail: (spec, what) => {
        if (spec.main.id === 'studio/outro-stack' && what === 'gif') throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      },
    });
    // Plenty at the start (the gate), 300 MB once the disk filled.
    let asked = 0;
    const filling = async () => (asked++ === 0 ? 50_000_000_000 : 300_000_000);
    const { job } = await renderLibrary(states, ids, { backend: nospace, freeBytes: filling }, { template: 'default' });
    expect(job.state).toBe('failed');
    expect(job.error).toMatchObject({ code: 'refused', message: expect.stringMatching(/^the disk has 300 MB free: library previews need at least 1 GB free/) });
    expect(nospace.calls.some((c) => c.includes('card-title'))).toBe(false);
    const after = await engine.components.library({ project: 'demo', template: 'default', components: ids });
    expect(after.items.map((i) => [i.component, i.poster.state, i.loop.state])).toEqual([
      ['studio/intro-stack', 'cached', 'cached'],
      ['studio/outro-stack', 'missing', 'missing'],
      ['studio/card-title', 'missing', 'missing'],
    ]);
    const names = await readdir(cache());
    expect(names.filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(names.sort()).toEqual([after.items[0].poster.key, after.items[0].loop.key].sort());

    // Under 1 GB at the start: refused before anything is rendered.
    const idle = fake();
    const gated = await renderLibrary(after, ['studio/card-title'], { backend: idle, freeBytes: async () => 900_000_000 }, { template: 'default' });
    expect(gated.job.state).toBe('failed');
    expect(gated.job.error?.message).toMatch(/^the disk has 900 MB free/);
    expect(idle.calls).toEqual([]);
  });

  it("a key the client did not compute is reported and the entry lies under the worker's; a loop too large is kept as such", async () => {
    const states = await engine.components.library({ project: 'demo', template: 'motion', components: ['studio/card-title', 'studio/interstitial-clock'] });
    await rm(cache(), { recursive: true, force: true });
    const stale = 'f'.repeat(32);
    const sub = await engine.components.libraryRender({ project: 'demo', template: 'motion', items: [{ component: 'studio/card-title', loop: stale }] });
    const job = await work({ backend: fake(), freeBytes: plenty }, sub.job.id);
    const r = job.result as PreviewJobResult;
    expect(r.library!.changed).toBe(1);
    expect(r.library!.entries).toEqual([{ component: 'studio/card-title', kind: 'loop', key: states.items[0].loop.key, state: expect.stringMatching(/^(written|cached)$/), expected: stale }]);
    expect(existsSync(join(cache(), stale))).toBe(false);

    const big = await renderLibrary(states, ['studio/interstitial-clock'], { backend: fake({ gifBytes: 1_600_000 }), freeBytes: plenty }, { template: 'motion', what: 'loop' });
    expect(big.result.library!.entries[0].state).toBe('too_large');
    const meta = JSON.parse(await readFile(join(cache(), states.items[1].loop.key, LIBRARY_FILES.meta), 'utf8'));
    expect(meta).toMatchObject({ kind: 'loop', state: 'too_large', component: 'studio/interstitial-clock', theme: { name: 'motion' } });
    expect((await engine.components.library({ project: 'demo', template: 'motion', components: ['studio/interstitial-clock'] })).items[0].loop.state).toBe('too_large');
  });

  it('refusals at submit: more than 12, a path, an unknown component, nothing asked, a malformed key', async () => {
    const k = '0'.repeat(32);
    const many = Array.from({ length: 13 }, () => ({ component: 'studio/card-title', poster: k })).map((x, i) => ({ ...x, component: i ? `studio/c${i}` : x.component }));
    await expect(engine.components.libraryRender({ project: 'demo', items: many })).rejects.toMatchObject({ code: 'invalid' });
    await expect(engine.components.libraryRender({ project: 'demo', items: [{ component: '../x', poster: k }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(engine.components.libraryRender({ project: 'demo', items: [{ component: 'acme/nope', poster: k }] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(engine.components.libraryRender({ project: 'demo', items: [{ component: 'studio/card-title' }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(engine.components.libraryRender({ project: 'demo', items: [{ component: 'studio/card-title', poster: '../../x' }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(engine.components.library({ project: 'demo', components: ['acme/nope'] })).rejects.toMatchObject({ code: 'not_found' });
  });
});
