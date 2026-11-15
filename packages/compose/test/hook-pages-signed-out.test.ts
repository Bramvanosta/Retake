/**
 * R-SBX-11 where it is wired: the capture runner's hook pages (`runnerWebCapture().hookPages.open`, the browser of a
 * js hook or of an http hook's `auth: {persona}` outside a take) refuse a sandbox persona whose session the sandbox's
 * reset signed out (its Firebase Auth accounts put back after the session was saved) — there is no preflight there to
 * sign it in again, and a request without its token must never go out. No browser: the refusal comes first.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY } from '@retake/core';
import type { LoadedProject, ResolvedPersona } from '@retake/core';
import { runnerWebCapture } from '@retake/compose';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-hook-pages-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function signedOutPersona(login: boolean): Promise<ResolvedPersona> {
  const snapshot = join(root, 'owner.json');
  const state = join(root, 'state.json');
  await mkdir(root, { recursive: true });
  await writeFile(snapshot, JSON.stringify({ cookies: [], origins: [], retake: { version: 1, project: 'shop', env: 'sandbox', persona: 'owner', machine: 'here', how: 'auto', created_at: '2026-11-15T21:00:00.000Z' } }));
  await writeFile(state, JSON.stringify({ version: 1, env: 'sandbox', provider: 'docker-compose', services: {}, accounts_at: '2026-11-15T21:31:07.000Z' }));
  return {
    name: 'owner',
    env: 'sandbox',
    legacy: false,
    pages: ['app'],
    session: 'storage_state',
    loginPatterns: [],
    ...(login ? { login: [{ open: 'app:/sign-in' }] as never } : {}),
    snapshot,
    statusFile: join(root, 'owner.status.json'),
    sandbox: true,
    sandboxState: state,
  };
}

const project = () => ({ slug: 'shop', dir: root, config: { capture: { width: 1280, height: 720, scale: 1 } } }) as unknown as LoadedProject;

describe('hook pages outside a take', () => {
  it('refuse a sandbox persona signed out by a reset, naming the reset and the sign-in, before any browser opens', async () => {
    const capture = runnerWebCapture();
    const open = (persona: ResolvedPersona) =>
      capture.hookPages.open({ policy: PERSON_POLICY, project: project(), persona, runId: 'hooks-1', log: () => undefined, failure: 'js hooks cannot use the saved session of persona owner:' });
    const e = await open(await signedOutPersona(true)).catch((x: unknown) => x);
    expect((e as Error).name).toBe('PreflightError');
    expect((e as Error).message).toMatch(
      /^js hooks cannot use the saved session of persona owner:\n {2}persona owner \(env sandbox\): signed out by the sandbox reset of \d\d:\d\d:\d\d \(it put the Firebase Auth emulator's accounts back\)\n {4}a take signs it in again off camera \(its login steps\); outside a take, sign it in: retake login shop --env sandbox --persona owner$/,
    );
    // Without login steps, the line says what would let a take sign it in.
    const none = await open(await signedOutPersona(false)).catch((x: unknown) => x);
    expect((none as Error).message).toMatch(/\n {4}give accounts\.owner login steps in sandbox\.yaml: a take then signs it in with them, off camera/);
  });
});
