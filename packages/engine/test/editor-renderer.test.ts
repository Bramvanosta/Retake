/**
 * The product's renderer as a composition root makes it (src/render/editor-renderer.ts), with the editor replaced at
 * the engine's loader: nothing is loaded before the first request, the driver is made once, a load that failed is not
 * kept (the next request loads again), and a preview backend handed to a test becomes the previews of the renderer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loads: 0, failNext: 0, made: 0, backends: [] as unknown[], asked: [] as string[] }));

vi.mock('../src/lazy.js', () => ({
  editor: async () => {
    state.loads++;
    if (state.failNext > 0) {
      state.failNext--;
      throw new Error('the editor could not be loaded');
    }
    const previews = (name: string) => ({
      bundle: async () => (state.asked.push(`${name}.bundle`), { hash: name, cached: false }),
      open: async () => (state.asked.push(`${name}.open`), {}),
    });
    return {
      createRenderer: () => {
        state.made++;
        return {
          video: async () => (state.asked.push('driver.video'), { file: 'v' }),
          stills: async () => (state.asked.push('driver.stills'), ['s']),
          previews: previews('driver'),
        };
      },
      previewDriver: (backend: unknown) => {
        state.backends.push(backend);
        return previews('backend');
      },
    };
  },
}));

import { editorRenderer, withPreviewBackend } from '../src/render/editor-renderer.js';

beforeEach(() => {
  Object.assign(state, { loads: 0, failNext: 0, made: 0, backends: [], asked: [] });
});

describe('the editor\'s driver behind the port', () => {
  it('loads nothing before the first request, then makes the driver once for every request', async () => {
    const r = editorRenderer();
    expect(state.loads).toBe(0);
    await r.video({} as never);
    await r.stills({} as never);
    const b = await r.previews.bundle({} as never);
    await r.previews.open(b, {} as never);
    expect(state.asked).toEqual(['driver.video', 'driver.stills', 'driver.bundle', 'driver.open']);
    expect([state.loads, state.made]).toEqual([1, 1]);
  });

  it('a load that failed is not kept: the request fails with it, the next one loads again and renders', async () => {
    const r = editorRenderer();
    state.failNext = 1;
    await expect(r.video({} as never)).rejects.toThrow('the editor could not be loaded');
    expect([state.loads, state.made]).toEqual([1, 0]);
    await expect(r.video({} as never)).resolves.toEqual({ file: 'v' });
    await r.stills({} as never);
    expect([state.loads, state.made]).toEqual([2, 1]);
  });

  it('requests that wait on the same failed load all fail with it, and none of them keeps it', async () => {
    const r = editorRenderer();
    state.failNext = 1;
    const both = await Promise.allSettled([r.video({} as never), r.stills({} as never)]);
    expect(both.map((x) => x.status)).toEqual(['rejected', 'rejected']);
    expect(state.loads).toBe(1);
    await r.video({} as never);
    expect([state.loads, state.made]).toEqual([2, 1]);
  });
});

describe('a renderer with its previews on a preview backend', () => {
  it('draws previews with the editor\'s driver of that backend (made once, on first use) and everything else with the renderer', async () => {
    const backend = { bundle: async () => ({}), open: async () => ({}) };
    const r = withPreviewBackend(editorRenderer(), backend as never);
    expect(state.backends).toEqual([]);
    const b = await r.previews.bundle({} as never);
    await r.previews.open(b, {} as never);
    await r.video({} as never);
    await r.stills({} as never);
    expect(state.asked).toEqual(['backend.bundle', 'backend.open', 'driver.video', 'driver.stills']);
    expect(state.backends).toEqual([backend]);
  });
});
