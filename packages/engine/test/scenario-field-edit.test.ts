/**
 * L4.5 part A: the timeline's one-click switches through the Studio's write path (engine scenarios.edit, kind
 * `set_field`, the `ui` client) — one line written, `change: 'edit'` (a render of the same take re-plans it), undo
 * (`restore`) byte-exact; the L4.3 rules untouched (the hash as if_match, hooks and vars frozen — a switch in a file with
 * setup hooks is fine, they do not change); a component or frame that does not fit the use refused with the reason
 * the inspector shows (⚑ critique B7: kind, slots, pages, a component written for another kit API).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseYaml, stepGuard } from '@retake/core';
import type { FieldAt } from '@retake/core';
import { EngineError, createEngine, fieldFitProblem, fieldOptions, memoRegistry, videoPages } from '../src/index.js';
import type { Engine, ScenarioEdit } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const P = 'northfield-fixture';
let ws: string;
let dir: string;
let ui: Engine;
const savedHome = process.env.RETAKE_HOME;
const file = (name: string) => join(dir, 'scenarios', `${name}.yaml`);
const read = (name: string) => readFile(file(name), 'utf8');
type Obj = Record<string, unknown>;
function atOf(text: string, entry: 'scene' | 'card' | 'interstitial', id: string): FieldAt {
  const scenes = (parseYaml(text).value as { scenes: Obj[] }).scenes;
  return { entry, id, guard: stepGuard(scenes.find((e, i) => (e.id ?? `${entry}-${i}`) === id)) };
}
/** The lines `b` has in place of `a`'s (common head and tail left out). */
function changed(a: string, b: string): string[] {
  const x = a.split('\n');
  const y = b.split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  let j = 0;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  return y.slice(i, y.length - j);
}

async function failure(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-field-edit-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  dir = join(ws, 'projects', P);
  // A workspace card written for another kit API (the guard-rail), and one that fits.
  for (const [id, extra] of [
    ['acme/next-card', 'engines: {kit: "^2"}\n'],
    ['acme/plain-card', ''],
  ] as const) {
    const d = join(ws, 'components', ...id.split('/'));
    await mkdir(d, { recursive: true });
    await writeFile(join(d, 'component.yaml'), `id: ${id}\nversion: 1.0.0\nkind: card\nname: Card\ndescription: A card.\n${extra}slots:\n  title: {type: text, required: true}\n  kicker: {type: text}\npreview: {slots: {title: Hello}}\n`);
    await writeFile(join(d, 'index.tsx'), 'export default function C() { return null; }\n');
  }
  ui = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(ws, { recursive: true, force: true });
});

