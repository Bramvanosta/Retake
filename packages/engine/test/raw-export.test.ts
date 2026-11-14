/**
 * L7.22 (U8a, U8e): the CLI's plan and raw export as the engine's use-case functions.
 *
 * - The capture port's raw export (`raw.timeline`, the export's gate): one contract on both adapters (the runner
 *   package and the in-memory runner) — a run that reads gives its timeline, a dry run and a folder without a timeline
 *   are refused in the export's own words as EngineErrors, a missing film is not the gate's. The package itself on the
 *   runner package needs ffmpeg and a film: the CLI's export-capture.test.ts makes one for real through this port.
 * - `rawExportWork` on the in-memory runner: the gate before the theme, the options handed to the port (the run's
 *   theme, the settings, the edit's files made absolute, the ffmpeg, the signal, the progress), the note when the run's
 *   theme does not load.
 * - `planOfRun`: the run found and told (`onRun`) before anything of it is read, a plan's words (`plan`), a run without
 *   its film plans while a render's plan refuses it, the summary's lines.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedProject } from '@retake/core';
import { EngineError, openWorkspace, planOfRun, planWork, rawExportWork, runnerWebCapture, diskWorkspaceReads } from '../src/index.js';
import type { CaptureRaw, OpenedWorkspace, RunRef } from '../src/index.js';
import { MemoryCaptureRunner } from '../src/capture/memory-capture.js';
import { openProjectBySlug } from '../src/projects.js';
import { syntheticRunRecord } from '@retake/test-support/render';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURES = join(REPO, 'packages', 'editor', 'test', 'fixtures');
const RUN = '20260101-120000-signup';
const DRY = '20260101-130000-signup';
const BARE = '20260101-140000-signup';
const FILMLESS = '20260101-150000-signup';
const OTHER_THEME = '20260101-160000-signup';
/** A capture whose edit names a project file (a card's image, relative to the project). */
const CARDED = '20260101-115000-signup';
/** A dry run whose theme does not load: the gate refuses it before the theme is looked for. */
const DRY_OTHER_THEME = '20260101-170000-signup';

let root = '';
let ws: OpenedWorkspace;
let project: LoadedProject;
const runDir = (id: string) => join(project.dir, 'runs', id);

