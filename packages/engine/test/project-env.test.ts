/**
 * R-ENV-06 / R-ENV-07: an agent changes project.yaml's environments through the engine (project_env_set /
 * project_env_remove). Free: the project's own origins, tightening, display URLs. Asked to the person (the approval
 * form; no form → needs_approval; a decline → refused, nothing written): a new origin, a protection lowered, the default
 * moved onto a protected environment, sign-in details in a URL. Refused before anyone is asked: a read-write page on a
 * protected host of any project, a sandbox environment, a result that does not validate. A change made to project.yaml
 * while the person is asked is a conflict.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchHome } from '@retake/test-support/home';
import { EngineError, createEngine } from '../src/index.js';
import { changeProjectEnvironment } from '../src/project-env.js';
import type { ApprovalOutcome, Approver, Engine, ProjectChangeApprovalRequest } from '../src/index.js';
import type { HostResolver } from '../src/protected-hosts.js';
import type { LoadedProject } from '@retake/core';

const home = scratchHome();
/** Names resolve at once to a documentation address: never a loopback one, never a timeout. */
const hosts: HostResolver = { lookup: async () => ['203.0.113.7'], timeoutMs: 2000 };

const P = [
  '# Northfield — environments edited by hand and by the tools',
  'name: P',
  'environments:',
  '  local:   # this machine',
  '    app: http://localhost:4521',
  '  stg:',
  '    production: true',
  '    pages:',
  '      app: https://app.stg.example.com',
  'capture: {width: 1280, height: 720, scale: 1, fps: 30}',
  'template: default',
  '',
].join('\n');
const Q = 'name: Q\nenvironments:\n  prod:\n    production: true\n    pages:\n      shop: https://shop.example.com\n';
const README = '# P\n\n## Environments & links\n\n- local: app http://localhost:4521\n- stg: app https://app.stg.example.com\n- old · app: https://old.example.com\n';

let root: string;
let file: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-env-edit-'));
  await writeFile(join(root, 'retake.yaml'), 'projects_dir: projects\n');
  for (const [slug, text] of [
    ['p', P],
    ['q', Q],
  ] as const) {
    await mkdir(join(root, 'projects', slug, 'scenarios'), { recursive: true });
    await writeFile(join(root, 'projects', slug, 'project.yaml'), text);
  }
  await writeFile(join(root, 'projects', 'p', 'README.md'), README);
  file = join(root, 'projects', 'p', 'project.yaml');
  home.use(join(root, '.home'));
});
afterEach(async () => {
  home.restore();
  await rm(root, { recursive: true, force: true });
});

const engineOf = (client: 'mcp' | 'ui' | 'cli' = 'mcp'): Promise<Engine> => createEngine({ root, client, autoStartWorker: false, ports: { hosts } });

function asking(answer: ApprovalOutcome | ((req: ProjectChangeApprovalRequest) => Promise<ApprovalOutcome>)): Approver & { asked: ProjectChangeApprovalRequest[] } {
  const asked: ProjectChangeApprovalRequest[] = [];
  return {
    asked,
    approve: async () => ({ approved: true }),
    approveProjectChange: async (req) => {
      asked.push(req);
      return typeof answer === 'function' ? answer(req) : answer;
    },
  };
}

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

