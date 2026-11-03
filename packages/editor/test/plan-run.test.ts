/**
 * L3.2 planRun with trust `mcp` (render/plan-run.ts): gate 1 refuses, before any file is read, what a render through
 * MCP must not read — files outside the project (absolute, `..`, a symbolic link out), a Lottie file an agent can write,
 * the music bed outside (never "not found": no existence oracle), a theme named by folder (unless it is project.yaml's
 * own), a remote slot value; gate 2 refuses a plan that serves a file from outside the project, the run and the theme
 * folders (an extension-less image slot, a theme logo that leaves its folder) or a hard-linked file (review A N4). Trust
 * `author` (the CLI) is unchanged.
 * No browser: planning only.
 */
import { execFileSync } from 'node:child_process';
import { cp, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@retake/core';
import type { LoadedProject, Timeline } from '@retake/core';
import { PlanTrustError, planRun, preReadProblems } from '@retake/editor';
import type { PlanRunOptions } from '@retake/editor';
import { synthTimeline } from './helpers.js';
import { TEMPLATES, hasTool, makeColourCapture } from './render-helpers.js';

const canPlan = hasTool('ffmpeg');
let root: string;
let outside: string;
let capture: string;

/** A timeline: a card (component + slots, optional media fields), scene a, scene b; `patch` edits it. */
function timeline(card: { component?: string; slots?: Record<string, string> } = {}, patch: (t: Timeline) => void = () => undefined): Timeline {
  const t = synthTimeline({
    duration: 4,
    entries: [
      { card: { id: 'quote', component: card.component ?? 'studio/card-title', slots: card.slots ?? { title: 'A card' } } },
      { id: 'a', t_start: 1.0, t_end: 2.0, caption: { text: 'Every frame has its own colour.' } },
      { id: 'b', t_start: 3.0, t_end: 4.0, open_end: 3.1 },
    ],
    video: { title: { text: 'Synthetic' }, intro: false, outro: false, frame: 'card', template: 'editorial' },
  });
  t.run_id = '20260101-120000-synthetic';
  t.scenario = 'synthetic';
  patch(t);
  return t;
}

let n = 0;
/** A project of its own (project.yaml `template:`) with one capture run of `t`. */
async function project(t: Timeline, template = 'editorial'): Promise<LoadedProject> {
  const slug = `p${++n}`;
  const dir = join(root, 'projects', slug);
  const runDir = join(dir, 'runs', t.run_id);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), `name: P\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ${template}\n`);
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
  await cp(capture, join(runDir, 'capture.mp4'));
  return loadProject(slug, root);
}

const mcp = (p: LoadedProject, o: Partial<PlanRunOptions> = {}) => planRun({ project: p, run: 'latest', root, trust: 'mcp', ...o });

async function refusal(p: Promise<unknown>): Promise<PlanTrustError> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(PlanTrustError);
  return e as PlanTrustError;
}

