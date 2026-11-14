/**
 * L4.8 part 4: the Record screen's ops over HTTP (record-ops.ts, R-UI-20 / 21 / 22), under the `ui` client — the
 * fixture product on ephemeral ports, the worker run in this process with Playwright playing the person
 * (`ports.recordWindow.drive`: a worker process cannot receive it), the person's Studio calls made over HTTP from inside the
 * drive while the window is open.
 *
 * - The allow-list: the 7 record ops are the Studio's own; scenario_record and job_cancel stay 404.
 * - Pinned inputs: record_start never takes a url, allow_writes, check or submitted_by (400, nothing queued); the job
 *   says `submitted_by: 'ui'`, `check: true`, a page and a path; no author / submitted_by in an annotate or a save.
 * - record_options: environments, personas with their stored state and a path-free sign-in command, defaults, warnings,
 *   the open recording (one window at a time: a second start is 409) and the recent list.
 * - Path-free answers: a failed job's error (message and `fix`: `retake -C <workspace> …`) path-free in record_view; the
 *   check replay's failure text under `untrusted.check` path-free; URL paths and the draft kept as written.
 * - A real recording: the live view while the window is open, a `workspace {records}` event for it, a caption "at the
 *   end", Stop and keep (the check runs), the draft as `untrusted.yaml_lines` (page and typed text under `untrusted`
 *   only), Save (a taken name 409, then a new file), a recording Claude started read-only (403), Discard.
 * - Secrets: a password sentinel typed in the window appears in no answer, no workspace file, no worker log, and not in
 *   the Studio's log or stderr.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { ClientRequest } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileJobQueue, newRecordId, runWorker, selfIdentity } from '@retake/engine';
import type { JobRecord, RecordWindow } from '@retake/engine';
import { OWN_OPS, RECORD_OPS, UI_OPS, recordPathFree, startStudioServer } from '../src/index.js';
import type { RecordOptionsAnswer, RecordStartAnswer, RecordViewAnswer, StudioServer } from '../src/index.js';
import { REPO } from '@retake/test-support/repo';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { raw } from '@retake/test-support/http';
import { recordsWatchScan } from '../src/server/record-watch.js';
import { scratchHome } from '@retake/test-support/home';

type Page = Parameters<NonNullable<RecordWindow['drive']>>[0];

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

const P = 'northfield-fixture';
const SENTINEL = `Sentinel-${randomBytes(6).toString('hex')}`;
const retakeHome = scratchHome('RETAKE_RECORD_MAX_MIN');
let fixture: Fixture;
let ws: string;
let studio: StudioServer;
let queue: FileJobQueue;
const logs: string[] = [];
const workerLogs: string[] = [];
const stderr: string[] = [];
const bodies: string[] = [];
const writeErr = process.stderr.write.bind(process.stderr);

const call = async (op: string, args: unknown) => {
  const r = await raw(studio.port, 'POST', `/v1/call/${op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
  bodies.push(r.body);
  return r;
};
const ok = async <T>(op: string, args: unknown): Promise<T> => {
  const r = await call(op, args);
  expect(r.status, `${op}: ${r.body}`).toBe(200);
  return r.json<{ data: T }>().data;
};
const jobIds = async () => (await readdir(join(ws, '.retake', 'jobs')).catch(() => [] as string[])).sort();
const recDir = (id: string) => join(ws, 'projects', P, '.retake', 'records', id);

interface Fail {
  ok: false;
  error: { code: string; message: string; fix?: string; details?: Record<string, unknown> };
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

/** The in-process worker (one job), Playwright playing the person; the window closes after `drive` if still open. */
function work(drive: (page: Page) => Promise<void>): Promise<number> {
  return runWorker({
    root: ws,
    once: true,
    idleExitMs: 0,
    pollMs: 50,
    log: (m) => workerLogs.push(m),
    ports: {
      recordWindow: {
        headless: true,
        windowSize: { width: 1400, height: 1000 },
        drive: async (page) => {
          await page.waitForLoadState('domcontentloaded');
          await page.waitForTimeout(800);
          await drive(page);
          await page.waitForTimeout(400).catch(() => undefined);
          await page.close().catch(() => undefined);
        },
      },
    },
  });
}

