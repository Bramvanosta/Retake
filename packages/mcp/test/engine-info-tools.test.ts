/**
 * engine_info and the app's downloaded Tools: their state and the ones not ready in `data.tools`, and a
 * summary clause only while they are not ready (Claude tells the person, who downloads them: no MCP tool does) — never
 * in a checkout.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BundleInfo } from '@retake/core/io';
import { createEngine } from '@retake/engine';
import { fakeToolsBundle, placeTool, toolFixtures } from '@retake/test-support/tools';
import type { FixtureTools } from '@retake/test-support/tools';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { TOOLS } from '../src/index.js';

const roots: string[] = [];
let fx: FixtureTools;
let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'engine-info-tools-'));
  roots.push(base);
  fx = await toolFixtures(join(base, 'fx'));
});
afterAll(async () => {
  // The placed Tools are read-only, as installed.
  for (const r of roots) spawnSync('/bin/chmod', ['-R', 'u+w', r]);
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

let n = 0;
async function info(bundle: BundleInfo | null, place: boolean) {
  const root = join(base, `ws${n}`);
  const home = join(base, `home${n++}`);
  await mkdir(root, { recursive: true });
  await fixtureWorkspace(root);
  if (place) for (const t of fx.tools) placeTool(join(home, 'tools'), t);
  const engine = await createEngine({ root, client: 'test', autoStartWorker: false, ports: { env: { ...process.env, RETAKE_HOME: home } }, tools: { bundle } });
  const tool = TOOLS.find((t) => t.name === 'engine_info')!;
  return tool.run({}, { engine, startedIn: root, signal: new AbortController().signal });
}

describe('engine_info: the Tools', () => {
  it('in a checkout: state checkout, no clause', async () => {
    const r = await info(null, false);
    expect(r.data.tools).toEqual({ state: 'checkout', missing: [] });
    expect(r.summary).not.toContain('Tools (');
  });

  it('in the app, not downloaded: each one named, and who downloads them; ready: no clause', async () => {
    const app = fakeToolsBundle(join(base, 'app'), fx.entries);
    const r = await info(app, false);
    expect(r.data.tools).toEqual({ state: 'needed', missing: ['render-browser', 'compositor', 'browser'] });
    expect(r.summary).toContain(
      "The app's downloaded Tools (render-browser, compositor, browser): not downloaded yet — the person downloads them (the Studio's set-up, or `retake tools install`); captures and renders wait in the queue and start by themselves once they are checked.",
    );
    const ready = await info(app, true);
    expect(ready.data.tools).toEqual({ state: 'ready', missing: [] });
    expect(ready.summary).not.toContain('Tools (');
  });

  it('no MCP tool downloads, checks or removes the Tools', () => {
    expect(TOOLS.map((t) => t.name).filter((name) => /^tools_|download/.test(name))).toEqual([]);
  });
});
