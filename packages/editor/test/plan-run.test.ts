/**
 * L3.2 planRun with trust `mcp` (render/plan-run.ts): gate 1 refuses, before any file is read, what a render through
 * MCP must not read — files outside the project (absolute, `..`, a symbolic link out), a Lottie file an agent can write,
 * the music bed outside (never "not found": no existence oracle), a theme named by folder (unless it is project.yaml's
 * own), a remote slot value; gate 2 refuses a plan that serves a file from outside the project, the run and the theme
 * folders (an extension-less image slot, a theme logo that leaves its folder) or a hard-linked file (review A N4). Trust
 * `author` (the CLI) is unchanged.
 * The run itself (L7.6a): a run named through MCP that is reached through a symbolic link and lies outside the project is
 * refused; a named run is refused in the sentences of core takeWords, in today's order (a missing film after gate 1).
 * No browser: planning only.
 */
import { execFileSync } from 'node:child_process';
import { cp, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@retake/core/io';
import type { LoadedProject, Timeline } from '@retake/core';
import { PlanTrustError, RenderError, planRun, preReadProblems } from '@retake/editor';
import type { PlanRunOptions } from '@retake/editor';
import { synthTimeline } from '@retake/test-support/timeline';
import { TEMPLATES, hasTool } from '@retake/test-support/repo';
import { makeColourCapture, syntheticRunRecord } from '@retake/test-support/render';
import { PERSON_POLICY } from '@retake/core';

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
/** A project of its own (project.yaml `template:`) with one capture run of `t`: its record, its timeline, its film. */
async function project(t: Timeline, template = 'editorial'): Promise<LoadedProject> {
  const slug = `p${++n}`;
  const dir = join(root, 'projects', slug);
  const runDir = join(dir, 'runs', t.run_id);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), `name: P\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ${template}\n`);
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
  await writeFile(join(runDir, 'run.json'), JSON.stringify(syntheticRunRecord(runDir, { id: t.run_id, scenario: t.scenario, project: slug })));
  await cp(capture, join(runDir, 'capture.mp4'));
  return loadProject(slug, root);
}