/** A job taken and finished by hand (no worker): `failed` with the given error. */
async function failJob(id: string, error: { code: string; message: string; fix?: string }): Promise<void> {
  const me = await selfIdentity();
  expect(await queue.claim(id, me)).toBe(true);
  const rec = (await queue.get(id)) as JobRecord;
  await queue.write({ ...rec, state: 'failed', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), worker: { ...me, host: hostname() }, error } as JobRecord);
}

/** Everything of an answer but its `untrusted` parts, as text. */
function trustedText(v: unknown): string {
  return JSON.stringify(v, (k, x: unknown) => (k === 'untrusted' ? undefined : x));
}

interface EventLog {
  events: Array<{ event: string; data: Record<string, unknown> }>;
  close(): void;
}

/** The Studio's event stream, collected. */
function events(): Promise<EventLog> {
  return new Promise((resolve, reject) => {
    const out: EventLog['events'] = [];
    const req: ClientRequest = request(
      { host: '127.0.0.1', port: studio.port, path: '/v1/events', method: 'GET', headers: { host: `127.0.0.1:${studio.port}`, authorization: `Bearer ${studio.token}` }, setHost: false, agent: false },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (ev && data) out.push({ event: ev, data: JSON.parse(data) as Record<string, unknown> });
          }
        });
        res.on('error', () => undefined);
        resolve({ events: out, close: () => req.destroy() });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
  ws = await mkdtemp(join(tmpdir(), 'studio-ui-record-ops-'));
  retakeHome.use(join(ws, '.home'));
  delete process.env.RETAKE_RECORD_MAX_MIN;
  await fixtureWorkspace(ws);
  const project = join(ws, 'projects', P);
  const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
  await writeFile(
    join(project, 'project.yaml'),
    yaml.replaceAll('http://localhost:4401', fixture.urls.console.replace(/\/$/, '')).replaceAll('http://localhost:4402', fixture.urls.shop.replace(/\/$/, '')),
  );
  // The Studio's stderr (`retake ui` passes `log` to it), and anything else written there meanwhile.
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return (writeErr as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  studio = await startStudioServer({
    root: ws,
    startWorker: false,
    pollMs: 150,
    log: (m) => {
      logs.push(m);
      process.stderr.write(`${m}\n`);
    },
  });
  queue = new FileJobQueue(ws);
}, 120_000);

afterAll(async () => {
  process.stderr.write = writeErr;
  await studio?.close();
  await fixture?.close();
  if (ws) await rm(ws, { recursive: true, force: true });
  retakeHome.restore();
});

