/**
 * The Studio's per-scenario chain (critique B5 of L4.6), characterized through its real server before scenario_render
 * became the engine's operation (L7.15) and held after: scenario_edit, scenario_render, thread_apply and record_save of
 * one scenario run one at a time in a server, in the order they came; another scenario's do not wait. The engine's
 * methods these ops call are replaced on the server's own engine by probes that hold until released (each logs when it
 * starts and ends), so the order is the chain's alone — nothing is written, planned or queued. A probe's call fails
 * (409) once released: the ops' answers are not what this test is about. The chain's keys are `<project>\0<name>`:
 * an edit of "quote" and a render of "quote" share one; a render of "catalogue" has its own.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineError } from '@retake/engine';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { raw } from './http.js';

const P = 'northfield-fixture';
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const HEX = 'a'.repeat(64);
let ws: string;
let studio: StudioServer;
const savedHome = process.env.RETAKE_HOME;

/** The probes' log and their gates: each call of a probe waits for `release(label)`. */
const log: string[] = [];
const gates = new Map<string, () => void>();
async function held(label: string): Promise<never> {
  log.push(`start ${label}`);
  await new Promise<void>((r) => gates.set(label, r));
  log.push(`end ${label}`);
  throw new EngineError('conflict', `probe ${label}`);
}
async function release(label: string): Promise<void> {
  for (let i = 0; i < 200 && !gates.has(label); i++) await new Promise((r) => setTimeout(r, 5));
  const g = gates.get(label);
  if (!g) throw new Error(`${label} never started (log: ${log.join(', ')})`);
  gates.delete(label);
  g();
}
const tick = () => new Promise((r) => setTimeout(r, 60));

/** One call of the server; the label names its probe (the call's arguments carry it where an argument is free text). */
function call(op: string, args: Record<string, unknown>) {
  return raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
}
const edit = (name: string, label: string) => call('scenario_edit', { project: P, name, hash: HEX, edit: { kind: 'replace_text', text: `${label}\n` } });
const render = (name: string, label: string) => call('scenario_render', { project: P, name, run: `20261016-090000-${label}`, expect_edit_sha256: HEX });
/** thread_apply's label is hex (it travels as the thread hash): "a1", "a2"… */
const apply = (label: string) => call('thread_apply', { project: P, comment_id: `c_${ULID}`, entry_id: `r_${ULID}`, if_match: label.padEnd(64, '0') });
const save = (name: string, label: string) => call('record_save', { project: P, rec_id: `rec_${ULID}`, name, rev: Number(label.replace(/\D/g, '')), draft: HEX });

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-scenario-chain-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  studio = await startStudioServer({ root: ws, startWorker: false });
  // The probes, on the server's own engine (the object its ops call): the label comes from each call's arguments.
  const e = studio.engine as unknown as Record<string, Record<string, (...a: never[]) => unknown>>;
  e.scenarios!.edit = ((_p: string, _n: string, o: { edit: { text: string } }) => held(o.edit.text.trim())) as never;
  e.renders!.submit = ((r: { run_id: string }) => held(r.run_id.replace(/^\d{8}-\d{6}-/, ''))) as never;
  // thread_apply reads its thread first (outside the chain): its scenario is "quote".
  e.comments!.get = (async () => ({ scenario: 'quote' })) as never;
  e.comments!.apply = ((_p: string, _id: string, o: { if_match: string }) => held(o.if_match.replace(/0+$/, ''))) as never;
  e.record!.save = ((_p: string, _id: string, o: { rev: number }) => held(`save${o.rev}`)) as never;
}, 60_000);

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe("the Studio's per-scenario chain (scenario_edit, scenario_render, thread_apply, record_save)", () => {
  it('an edit of a scenario held: its render, its apply and its save wait in order; another scenario’s render does not', async () => {
    log.length = 0;
    const answers = [edit('quote', 'edit1')];
    await tick();
    answers.push(render('quote', 'render1'));
    await tick();
    answers.push(render('catalogue', 'render2'));
    await tick();
    answers.push(apply('a1'));
    await tick();
    answers.push(save('quote', 'save1'));
    await tick();
    // Only the edit of quote and the render of catalogue have started.
    expect([...log].sort()).toEqual(['start edit1', 'start render2']);
    await release('render2');
    await tick();
    expect(log).not.toContain('start render1');
    await release('edit1');
    await tick();
    expect(log.at(-1)).toBe('start render1');
    await release('render1');
    await tick();
    expect(log.at(-1)).toBe('start a1');
    await release('a1');
    await tick();
    expect(log.at(-1)).toBe('start save1');
    await release('save1');
    const statuses = (await Promise.all(answers)).map((r) => r.status);
    expect(statuses).toEqual([409, 409, 409, 409, 409]);
    expect(log.filter((l) => !l.includes('render2'))).toEqual(['start edit1', 'end edit1', 'start render1', 'end render1', 'start a1', 'end a1', 'start save1', 'end save1']);
  });

  it('a render of a scenario held: an edit of it waits until the render settled; an edit of another scenario does not', async () => {
    log.length = 0;
    const answers = [render('quote', 'render3')];
    await tick();
    answers.push(edit('quote', 'edit2'));
    await tick();
    answers.push(edit('catalogue', 'edit3'));
    await tick();
    answers.push(render('quote', 'render4'));
    await tick();
    expect([...log].sort()).toEqual(['start edit3', 'start render3']);
    await release('edit3');
    await release('render3');
    await tick();
    expect(log.at(-1)).toBe('start edit2');
    await release('edit2');
    await tick();
    expect(log.at(-1)).toBe('start render4');
    await release('render4');
    expect((await Promise.all(answers)).map((r) => r.status)).toEqual([409, 409, 409, 409]);
    expect(log.filter((l) => !l.includes('edit3'))).toEqual(['start render3', 'end render3', 'start edit2', 'end edit2', 'start render4', 'end render4']);
  });

  it('a refused call never takes its place in the chain: a render whose arguments do not parse answers at once', async () => {
    log.length = 0;
    const first = edit('quote', 'edit4');
    await tick();
    const bad = await call('scenario_render', { project: P, name: 'quote', run: '../x', expect_edit_sha256: HEX });
    expect(bad.status).toBe(400);
    expect(log).toEqual(['start edit4']);
    await release('edit4');
    expect((await first).status).toBe(409);
  });
});
