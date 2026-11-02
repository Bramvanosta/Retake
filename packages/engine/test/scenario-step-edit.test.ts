/**
 * L4.3 part 2: step edits through the Studio's write path (engine scenarios.edit, the `ui` client): move / delete /
 * duplicate splice the file the view read (its hash as if_match), each step named by its guard (critique B2: stale →
 * a conflict with `details.stale`, nothing written); the spliced text must re-parse to exactly the intended value (the
 * verify: a splice that would change another value — a keep-chomped block scalar losing its blank line — is refused,
 * nothing written); every part-1 rule still applies (a blocked file refused whole, no new hidden character — a copy of
 * a step holding one included —, errors refuse); `restore` puts the exact earlier bytes back (undo). The view gives each
 * step its guard and lock, and marks a step moved since the run (LIS) that keeps its picture; comments_list's
 * `step_now` follows a moved step (critique B10).
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScenarioError, parseYaml, stepGuard } from '@demo-studio/core';
import { EngineError, createEngine } from '../src/index.js';
import type { Engine, StepBinding } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';
import { BLOCKS_YAML, capture, writeRun } from './synthetic-runs.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const P = 'northfield-fixture';
const CAP = '20261020-100000-blocks';
const RLO = String.fromCodePoint(0x202e);
let ws: string;
let dir: string;
let ui: Engine;
const savedHome = process.env.DEMO_STUDIO_HOME;
const file = (name: string) => join(dir, 'scenarios', `${name}.yaml`);
const stepsOf = (t: string, scene: string) => (parseYaml(t).value as { scenes: Array<{ id: string; steps: unknown[] }> }).scenes.find((s) => s.id === scene)!.steps;
const at = (t: string, scene: string, index: number) => ({ scene, index, guard: stepGuard(stepsOf(t, scene)[index]) });

async function put(name: string, text: string): Promise<string> {
  await writeFile(file(name), text);
  return sha(text);
}

async function failure(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

async function snapshot(name: string): Promise<{ bytes: string; mtime: number }> {
  return { bytes: (await readFile(file(name))).toString('hex'), mtime: (await stat(file(name))).mtimeMs };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-step-edit-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  dir = join(ws, 'projects', P);
  await writeFile(file('blocks'), BLOCKS_YAML);
  await writeRun(dir, capture(CAP, { video: false }));
  ui = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('move, delete, duplicate through scenarios.edit', () => {
  it("move: the file the view read, spliced (only the step's lines moved), the label, the step to select; restore puts the exact bytes back", async () => {
    const t0 = await readFile(file('quote'), 'utf8');
    const h0 = sha(t0);
    const v = await ui.scenarios.view(P, 'quote');
    expect(v.edit.blocks).toEqual({ ok: true });
    const request = v.blocks.entries.find((e) => e.type === 'scene' && e.id === 'request');
    if (request?.type !== 'scene') throw new Error('no request scene');
    expect(request.steps[4].guard).toBe(stepGuard(stepsOf(t0, 'request')[4]));
    expect(request.steps[4].locked).toBeUndefined();
    const r = await ui.scenarios.edit(P, 'quote', { hash: h0, edit: { kind: 'move_step', from: { scene: 'request', index: 4, guard: request.steps[4].guard! }, to: { scene: 'request', index: 0 } } });
    expect(r).toMatchObject({ file: 'scenarios/quote.yaml', label: 'Moved step 5 of request to position 1', select: 'request.0', notices: [] });
    const t1 = await readFile(file('quote'), 'utf8');
    expect(r.hash).toBe(sha(t1));
    const a = t0.split('\n');
    const i = a.indexOf('      - select: {field: Grind, option: Whole bean}');
    const j = a.indexOf('      - click: {role: button, name: Request a quote}');
    expect(t1.split('\n')).toEqual([...a.slice(0, j), a[i], ...a.slice(j, i), ...a.slice(i + 1)]);
    const back = await ui.scenarios.edit(P, 'quote', { hash: r.hash, edit: { kind: 'restore', text: t0, text_hash: h0 } });
    expect(back.hash).toBe(h0);
    expect(await readFile(file('quote'), 'utf8')).toBe(t0);
  });

  it('delete and duplicate: labels, notices, the step to select; the copy of a capture is renamed', async () => {
    const t0 = await readFile(file('quote'), 'utf8');
    const steps = stepsOf(t0, 'proposal');
    const i = steps.findIndex((s) => typeof s === 'object' && s !== null && 'download' in s);
    const d = await ui.scenarios.edit(P, 'quote', { hash: sha(t0), edit: { kind: 'duplicate_step', at: at(t0, 'proposal', i) } });
    expect(d).toMatchObject({ label: `Duplicated step ${i + 1} of proposal`, select: `proposal.${i + 1}`, notices: ['The copy saves its document as "quote-2": names of captures are unique (the original keeps "quote").'] });
    const t1 = await readFile(file('quote'), 'utf8');
    expect(stepsOf(t1, 'proposal')[i + 1]).toEqual({ download: { click: { text: 'Download quote PDF' }, as: 'quote-2' } });
    const x = await ui.scenarios.edit(P, 'quote', { hash: d.hash, edit: { kind: 'delete_step', at: at(t1, 'proposal', i + 1) } });
    expect(x).toMatchObject({ label: `Deleted step ${i + 2} of proposal`, select: `proposal.${i + 1}` });
    expect(await readFile(file('quote'), 'utf8')).toBe(t0);
  });

  it('a stale guard (another step at that place) is a conflict with details.stale; a stale hash a plain conflict: nothing written', async () => {
    const t0 = BLOCKS_YAML;
    const h0 = await put('blocks', t0);
    const before = await snapshot('blocks');
    const wrong = { scene: 'one', index: 0, guard: stepGuard({ click: 'Second' }) };
    const e = await failure(ui.scenarios.edit(P, 'blocks', { hash: h0, edit: { kind: 'delete_step', at: wrong } }));
    expect(e.code).toBe('conflict');
    expect(e.details).toEqual({ current: h0, stale: true });
    expect(e.message).toBe('not saved: step 1 of one is not the step the edit was made on (it changed or moved): read the file again');
    const e2 = await failure(ui.scenarios.edit(P, 'blocks', { hash: sha('other'), edit: { kind: 'delete_step', at: at(t0, 'one', 0) } }));
    expect(e2.code).toBe('conflict');
    expect(e2.details).toEqual({ current: h0 });
    expect(await snapshot('blocks')).toEqual(before);
  });

  it('the verify: a splice that would change another value (a keep-chomped block scalar losing its blank line) is refused, nothing written', async () => {
    const t = 'video: keep\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - click: B\n      - type:\n          into: {label: Note}\n          text: |+\n            hello\n\n';
    const h = await put('keep', t);
    const before = await snapshot('keep');
    const e = await failure(ui.scenarios.edit(P, 'keep', { hash: h, edit: { kind: 'move_step', from: at(t, 'a', 1), to: { scene: 'a', index: 0 } } }));
    expect(e.code).toBe('refused');
    expect(e.message).toBe('not saved: the edit cannot be made without changing other parts of the file — change it in the YAML view');
    expect(await snapshot('keep')).toEqual(before);
  });

  it('part-1 rules hold for step edits: a blocked file is refused whole; a copy adding a hidden character is refused; an edit leaving an error is refused', async () => {
    const owned = BLOCKS_YAML.replace('      - click: First', '      - type: {into: {label: Name}, text: "{{env:SHOP_TOKEN}}"}');
    const h1 = await put('owned', owned);
    const e1 = await failure(ui.scenarios.edit(P, 'owned', { hash: h1, edit: { kind: 'move_step', from: at(owned, 'one', 1), to: { scene: 'one', index: 0 } } }));
    expect(e1.code).toBe('refused');
    expect(e1.message).toMatch(/^scenarios\/owned\.yaml holds what the Studio never writes \(line 7\)/);
    const hidden = BLOCKS_YAML.replace('click: Second', `click: "Sec${RLO}ond"`);
    const h2 = await put('hidden', hidden);
    const e2 = await failure(ui.scenarios.edit(P, 'hidden', { hash: h2, edit: { kind: 'duplicate_step', at: at(hidden, 'one', 1) } }));
    expect(e2.code).toBe('invalid');
    expect(e2.message).toMatch(/^not saved: line 9, column \d+ holds U\+202E \(a direction control\)/);
    // Moving it is fine (no new one).
    await ui.scenarios.edit(P, 'hidden', { hash: h2, edit: { kind: 'move_step', from: at(hidden, 'one', 1), to: { scene: 'one', index: 0 } } });
    // A step with an id moved after its use is fine; a duplicate id cannot come from a copy (dropped).
    const ided = BLOCKS_YAML.replace('      - click: First', '      - id: first\n        click: First');
    const h3 = await put('ided', ided);
    const c = await ui.scenarios.edit(P, 'ided', { hash: h3, edit: { kind: 'duplicate_step', at: at(ided, 'one', 0) } });
    expect(c.notices[0]).toBe('The copy has no id: step ids are unique (the original keeps "first").');
    expect(c.warnings.filter((w) => /duplicate/.test(w.message))).toEqual([]);
    // Deleting the download a card shows leaves an error: refused with its issues, nothing written.
    const q = await readFile(file('quote'), 'utf8');
    const i = stepsOf(q, 'proposal').findIndex((s) => typeof s === 'object' && s !== null && 'download' in s);
    const before = await snapshot('quote');
    const e3 = await ui.scenarios.edit(P, 'quote', { hash: sha(q), edit: { kind: 'delete_step', at: at(q, 'proposal', i) } }).then(() => undefined, (x: unknown) => x);
    expect(e3).toBeInstanceOf(ScenarioError);
    expect((e3 as ScenarioError).issues.some((x) => x.severity === 'error' && /quote/.test(x.message))).toBe(true);
    expect(await snapshot('quote')).toEqual(before);
  });

  it('the view: a step written as an alias and the steps of a flow-list scene are locked (why given), the others carry a guard', async () => {
    const t = 'video: locks\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - &s {click: Save}\n      - *s\n  - id: b\n    steps: [{click: One}, {click: Two}]\n';
    await put('locks', t);
    const v = await ui.scenarios.view(P, 'locks');
    const [a, b] = v.blocks.entries.filter((e) => e.type === 'scene');
    if (a.type !== 'scene' || b.type !== 'scene') throw new Error('scenes');
    expect(a.steps.map((s) => s.locked ?? null)).toEqual([null, 'written as a YAML alias: edit it in the YAML view']);
    expect(b.steps_locked).toBe('its scene writes its steps as a flow list ([…]): edit them in the YAML view');
    expect(b.steps.every((s) => s.locked === b.steps_locked)).toBe(true);
    expect(a.steps.every((s) => typeof s.guard === 'string' && /^[0-9a-f]{16}$/.test(s.guard))).toBe(true);
  });
});

describe('pictures after an edit: moved since the run', () => {
  it('a step moved within its scene keeps its run picture and is marked moved (only it); its key in the run is the old one', async () => {
    const h0 = await put('blocks', BLOCKS_YAML);
    const fresh = await ui.scenarios.view(P, 'blocks');
    expect(Object.values(fresh.steps).some((b) => 'moved' in b)).toBe(false);
    await ui.scenarios.edit(P, 'blocks', { hash: h0, edit: { kind: 'move_step', from: at(BLOCKS_YAML, 'one', 1), to: { scene: 'one', index: 0 } } });
    const v = await ui.scenarios.view(P, 'blocks');
    const b = (k: string) => v.steps[k] as Extract<StepBinding, { run_key: string }>;
    expect(b('one.0')).toMatchObject({ run_key: 'one.1', moved: true });
    expect(b('one.1')).toMatchObject({ run_key: 'one.0' });
    expect(b('one.1').moved).toBeUndefined();
    expect(b('one.2').moved).toBeUndefined();
    expect(v.source?.notice).toBe('changed');
    await put('blocks', BLOCKS_YAML);
  });
});
