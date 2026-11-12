/**
 * The Sandboxes port's contract (L7.25, U14 — finding X8: the process and docker-compose providers shared no suite):
 * one sequence of cases on one sandbox, run on every adapter — the sandbox package with a process sandbox and with a
 * docker-compose one (RETAKE_TEST_DOCKER=1), and the in-memory sandboxes with a manifest of each kind
 * (sandboxes.test.ts). The cases are the answers the engine and the shells read: the refusals of open (their words),
 * the handle's facts and the capabilities of its kind, status down / up, up seeding once and keeping, `seed: 'never'`,
 * a reset refused when down (`down`) and back to the seed, the take lock (busy, named, released), checkRunning, logs
 * (an unknown service refused), the follow of logs by capability, down (the data of a process sandbox goes with it).
 */
import { describe, expect, it } from 'vitest';
import { PERSON_POLICY, SandboxError, sandboxPaths } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import type { ProviderCapabilities, SandboxLog } from '@retake/sandbox/types';
import type { SandboxHandle, Sandboxes } from '../src/sandboxes/sandboxes.js';

export interface SandboxSubject {
  /** What the adapter is (the describe's title). */
  name: string;
  sandboxes: Sandboxes;
  kind: 'process' | 'docker-compose';
  /** A project whose one sandbox is environment `sandbox`. */
  project: LoadedProject;
  /** A project with no sandbox. */
  bare: LoadedProject;
  /** The services sandbox.yaml declares, in its order. */
  services: string[];
  /** How many seed steps sandbox.yaml has. */
  seedSteps: number;
}

const ALL_FALSE: ProviderCapabilities = { exec: false, logs: false, followLogs: false, snapshots: false, address: false, hashInputs: false, build: false, volumes: false };
const ALL_TRUE: ProviderCapabilities = { exec: true, logs: true, followLogs: true, snapshots: true, address: true, hashInputs: true, build: true, volumes: true };
/** The capabilities each provider kind has (the sandbox package's PROCESS_CAPABILITIES / COMPOSE_CAPABILITIES). */
export const KIND_CAPABILITIES: Record<SandboxSubject['kind'], ProviderCapabilities> = { process: ALL_FALSE, 'docker-compose': ALL_TRUE };

