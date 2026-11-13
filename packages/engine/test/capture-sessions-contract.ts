/**
 * The capture runner's contract for what is not a run (the CaptureRunner port, src/capture/runner.ts): a persona's
 * session (its check, its sign-in, its lock, its last status), the js hooks' pages, a recording's window and a site's
 * facts. One suite both adapters pass: the runner package (`runnerWebCapture`, in a real Chromium on local test pages —
 * its browser cases skipped without one) and the in-memory runner (src/capture/memory-sessions.ts).
 *
 * Not here, because it is not an adapter's: which persona a js hook's tab is signed in as, the sign-in landing's words,
 * the trust rule that hands the persona's own origins (engine hooks.ts, hooks-pages.test.ts); the preflight of a
 * recording (record.ts, record.test.ts); a run (capture-runner-contract.ts).
 */
import { enginePorts } from '../src/index.js';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERSON_POLICY, resolveEnvironment } from '@retake/core';
import type { LoadedProject, RecordedEvent, ResolvedPersona } from '@retake/core';
import type { PersonaStatusRecord, RecordSessionOptions, SiteExtractOptions } from '@retake/runner-web/types';
import type { CaptureRunner } from '../src/capture/runner.js';
import { EngineError } from '../src/errors.js';

export interface ContractSessions {
  runner: CaptureRunner;
  /** A project whose environment `test` has the pages `app` (a cookie sign-in) and `rec` (a page with a Go button). */
  project: LoadedProject;
  /** `ada`: pages [app], a check, login steps; `plain`: pages [app], no check, no login steps. */
  persona(name: 'ada' | 'plain'): ResolvedPersona;
  /** Make the master profile folder's lock what `state` says. */
  arrangeLock(dir: string, state: 'none' | 'stale' | 'live'): Promise<void>;
  /** Write a persona's last status record. */
  arrangeStatus(file: string, rec: PersonaStatusRecord): Promise<void>;
  /** js hook code that answers 42. */
  answer: string;
  /** The recording window's page and how the person plays it (one press of Go, then the window closes). */
  record: Pick<RecordSessionOptions, 'url' | 'drive' | 'headless' | 'windowSize'>;
  /** A site's extraction (absent: no way to serve one here — its case is skipped). */
  site?: Pick<SiteExtractOptions, 'url' | 'host' | 'testResolve'>;
  /** The browser cases run (a real Chromium is there, or no browser is needed). */
  browser: boolean;
}

const named = async (p: Promise<unknown>): Promise<{ name: string; message: string } | null> =>
  p.then(
    () => null,
    (e: unknown) => ({ name: (e as Error).name, message: (e as Error).message }),
  );