describe('set_field through scenarios.edit (L4.5)', () => {
  it('a layout switch writes one line, is an edit change, and undoes to the exact bytes (a file with setup hooks: they stay)', async () => {
    const before = await read('quote');
    const edit: ScenarioEdit = { kind: 'set_field', at: atOf(before, 'scene', 'request'), field: 'frame', to: 'laptop' };
    const r = await ui.scenarios.edit(P, 'quote', { hash: sha(before), edit });
    const after = await read('quote');
    expect(r).toMatchObject({ label: 'Set the layout of scene request to laptop', change: 'edit', select: null, hash: sha(after) });
    expect(changed(before, after)).toEqual(['    frame: laptop']);
    expect(after.split('\n').length).toBe(before.split('\n').length + 1);
    const undo = await ui.scenarios.edit(P, 'quote', { hash: r.hash, edit: { kind: 'restore', text: before, text_hash: sha(before) } });
    expect(await read('quote')).toBe(before);
    expect(undo.hash).toBe(sha(before));
  });

  it('the caption component and a card component: before `scenes:` / in the card\'s flow map', async () => {
    const before = await read('quote');
    const cap = await ui.scenarios.edit(P, 'quote', { hash: sha(before), edit: { kind: 'set_field', at: { entry: 'top' }, field: 'caption_component', to: 'studio/caption-overlay' } });
    const t1 = await read('quote');
    expect(changed(before, t1)[0]).toBe('caption_component: studio/caption-overlay');
    expect(t1).toContain('\n\ncaption_component: studio/caption-overlay\nscenes:\n');
    const card = await ui.scenarios.edit(P, 'quote', { hash: cap.hash, edit: { kind: 'set_field', at: atOf(t1, 'card', 'chapter-request'), field: 'card.component', to: 'acme/plain-card' } });
    const t2 = await read('quote');
    expect(changed(t1, t2)).toEqual(['  - card: {slots: {kicker: Step two, title: Ask the roaster for a quote}, component: acme/plain-card}']);
    expect(card.change).toBe('edit');
    await ui.scenarios.edit(P, 'quote', { hash: card.hash, edit: { kind: 'restore', text: before, text_hash: sha(before) } });
  });

  it('⚑ a component or frame that does not fit the use is refused with the inspector\'s reason, nothing written', async () => {
    const before = await read('quote');
    const { mtimeMs } = await stat(file('quote'));
    const refusals: Array<[ScenarioEdit, RegExp]> = [
      [{ kind: 'set_field', at: atOf(before, 'card', 'chapter-request'), field: 'card.component', to: 'studio/card-testimonial' }, /^not saved: studio\/card-testimonial does not show slots\.kicker$/],
      [{ kind: 'set_field', at: atOf(before, 'card', 'chapter-request'), field: 'card.component', to: 'studio/intro-stack' }, /is an intro component, not a card/],
      [{ kind: 'set_field', at: atOf(before, 'card', 'chapter-request'), field: 'card.component', to: 'acme/next-card' }, /needs kit API 2/],
      [{ kind: 'set_field', at: atOf(before, 'card', 'chapter-request'), field: 'card.component', to: 'acme/missing-card' }, /not found/],
      [{ kind: 'set_field', at: { entry: 'top' }, field: 'caption_component', to: 'studio/layout-laptop' }, /is a layout component, not a caption/],
      [{ kind: 'set_field', at: atOf(before, 'scene', 'request'), field: 'frame', to: 'split' }, /split shows several pages: this scene films one/],
      [{ kind: 'set_field', at: atOf(before, 'scene', 'request'), field: 'frame', to: 'studio/layout-pip' }, /shows several pages: this scene films one/],
      [{ kind: 'set_field', at: { entry: 'top' }, field: 'frame', to: 'pip' }, /pip shows several pages: no scene of this video films more than one/],
      [{ kind: 'set_field', at: atOf(before, 'scene', 'request'), field: 'transition', to: 'studio/card-title' }, /is a card component, not a transition/],
    ];
    for (const [edit, re] of refusals) {
      const e = await failure(ui.scenarios.edit(P, 'quote', { hash: sha(before), edit }));
      expect(e.code, JSON.stringify(edit)).toBe('invalid');
      expect(e.message, JSON.stringify(edit)).toMatch(re);
    }
    expect(await read('quote')).toBe(before);
    expect((await stat(file('quote'))).mtimeMs).toBe(mtimeMs);
    // A multi-page scene takes split, pip or a multi-page layout, never a single-page frame.
    const live = await read('live-quote');
    const scene = (parseYaml(live).value as { scenes: Obj[] }).scenes.find((s) => s.pages)!.id as string;
    const one = await failure(ui.scenarios.edit(P, 'live-quote', { hash: sha(live), edit: { kind: 'set_field', at: atOf(live, 'scene', scene), field: 'frame', to: 'laptop' } }));
    expect(one.message).toMatch(/laptop shows one page: this scene films 2/);
  });

  it("review B: the video's frame offers split / pip when a scene films several pages; on an all-multi-page video a one-page layout says it changes none", async () => {
    const live = parseYaml(await read('live-quote')).value as { scenes: Obj[] };
    const registry = (await memoRegistry(ui.workspace)).registry;
    const fit = (await import('@retake/components')).componentFit;
    // live-quote films several pages in every scene: a top-level split dresses them (it could not be picked again
    // before), a one-page style is disabled with why (it would change nothing, silently).
    expect(videoPages(live)).toMatchObject({ multi: videoPages(live).scenes });
    expect(fieldFitProblem(registry, fit, live, { at: { entry: 'top' }, field: 'frame', to: 'split' })).toBeNull();
    expect(fieldFitProblem(registry, fit, live, { at: { entry: 'top' }, field: 'frame', to: 'pip' })).toBeNull();
    expect(fieldFitProblem(registry, fit, live, { at: { entry: 'top' }, field: 'frame', to: 'laptop' })).toBe('every scene of this video films several pages: a one-page layout changes none of them (Split screen, Picture in picture, or a multi-page layout component)');
    const top = (await fieldOptions(registry, live, { entry: 'top' }, 'frame')).map((o) => [o.value, o.usable === true]);
    expect(top).toContainEqual(['split', true]);
    expect(top).toContainEqual(['laptop', false]);
    // A video with a one-page scene too: both kinds of frame are usable at the top.
    const mixed = { ...live, scenes: [...live.scenes, { id: 'single', page: 'buyer', open: '/', steps: [{ hold: 1 }] }] };
    const both = (await fieldOptions(registry, mixed, { entry: 'top' }, 'frame')).map((o) => [o.value, o.usable === true]);
    expect(both).toContainEqual(['split', true]);
    expect(both).toContainEqual(['laptop', true]);
  });

  it('the L4.3 rules: a stale hash or value is a conflict, an allow-list path refused, the file untouched', async () => {
    const before = await read('quote');
    const at = atOf(before, 'scene', 'request');
    const stale = await failure(ui.scenarios.edit(P, 'quote', { hash: sha('other'), edit: { kind: 'set_field', at, field: 'frame', to: 'laptop' } }));
    expect(stale.code).toBe('conflict');
    const from = await failure(ui.scenarios.edit(P, 'quote', { hash: sha(before), edit: { kind: 'set_field', at, field: 'frame', from: 'phone', to: 'laptop' } }));
    expect(from).toMatchObject({ code: 'conflict', details: { stale: true, field: 'frame' } });
    const hooks = await failure(ui.scenarios.edit(P, 'quote', { hash: sha(before), edit: { kind: 'set_field', at: { entry: 'top' }, field: 'setup', to: 'x' } }));
    expect(hooks.code).toBe('invalid');
    expect(hooks.message).toMatch(/setup is not a value the timeline sets/);
    expect(await read('quote')).toBe(before);
  });
});