/** A rejection's SandboxError (its code and message), else a failure naming what came instead. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string; kind: string }> {
  try {
    await p;
  } catch (e) {
    expect(e, String(e)).toBeInstanceOf(SandboxError);
    const err = e as SandboxError;
    return { code: err.code, message: err.message, kind: err.errorKind };
  }
  throw new Error('expected a SandboxError, got an answer');
}

/** The contract, on `subject()` (built in the caller's beforeAll). The cases run in order on one sandbox. */
export function sandboxContract(subject: () => SandboxSubject, timeout = 120_000): void {
  let s: SandboxSubject;
  let sb: SandboxHandle;
  const logs: string[] = [];
  const log: SandboxLog = (level, message) => logs.push(`${level} ${message}`);
  const it_ = (title: string, fn: () => Promise<void>) => it(title, fn, timeout);

  describe('the Sandboxes contract', () => {
    it_('open refuses a project without a sandbox and an environment that is not one, in the words of the package', async () => {
      s = subject();
      expect(await refusal(s.sandboxes.open(s.bare, undefined, PERSON_POLICY))).toEqual({ code: 'failed', kind: 'not_found', message: `project ${s.bare.slug} has no sandbox: add \`sandboxes: {sandbox: sandbox/sandbox.yaml}\` to project.yaml` });
      expect(await refusal(s.sandboxes.open(s.project, 'nope', PERSON_POLICY))).toMatchObject({ code: 'failed', kind: 'not_found', message: `nope is not a sandbox of project ${s.project.slug} (sandboxes: sandbox)` });
      sb = await s.sandboxes.open(s.project, undefined, PERSON_POLICY);
    });

    it_('a handle says its environment, kind, strategy, paths and the capabilities of its kind', async () => {
      expect({ env: sb.env, kind: sb.kind, strategy: sb.strategy }).toEqual({ env: 'sandbox', kind: s.kind, strategy: 'reseed' });
      expect(sb.paths).toEqual(sandboxPaths(s.project.dir, 'sandbox'));
      expect({ ...sb.capabilities }).toEqual(KIND_CAPABILITIES[s.kind]);
      // A second open of the same environment is the same sandbox (named or not).
      expect((await s.sandboxes.open(s.project, 'sandbox', PERSON_POLICY)).paths).toEqual(sb.paths);
    });

    it_('before up: down, every declared service stopped, no seed, no lock; reset and checkRunning refused (down)', async () => {
      const st = await sb.status();
      expect(st).toMatchObject({ env: 'sandbox', provider: s.kind, state: 'down', file: s.project.sandboxes!.sandbox!.file, logs: sb.paths.logs });
      expect(st.services.map((x) => [x.name, x.state])).toEqual(s.services.map((n) => [n, 'stopped']));
      expect(st.seed).toBeUndefined();
      expect(st.lock).toBeUndefined();
      const down = await refusal(sb.reset({ log }));
      expect(down).toMatchObject({ code: 'down', kind: 'unavailable' });
      expect(down.message).toBe(`sandbox sandbox is not running (${s.services.map((n) => `${n} is not running`).join(', ')}): retake sandbox up ${s.project.slug} --env sandbox, or run with --sandbox`);
      expect(await refusal(sb.checkRunning())).toMatchObject({ code: 'down', message: down.message });
    });

    it_('up starts every service and seeds it once (never seeded); up again keeps them; seed never seeds nothing', async () => {
      const r = await sb.up({ log });
      expect({ started: r.started, kept: r.kept, changed: r.changed }).toEqual({ started: s.services, kept: [], changed: [] });
      expect(r.reset).toMatchObject({ strategy: 'reseed', restored: false, seed: { steps: s.seedSteps }, superseded: 0, restarted: [] });
      expect(logs).toContain('info seeding sandbox sandbox (never seeded)');
      const st = await sb.status();
      expect(st.state).toBe('up');
      expect(st.services.map((x) => [x.name, x.state, x.healthy])).toEqual(s.services.map((n) => [n, 'running', true]));
      expect(st.seed).toMatchObject({ current: true, hash: r.reset!.hash.slice(0, 12) });
      expect(st.last_reset).toMatchObject({ strategy: 'reseed', restored: false, by: 'sandbox up' });
      const again = await sb.up({ log });
      expect({ started: again.started, kept: again.kept }).toEqual({ started: [], kept: s.services });
      expect(again.reset).toBeUndefined();
      const never = await sb.up({ log, seed: 'never' });
      expect({ started: never.started, reset: never.reset }).toEqual({ started: [], reset: undefined });
    });

    it_('reset goes back to the seed (by: who); checkRunning answers no lock', async () => {
      const r = await sb.reset({ log });
      expect(r).toMatchObject({ strategy: 'reseed', restored: false, seed: { steps: s.seedSteps } });
      expect((await sb.status()).last_reset).toMatchObject({ by: 'sandbox reset' });
      await sb.reset({ log, by: 'contract', reseed: true });
      expect((await sb.status()).last_reset).toMatchObject({ by: 'contract' });
      expect(await sb.checkRunning()).toEqual({});
    });

    it_('a take holds the lock: another call is busy and names the holder, status and checkRunning show it, release frees it', async () => {
      const take = await sb.prepareTake({ log, command: 'run contract' });
      expect(take.info).toMatchObject({ name: 'sandbox', provider: s.kind, strategy: 'reseed', restored: false });
      expect(take.info.seed_hash).toMatch(/^[0-9a-f]{12}$/);
      expect(take.up.started).toEqual([]);
      const busy = await refusal(sb.up({ log }));
      expect(busy).toMatchObject({ code: 'busy', kind: 'busy' });
      expect(busy.message).toMatch(new RegExp(`^sandbox sandbox is in use: run contract \\(pid ${process.pid}\\) since \\d\\d:\\d\\d:\\d\\d — wait for it \\(retake sandbox status shows it\\)$`));
      expect((await refusal(sb.reset({ log }))).code).toBe('busy');
      expect((await sb.status()).lock).toMatchObject({ command: 'run contract', pid: process.pid });
      expect((await sb.checkRunning()).lock).toMatchObject({ command: 'run contract' });
      take.note('r-contract');
      expect((await sb.status()).lock).toMatchObject({ run: 'r-contract' });
      expect((await refusal(sb.down({ log }))).message).toMatch(/^sandbox sandbox is in use: run r-contract \(pid \d+\)/);
      await take.release();
      expect((await sb.status()).lock).toBeUndefined();
      expect((await sb.up({ log })).started).toEqual([]);
    });

    it_('logs: every service, or one; an unknown service is refused with the services named', async () => {
      const all = await sb.logs({ lines: 5 });
      expect(all.map((l) => l.service)).toEqual(s.services);
      const one = await sb.logs({ service: s.services[0], lines: 5 });
      expect(one.map((l) => [l.service, l.exists])).toEqual([[s.services[0], true]]);
      if (s.kind === 'process') expect(one[0]!.file).toBe(`${sb.paths.logs}/${s.services[0]}.log`);
      else expect(one[0]!.source).toEqual(expect.any(String));
      expect(await refusal(sb.logs({ service: 'nope' }))).toMatchObject({ code: 'failed', kind: 'not_found', message: `unknown service "nope" (sandbox sandbox: ${s.services.join(', ')})` });
    });

    it_('logs are followed by capability: a process sandbox refuses (its logs are files), a docker-compose one writes until the signal', async () => {
      const ac = new AbortController();
      if (!sb.capabilities.followLogs) {
        const r = await refusal(sb.followLogs({ signal: ac.signal, write: () => undefined }));
        expect(r.message).toMatch(/^sandbox sandbox: following logs is for docker-compose sandboxes — tail -f .+\/<service>\.log$/);
        return;
      }
      const lines: string[] = [];
      setTimeout(() => ac.abort(), 1500);
      await sb.followLogs({ service: s.services[0], lines: 5, signal: ac.signal, write: (l) => lines.push(l) });
      expect(ac.signal.aborted).toBe(true);
    });

    it_('down stops every service, last first; a process sandbox loses its data (the next up seeds again); down again stops nothing', async () => {
      sb.killStartedSync(); // nothing started by a call in progress: nothing to kill
      const r = await sb.down({ log });
      expect(r).toEqual({ stopped: [...s.services].reverse(), dataGone: s.kind === 'process' });
      const st = await sb.status();
      expect(st.state).toBe('down');
      expect(st.seed === undefined).toBe(s.kind === 'process');
      expect((await sb.down({ log })).stopped).toEqual([]);
    });
  });
}