describe('the allow-list and the pinned inputs', () => {
  it("the 7 record ops are the Studio's own; scenario_record and job_cancel stay out", async () => {
    expect([...RECORD_OPS]).toEqual(['record_options', 'record_start', 'record_view', 'record_annotate', 'record_stop', 'record_discard', 'record_save']);
    for (const op of RECORD_OPS) {
      expect(OWN_OPS as readonly string[]).toContain(op);
      expect(UI_OPS as readonly string[]).toContain(op);
    }
    for (const op of ['scenario_record', 'job_cancel', 'job_status']) expect((await call(op, { project: P })).status, op).toBe(404);
  });

  it('record_start: no url, allow_writes, check or submitted_by from a page (400, nothing queued); bad page, path, name refused', async () => {
    const before = await jobIds();
    const shop = fixture.urls.shop.replace(/\/$/, '');
    for (const extra of [
      { url: `${shop}/record-lab` },
      { allowWrites: true },
      { allow_writes: true },
      { check: false },
      { check: true },
      { submitted_by: 'mcp' },
      { author: 'claude' },
      { path: '/x/{{env:HOME}}' },
      { path: 'record-lab' },
      { path: `${shop}/record-lab` },
      { page: '../shop' },
      { page: '{{env:HOME}}' },
      { persona: '../x' },
      { name: '../escape' },
      { env: '../local' },
    ]) {
      const r = await call('record_start', { project: P, page: 'shop', path: '/record-lab', ...extra });
      expect(r.status, `${JSON.stringify(extra)}: ${r.body}`).toBe(400);
    }
    expect(await jobIds()).toEqual(before);
  });

  it('record_view / annotate / stop / discard / save: ids never paths, no author or submitted_by, strict changes', async () => {
    const id = newRecordId();
    for (const [op, args] of [
      ['record_view', { project: P, rec_id: '../x' }],
      ['record_view', { project: P, rec_id: id, job: '../j' }],
      ['record_view', { project: P, rec_id: id, since: 'not-a-version' }],
      ['record_stop', { project: P, rec_id: `${id}/..` }],
      ['record_discard', { project: P, rec_id: id, submitted_by: 'ui' }],
      ['record_annotate', { project: P, rec_id: id, rev: 0, change: { op: 'insert', at: 'end', insert: { kind: 'hold', seconds: 2 } }, submitted_by: 'ui' }],
      ['record_annotate', { project: P, rec_id: id, rev: 0, change: { op: 'insert', at: 'end', insert: { kind: 'hold', seconds: 2 }, author: 'claude' } }],
      ['record_annotate', { project: P, rec_id: id, rev: 0, change: { op: 'insert', at: 'end', insert: { kind: 'caption', text: 'a {{env:HOME}}' } } }],
      ['record_save', { project: P, rec_id: id, name: 'x', rev: 0, draft: 'a'.repeat(64), author: 'claude' }],
      ['record_save', { project: P, rec_id: id, name: 'x', rev: 0, draft: 'a'.repeat(64), overwrite: true }],
      ['record_save', { project: P, rec_id: id, name: '../escape', rev: 0, draft: 'a'.repeat(64) }],
      // Never a save of whatever is on disk: the draft the person saw is required (review A-M1).
      ['record_save', { project: P, rec_id: id, name: 'x', rev: 0 }],
      ['record_save', { project: P, rec_id: id, name: 'x', rev: 0, draft: 'not-a-hash' }],
    ] as const) {
      const r = await call(op, args);
      expect(r.status, `${op} ${JSON.stringify(args)}: ${r.body}`).toBe(400);
    }
  });
});

let first: RecordStartAnswer;

