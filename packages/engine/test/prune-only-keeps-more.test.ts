/**
 * "Prune only keeps more" (L7.7, R-FLD-28), held by the suite: a seeded generator of run-folder layouts, each pruned
 * (dry) by the product and by a FROZEN copy of the rule for takes as it was before the lot. The product never lists a
 * take the frozen rule kept, and what both list is listed for the same reason.
 *
 * The frozen copy below is not to follow the product: it is what the property is measured against.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isMadeRunId } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { pruneProject } from '../src/index.js';
import { writeWorkspace } from '../../core/test/fixtures/records/build.js';
import type { StateSpec } from '../../core/test/fixtures/records/build.js';
import { BARE, buildLayout } from '../../core/test/fixtures/records/prune-layouts.js';
import type { Layout, LayoutRun } from '../../core/test/fixtures/records/prune-layouts.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'retake-prune-only-more-'));
  writeWorkspace(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// ── FROZEN: the takes prune listed before L7.7 (engine prune.ts at ab3e8f5: pruneReadRun, pruneLastCapture and the
// loop over runs/), without the keeps a thread, a render or a job gives — the layouts here hold none. ──
interface OldRun {
  id: string;
  status: string;
  mode?: unknown;
  scenario: string;
}
async function oldReadRun(dir: string): Promise<OldRun | null> {
  try {
    const r = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as OldRun | null;
    return r && typeof r.id === 'string' && typeof r.status === 'string' ? r : null;
  } catch {
    return null;
  }
}
const OLD_FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
/** `id → reason` of every take the old rule listed, and how many it kept. */
async function oldPrune(runsDir: string): Promise<{ listed: Map<string, string>; kept: number }> {
  const runs: OldRun[] = [];
  let kept = 0;
  for (const name of (await readdir(runsDir).catch(() => [] as string[])).sort()) {
    if (!isMadeRunId(name)) continue;
    const r = await oldReadRun(join(runsDir, name));
    if (r) runs.push({ ...r, id: name });
    else kept++;
  }
  const last = new Map<string, string>();
  for (const r of runs) if (r.mode === 'capture' && r.status === 'succeeded') last.set(r.scenario, r.id);
  const listed = new Map<string, string>();
  for (const r of runs) {
    if (!OLD_FINISHED.has(r.status) || last.get(r.scenario) === r.id) kept++;
    else listed.set(r.id, r.mode === 'dry' ? 'dry run' : r.status === 'succeeded' ? 'older capture nothing uses' : `${r.status} take`);
  }
  return { listed, kept };
}
// ── end of the frozen copy ──

/** A deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INTERRUPTED: StateSpec = { about: 'interrupted', record: { set: { status: 'interrupted' } } };
const NEWER_DRY: StateSpec = { about: 'newer, dry', record: { set: { version: 2, mode: 'dry' } } };
/** The states of a run folder (states.json, and the lot's own); the usual ones several times. */
const POOL: Array<string | StateSpec> = [
  ...['good', 'good', 'good', 'good', 't6', 't6', 't6', 'g', 'g', 'g', 'c', 'c', 'f', 'l', 'o', 'k1'],
  ...['a', 'b', 'd', 'e', 'gn', 'gf', 'h', 'i', 'j', 'k', 'of', 'p', 'p2', 'r', 's', 't5', 't7', 't9', 'hr', 'hf', 'v', 'k1f', 'k2'],
  ...[BARE('failed'), BARE('succeeded'), BARE('succeeded', 'dry'), INTERRUPTED, NEWER_DRY],
];
/** The states whose run.json can be moved out and linked (a real folder that holds one). */
const NO_LINKED_RECORD = new Set(['k', 'k1', 'k1f', 'k2']);

const LAYOUTS = 300;
const SEED = 20261111;

describe('prune only keeps more than it did before L7.7', () => {
  it('generated layouts (a fixed seed): no take is listed that the frozen rule kept, and a take both list has the same reason', async () => {
    const rnd = random(SEED);
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
    const count = { runs: 0, listedBefore: 0, listedAfter: 0, shorter: 0, said: new Map<string, number>() };
    const wrong: string[] = [];
    for (let n = 0; n < LAYOUTS; n++) {
      const scenarios = rnd() < 0.4 ? ['quote', 'other'] : ['quote'];
      const runs: LayoutRun[] = [];
      const shape: string[] = [];
      for (let i = 0, k = 1 + Math.floor(rnd() * 6); i < k; i++) {
        const state = pick(POOL);
        const scenario = pick(scenarios);
        const linkedRecord = !(typeof state === 'string' && NO_LINKED_RECORD.has(state)) && rnd() < 0.12;
        const hand = rnd() < 0.05;
        runs.push([`R${i}`, i + 1, state, { scenario, ...(linkedRecord ? { linkedRecord: true as const } : {}), ...(hand ? { name: `take${i}-${scenario}` } : {}) }]);
        shape.push(`${typeof state === 'string' ? state : state.about}${linkedRecord ? '+linked record' : ''}${hand ? '+hand' : ''}:${scenario}`);
      }
      const layout: Layout = { about: 'generated', runs };
      const b = buildLayout(root, 'generated', { slug: `g-${String(n).padStart(3, '0')}`, layout });
      const project = { slug: b.slug, dir: b.dir, root, config: { name: 'P', environments: {} }, readme: null, scenarios: [], file: join(b.dir, 'project.yaml') } as unknown as LoadedProject;
      const before = await oldPrune(b.runs);
      const after = await pruneProject(project, { dry_run: true });
      const listed = after.items.filter((i) => i.kind === 'run');
      for (const i of listed) {
        if (!before.listed.has(i.id)) wrong.push(`${b.slug} [${shape.join(', ')}]: lists ${i.id} (${i.reason}), which was kept`);
        else if (before.listed.get(i.id) !== i.reason) wrong.push(`${b.slug} [${shape.join(', ')}]: ${i.id} was "${before.listed.get(i.id)}", is "${i.reason}"`);
      }
      // Every take that left the list is one more take kept, and nothing else of the answer is a take's.
      const left = before.listed.size - listed.length;
      if (after.kept.runs !== before.kept + left || after.items.length !== listed.length) wrong.push(`${b.slug} [${shape.join(', ')}]: kept ${before.kept} → ${after.kept.runs} with ${left} off the list`);
      count.runs += runs.length;
      count.listedBefore += before.listed.size;
      count.listedAfter += listed.length;
      if (left > 0) count.shorter++;
      for (const k of after.kept_takes ?? []) count.said.set(k.why, (count.said.get(k.why) ?? 0) + 1);
    }
    expect(wrong).toEqual([]);
    // The generator is not idle: the frozen rule lists takes, the product lists fewer, and every reason is met.
    expect(count.listedBefore).toBeGreaterThan(200);
    expect(count.listedAfter).toBeLessThan(count.listedBefore);
    expect(count.shorter).toBeGreaterThan(50);
    expect([...count.said.keys()].sort()).toEqual(['complete', 'editable', 'linked', 'newer-format']);
  }, 120_000);
});
