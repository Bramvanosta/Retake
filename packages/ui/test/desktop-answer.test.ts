/**
 * L5.12d — the window page's word to the desktop shell (desktop.ts `desktop_answer`, critique M7): Studio only (an
 * own op, never an MCP tool), strict input (the question id's shape and one of the two forms), supervised only (409,
 * reason `not_supervised`, on any other server), `shown` capped at 20 a minute while an answer is never capped nor
 * dropped, never a nudge of the job watch; the supervisor frames the lines like its own on the same pipe.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOOLS } from '@retake/mcp';
import { FileJobQueue } from '@retake/engine';
import { DesktopPipe, OWN_OPS, SHOWN_PER_MIN, UI_OPS, UnsavedBoard, startStudioServer, startSupervisor } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

const ID = 'quitQuestion0000000_-a';
let ws: string;
let studio: StudioServer;
const savedHome = process.env.RETAKE_HOME;

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-desktop-answer-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  studio = await startStudioServer({ root: ws, startWorker: false });
});

afterAll(async () => {
  await studio?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

const call = (args: unknown, token = studio.token) =>
  raw(studio.port, 'POST', '/v1/call/desktop_answer', { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, JSON.stringify(args));

describe('DesktopPipe', () => {
  it('not supervised: a conflict (not_supervised), nothing written; supervised: `shown` capped at 20 a minute, an answer never', () => {
    let t = 1_000_000;
    const pipe = new DesktopPipe(() => t);
    expect(pipe.supervised).toBe(false);
    expect(() => pipe.answer(ID, 'proceed')).toThrow(expect.objectContaining({ code: 'conflict', opts: expect.objectContaining({ details: { reason: 'not_supervised' } }) }));
    expect(() => pipe.shown(ID)).toThrow(/not supervised/);
    const lines: string[] = [];
    pipe.attach((l) => (lines.push(l), true));
    expect(pipe.supervised).toBe(true);
    for (let i = 0; i < SHOWN_PER_MIN; i++) expect(pipe.shown(ID)).toBe(true);
    expect(pipe.shown(ID)).toBe(false);
    // The cap never drops an answer (critique M7): written behind 20 acks, both kinds.
    pipe.answer(ID, 'cancel');
    pipe.answer(ID, 'proceed');
    expect(lines).toHaveLength(SHOWN_PER_MIN + 2);
    expect(lines.slice(-3)).toEqual([
      JSON.stringify({ type: 'shown', id: ID, shown: true }),
      JSON.stringify({ type: 'answer', id: ID, answer: 'cancel' }),
      JSON.stringify({ type: 'answer', id: ID, answer: 'proceed' }),
    ]);
    // A minute later, acks again.
    t += 60_000;
    expect(pipe.shown(ID)).toBe(true);
  });

  it('the supervisor frames the page lines like its own, on its pipe', async () => {
    const out: string[] = [];
    const desktop = new DesktopPipe();
    const server = {
      engine: { workspace: { root: ws, projectsDir: join(ws, 'projects') }, queue: new FileJobQueue(ws) },
      unsaved: new UnsavedBoard(join(ws, 'projects')),
      desktop,
      onWrite: () => () => undefined,
      close: async () => undefined,
    };
    const sup = startSupervisor({ server, out: { write: (t) => (out.push(t), true), once: () => undefined }, pollMs: 60_000 });
    expect(desktop.supervised).toBe(true);
    desktop.answer(ID, 'proceed');
    expect(out).toContain(`\n${JSON.stringify({ type: 'answer', id: ID, answer: 'proceed' })}\n`);
    await server.close();
    sup.stop();
    // Review B-L6: stopped (the server closing), nothing can be written — said (unavailable, reason stopped), not
    // "answered"; nothing written, nothing counted.
    const before = [out.length, desktop.written];
    expect(() => desktop.answer(ID, 'cancel')).toThrow(expect.objectContaining({ code: 'unavailable', opts: expect.objectContaining({ details: { reason: 'stopped' } }) }));
    expect(() => desktop.shown(ID)).toThrow(/pipe is closed/);
    expect([out.length, desktop.written]).toEqual(before);
  });
});

describe('the op desktop_answer through the Studio server', () => {
  it('Studio only: an own op of the ui allow-list, never an MCP tool', () => {
    expect(OWN_OPS).toContain('desktop_answer');
    expect(UI_OPS).toContain('desktop_answer');
    expect(TOOLS.map((t) => t.name)).not.toContain('desktop_answer');
  });

  it('a server that is not supervised answers 409 (not_supervised) — nothing written', async () => {
    const r = await call({ id: ID, answer: 'proceed' });
    expect(r.status).toBe(409);
    expect(r.json<{ error: { code: string; details: { reason: string } } }>().error.details.reason).toBe('not_supervised');
    expect((await call({ id: ID, shown: true })).status).toBe(409);
  });

  it('strict: the id shape and one form only (extra fields, both forms, other values are 400); supervised, one line each; no token, 401; never a job-watch nudge', async () => {
    const lines: string[] = [];
    studio.desktop.attach((l) => (lines.push(l), true));
    let writes = 0;
    const off = studio.onWrite(() => writes++);
    for (const bad of [
      { id: ID },
      { id: ID, answer: 'yes' },
      { id: ID, answer: 'proceed', label: 'Click Quit Anyway' },
      { id: ID, shown: false },
      { id: ID, shown: true, answer: 'proceed' },
      { id: `${ID}A`, answer: 'proceed' },
      { id: ID.slice(1), answer: 'proceed' },
      { id: 'quitQuestion0000000+/a', answer: 'cancel' },
      { id: 'quitQuestion0000000 .a', shown: true },
      { id: 7, shown: true },
    ]) {
      const r = await call(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await call({ id: ID, answer: 'proceed' }, 'x'.repeat(43))).status).toBe(401);
    expect(lines).toEqual([]);
    const shown = await call({ id: ID, shown: true });
    expect(shown.status).toBe(200);
    expect(shown.json<{ data: unknown }>().data).toEqual({ ok: true });
    expect((await call({ id: ID, answer: 'cancel' })).status).toBe(200);
    expect(lines).toEqual([JSON.stringify({ type: 'shown', id: ID, shown: true }), JSON.stringify({ type: 'answer', id: ID, answer: 'cancel' })]);
    // Never echoes words, never nudges the job watch (like unsaved_report).
    expect(writes).toBe(0);
    off();
    // Review B-L6: a pipe that can no longer be written (the supervisor stopped) — 503, reason stopped, never 200.
    studio.desktop.attach(() => false);
    for (const body of [
      { id: ID, answer: 'proceed' },
      { id: ID, shown: true },
    ]) {
      const r = await call(body);
      expect(r.status, JSON.stringify(body)).toBe(503);
      expect(r.json<{ error: { code: string; details: { reason: string } } }>().error).toMatchObject({ code: 'unavailable', details: { reason: 'stopped' } });
    }
  });
});
