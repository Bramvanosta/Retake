/**
 * L4.8 the Studio's side of a recording (engine record-studio.ts, R-UI-20 / 21 / 22) on the fixture product (own ports
 * 4551–4554), the worker run in this process with Playwright playing the person (`recordTest.drive`, which a worker
 * process cannot receive) — and the person's Studio calls made from inside the drive, while the window is open.
 *
 * - A Studio recording (`ui`): meta.json at folder creation, never auto-saved; the live view; a caption inserted "at the
 *   end" right after a visit to the Studio committed the typing (resolved under the lock: B3); a hold, a target pick, a
 *   stale revision; Stop (the window closes as if closed, the check replay runs); Save — a new file only, the name
 *   rules, a stale revision, then read-only; a password sentinel nowhere but where L3.4 allows (nowhere at all here).
 * - Its events edited after the check: Save refused (B8), the view says so, a crafted line dropped.
 * - studio.json a symbolic link: never read or written through it; Discard of a finished recording.
 * - A recording Claude started (`mcp`): unchanged (auto-saved), read-only from the Studio, the view's draft
 *   byte-identical to the worker's draft.yaml; the record ops refused to the MCP client.
 * - Discard during the check (B9); MCP job_cancel refused on the person's open recording (B16); one window at a time
 *   (B5); an interrupted recording (B6) saved; Stop before the window opens; prune keeps what is in use (B12); the
 *   records folder a link: Discard removes nothing through it.
 * - After the reviews: Save writes only the draft the person saw (A-M1); a spoiled or missing record.json is tampered
 *   (A-M2); a hidden character is never saved (A-M3); a recording is the person's only with its job (A-L1); reads never
 *   follow a link (A-L3); the zoom under the theme's max_zoom (B-M3); the check's failing step on screen (B-M4); Discard
 *   of an open window ends "discarded" (B-M5); a Discard during the check is settled by the job and the list (B-L2);
 *   Stop before the window is a clean cancel (B-L8).
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firstHiddenChar } from '@retake/core';
import { TakeLock } from '@retake/sandbox';
import {
  FileJobQueue,
  RECORD_KEEP,
  createEngine,
  historyFile,
  jobsDir,
  newRecordId,
  openProject,
  openWorkspace,
  pruneRecords,
  recordLockFile,
  recordsRoot,
  runWorker,
  saveRecordedDraft,
} from '../src/index.js';
import type { Engine, EngineError, RecordJobResult, RecordJobTestHooks, RecordView } from '../src/index.js';
import { REPO, fixtureWorkspace } from './helpers.js';

type Page = Parameters<NonNullable<RecordJobTestHooks['drive']>>[0];

interface Fixture {
  urls: { console: string; shop: string; signedIn?: { console: string; shop: string } };
  close(): Promise<void>;
}

const PROJECT = 'northfield-fixture';
const SENTINEL = `Sentinel-${randomBytes(6).toString('hex')}`;
let fixture: Fixture;
let root: string;
let ui: Engine;
let mcp: Engine;
const logs: string[] = [];
const answers: unknown[] = [];
const saved = { home: process.env.RETAKE_HOME, max: process.env.RETAKE_RECORD_MAX_MIN, tmp: process.env.TMPDIR };

/** Keep every answer for the sentinel scan. */
function keep<T>(x: T): T {
  answers.push(x);
  return x;
}

/** The in-process worker (one job), Playwright playing the person; the window closes after `drive` if still open. */
function work(drive: (page: Page) => Promise<void>): Promise<number> {
  return runWorker({
    root,
    once: true,
    idleExitMs: 0,
    pollMs: 50,
    log: (m) => logs.push(m),
    recordTest: {
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
  });
}

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  expect(e, 'expected a refusal').not.toBeNull();
  answers.push({ code: e!.code, message: e!.message, details: e!.details });
  return e!;
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (e.isFile()) out.push(join(d, e.name));
    }
  };
  if (existsSync(dir)) await walk(dir);
  return out;
}

