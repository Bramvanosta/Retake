/**
 * "Prune only keeps more" (L7.7, R-FLD-28), held by the suite: a seeded generator of run-folder layouts, each pruned
 * (dry) by the product and by a FROZEN copy of the rule for takes as it was before the lot. The product never lists a
 * take the frozen rule kept, and what both list is listed for the same reason.
 *
 * The frozen copy below is not to follow the product: it is what the property is measured against.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isMadeRunId, parseRenderId, renderIdOf } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { pruneProject } from '../src/index.js';
import { writeWorkspace } from '../../core/test/fixtures/records/build.js';
import type { StateSpec } from '../../core/test/fixtures/records/build.js';
import { BARE, buildLayout } from '../../core/test/fixtures/records/prune-layouts.js';
import type { Layout, LayoutRenderFile, LayoutRun } from '../../core/test/fixtures/records/prune-layouts.js';
import type { RenderFileSpec } from '../../core/test/fixtures/records/build-renders.js';

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

// ════════════════════════════════════════════════════════════════════════════
// The renders (L7.6b). The property is "a subset": every render and review item of the product is an item of the
// frozen rule with the same reason and the same paths or fewer (and no id is listed twice), every take the frozen rule
// protected through a render is not listed, and where the frozen rule throws the product answers a list none of whose
// items is a file that made it throw. (Before the lot's prune part the product WAS the frozen rule, and this test held
// the two lists equal, layout by layout.)
// ════════════════════════════════════════════════════════════════════════════

// ── FROZEN: what prune listed of renders/ and review/ before L7.6b (editor render-record.ts readRenderRecords and
// isRenderRecord, engine prune.ts lines 202-203 (`sameName`, `unreadRender`), 208-247 and 264-265, all at 126f8c2), its
// throw included — line for line but for the inputs: `unreadBy` is HEAD's over the scenarios whose threads do not all
// read (`unread`; the generated layouts hold none, so it says no), `parseRenderId` and `renderIdOf` are core's id
// grammar, which the lot does not touch. Not to follow the product. ──
interface OldRender {
  id: string;
  scenario: string;
  variant: unknown;
  status: string;
  created_at: string;
  run_id: string;
}
interface OldRenders {
  /** `render <id>` → reason and paths (relative to the project), once per record that is no kept one — a list, as the rule may list an id twice. */
  renders: Array<{ id: string; reason: string; paths: string[] }>;
  reviews: Array<{ id: string; reason: string }>;
  /** The run ids a kept record names. */
  protectedRuns: Set<string>;
  keptRenders: number;
}
/** The files of renders/ whose record the frozen rule reads and cannot order: what makes it throw (their names without `.json`). Not part of the frozen rule: the test's own reading of why it threw. */
async function oldThrowers(projectDir: string): Promise<Set<string>> {
  const dir = join(projectDir, 'renders');
  const out = new Set<string>();
  for (const f of (await readdir(dir).catch(() => [] as string[])).filter((x) => x.endsWith('.json') && !x.startsWith('.'))) {
    try {
      const r = JSON.parse(await readFile(join(dir, f), 'utf8')) as { version?: unknown; id?: unknown; plan?: unknown; created_at?: unknown } | null;
      if (!!r && r.version === 1 && typeof r.id === 'string' && !!r.plan && typeof r.created_at !== 'string') out.add(f.slice(0, -5));
    } catch {
      // not a render record
    }
  }
  return out;
}
async function oldRenders(projectDir: string, o: { keep: number; threadRenders: ReadonlySet<string>; busy: (id: string) => boolean; unread?: ReadonlySet<string> }): Promise<OldRenders> {
  const keepOf = o.unread ?? new Set<string>();
  const unreadBy = (...is: Array<(s: string) => boolean>): boolean => [...keepOf].some((s) => is.some((f) => f(s)));
  const sameName = (a: unknown, s: string): boolean => typeof a === 'string' && a.toLowerCase() === s.toLowerCase();
  const unreadRender = (r: { id: string; scenario: string }) => unreadBy((s) => sameName(r.scenario, s), (s) => sameName(parseRenderId(r.id)?.scenario, s));
  const dir = join(projectDir, 'renders');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    files = [];
  }
  const renders: OldRender[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(await readFile(join(dir, f), 'utf8')) as (OldRender & { version?: unknown; plan?: unknown }) | null;
      if (!!r && r.version === 1 && typeof r.id === 'string' && !!r.plan) renders.push(r);
    } catch {
      // not a render record
    }
  }
  renders.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const rendersFiles = await readdir(dir).catch(() => [] as string[]);
  const kept = new Set<string>();
  const groups = new Map<string, OldRender[]>();
  for (const r of renders) {
    if (!(typeof r.scenario === 'string' && renderIdOf(r.id, r.scenario) !== null)) {
      if (r.status === 'succeeded') kept.add(r.id);
      continue;
    }
    const key = `${r.scenario} ${String(r.variant)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }
  for (const g of groups.values()) {
    const ok = g.filter((r) => r.status === 'succeeded').sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const r of ok.slice(-o.keep)) kept.add(r.id);
  }
  for (const r of renders) if (unreadRender(r) || o.threadRenders.has(r.id) || o.busy(r.id)) kept.add(r.id);
  const out: OldRenders = { renders: [], reviews: [], protectedRuns: new Set(), keptRenders: 0 };
  for (const r of renders) {
    if (kept.has(r.id)) continue;
    if (r.id === '' || r.id.startsWith('.')) continue;
    out.renders.push({ id: r.id, reason: r.status === 'succeeded' ? 'older render' : `${r.status} render`, paths: rendersFiles.filter((f) => f === `${r.id}.json` || f.startsWith(`${r.id}.`)).map((f) => `renders/${f}`) });
  }
  for (const name of await readdir(join(projectDir, 'review')).catch(() => [] as string[])) {
    if (name.startsWith('.')) continue;
    const path = join(projectDir, 'review', name);
    if (!(await lstat(path).catch(() => null))?.isDirectory()) continue;
    if (kept.has(name) || o.busy(name)) continue;
    out.reviews.push({ id: name, reason: renders.some((r) => r.id === name) ? 'review of an older render' : 'review of a deleted render' });
  }
  for (const r of renders) if (kept.has(r.id)) out.protectedRuns.add(r.run_id);
  out.keptRenders = kept.size;
  return out;
}
// ── end of the frozen copy ──

describe('prune only keeps more than it did before L7.6b: the renders', () => {
  const RENDER_LAYOUTS = 300;
  const RENDER_SEED = 20261112;

  it('generated renders/ folders (a fixed seed): the lists of renders and reviews are the frozen rule\'s or shorter, and no take it protected through a render is listed', async () => {
    const rnd = random(RENDER_SEED);
    const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
    const chance = (p: number): boolean => rnd() < p;
    const count = { layouts: 0, threw: 0, listed: 0, listedAfter: 0, shorter: 0, twice: 0, phantom: 0, reviews: 0, reviewsAfter: 0, protectedListedElsewhere: 0, unread: 0, firstList: 0, shapes: new Map<string, number>(), alone: new Map<string, number>(), said: new Map<string, number>() };
    const seen = (shape: string): void => void count.shapes.set(shape, (count.shapes.get(shape) ?? 0) + 1);
    const wrong: string[] = [];
    for (let n = 0; n < RENDER_LAYOUTS; n++) {
      // Three to five good captures (two scenarios in a share of the layouts): the takes a render may name.
      const runs: LayoutRun[] = [];
      for (let i = 0, k = 3 + Math.floor(rnd() * 3); i < k; i++) runs.push([`R${i}`, i + 1, 'good', { scenario: chance(0.25) ? 'other' : 'quote' }]);
      const label = () => pick(runs)[0];
      const files: LayoutRenderFile[] = [];
      const shape: string[] = [];
      const real: string[] = [];
      const at = (m: number): string => `2026-10-20T09:${String(m).padStart(2, '0')}:00.000Z`;
      // 0–7 records named as the tool names them, each with a twist in a share of the cases.
      for (let i = 0, k = Math.floor(rnd() * 8); i < k; i++) {
        const scenario = chance(0.2) ? 'other' : 'quote';
        const vertical = chance(0.15);
        const id = `${scenario}-v${i + 1}${vertical ? '-vertical' : ''}`;
        const spec: RenderFileSpec = { file: id, at: at(i + 1), set: { scenario, ...(vertical ? { variant: 'vertical' } : {}) } };
        const twist = chance(0.45) ? pick(TWISTS) : 'none';
        TWIST[twist]!(spec);
        const how = chance(0.08) ? 'link' : chance(0.03) ? 'dangling' : chance(0.02) ? 'big' : 'file';
        if (how === 'link') spec.link = true;
        if (how === 'dangling') spec.dangling = true;
        if (how === 'big') spec.big = true;
        if (chance(0.15)) spec.video = false;
        files.push({ spec, run: label() });
        real.push(id);
        shape.push(`${id}${twist === 'none' ? '' : `+${twist}`}${how === 'file' ? '' : `+${how}`}`);
        seen(twist);
        seen(how);
      }
      // 0–3 strays: files of renders/ that are no render of their own name.
      for (let i = 0, k = Math.floor(rnd() * 4); i < k; i++) {
        const target = real.length ? pick(real) : 'quote-v1';
        const kind = pick(STRAYS);
        const m = 10 + i;
        const stray: Record<(typeof STRAYS)[number], () => RenderFileSpec> = {
          // An exact copy of a record (its creation time is the original's only when the generator made it so: a share).
          copy: () => ({ file: `${target} copy`, id: target, at: at(chance(0.5) ? Number(/-v(\d+)/.exec(target)?.[1] ?? 1) : m), video: false }),
          'edited-copy': () => ({ file: `${target}-backup`, id: target, at: at(40 + i), set: { scenario: chance(0.5) ? 'other' : 'quote' }, video: false }),
          renamed: () => ({ file: `quote-final${i || ''}`, id: chance(0.5) ? target : `quote-v${20 + i}`, at: at(chance(0.5) ? 0 : m) }),
          // The shapes that make "the said id is kept" necessary: a file saying a real record's id under another
          // scenario, with a newer date, or with a thread on it.
          'keep-other-scenario': () => ({ file: `keep${i || ''}`, id: target, at: at(0), set: { scenario: 'other' }, video: false }),
          'keep-newer': () => ({ file: `keep${i || ''}`, id: target, at: at(50 + i), video: false }),
          'final-says-original': () => ({ file: `${target}.final`, id: target, at: at(m) }),
          'final-says-itself': () => ({ file: `${target}.final`, at: at(m) }),
          out: () => ({ file: `cut-${i}`, at: at(m), ...(chance(0.3) ? { set: { status: 'failed', error: 'x' } } : {}) }),
          'empty-id': () => ({ file: `x${i}`, id: '', at: at(m) }),
          null: () => ({ file: `stray${i}`, raw: 'null' }),
          array: () => ({ file: `stray${i}`, raw: '[]' }),
          'not-json': () => ({ file: `stray${i}`, raw: '{"version": 1, "id": "quo' }),
          'link-to-copy': () => ({ file: `linked${i}`, id: target, at: at(m), link: true, video: false }),
          'big-stray': () => ({ file: `big${i}`, id: target, at: at(m), big: true, video: false }),
        };
        const spec = stray[kind]();
        if (files.some((f) => f.spec.file === spec.file)) continue;
        files.push({ spec, run: label() });
        shape.push(`${spec.file}(${kind}→${spec.id ?? spec.file})`);
        seen(kind);
      }
      // Reviews of some renders, of a stray and of a render that is gone; a thread and a busy id in a share.
      const reviews = [...new Set([...real.filter(() => chance(0.3)), ...(chance(0.2) ? ['quote-final'] : []), ...(chance(0.2) ? ['quote-v99'] : [])])];
      const threadOn = real.length && chance(0.2) ? pick(real) : undefined;
      const busyId = real.length && chance(0.1) ? pick(real) : undefined;
      const layout: Layout = { about: 'generated renders', runs, files, reviews, ...(threadOn ? { threads: [{ scenario: threadOn.startsWith('other') ? 'other' : 'quote', on: { render: threadOn, run: label() } }] } : {}) };
      const b = buildLayout(root, 'generated', { slug: `r-${String(n).padStart(3, '0')}`, layout });
      const project = { slug: b.slug, dir: b.dir, root, config: { name: 'P', environments: {} }, readme: null, scenarios: [], file: join(b.dir, 'project.yaml') } as unknown as LoadedProject;
      const busy = (id: string): boolean => id === busyId;
      const where = `${b.slug} [${shape.join(', ')}]${threadOn ? ` thread on ${threadOn}` : ''}${busyId ? ` busy ${busyId}` : ''}`;
      const threadRuns = threadOn ? layout.threads!.map((t) => b.ids[t.on!.run]!) : [];
      count.layouts++;
      // The last three renders of a scenario and variant (the default), or the last one (so that most layouts list some).
      const keep = chance(0.5) ? 1 : 3;
      const before = await oldRenders(b.dir, { keep, threadRenders: new Set(threadOn ? [threadOn] : []), busy }).catch((e: unknown) => e as Error);
      const after = await pruneProject(project, { dry_run: true, keep_renders: keep, busy }).catch((e: unknown) => e as Error);
      // The product never throws on a file of renders/: it answers a list in every layout.
      if (after instanceof Error) {
        wrong.push(`${where}: the product throws "${after.message}"`);
        continue;
      }
      const rel = (p: string): string => p.slice(b.dir.length + 1);
      const renderItems = after.items.filter((i) => i.kind === 'render');
      const reviewItems = after.items.filter((i) => i.kind === 'review');
      for (const k of after.kept_takes ?? []) count.said.set(k.why, (count.said.get(k.why) ?? 0) + 1);
      for (const a of after.renders_alone?.reasons ?? []) count.alone.set(a.why, (count.alone.get(a.why) ?? 0) + a.count);
      // What stays is said: the files left alone are counted and named under `untrusted` only, a file too big to read
      // keeps everything, and the count of renders kept is the count of record files that stay.
      const jsonFiles = (await readdir(join(b.dir, 'renders')).catch(() => [] as string[])).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
      if (after.kept.renders !== jsonFiles.length - renderItems.length) wrong.push(`${where}: kept ${after.kept.renders} renders of ${jsonFiles.length} record files with ${renderItems.length} listed`);
      if ((after.renders_alone?.count ?? 0) !== (after.untrusted?.renders_alone.length ?? 0)) wrong.push(`${where}: ${after.renders_alone?.count} files left alone, ${after.untrusted?.renders_alone.length} named`);
      if (after.renders_unread !== undefined) {
        count.unread++;
        if (after.items.length) wrong.push(`${where}: a file of renders/ is too big to read and ${after.items.length} items are listed`);
      }
      if (new Set(renderItems.map((i) => i.id)).size < renderItems.length) wrong.push(`${where}: a render is listed twice`);
      for (const i of renderItems) if (i.paths.length === 0 || !i.paths.map(rel).includes(`renders/${i.id}.json`)) wrong.push(`${where}: render ${i.id} is listed without its own record file`);
      if (before instanceof Error) {
        count.threw++;
        // The frozen rule threw: no list to compare with. The product's first list holds none of the files that made it throw.
        const throwers = await oldThrowers(b.dir);
        if (throwers.size === 0) wrong.push(`${where}: the frozen rule throws "${before.message}" and no file explains it`);
        for (const i of renderItems) {
          if (throwers.has(i.id) || i.paths.map(rel).some((p) => [...throwers].some((t) => p === `renders/${t}.json`))) wrong.push(`${where}: lists ${i.id}, a file that made the frozen rule throw`);
        }
        if (after.items.length) count.firstList++;
        continue;
      }
      // Subset: every render item is one of the frozen rule's, for the same reason, with the same paths or fewer.
      for (const i of renderItems) {
        const was = before.renders.filter((x) => x.id === i.id);
        const paths = i.paths.map(rel);
        if (!was.length) wrong.push(`${where}: lists render ${i.id} (${i.reason}), which the frozen rule kept`);
        else if (!was.some((x) => x.reason === i.reason)) wrong.push(`${where}: render ${i.id} was "${was[0]!.reason}", is "${i.reason}"`);
        else if (!was.some((x) => paths.every((p) => x.paths.includes(p)))) wrong.push(`${where}: render ${i.id} has a path the frozen rule did not list: ${paths.join(' ')} (frozen: ${was.map((x) => x.paths.join(' ')).join(' | ')})`);
      }
      // … every review item too …
      for (const i of reviewItems) {
        const was = before.reviews.find((x) => x.id === i.id);
        if (!was) wrong.push(`${where}: lists review ${i.id} (${i.reason}), which the frozen rule kept`);
        else if (was.reason !== i.reason) wrong.push(`${where}: review ${i.id} was "${was.reason}", is "${i.reason}"`);
      }
      // … and no take the frozen rule protected through a render, or a thread names, is listed.
      for (const i of after.items.filter((x) => x.kind === 'run')) {
        if (before.protectedRuns.has(i.id) || threadRuns.includes(i.id)) wrong.push(`${where}: lists run ${i.id}, which a kept render or a thread names`);
      }
      count.listed += before.renders.length;
      count.listedAfter += renderItems.length;
      if (renderItems.length < before.renders.length) count.shorter++;
      count.reviews += before.reviews.length;
      count.reviewsAfter += reviewItems.length;
      if (new Set(before.renders.map((r) => r.id)).size < before.renders.length) count.twice++;
      if (before.renders.some((r) => r.paths.length === 0)) count.phantom++;
      if (after.items.some((x) => x.kind === 'run')) count.protectedListedElsewhere++;
    }
    expect(wrong).toEqual([]);
    // The generator is not idle: the frozen rule lists renders and reviews, throws in a share of the layouts, lists an
    // id twice and a line without a file in some, runs are listed in some, and every twist and every stray is met.
    expect(count.listed).toBeGreaterThan(150);
    expect(count.reviews).toBeGreaterThan(30);
    expect(count.threw).toBeGreaterThan(20);
    expect(count.threw).toBeLessThan(RENDER_LAYOUTS / 2);
    expect(count.twice).toBeGreaterThan(0);
    expect(count.phantom).toBeGreaterThan(0);
    expect(count.protectedListedElsewhere).toBeGreaterThan(20);
    expect([...count.shapes.keys()].sort()).toEqual([...new Set([...TWISTS, ...STRAYS, 'none', 'file', 'link', 'dangling', 'big'])].sort());
    // … the product still lists renders and reviews, fewer of them, in fewer layouts; it answers a first list where the
    // frozen rule threw; and every reason a file is left alone for, the take kept for such a file and the file too big
    // to read are each met.
    expect(count.listedAfter).toBeGreaterThan(40);
    expect(count.listedAfter).toBeLessThan(count.listed);
    expect(count.reviewsAfter).toBeGreaterThan(5);
    expect(count.reviewsAfter).toBeLessThan(count.reviews);
    expect(count.shorter).toBeGreaterThan(30);
    expect(count.firstList).toBeGreaterThan(5);
    expect(count.unread).toBeGreaterThan(3);
    expect([...count.alone.keys()].sort()).toEqual(['incomplete', 'linked', 'newer-format', 'renamed', 'too-big', 'unknown-status', 'unreadable']);
    expect(count.said.get('render-file') ?? 0).toBeGreaterThan(5);
  }, 240_000);
});

/** What a generated record may have that a written one has not (the states of render-states.json and the model's twists). */
const TWIST: Record<string, (s: RenderFileSpec) => void> = {
  none: () => undefined,
  failed: (s) => void (s.set = { ...s.set, status: 'failed', error: 'x' }),
  cancelled: (s) => void (s.set = { ...s.set, status: 'cancelled', error: 'x' }),
  paused: (s) => void (s.set = { ...s.set, status: 'paused' }),
  'no-status': (s) => void (s.unset = [...(s.unset ?? []), 'status']),
  'version-2': (s) => void (s.set = { ...s.set, version: 2 }),
  'no-plan': (s) => void (s.unset = [...(s.unset ?? []), 'plan']),
  'plan-5': (s) => void (s.set = { ...s.set, plan: 5 }),
  'no-created': (s) => void (s.unset = [...(s.unset ?? []), 'created_at']),
  'created-5': (s) => void (s.set = { ...s.set, created_at: 5 }),
  'scenario-other': (s) => void (s.set = { ...s.set, scenario: s.set?.scenario === 'other' ? 'quote' : 'other' }),
  'scenario-7': (s) => void (s.set = { ...s.set, scenario: 7 }),
  'no-variant': (s) => void (s.unset = [...(s.unset ?? []), 'variant']),
  'variant-cube': (s) => void (s.set = { ...s.set, variant: 'cube' }),
  // A member prune groups or orders by whose value is no text (the fix pass of L7.6b: a non-text variant read as
  // absent merged two groups). The text "undefined" groups with an absent variant before and after the lot.
  'variant-5': (s) => void (s.set = { ...s.set, variant: 5 }),
  'variant-null': (s) => void (s.set = { ...s.set, variant: null }),
  'variant-array': (s) => void (s.set = { ...s.set, variant: [] }),
  'variant-object': (s) => void (s.set = { ...s.set, variant: {} }),
  'variant-undefined-text': (s) => void (s.set = { ...s.set, variant: 'undefined' }),
  'scenario-null': (s) => void (s.set = { ...s.set, scenario: null }),
  'created-null': (s) => void (s.set = { ...s.set, created_at: null }),
  'status-5': (s) => void (s.set = { ...s.set, status: 5 }),
  'id-5': (s) => void (s.set = { ...s.set, id: 5 }),
  'no-run-id': (s) => void (s.unset = [...(s.unset ?? []), 'run_id']),
  'not-json': (s) => void (s.raw = '{"version": 1, "id": "quo'),
};
const TWISTS = Object.keys(TWIST).filter((k) => k !== 'none');
const STRAYS = ['copy', 'edited-copy', 'renamed', 'keep-other-scenario', 'keep-newer', 'final-says-original', 'final-says-itself', 'out', 'empty-id', 'null', 'array', 'not-json', 'link-to-copy', 'big-stray'] as const;
