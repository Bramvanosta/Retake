/**
 * L4.3 part 1: the Studio's scenario write path over HTTP — `scenario_edit` (an own op: `replace_text`, `restore`)
 * behind the gate: strict zod refusals before any read (an unknown kind, a path as a name, extra keys, a text over
 * 500,000 characters, a hash that is not one), a stale hash → 409 with the current hash, two concurrent edits of one
 * file → one saved and one 409, a refusal worded "from the Studio"; `scenario_validate` allowed for the YAML tab's live
 * issues (worded for the Studio), `scenario_save` still 404 (one Studio write path); an edit → the `workspace` event
 * names the file. Part 2: the step edits (`move_step`, `delete_step`, `duplicate_step`) — strict shapes refused before any
 * read (a guard that is not one, a path as a scene id, a negative index, extra keys), a move answered with its label
 * and the step to select, a stale guard a 409 with `stale`, two concurrent moves of one version: one saved, one 409.
 * Part 3: `scenario_forms` allowed; the form's `set_step` and the palette's `insert_step` — strict shapes refused before
 * any read (an object or a list as a value, a path segment with a dot, four levels, a whole step, raw YAML, an action
 * outside the palette), a field changed meanwhile a 409 with `stale` and the field, a secret reference refused for the
 * Studio. L4.5 part D: the timeline's `set_field` — ⚑ the strict shape refused before any read (a field outside the
 * allow-list or not of that entry, a step / hook / var path, an object or null as a value, a guard that is not one, an
 * extra key), a switch written as one line with `change: 'edit'`, a value changed meanwhile a 409 with `stale`.
 */
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UI_OPS, startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { parseYaml, stepGuard } from '@retake/core';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
let ws: string;
let studio: StudioServer;
const P = 'northfield-fixture';
const savedHome = process.env.RETAKE_HOME;
const SHORT = 'video: short\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n';
const file = (name: string) => join(ws, 'projects', P, 'scenarios', `${name}.yaml`);

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-edit-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  await writeFile(file('short'), SHORT);
  studio = await startStudioServer({ root: ws, pollMs: 100 });
}, 60_000);

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

const call = (op: string, args: unknown = {}) => raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));