const project = async () => openProject(await openWorkspace({ root }), PROJECT);
const recDir = async (id: string) => join(recordsRoot(await project()), id);
const fileEvents = async (id: string) =>
  (await readFile(join(await recDir(id), 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { seq: number; kind: string; el?: { label?: string | null } });
const studioJson = async (id: string) => JSON.parse(await readFile(join(await recDir(id), 'studio.json'), 'utf8')) as { rev: number; inserts: Array<{ id: string; after_seq: number; kind: string }>; choices: Record<string, number> };
const mode = (f: string) => statSync(f).mode & 0o777;

/** A `record` job of the Studio (or `by`) for a recording, in a final or running state (no worker runs it). */
async function fakeJob(rec: string, state: 'succeeded' | 'running' | 'queued', by: 'ui' | 'mcp' = 'ui') {
  const q = new FileJobQueue(root, 'retake');
  const job = await q.enqueue({ version: 1, kind: 'record', project: PROJECT, rec_id: rec, source: { page: 'shop', path: '/record-lab' }, check: true, submitted_by: by });
  const now = new Date().toISOString();
  if (state === 'succeeded') await q.write({ ...job, state, started_at: now, finished_at: now });
  if (state === 'running') {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    await q.write({ ...job, state, started_at: now, worker: { pid: dead, host: 'h' }, progress: { steps_done: 0, steps_total: 0, phase: 'recording · 4 actions', updated_at: now } });
  }
  return job;
}

/**
 * A copy of a recording under a new id, as the Studio's own: meta.json renamed, with its own succeeded job (a finished
 * recording with its record.json). `job: false`: no job (meta.json's job_id null).
 */
async function cloneRecording(id: string, o: { job?: boolean } = {}): Promise<string> {
  const next = newRecordId();
  const from = await recDir(id);
  const to = await recDir(next);
  await cp(from, to, { recursive: true });
  const meta = JSON.parse(await readFile(join(to, 'meta.json'), 'utf8')) as Record<string, unknown>;
  await rm(join(to, 'meta.json'));
  const job = o.job === false ? null : await fakeJob(next, 'succeeded');
  await writeFile(join(to, 'meta.json'), JSON.stringify({ ...meta, rec_id: next, job_id: job?.id ?? null }), { mode: 0o600 });
  // Not saved (the copy of a saved recording would be read-only).
  if (existsSync(join(to, 'studio.json'))) {
    const { saved: _saved, ...ann } = JSON.parse(await readFile(join(to, 'studio.json'), 'utf8')) as Record<string, unknown>;
    await rm(join(to, 'studio.json'));
    await writeFile(join(to, 'studio.json'), JSON.stringify(ann), { mode: 0o600 });
  }
  return next;
}

/** An interrupted Studio copy of a recording (its job running on a dead worker, no record.json, no stop event). */
async function interruptedCopy(id: string, name: string): Promise<string> {
  const next = newRecordId();
  const job = await fakeJob(next, 'running');
  const dir = await recDir(next);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const from = await recDir(id);
  const meta = JSON.parse(await readFile(join(from, 'meta.json'), 'utf8')) as Record<string, unknown>;
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, rec_id: next, job_id: job.id, name }), { mode: 0o600 });
  const lines = (await readFile(join(from, 'events.jsonl'), 'utf8')).split('\n').filter((l) => l && !l.includes('"kind":"stop"'));
  await writeFile(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`, { mode: 0o600 });
  return next;
}

/** Save as the Record screen does: the revision and the draft of the view on screen. */
async function saveShown(id: string, name: string, v?: RecordView) {
  const shown = v ?? (await ui.record.view(PROJECT, id));
  return ui.record.save(PROJECT, id, { name, rev: shown.rev, draft: shown.draft_sha256 ?? '' });
}

beforeAll(async () => {
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as {
    startFixture(o: { consolePort: number; shopPort: number; host: string; auth: { consolePort: number; shopPort: number } }): Promise<Fixture>;
  };
  fixture = await mod.startFixture({ consolePort: 4551, shopPort: 4552, host: '127.0.0.1', auth: { consolePort: 4553, shopPort: 4554 } });
  root = await mkdtemp(join(tmpdir(), 'studio-record-studio-'));
  process.env.RETAKE_HOME = join(root, '.home');
  // The window's session copies land here: the sentinel scan reads them, and none may stay (review A-N4).
  await mkdir(join(root, '.tmp'), { recursive: true });
  process.env.TMPDIR = join(root, '.tmp');
  delete process.env.RETAKE_RECORD_MAX_MIN;
  await fixtureWorkspace(root);
  const projectDir = join(root, 'projects', PROJECT);
  const strip = (u: string) => u.replace(/\/$/, '');
  const yaml = (await readFile(join(projectDir, 'project.yaml'), 'utf8'))
    .replaceAll('http://localhost:4401', strip(fixture.urls.console))
    .replaceAll('http://localhost:4402', strip(fixture.urls.shop))
    .replaceAll('http://localhost:4403', strip(fixture.urls.signedIn!.console))
    .replaceAll('http://localhost:4404', strip(fixture.urls.signedIn!.shop));
  await writeFile(join(projectDir, 'project.yaml'), yaml);
  ui = await createEngine({ root, client: 'ui', autoStartWorker: false });
  mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false });
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
  for (const [k, v] of [
    ['RETAKE_HOME', saved.home],
    ['RETAKE_RECORD_MAX_MIN', saved.max],
    ['TMPDIR', saved.tmp],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

let lab: { rec: string; job: string };

describe('a Studio recording: live view, annotations, Stop, Save', () => {
  it('records the lab: meta.json, no auto-save, a caption at the end after a Studio visit, a hold, a pick, Stop runs the check', async () => {
    const sub = keep(await ui.record.submit({ project: PROJECT, page: 'shop', path: '/record-lab', scenario: 'studio-lab' }));
    lab = { rec: sub.rec_id, job: sub.job.id };
    expect(sub.job.input).toMatchObject({ kind: 'record', submitted_by: 'ui', check: true });
    const queued = keep(await ui.record.view(PROJECT, sub.rec_id, { job: sub.job.id }));
    expect(queued).toMatchObject({ state: 'queued', started_by: 'ui', can: { annotate: false, save: false, discard: true, stop: true }, untrusted: null });

    let beforeBlur = -1;
    let noteSeq = -1;
    let caption: { rev: number; insert_id?: string } | undefined;
    await work(async (page) => {
      await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await page.locator('#lab-password').click();
      await page.keyboard.type(SENTINEL);
      await page.getByLabel('Note').click();
      await page.keyboard.type('Two');
      // The screen polls: the draft so far, while the window is open.
      const v1 = keep(await until(async () => {
        const v = await ui.record.view(PROJECT, sub.rec_id);
        return v.state === 'recording' && v.counts.actions >= 3 ? v : null;
      }, 'the live draft'));
      expect(v1.can).toMatchObject({ annotate: true, save: false, discard: true, stop: true });
      expect(v1.untrusted?.yaml).toContain('{{vars.password_1}}');
      beforeBlur = Math.max(...(await fileEvents(sub.rec_id)).map((e) => e.seq));
      // Switching to the Studio blurs the window: the typing is committed now, after the screen's last poll.
      await page.getByLabel('Note').blur();
      noteSeq = (await until(async () => (await fileEvents(sub.rec_id)).find((e) => e.kind === 'type' && e.el?.label === 'Note'), 'the committed typing')).seq;
      expect(noteSeq).toBeGreaterThan(beforeBlur);
      caption = keep(await ui.record.annotate(PROJECT, sub.rec_id, { rev: 0, change: { op: 'insert', at: 'end', insert: { kind: 'caption', text: 'Add a note' } } }));
      expect(caption.rev).toBe(1);
      await page.getByRole('button', { name: 'Forgery target' }).click();
      const pick = keep(await until(async () => {
        const v = await ui.record.view(PROJECT, sub.rec_id);
        return v.untrusted?.alternatives.find((a) => a.options.some((o) => JSON.stringify(o.target).includes('#lab-forge-target')));
      }, 'the button\'s alternatives'));
      expect(pick.chosen).toBe(0);
      expect(pick.options[0].index).toBe(0);
      const css = pick.options.find((o) => JSON.stringify(o.target).includes('#lab-forge-target'))!;
      expect((await refusal(ui.record.annotate(PROJECT, sub.rec_id, { rev: 0, change: { op: 'choose', seq: pick.seq, index: css.index } }))).code).toBe('conflict');
      expect(keep(await ui.record.annotate(PROJECT, sub.rec_id, { rev: 1, change: { op: 'choose', seq: pick.seq, index: css.index } })).rev).toBe(2);
      expect(keep(await ui.record.annotate(PROJECT, sub.rec_id, { rev: 2, change: { op: 'insert', at: 'end', insert: { kind: 'hold', seconds: 2 } } })).rev).toBe(3);
      await page.getByLabel('Roast level').focus();
      await page.keyboard.press('d');
      await page.waitForTimeout(300);
      // Stop and keep: the window closes as if the person closed it.
      const stopped = keep(await ui.record.stop(PROJECT, sub.rec_id));
      expect(stopped.action).toBe('stopping');
      await page.waitForEvent('close', { timeout: 10_000 }).catch(() => undefined);
    });

    const job = await ui.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    const r = job.result as RecordJobResult;
    // Never saved by the job; the check replay ran (a Stop is not a worker signal).
    expect(r).toMatchObject({ saved: null, not_saved: 'studio', stop: 'stopped', check: { status: 'passed', scope: 'all' } });
    const p = await project();
    expect(existsSync(join(p.dir, 'scenarios', 'studio-lab.yaml'))).toBe(false);
    const dir = await recDir(sub.rec_id);
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    expect(meta).toMatchObject({ v: 1, rec_id: sub.rec_id, job_id: sub.job.id, submitted_by: 'ui', name: 'studio-lab', env: 'local', persona: null, page: 'shop', path: '/record-lab' });
    for (const f of ['meta.json', 'studio.json', 'record.json', 'events.jsonl']) expect(mode(join(dir, f)), f).toBe(0o600);
    const rj = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8')) as { events_sha256: string };
    expect(rj.events_sha256).toMatch(/^[0-9a-f]{64}$/);

    // B3: "at the end" is the newest event in the file when the change was made — the typing the blur committed.
    const ann = await studioJson(sub.rec_id);
    const i1 = ann.inserts.find((x) => x.id === caption!.insert_id)!;
    expect(i1.after_seq).toBeGreaterThanOrEqual(noteSeq);
    const v = keep(await ui.record.view(PROJECT, sub.rec_id));
    expect(v).toMatchObject({ state: 'done', rev: 3, can: { annotate: true, save: true, discard: true, stop: false }, check: { status: 'passed', events_changed: false }, saved: null });
    const u = v.untrusted!;
    const onCaption = u.sources.find((s) => s.modifiers?.includes(i1.id))!;
    const typing = u.sources.find((s) => s.role === 'action' && s.seqs[0] <= noteSeq && noteSeq <= s.seqs[1])!;
    expect(onCaption).toBeTruthy();
    expect(onCaption).not.toBe(typing);
    expect(onCaption.seqs[1]).toBeGreaterThan(i1.after_seq);
    expect(u.yaml).toContain('Add a note');
    expect(u.yaml).toContain('- hold: 2');
    expect(u.yaml).toContain('#lab-forge-target');
    expect(u.yaml).toContain('{{vars.password_1}}');
    expect(u.inserts.map((x) => x.kind)).toEqual(['caption', 'hold']);
    // An unchanged poll is short.
    expect(keep(await ui.record.view(PROJECT, sub.rec_id, { since: v.version }))).toMatchObject({ unchanged: true, state: 'done' });
  }, 180_000);

  it('its events edited after the check: Save refused, the view says so, a crafted line dropped (B8)', async () => {
    const id = await cloneRecording(lab.rec);
    const dir = await recDir(id);
    const text = await readFile(join(dir, 'events.jsonl'), 'utf8');
    expect(text).toContain('"Two"');
    await writeFile(join(dir, 'events.jsonl'), `${text.replace('"Two"', '"Ten"')}{"seq":999,"kind":"pointer","forged":true}\n`, { mode: 0o600 });
    const v = keep(await ui.record.view(PROJECT, id));
    expect(v).toMatchObject({ state: 'done', started_by: 'ui', check: { events_changed: true }, can: { save: false } });
    expect(v.counts.dropped_lines).toBe(1);
    const e = await refusal(ui.record.save(PROJECT, id, { name: 'studio-edited', rev: v.rev, draft: v.draft_sha256! }));
    expect(e.code).toBe('conflict');
    expect(e.message).toMatch(/events changed after it was drafted and checked/);
    expect(existsSync(join((await project()).dir, 'scenarios', 'studio-edited.yaml'))).toBe(false);
    // Discard of a finished recording: its folder only.
    expect(keep(await ui.record.discard(PROJECT, id))).toEqual({ rec_id: id, state: 'discarded' });
    expect(existsSync(dir)).toBe(false);
    expect(keep(await ui.record.view(PROJECT, id)).state).toBe('missing');
  });

  it('studio.json a symbolic link: annotate refused, nothing read or written through it', async () => {
    const id = await cloneRecording(lab.rec);
    const dir = await recDir(id);
    const outside = join(root, 'outside-studio.json');
    await copyFile(join(dir, 'studio.json'), outside);
    const before = await readFile(outside, 'utf8');
    await rm(join(dir, 'studio.json'));
    await symlink(outside, join(dir, 'studio.json'));
    const v = keep(await ui.record.view(PROJECT, id));
    expect(v.problem).toMatch(/symbolic link/);
    expect(v.can.annotate).toBe(false);
    const e = await refusal(ui.record.annotate(PROJECT, id, { rev: 3, change: { op: 'insert', at: 'end', insert: { kind: 'mark' } } }));
    expect(e.code).toBe('invalid');
    expect(e.message).toMatch(/symbolic link/);
    expect(await readFile(outside, 'utf8')).toBe(before);
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it('Save: a stale revision, a taken name, a path as a name refused; then a NEW scenario, read-only after', async () => {
    const p = await project();
    const quote = await readFile(join(p.dir, 'scenarios', 'quote.yaml'), 'utf8');
    const shown = await ui.record.view(PROJECT, lab.rec);
    const draft = shown.draft_sha256!;
    expect(draft).toMatch(/^[0-9a-f]{64}$/);
    expect((await refusal(ui.record.save(PROJECT, lab.rec, { name: 'studio-lab', rev: 2, draft }))).code).toBe('conflict');
    const taken = await refusal(ui.record.save(PROJECT, lab.rec, { name: 'quote', rev: 3, draft }));
    expect(taken.code).toBe('conflict');
    expect(taken.message).toMatch(/choose another name/);
    expect(await readFile(join(p.dir, 'scenarios', 'quote.yaml'), 'utf8')).toBe(quote);
    expect((await refusal(ui.record.save(PROJECT, lab.rec, { name: '../escape', rev: 3, draft }))).code).toBe('invalid');
    expect(existsSync(join(p.dir, 'escape.yaml'))).toBe(false);
    // The draft is required: never a save of whatever is on disk.
    expect((await refusal(ui.record.save(PROJECT, lab.rec, { name: 'studio-lab', rev: 3, draft: '' }))).code).toBe('invalid');

    const s = keep(await ui.record.save(PROJECT, lab.rec, { name: 'studio-lab', rev: 3, draft }));
    expect(s).toMatchObject({ name: 'studio-lab', file: 'scenarios/studio-lab.yaml', rev: 4 });
    const written = await readFile(join(p.dir, 'scenarios', 'studio-lab.yaml'), 'utf8');
    expect(written).toBe(shown.untrusted!.yaml.endsWith('\n') ? shown.untrusted!.yaml : `${shown.untrusted!.yaml}\n`);
    // A Studio draft holds no YAML anchor or alias (B-M2).
    expect(written).not.toMatch(/[&*]a\d/);
    expect(JSON.stringify(s)).not.toContain(root);
    const after = keep(await ui.record.view(PROJECT, lab.rec));
    expect(after).toMatchObject({ saved: { name: 'studio-lab', file: 'scenarios/studio-lab.yaml', hash: s.hash }, can: { annotate: false, save: false } });
    expect((await refusal(ui.record.annotate(PROJECT, lab.rec, { rev: 4, change: { op: 'insert', at: 'end', insert: { kind: 'mark' } } }))).code).toBe('conflict');
    expect((await refusal(ui.record.save(PROJECT, lab.rec, { name: 'studio-lab-2', rev: 4, draft }))).code).toBe('conflict');
    expect(existsSync(join(p.dir, 'scenarios', 'studio-lab-2.yaml'))).toBe(false);
  });

  it('the write path of Save: agent trust refuses a secret reference, with no path in the answer', async () => {
    const p = await project();
    const yaml = `version: 1\nvideo: trust-check\nscenes:\n  - id: lab\n    page: shop\n    open: /record-lab\n    steps:\n      - type: {into: {label: Note}, text: "{{env:HOME}}"}\n`;
    const e = await refusal(saveRecordedDraft(p, 'trust-check', yaml, ['lab']));
    expect(e.code).toBe('invalid');
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain(p.dir);
    expect((e.details as { issues: Array<{ scene?: string; step?: number }> }).issues[0]).toMatchObject({ scene: 'lab', step: 0 });
    expect(existsSync(join(p.dir, 'scenarios', 'trust-check.yaml'))).toBe(false);
  });
});

describe('a recording Claude started: unchanged, read-only from the Studio', () => {
  it('auto-saved by its job; the view rebuilds the same draft; annotate / save / discard refused; the ops refused to MCP', async () => {
    const sub = await mcp.record.submit({ project: PROJECT, page: 'shop', scenario: 'by-claude', check: false });
    await work(async (page) => {
      await page.getByText('Selowa Ridge').first().click();
      await page.getByRole('button', { name: 'Request a quote' }).waitFor();
    });
    const job = await mcp.jobs.get(sub.job.id);
    expect(job.state, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.result).toMatchObject({ saved: { file: 'scenarios/by-claude.yaml' } });
    expect((job.result as RecordJobResult).not_saved).toBeUndefined();
    const dir = await recDir(sub.rec_id);
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))).toMatchObject({ submitted_by: 'mcp', job_id: sub.job.id });
    const v = keep(await ui.record.view(PROJECT, sub.rec_id));
    expect(v).toMatchObject({ state: 'done', started_by: 'mcp', can: { annotate: false, save: false, discard: false, stop: false }, saved: { file: 'scenarios/by-claude.yaml' } });
    expect(v.problem).toMatch(/Claude started this recording/);
    // B4: meta.json gives the worker's context — the same draft, byte for byte.
    expect(v.untrusted!.yaml).toBe(await readFile(join(dir, 'draft.yaml'), 'utf8'));
    for (const p of [
      () => ui.record.annotate(PROJECT, sub.rec_id, { rev: 0, change: { op: 'insert', at: 'end', insert: { kind: 'mark' } } }),
      () => ui.record.save(PROJECT, sub.rec_id, { name: 'by-claude-2', rev: 0, draft: v.draft_sha256! }),
      () => ui.record.discard(PROJECT, sub.rec_id),
    ]) {
      const e = await refusal(p());
      expect(e.code).toBe('refused');
    }
    expect(existsSync(join(dir, 'studio.json'))).toBe(false);
    expect(existsSync(dir)).toBe(true);
    for (const p of [() => mcp.record.view(PROJECT, sub.rec_id), () => mcp.record.stop(PROJECT, sub.rec_id), () => mcp.record.discard(PROJECT, sub.rec_id)]) {
      expect((await refusal(p())).code).toBe('refused');
    }
  }, 120_000);
});

describe('discard, cancel and one window at a time', () => {
  it('B16 / B5 while queued; Discard during the check removes the folder once the job is over (B9)', async () => {
    const sub = keep(await ui.record.submit({ project: PROJECT, page: 'shop', scenario: 'to-discard' }));
    // B16: Claude's job_cancel never discards the person's open recording.
    const b16 = await refusal(mcp.jobs.cancel(sub.job.id));
    expect(b16.code).toBe('refused');
    expect(b16.message).toMatch(/started in the Studio/);
    expect((await ui.jobs.get(sub.job.id)).cancel_requested_at).toBeUndefined();
    // B5: one window at a time.
    const second = await refusal(ui.record.submit({ project: PROJECT, page: 'shop' }));
    expect(second.code).toBe('conflict');
    expect(second.details).toMatchObject({ job: sub.job.id, rec_id: sub.rec_id });

    let discarded: unknown;
    const watch = (async () => {
      await until(async () => (await ui.jobs.get(sub.job.id)).progress?.phase === 'check', 'the check phase', 60_000);
      discarded = keep(await ui.record.discard(PROJECT, sub.rec_id));
    })();
    await work(async (page) => {
      await page.getByText('Selowa Ridge').first().click();
      await page.getByRole('button', { name: 'Request a quote' }).waitFor();
      await page.getByRole('button', { name: 'Request a quote' }).click();
      await page.waitForTimeout(500);
    });
    await watch;
    expect(discarded).toEqual({ rec_id: sub.rec_id, state: 'discarding' });
    const job = await ui.jobs.get(sub.job.id);
    expect(FINISHED.has(job.state)).toBe(true);
    // The job itself removed the folder at its end (B-L2): no Record screen needs to look again; the list never shows it.
    expect(existsSync(await recDir(sub.rec_id))).toBe(false);
    expect((await ui.record.list(PROJECT, { limit: 50 })).some((x) => x.rec_id === sub.rec_id)).toBe(false);
    // Read once the folder is gone, with the job as the Record screen passes it: discarded (the job ended well though
    // cancelled), never "nothing recorded".
    expect(keep(await ui.record.view(PROJECT, sub.rec_id, { job: sub.job.id })).state).toBe('discarded');
    expect(existsSync(join((await project()).dir, 'scenarios', 'to-discard.yaml'))).toBe(false);
  }, 180_000);

  it('an interrupted Studio recording (B6): unchecked, annotated, saved from its events', async () => {
    const q = new FileJobQueue(root, 'retake');
    const id = newRecordId();
    const job = await q.enqueue({ version: 1, kind: 'record', project: PROJECT, rec_id: id, source: { page: 'shop', path: '/record-lab' }, check: true, submitted_by: 'ui' });
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    await q.write({ ...job, state: 'running', started_at: new Date().toISOString(), worker: { pid: dead, host: 'h' }, progress: { steps_done: 0, steps_total: 0, phase: 'recording · 4 actions', updated_at: new Date().toISOString() } });
    const dir = await recDir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const from = await recDir(lab.rec);
    const meta = JSON.parse(await readFile(join(from, 'meta.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, rec_id: id, job_id: job.id, name: 'studio-cut' }), { mode: 0o600 });
    const lines = (await readFile(join(from, 'events.jsonl'), 'utf8')).split('\n').filter((l) => l && !l.includes('"kind":"stop"'));
    await writeFile(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`, { mode: 0o600 });
    const v = keep(await ui.record.view(PROJECT, id));
    expect(v).toMatchObject({ state: 'interrupted', check: null, can: { annotate: true, save: true, discard: true, stop: false } });
    const a = keep(await ui.record.annotate(PROJECT, id, { rev: 0, change: { op: 'insert', at: 'end', insert: { kind: 'caption', text: 'The end' } } }));
    expect(a.view.untrusted!.issues.map((i) => i.code)).toContain('insert_moved');
    const s = keep(await saveShown(id, 'studio-cut', a.view));
    expect(s.file).toBe('scenarios/studio-cut.yaml');
    expect(await readFile(join((await project()).dir, 'scenarios', 'studio-cut.yaml'), 'utf8')).toContain('The end');
  });

  it('Stop before the window opens cancels the job', async () => {
    const sub = keep(await ui.record.submit({ project: PROJECT, page: 'shop' }));
    const r = keep(await ui.record.stop(PROJECT, sub.rec_id, { job: sub.job.id }));
    expect(r.action).toBe('cancelled');
    expect(r.view.state).toBe('cancelled');
    await work(async () => undefined); // the worker closes the cancelled job
    expect((await ui.jobs.get(sub.job.id)).state).toBe('cancelled');
  }, 60_000);

  it('B-L8: Stop once the worker has the job, before the window: the stop marker, a clean cancel — never a discard race', async () => {
    // Stop on a job the worker runs but whose window is not open yet: the stop marker only (no cancel marker).
    const pre = newRecordId();
    const q = new FileJobQueue(root, 'retake');
    const job0 = await q.enqueue({ version: 1, kind: 'record', project: PROJECT, rec_id: pre, source: { page: 'shop', path: '/' }, check: true, submitted_by: 'ui' });
    const now = new Date().toISOString();
    await q.write({ ...job0, state: 'running', started_at: now, worker: { pid: process.pid, host: 'h' }, progress: { steps_done: 0, steps_total: 0, phase: 'preflight', updated_at: now } });
    const r = keep(await ui.record.stop(PROJECT, pre, { job: job0.id }));
    expect(r.action).toBe('cancelled');
    expect(await q.stopRequested(job0.id)).toBe(true);
    expect(await q.cancelRequested(job0.id)).toBe(false);
    expect(r.view.can.stop).toBe(false);
    await q.write({ ...job0, state: 'cancelled', started_at: now, finished_at: now });
    // The worker takes a job whose stop was asked as it was taken: nothing opens, nothing is kept, no folder.
    const sub = keep(await ui.record.submit({ project: PROJECT, page: 'shop', path: '/record-lab' }));
    await q.requestStop(sub.job.id, 'ui');
    let drove = false;
    await work(async () => {
      drove = true;
    });
    const job = await ui.jobs.get(sub.job.id);
    expect(job.state).toBe('cancelled');
    expect(drove).toBe(false);
    expect(existsSync(await recDir(sub.rec_id))).toBe(false);
    expect(keep(await ui.record.view(PROJECT, sub.rec_id, { job: sub.job.id })).state).toBe('cancelled');
  }, 60_000);

  it('B-M5: Discard while the window is open ends "discarded" (not "cancelled")', async () => {
    const sub = keep(await ui.record.submit({ project: PROJECT, page: 'shop', path: '/record-lab' }));
    let d: unknown;
    await work(async (page) => {
      await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
      await page.locator('#lab-email').click();
      await until(async () => (await ui.record.view(PROJECT, sub.rec_id)).state === 'recording', 'the window open');
      d = keep(await ui.record.discard(PROJECT, sub.rec_id));
      await page.waitForEvent('close', { timeout: 10_000 }).catch(() => undefined);
    });
    expect(d).toEqual({ rec_id: sub.rec_id, state: 'discarding' });
    expect((await ui.jobs.get(sub.job.id)).state).toBe('cancelled');
    expect(existsSync(await recDir(sub.rec_id))).toBe(false);
    expect(keep(await ui.record.view(PROJECT, sub.rec_id, { job: sub.job.id })).state).toBe('discarded');
  }, 60_000);
});

