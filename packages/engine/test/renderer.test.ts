/**
 * The renderer port: the contract suite on the in-memory renderer, and what only that one has (the requests it keeps,
 * the failure a test injects).
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import type { BundleComponent, ComponentPreviewSpec, EditPlan } from '@retake/editor';
import { MemoryRenderer } from '../src/render/memory-renderer.js';
import { rendererContract } from './renderer-contract.js';

let ws: string;
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-renderer-contract-'));
});
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

/** The in-memory renderer reads a plan's length only. */
const PLAN = { durationInFrames: 12, fps: 30, segments: [] } as unknown as EditPlan;
const component = (id: string): BundleComponent => ({ id, kind: 'card', dir: `/components/${id}`, entry: `/components/${id}/index.tsx`, defaults: {} });
const SPEC = { width: 1920, height: 1080, fps: 30, durationInFrames: 60, frame: 10 } as unknown as ComponentPreviewSpec;

let n = 0;
rendererContract('memory', async (name) => {
  const out = join(ws, `${name}-${n++}`);
  await mkdir(out, { recursive: true });
  let abort: AbortController | undefined;
  const renderer = new MemoryRenderer({ duringVideo: () => abort?.abort(), process: { pid: process.pid } });
  return {
    renderer,
    plan: PLAN,
    workPolicy: PERSON_POLICY,
    root: ws,
    out,
    cancelDuring: (a) => {
      abort = a;
      return { onProgress: () => undefined };
    },
    previews: { sets: [[component('acme/one')], [component('acme/two')]], spec: SPEC, assets: 'http://127.0.0.1:1/' },
  };
}, { previews: true });

describe('the in-memory renderer', () => {
  it('keeps every request, in order', async () => {
    const r = new MemoryRenderer();
    const out = join(ws, 'calls');
    await r.video({ workPolicy: PERSON_POLICY, plan: PLAN, out: join(out, 'a.mp4') });
    await r.stills({ workPolicy: PERSON_POLICY, plan: PLAN, frames: [{ frame: 1, out: join(out, 'a.png') }] });
    const b = await r.previews.bundle({ root: ws, components: [component('acme/one')] });
    await (await r.previews.open(b, { workPolicy: PERSON_POLICY, assets: 'http://127.0.0.1:1/' })).close();
    expect(r.calls.map((c) => c.op)).toEqual(['video', 'stills', 'previews.bundle', 'previews.open']);
    expect(r.calls[0].req).toMatchObject({ out: join(out, 'a.mp4') });
  });

  it('a failure thrown while a video renders is the render\'s, with its fields, and leaves nothing at `out`', async () => {
    const failure = Object.assign(new Error('the GPU went away'), { renderWarnings: ['one'], diskFull: true as const });
    const r = new MemoryRenderer({ duringVideo: () => { throw failure; } });
    const out = join(ws, 'failed', 'a.mp4');
    await expect(r.video({ workPolicy: PERSON_POLICY, plan: PLAN, out })).rejects.toBe(failure);
    expect(existsSync(out)).toBe(false);
  });
});