const mcp = (p: LoadedProject, o: Partial<PlanRunOptions> = {}) => planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', root, trust: 'mcp', ...o });

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
    const a = await planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', root });
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
      await expect(planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', root })).resolves.toBeTruthy();
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
    await expect(planRun({ workPolicy: PERSON_POLICY, project: q, run: 'latest', root })).rejects.toThrow(/music file not found/);
  });

  it('gate 1: a Lottie file is code — never from a folder an agent writes (scenarios/), fine from assets/', () => {
    const p = { dir: join(root, 'lottie'), config: { template: 'editorial' } } as unknown as LoadedProject;
    const withCard = (lottie: string) => timeline({}, (t) => (t.scenes[0].card = { lottie }));
    const bad = preReadProblems(p, withCard('scenarios/anim.json'), undefined, { project: p });
    expect(bad).toEqual([expect.stringMatching(/^scene quote, card \(lottie file\): scenarios\/anim\.json is a file an agent can write .*a Lottie file is code/)]);
    expect(preReadProblems(p, withCard('assets/anim.json'), undefined, { project: p })).toEqual([]);
    // An image there is data: fine.
    expect(
      preReadProblems(
        p,
        timeline({}, (t) => (t.scenes[0].card = { image: 'scenarios/shot.png' })),
        undefined,
        { project: p },
      ),
    ).toEqual([]);
  });

  it("gate 1: a theme is named — a folder only when it is project.yaml's own template", async () => {
    const p = await project(timeline({}, (t) => (t.video!.template = '../../outside')));
    expect((await refusal(mcp(p))).problems[0]).toMatch(/^the run's theme \(the scenario's template:\) is a folder \(\.\.\/\.\.\/outside\)/);
    expect((await refusal(mcp(p, { template: './x' }))).problems[0]).toMatch(/^the theme asked is a folder/);
    const own = await project(
      timeline({}, (t) => (t.video!.template = './template')),
      './template',
    );
    await cp(join(TEMPLATES, 'editorial'), join(own.dir, 'template'), { recursive: true });
    await expect(mcp(own)).resolves.toMatchObject({ template: { dir: join(own.dir, 'template') } });
  });

  it('gate 1: a remote slot value is refused (put the file in assets/)', async () => {
    const p = await project(timeline({ component: 'studio/card-testimonial', slots: { quote: 'Fast.', name: 'A. Buyer', avatar: 'https://example.com/a.png' } }));
    expect((await refusal(mcp(p))).problems).toEqual([expect.stringMatching(/^scene quote, card slot avatar: https:\/\/example\.com\/a\.png is a remote URL/)]);
  });

  it("gate 1 (hotfix v0.2.5): an address a component only shows or encodes is no remote file — a CTA's url and QR code", async () => {
    const p = await project(
      timeline({ component: 'studio/card-cta', slots: { title: 'Open an account', url: 'https://shop.example.test/sign-up', qr: 'https://shop.example.test/sign-up?src=video' } }),
    );
    await expect(mcp(p)).resolves.toMatchObject({ plan: expect.anything() });
    // Without the manifests (no registry), or a card whose component the theme picks: counted as loaded, as before.
    expect(preReadProblems(p, timeline({ component: 'studio/card-cta', slots: { title: 'x', qr: 'https://shop.example.test/q' } }), undefined, { project: p })).toEqual([
      expect.stringMatching(/card slot qr: .* is a remote URL/),
    ]);
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
    expect((await refusal(mcp(p))).problems).toEqual([
      expect.stringMatching(/^the plan serves image-.* from .*assets\/logo\.svg, a file with more than one name \(a hard link\): through MCP a render serves none$/),
    ]);
    // The CLI (trust author) is unchanged.
    expect((await planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', root })).plan.durationInFrames).toBeGreaterThan(0);
  });

  it("gate 2: a theme's logo that leaves its folder (and the project) is refused", async () => {
    const own = await project(
      timeline({}, (t) => (t.video!.template = './template')),
      './template',
    );
    await cp(join(TEMPLATES, 'editorial'), join(own.dir, 'template'), { recursive: true });
    const yaml = join(own.dir, 'template', 'template.yaml');
    await writeFile(yaml, (await readFile(yaml, 'utf8')).replace(/^logo: .*$/m, 'logo: ../../../outside/logo.svg'));
    expect((await refusal(mcp(own))).problems).toEqual([expect.stringMatching(/^the plan serves logo\.svg from .*outside\/logo\.svg/)]);
  });

  const RUN = '20260101-120000-synthetic';
  const message = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'planned',
      (e: unknown) => `${e instanceof PlanTrustError ? 'PlanTrustError' : e instanceof RenderError ? 'RenderError' : (e as Error).name}: ${(e as Error).message}`,
    );

  it('a named run that cannot be planned: one sentence each, the same at a terminal and through MCP (L7.6a, F-4)', async () => {
    const by = (p: LoadedProject, trust: 'author' | 'mcp', o: Partial<PlanRunOptions> = {}) => message(planRun({ workPolicy: PERSON_POLICY, project: p, run: RUN, root, trust, ...o }));
    const both = async (p: LoadedProject, o: Partial<PlanRunOptions> = {}) => {
      const [a, m] = [await by(p, 'author', o), await by(p, 'mcp', o)];
      expect(m).toBe(a);
      return a;
    };
    const p = await project(timeline());
    const dir = join(p.dir, 'runs', RUN);
    expect(await both(p)).toBe('planned');
    expect(await both(p, { scenario: 'other' })).toBe(`RenderError: run ${RUN} is a run of scenario "synthetic", not "other"`);
    // The record's status is not looked at: a run someone names is planned whatever it says.
    await writeFile(join(dir, 'run.json'), JSON.stringify({ ...syntheticRunRecord(dir, { id: RUN }), status: 'running', finished_at: undefined }));
    expect(await both(p)).toBe('planned');
    await rm(join(dir, 'run.json'));
    expect(await both(p)).toBe('planned');
    // F-4: a timeline cut short, or one that is no timeline, is said in a sentence (before: the JSON parser's own message, or a plan of nothing).
    const whole = await readFile(join(dir, 'timeline.json'), 'utf8');
    await writeFile(join(dir, 'timeline.json'), whole.slice(0, 200));
    expect(await both(p)).toBe(`RenderError: run ${RUN}: its timeline does not read (timeline.json is not JSON)`);
    await writeFile(join(dir, 'timeline.json'), JSON.stringify({ mode: 'capture' }));
    expect(await both(p)).toBe(`RenderError: run ${RUN}: its timeline does not read (timeline.json is not a timeline)`);
    await writeFile(join(dir, 'timeline.json'), JSON.stringify({ ...(JSON.parse(whole) as Record<string, unknown>), events: 'none' }));
    expect(await both(p)).toBe(`RenderError: run ${RUN}: its timeline does not read (timeline.json is not a timeline)`);
    await writeFile(join(dir, 'timeline.json'), JSON.stringify({ ...(JSON.parse(whole) as Record<string, unknown>), mode: 'dry' }));
    expect(await both(p)).toBe(`RenderError: run ${RUN} is a dry run: there is no capture to render`);
    await rm(join(dir, 'timeline.json'));
    expect(await both(p)).toBe(`RenderError: run ${RUN} has no timeline.json (${dir})`);
    // The film is the one the run's timeline names; a timeline that names none means capture.mp4.
    await writeFile(join(dir, 'timeline.json'), JSON.stringify({ ...(JSON.parse(whole) as Timeline), capture: { ...(JSON.parse(whole) as Timeline).capture, file: 'film.mp4' } }));
    expect(await both(p)).toBe(`RenderError: run ${RUN} has no capture video (${join(dir, 'film.mp4')})`);
    await rename(join(dir, 'capture.mp4'), join(dir, 'film.mp4'));
    expect((await planRun({ workPolicy: PERSON_POLICY, project: p, run: RUN, root })).captureFile).toBe(join(dir, 'film.mp4'));
    await writeFile(join(dir, 'timeline.json'), JSON.stringify({ ...(JSON.parse(whole) as Timeline), capture: { ...(JSON.parse(whole) as Timeline).capture, file: '' } }));
    expect(await both(p)).toBe(`RenderError: run ${RUN} has no capture video (${join(dir, 'capture.mp4')})`);
  });

  it('a missing film is said after gate 1, as it always was: through MCP the trust refusal comes first', async () => {
    const p = await project(timeline({ component: 'studio/card-testimonial', slots: { quote: 'Fast.', name: 'A. Buyer', logo: '../../outside/logo.svg' } }));
    await rm(join(p.dir, 'runs', RUN, 'capture.mp4'));
    expect((await refusal(mcp(p, { run: RUN }))).problems).toEqual([expect.stringMatching(/^scene quote, card slot logo: .*resolves outside the project folder/)]);
    expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: RUN, root }))).toBe(`RenderError: run ${RUN} has no capture video (${join(p.dir, 'runs', RUN, 'capture.mp4')})`);
  });

  it('the film of a named run is a file of its own folder through MCP: one path segment; at a terminal the name is taken as the timeline gives it (L7.6a)', async () => {
    const p = await project(timeline());
    const dir = join(p.dir, 'runs', RUN);
    const whole = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8')) as Timeline;
    // Another run of the same project, with its own film; and the first run's film removed.
    const other = join(p.dir, 'runs', '20260101-110000-other');
    await mkdir(other, { recursive: true });
    await rename(join(dir, 'capture.mp4'), join(other, 'capture.mp4'));
    const named = async (file: string, trust: 'author' | 'mcp') => {
      await writeFile(join(dir, 'timeline.json'), JSON.stringify({ ...whole, capture: { ...whole.capture, file } }));
      return message(planRun({ workPolicy: PERSON_POLICY, project: p, run: RUN, root, trust }));
    };
    const NOT_IN_FOLDER = `PlanTrustError: refused through MCP:\n- run ${RUN}: the film its timeline names is not a file of the run folder: through MCP a render reads only the film inside it`;
    const none = (file: string) => `RenderError: run ${RUN} has no capture video (${dir}/${file})`;
    // [the timeline's capture.file, at a terminal (unchanged), through MCP]. Before L7.6a's close the two columns were
    // the same: through MCP the film of ANOTHER run of the project was planned, and so were `..` and `.`.
    const rows: Array<[string, string, string]> = [
      ['../20260101-110000-other/capture.mp4', 'planned', NOT_IN_FOLDER],
      ['..\\20260101-110000-other\\capture.mp4', none('..\\20260101-110000-other\\capture.mp4'), NOT_IN_FOLDER],
      ['..', 'planned', NOT_IN_FOLDER],
      ['.', 'planned', NOT_IN_FOLDER],
      ['sub/film.mp4', none('sub/film.mp4'), NOT_IN_FOLDER],
      // No word on whether the file is there: the refusal is the same for a film that exists and one that does not.
      ['../missing/capture.mp4', none('../missing/capture.mp4'), NOT_IN_FOLDER],
      ['/capture.mp4', none('/capture.mp4'), NOT_IN_FOLDER],
    ];
    for (const [file, terminal, throughMcp] of rows) expect([file, await named(file, 'author'), await named(file, 'mcp')], file).toEqual([file, terminal, throughMcp]);
    // The refusal comes before the scenario is compared and before the trust gates read anything.
    await writeFile(join(dir, 'timeline.json'), JSON.stringify({ ...whole, capture: { ...whole.capture, file: '../20260101-110000-other/capture.mp4' } }));
    expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: RUN, root, trust: 'mcp', scenario: 'other' }))).toBe(NOT_IN_FOLDER);
    // One path segment of the folder is the film, whatever its name; the refusal names no file (the name is the timeline's text).
    await rename(join(other, 'capture.mp4'), join(dir, 'the film.mp4'));
    expect([await named('the film.mp4', 'author'), await named('the film.mp4', 'mcp')]).toEqual(['planned', 'planned']);
    expect(NOT_IN_FOLDER).not.toContain('other');
  });

  it('a run folder that is a link out of the project: never `latest`; named, refused through MCP and planned at a terminal (L7.6a D-7)', async () => {
    const p = await project(timeline());
    const real = join(outside, `run-${n}`);
    await rename(join(p.dir, 'runs', RUN), real);
    await symlink(real, join(p.dir, 'runs', RUN));
    const LINKED = `PlanTrustError: refused through MCP:\n- run ${RUN} is a link to a folder outside the project: through MCP a render reads only the runs inside it`;
    expect(await message(mcp(p, { run: RUN }))).toBe(LINKED);
    expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: RUN, root }))).toBe('planned');
    for (const trust of ['author', 'mcp'] as const) {
      expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', root, trust }))).toMatch(/^RenderError: no capture run in .*`retake run p\d+ <scenario>`$/);
    }
    // A link to a folder of the same project is a run of the project: planned through MCP too.
    const q = await project(timeline());
    await rename(join(q.dir, 'runs', RUN), join(q.dir, 'kept'));
    await symlink(join(q.dir, 'kept'), join(q.dir, 'runs', RUN));
    expect(await message(mcp(q, { run: RUN }))).toBe('planned');
  });

  it('runs/ itself a link to another disk: the terminal works, by name and for `latest`; through MCP neither a named run nor `latest` reads a run outside the project (L7.6a, small point 3.2)', async () => {
    const p = await project(timeline());
    const real = join(outside, `runs-${n}`);
    await rename(join(p.dir, 'runs'), real);
    await symlink(real, join(p.dir, 'runs'));
    expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: RUN, root }))).toBe('planned');
    expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', root }))).toBe('planned');
    // Through MCP `latest` takes no run that lies outside the project either (before L7.6a's close: 'planned', while
    // naming that very run was refused): it is passed over and counted, in the rule's fixed words.
    expect(await message(mcp(p))).toMatch(/^RenderError: no capture run in .*`retake run p\d+ <scenario>` — 1 capture of it cannot be edited: it lies outside the project \(1\)$/);
    expect(await message(mcp(p, { scenario: 'synthetic' }))).toMatch(
      /^RenderError: no capture run of scenario "synthetic" in .* — 1 capture of it cannot be edited: it lies outside the project \(1\)$/,
    );
    // Named: refused in its own words — the folder is no link itself, a folder above it is.
    expect(await message(mcp(p, { run: RUN }))).toBe(
      `PlanTrustError: refused through MCP:\n- run ${RUN} lies outside the project (its folder, or a folder above it, is a link): through MCP a render reads only the runs inside it`,
    );
  });

  it('a timeline made by hand — no run id in it, no film named — still plans when its run is named, at a terminal and through MCP; `latest` wants a complete one', async () => {
    for (const drop of ['run_id', 'capture.file'] as const) {
      const p = await project(timeline());
      const dir = join(p.dir, 'runs', RUN);
      const whole = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8')) as Record<string, unknown> & { capture: Record<string, unknown> };
      if (drop === 'run_id') delete whole.run_id;
      else delete whole.capture.file;
      await writeFile(join(dir, 'timeline.json'), JSON.stringify(whole));
      // By its name: planned, with the film a capture has always had.
      const planned = await planRun({ workPolicy: PERSON_POLICY, project: p, run: RUN, root });
      expect([drop, planned.run.id, planned.captureFile]).toEqual([drop, RUN, join(dir, 'capture.mp4')]);
      expect(await message(mcp(p, { run: RUN })), drop).toBe('planned');
      expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: dir, root })), drop).toBe('planned');
      // As `latest`: not a take (a head no runner wrote), and said.
      expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', root })), drop).toMatch(/ — 1 capture of it cannot be edited: its timeline does not read \(1\)$/);
    }
  });

  it("the files of a named run through MCP are its folder's own: a run.json, a timeline.json or a film that is a link is refused; at a terminal it plans", async () => {
    const LINKS = `PlanTrustError: refused through MCP:\n- run ${RUN}: its files are links: through MCP a render reads only the files of the run folder itself`;
    for (const file of ['run.json', 'timeline.json', 'capture.mp4']) {
      const p = await project(timeline());
      const dir = join(p.dir, 'runs', RUN);
      // The file moved to another folder of the same project, and linked back: inside the project all along.
      await mkdir(join(p.dir, 'kept'), { recursive: true });
      await rename(join(dir, file), join(p.dir, 'kept', file));
      await symlink(join(p.dir, 'kept', file), join(dir, file));
      expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: RUN, root })), file).toBe('planned');
      expect(await message(mcp(p, { run: RUN })), file).toBe(LINKS);
      // And such a run is never `latest`, for a person or an agent.
      for (const trust of ['author', 'mcp'] as const)
        expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', root, trust })), `${file} ${trust}`).toMatch(/^RenderError: no capture run in /);
    }
  });

  it('nothing to edit, said through MCP: no folder name of a run that was not picked, and the argument of the tool where a terminal names its option', async () => {
    // The only capture was written by a newer Retake: a terminal names it; through MCP the sentence names no run.
    const p = await project(timeline());
    const dir = join(p.dir, 'runs', RUN);
    await writeFile(join(dir, 'run.json'), JSON.stringify({ ...syntheticRunRecord(dir, { id: RUN, scenario: 'synthetic', project: p.slug }), version: 2 }));
    const NEWER = 'this run.json is version 2: it was made for a newer Retake (this one reads version 1) — update Retake';
    expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', scenario: 'synthetic', root }))).toBe(`RenderError: run ${RUN}: ${NEWER}`);
    const said = await message(mcp(p, { scenario: 'synthetic' }));
    expect(said).toBe(`RenderError: the newest capture of scenario "synthetic": ${NEWER}`);
    expect(said).not.toContain(RUN);
    // A folder without its run.json: how to name one, in the words of who asked.
    await rm(join(dir, 'run.json'));
    expect(await message(planRun({ workPolicy: PERSON_POLICY, project: p, run: 'latest', root }))).toMatch(
      / — 1 run folder without a readable run\.json was not considered \(name one with `--run <id>`\)$/,
    );
    const through = await message(mcp(p));
    expect(through).toMatch(/ — 1 run folder without a readable run\.json was not considered \(name one with `run_id`\)$/);
    expect(through).not.toContain(RUN);
  });
});
