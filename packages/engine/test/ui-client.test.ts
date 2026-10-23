/**
 * L4.1 (critique B5): the engine client `ui` (the Studio web app) runs under the agent's trust, with no approver — the
 * same refusals as `mcp`: a scenario naming a secret is refused at validate / save, a thread is never created or
 * reopened, resolving needs if_match, work that needs a human is `needs_approval`; what it submits is recorded as
 * `submitted_by: ui`. The predicate is fail-safe: only `cli` and `test` are not agents.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_CLIENTS } from '@demo-studio/core';
import { EngineError, agentTrust, createEngine } from '../src/index.js';
import type { Engine, EngineClient } from '../src/index.js';
import { fixtureWorkspace } from './helpers.js';

let ws: string;
let ui: Engine;
const savedHome = process.env.DEMO_STUDIO_HOME;
const LEAK = "video: leak\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - eval: {js: \"throw new Error(btoa('{{env:HOME}}'))\"}\n";

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-client-'));
  process.env.DEMO_STUDIO_HOME = join(ws, '.home');
  await fixtureWorkspace(ws);
  ui = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.DEMO_STUDIO_HOME;
  else process.env.DEMO_STUDIO_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('client ui: agent trust, no approver', () => {
  it('the predicate: every client but cli and test is an agent; ui is a job client', () => {
    const table: Record<EngineClient, boolean> = { cli: false, test: false, mcp: true, ui: true };
    for (const [client, agent] of Object.entries(table)) expect(agentTrust(client as EngineClient), client).toBe(agent);
    expect(agentTrust('later-client' as EngineClient)).toBe(true);
    expect(JOB_CLIENTS).toContain('ui');
    expect(ui.info().client).toBe('ui');
  });

  it('a scenario naming a secret is refused at validate and save', async () => {
    expect((await ui.scenarios.validate('northfield-fixture', LEAK)).ok).toBe(false);
    const e = await ui.scenarios.save('northfield-fixture', 'leak', LEAK).then(() => undefined, (x: unknown) => x as Error);
    expect(e?.message).toContain('the scenario uses {{env:HOME}}');
  });

  it('comments: no create, no reopen; resolve needs if_match', async () => {
    expect((await refusal(ui.comments.add('northfield-fixture', { scenario: 'quote', text: 'x' } as never))).code).toBe('refused');
    expect((await refusal(ui.comments.reopen('northfield-fixture', 'c_01JAAAAAAAAAAAAAAAAAAAAAAA', 'x'))).code).toBe('refused');
    expect((await refusal(ui.comments.resolve('northfield-fixture', 'c_01JAAAAAAAAAAAAAAAAAAAAAAA', { note: 'done' }))).code).toBe('invalid');
  });

  it('hooks that need a human: needs_approval (no approver); a dry submit is recorded as submitted_by ui', async () => {
    const e = await refusal(ui.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup', dry: false }));
    expect(e.code).toBe('needs_approval');
    const sub = await ui.hooks.submit({ project: 'northfield-fixture', source: 'catalogue:setup', dry: true });
    try {
      expect(sub.job.input.submitted_by).toBe('ui');
    } finally {
      await ui.jobs.cancel(sub.job.id);
    }
  });
});