describe('the start form, one window at a time, path-free answers', () => {
  it('record_options: environments, personas with their stored state, defaults, warnings, no path', async () => {
    const r = await call('record_options', { project: P });
    expect(r.status, r.body).toBe(200);
    expect(r.body).not.toContain(ws);
    const o = r.json<{ data: RecordOptionsAnswer }>().data;
    expect(o).toMatchObject({ project: P, default_env: 'local', max_minutes: 30, display: true, open: null, recent: [] });
    expect(o.default_name).toMatch(/^recorded-\d{8}-\d{4}$/);
    expect(o.environments.map((e) => e.name)).toEqual(['local', 'signed-in', 'production', 'sandbox', 'sandbox-docker']);
    const local = o.environments.find((e) => e.name === 'local')!;
    expect(local).toMatchObject({ access: 'read-write', production: false, pages: ['console', 'shop'], default: { page: 'console', path: '/', persona: null } });
    const prod = o.environments.find((e) => e.name === 'production')!;
    expect(prod.access).toBe('read-only');
    expect(prod.warnings.join(' ')).toMatch(/production environment/);
    const signed = o.environments.find((e) => e.name === 'signed-in')!;
    expect(signed.default).toEqual({ page: 'console', path: '/', persona: 'supplier' });
    const supplier = signed.personas.find((p) => p.name === 'supplier')!;
    expect(supplier).toMatchObject({ pages: ['console'], login_steps: true, status: 'never', in_use: false });
    // The sign-in command, path-free: `retake -C <workspace> login …` with the workspace cut.
    expect(supplier.command).toMatch(/login northfield-fixture --env signed-in --persona supplier/);
    expect(o.notes.join(' ')).toMatch(/full size/);
  });

  it('record_start: the job is pinned (ui, check on, page and path); a second start is 409; the view before the folder', async () => {
    first = await ok<RecordStartAnswer>('record_start', { project: P, page: 'shop', path: '/record-lab/a/b', name: 'ops-first' });
    expect(first).toMatchObject({ state: 'queued', env: 'local', page: 'shop', path: '/record-lab/a/b', persona: null });
    const job = (await queue.get(first.job))!;
    expect(job.input).toEqual({
      version: job.input.version,
      kind: 'record',
      project: P,
      rec_id: first.rec_id,
      source: { page: 'shop', path: '/record-lab/a/b' },
      scenario: 'ops-first',
      check: true,
      submitted_by: 'ui',
    });
    const again = await call('record_start', { project: P, page: 'shop', path: '/record-lab' });
    expect(again.status).toBe(409);
    expect(again.json<Fail>().error.details).toMatchObject({ job: first.job, project: P, rec_id: first.rec_id });
    const v = await ok<RecordViewAnswer>('record_view', { project: P, rec_id: first.rec_id, job: first.job });
    // A URL path is the recording's own: never shortened like a file path.
    expect(v).toMatchObject({ state: 'queued', started_by: 'ui', path: '/record-lab/a/b', can: { stop: true, discard: true, annotate: false, save: false }, untrusted: null });
    const o = await ok<RecordOptionsAnswer>('record_options', { project: P });
    expect(o.open).toEqual({ job: first.job, project: P, rec_id: first.rec_id, state: 'queued' });
    expect(o.recent[0]).toMatchObject({
      rec_id: first.rec_id,
      state: 'queued',
      job: first.job,
      started_by: 'ui',
      name: 'ops-first',
      page: 'shop',
      path: '/record-lab/a/b',
      steps: null,
      saved: null,
      studio: true,
    });
  });

  it("a failed job's error in record_view: message and fix path-free (a refused preflight's retake -C <workspace> …)", async () => {
    await failJob(first.job, {
      code: 'refused',
      message: `persona not signed in (profile ${ws}/.home/profiles/x): sign it in first — retake -C ${ws} login ${P} --env local`,
      fix: `retake -C ${ws} record ${P} ops-first --page shop --path /record-lab/a/b`,
    });
    const r = await call('record_view', { project: P, rec_id: first.rec_id, job: first.job });
    expect(r.status, r.body).toBe(200);
    expect(r.body).not.toContain(ws);
    const v = r.json<{ data: RecordViewAnswer }>().data;
    expect(v).toMatchObject({ state: 'failed', job: { state: 'failed', error: { code: 'refused' } }, can: { stop: false } });
    expect(v.job!.error!.fix).toMatch(/^retake -C \. record northfield-fixture ops-first/);
  });

  it('the records watch never looks through a link (review A-L3): a project whose records or .retake folder is one is skipped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studio-record-watch-'));
    try {
      const id = newRecordId();
      const outside = join(dir, 'outside');
      await mkdir(join(outside, 'records', id), { recursive: true });
      await writeFile(join(outside, 'records', id, 'events.jsonl'), '');
      await mkdir(join(dir, 'projects', 'real', '.retake', 'records', id), { recursive: true });
      await mkdir(join(dir, 'projects', 'linked-records', '.retake'), { recursive: true });
      await symlink(join(outside, 'records'), join(dir, 'projects', 'linked-records', '.retake', 'records'));
      await mkdir(join(dir, 'projects', 'linked-home'), { recursive: true });
      await symlink(outside, join(dir, 'projects', 'linked-home', '.retake'));
      expect([...recordsWatchScan(join(dir, 'projects')).keys()]).toEqual([`real/${id}`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recordPathFree: trusted strings path-free, URL paths and the draft as written, the check failure path-free', () => {
    const root = '/work/space';
    const out = recordPathFree(
      {
        path: '/orders/new/42',
        view: { path: '/orders/new/43' },
        recent: [{ path: '/orders/new/44' }],
        // N1: any other `path` is a trusted string like the others (an absolute file path never passes).
        result: { saved: { path: '/opt/elsewhere/deep/file.yaml' } },
        problem: `cannot read ${root}/projects/p/x and /opt/elsewhere/deep/file.txt`,
        job: { error: { message: 'failed at /var/lib/thing/deep/file', fix: `retake -C ${root} record p` } },
        untrusted: { yaml_lines: ['    open: /orders/new/42', `  - type: {text: "${root}/notes"}`], check: { error: 'no element; screenshot /private/var/folders/x/y/shot.png' } },
      },
      root,
    ) as Record<string, any>;
    expect(out.path).toBe('/orders/new/42');
    expect(out.view.path).toBe('/orders/new/43');
    expect(out.recent[0].path).toBe('/orders/new/44');
    expect(out.result.saved.path).not.toContain('/opt/elsewhere/deep');
    expect(out.problem).not.toContain('/opt/elsewhere/deep');
    expect(out.problem).not.toContain(root);
    expect(out.job.error.message).not.toContain('/var/lib/thing/deep');
    expect(out.job.error.fix).toBe('retake -C . record p');
    expect(out.untrusted.yaml_lines).toEqual(['    open: /orders/new/42', '  - type: {text: "notes"}']);
    expect(out.untrusted.check.error).not.toContain('/private/var/folders/x/y');
  });
});