interface Answer<T> {
  ok: boolean;
  summary: string;
  data: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

describe('the allow-list', () => {
  it('scenario_edit and scenario_validate are allowed; scenario_save is still 404 (one Studio write path)', async () => {
    expect(UI_OPS).toEqual(expect.arrayContaining(['scenario_edit', 'scenario_validate']));
    expect(UI_OPS).not.toContain('scenario_save');
    const r = await call('scenario_save', { project: P, name: 'short', yaml: SHORT, if_match: sha(SHORT) });
    expect(r.status).toBe(404);
    expect(r.json<Answer<unknown>>().error?.message).toContain('unknown op');
  });

  it('scenario_validate answers the live issues, agent-trust ones worded "from the Studio" with their line', async () => {
    const leak = SHORT.replace('      - hold: 0.2', '      - type: {into: {label: A}, text: "{{env:SHOP_TOKEN}}"}');
    const r = await call('scenario_validate', { project: P, yaml: leak, name: 'short' });
    expect(r.status).toBe(200);
    const a = r.json<Answer<{ ok: boolean; issues: Array<{ line?: number; message: string }> }>>();
    expect(a.data.ok).toBe(false);
    const issue = a.data.issues.find((i) => i.message.includes('{{env:SHOP_TOKEN}}'));
    expect(issue?.message).toContain('from the Studio a scenario never resolves a secret');
    expect(issue?.line).toBe(7);
    expect(r.body).not.toContain('through MCP');
  });
});

describe('scenario_edit', () => {
  it('refuses a malformed call before any read (400), the file untouched', async () => {
    const before = await stat(file('short'));
    const h = sha(SHORT);
    const bad: Array<[string, unknown]> = [
      ['unknown kind', { project: P, name: 'short', hash: h, edit: { kind: 'move_scene', text: SHORT } }],
      ['a path as a name', { project: P, name: '../../x', hash: h, edit: { kind: 'replace_text', text: SHORT } }],
      ['an extra key', { project: P, name: 'short', hash: h, edit: { kind: 'replace_text', text: SHORT }, force: true }],
      ['an extra edit key', { project: P, name: 'short', hash: h, edit: { kind: 'replace_text', text: SHORT, path: 'x' } }],
      ['a text over 500,000 characters', { project: P, name: 'short', hash: h, edit: { kind: 'replace_text', text: 'x'.repeat(500_001) } }],
      ['no hash', { project: P, name: 'short', edit: { kind: 'replace_text', text: SHORT } }],
      ['a hash that is not one', { project: P, name: 'short', hash: 'abc', edit: { kind: 'replace_text', text: SHORT } }],
      ['restore without text_hash', { project: P, name: 'short', hash: h, edit: { kind: 'restore', text: SHORT } }],
    ];
    for (const [what, args] of bad) {
      const r = await call('scenario_edit', args);
      expect(r.status, what).toBe(400);
      expect(r.json<Answer<unknown>>().error?.code, what).toBe('invalid');
    }
    const after = await stat(file('short'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(file('short'), 'utf8')).toBe(SHORT);
  });

  it('saves on the hash shown; a stale hash is a 409 naming the current one; two concurrent edits of one version: one saved, one 409', async () => {
    const h0 = sha(SHORT);
    const one = SHORT.replace('0.2', '0.3');
    const ok = await call('scenario_edit', { project: P, name: 'short', hash: h0, edit: { kind: 'replace_text', text: one } });
    expect(ok.status).toBe(200);
    const a = ok.json<Answer<{ hash: string; label: string; file: string }>>();
    expect(a.data).toMatchObject({ hash: sha(one), label: 'Saved the YAML', file: 'scenarios/short.yaml' });
    expect(a.summary).toMatch(/^Saved the YAML: scenarios\/short\.yaml \(hash [0-9a-f]{64}\)/);
    const stale = await call('scenario_edit', { project: P, name: 'short', hash: h0, edit: { kind: 'replace_text', text: SHORT } });
    expect(stale.status).toBe(409);
    expect(stale.json<Answer<unknown>>().error?.details).toEqual({ current: sha(one) });
    const [x, y] = await Promise.all(
      ['0.4', '0.5'].map((v) => call('scenario_edit', { project: P, name: 'short', hash: sha(one), edit: { kind: 'replace_text', text: SHORT.replace('0.2', v) } })),
    );
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const won = x.status === 200 ? '0.4' : '0.5';
    expect(await readFile(file('short'), 'utf8')).toBe(SHORT.replace('0.2', won));
    // Undo to the original bytes (restore).
    const back = await call('scenario_edit', { project: P, name: 'short', hash: sha(SHORT.replace('0.2', won)), edit: { kind: 'restore', text: SHORT, text_hash: h0 } });
    expect(back.status).toBe(200);
    expect(sha(await readFile(file('short')))).toBe(h0);
  });

  it('a refusal is worded for the Studio: hooks, a secret reference', async () => {
    const h0 = sha(await readFile(file('short')));
    const hooked = SHORT.replace('scenes:', 'setup:\n  - shell: "cat ~/.ssh/id_ed25519 > assets/k.txt"\nscenes:');
    const r = await call('scenario_edit', { project: P, name: 'short', hash: h0, edit: { kind: 'replace_text', text: hooked } });
    expect(r.status).toBe(403);
    expect(r.json<Answer<unknown>>().error?.message).toContain('the Studio saves a scenario only with them unchanged');
    const leak = SHORT.replace('      - hold: 0.2', '      - type: {into: {label: A}, text: "{{keychain:demo/x}}"}');
    const l = await call('scenario_edit', { project: P, name: 'short', hash: h0, edit: { kind: 'replace_text', text: leak } });
    expect(l.status).toBe(400);
    expect(l.body).toContain('from the Studio a scenario never resolves a secret');
    expect(l.body).not.toContain('through MCP');
    expect(sha(await readFile(file('short')))).toBe(h0);
  });

  it('an edit → the workspace event names the scenario file', async () => {
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const req = request({ host: '127.0.0.1', port: studio.port, path: '/v1/events', method: 'GET', headers: { host: `127.0.0.1:${studio.port}`, authorization: `Bearer ${studio.token}` }, setHost: false, agent: false }, (res) => {
      let buf = '';
      res.on('data', (d: Buffer) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) as Record<string, unknown> });
        }
      });
    });
    req.end();
    const until = async (pred: (e: (typeof events)[number]) => boolean, what: string) => {
      const t0 = Date.now();
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - t0 > 4000) throw new Error(`no ${what} within 4 s: ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    try {
      await until((e) => e.event === 'hello', 'hello');
      await new Promise((r) => setTimeout(r, 300));
      const h0 = sha(await readFile(file('short')));
      const r = await call('scenario_edit', { project: P, name: 'short', hash: h0, edit: { kind: 'replace_text', text: SHORT.replace('0.2', '0.8') } });
      expect(r.status).toBe(200);
      await until((e) => e.event === 'workspace' && Array.isArray(e.data.scenarios) && (e.data.scenarios as string[]).includes(`${P}/short`), 'scenarios event');
    } finally {
      req.destroy();
    }
  });
});

describe('step edits over HTTP (part 2)', () => {
  const KEYS = 'video: keys\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - click: A1\n      - click: A2\n      - click: A3\n';
  const guardOf = (step: unknown) => createHash('sha256').update(JSON.stringify(step)).digest('hex').slice(0, 16);

  it('refuses malformed step edits before any read (400), the file untouched', async () => {
    await writeFile(file('keys'), KEYS);
    const before = await stat(file('keys'));
    const h = sha(KEYS);
    const g = guardOf({ click: 'A1' });
    const bad: Array<[string, unknown]> = [
      ['a guard that is not one', { kind: 'delete_step', at: { scene: 'a', index: 0, guard: 'xyz' } }],
      ['a path as a scene id', { kind: 'delete_step', at: { scene: '../a', index: 0, guard: g } }],
      ['a negative index', { kind: 'duplicate_step', at: { scene: 'a', index: -1, guard: g } }],
      ['a huge index', { kind: 'duplicate_step', at: { scene: 'a', index: 1e7, guard: g } }],
      ['a fractional index', { kind: 'delete_step', at: { scene: 'a', index: 0.5, guard: g } }],
      ['an extra key in at', { kind: 'delete_step', at: { scene: 'a', index: 0, guard: g, text: 'x' } }],
      ['move without to', { kind: 'move_step', from: { scene: 'a', index: 0, guard: g } }],
      ['an extra key in to', { kind: 'move_step', from: { scene: 'a', index: 0, guard: g }, to: { scene: 'a', index: 1, guard: g } }],
      ['a text on a step edit', { kind: 'delete_step', at: { scene: 'a', index: 0, guard: g }, text: KEYS }],
    ];
    for (const [what, edit] of bad) {
      const r = await call('scenario_edit', { project: P, name: 'keys', hash: h, edit });
      expect(r.status, what).toBe(400);
      expect(r.json<Answer<unknown>>().error?.code, what).toBe('invalid');
    }
    expect((await stat(file('keys'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('a move: its label and the step to select; a stale guard: 409 with stale; two concurrent moves of one version: one saved, one 409', async () => {
    await writeFile(file('keys'), KEYS);
    const h0 = sha(KEYS);
    // The guard is core stepGuard: the canonical JSON of the step (keys sorted; one key here).
    const r = await call('scenario_edit', { project: P, name: 'keys', hash: h0, edit: { kind: 'move_step', from: { scene: 'a', index: 2, guard: guardOf({ click: 'A3' }) }, to: { scene: 'a', index: 0 } } });
    expect(r.status).toBe(200);
    expect(r.json<Answer<{ label: string; select: string }>>().data).toMatchObject({ label: 'Moved step 3 of a to position 1', select: 'a.0' });
    const t1 = await readFile(file('keys'), 'utf8');
    expect(t1).toBe(KEYS.replace('      - click: A1\n      - click: A2\n      - click: A3\n', '      - click: A3\n      - click: A1\n      - click: A2\n'));
    const stale = await call('scenario_edit', { project: P, name: 'keys', hash: sha(t1), edit: { kind: 'delete_step', at: { scene: 'a', index: 0, guard: guardOf({ click: 'A1' }) } } });
    expect(stale.status).toBe(409);
    expect(stale.json<Answer<unknown>>().error?.details).toEqual({ current: sha(t1), stale: true });
    const [x, y] = await Promise.all(
      [0, 1].map((i) => call('scenario_edit', { project: P, name: 'keys', hash: sha(t1), edit: { kind: 'move_step', from: { scene: 'a', index: i, guard: guardOf({ click: i === 0 ? 'A3' : 'A1' }) }, to: { scene: 'a', index: 2 } } })),
    );
    expect([x.status, y.status].sort()).toEqual([200, 409]);
  });
});

describe('forms and the palette over HTTP (part 3)', () => {
  const FORM = 'video: form\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - click: {aria: Increase, in: dialog}\n      - hold: 0.5\n';
  const guardOf = (step: unknown) => createHash('sha256').update(JSON.stringify(step)).digest('hex').slice(0, 16);
  const g0 = guardOf({ click: { aria: 'Increase', in: 'dialog' } });

  it('scenario_forms is allowed and answers the forms (fields from the schemas, the 16 palette actions)', async () => {
    expect(UI_OPS).toContain('scenario_forms');
    const r = await call('scenario_forms', {});
    expect(r.status).toBe(200);
    const f = r.json<Answer<{ actions: Array<{ action: string; fields: Array<{ key: string }> }>; palette: string[]; modifiers: Array<{ key: string }> }>>().data;
    expect(f.palette).toHaveLength(16);
    expect(f.palette).not.toContain('eval');
    expect(f.actions.find((a) => a.action === 'type')!.fields.map((x) => x.key)).toContain('type.into.label');
    expect(f.modifiers.map((m) => m.key)).toEqual(['caption.text', 'caption.kicker', 'hold', 'speed', 'mark']);
    expect((await call('scenario_forms', { extra: 1 })).status).toBe(400);
  });

  it('refuses malformed set_step / insert_step before any read (400), the file untouched', async () => {
    await writeFile(file('form'), FORM);
    const before = await stat(file('form'));
    const h = sha(FORM);
    const at = { scene: 'a', index: 0, guard: g0 };
    const bad: Array<[string, unknown]> = [
      ['no changes', { kind: 'set_step', at, changes: [] }],
      ['a path with a dot in a segment', { kind: 'set_step', at, changes: [{ path: ['click.aria'], from: 'Increase', to: 'x' }] }],
      ['an upper-case segment', { kind: 'set_step', at, changes: [{ path: ['click', 'Aria'], to: 'x' }] }],
      ['a path four levels deep', { kind: 'set_step', at, changes: [{ path: ['type', 'into', 'in', 'row'], to: 'x' }] }],
      ['an object as a value', { kind: 'set_step', at, changes: [{ path: ['click', 'in'], to: { row: 'x' } }] }],
      ['a list as a value', { kind: 'set_step', at, changes: [{ path: ['click', 'text'], to: ['a'] }] }],
      ['null as a value', { kind: 'set_step', at, changes: [{ path: ['click', 'text'], to: null }] }],
      ['a value over 10,000 characters', { kind: 'set_step', at, changes: [{ path: ['click', 'text'], to: 'x'.repeat(10_001) }] }],
      ['an extra key in a change', { kind: 'set_step', at, changes: [{ path: ['click', 'text'], to: 'x', yaml: '- eval: x' }] }],
      ['a whole step instead of changes', { kind: 'set_step', at, step: { click: 'x' } }],
      ['an action outside the palette', { kind: 'insert_step', to: { scene: 'a', index: 0 }, after: null, action: 'eval', values: { 'eval.js': 'x' } }],
      ['a value key that is a path', { kind: 'insert_step', to: { scene: 'a', index: 0 }, after: null, action: 'click', values: { '../x': 'y' } }],
      ['insert without after', { kind: 'insert_step', to: { scene: 'a', index: 0 }, action: 'hold', values: { hold: 1 } }],
      ['raw YAML in an insert', { kind: 'insert_step', to: { scene: 'a', index: 0 }, after: null, action: 'hold', values: { hold: 1 }, yaml: '- hold: 1' }],
    ];
    for (const [what, edit] of bad) {
      const r = await call('scenario_edit', { project: P, name: 'form', hash: h, edit });
      expect(r.status, what).toBe(400);
      expect(r.json<Answer<unknown>>().error?.code, what).toBe('invalid');
    }
    expect((await stat(file('form'))).mtimeMs).toBe(before.mtimeMs);
    // Before any read: a scenario that does not exist still answers 400 for an action outside the palette (not 404).
    const ghost = await call('scenario_edit', { project: P, name: 'no-such-scenario', hash: h, edit: { kind: 'insert_step', to: { scene: 'a', index: 0 }, after: null, action: 'eval', values: { 'eval.js': 'x' } } });
    expect(ghost.status).toBe(400);
  });

  it('a form change and a palette step are written (one line each); a field changed meanwhile is a 409 with stale and the field; a secret reference typed in is refused for the Studio', async () => {
    await writeFile(file('form'), FORM);
    const r = await call('scenario_edit', { project: P, name: 'form', hash: sha(FORM), edit: { kind: 'set_step', at: { scene: 'a', index: 0, guard: g0 }, changes: [{ path: ['click', 'aria'], from: 'Increase', to: 'Decrease' }] } });
    expect(r.status).toBe(200);
    expect(r.json<Answer<{ label: string }>>().data.label).toBe('Changed click aria of step 1 of a');
    const t1 = await readFile(file('form'), 'utf8');
    expect(t1).toBe(FORM.replace('aria: Increase', 'aria: Decrease'));
    const g1 = guardOf({ click: { aria: 'Decrease', in: 'dialog' } });
    const stale = await call('scenario_edit', { project: P, name: 'form', hash: sha(t1), edit: { kind: 'set_step', at: { scene: 'a', index: 0, guard: g1 }, changes: [{ path: ['click', 'aria'], from: 'Increase', to: 'Other' }] } });
    expect(stale.status).toBe(409);
    expect(stale.json<Answer<unknown>>().error?.details).toEqual({ current: sha(t1), stale: true, field: 'click.aria' });
    const leak = await call('scenario_edit', { project: P, name: 'form', hash: sha(t1), edit: { kind: 'set_step', at: { scene: 'a', index: 0, guard: g1 }, changes: [{ path: ['click', 'aria'], from: 'Decrease', to: '{{env:SHOP_TOKEN}}' }] } });
    expect(leak.status).toBe(400);
    expect(leak.body).toContain('from the Studio a scenario never resolves a secret');
    const ins = await call('scenario_edit', { project: P, name: 'form', hash: sha(t1), edit: { kind: 'insert_step', to: { scene: 'a', index: 2 }, after: guardOf({ hold: 0.5 }), action: 'click', values: { 'click.text': 'Save', 'click.in': 'dialog' } } });
    expect(ins.status).toBe(200);
    expect(await readFile(file('form'), 'utf8')).toBe(`${t1}      - click: {text: Save, in: dialog}\n`);
  });
});

describe('timeline switches over HTTP (L4.5 part D)', () => {
  const FIELD = 'video: field\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 0.2\n  - card: {slots: {title: Two}}\n    id: c1\n';
  const guard = (text: string, i: number) => stepGuard((parseYaml(text).value as { scenes: unknown[] }).scenes[i]);

  it('⚑ refuses a malformed set_field before any read (400), the file untouched', async () => {
    await writeFile(file('field'), FIELD);
    const before = await stat(file('field'));
    const h = sha(FIELD);
    const a = { entry: 'scene', id: 'a', guard: guard(FIELD, 0) };
    const bad: Array<[string, unknown]> = [
      ['a field outside the allow-list', { kind: 'set_field', at: a, field: 'steps', to: 'x' }],
      ['a hook path', { kind: 'set_field', at: { entry: 'top' }, field: 'hooks.setup', to: 'x' }],
      ['a var path', { kind: 'set_field', at: { entry: 'top' }, field: 'vars.who', to: 'x' }],
      ['the environment', { kind: 'set_field', at: { entry: 'top' }, field: 'env', to: 'staging' }],
      ['a scene field at the top', { kind: 'set_field', at: { entry: 'top' }, field: 'speed', to: 2 }],
      ['a top field on a scene', { kind: 'set_field', at: a, field: 'caption_component', to: 'studio/caption-pill' }],
      ['a card field on a scene', { kind: 'set_field', at: a, field: 'card.component', to: 'studio/card-title' }],
      ['an object as a value', { kind: 'set_field', at: a, field: 'frame', to: { component: 'studio/layout-laptop' } }],
      ['a list as a value', { kind: 'set_field', at: a, field: 'frame', to: ['laptop'] }],
      ['null as a value', { kind: 'set_field', at: a, field: 'frame', to: null }],
      ['a value over 200 characters', { kind: 'set_field', at: a, field: 'frame', to: 'x'.repeat(201) }],
      ['a guard that is not one', { kind: 'set_field', at: { ...a, guard: 'zz' }, field: 'frame', to: 'laptop' }],
      ['a scene without its guard', { kind: 'set_field', at: { entry: 'scene', id: 'a' }, field: 'frame', to: 'laptop' }],
      ['a path as an id', { kind: 'set_field', at: { ...a, id: '../a' }, field: 'frame', to: 'laptop' }],
      ['an unknown entry', { kind: 'set_field', at: { entry: 'hooks', id: 'a', guard: a.guard }, field: 'frame', to: 'laptop' }],
      ['an extra key at the top level', { kind: 'set_field', at: { entry: 'top', id: 'x' }, field: 'frame', to: 'laptop' }],
      ['an extra key in the edit', { kind: 'set_field', at: a, field: 'frame', to: 'laptop', yaml: 'frame: laptop' }],
    ];
    for (const [what, edit] of bad) {
      const r = await call('scenario_edit', { project: P, name: 'field', hash: h, edit });
      expect(r.status, what).toBe(400);
      expect(r.json<Answer<unknown>>().error?.code, what).toBe('invalid');
      // Before any read: a scenario that does not exist answers 400 too (not 404).
      const ghost = await call('scenario_edit', { project: P, name: 'no-such-scenario', hash: h, edit });
      expect(ghost.status, `${what} (no such scenario)`).toBe(400);
    }
    expect((await stat(file('field'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('a switch is one line and an edit change; the default removes it; a value changed meanwhile is a 409 with stale', async () => {
    await writeFile(file('field'), FIELD);
    const r = await call('scenario_edit', { project: P, name: 'field', hash: sha(FIELD), edit: { kind: 'set_field', at: { entry: 'scene', id: 'a', guard: guard(FIELD, 0) }, field: 'frame', to: 'laptop' } });
    expect(r.status, r.body.slice(0, 300)).toBe(200);
    expect(r.json<Answer<{ label: string; change: string }>>().data).toMatchObject({ label: 'Set the layout of scene a to laptop', change: 'edit' });
    const t1 = await readFile(file('field'), 'utf8');
    expect(t1).toBe(FIELD.replace('    open: /\n', '    open: /\n    frame: laptop\n'));
    const stale = await call('scenario_edit', { project: P, name: 'field', hash: sha(t1), edit: { kind: 'set_field', at: { entry: 'scene', id: 'a', guard: guard(t1, 0) }, field: 'frame', from: 'browser', to: 'phone' } });
    expect(stale.status).toBe(409);
    expect(stale.json<Answer<unknown>>().error?.details).toMatchObject({ current: sha(t1), stale: true });
    const back = await call('scenario_edit', { project: P, name: 'field', hash: sha(t1), edit: { kind: 'set_field', at: { entry: 'scene', id: 'a', guard: guard(t1, 0) }, field: 'frame', from: 'laptop' } });
    expect(back.status).toBe(200);
    expect(await readFile(file('field'), 'utf8')).toBe(FIELD);
  });

  it("review B H2: the outro switch over an outro with its own tagline is refused — the tagline survives, nothing written", async () => {
    const text = FIELD.replace('video: field\n', 'video: field\noutro:\n  tagline: Order in two clicks\n');
    await writeFile(file('field'), text);
    for (const edit of [
      { kind: 'set_field', at: { entry: 'top' }, field: 'outro', from: true, to: false },
      { kind: 'set_field', at: { entry: 'top' }, field: 'outro', from: true },
    ]) {
      const r = await call('scenario_edit', { project: P, name: 'field', hash: sha(text), edit });
      expect(r.status, JSON.stringify(edit)).toBeGreaterThanOrEqual(400);
      expect(r.body).toContain('the outro has its own tagline');
      expect(await readFile(file('field'), 'utf8')).toBe(text);
    }
    await writeFile(file('field'), FIELD);
  });
});
