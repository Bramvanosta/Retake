/**
 * The acceptance of R-SHR-05: a project folder copied ALONE into a fresh workspace B — another place, as on another
 * Mac — renders its copied run, and reviews and exports its copied render, at a terminal (`retake`, spawned from the
 * sources) and through MCP (`retake mcp` over stdio, its worker): every file read and written is B's. Workspace A is
 * made unreadable right after the copy (restored at the end): a reader that still reached into A would fail or say a
 * file is missing — so the review's notes are checked too (no `capture-missing`, no `timeline-missing`), and the copied
 * record's `run_id` names no folder of B: only its `run_dir` finds the run. A starter theme (A and B have no theme of
 * their own; the theme folder is the install's, neither A nor B). A's run is an older one, all absolute (0.3.0's
 * shape): read in B, rebased. Needs ffmpeg and a headless shell.
 */
import { execFile } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readWorkerLock } from '@retake/engine/testing';
import { REPO, hasTool } from '@retake/test-support/repo';
import { RUN_ID, linkSharedCache, makeColourCapture, syntheticRunRecord, syntheticTimeline } from '@retake/test-support/render';
import { testChildEnv } from '@retake/test-support/child-env';

const run = promisify(execFile);
const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const can = hasTool('ffmpeg') && hasTool('ffprobe');
const LONG = 600_000;

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

let scratch: string;
let a: string;
let b: string;
let client: Client | undefined;
let unreadable = false;
const projectB = () => join(b, 'projects', 'demo');

