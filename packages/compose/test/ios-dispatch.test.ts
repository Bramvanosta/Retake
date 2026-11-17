/**
 * The capture runner's dispatch on the environment: a run on an iOS environment (`ios:`) gets the iOS runner's driver
 * (loaded for it only), a web run is handed on unchanged and never loads the iOS runner; what only a browser does — a
 * dry run, an inspection, a recording, a js hook's page — is refused on an iOS environment.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseProjectYaml } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { EngineError } from '@retake/engine/composition';
import type { CaptureRunner } from '@retake/engine/composition';

type CaptureRequest = Parameters<CaptureRunner['run']>[0];

const loaded = vi.hoisted(() => ({ ios: 0, calls: [] as Array<Record<string, unknown>> }));
const IOS_DRIVER = vi.hoisted(() => () => {
  throw new Error('the test driver films nothing');
});

vi.mock('@retake/runner-ios', () => {
  loaded.ios++;
  return { iosDriver: IOS_DRIVER };
});
vi.mock('@retake/runner-web', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retake/runner-web')>();
  return {
    ...real,
    runScenario: async (req: Record<string, unknown>) => {
      loaded.calls.push(req);
      return { status: 'succeeded' };
    },
    recordSession: async () => ({ recorded: true }),
    evalHookInPage: async () => 'evaluated',
  };
});

const { iosEnvironmentOf, runnerWebCapture } = await import('../src/runner-web-capture.js');

const PROJECT =
  'version: 1\nname: Northfield\nenvironments:\n  staging:\n    shop: https://shop.staging.example.com\n  simulator:\n    ios: {app: build/Buyer.app, device: iPhone 17 Pro, schemes: [northfield]}\n';

function project(): LoadedProject {
  const { config, issues } = parseProjectYaml(PROJECT);
  if (!config) throw new Error(JSON.stringify(issues));
  return { slug: 'northfield', dir: '/nonexistent/p', root: '/nonexistent', file: '/nonexistent/p/project.yaml', readme: null, scenarios: [], config };
}

function request(env: string | undefined, extra: Partial<CaptureRequest> = {}, scenarioEnv?: string): CaptureRequest {
  return {
    project: project(),
    scenario: { name: 's', file: '/x/s.yaml', text: '', issues: [], scenario: { video: 's', ...(scenarioEnv ? { env: scenarioEnv } : {}), scenes: [] } },
    mode: 'capture',
    ...(env ? { env } : {}),
    runs: {},
    ...extra,
  } as unknown as CaptureRequest;
}

beforeEach(() => {
  loaded.calls.length = 0;
});

describe('the capture runner on an iOS environment', () => {
  it('a web run is handed on unchanged: no driver, the iOS runner never loaded', async () => {
    const capture = runnerWebCapture();
    await capture.run(request('staging'));
    await capture.run(request(undefined)); // the default environment: the first, staging
    expect(loaded.calls).toHaveLength(2);
    for (const c of loaded.calls) expect(Object.hasOwn(c, 'driver')).toBe(false);
    expect(loaded.ios).toBe(0);
  });

  it("a run on an iOS environment gets the iOS runner's driver (the request's env, else the scenario's)", async () => {
    const capture = runnerWebCapture();
    await capture.run(request('simulator'));
    await capture.run(request(undefined, {}, 'simulator'));
    expect(loaded.calls.map((c) => c.driver)).toEqual([IOS_DRIVER, IOS_DRIVER]);
    expect(loaded.calls[0]).not.toHaveProperty('runs');
    expect(loaded.ios).toBe(1);
  });

  it('a dry run and an inspection are refused on it (invalid), before the runner runs', async () => {
    const capture = runnerWebCapture();
    await expect(capture.run(request('simulator', { mode: 'dry' }))).rejects.toThrow('environment simulator is an iOS environment: a dry run is not available on it');
    await expect(capture.run(request('simulator', { mode: 'dry', inspect: {} as never }))).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('an inspection is not available'),
    });
    expect(loaded.calls).toEqual([]);
    // The same dry run on the web environment is handed on.
    await capture.run(request('staging', { mode: 'dry' }));
    expect(loaded.calls).toHaveLength(1);
  });

  it("a recording's window and a js hook's page are refused on it", async () => {
    const capture = runnerWebCapture();
    const p = project();
    const ios = { name: 'simulator', pages: {}, ios: { app: 'build/Buyer.app', device: 'iPhone 17 Pro' } };
    await expect(capture.record({ project: p, env: ios, url: 'northfield://x' } as never)).rejects.toBeInstanceOf(EngineError);
    await expect(capture.record({ project: p, env: ios, url: 'northfield://x' } as never)).rejects.toThrow('a recording is not available on it');
    expect(await capture.record({ project: p, env: { name: 'staging', pages: {} }, url: 'https://shop.staging.example.com' } as never)).toEqual({ recorded: true });
    await expect(capture.hookPages.evalIn({} as never, { project: p, env: { name: 'simulator', pages: {} }, log: () => undefined }, undefined, '1')).rejects.toThrow(
      'a js hook is not available on it',
    );
  });

  it('iosEnvironmentOf: the iOS environment, else null (a web one, an unknown name: the runner says it)', () => {
    expect(iosEnvironmentOf(project(), 'simulator')?.ios).toEqual({ app: 'build/Buyer.app', device: 'iPhone 17 Pro', schemes: ['northfield'] });
    expect(iosEnvironmentOf(project(), 'staging')).toBeNull();
    expect(iosEnvironmentOf(project(), undefined)).toBeNull();
    expect(iosEnvironmentOf(project(), 'nowhere')).toBeNull();
  });
});