const FINISHED = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

describe('after the reviews (trust)', () => {
  it('A-M1: Save writes only the draft the person saw — an events line or a project.yaml var changed since is a conflict, no file', async () => {
    const p = await project();
    const id = await interruptedCopy(lab.rec, 'studio-seen');
    const dir = await recDir(id);
    const v1 = keep(await ui.record.view(PROJECT, id));
    expect(v1).toMatchObject({ state: 'interrupted', can: { save: true } });
    expect(v1.draft_sha256).toMatch(/^[0-9a-f]{64}$/);
    // One event line edited between the view and Save (no record.json: B8 cannot see it).
    const text = await readFile(join(dir, 'events.jsonl'), 'utf8');
    expect(text).toContain('"Two"');
    await writeFile(join(dir, 'events.jsonl'), text.replace('"Two"', '"Ten"'), { mode: 0o600 });
    const e1 = await refusal(saveShown(id, 'studio-seen', v1));
    expect(e1.code).toBe('conflict');
    expect(e1.message).toMatch(/draft changed since you read it/);
    expect(existsSync(join(p.dir, 'scenarios', 'studio-seen.yaml'))).toBe(false);
    // Read again (the edited line is what is shown now), then a project.yaml var that the draft's placeholder uses.
    const v2 = keep(await ui.record.view(PROJECT, id));
    expect(v2.untrusted!.yaml).toContain('Ten');
    expect(v2.untrusted!.yaml).toContain('password_1: CHANGE-ME');
    const yaml = await readFile(join(p.dir, 'project.yaml'), 'utf8');
    try {
      await writeFile(join(p.dir, 'project.yaml'), `${yaml.trimEnd()}\nvars:\n  password_1: demo-pass\n`);
      const e2 = await refusal(saveShown(id, 'studio-seen', v2));
      expect(e2.code).toBe('conflict');
      expect(existsSync(join(p.dir, 'scenarios', 'studio-seen.yaml'))).toBe(false);
      // The draft on screen now: saved, byte for byte.
      const v3 = keep(await ui.record.view(PROJECT, id));
      expect(v3.untrusted!.yaml).not.toContain('CHANGE-ME');
      keep(await saveShown(id, 'studio-seen', v3));
      expect(await readFile(join(p.dir, 'scenarios', 'studio-seen.yaml'), 'utf8')).toBe(v3.untrusted!.yaml);
    } finally {
      await writeFile(join(p.dir, 'project.yaml'), yaml);
    }
  });

  it('A-M2: fail closed — a spoiled events checksum or a removed record.json is "tampered": no "check passed", no Save', async () => {
    const p = await project();
    const spoiled = await cloneRecording(lab.rec);
    const rj = join(await recDir(spoiled), 'record.json');
    const record = JSON.parse(await readFile(rj, 'utf8')) as Record<string, unknown>;
    expect(record.check).toMatchObject({ status: 'passed' });
    await writeFile(rj, JSON.stringify({ ...record, events_sha256: 'x' }), { mode: 0o600 });
    const v = keep(await ui.record.view(PROJECT, spoiled));
    expect(v).toMatchObject({ state: 'tampered', can: { annotate: false, save: false, discard: true } });
    expect(v.check).toMatchObject({ events_changed: true });
    expect(v.problem).toMatch(/cannot be verified/);
    const e = await refusal(ui.record.save(PROJECT, spoiled, { name: 'tampered-1', rev: v.rev, draft: v.draft_sha256! }));
    expect(e.code).toBe('conflict');
    expect(existsSync(join(p.dir, 'scenarios', 'tampered-1.yaml'))).toBe(false);
    // record.json removed after the job succeeded: tampered too (never "interrupted", which Save accepts).
    const gone = await cloneRecording(lab.rec);
    await rm(join(await recDir(gone), 'record.json'));
    const g = keep(await ui.record.view(PROJECT, gone));
    expect(g).toMatchObject({ state: 'tampered', check: null, can: { annotate: false, save: false } });
    expect((await refusal(ui.record.save(PROJECT, gone, { name: 'tampered-2', rev: g.rev, draft: g.draft_sha256! }))).code).toBe('conflict');
    expect(existsSync(join(p.dir, 'scenarios', 'tampered-2.yaml'))).toBe(false);
    expect((await ui.record.list(PROJECT, { limit: 50 })).find((x) => x.rec_id === gone)).toMatchObject({ state: 'tampered', studio: false });
  });

  it('A-M3: Save never writes a hidden character — refused with its scene and step, no file', async () => {
    const p = await project();
    const rlo = String.fromCharCode(0x202e);
    const yaml = `version: 1\nvideo: hidden-check\nscenes:\n  - id: lab\n    page: shop\n    open: /record-lab\n    steps:\n      - click: Save\n      - click: "Cancel${rlo}lecnac"\n`;
    const e = await refusal(saveRecordedDraft(p, 'hidden-check', yaml, ['lab']));
    expect(e.code).toBe('invalid');
    expect(e.message).toMatch(/scene lab, step 2 holds U\+202E \(a direction control\)/);
    expect(firstHiddenChar(e.message)).toBeUndefined();
    expect(existsSync(join(p.dir, 'scenarios', 'hidden-check.yaml'))).toBe(false);
  });

  it('A-L1: a recording is the person\'s only when its job (the Studio\'s) is the one meta.json names — else read-only', async () => {
    const p = await project();
    // meta.json says ui, with no job.
    const orphan = await cloneRecording(lab.rec, { job: false });
    // meta.json says ui, over a job Claude started.
    const overMcp = await cloneRecording(lab.rec, { job: false });
    const mcpJob = await fakeJob(overMcp, 'succeeded', 'mcp');
    const metaFile = join(await recDir(overMcp), 'meta.json');
    const meta = JSON.parse(await readFile(metaFile, 'utf8')) as Record<string, unknown>;
    await rm(metaFile);
    await writeFile(metaFile, JSON.stringify({ ...meta, job_id: mcpJob.id }), { mode: 0o600 });
    for (const id of [orphan, overMcp]) {
      const v = keep(await ui.record.view(PROJECT, id));
      expect(v.started_by).not.toBe('ui');
      expect(v.can).toEqual({ annotate: false, save: false, discard: false, stop: false });
      expect(v.problem).toMatch(/origin cannot be verified/);
      const e = await refusal(ui.record.save(PROJECT, id, { name: `forged-${id.slice(-4).toLowerCase()}`, rev: v.rev, draft: v.draft_sha256 ?? 'a'.repeat(64) }));
      expect(e.code).toBe('refused');
      expect((await refusal(ui.record.annotate(PROJECT, id, { rev: v.rev, change: { op: 'insert', at: 'end', insert: { kind: 'mark' } } }))).code).toBe('refused');
      expect((await refusal(ui.record.discard(PROJECT, id))).code).toBe('refused');
      expect((await ui.record.list(PROJECT, { limit: 50 })).find((x) => x.rec_id === id)?.studio).toBe(false);
      expect(existsSync(await recDir(id))).toBe(true);
    }
    expect((await readdir(join(p.dir, 'scenarios'))).filter((f) => f.startsWith('forged-'))).toEqual([]);
  });

  it('A-L3: reads never follow a link — a records folder (or .retake) that is one: no draft, no list item, the reason said', async () => {
    const ws = await openWorkspace({ root });
    for (const which of ['records', '.retake'] as const) {
      const slug = which === 'records' ? 'linky-read' : 'linky-read-2';
      const dir = join(root, 'projects', slug);
      const outside = join(root, `outside-${slug}`);
      const id = newRecordId();
      const recs = which === 'records' ? join(outside, id) : join(outside, 'records', id);
      await mkdir(recs, { recursive: true });
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'project.yaml'), 'name: Linky\nenvironments:\n  local:\n    pages: {app: "http://localhost:1/"}\n');
      const lines = (await readFile(join(await recDir(lab.rec), 'events.jsonl'), 'utf8'));
      await writeFile(join(recs, 'events.jsonl'), lines);
      await writeFile(join(recs, 'meta.json'), JSON.stringify({ v: 1, rec_id: id, job_id: null, submitted_by: 'cli', name: 'x', env: 'local', persona: null, access: 'read-write', page: 'app', path: '/', started_at: new Date().toISOString(), max_ms: null, owner: { pid: 1 } }));
      if (which === 'records') {
        await mkdir(join(dir, '.retake'), { recursive: true });
        await symlink(outside, join(dir, '.retake', 'records'));
      } else await symlink(outside, join(dir, '.retake'));
      await openProject(ws, slug);
      const v = keep(await ui.record.view(slug, id));
      expect(v.untrusted, which).toBeNull();
      expect(v.problem, which).toMatch(/symbolic link/);
      expect(v.counts.events).toBe(0);
      expect(await ui.record.list(slug, { limit: 50 }), which).toEqual([]);
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('after the reviews (the screen)', () => {
  it('B-M3: the zoom under the project theme\'s max_zoom — the default saved draws no validation warning; above it refused', async () => {
    const id = await interruptedCopy(lab.rec, 'studio-zoom');
    const v = keep(await ui.record.view(PROJECT, id));
    expect(v.zoom).toEqual({ max: 1.4, options: [1.25, 1.4], default: 1.4 });
    const e = await refusal(ui.record.annotate(PROJECT, id, { rev: 0, change: { op: 'insert', at: 'end', insert: { kind: 'camera', zoom: 1.5, until: 'scene_end' } } }));
    expect(e.code).toBe('invalid');
    expect(e.message).toMatch(/max_zoom/);
    const a = keep(await ui.record.annotate(PROJECT, id, { rev: 0, change: { op: 'insert', at: { after_step_seq: 1 }, insert: { kind: 'camera', zoom: v.zoom!.default, until: 'scene_end' } } }));
    expect(a.view.untrusted!.yaml).toContain('zoom: 1.4');
    keep(await saveShown(id, 'studio-zoom', a.view));
    const p = await project();
    const checked = await ui.scenarios.validate(PROJECT, await readFile(join(p.dir, 'scenarios', 'studio-zoom.yaml'), 'utf8'));
    expect(checked.issues.filter((i) => /max_zoom|clamp/.test(i.message))).toEqual([]);
  });

  it('B-M4: the check\'s failing step is shown on its row — an insert before it moves it; a step that is gone is not on screen', async () => {
    const id = await cloneRecording(lab.rec);
    await rm(join(await recDir(id), 'studio.json'));
    const rj = join(await recDir(id), 'record.json');
    const record = JSON.parse(await readFile(rj, 'utf8')) as Record<string, unknown>;
    const v0 = keep(await ui.record.view(PROJECT, id));
    const scene = v0.untrusted!.sources[0].scene;
    await writeFile(rj, JSON.stringify({ ...record, check: { status: 'failed', scope: 'all', steps_passed: 1, steps_total: 4, failed_at: { scene, step: 1, action: 'click' } } }), { mode: 0o600 });
    const v1 = keep(await ui.record.view(PROJECT, id));
    expect(v1.untrusted!.check).toMatchObject({ failed_at: { scene, step: 1 }, failed_row: { scene, step: 1 } });
    // A hold before every step: the failing step is one row further down on screen.
    const before = v1.untrusted!.sources.length;
    const a = keep(await ui.record.annotate(PROJECT, id, { rev: v1.rev, change: { op: 'insert', at: { after_step_seq: -1 }, insert: { kind: 'hold', seconds: 1 } } }));
    expect(a.view.untrusted!.sources).toHaveLength(before + 1);
    expect(a.view.untrusted!.check).toMatchObject({ failed_at: { scene, step: 1 }, failed_row: { scene, step: 2 } });
  });

  it('B-L2: a Discard marked during the check whose job is over is settled by the recent list (no view needed)', async () => {
    const id = await cloneRecording(lab.rec);
    const sj = join(await recDir(id), 'studio.json');
    const ann = JSON.parse(await readFile(sj, 'utf8')) as Record<string, unknown>;
    await rm(sj);
    await writeFile(sj, JSON.stringify({ ...ann, discard: { at: new Date().toISOString() } }), { mode: 0o600 });
    expect((await ui.record.list(PROJECT, { limit: 50 })).some((x) => x.rec_id === id)).toBe(false);
    expect(existsSync(await recDir(id))).toBe(false);
  });
});

describe('folders', () => {
  it('prune keeps a folder whose lock is held and an unsaved Studio recording younger than 7 days (B12)', async () => {
    const ws = await openWorkspace({ root });
    const other = join(root, 'projects', 'prune-me');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'project.yaml'), 'name: Prune\nenvironments:\n  local:\n    pages: {app: "http://localhost:1/"}\n');
    const p = await openProject(ws, 'prune-me');
    const meta = (id: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ v: 1, rec_id: id, job_id: null, submitted_by: 'ui', name: 'x', env: 'local', persona: null, access: 'read-write', page: 'app', path: '/', started_at: new Date().toISOString(), max_ms: null, owner: { pid: 1 }, ...extra });
    const [locked, fresh, old, savedOne, cli] = [newRecordId(), newRecordId(), newRecordId(), newRecordId(), newRecordId()];
    for (const id of [locked, fresh, old, savedOne, cli]) await mkdir(join(recordsRoot(p), id), { recursive: true });
    await new Promise((r) => setTimeout(r, 10)); // the newer folders' ids sort after these
    await writeFile(join(recordsRoot(p), fresh, 'meta.json'), meta(fresh));
    await writeFile(join(recordsRoot(p), old, 'meta.json'), meta(old, { started_at: new Date(Date.now() - 8 * 86_400_000).toISOString() }));
    await writeFile(join(recordsRoot(p), savedOne, 'meta.json'), meta(savedOne));
    await writeFile(join(recordsRoot(p), savedOne, 'studio.json'), JSON.stringify({ v: 1, rev: 1, choices: {}, inserts: [], saved: { name: 'x', file: 'scenarios/x.yaml', hash: 'a'.repeat(64), at: new Date().toISOString() } }));
    await writeFile(join(recordsRoot(p), cli, 'meta.json'), meta(cli, { submitted_by: 'cli' }));
    for (let i = 0; i < RECORD_KEEP; i++) await mkdir(join(recordsRoot(p), newRecordId()), { recursive: true });
    const lock = TakeLock.acquire(recordLockFile(p.dir, locked), 'record annotate', 'test');
    try {
      const removed = await pruneRecords(p, RECORD_KEEP);
      expect(removed.sort()).toEqual([old, savedOne, cli].sort());
      expect(existsSync(join(recordsRoot(p), locked))).toBe(true);
      expect(existsSync(join(recordsRoot(p), fresh))).toBe(true);
    } finally {
      lock.releaseSync();
    }
  });

  it('the records folder a symbolic link: Discard removes nothing through it', async () => {
    const ws = await openWorkspace({ root });
    const linky = join(root, 'projects', 'linky');
    await mkdir(join(linky, '.retake'), { recursive: true });
    await writeFile(join(linky, 'project.yaml'), 'name: Linky\nenvironments:\n  local:\n    pages: {app: "http://localhost:1/"}\n');
    const outside = join(root, 'outside-records');
    const id = newRecordId();
    await mkdir(join(outside, id), { recursive: true });
    await writeFile(join(outside, id, 'meta.json'), JSON.stringify({ v: 1, rec_id: id, job_id: null, submitted_by: 'ui', name: 'x', env: 'local', persona: null, access: 'read-write', page: 'app', path: '/', started_at: new Date().toISOString(), max_ms: null, owner: { pid: spawnSync(process.execPath, ['-e', '0']).pid! } }));
    await writeFile(join(outside, id, 'events.jsonl'), '');
    await symlink(outside, join(linky, '.retake', 'records'));
    await openProject(ws, 'linky');
    const e = await refusal(ui.record.discard('linky', id));
    expect(e.code).toBe('refused');
    expect(e.message).toMatch(/symbolic link/);
    expect(e.message).not.toContain(root);
    expect(existsSync(join(outside, id, 'meta.json'))).toBe(true);
    await rm(linky, { recursive: true, force: true });
  });
});