describe('an agent changing environments (R-ENV-06, R-ENV-07)', () => {
  it("adds an environment on the project's own origins without asking: only its lines are written", async () => {
    const mcp = await engineOf();
    const a = asking({ approved: true });
    const r = await mcp.projects.setEnvironment('p', 'demo', { pages: { app: { url: 'http://localhost:4521/demo', display: 'app.example.com' } } }, { approver: a });
    expect(a.asked).toEqual([]);
    expect(r.action).toBe('added');
    expect(r.environment).toEqual({ name: 'demo', pages: { app: 'http://localhost:4521/demo' }, display: { app: 'https://app.example.com' }, production: false, access: 'read-write' });
    expect(await readFile(file, 'utf8')).toBe(P.replace('capture:', '  demo:\n    app: {url: http://localhost:4521/demo, display: app.example.com}\ncapture:'));
    // Only README lines of this environment: the stale `old` line is not this change's.
    expect(r.readme_environments).toEqual({ missing: ['- demo · app: http://localhost:4521/demo (shown as https://app.example.com)'], gone: [] });
    // Marking it production, then read-only: tightening asks nobody.
    await mcp.projects.setEnvironment('p', 'demo', { production: true, access: 'read-only' }, { approver: a });
    expect(a.asked).toEqual([]);
  });

  it('a new origin asks the user once; the form lists the change, why and the command; a decline writes nothing, an accept writes', async () => {
    const mcp = await engineOf();
    const no = asking({ approved: false, reason: 'declined' });
    const e = await refusal(mcp.projects.setEnvironment('p', 'prd', { pages: { app: 'https://app.example.com' }, production: true }, { approver: no }));
    expect(e.code).toBe('refused');
    expect(e.message).toMatch(/^nothing was written: .*declined/);
    expect(no.asked).toHaveLength(1);
    expect(no.asked[0].lines).toEqual(['add environment prd (production, read-only)', 'page app: https://app.example.com']);
    expect(no.asked[0].asks).toEqual(['page app reaches https://app.example.com:443, an origin no environment of the project has']);
    expect(no.asked[0].fix).toMatch(/^retake -C .+ env add p prd --page app=https:\/\/app\.example\.com --production$/);
    expect(await readFile(file, 'utf8')).toBe(P);
    const yes = asking({ approved: true });
    const r = await mcp.projects.setEnvironment('p', 'prd', { pages: { app: 'https://app.example.com' }, production: true }, { approver: yes });
    expect(r.approved).toEqual(no.asked[0].asks);
    expect(await readFile(file, 'utf8')).toContain('  prd:\n    production: true\n    pages:\n      app: https://app.example.com\n');
  });

  it('a client that cannot ask gets needs_approval with the retake env command (MCP and Studio wording)', async () => {
    const mcp = await engineOf();
    const e = await refusal(mcp.projects.setEnvironment('p', 'local', { pages: { app: 'http://localhost:4529' } }));
    expect(e.code).toBe('needs_approval');
    expect(e.message).toContain('this MCP client cannot ask its user');
    expect(e.fix).toMatch(/ env set p local --page app=http:\/\/localhost:4529$/);
    // An approver that cannot ask about it is no approver.
    expect((await refusal(mcp.projects.setEnvironment('p', 'local', { pages: { app: 'http://localhost:4529' } }, { approver: { approve: async () => ({ approved: true }) } }))).code).toBe('needs_approval');
    const ui = await engineOf('ui');
    expect((await refusal(ui.projects.removeEnvironment('p', 'stg'))).message).toContain('the Studio cannot approve it');
    expect(await readFile(file, 'utf8')).toBe(P);
  });

  it('lowering a protection and moving the default onto production ask; a read-write page on a protected host is refused before anyone is asked', async () => {
    const mcp = await engineOf();
    const a = asking({ approved: false, reason: 'declined' });
    await refusal(mcp.projects.setEnvironment('p', 'stg', { production: false }, { approver: a }));
    await refusal(mcp.projects.removeEnvironment('p', 'stg', { approver: a }));
    await refusal(mcp.projects.setEnvironment('p', 'stg', { default: true }, { approver: a }));
    // local is the first one and the default: removing it makes stg (production) the default.
    await refusal(mcp.projects.removeEnvironment('p', 'local', { approver: a }));
    expect(a.asked.map((r) => r.asks.map((l) => l.replace(/ .*/, '')))).toEqual([['environment'], ['environment'], ['scenarios'], ['scenarios']]);
    // production taken off keeps its read-only access: one thing lowered, said once.
    expect(a.asked[0].asks).toEqual(['environment stg is no longer production']);
    expect(a.asked[3].asks[0]).toBe('scenarios without env: would run on stg, a production or read-only environment (was local)');
    const before = a.asked.length;
    // Another project's production host, and this project's own: refused, nobody asked.
    const other = await refusal(mcp.projects.setEnvironment('p', 'shop', { pages: { shop: 'https://shop.example.com' } }, { approver: a }));
    expect(other.message).toContain('points at a host of production environment prod of project q');
    const own = await refusal(mcp.projects.setEnvironment('p', 'demo', { pages: { app: 'https://app.stg.example.com' } }, { approver: a }));
    expect(own.message).toContain('points at a host of production environment stg of project p');
    expect(own.fix).toMatch(/ env add p demo --page app=https:\/\/app\.stg\.example\.com$/);
    expect(a.asked).toHaveLength(before);
    expect(await readFile(file, 'utf8')).toBe(P);
    // A person's command writes it, with a warning.
    const cli = await engineOf('cli');
    const r = await cli.projects.setEnvironment('p', 'demo', { pages: { app: 'https://app.stg.example.com' } });
    expect(r.warnings[0]).toContain('points at a host of production environment stg of project p');
  });

  it('a new production environment that allows writes asks the user', async () => {
    const mcp = await engineOf();
    const a = asking({ approved: false, reason: 'declined' });
    // The project's own origin, production, access read-write: runs could write to it with --allow-writes.
    await refusal(mcp.projects.setEnvironment('p', 'live', { pages: { app: 'http://localhost:4521' }, production: true, access: 'read-write' }, { approver: a }));
    expect(a.asked.map((r) => r.asks)).toEqual([['environment live is production and allows writes (access: read-write)']]);
    expect(a.asked[0].fix).toMatch(/ env add p live --page app=http:\/\/localhost:4521 --production --read-write$/);
    expect(await readFile(file, 'utf8')).toBe(P);
  });

  it('a change made to project.yaml while the user is asked is a conflict: the hand edit stays', async () => {
    const mcp = await engineOf();
    const edited = P.replace('template: default', 'template: editorial');
    const a = asking(async () => {
      await writeFile(file, edited);
      return { approved: true };
    });
    const e = await refusal(mcp.projects.setEnvironment('p', 'prd', { pages: { app: 'https://app.example.com' } }, { approver: a }));
    expect(e.code).toBe('conflict');
    expect(e.message).toContain('changed while the user was asked');
    expect(await readFile(file, 'utf8')).toBe(edited);
  });

  it('refuses a result that does not validate (each issue named), a sandbox environment and a name that is a path', async () => {
    await writeFile(file, P.replace('template: default', 'template: default\nauth:\n  local:\n    personas:\n      admin: {pages: [app]}'));
    const mcp = await engineOf();
    const e = await refusal(mcp.projects.removeEnvironment('p', 'local', { approver: asking({ approved: true }) }));
    expect(e.code).toBe('refused');
    expect(e.message).toMatch(/^nothing was written: project\.yaml would not be valid — auth/);
    const bad = await refusal(mcp.projects.setEnvironment('p', '../x', { production: true }));
    expect(bad.code).toBe('invalid');
    const sandboxed = { slug: 'p', dir: join(root, 'projects', 'p'), file, scenarios: [], config: { name: 'P', environments: {}, sandboxes: { sandbox: 'sandbox/sandbox.yaml' } } } as unknown as LoadedProject;
    const s = await refusal(changeProjectEnvironment({ ws: mcp.workspace, scope: undefined as never, hosts, agent: true, cli: 'retake' }, sandboxed, { kind: 'remove', env: 'sandbox' }));
    expect(s.message).toContain('environment sandbox is a sandbox: its pages and accounts are in its sandbox.yaml');
  });

  it('never shows a page URL’s user:password@: not in the form, the answer or the journal', async () => {
    const mcp = await engineOf();
    const a = asking({ approved: true });
    const r = await mcp.projects.setEnvironment('p', 'local', { pages: { app: 'http://demo:s3cret-pw@localhost:4521' } }, { approver: a });
    expect(a.asked[0].asks).toEqual(["page app's URL carries sign-in details (user:password@, not shown)"]);
    expect(a.asked[0].fix).toContain('app=http://USER:PASSWORD@localhost:4521');
    expect(r.environment?.credentials).toEqual(['app']);
    expect(JSON.stringify([a.asked, r])).not.toContain('s3cret');
    const journals = join(root, '.retake');
    const all = async (d: string): Promise<string[]> =>
      (await readdir(d, { withFileTypes: true }).catch(() => [])).flatMap((x) => (x.isDirectory() ? [] : [join(d, x.name)])).concat(
        ...(await Promise.all((await readdir(d, { withFileTypes: true }).catch(() => [])).filter((x) => x.isDirectory()).map((x) => all(join(d, x.name))))),
      );
    const texts = await Promise.all((await all(journals)).map((f) => readFile(f, 'utf8')));
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.join('\n')).not.toContain('s3cret');
  });

  it('a removal names the scenarios that still name the environment and its saved sessions, and deletes neither', async () => {
    const mcp = await engineOf();
    await writeFile(join(root, 'projects', 'p', 'scenarios', 'quote.yaml'), 'video: quote\nenv: demo\nscenes: []\n');
    await writeFile(join(root, 'projects', 'p', 'scenarios', 'tour.yaml'), 'video: tour\nscenes: []\n');
    await mcp.projects.setEnvironment('p', 'demo', { pages: { app: 'http://localhost:4521' } });
    const sessions = join(root, '.home', 'sessions', 'p', 'demo');
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, 'admin.json'), '{}');
    await writeFile(join(sessions, 'admin.status.json'), '{}');
    const r = await mcp.projects.removeEnvironment('p', 'demo');
    expect(r.removed).toEqual({ scenarios: ['quote'], sessions: 1, remove_sessions: 'rm -r "${RETAKE_HOME:-$HOME/.retake}"/sessions/p/demo "${RETAKE_HOME:-$HOME/.retake}"/profiles/p/demo' });
    // Persona names come from the Retake home's folders: under untrusted only.
    expect(r.untrusted).toEqual({ sessions: ['admin'] });
    expect(r.environment).toBeNull();
    expect(await readFile(file, 'utf8')).toBe(P);
    expect((await readdir(sessions)).sort()).toEqual(['admin.json', 'admin.status.json']);
  });
});
