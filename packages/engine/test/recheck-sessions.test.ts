/**
 * `retake auth status --check`'s work in the engine (auth.ts recheckSessions), on the in-memory sessions: each saved
 * session checked live, one after the other, its result saved as the persona's last status and shown in its state; a
 * persona never signed in passed over; a profile a browser holds, or one the check could not open, shown `not checked`;
 * an interrupt that fails a check ends the work.
 */
import { describe, expect, it } from 'vitest';
import { PERSON_POLICY, resolvePersonas } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { recheckSessions } from '../src/auth.js';
import type { PersonaState, SessionRecheck } from '../src/index.js';
import { MemorySessions } from '../src/capture/memory-sessions.js';

const project = {
  slug: 'shop',
  dir: '/work/projects/shop',
  config: {
    name: 'Shop',
    environments: { staging: { app: 'https://app.staging.example.com' } },
    auth: { login_url: '/login', personas: { ada: { pages: ['app'], check: { expect_text: 'Ada' } }, bob: { pages: ['app'], check: { expect_text: 'Bob' } }, cy: { pages: ['app'] } } },
  },
} as unknown as LoadedProject;
const personas = resolvePersonas(project, 'staging', { home: '/home/me/.retake' });

function row(name: string, state: Partial<PersonaState>): SessionRecheck {
  const persona = personas.find((p) => p.name === name)!;
  return { project, persona, state: { project: 'shop', env: 'staging', persona: name, session: 'profile', legacy: false, status: 'unchecked', ...state } };
}

const NOW = Date.parse('2026-11-14T10:00:00.000Z');

describe('recheckSessions: auth status --check', () => {
  it('checks each saved session, saves the result and shows it; passes over a session never signed in and one a browser holds', async () => {
    const sessions = new MemorySessions({
      checks: { ada: { status: 'valid', detail: 'app:/ shows "Ada"', ms: 3 }, bob: { status: 'expired', detail: 'signed out', at: 'https://app.staging.example.com/login', ms: 3 } },
    });
    const rows = [
      row('ada', { status: 'expired', checked_at: '2026-11-01T00:00:00.000Z', by: 'preflight', run: '20261101-000000-quote', at: 'x' }),
      row('bob', {}),
      row('cy', { status: 'never' }),
      row('ada', { status: 'valid', in_use: { pid: 7 }, checked_at: '2026-11-01T00:00:00.000Z', by: 'login' }),
    ];
    const seen: string[] = [];
    const done = await recheckSessions(rows, {
      policy: PERSON_POLICY,
      sessions,
      now: () => NOW,
      onCheck: (r) => seen.push(`check ${r.state.persona}`),
      onChecked: (r) => seen.push(`checked ${r.state.persona}`),
    });
    expect(done).toBe('done');
    expect(seen).toEqual(['check ada', 'checked ada', 'check bob', 'checked bob']);
    expect(rows.map((r) => r.state)).toEqual([
      { ...rows[0].state, status: 'valid', checked_at: '2026-11-14T10:00:00.000Z', by: 'auth-status', detail: 'app:/ shows "Ada"' },
      { ...rows[1].state, status: 'expired', checked_at: '2026-11-14T10:00:00.000Z', by: 'auth-status', detail: 'signed out', at: 'https://app.staging.example.com/login' },
      rows[2].state,
      { project: 'shop', env: 'staging', persona: 'ada', session: 'profile', legacy: false, status: 'error', in_use: { pid: 7 }, detail: 'not checked' },
    ]);
    expect(rows[0].state.run).toBeUndefined();
    expect(rows[0].state.at).toBeUndefined();
    expect(sessions.calls.filter((c) => c.member === 'save').map((c) => (c as { file: string }).file)).toEqual([rows[0].persona.statusFile, rows[1].persona.statusFile]);
    expect(sessions.statuses.get(rows[1].persona.statusFile)).toMatchObject({ version: 1, status: 'expired', by: 'auth-status', at: 'https://app.staging.example.com/login', detail: 'signed out' });
  });

  it('a profile a browser opened meanwhile (the runner refuses it by name): in use, not checked; another failure says why, on one line', async () => {
    const refused = Object.assign(new Error('the profile is in use'), { name: 'PreflightError' });
    const sessions = new MemorySessions({
      checks: { ada: refused, bob: new Error('no browser\nstack') },
      locks: { [personas.find((p) => p.name === 'ada')!.profileDir!]: { state: 'live', pid: 42 } },
    });
    const rows = [row('ada', { checked_at: '2026-11-01T00:00:00.000Z', by: 'preflight' }), row('bob', {})];
    expect(await recheckSessions(rows, { policy: PERSON_POLICY, sessions, now: () => NOW })).toBe('done');
    expect(rows[0].state).toMatchObject({ status: 'error', detail: 'not checked', in_use: { pid: 42 } });
    expect(rows[0].state.checked_at).toBeUndefined();
    expect(rows[1].state).toMatchObject({ status: 'error', detail: 'not checked: no browser' });
    expect(rows[1].state.in_use).toBeUndefined();
    expect(sessions.calls.some((c) => c.member === 'save')).toBe(false);
  });

  it('interrupted: the check that failed ends the work, nothing more checked or saved', async () => {
    const sessions = new MemorySessions({ checks: { ada: new Error('cancelled') } });
    const rows = [row('ada', {}), row('bob', {})];
    expect(await recheckSessions(rows, { policy: PERSON_POLICY, sessions, now: () => NOW, interrupted: () => true })).toBe('interrupted');
    expect(sessions.calls.filter((c) => c.member === 'check')).toHaveLength(1);
    expect(rows[0].state.status).toBe('unchecked');
  });
});