/** `make(name)`: an adapter and its material, new each call (its own project and Retake home paths). */
export function captureSessionsContract(adapter: string, make: (name: string) => Promise<ContractSessions>): void {
  describe(`the capture sessions contract (${adapter})`, () => {
    it('a persona that declares no check is unchecked, nothing opened', async () => {
      const c = await make('unchecked');
      const env = resolveEnvironment(c.project, 'test');
      expect(await c.runner.sessions.check({ project: c.project, policy: PERSON_POLICY, env, persona: c.persona('plain') })).toEqual({ status: 'unchecked', detail: 'no check declared', ms: 0 });
    });

    it("a master profile's lock: none, left behind (stale, its pid), held (live)", async () => {
      const c = await make('lock');
      const dir = c.persona('ada').profileDir!;
      await c.arrangeLock(dir, 'none');
      expect(await c.runner.sessions.lock(dir)).toEqual({ state: 'none' });
      await c.arrangeLock(dir, 'stale');
      expect(await c.runner.sessions.lock(dir)).toMatchObject({ state: 'stale', pid: expect.any(Number) });
      await c.arrangeLock(dir, 'live');
      expect(await c.runner.sessions.lock(dir)).toMatchObject({ state: 'live', pid: process.pid });
    });

    it('the last status: null before any check, then the record written', async () => {
      const c = await make('status');
      const file = c.persona('ada').statusFile;
      expect(await c.runner.sessions.status(file)).toBeNull();
      const rec: PersonaStatusRecord = {
        version: 1,
        status: 'expired',
        checked_at: '2026-11-11T10:00:00.000Z',
        by: 'preflight',
        run: '20261111-100000-quote',
        at: 'http://127.0.0.1/sign-in',
        detail: 'signed out',
      };
      await c.arrangeStatus(file, rec);
      expect(await c.runner.sessions.status(file)).toEqual(rec);
    });

    it('a js-hook browser of another runner is refused, never used', async () => {
      const c = await make('foreign');
      const env = resolveEnvironment(c.project, 'test');
      const foreign = { close: async () => undefined };
      const e = await c.runner.hookPages.evalIn(foreign, { project: c.project, env, log: () => undefined }, undefined, c.answer).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(EngineError);
      expect(e).toMatchObject({ code: 'internal', message: expect.stringMatching(/opened by another capture runner/) });
    });

    describe('with a browser (skipped without Chromium)', () => {
      it('a sign-in already cancelled is a CancelledError, nothing signed in', async (t) => {
        const c = await make('signin-cancel');
        if (!c.browser) return t.skip();
        const stop = new AbortController();
        stop.abort();
        const env = resolveEnvironment(c.project, 'test');
        const e = await named(
          c.runner.sessions.signIn({
            resolveSecret: (ref) => enginePorts().secrets.resolve(ref),
            project: c.project,
            policy: PERSON_POLICY,
            env,
            persona: c.persona('ada'),
            mode: 'auto',
            signal: stop.signal,
          }),
        );
        expect(e?.name).toBe('CancelledError');
      });

      it("auto: the persona's login steps sign it in, checked the way a run sees it; then its saved session checks valid", async (t) => {
        const c = await make('signin');
        if (!c.browser) return t.skip();
        const env = resolveEnvironment(c.project, 'test');
        const opened: string[] = [];
        const r = await c.runner.sessions.signIn({
          resolveSecret: (ref) => enginePorts().secrets.resolve(ref),
          project: c.project,
          policy: PERSON_POLICY,
          env,
          persona: c.persona('ada'),
          mode: 'auto',
          onOpen: (u) => opened.push(u),
        });
        expect(r.persona).toBe('ada');
        expect(r.check.status).toBe('valid');
        expect(opened).toHaveLength(1);
        expect((await c.runner.sessions.check({ project: c.project, policy: PERSON_POLICY, env, persona: c.persona('ada') })).status).toBe('valid');
      }, 60_000);

      it('js hooks run in a browser of the persona; its http auth reads the session, for its own pages only when asked', async (t) => {
        const c = await make('pages');
        if (!c.browser) return t.skip();
        const env = resolveEnvironment(c.project, 'test');
        const ada = c.persona('ada');
        await c.runner.sessions.signIn({ resolveSecret: (ref) => enginePorts().secrets.resolve(ref), project: c.project, policy: PERSON_POLICY, env, persona: ada, mode: 'auto' });
        const browser = await c.runner.hookPages.open({
          policy: PERSON_POLICY,
          project: c.project,
          persona: ada,
          runId: '20261111-100000-hooks',
          log: () => undefined,
          failure: 'js hooks cannot use the saved session of persona ada:',
        });
        try {
          expect(await c.runner.hookPages.evalIn(browser, { project: c.project, env, log: () => undefined }, 'app', c.answer)).toBe(42);
          // The environment's first page when none is named.
          expect(await c.runner.hookPages.evalIn(browser, { project: c.project, env, log: () => undefined }, undefined, c.answer)).toBe(42);
          let opens = 0;
          const own = [new URL(env.pages.app).origin];
          const read = await c.runner.hookPages.authReader({
            persona: ada,
            browser: async () => (opens++, browser),
            envPages: env.pages,
            relogin: 'retake login contract --env test --persona ada',
            origins: own,
          });
          expect(opens).toBe(0);
          const auth = await read(`${env.pages.app}/api/whoami`);
          expect(auth.cookie).toMatch(/(^|; )sid=/);
          expect(opens).toBe(1);
          const away = await named(read('http://elsewhere.test/api'));
          expect(away?.message).toMatch(/sends its session only to that persona's own pages/);
          expect(opens).toBe(1);
        } finally {
          await browser.close();
        }
      }, 90_000);

      it('a recording: the window opens on its page, every event is kept in the events file and handed on, the actions counted', async (t) => {
        const c = await make('record');
        if (!c.browser) return t.skip();
        const env = resolveEnvironment(c.project, 'test');
        const dir = await mkdtemp(join(tmpdir(), 'capture-record-'));
        try {
          const eventsFile = join(dir, 'events.jsonl');
          const opened: string[] = [];
          const seen: RecordedEvent[] = [];
          const r = await c.runner.record({
            policy: PERSON_POLICY,
            project: c.project,
            env,
            persona: null,
            eventsFile,
            log: () => undefined,
            onOpen: (u) => opened.push(u),
            onEvent: (e) => seen.push(e),
            ...c.record,
          });
          expect(opened).toEqual([c.record.url]);
          expect(r.stop).toBe('closed');
          expect(r.persona).toBeNull();
          expect(r.events.some((e) => e.kind === 'pointer')).toBe(true);
          expect(r.counts.actions).toBeGreaterThanOrEqual(1);
          expect(r.counts.events).toBe(r.events.length);
          expect(seen.map((e) => e.seq)).toEqual(r.events.map((e) => e.seq));
          const lines = (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean);
          expect(lines.map((l) => (JSON.parse(l) as RecordedEvent).seq)).toEqual(r.events.map((e) => e.seq));
          const cancel = new AbortController();
          cancel.abort();
          const cancelled = await named(
            c.runner.record({ policy: PERSON_POLICY, project: c.project, env, eventsFile: join(dir, 'cancelled.jsonl'), signal: cancel.signal, log: () => undefined, ...c.record }),
          );
          expect(cancelled?.name).toBe('CancelledError');
          expect(existsSync(join(dir, 'cancelled.jsonl'))).toBe(false);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, 90_000);

      it("a site's facts: the report for the URL asked, written as site.json in its folder", async (t) => {
        const c = await make('site');
        if (!c.browser || !c.site) return t.skip();
        const outDir = await mkdtemp(join(tmpdir(), 'capture-site-'));
        try {
          const r = await c.runner.site.extract({ policy: PERSON_POLICY, outDir, ...c.site });
          expect(r.url).toBe(c.site.url);
          expect(r.status).toBe('ok');
          expect(r.palette?.roles.paper).toMatch(/^#[0-9a-f]{6}$/);
          const written = JSON.parse(await readFile(join(outDir, 'site.json'), 'utf8')) as { url: string; status: string };
          expect(written).toMatchObject({ url: c.site.url, status: 'ok' });
        } finally {
          await rm(outDir, { recursive: true, force: true });
        }
      }, 120_000);
    });
  });
}
