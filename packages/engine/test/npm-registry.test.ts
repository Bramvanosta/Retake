/**
 * The product's font registry (engine fonts/npm-registry.ts) against loopback HTTP servers only — the real registry is
 * never reached: the test hatch is accepted by one exact pattern (loopback http and a port, nothing else) and refused
 * otherwise, never ignored; the suite's guard refuses every fetch but the hatch's; an answer is a 200 of at most its
 * cap (Content-Length checked first, then counted), never a redirect followed, never re-encoded; a proxy variable
 * (HTTP_PROXY with NODE_USE_ENV_PROXY) never reroutes it; `retake doctor` warns while the hatch is set.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HTTPS_AGENT_OPTIONS, registryAgent, NO_FONT_FETCH_ENV, NPM_TEST_REGISTRY_ENV, npmFontRegistry, npmTestRegistry } from '../src/fonts/npm-registry.js';
import { npmTestRegistryCheck } from '../src/doctor/machine-checks.js';
import type { DoctorProbes } from '../src/doctor/types.js';
import { REPO } from '@retake/test-support/repo';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ base: string; hits: string[] }> {
  const hits: string[] = [];
  const s = createServer((req, res) => {
    hits.push(req.url ?? '');
    handler!(req, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits };
}

const get = (reg: ReturnType<typeof npmFontRegistry>, path: string, max = 1000) => reg.get(path, { max, signal: AbortSignal.timeout(5000) });

describe('the test hatch and the guard', () => {
  it('the test hatch takes loopback http and a port only, anything else refuses every fetch (never ignored)', async () => {
    expect(npmTestRegistry({})).toBeNull();
    expect(npmTestRegistry({ [NPM_TEST_REGISTRY_ENV]: 'http://127.0.0.1:4519' })).toEqual({ url: 'http://127.0.0.1:4519' });
    expect(npmTestRegistry({ [NPM_TEST_REGISTRY_ENV]: 'http://[::1]:4519' })).toEqual({ url: 'http://[::1]:4519' });
    for (const bad of [
      'http://localhost:4519',
      'http://127.1:4519',
      'http://0x7f.0.0.1:4519',
      'http://127.0.0.2:4519',
      'https://127.0.0.1:4519',
      'http://127.0.0.1:4519/',
      'http://127.0.0.1:4519/path',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:99999',
      'http://user@127.0.0.1:4519',
      'https://registry.npmjs.org',
      ' http://127.0.0.1:4519',
    ]) {
      expect(npmTestRegistry({ [NPM_TEST_REGISTRY_ENV]: bad }), bad).toBe('invalid');
      const reg = npmFontRegistry({ [NPM_TEST_REGISTRY_ENV]: bad });
      expect(reg.problem, bad).toMatch(/no font is fetched/);
      await expect(get(reg, '/x')).rejects.toThrow(/no font is fetched/);
    }
  });

  it("the suite's guard refuses the real registry before any socket; the hatch's loopback registry still answers", async () => {
    const guarded = npmFontRegistry({ [NO_FONT_FETCH_ENV]: '1' });
    expect(guarded).toMatchObject({ base: 'https://registry.npmjs.org', test: false });
    expect(guarded.problem).toMatch(/RETAKE_TEST_NO_FONT_FETCH/);
    await expect(get(guarded, '/@fontsource%2ftest-sans/latest')).rejects.toThrow(/RETAKE_TEST_NO_FONT_FETCH/);
    const s = await serve((_q, r) => r.end('{}'));
    const hatch = npmFontRegistry({ [NO_FONT_FETCH_ENV]: '1', [NPM_TEST_REGISTRY_ENV]: s.base });
    expect(hatch).toMatchObject({ base: s.base, test: true });
    expect(hatch.problem).toBeUndefined();
    expect((await get(hatch, '/a')).toString()).toBe('{}');
    // This very suite runs under the guard (vitest.config.ts).
    expect(process.env[NO_FONT_FETCH_ENV]).toBe('1');
    expect(npmFontRegistry(process.env).problem).toMatch(/RETAKE_TEST_NO_FONT_FETCH/);
  });

  it('the npm test hatch is warned by retake doctor, a malformed one too', () => {
    expect(npmTestRegistryCheck({ env: {} } as unknown as DoctorProbes)).toBeNull();
    const ok = npmTestRegistryCheck({ env: { [NPM_TEST_REGISTRY_ENV]: 'http://127.0.0.1:4519' } } as unknown as DoctorProbes);
    expect(ok).toMatchObject({ status: 'warn', name: 'Font fetch' });
    expect(ok!.detail).toMatch(/TEST registry http:\/\/127\.0\.0\.1:4519/);
    expect(npmTestRegistryCheck({ env: { [NPM_TEST_REGISTRY_ENV]: 'http://localhost:1' } } as unknown as DoctorProbes)!.detail).toMatch(/every font fetch is refused/);
  });
});

describe('the adapter (loopback http)', () => {
  it('the adapter refuses redirects, non-200 answers, re-encoded and oversize bodies', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/ok' });
        return res.end();
      }
      if (req.url === '/missing') {
        res.writeHead(404);
        return res.end();
      }
      if (req.url === '/error') {
        res.writeHead(500);
        return res.end();
      }
      if (req.url === '/gzip') {
        res.writeHead(200, { 'content-encoding': 'gzip' });
        return res.end('x');
      }
      if (req.url === '/declared') {
        res.writeHead(200, { 'content-length': '5000' });
        return res.end(Buffer.alloc(5000));
      }
      if (req.url === '/streamed') {
        // No Content-Length: counted while it streams.
        res.writeHead(200, { 'transfer-encoding': 'chunked' });
        res.write(Buffer.alloc(600));
        res.write(Buffer.alloc(600));
        return res.end();
      }
      res.end('fine');
    });
    const reg = npmFontRegistry({ [NPM_TEST_REGISTRY_ENV]: s.base });
    expect((await get(reg, '/ok')).toString()).toBe('fine');
    await expect(get(reg, '/redirect')).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/redirects are never followed/) });
    expect(s.hits).not.toContain('/ok2');
    await expect(get(reg, '/missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(get(reg, '/error')).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/answered 500/) });
    await expect(get(reg, '/gzip')).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/content-encoding gzip/) });
    await expect(get(reg, '/declared')).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/5000 bytes, more than the 1000/) });
    await expect(get(reg, '/streamed')).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/more than the 1000 bytes/) });
    // Only the redirect's own request: its location was never asked.
    expect(s.hits.filter((h) => h === '/ok')).toHaveLength(1);
  });

  it('the HTTPS agent checks certificates explicitly (NODE_TLS_REJECT_UNAUTHORIZED=0 cannot switch it off) and keeps no connection', () => {
    expect(HTTPS_AGENT_OPTIONS).toEqual({ keepAlive: false, rejectUnauthorized: true });
    expect(Object.isFrozen(HTTPS_AGENT_OPTIONS)).toBe(true);
    const agent = registryAgent(true) as unknown as { options: Record<string, unknown> };
    expect(agent.options).toMatchObject({ keepAlive: false, rejectUnauthorized: true });
    expect(registryAgent(true)).not.toBe(registryAgent(true));
  });

  it('a registry that does not answer in time is unavailable (the call deadline)', async () => {
    const s = await serve(() => undefined);
    const reg = npmFontRegistry({ [NPM_TEST_REGISTRY_ENV]: s.base });
    await expect(reg.get('/slow', { max: 10, signal: AbortSignal.timeout(200) })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringMatching(/no answer in time/) });
  });

  it('a proxy variable never reroutes a fetch (HTTP_PROXY with NODE_USE_ENV_PROXY): the registry is asked, the proxy never', async () => {
    const registry = await serve((_q, r) => r.end('from the registry'));
    const proxy = await serve((_q, r) => r.end('from the proxy'));
    const mod = pathToFileURL(join(REPO, 'packages/engine/dist/fonts/npm-registry.js')).href;
    const script = `const m = await import(${JSON.stringify(mod)}); const r = m.npmFontRegistry(process.env); const b = await r.get('/pkg', { max: 1000, signal: AbortSignal.timeout(5000) }); process.stdout.write(b.toString());`;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { PATH: process.env.PATH ?? '', [NPM_TEST_REGISTRY_ENV]: registry.base, HTTP_PROXY: proxy.base, http_proxy: proxy.base, HTTPS_PROXY: proxy.base, NODE_USE_ENV_PROXY: '1' },
      });
      let text = '';
      child.stdout.on('data', (c: Buffer) => (text += c.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`exit ${code}`))));
    });
    expect(out).toBe('from the registry');
    expect(registry.hits).toEqual(['/pkg']);
    expect(proxy.hits).toEqual([]);
  });
});