describe('secrets', () => {
  it('the password sentinel is in no job file, recording file, history, worker log, saved scenario or answer', async () => {
    const p = await project();
    // None of the window's session copies stays (the browser's last writes are removed a moment after it closed).
    await until(async () => (await readdir(join(root, '.tmp'))).every((n) => !n.startsWith('retake-session-record-')), 'the session copies removed', 10_000);
    // A-N4: the Retake home (the profile the window ran on) and the temporary folder (the window's session copies) too.
    const scanned = [
      ...(await files(jobsDir(root))),
      ...(await files(recordsRoot(p))),
      ...(await files(join(p.dir, 'scenarios'))),
      historyFile(root),
      ...(await files(join(root, '.home'))),
      ...(await files(join(root, '.tmp'))),
    ];
    expect(scanned.length).toBeGreaterThan(10);
    for (const f of scanned) expect((await readFile(f)).includes(SENTINEL), f).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(SENTINEL);
    expect(answers.length).toBeGreaterThan(15);
    expect(JSON.stringify(answers)).not.toContain(SENTINEL);
    // Answers name no absolute path of the workspace (views, annotations, saves, refusals).
    const views = answers.filter((a): a is RecordView => !!a && typeof a === 'object' && 'state' in a && 'version' in a);
    expect(views.length).toBeGreaterThan(5);
    for (const v of views) expect(JSON.stringify({ ...v, job: v.job ? { ...v.job, error: undefined } : null })).not.toContain(root);
  });
});
