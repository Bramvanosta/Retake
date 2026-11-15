/**
 * R-SBX-11: a sandbox reset that puts a Firebase Auth emulator's accounts back signs out every
 * persona session saved before — its ID token names accounts the emulator no longer has. prepareSessions starts such a
 * session signed out (never copied, never sent), so the take's preflight signs it in with its login steps, off camera;
 * a persona without login steps is refused naming the fix (sandbox.yaml, never `retake login`, which would not last);
 * hooks outside a take, which have no preflight, refuse it instead of sending a request without its token. No browser:
 * the sessions are files under a temp folder, the preflight's browser a stand-in that is never opened.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedPersona } from '@retake/core/environment';
import { PreflightError } from '../src/errors.js';
import { preflight, prepareSessions, signedOutByReset } from '../src/auth.js';
import type { PreparedSession } from '../src/auth.js';
import type { BrowserSession } from '../src/session.js';
import { RunSecrets } from '../src/secrets.js';

let root: string;
const PUT_BACK = '2026-11-15T21:31:07.000Z';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-session-reset-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A storage_state persona of a sandbox environment, its session saved at `savedAt` (null: none saved). */
async function persona(name: string, o: { savedAt: string | null; state?: string | null | 'unreadable'; login?: boolean; sandbox?: boolean }): Promise<ResolvedPersona> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const snapshot = join(dir, `${name}.json`);
  if (o.savedAt) {
    await writeFile(snapshot, JSON.stringify({ cookies: [{ name: 'sid', value: 'v', domain: 'localhost', path: '/' }], origins: [], retake: { version: 1, project: 'p', env: 'sandbox', persona: name, machine: 'here', how: 'auto', created_at: o.savedAt } }));
  }
  const stateFile = join(dir, 'state.json');
  if (o.state === 'unreadable') await writeFile(stateFile, '{ not json');
  else if (o.state !== null) await writeFile(stateFile, JSON.stringify({ version: 1, env: 'sandbox', provider: 'docker-compose', services: {}, accounts_at: o.state ?? PUT_BACK }));
  return {
    name,
    env: 'sandbox',
    legacy: false,
    pages: ['app'],
    session: 'storage_state',
    loginPatterns: [],
    ...(o.login === false ? {} : { login: [{ open: 'app:/sign-in' }] as never }),
    snapshot,
    statusFile: join(dir, `${name}.status.json`),
    ...(o.sandbox === false ? {} : { sandbox: true as const, sandboxState: stateFile }),
  };
}

const log = () => undefined;

describe('a sandbox reset that puts the Firebase Auth accounts back signs the personas out', () => {
  it('a sandbox persona saved before its sandbox\'s accounts were put back starts fresh (no copy, no snapshot), one saved after is used as it is', async () => {
    const before = await persona('owner', { savedAt: '2026-11-15T21:00:00.000Z' });
    const after = await persona('admin', { savedAt: '2026-11-15T21:40:00.000Z' });
    const [b, a] = await prepareSessions([before, after], { runId: 'r1', log });
    expect(b).toMatchObject({ source: 'fresh', signedOut: PUT_BACK });
    expect(b.realm).toEqual({ name: 'owner' });
    expect(a.source).toBe('snapshot');
    expect(a.signedOut).toBeUndefined();
    expect(a.realm.storageState).toMatchObject({ cookies: [{ name: 'sid' }] });
  });

  it('without the snapshot\'s own time, its file\'s time says when it was saved; never signed in stays "never"', async () => {
    const p = await persona('legacy-meta', { savedAt: '2026-11-15T21:00:00.000Z' });
    await writeFile(p.snapshot!, JSON.stringify({ cookies: [], origins: [] }));
    await utimes(p.snapshot!, new Date('2026-11-15T22:00:00Z'), new Date('2026-11-15T22:00:00Z'));
    expect(await signedOutByReset(p, { cookies: [], origins: [] }, false)).toBeNull();
    await utimes(p.snapshot!, new Date('2026-11-15T20:00:00Z'), new Date('2026-11-15T20:00:00Z'));
    expect(await signedOutByReset(p, { cookies: [], origins: [] }, false)).toBe(PUT_BACK);
    const never = await persona('never', { savedAt: null });
    const [n] = await prepareSessions([never], { runId: 'r2', log });
    expect(n.source).toBe('fresh');
    expect(n.signedOut).toBeUndefined();
  });

  it('a persona that is not such a sandbox account ignores the sandbox state; a missing or unreadable state changes nothing', async () => {
    const plain = await persona('plain', { savedAt: '2026-11-15T21:00:00.000Z', sandbox: false });
    const missing = await persona('missing', { savedAt: '2026-11-15T21:00:00.000Z', state: null });
    const broken = await persona('broken', { savedAt: '2026-11-15T21:00:00.000Z', state: 'unreadable' });
    const noTime = await persona('no-time', { savedAt: '2026-11-15T21:00:00.000Z', state: 'not a date' });
    const out = await prepareSessions([plain, missing, broken, noTime], { runId: 'r3', log });
    expect(out.map((x) => x.source)).toEqual(['snapshot', 'snapshot', 'snapshot', 'snapshot']);
    expect(out.every((x) => x.signedOut === undefined)).toBe(true);
  });

  it('hooks outside a take refuse a signed-out session, naming the reset and the sign-in — never a request without its token', async () => {
    const p = await persona('hooked', { savedAt: '2026-11-15T21:00:00.000Z' });
    const e = await prepareSessions([p], { runId: 'r4', log, signedOut: 'refuse', project: 'shop', failure: 'js hooks cannot use the saved session of persona hooked:' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PreflightError);
    expect((e as Error).message).toMatch(
      /^js hooks cannot use the saved session of persona hooked:\n {2}persona hooked \(env sandbox\): signed out by the sandbox reset of \d\d:\d\d:\d\d \(it put the Firebase Auth emulator's accounts back\)\n {4}a take signs it in again off camera \(its login steps\); outside a take, sign it in: retake login shop --env sandbox --persona hooked$/,
    );
  });

  it('the preflight refuses a signed-out persona without login steps, naming sandbox.yaml — not retake login, which the next reset would undo', async () => {
    const p = await persona('viewer', { savedAt: '2026-11-15T21:00:00.000Z', login: false });
    const prepared: PreparedSession[] = await prepareSessions([p], { runId: 'r5', log });
    expect(prepared[0]).toMatchObject({ source: 'fresh', signedOut: PUT_BACK });
    // Never opened: a persona without `check` is not checked in a page.
    const session = { contextOf: async () => ({}) } as unknown as BrowserSession;
    const e = await preflight(session, prepared, { project: 'shop', env: 'sandbox', runId: 'r5', log, secrets: new RunSecrets(), template: { pages: {}, vars: {} } as never, envPages: {}, kitSource: '' }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(PreflightError);
    const msg = (e as Error).message;
    expect(msg).toMatch(/persona viewer \(env sandbox\): signed out by the sandbox reset of .*\(it put the Firebase Auth emulator's accounts back\)/);
    expect(msg).toMatch(/give accounts\.viewer login steps in sandbox\.yaml: a take then signs it in with them, off camera/);
    expect(msg).not.toMatch(/sign in once: retake login/);
  });
});