/** `retake --root <root> …` as a person types it (the sources, through tsx): its exit code and its output. */
async function retake(root: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const r = await run(process.execPath, ['--conditions=source', '--import', 'tsx', BIN, '--root', root, ...args], {
      cwd: REPO,
      env: testChildEnv({ RETAKE_HOME: join(scratch, 'home'), RETAKE_WORKER_IDLE_MS: '1500' }),
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof x.code === 'number' ? x.code : 1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
}

function killWorker(root: string): void {
  const w = readWorkerLock(root);
  if (!w) return;
  try {
    process.kill(w.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client!.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as Result;
}

beforeAll(async () => {
  if (!can) return;
  // Its real path (macOS: /private/var/…, not /var/…), so that what a command prints compares as text.
  scratch = realpathSync(await mkdtemp(join(tmpdir(), 'retake-project-copy-acc-')));
  a = join(scratch, 'a');
  b = join(scratch, 'b');
  for (const root of [a, b]) {
    mkdirSync(root, { recursive: true });
    // No theme folder of their own: the project's theme is a starter (the install's).
    writeFileSync(join(root, 'retake.yaml'), 'projects_dir: projects\n');
    await linkSharedCache(root);
  }
  const dir = join(a, 'projects', 'demo');
  const runDir = join(dir, 'runs', RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(dir, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  writeFileSync(join(runDir, 'timeline.json'), JSON.stringify(syntheticTimeline(), null, 2));
  // An older run, as 0.3.0 wrote it: every path absolute (A's).
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(syntheticRunRecord(runDir), null, 2)}\n`);
  makeColourCapture(join(runDir, 'capture.mp4'));
  // The render made in A, at a terminal.
  const made = await retake(a, 'render', 'demo', 'synthetic', '--scale', '0.25');
  if (made.code !== 0) throw new Error(`render in A: ${made.err}`);
  killWorker(a);
  // The project folder alone, into B. Its record's run_id is made to name no folder: only run_dir finds the run.
  cpSync(dir, projectB(), { recursive: true });
  const recordFile = join(projectB(), 'renders', 'synthetic-v1.json');
  const record = JSON.parse(readFileSync(recordFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(recordFile, `${JSON.stringify({ ...record, run_id: '20260101-000000-gone' }, null, 2)}\n`);
  chmodSync(a, 0o000);
  unreadable = true;
}, LONG);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  if (b) killWorker(b);
  if (unreadable) chmodSync(a, 0o755);
  if (scratch) await rm(scratch, { recursive: true, force: true });
}, 60_000);

/** Every absolute path a text names lies in B (none in A). */
function inB(text: string): void {
  expect(text).not.toContain(a);
  expect(text).toContain(b);
}

describe.skipIf(!can)('a project folder copied alone into another workspace (R-SHR-05)', () => {
  it(
    'the copied record names its files relative to renders/: nothing of A in it',
    () => {
      const text = readFileSync(join(projectB(), 'renders', 'synthetic-v1.json'), 'utf8');
      const disk = JSON.parse(text) as { version: number; file: string; record: string; run_dir: string; plan: { source: { file: string } } };
      expect([disk.version, disk.file, disk.record, disk.run_dir, disk.plan.source.file]).toEqual([2, 'synthetic-v1.mp4', 'synthetic-v1.json', `../runs/${RUN_ID}`, `../runs/${RUN_ID}/capture.mp4`]);
      expect(text).not.toContain(a);
    },
    LONG,
  );

  it(
    'at a terminal in B: the copied run renders, the copied render is reviewed (its capture and timeline found, through run_dir) and exported — every file B’s',
    async () => {
      const render = await retake(b, 'render', 'demo', 'synthetic', '--scale', '0.25', '--json');
      expect(render.code, render.err).toBe(0);
      const rec = JSON.parse(render.out) as { id: string; file: string; run_dir: string };
      expect(rec.id).toBe('synthetic-v2');
      expect([rec.file, rec.run_dir]).toEqual([join(projectB(), 'renders', 'synthetic-v2.mp4'), join(projectB(), 'runs', RUN_ID)]);
      expect(existsSync(rec.file)).toBe(true);
      expect(readFileSync(join(projectB(), 'renders', 'synthetic-v2.json'), 'utf8')).not.toContain(scratch);

      const review = await retake(b, 'review', 'demo', 'synthetic-v1', '--no-previous', '--json');
      expect(review.code, review.err).toBe(0);
      const result = JSON.parse(review.out) as { files: { dir: string }; findings: Array<{ code: string }>; render: { file: string } };
      expect(result.files.dir).toBe(join(projectB(), 'review', 'synthetic-v1'));
      expect(result.render.file).toBe(join(projectB(), 'renders', 'synthetic-v1.mp4'));
      const codes = result.findings.map((f) => f.code);
      for (const missing of ['capture-missing', 'capture-unreadable', 'timeline-missing', 'frames-missing']) expect(codes, review.out.slice(0, 2000)).not.toContain(missing);
      inB(review.out);
      // report.json on the disk: relative to its folder.
      const report = JSON.parse(readFileSync(join(projectB(), 'review', 'synthetic-v1', 'report.json'), 'utf8')) as { files: { dir: string }; render: { file: string } };
      expect([report.files.dir, report.render.file]).toEqual(['.', '../../renders/synthetic-v1.mp4']);

      const exported = await retake(b, 'export', 'demo', 'synthetic-v1', '--formats', 'mp4_1080p');
      expect(exported.code, exported.err).toBe(0);
      expect(readdirSync(join(projectB(), 'exports', 'synthetic-v1')).some((f) => f.endsWith('.mp4'))).toBe(true);
      inB(exported.out + exported.err);
      killWorker(b);
    },
    LONG,
  );

  it(
    'through MCP in B: the copied render is reviewed and exported, and the copied run renders — refused nowhere, every file B’s',
    async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--conditions=source', '--import', 'tsx', BIN, '--root', b, 'mcp'],
        cwd: REPO,
        env: testChildEnv({ RETAKE_HOME: join(scratch, 'home'), RETAKE_WORKER_IDLE_MS: '1500' }),
        stderr: 'pipe',
      });
      client = new Client({ name: 'retake-test', version: '0' }, { capabilities: {} });
      await client.connect(transport);

      let r = await call('review', { project: 'demo', render_id: 'synthetic-v1', previous: false, wait_s: 25 });
      expect(r.isError, JSON.stringify(r).slice(0, 2000)).toBeFalsy();
      for (let i = 0; i < 10 && !(r.structuredContent?.finished as boolean); i++) r = await call('review_get', { project: 'demo', render_id: 'synthetic-v1', wait_s: 25, images: 'none' });
      expect(r.structuredContent).toMatchObject({ status: 'succeeded', finished: true, dir: join(projectB(), 'review', 'synthetic-v1') });
      const findings = (r.structuredContent as { findings: Array<{ code: string }> }).findings.map((f) => f.code);
      for (const missing of ['capture-missing', 'capture-unreadable', 'timeline-missing']) expect(findings).not.toContain(missing);
      inB(JSON.stringify(r.structuredContent));

      let e = await call('export', { project: 'demo', render_id: 'synthetic-v1', formats: ['gif_preview'], wait_s: 25 });
      expect(e.isError, JSON.stringify(e).slice(0, 2000)).toBeFalsy();
      const jobId = (e.structuredContent as { job: { id: string } }).job.id;
      for (let i = 0; i < 10 && !/: succeeded/.test(e.content[0]!.text); i++) e = await call('job_status', { job_id: jobId, wait_s: 25 });
      expect(e.content[0]!.text).toMatch(/export synthetic-v1 → gif_preview in demo: succeeded · 1 file/);
      expect(readdirSync(join(projectB(), 'exports', 'synthetic-v1')).some((f) => f.endsWith('.gif'))).toBe(true);

      let s = await call('render', { project: 'demo', scenario: 'synthetic', overrides: { scale: 0.5 } });
      expect(s.isError, JSON.stringify(s).slice(0, 2000)).toBeFalsy();
      const id = (s.structuredContent as { render_id: string }).render_id;
      for (let i = 0; i < 12 && !(s.structuredContent?.finished as boolean); i++) s = await call('render_status', { project: 'demo', render_id: id, wait_s: 25 });
      const st = s.structuredContent as { status: string; file: string };
      expect(st.status, s.content[0]!.text).toBe('succeeded');
      expect(st.file).toBe(join(projectB(), 'renders', `${id}.mp4`));
      expect(readFileSync(join(projectB(), 'renders', `${id}.json`), 'utf8')).not.toContain(scratch);
    },
    LONG,
  );
});
