/**
 * Hotfix v0.2.5 (field point 20) — an MCP server whose engine was updated under it (the app updated in place, a checkout
 * pulled and built): core `installedVersion` reads the installed version again from disk (the bundle's bundle.json, the
 * checkout's core package.json); engine_info says `stale`; any other call is refused with why, and the server stops
 * once the answer is written, so that the client starts it again on the installed engine.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETAKE_VERSION, installedVersion, staleEngine } from '@retake/core';
import type { BundleInfo } from '@retake/core';
import { fixtureWorkspace } from '../../engine/test/helpers.js';
import { startMcpServer, staleWords } from '../src/index.js';

let ws: string;
beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-stale-'));
  await fixtureWorkspace(ws);
});
afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('the installed engine, read again from disk', () => {
  it("an app's bundle.json, a checkout's core package.json; stale only when they differ from the running one", async () => {
    const app = join(ws, 'Resources');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'bundle.json'), JSON.stringify({ v: 1, app: '9.9.9' }));
    const bundle = { root: app, sealed: app } as unknown as BundleInfo;
    expect(installedVersion(bundle)).toBe('9.9.9');
    const checkout = join(ws, 'checkout');
    await mkdir(join(checkout, 'packages', 'core'), { recursive: true });
    await writeFile(join(checkout, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@retake/core', version: '1.2.3' }));
    expect(installedVersion(null, checkout)).toBe('1.2.3');
    expect(installedVersion(null, join(ws, 'nowhere'))).toBeUndefined();
    expect(staleEngine('1.2.2', '1.2.3')).toEqual({ running: '1.2.2', installed: '1.2.3' });
    expect(staleEngine('1.2.3', '1.2.3')).toBeNull();
    // This checkout: the version it runs is the one on disk.
    expect(staleEngine(RETAKE_VERSION)).toBeNull();
  });
});

describe('an MCP server on a stale engine', () => {
  it('engine_info says stale; another call is refused with why; then the server stops by itself', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (d: Buffer) => (out += d.toString()));
    const logs: string[] = [];
    let installed = RETAKE_VERSION;
    const served = startMcpServer({ root: ws, stdin, stdout, log: (m) => logs.push(m), stale: () => staleEngine(RETAKE_VERSION, installed) });
    const send = (o: Record<string, unknown>) => stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
    const answer = async (id: number) => {
      for (let i = 0; i < 400; i++) {
        const line = out.split('\n').find((l) => l.includes(`"id":${id}`));
        if (line) return JSON.parse(line) as { result: { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, any> } };
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`no answer to ${id}: ${out}`);
    };
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await answer(1);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'engine_info', arguments: {} } });
    const fresh = await answer(2);
    expect(fresh.result.structuredContent?.stale).toBeNull();
    // The app is updated under the server.
    installed = '99.0.0';
    send({ id: 3, method: 'tools/call', params: { name: 'project_list', arguments: {} } });
    const refused = await answer(3);
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain(staleWords({ running: RETAKE_VERSION, installed: '99.0.0' }));
    // It stops by itself (the client starts it again), the answer written first.
    await expect(Promise.race([served.then(() => 'stopped'), new Promise((r) => setTimeout(() => r('still running'), 5000))])).resolves.toBe('stopped');
    expect(logs.join('\n')).toContain('still runs Retake');
  }, 60_000);

  it('engine_info on a stale engine answers, with `stale` and the words first, then the server stops', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (d: Buffer) => (out += d.toString()));
    const served = startMcpServer({ root: ws, stdin, stdout, log: () => undefined, stale: () => ({ running: RETAKE_VERSION, installed: '99.0.0' }) });
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'engine_info', arguments: {} } })}\n`);
    await served;
    const line = out.split('\n').find((l) => l.includes('"id":2'))!;
    const r = JSON.parse(line).result;
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^STALE: this Retake MCP server still runs Retake .*, but 99\.0\.0 is installed now/);
    expect(r.structuredContent.stale).toEqual({ running: RETAKE_VERSION, installed: '99.0.0' });
  }, 60_000);
});
