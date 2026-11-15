/**
 * What an engine remembers between calls is its own (facade/context.ts EngineCaches): the versions of the scenario
 * files and themes it showed or wrote — an undo / redo `restore` writes back only one of those, so another engine of
 * the same process (a second Studio server, an MCP server, a test) never restores what only the first one showed — and
 * its memos (the component registry, the timeline's, the render list's, the theme editor's), never shared.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineError, createEngine } from '../src/index.js';
import { RenderMemos } from '../src/renders.js';
import { ThemeEditMemos } from '../src/theme-edit.js';
import { TimelineMemos, RegistryMemo } from '../src/views/timeline-view.js';
import { VersionLedger } from '../src/version-ledger.js';
import type { Engine } from '../src/index.js';
import { scratchHome } from '@retake/test-support/home';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const PROJECT = 'name: W\nenvironments:\n  local:\n    console: http://127.0.0.1:4997\ncapture: {width: 1280, height: 720, scale: 1, fps: 30}\ntemplate: default\n';
const V0 = 'video: v0\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n';
const V1 = V0.replace('video: v0', 'video: v1');

let ws: string;
let file: string;
let a: Engine;
let b: Engine;
const retakeHome = scratchHome();

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-engine-caches-'));
  retakeHome.use(join(ws, '.home'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  const dir = join(ws, 'projects', 'w');
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), PROJECT);
  file = join(dir, 'scenarios', 'one.yaml');
  await writeFile(file, V0);
  // Two engines of one process on one workspace: the Studio's client, as two Studio servers would be.
  a = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
  b = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
});

afterAll(async () => {
  retakeHome.restore();
  await rm(ws, { recursive: true, force: true });
});

describe("an engine's caches are its own", () => {
  it('restore writes back only a version this engine showed or wrote: another engine of the process is refused it', async () => {
    // Engine a shows v0, then writes v1: it knows both.
    expect((await a.scenarios.get('w', 'one')).hash).toBe(sha(V0));
    const w1 = await a.scenarios.edit('w', 'one', {
      hash: sha(V0),
      edit: { kind: 'replace_text', text: V1 },
    });
    expect(w1.hash).toBe(sha(V1));
    // Engine b shows v1 only: its undo to v0 is refused, nothing written.
    expect((await b.scenarios.get('w', 'one')).hash).toBe(sha(V1));
    const e = await refusal(
      b.scenarios.edit('w', 'one', {
        hash: sha(V1),
        edit: { kind: 'restore', text: V0, text_hash: sha(V0) },
      }),
    );
    expect(e).toMatchObject({
      code: 'refused',
      details: { argument: 'edit.text_hash' },
    });
    expect(e.message).toMatch(/not a version of scenarios\/one\.yaml the Studio showed or wrote/);
    expect(await readFile(file, 'utf8')).toBe(V1);
    // Engine a, which showed v0, restores it byte for byte.
    const back = await a.scenarios.edit('w', 'one', {
      hash: sha(V1),
      edit: { kind: 'restore', text: V0, text_hash: sha(V0) },
    });
    expect(back.hash).toBe(sha(V0));
    expect(await readFile(file, 'utf8')).toBe(V0);
    // And b, which has now shown v0 too (a read of today's file), may undo to it later.
    expect((await b.scenarios.get('w', 'one')).hash).toBe(sha(V0));
  });

  it("each engine's component registry is its own, reused while the components are unchanged", async () => {
    const ra = await a.components.registry();
    expect(await a.components.registry()).toBe(ra);
    const rb = await b.components.registry();
    expect(rb).not.toBe(ra);
    expect(await b.components.registry()).toBe(rb);
  });

  it('the memo classes hold nothing of another instance: a ledger, the timeline and render memos, the theme editor', () => {
    const one = new VersionLedger();
    const two = new VersionLedger();
    one.remember('/x', 'h');
    expect([one.knows('/x', 'h'), two.knows('/x', 'h')]).toEqual([true, false]);
    const t1 = new ThemeEditMemos();
    t1.versions.remember('/t', 'h');
    expect(new ThemeEditMemos().versions.knows('/t', 'h')).toBe(false);
    const registry = new RegistryMemo();
    const tl = new TimelineMemos(registry);
    tl.music.set('k', 1);
    expect(new TimelineMemos(new RegistryMemo()).music.size).toBe(0);
    tl.clear();
    expect(tl.music.size).toBe(0);
    const r = new RenderMemos();
    r.planSigs.set('k', 'sig');
    expect(new RenderMemos().planSigs.size).toBe(0);
  });
});
