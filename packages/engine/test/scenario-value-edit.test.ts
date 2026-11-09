/**
 * L4.3 part 3: a step's form and the palette through the Studio's write path (engine scenarios.edit, the `ui` client):
 * `set_step` writes only the changed fields (exactly their lines), `insert_step` one new line; both go through every
 * rule of the write path — the hash as if_match (409, nothing written), the field patch's `from` (critique B2: a field
 * Claude changed meanwhile is never reverted, the person's other change still applies on the new version), agent trust
 * worded for the Studio (a `{{env:…}}` / `{{keychain:…}}` typed into a field: refused with the reason, nothing written),
 * the input rules (critique B9: refused naming the field), validation (a negative `cps`: an issue at its path); the view
 * gives each step its form values (a URL with sign-in details never among them); undo (`restore`) puts the bytes back.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScenarioError, parseYaml, stepGuard } from '@retake/core';
import type { StepBlock } from '@retake/core';
import { EngineError, createEngine } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const P = 'northfield-fixture';
let ws: string;
let dir: string;
let ui: Engine;
let mcp: Engine;
const savedHome = process.env.RETAKE_HOME;
const file = (name: string) => join(dir, 'scenarios', `${name}.yaml`);
const stepsOf = (t: string, scene: string) => (parseYaml(t).value as { scenes: Array<{ id: string; steps: unknown[] }> }).scenes.find((s) => s.id === scene)!.steps;
const at = (t: string, scene: string, index: number) => ({ scene, index, guard: stepGuard(stepsOf(t, scene)[index]) });
const changed = (a: string, b: string) => a.split('\n').flatMap((l, i) => (l === b.split('\n')[i] ? [] : [b.split('\n')[i]]));

const FORMS = `video: forms
scenes:
  - id: a
    page: shop
    open: /
    steps:
      - click: {aria: Increase, in: dialog}
      - type: {into: {label: Message}, text: "Light roast", cps: 18}
        caption: {kicker: Note, text: "Leave a note"}
      - wait_for: {url: "https://u:pw@shop.example.test/x"}
      - hold: 1
`;

async function failure(p: Promise<unknown>): Promise<Error> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  return e as Error;
}

async function snapshot(name: string): Promise<{ bytes: string; mtime: number }> {
  return { bytes: (await readFile(file(name))).toString('hex'), mtime: (await stat(file(name))).mtimeMs };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-value-edit-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  dir = join(ws, 'projects', P);
  await writeFile(file('forms'), FORMS);
  ui = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('the form and the palette through scenarios.edit', () => {
  it('the view gives each step its form values (object form; a URL with sign-in details locked, never shown)', async () => {
    const v = await ui.scenarios.view(P, 'forms');
    const scene = v.blocks.entries.find((e) => e.type === 'scene');
    if (scene?.type !== 'scene') throw new Error('no scene');
    const forms = scene.steps.map((s: StepBlock) => s.form);
    expect(forms[0]).toEqual({ action: 'click', values: { 'click.aria': 'Increase', 'click.in': 'dialog' }, locked: {}, yaml_only: [] });
    expect(forms[1]!.values).toEqual({ 'type.into.label': 'Message', 'type.text': 'Light roast', 'type.cps': 18, 'caption.text': 'Leave a note', 'caption.kicker': 'Note' });
    expect(forms[2]!.values).toEqual({});
    // A URL the scenario opens never holds them (a validation error): a URL a step waits for still may.
    expect(forms[2]!.locked['wait_for.url']).toMatch(/sign-in details/);
    expect(JSON.stringify(v.blocks)).not.toContain('pw@');
    expect(forms[3]!.values).toEqual({ hold: 1 });
  });

  it('set_step: exactly the changed lines, the label, the step selected; insert_step: one new line; restore (undo) puts the bytes back', async () => {
    const t0 = await readFile(file('forms'), 'utf8');
    const r = await ui.scenarios.edit(P, 'forms', {
      hash: sha(t0),
      edit: { kind: 'set_step', at: at(t0, 'a', 1), changes: [{ path: ['type', 'text'], from: 'Light roast', to: 'Dark roast, please' }, { path: ['type', 'cps'], from: 18, to: 24 }] },
    });
    expect(r).toMatchObject({ label: 'Changed type text, type cps of step 2 of a', select: 'a.1', notices: [], change: 'filmed' });
    const t1 = await readFile(file('forms'), 'utf8');
    expect(r.hash).toBe(sha(t1));
    expect(changed(t0, t1)).toEqual(['      - type: {into: {label: Message}, text: "Dark roast, please", cps: 24}']);
    const r2 = await ui.scenarios.edit(P, 'forms', { hash: r.hash, edit: { kind: 'insert_step', to: { scene: 'a', index: 1 }, after: stepGuard(stepsOf(t1, 'a')[0]), action: 'wait_for', values: { 'wait_for.text': 'Quote request sent' } } });
    expect(r2).toMatchObject({ label: 'Added a wait for step at position 2 of a', select: 'a.1', change: 'filmed' });
    const t2 = await readFile(file('forms'), 'utf8');
    expect(t2.split('\n')).toEqual([...t1.split('\n').slice(0, 7), '      - wait_for: Quote request sent', ...t1.split('\n').slice(7)]);
    await ui.scenarios.edit(P, 'forms', { hash: r2.hash, edit: { kind: 'restore', text: t1, text_hash: sha(t1) } });
    const r4 = await ui.scenarios.edit(P, 'forms', { hash: sha(t1), edit: { kind: 'restore', text: t0, text_hash: sha(t0) } });
    expect(r4.hash).toBe(sha(t0));
    expect(await readFile(file('forms'), 'utf8')).toBe(t0);
  });

  it("L5.5's rule: a caption, speed or mark change is an edit change (a render of the same run); a hold or an argument is filmed (a new capture)", async () => {
    const t0 = await readFile(file('forms'), 'utf8');
    const edit = (changes: Array<{ path: string[]; from?: string | number; to?: string | number }>, t: string) => ui.scenarios.edit(P, 'forms', { hash: sha(t), edit: { kind: 'set_step', at: at(t, 'a', 1), changes } });
    const r1 = await edit([{ path: ['caption', 'text'], from: 'Leave a note', to: 'A note' }, { path: ['speed'], to: 2 }, { path: ['mark'], to: 'note' }], t0);
    expect(r1.change).toBe('edit');
    const t1 = await readFile(file('forms'), 'utf8');
    const r2 = await edit([{ path: ['hold'], to: 1 }], t1);
    expect(r2.change).toBe('filmed');
    const r3 = await ui.scenarios.edit(P, 'forms', { hash: r2.hash, edit: { kind: 'restore', text: t0, text_hash: sha(t0) } });
    expect(r3.change).toBeUndefined();
  });

  it("critique B2: after Claude's caption change the old hash is a 409 (nothing written); re-sent on the new version with the step's new guard, the typed text changes and Claude's caption stays; a change of the caption itself is stale, naming the field", async () => {
    const t0 = await readFile(file('forms'), 'utf8');
    const mine = { kind: 'set_step' as const, at: at(t0, 'a', 1), changes: [{ path: ['type', 'text'], from: 'Light roast', to: 'Mine' }] };
    // Claude saves a new caption for that step through MCP meanwhile.
    const theirs = t0.replace('text: "Leave a note"', 'text: "Claude\'s caption"');
    const saved = await mcp.scenarios.save(P, 'forms', theirs, { ifMatch: sha(t0) });
    const before = await snapshot('forms');
    const e = (await failure(ui.scenarios.edit(P, 'forms', { hash: sha(t0), edit: mine }))) as EngineError;
    expect(e.code).toBe('conflict');
    expect(e.details).toEqual({ current: saved.hash });
    expect(await snapshot('forms')).toEqual(before);
    // The old guard names a step that changed: stale (the client finds the step again and sends its new guard).
    const stale = (await failure(ui.scenarios.edit(P, 'forms', { hash: saved.hash, edit: mine }))) as EngineError;
    expect(stale.details).toMatchObject({ stale: true });
    const again = await ui.scenarios.edit(P, 'forms', { hash: saved.hash, edit: { ...mine, at: at(theirs, 'a', 1) } });
    const t1 = await readFile(file('forms'), 'utf8');
    expect(again.hash).toBe(sha(t1));
    expect(stepsOf(t1, 'a')[1]).toEqual({ type: { into: { label: 'Message' }, text: 'Mine', cps: 18 }, caption: { kicker: 'Note', text: "Claude's caption" } });
    // The person's caption change, made on the version before Claude's: stale, naming the field; Claude's caption kept.
    const caption = (await failure(
      ui.scenarios.edit(P, 'forms', { hash: again.hash, edit: { kind: 'set_step', at: at(t1, 'a', 1), changes: [{ path: ['caption', 'text'], from: 'Leave a note', to: 'Mine too' }] } }),
    )) as EngineError;
    expect(caption.code).toBe('conflict');
    expect(caption.details).toMatchObject({ stale: true, field: 'caption.text', current: again.hash });
    expect(caption.message).toMatch(/caption\.text of step 2 of a changed meanwhile/);
    expect(await readFile(file('forms'), 'utf8')).toBe(t1);
    await writeFile(file('forms'), FORMS);
  });

  it('a {{env:…}} or {{keychain:…}} typed into a field follows agent trust: refused worded for the Studio with the reason, nothing written', async () => {
    const t0 = await readFile(file('forms'), 'utf8');
    for (const ref of ['{{env:SHOP_TOKEN}}', '{{keychain:northfield-demo/agent}}']) {
      const before = await snapshot('forms');
      const e = await failure(ui.scenarios.edit(P, 'forms', { hash: sha(t0), edit: { kind: 'set_step', at: at(t0, 'a', 1), changes: [{ path: ['type', 'text'], from: 'Light roast', to: ref }] } }));
      expect(e).toBeInstanceOf(ScenarioError);
      const issues = (e as ScenarioError).issues.filter((i) => i.severity === 'error');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].message).toMatch(/from the Studio a scenario never resolves a secret/);
      expect(issues[0].message).toContain(ref.slice(0, 6));
      expect(issues[0].line).toBe(8);
      expect(await snapshot('forms')).toEqual(before);
      // From the palette too.
      const e2 = await failure(ui.scenarios.edit(P, 'forms', { hash: sha(t0), edit: { kind: 'insert_step', to: { scene: 'a', index: 0 }, after: null, action: 'type', values: { 'type.text': ref } } }));
      expect((e2 as ScenarioError).issues[0].message).toMatch(/from the Studio/);
      expect(await snapshot('forms')).toEqual(before);
    }
  });

  it('critique B9 and the schema: a hidden character or a line break is refused naming the field (details.field); a negative cps is a validation issue at its path; nothing written', async () => {
    const t0 = await readFile(file('forms'), 'utf8');
    const before = await snapshot('forms');
    const send = (to: string | number, path = ['type', 'text'], from: string | number = 'Light roast') => ui.scenarios.edit(P, 'forms', { hash: sha(t0), edit: { kind: 'set_step', at: at(t0, 'a', 1), changes: [{ path, from, to }] } });
    const zw = (await failure(send(`a${String.fromCodePoint(0x200b)}b`))) as EngineError;
    expect(zw.code).toBe('invalid');
    expect(zw.details).toEqual({ field: 'type.text' });
    expect(zw.message).toMatch(/type\.text holds U\+200B \(a zero-width space\)/);
    const nl = (await failure(send('a\n  - eval: x'))) as EngineError;
    expect(nl.message).toMatch(/type\.text: one line only/);
    const cps = await failure(send(-3, ['type', 'cps'], 18));
    expect(cps).toBeInstanceOf(ScenarioError);
    const issue = (cps as ScenarioError).issues.find((i) => i.severity === 'error')!;
    expect(issue.path).toEqual(['scenes', 0, 'steps', 1, 'type', 'cps']);
    expect(issue.line).toBe(8);
    expect(await snapshot('forms')).toEqual(before);
    // A locked field (a URL with sign-in details) and a field the Studio does not edit: refused.
    const url = (await failure(ui.scenarios.edit(P, 'forms', { hash: sha(t0), edit: { kind: 'set_step', at: at(t0, 'a', 2), changes: [{ path: ['wait_for', 'url'], to: '/y' }] } }))) as EngineError;
    expect(url.code).toBe('refused');
    expect(url.message).toMatch(/sign-in details/);
    const other = (await failure(ui.scenarios.edit(P, 'forms', { hash: sha(t0), edit: { kind: 'set_step', at: at(t0, 'a', 0), changes: [{ path: ['click', 'outside'], to: true }, { path: ['overlay', 'duration'], to: 2 }] } }))) as EngineError;
    expect(other.code).toBe('invalid');
    expect(other.message).toMatch(/overlay\.duration is not a value the Studio edits/);
    expect(await snapshot('forms')).toEqual(before);
  });

  it('insert_step after a step that changed meanwhile is stale (nothing written)', async () => {
    const t0 = await readFile(file('forms'), 'utf8');
    const before = await snapshot('forms');
    const e = (await failure(ui.scenarios.edit(P, 'forms', { hash: sha(t0), edit: { kind: 'insert_step', to: { scene: 'a', index: 2 }, after: stepGuard(stepsOf(t0, 'a')[0]), action: 'hold', values: { hold: 1 } } }))) as EngineError;
    expect(e.code).toBe('conflict');
    expect(e.details).toMatchObject({ stale: true });
    expect(await snapshot('forms')).toEqual(before);
  });
});