beforeAll(async () => {
  if (!canPlan) return;
  root = await mkdtemp(join(tmpdir(), 'studio-plan-run-'));
  outside = join(root, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  await writeFile(join(outside, 'secret.csv'), 'month,count\nJan,1\n');
  await writeFile(join(outside, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  await writeFile(join(outside, 'logo'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  await writeFile(join(outside, 'music.mp3'), 'not audio');
  capture = join(root, 'capture.mp4');
  makeColourCapture(capture, 4);
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!canPlan)('planRun, trust mcp', () => {
  it('a plan of project files plans as with trust author', async () => {
    const p = await project(timeline({ component: 'studio/card-testimonial', slots: { quote: 'Fast.', name: 'A. Buyer', logo: 'assets/logo.svg' } }));
    await writeFile(join(p.dir, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const a = await planRun({ project: p, run: 'latest', root });
    const m = await mcp(p);
    expect(m.plan).toEqual(a.plan);
  });

  it('gate 1: an image slot outside the project (absolute, "..", a symbolic link out) is refused, positioned', async () => {
    for (const logo of [join(outside, 'logo.svg'), '../../outside/logo.svg', 'assets/link/logo.svg']) {
      const p = await project(timeline({ component: 'studio/card-testimonial', slots: { quote: 'Fast.', name: 'A. Buyer', logo } }));
      await symlink(outside, join(p.dir, 'assets', 'link'));
      const e = await refusal(mcp(p));
      expect(e.problems).toEqual([expect.stringMatching(/^scene quote, card slot logo: .*(absolute path|resolves outside the project folder)/)]);
      // The CLI's trust is unchanged: a human may name any file.
      await expect(planRun({ project: p, run: 'latest', root })).resolves.toBeTruthy();
    }
  });

  it('gate 1: a CSV outside the project is refused before it is read (a FIFO would block a read)', async () => {
    const fifo = join(outside, 'pipe.csv');
    execFileSync('mkfifo', [fifo]);
    const p = await project(timeline({ component: 'studio/card-chart', slots: { title: 'Rows', data: fifo } }));
    const e = await refusal(mcp(p));
    expect(e.problems[0]).toMatch(/^scene quote, card slot data: .*pipe\.csv is an absolute path/);
    expect(e.message).not.toContain('Jan');
  });

  it('gate 1: the music bed outside the project is refused whether or not the file exists (no existence oracle)', async () => {
    const msgs: string[] = [];
    for (const file of [join(outside, 'music.mp3'), join(outside, 'missing.mp3')]) {
      const p = await project(timeline({}, (t) => (t.video!.music = { file })));
      const e = await refusal(mcp(p));
      expect(e.message).not.toContain('not found');
      msgs.push(e.problems.join('\n').replace(file, '<file>'));
    }
    expect(msgs[0]).toBe(msgs[1]);
    expect(msgs[0]).toContain('the music bed (music.file)');
    // Overrides are checked too.
    const p = await project(timeline());
    expect((await refusal(mcp(p, { overrides: { music: '../../outside/music.mp3' } }))).problems[0]).toContain('the music of the overrides');
    // And trust author still says what is missing (a human's own machine).
    const q = await project(timeline({}, (t) => (t.video!.music = { file: join(outside, 'missing.mp3') })));
    await expect(planRun({ project: q, run: 'latest', root })).rejects.toThrow(/music file not found/);
  });

  it('gate 1: a Lottie file is code — never from a folder an agent writes (scenarios/), fine from assets/', () => {
    const p = { dir: join(root, 'lottie'), config: { template: 'editorial' } } as unknown as LoadedProject;
    const withCard = (lottie: string) => timeline({}, (t) => (t.scenes[0].card = { lottie }));
    const bad = preReadProblems(p, withCard('scenarios/anim.json'), undefined, { project: p });
    expect(bad).toEqual([expect.stringMatching(/^scene quote, card \(lottie file\): scenarios\/anim\.json is a file an agent can write .*a Lottie file is code/)]);
    expect(preReadProblems(p, withCard('assets/anim.json'), undefined, { project: p })).toEqual([]);
    // An image there is data: fine.
    expect(preReadProblems(p, timeline({}, (t) => (t.scenes[0].card = { image: 'scenarios/shot.png' })), undefined, { project: p })).toEqual([]);
  });

  it("gate 1: a theme is named — a folder only when it is project.yaml's own template", async () => {
    const p = await project(timeline({}, (t) => (t.video!.template = '../../outside')));
    expect((await refusal(mcp(p))).problems[0]).toMatch(/^the run's theme \(the scenario's template:\) is a folder \(\.\.\/\.\.\/outside\)/);
    expect((await refusal(mcp(p, { template: './x' }))).problems[0]).toMatch(/^the theme asked is a folder/);
    const own = await project(timeline({}, (t) => (t.video!.template = './template')), './template');
    await cp(join(TEMPLATES, 'editorial'), join(own.dir, 'template'), { recursive: true });
    await expect(mcp(own)).resolves.toMatchObject({ template: { dir: join(own.dir, 'template') } });
  });

  it('gate 1: a remote slot value is refused (put the file in assets/)', async () => {
    const p = await project(timeline({ component: 'studio/card-testimonial', slots: { quote: 'Fast.', name: 'A. Buyer', avatar: 'https://example.com/a.png' } }));
    expect((await refusal(mcp(p))).problems).toEqual([expect.stringMatching(/^scene quote, card slot avatar: https:\/\/example\.com\/a\.png is a remote URL/)]);
  });

  it('gate 2: an image slot without an extension, outside, is caught where the plan serves it', async () => {
    const p = await project(timeline({ component: 'studio/card-testimonial', slots: { quote: 'Fast.', name: 'A. Buyer', logo: '../../outside/logo' } }));
    expect(preReadProblems(p, timeline({ component: 'studio/card-testimonial', slots: { logo: '../../outside/logo' } }), undefined, { project: p })).toEqual([]);
    expect((await refusal(mcp(p))).problems).toEqual([expect.stringMatching(/^the plan serves image-.* from .*outside\/logo, outside the project, the run and the theme folders/)]);
  });

  it('gate 2 (review A N4): a hard link in the project — the same file as one outside — is never served', async () => {
    const p = await project(timeline({ component: 'studio/card-testimonial', slots: { quote: 'Fast.', name: 'A. Buyer', logo: 'assets/logo.svg' } }));
    await link(join(outside, 'logo.svg'), join(p.dir, 'assets', 'logo.svg'));
    // Every check on paths passes (inside assets/, no symbolic link): only its link count tells.
    expect(preReadProblems(p, timeline({ component: 'studio/card-testimonial', slots: { logo: 'assets/logo.svg' } }), undefined, { project: p })).toEqual([]);
    expect((await refusal(mcp(p))).problems).toEqual([expect.stringMatching(/^the plan serves image-.* from .*assets\/logo\.svg, a file with more than one name \(a hard link\): through MCP a render serves none$/)]);
    // The CLI (trust author) is unchanged.
    expect((await planRun({ project: p, run: 'latest', root })).plan.durationInFrames).toBeGreaterThan(0);
  });

  it("gate 2: a theme's logo that leaves its folder (and the project) is refused", async () => {
    const own = await project(timeline({}, (t) => (t.video!.template = './template')), './template');
    await cp(join(TEMPLATES, 'editorial'), join(own.dir, 'template'), { recursive: true });
    const yaml = join(own.dir, 'template', 'template.yaml');
    await writeFile(yaml, (await readFile(yaml, 'utf8')).replace(/^logo: .*$/m, 'logo: ../../../outside/logo.svg'));
    expect((await refusal(mcp(own))).problems).toEqual([expect.stringMatching(/^the plan serves logo\.svg from .*outside\/logo\.svg/)]);
  });
});
