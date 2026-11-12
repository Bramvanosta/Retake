/**
 * X8 (L7.25): the providers' optional methods made explicit capabilities. Every provider has every method of
 * `Provider`; `capabilities` says which ones do the work: the docker-compose provider all, the process provider none
 * (its exec, logs, followLogs and publishedBy refuse with a SandboxError naming the docker-compose provider; its
 * address and hashInputs give the neutral answers — undefined, none — the Sandbox used when the methods were absent).
 * What the Sandbox and the seed do with a sandbox of each kind is the engine's Sandboxes contract
 * (packages/engine/test/sandbox-contract.ts: the package on a process sandbox, and on a docker-compose one with
 * RETAKE_TEST_DOCKER=1).
 */
import { describe, expect, it } from 'vitest';
import { PERSON_POLICY, SandboxError, sandboxPaths } from '@retake/core';
import type { LoadedProject, LoadedSandbox } from '@retake/core';
import { COMPOSE_CAPABILITIES, ComposeProvider, PROCESS_CAPABILITIES, ProcessProvider, emptyState, providerFor } from '@retake/sandbox';
import type { Provider, ProviderCapabilities, ProviderContext } from '@retake/sandbox';

const NAMES: Array<keyof ProviderCapabilities> = ['exec', 'logs', 'followLogs', 'snapshots', 'address', 'hashInputs', 'build', 'volumes'];
/** The methods that were optional before L7.25, by the capability that says they work. */
const METHODS: Record<string, keyof ProviderCapabilities> = { exec: 'exec', logs: 'logs', followLogs: 'followLogs', publishedBy: 'snapshots', address: 'address', hashInputs: 'hashInputs' };

const sandbox = (provider: LoadedSandbox['manifest']['provider']): LoadedSandbox =>
  ({ env: 'sandbox', file: '/p/sandbox/sandbox.yaml', dir: '/p/sandbox', manifest: { version: 1, provider, services: { app: { command: ['true'] } } }, issues: [] }) as unknown as LoadedSandbox;
const ctxOf = (s: LoadedSandbox): ProviderContext => ({
  project: { slug: 'p', dir: '/p' } as unknown as LoadedProject,
  policy: PERSON_POLICY,
  sandbox: s,
  paths: sandboxPaths('/p', 'sandbox'),
  state: emptyState('sandbox', s.manifest.provider),
  save: () => undefined,
  log: () => undefined,
});

describe('the providers declare their capabilities (X8)', () => {
  it('the process provider has none, the docker-compose provider all; providerFor picks by kind', () => {
    expect(Object.keys(PROCESS_CAPABILITIES).sort()).toEqual([...NAMES].sort());
    expect(Object.keys(COMPOSE_CAPABILITIES).sort()).toEqual([...NAMES].sort());
    expect(NAMES.filter((n) => PROCESS_CAPABILITIES[n])).toEqual([]);
    expect(NAMES.filter((n) => !COMPOSE_CAPABILITIES[n])).toEqual([]);
    expect(Object.isFrozen(PROCESS_CAPABILITIES) && Object.isFrozen(COMPOSE_CAPABILITIES)).toBe(true);
    const proc = providerFor(sandbox('process'), PERSON_POLICY);
    const compose = providerFor(sandbox('docker-compose'), PERSON_POLICY);
    expect(proc).toBeInstanceOf(ProcessProvider);
    expect(proc.capabilities).toBe(PROCESS_CAPABILITIES);
    expect(compose).toBeInstanceOf(ComposeProvider);
    expect(compose.capabilities).toBe(COMPOSE_CAPABILITIES);
  });

  it('every provider has every method; the ones that were optional are there whatever the capability says', () => {
    for (const p of [new ProcessProvider(), new ComposeProvider({ policy: PERSON_POLICY })] as Provider[]) {
      for (const m of [...Object.keys(METHODS), 'up', 'down', 'status', 'restart', 'stopStarted', 'killStartedSync', 'logFiles', 'servedBy']) {
        expect(typeof (p as unknown as Record<string, unknown>)[m], `${p.kind} ${m}`).toBe('function');
      }
    }
  });

  it('the process provider refuses what it cannot do, naming the docker-compose provider, and answers the neutral values for the rest', async () => {
    // Called through the port's type, as the Sandbox calls them (the class's own signatures take what they use).
    const p: Provider = new ProcessProvider();
    const ctx = ctxOf(sandbox('process'));
    const refused = async (what: Promise<unknown>) => {
      const e = await what.then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(SandboxError);
      return (e as SandboxError).message;
    };
    expect(await refused(p.exec(ctx, { service: 'app', command: 'true' }))).toBe('sandbox sandbox: exec steps — a capability of the docker-compose provider, not of a process sandbox');
    expect(await refused(p.logs(ctx, { lines: 5 }))).toMatch(/^sandbox sandbox: reading logs other than its log files — a capability of the docker-compose provider/);
    expect(await refused(p.followLogs(ctx, { lines: 5, signal: new AbortController().signal, write: () => undefined }))).toMatch(/^sandbox sandbox: following logs — a capability of the docker-compose provider/);
    expect(await refused(p.publishedBy(ctx, 5432))).toMatch(/^sandbox sandbox: snapshot resets — a capability of the docker-compose provider/);
    expect(await p.address(ctx, 5432)).toBeUndefined();
    expect(await p.hashInputs(ctx)).toEqual([]);
  });
});
