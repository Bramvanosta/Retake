/**
 * L1.7 on the command line (R-ENV-02/04): `--allow-writes` on run / hooks run / hooks rollback / env reset, writing
 * hooks refused on read-only environments (before any browser opens for `retake run`), journal replays judged by
 * each entry's own environment. A local HTTP server stands in for the product; no browser is needed.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '@retake/core';
import { EXIT, main, memoryIo } from '../src/index.js';

let root: string;
let server: Server;
let base: string;
const requests: string[] = [];

async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', root, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), 'studio-readonly-'));
  // A browser that cannot start: `retake run` must refuse before it would launch one.
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\nbrowser: {executable: /nonexistent/chromium}\n');
  const project = join(root, 'projects', 'shop');
  await mkdir(join(project, 'hooks'), { recursive: true });
  await mkdir(join(project, 'scenarios'), { recursive: true });
  await writeFile(
    join(project, 'project.yaml'),
    `name: Shop
environments:
  local:
    app: {url: ${base}, display: app.northfield.example}
  production:
    production: true
    pages: {app: ${base}}
  live:
    production: true
    access: read-write
    pages: {app: ${base}}
browser: {timezone: Europe/Paris}
reset:
  - name: reset
    http: {method: POST, url: "{{app}}/api/reset"}
`,
  );
  await writeFile(
    join(project, 'hooks', 'arm.yaml'),
    '- name: arm\n  http:\n    method: POST\n    url: "{{app}}/api/arm"\n    rollback: {method: DELETE, url: "{{app}}/api/arm"}\n',
  );
  await writeFile(join(project, 'hooks', 'read.yaml'), '- name: health\n  http: {url: "{{app}}/api/health"}\n- name: count\n  shell: "true"\n  writes: false\n');
  await writeFile(
    join(project, 'scenarios', 'frozen.yaml'),
    'video: frozen\nclock: {at: "2026-11-02T10:24:00", freeze: true}\nsetup:\n  - name: reset\n    http: {method: POST, url: "{{app}}/api/reset"}\nscenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - wait: 0.1\n',
  );
  await writeFile(
    join(project, 'scenarios', 'quote.yaml'),
    'video: quote\nsetup:\n  - name: reset\n    http: {method: POST, url: "{{app}}/api/reset"}\nscenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - wait: 0.1\n',
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
});

describe('retake hooks run on read-only environments', () => {
  it('refuses a writing hook on production; reads run; the header says read-only', async () => {
    const w = await retake('hooks', 'run', 'shop', 'hooks/arm.yaml', '--env', 'production');
    expect(w.code).toBe(EXIT.failure);
    expect(w.err).toContain('· env production · production · read-only');
    expect(w.err).toContain('refusing a hook that writes (HTTP POST) on read-only environment production');
    expect(requests).toEqual([]);

    const r = await retake('hooks', 'run', 'shop', 'hooks/read.yaml', '--env', 'production');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(requests).toEqual(['GET /api/health']);
  });

  it('a dry run reports the refusal; --allow-writes on a read-only environment is a usage error', async () => {
    const dry = await retake('hooks', 'run', 'shop', 'hooks/arm.yaml', '--env', 'production', '--dry');
    expect(dry.code).toBe(EXIT.failure);
    expect(dry.err).toContain('refusing a hook that writes (HTTP POST)');
    const flag = await retake('hooks', 'run', 'shop', 'hooks/arm.yaml', '--env', 'production', '--allow-writes');
    expect(flag.code).toBe(EXIT.usage);
    expect(flag.err).toContain('environment production is read-only in project.yaml (production: true): --allow-writes only confirms writes');
    expect(requests).toEqual([]);
  });

  it('production that allows writes: read-only with a notice, read-write with --allow-writes', async () => {
    const no = await retake('hooks', 'run', 'shop', 'hooks/arm.yaml', '--env', 'live');
    expect(no.code).toBe(EXIT.failure);
    expect(no.err).toContain('this run is read-only: pass --allow-writes to write');
    expect(no.err).toContain('pass --allow-writes to let it write to production');
    expect(requests).toEqual([]);

    const yes = await retake('hooks', 'run', 'shop', 'hooks/arm.yaml', '--env', 'live', '--allow-writes');
    expect(yes.code, yes.err).toBe(EXIT.ok);
    expect(yes.err).toContain('· env live · production · writes allowed');
    expect(yes.err).toContain('writes go to production: environment live runs read-write (--allow-writes)');
    expect(requests).toEqual(['POST /api/arm']);
  });
});

describe('journal replays take the access of each entry\'s environment', () => {
  it('env reset on local does not replay a production rollback without --allow-writes', async () => {
    const journals = join(root, 'projects', 'shop', '.retake', 'journals');
    await rm(journals, { recursive: true, force: true });
    expect((await retake('hooks', 'run', 'shop', 'hooks/arm.yaml', '--env', 'live', '--allow-writes')).code).toBe(EXIT.ok);
    requests.length = 0;

    // The command's environment is local (read-write): the pending entry ran on live.
    const reset = await retake('env', 'reset', 'shop');
    expect(reset.code).toBe(EXIT.failure);
    expect(reset.err).toContain('refusing a hook that writes (its rollback: HTTP DELETE) on read-only environment live: pass --allow-writes');
    expect(requests).toEqual(['POST /api/reset']); // the reset hooks of local ran; the rollback did not

    const rollback = await retake('hooks', 'rollback', 'shop', '--allow-writes');
    expect(rollback.code, rollback.err).toBe(EXIT.ok);
    expect(requests).toEqual(['POST /api/reset', 'DELETE /api/arm']);
    expect((await retake('hooks', 'rollback', 'shop')).err).toContain('no pending rollbacks');
    expect((await readdir(journals)).length).toBeGreaterThan(0);
  });

  it('env reset on production refuses its own writing reset hooks', async () => {
    const r = await retake('env', 'reset', 'shop', '--env', 'production');
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toContain('· env production · production · read-only');
    expect(r.err).toContain('refusing a hook that writes (HTTP POST)');
    expect(requests).toEqual([]);
  });
});

describe('retake run on read-only environments', () => {
  it('refuses a scenario whose setup hooks write, before any browser opens', async () => {
    const r = await retake('run', 'shop', 'quote', '--env', 'production');
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toContain('production · read-only');
    expect(r.err).toContain('environment production is production, read-only and a hook writes: setup hook 1 "reset" (HTTP POST) — nothing ran');
    expect(r.err).not.toMatch(/nonexistent|executable/i);
    expect(requests).toEqual([]);
    const runs = join(root, 'projects', 'shop', 'runs');
    const [id] = (await readdir(runs)).filter((d) => d.endsWith('-quote'));
    const record = JSON.parse(await readFile(join(runs, id, 'run.json'), 'utf8')) as RunRecord;
    expect(record).toMatchObject({ status: 'failed', env: 'production', environment: { production: true, access: 'read-only' } });
  });

  it('the header and run.json say a frozen clock and its zone (T4)', async () => {
    const r = await retake('run', 'shop', 'frozen', '--env', 'production');
    expect(r.code).toBe(EXIT.failure); // its setup hook writes: refused before any browser opens
    expect(r.err).toContain('capture  env production · hooks run · production · read-only · clock 2026-11-02T10:24:00 Europe/Paris (frozen)');
    const runs = join(root, 'projects', 'shop', 'runs');
    const [id] = (await readdir(runs)).filter((d) => d.endsWith('-frozen'));
    const record = JSON.parse(await readFile(join(runs, id, 'run.json'), 'utf8')) as RunRecord;
    expect(record.environment).toEqual({ production: true, access: 'read-only', clock: { at: '2026-11-02T10:24:00', timezone: 'Europe/Paris', freeze: true } });
  });

  it('--allow-writes on a read-only environment is a usage error', async () => {
    const r = await retake('run', 'shop', 'quote', '--env', 'production', '--allow-writes');
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('--allow-writes only confirms writes');
    expect(requests).toEqual([]);
  });

  it('validate warns about the hooks a read-only run would refuse', async () => {
    const v = await retake('validate', 'shop', 'quote', '--env', 'production');
    expect(v.code, v.err).toBe(EXIT.ok);
    expect(v.err).toMatch(/quote\.yaml:3:\d+ warning .*this hook writes \(HTTP POST\) and environment production is production, read-only/);
  });
});

describe('js hooks on read-only environments (a real browser)', () => {
  let jsRoot: string;
  const run = async (...args: string[]) => {
    const io = memoryIo();
    const code = await main(['node', 'retake', '--root', jsRoot, ...args], io);
    return { code, out: io.stdout(), err: io.stderr() };
  };

  beforeAll(async () => {
    jsRoot = await mkdtemp(join(tmpdir(), 'studio-readonly-js-'));
    await writeFile(join(jsRoot, 'retake.yaml'), 'projects_dir: projects\n');
    const project = join(jsRoot, 'projects', 'shop');
    await mkdir(join(project, 'hooks'), { recursive: true });
    await writeFile(join(project, 'project.yaml'), `name: Shop\nenvironments:\n  production:\n    production: true\n    pages: {app: ${base}}\n`);
    await writeFile(join(project, 'hooks', 'js-write.yaml'), `- name: reset\n  js: {code: "const r = await fetch('/api/reset', { method: 'POST' }); return r.status", page: app}\n`);
    await writeFile(join(project, 'hooks', 'js-read.yaml'), `- name: health\n  js: {code: "return (await fetch('/api/health')).status", page: app}\n`);
  });

  afterAll(async () => {
    if (jsRoot) await rm(jsRoot, { recursive: true, force: true });
  });

  it("the hook's tab stops its writes: refused (read-only), never sent; its reads run", async () => {
    const w = await run('hooks', 'run', 'shop', 'hooks/js-write.yaml', '--env', 'production');
    expect(w.code).toBe(EXIT.failure);
    expect(w.err).toContain('refusing a hook that writes (POST app:/api/reset, stopped in its tab) on read-only environment production');
    expect(w.err).toContain('the hook threw: TypeError: Failed to fetch');
    expect(requests.filter((r) => !r.startsWith('GET '))).toEqual([]);

    const r = await run('hooks', 'run', 'shop', 'hooks/js-read.yaml', '--env', 'production');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toMatch(/health: js .* returned 200/);
    expect(requests).toContain('GET /api/health');
  });
});