async function runFolder(id: string, o: { timeline?: (t: Record<string, unknown>) => Record<string, unknown>; film?: boolean } = {}): Promise<void> {
  const dir = runDir(id);
  await mkdir(dir, { recursive: true });
  if (o.timeline) {
    const t = JSON.parse(await readFile(join(FIXTURES, 'signup.timeline.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(dir, 'timeline.json'), JSON.stringify(o.timeline({ ...t, run_id: id, project: 'film' })));
  }
  await writeFile(join(dir, 'run.json'), JSON.stringify(syntheticRunRecord(dir, { id, scenario: 'signup', project: 'film' })));
  if (o.film !== false) await writeFile(join(dir, 'capture.mp4'), 'never read');
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-l722-'));
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  const dir = join(root, 'projects', 'film');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'name: Film\nenvironments:\n  local: {shop: "http://shop.example.test", console: "http://console.example.test"}\ntemplate: editorial\n');
  ws = await openWorkspace({ root, agent: false, reads: diskWorkspaceReads });
  project = await openProjectBySlug(ws, 'film');
  await runFolder(RUN, { timeline: (t) => t });
  await runFolder(DRY, { timeline: (t) => ({ ...t, mode: 'dry' }) });
  await runFolder(BARE);
  await runFolder(FILMLESS, { timeline: (t) => t, film: false });
  await runFolder(CARDED, {
    timeline: (t) => ({
      ...t,
      scenes: (t.scenes as Array<Record<string, unknown>>).map((sc, i) =>
        i === 0 ? { ...sc, card: { component: 'studio/card-figure', slots: { image: 'assets/figure.png', title: 'A figure' } } } : sc,
      ),
    }),
  });
  await writeFile(join(dir, 'assets', 'figure.png'), 'not read');
  await runFolder(DRY_OTHER_THEME, { timeline: (t) => ({ ...t, mode: 'dry', video: { ...((t.video as object | undefined) ?? {}), template: 'no-such-theme' } }) });
  await runFolder(OTHER_THEME, { timeline: (t) => ({ ...t, video: { ...((t.video as object | undefined) ?? {}), template: 'no-such-theme' } }) });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The refusal `work` throws (an EngineError: the port's own refusals). */
async function refusal(work: Promise<unknown>): Promise<EngineError> {
  const e = await work.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

/** The gate's contract, one adapter's `raw` made new for each case. */
function gateContract(raw: () => CaptureRaw): void {
  it("gives the timeline of a run that reads, also of one without its film (the film is not the gate's)", async () => {
    expect((await raw().timeline(runDir(RUN))).run_id).toBe(RUN);
    expect((await raw().timeline(runDir(FILMLESS))).run_id).toBe(FILMLESS);
  });

  it("refuses a dry run and a folder without a timeline in the export's words, as EngineErrors", async () => {
    const dry = await refusal(raw().timeline(runDir(DRY)));
    expect([dry.code, dry.message]).toEqual(['invalid', `run ${DRY} is a dry run: it has no capture to export`]);
    const bare = await refusal(raw().timeline(runDir(BARE)));
    expect([bare.code, bare.message]).toEqual(['invalid', `${runDir(BARE)} has no timeline.json (not a run, or the run did not finish)`]);
  });
}

describe("the capture port's raw export gate (runner package)", () => gateContract(() => runnerWebCapture().raw));
describe("the capture port's raw export gate (memory)", () => gateContract(() => new MemoryCaptureRunner().raw));

describe('rawExportWork (in memory)', () => {
  it("hands the port the run's theme, the settings, the edit's files, the ffmpeg, the signal and the progress", async () => {
    const capture = new MemoryCaptureRunner();
    const progress: string[] = [];
    const notes: string[] = [];
    const ac = new AbortController();
    const out = join(root, 'exports-a');
    const r = await rawExportWork({
      capture,
      ws: { policy: ws.policy, ffmpeg: '/opt/ffmpeg', reads: ws.reads },
      project,
      runDir: runDir(RUN),
      settings: { format: 'prores', fps: 60, cuts: false, out },
      signal: ac.signal,
      onNote: (n) => notes.push(n),
      onProgress: (p) => progress.push(p.stage),
    });
    expect(r.dir).toBe(out);
    expect(r.manifest.settings).toMatchObject({ format: 'prores', fps: 60, cuts: false });
    expect(notes).toEqual([]);
    expect(progress.at(-1)).toBe('done');
    expect(capture.calls.map((c) => c.member)).toEqual(['raw.timeline', 'raw.export']);
    const asked = capture.calls.flatMap((c) => (c.member === 'raw.export' ? [c.options] : []))[0]!;
    expect(Object.keys(asked).sort()).toEqual(['cuts', 'editFiles', 'ffmpeg', 'format', 'fps', 'onProgress', 'out', 'policy', 'project', 'runDir', 'signal', 'template']);
    expect([asked.template?.name, asked.ffmpeg, asked.signal, asked.runDir]).toEqual(['editorial', '/opt/ffmpeg', ac.signal, runDir(RUN)]);
    expect(asked.editFiles!.every((f) => f.startsWith('/'))).toBe(true);
  });

  it('lists the files the edit names, relative ones made absolute in the project', async () => {
    const capture = new MemoryCaptureRunner();
    const r = await rawExportWork({ capture, ws, project, runDir: runDir(CARDED), settings: { out: join(root, 'exports-c') } });
    expect(r.manifest.edit_files).toContain(join(project.dir, 'assets', 'figure.png'));
    expect(r.manifest.edit_files.every((f) => f.startsWith('/'))).toBe(true);
  });

  it("says a note when the run's theme does not load, and exports with the default look (no template handed)", async () => {
    const capture = new MemoryCaptureRunner();
    const notes: string[] = [];
    const r = await rawExportWork({ capture, ws, project, runDir: runDir(OTHER_THEME), settings: { out: join(root, 'exports-b') }, onNote: (n) => notes.push(n) });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^the run's template could not be loaded \(.*no-such-theme.*\): the cursor layer uses the default look$/);
    const asked = capture.calls.flatMap((c) => (c.member === 'raw.export' ? [c.options] : []))[0]!;
    expect('template' in asked).toBe(false);
    expect(r.manifest.warnings).toEqual(['the cursor layer uses the default look']);
  });

  it('refuses at the gate before the theme is looked for or anything is exported', async () => {
    const capture = new MemoryCaptureRunner();
    const notes: string[] = [];
    const e = await refusal(rawExportWork({ capture, ws, project, runDir: runDir(DRY_OTHER_THEME), settings: {}, onNote: (n) => notes.push(n) }));
    expect(e.message).toBe(`run ${DRY_OTHER_THEME} is a dry run: it has no capture to export`);
    expect(capture.calls.map((c) => c.member)).toEqual(['raw.timeline']);
    expect(notes).toEqual([]);
  });
});

describe('planOfRun', () => {
  it("tells the run it found before reading it, and plans it as `retake plan` does (the summary's lines too)", async () => {
    const order: string[] = [];
    const p = await planOfRun(ws, project, RUN, { scenario: 'signup', overrides: { frame: 'raw' }, trust: 'author', onRun: (run: RunRef) => order.push(`found ${run.id}`) });
    expect(order).toEqual([`found ${RUN}`]);
    expect([p.run.id, p.plan.frame, p.edit.from]).toEqual([RUN, 'raw', 'run']);
    expect(p.summary[0]).toContain(`(run ${RUN})`);
    // A refusal comes after the run was told.
    const told: string[] = [];
    await expect(planOfRun(ws, project, DRY, { trust: 'author', onRun: (run) => told.push(run.id) })).rejects.toThrow(`run ${DRY} is a dry run: there is no capture to plan`);
    expect(told).toEqual([DRY]);
  });

  it('says plan in its refusals, and plans a run without its film (a render of it is refused)', async () => {
    await expect(planOfRun(ws, project, BARE, { trust: 'author' })).rejects.toThrow(`run ${BARE} has no timeline.json (${runDir(BARE)})`);
    const p = await planOfRun(ws, project, FILMLESS, { trust: 'author' });
    expect(p.plan.meta.run_id).toBe(FILMLESS);
    await expect(planWork({ workPolicy: ws.policy, project, run: FILMLESS, root: ws.root, measureMusic: false })).rejects.toThrow(
      `run ${FILMLESS} has no capture video (${runDir(FILMLESS)}/capture.mp4)`,
    );
  });

  it("takes a theme by name in place of the run's, named in the overrides", async () => {
    const p = await planOfRun(ws, project, RUN, { theme: 'motion', trust: 'author' });
    expect([p.template.name, p.overrides.theme, p.plan.meta.theme]).toEqual(['motion', 'motion', 'motion']);
  });
});