let lab: { rec: string; job: string };

describe('a real recording through the ops', () => {
  it('live view while the window is open, a records event, a caption at the end, Stop and keep, the draft under untrusted', async () => {
    const stream = await events();
    lab = await (async () => {
      const s = await ok<RecordStartAnswer>('record_start', { project: P, page: 'shop', path: '/record-lab', name: 'ops-lab' });
      return { rec: s.rec_id, job: s.job };
    })();
    let caption: { rev: number; insert_id?: string } | undefined;
    await work(async (page) => {
      await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await page.locator('#lab-password').click();
      await page.keyboard.type(SENTINEL);
      await page.getByLabel('Note').click();
      await page.keyboard.type('Two words');
      const live = await until(async () => {
        const v = await ok<RecordViewAnswer>('record_view', { project: P, rec_id: lab.rec });
        return v.state === 'recording' && v.counts.actions >= 3 ? v : null;
      }, 'the live draft');
      expect(live.can).toMatchObject({ annotate: true, save: false, discard: true, stop: true });
      expect(live.untrusted!.yaml_lines.join('\n')).toContain('{{vars.password_1}}');
      // The stream names this recording while the runner writes its events.
      await until(async () => stream.events.some((e) => e.event === 'workspace' && (e.data.records as string[] | undefined)?.includes(`${P}/${lab.rec}`)), 'a records event');
      await page.getByLabel('Note').blur();
      caption = await ok<{ rev: number; insert_id?: string }>('record_annotate', {
        project: P,
        rec_id: lab.rec,
        rev: live.rev,
        change: { op: 'insert', at: 'end', insert: { kind: 'caption', text: 'Add a note' } },
      });
      expect(caption.rev).toBe(live.rev + 1);
      const stale = await call('record_annotate', { project: P, rec_id: lab.rec, rev: live.rev, change: { op: 'insert', at: 'end', insert: { kind: 'hold', seconds: 2 } } });
      expect(stale.status).toBe(409);
      expect(stale.json<Fail>().error.fix).toBe(`rev: ${caption.rev}`);
      await page.getByRole('button', { name: 'Forgery target' }).click();
      await page.waitForTimeout(300);
      const stopped = await ok<{ action: string; view: RecordViewAnswer }>('record_stop', { project: P, rec_id: lab.rec });
      expect(stopped.action).toBe('stopping');
      await page.waitForEvent('close', { timeout: 10_000 }).catch(() => undefined);
    });
    stream.close();
    const job = (await queue.get(lab.job))!;
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(existsSync(join(ws, 'projects', P, 'scenarios', 'ops-lab.yaml'))).toBe(false);
    const r = await call('record_view', { project: P, rec_id: lab.rec });
    expect(r.body).not.toContain(ws);
    const v = r.json<{ data: RecordViewAnswer }>().data;
    expect(v).toMatchObject({ state: 'done', started_by: 'ui', rev: caption!.rev, can: { annotate: true, save: true, discard: true, stop: false }, check: { status: 'passed' }, saved: null });
    const yaml = v.untrusted!.yaml_lines.join('\n');
    expect(yaml).toContain('Add a note');
    expect(yaml).toContain('Two words');
    expect(yaml).toContain('{{vars.password_1}}');
    expect(v.untrusted!.inserts.map((x) => x.kind)).toEqual(['caption']);
    // Page and typed text only under `untrusted`: the trusted fields carry counts, enums and names.
    const trusted = trustedText(v);
    for (const text of ['Two words', 'Add a note', 'Forgery target', 'Note', 'Recording lab']) expect(trusted, text).not.toContain(text);
    expect((await ok<RecordViewAnswer>('record_view', { project: P, rec_id: lab.rec, since: v.version })).unchanged).toBe(true);
  }, 180_000);

  it('Save: a taken name 409 with its fix, then a NEW scenario, read-only after; the recent list says so', async () => {
    const v = await ok<RecordViewAnswer>('record_view', { project: P, rec_id: lab.rec });
    const quote = await readFile(join(ws, 'projects', P, 'scenarios', 'quote.yaml'), 'utf8');
    const taken = await call('record_save', { project: P, rec_id: lab.rec, name: 'quote', rev: v.rev, draft: v.draft_sha256 });
    expect(taken.status).toBe(409);
    expect(taken.json<Fail>().error.message).toMatch(/choose another name/);
    expect(await readFile(join(ws, 'projects', P, 'scenarios', 'quote.yaml'), 'utf8')).toBe(quote);
    // Another draft than the one on screen: 409, no file.
    const stale = await call('record_save', { project: P, rec_id: lab.rec, name: 'ops-lab', rev: v.rev, draft: 'b'.repeat(64) });
    expect(stale.status).toBe(409);
    expect(existsSync(join(ws, 'projects', P, 'scenarios', 'ops-lab.yaml'))).toBe(false);
    const r = await call('record_save', { project: P, rec_id: lab.rec, name: 'ops-lab', rev: v.rev, draft: v.draft_sha256 });
    expect(r.status, r.body).toBe(200);
    expect(r.body).not.toContain(ws);
    const s = r.json<{ data: { name: string; file: string; hash: string; rev: number } }>().data;
    expect(s).toMatchObject({ name: 'ops-lab', file: 'scenarios/ops-lab.yaml', rev: v.rev + 1 });
    const written = await readFile(join(ws, 'projects', P, 'scenarios', 'ops-lab.yaml'), 'utf8');
    expect(written.replace(/\n$/, '').split('\n')).toEqual(v.untrusted!.yaml_lines);
    const after = await ok<RecordViewAnswer>('record_view', { project: P, rec_id: lab.rec });
    expect(after).toMatchObject({ saved: { name: 'ops-lab', file: 'scenarios/ops-lab.yaml' }, can: { annotate: false, save: false } });
    expect((await call('record_annotate', { project: P, rec_id: lab.rec, rev: after.rev, change: { op: 'insert', at: 'end', insert: { kind: 'mark' } } })).status).toBe(409);
    const o = await ok<RecordOptionsAnswer>('record_options', { project: P });
    expect(o.open).toBeNull();
    const item = o.recent.find((x) => x.rec_id === lab.rec)!;
    expect(item).toMatchObject({ state: 'done', started_by: 'ui', name: 'ops-lab', saved: { name: 'ops-lab', file: 'scenarios/ops-lab.yaml' }, studio: false });
    expect(item.steps).toBeGreaterThan(0);
    expect(item.actions).toBeGreaterThanOrEqual(3);
  });

  it("a recording Claude started is read-only (403); a crafted check failure is path-free under untrusted; Discard of the Studio's copy", async () => {
    // A copy of the recording, as if Claude had started it (meta.json submitted_by mcp, no job).
    const claude = newRecordId();
    await cp(recDir(lab.rec), recDir(claude), { recursive: true });
    const meta = JSON.parse(await readFile(join(recDir(claude), 'meta.json'), 'utf8')) as Record<string, unknown>;
    await rm(join(recDir(claude), 'meta.json'));
    await writeFile(join(recDir(claude), 'meta.json'), JSON.stringify({ ...meta, rec_id: claude, job_id: null, submitted_by: 'mcp' }), { mode: 0o600 });
    await rm(join(recDir(claude), 'studio.json'));
    const v = await ok<RecordViewAnswer>('record_view', { project: P, rec_id: claude });
    expect(v).toMatchObject({ state: 'done', started_by: 'mcp', can: { annotate: false, save: false, discard: false } });
    for (const [op, args] of [
      ['record_annotate', { project: P, rec_id: claude, rev: 0, change: { op: 'insert', at: 'end', insert: { kind: 'mark' } } }],
      ['record_save', { project: P, rec_id: claude, name: 'claude-copy', rev: 0, draft: v.draft_sha256 }],
      ['record_discard', { project: P, rec_id: claude }],
    ] as const) {
      const r = await call(op, args);
      expect(r.status, `${op}: ${r.body}`).toBe(403);
    }
    expect(existsSync(join(ws, 'projects', P, 'scenarios', 'claude-copy.yaml'))).toBe(false);
    expect(existsSync(recDir(claude))).toBe(true);

    // A Studio copy whose record.json says the check failed with paths in its text (the runner's error).
    const mine = newRecordId();
    await cp(recDir(lab.rec), recDir(mine), { recursive: true });
    await rm(join(recDir(mine), 'meta.json'));
    // The Studio's own: its job (submitted_by ui) is the one meta.json names (review A-L1).
    const q = new FileJobQueue(ws);
    const job = await q.enqueue({ version: 1, kind: 'record', project: P, rec_id: mine, source: { page: 'shop', path: '/record-lab' }, check: true, submitted_by: 'ui' });
    const at = new Date().toISOString();
    await q.write({ ...job, state: 'succeeded', started_at: at, finished_at: at });
    await writeFile(join(recDir(mine), 'meta.json'), JSON.stringify({ ...meta, rec_id: mine, job_id: job.id }), { mode: 0o600 });
    await rm(join(recDir(mine), 'studio.json'));
    const rj = JSON.parse(await readFile(join(recDir(mine), 'record.json'), 'utf8')) as Record<string, unknown>;
    const elsewhere = '/private/var/folders/zz/elsewhere/T/shot.png';
    await writeFile(
      join(recDir(mine), 'record.json'),
      JSON.stringify({
        ...rj,
        saved: null,
        check: {
          status: 'failed',
          scope: 'all',
          steps_passed: 1,
          steps_total: 3,
          failed_at: { scene: 'record-lab', step: 1, action: 'click' },
          untrusted: { error: `no element — see ${ws}/projects/${P}/runs/x/error.png and ${elsewhere}` },
        },
      }),
      { mode: 0o600 },
    );
    const r = await call('record_view', { project: P, rec_id: mine });
    expect(r.status, r.body).toBe(200);
    expect(r.body).not.toContain(ws);
    expect(r.body).not.toContain('/private/var/folders/zz/elsewhere');
    const failed = r.json<{ data: RecordViewAnswer }>().data;
    expect(failed).toMatchObject({ state: 'done', started_by: 'ui', check: { status: 'failed' }, can: { discard: true } });
    expect(failed.untrusted!.check!.error).toMatch(/no element/);
    expect(trustedText(failed)).not.toContain('no element');
    expect(await ok<{ rec_id: string; state: string }>('record_discard', { project: P, rec_id: mine })).toEqual({ rec_id: mine, state: 'discarded' });
    expect(existsSync(recDir(mine))).toBe(false);
    expect((await ok<RecordViewAnswer>('record_view', { project: P, rec_id: mine })).state).toBe('missing');
    await rm(recDir(claude), { recursive: true, force: true });
  });

  it("the password sentinel is nowhere: answers, workspace files, worker log, the Studio's log and stderr", async () => {
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        if (e.name === 'fixtures' || e.name === 'node_modules') continue;
        if (e.isDirectory()) await walk(join(d, e.name));
        else if (e.isFile()) files.push(join(d, e.name));
      }
    };
    await walk(ws);
    // The job folders, the worker's log, the history and the recording's own files are among them.
    expect(files.some((f) => f.endsWith(join('jobs', lab.job, 'job.json')))).toBe(true);
    expect(files.some((f) => f.endsWith(join('records', lab.rec, 'events.jsonl')))).toBe(true);
    expect(files.some((f) => f.endsWith('history.jsonl'))).toBe(true);
    for (const f of files) expect((await readFile(f)).includes(SENTINEL), f).toBe(false);
    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) expect(b).not.toContain(SENTINEL);
    for (const l of [...logs, ...workerLogs, ...stderr]) expect(l).not.toContain(SENTINEL);
  });
});
