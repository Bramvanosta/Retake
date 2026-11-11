/**
 * L5.16d — the desktop app's updates in the Studio server (update-ops.ts; DESIGN §4p (d)), through its HTTP API: the
 * shell's update lines on stdin parsed strictly (fixed keys per state, enums, versions, counts, notes without control
 * or bidi characters), kept and read back by `desktop_update_status` (the notes under `untrusted`), and the sheet's
 * click `desktop_update` written as one pipe line of exactly `{type, action}` — Studio only (never an MCP tool: an
 * agent never installs and restarts the app), the desktop app's own server only, Install only while an update is
 * known, capped a minute, never nudging the job watch.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TOOLS } from '@retake/mcp';
import { OWN_OPS, SHELL_LINE_MAX, UI_OPS, UPDATE_CLICKS_PER_MIN, UPDATE_NOTES_MAX, UPDATE_OPS, applyShellLine, installable, parseShellLine, startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { raw } from './http.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'update-ops-')));
const ws = join(base, 'ws');
let studio: StudioServer;
const lines: string[] = [];

beforeAll(async () => {
  mkdirSync(ws);
  await fixtureWorkspace(ws);
  studio = await startStudioServer({ root: ws, startWorker: false });
});
afterAll(async () => {
  await studio?.close();
  rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  lines.length = 0;
  (studio.update as unknown as { window: { start: number; count: number } }).window = { start: 0, count: 0 };
});

const call = async (op: string, args: Record<string, unknown> = {}) => {
  const r = await raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
  return { status: r.status, body: r.json<{ data: Record<string, any>; error: { code: string; details?: { reason?: string } } }>() };
};
const shell = (o: Record<string, unknown>) => applyShellLine(studio.setup, ws, JSON.stringify(o), studio.update);
const L = {
  off: { type: 'update', state: 'off', current: '0.2.0', reason: 'build' },
  idle: { type: 'update', state: 'idle', current: '0.2.0', checked: 1762000000 },
  checking: { type: 'update', state: 'checking', current: '0.2.0' },
  updated: { type: 'update', state: 'updated', current: '0.2.0', checked: null },
  available: { type: 'update', state: 'available', current: '0.2.0', version: '0.2.1', notes: 'Faster renders.\n<b>bold?</b>', checked: null },
  downloading: { type: 'update', state: 'downloading', current: '0.2.0', version: '0.2.1', received: 152_000_000, total: 370_000_000 },
  waiting: { type: 'update', state: 'waiting', current: '0.2.0', version: '0.2.1', jobs: 2 },
  installing: { type: 'update', state: 'installing', current: '0.2.0', version: '0.2.1' },
  failed: { type: 'update', state: 'failed', current: '0.2.0', failure: 'download', version: '0.2.1', checked: 5, retry: true },
} as const;

describe('the shell\'s update lines', () => {
  it('each state\'s exact shape is taken; an extra or missing key, a bad version, enum, count or note is dropped', () => {
    for (const l of Object.values(L)) expect(parseShellLine(JSON.stringify(l)), l.state).toEqual(l);
    expect(parseShellLine(JSON.stringify({ ...L.failed, failure: 'check', version: null, retry: false }))).not.toBeNull();
    // BL-167: a download without an announced size.
    expect(parseShellLine(JSON.stringify({ ...L.downloading, received: 0, total: null }))).not.toBeNull();
    const bad: Array<Record<string, unknown>> = [
      { ...L.available, url: 'https://downloads.example.test/x.tar.gz' },
      { type: 'update', state: 'available', current: '0.2.0', version: '0.2.1', checked: null },
      { ...L.available, version: 'v0.2.1' },
      { ...L.available, version: '0.2.1"><img>' },
      { ...L.available, current: 'dev' },
      { ...L.available, notes: 'ok\u202egnp' },
      { ...L.available, notes: 'bell\u0007' },
      // Review d B-L4 (a): the isolates too (U+2066 – U+2069).
      { ...L.available, notes: 'ok\u2067x' },
      { ...L.failed, retry: 'yes' },
      { ...L.failed, failure: 'check', version: null, retry: true },
      (({ retry: _r, ...rest }) => rest)(L.failed),
      { ...L.available, notes: 'x'.repeat(UPDATE_NOTES_MAX + 2) },
      { ...L.available, checked: -1 },
      { ...L.available, checked: 1.5 },
      { ...L.off, reason: 'because' },
      { ...L.failed, failure: 'format_disk' },
      { ...L.waiting, jobs: 0 },
      { ...L.updated, version: '0.2.0' },
      // BL-167: the download's bytes — whole, never negative, a size above zero, both keys always there.
      { ...L.downloading, received: -1 },
      { ...L.downloading, received: 1.5 },
      { ...L.downloading, received: '12' },
      { ...L.downloading, total: 0 },
      { ...L.downloading, total: '370' },
      (({ total: _t, ...rest }) => rest)(L.downloading),
      { type: 'update', state: 'downloading', current: '0.2.0', version: '0.2.1' },
      { ...L.installing, received: 1 },
      { ...L.waiting, jobs: '2' },
      { type: 'update', state: 'rebooting', current: '0.2.0' },
      { type: 'update', state: 'checking', current: '0.2.0', notes: 'x' },
    ];
    for (const b of bad) expect(parseShellLine(JSON.stringify(b)), JSON.stringify(b)).toBeNull();
    // Notes at the cap (plus the shell's "…") pass; the whole line stays within the stdin cap.
    expect(parseShellLine(JSON.stringify({ ...L.available, notes: `${'é'.repeat(UPDATE_NOTES_MAX)}…` }))).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify({ ...L.available, notes: `${'é'.repeat(UPDATE_NOTES_MAX)}…` }))).toBeLessThan(SHELL_LINE_MAX);
  });

  it('installable: available, or a failure the shell says may be tried again (retry) — never a dead Install', () => {
    expect(installable(L.available as never)).toBe(true);
    expect(installable(L.failed as never)).toBe(true);
    expect(installable({ ...L.failed, failure: 'install' } as never)).toBe(true);
    // Review d M2: a failed install remembered by the restarted app (no update known yet) is not installable.
    expect(installable({ ...L.failed, failure: 'install', retry: false } as never)).toBe(false);
    // A folder this account may not write never retries, whatever the line says.
    expect(installable({ ...L.failed, failure: 'not_writable', retry: true } as never)).toBe(false);
    for (const l of [L.off, L.idle, L.checking, L.downloading, L.waiting, L.installing, { ...L.failed, failure: 'not_writable', retry: false }, { ...L.failed, failure: 'check', version: null, retry: false }]) expect(installable(l as never), l.state).toBe(false);
    expect(installable(undefined)).toBe(false);
  });
});

describe('who may call them', () => {
  it('Studio-only own ops in the ui allow-list; never MCP tools; Install never nudges the job watch', async () => {
    expect(UPDATE_OPS).toEqual(['desktop_update_status', 'desktop_update']);
    for (const op of UPDATE_OPS) {
      expect(OWN_OPS as readonly string[]).toContain(op);
      expect(UI_OPS as readonly string[]).toContain(op);
    }
    expect(TOOLS.map((t) => t.name).filter((n) => /update/.test(n) && n.startsWith('desktop'))).toEqual([]);
    const src = await import('node:fs').then((fs) => fs.readFileSync(join(__dirname, '..', 'src', 'server', 'studio.ts'), 'utf8'));
    expect(/const NO_NUDGE = new Set<string>\(\[([^\]]*)\]\)/.exec(src)?.[1]).toContain("'desktop_update'");
  });

  it('not the desktop app\'s server: status says so, the click is refused — nothing written', async () => {
    expect((await call('desktop_update_status')).body.data).toEqual({ available: false, reason: 'not_supervised' });
    const r = await call('desktop_update', { action: 'install' });
    expect(r.status).toBe(409);
    expect(r.body.error.details?.reason).toBe('not_supervised');
  });
});

describe('the desktop app\'s own server', () => {
  beforeAll(() => studio.desktop.attach((l) => (lines.push(l), true)));

  it('the status follows the shell\'s lines; the notes come under untrusted; strict input', async () => {
    studio.update.last = undefined;
    expect((await call('desktop_update_status')).body.data).toEqual({ available: true, state: 'unknown' });
    expect(shell(L.idle)).toBe(true);
    expect((await call('desktop_update_status')).body.data).toEqual({ available: true, state: 'idle', current: '0.2.0', checked: 1762000000, installable: false });
    expect(shell(L.available)).toBe(true);
    const s = (await call('desktop_update_status')).body.data;
    expect(s).toEqual({ available: true, state: 'available', current: '0.2.0', version: '0.2.1', checked: null, installable: true, untrusted: { notes: 'Faster renders.\n<b>bold?</b>' } });
    expect('notes' in s).toBe(false);
    // A dropped line keeps the last state.
    expect(shell({ ...L.available, version: 'nine' })).toBe(false);
    expect((await call('desktop_update_status')).body.data.version).toBe('0.2.1');
    expect(shell(L.waiting)).toBe(true);
    expect((await call('desktop_update_status')).body.data).toEqual({ available: true, state: 'waiting', current: '0.2.0', version: '0.2.1', jobs: 2, installable: false });
    expect((await call('desktop_update_status', { x: 1 })).status).toBe(400);
  });

  it('Install and Restart / Later: exactly one pipe line of {type, action}; Install only while an update is known', async () => {
    shell(L.available);
    expect((await call('desktop_update', { action: 'install' })).body.data).toEqual({ ok: true });
    expect((await call('desktop_update', { action: 'later' })).body.data).toEqual({ ok: true });
    expect(lines).toEqual(['{"type":"update","action":"install"}', '{"type":"update","action":"later"}']);
    for (const bad of [{}, { action: 'check' }, { action: 'install', version: '9.9.9' }, { action: 'install', url: 'https://downloads.example.test/x' }]) expect((await call('desktop_update', bad)).status, JSON.stringify(bad)).toBe(400);
    for (const l of [L.idle, L.off, L.downloading, L.installing, { ...L.failed, failure: 'not_writable', retry: false }, { ...L.failed, failure: 'install', retry: false }]) {
      shell(l);
      const r = await call('desktop_update', { action: 'install' });
      expect(r.status, l.state).toBe(409);
      expect(r.body.error.details?.reason).toBe('no_update');
    }
    // Later stays possible in any state (it stops a wait).
    expect((await call('desktop_update', { action: 'later' })).status).toBe(200);
    shell(L.failed);
    expect((await call('desktop_update', { action: 'install' })).status).toBe(200);
    expect(lines).toHaveLength(4);
  });

  it(`at most ${UPDATE_CLICKS_PER_MIN} clicks a minute`, async () => {
    shell(L.available);
    for (let i = 0; i < UPDATE_CLICKS_PER_MIN; i++) expect((await call('desktop_update', { action: 'later' })).status).toBe(200);
    const r = await call('desktop_update', { action: 'install' });
    // `busy` (423), like the set-up ops' cap.
    expect(r.status).toBe(423);
    expect(r.body.error.details?.reason).toBe('rate');
    expect(lines).toHaveLength(UPDATE_CLICKS_PER_MIN);
  });

  it('a closed pipe (the server stopping) says the click was not sent', async () => {
    studio.desktop.attach(() => false);
    shell(L.available);
    const r = await call('desktop_update', { action: 'install' });
    expect(r.status).toBe(503);
    expect(r.body.error.details?.reason).toBe('stopped');
    studio.desktop.attach((l) => (lines.push(l), true));
  });
});
