import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EditPlan } from '@demo-studio/editor';
import { EXIT, main, memoryIo } from '../src/index.js';

const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../editor/test/fixtures', import.meta.url));

let ws: string;
let runs: string;

async function studio(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'studio', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-plan-'));
  await writeFile(join(ws, 'studio.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  const project = join(ws, 'projects', 'demo');
  runs = join(project, 'runs');
  await mkdir(runs, { recursive: true });
  await writeFile(join(project, 'project.yaml'), 'name: Demo\nenvironments:\n  local: {shop: "http://localhost:4402"}\ntemplate: editorial\n');
  // Two real runs (catalogue older, quote newer) and a dry run of the quote, newest of all.
  for (const [id, name] of [
    ['20261011-182524-catalogue', 'catalogue'],
    ['20261011-182706-quote', 'quote'],
  ]) {
    await mkdir(join(runs, id));
    await copyFile(join(FIXTURES, `${name}.timeline.json`), join(runs, id, 'timeline.json'));
  }
  await mkdir(join(runs, '20261011-190000-quote'));
  const dry = JSON.parse(await readFile(join(FIXTURES, 'quote.timeline.json'), 'utf8')) as { mode: string };
  dry.mode = 'dry';
  await writeFile(join(runs, '20261011-190000-quote', 'timeline.json'), JSON.stringify(dry));
  // A run folder without a timeline (failed early) is skipped by "latest".
  await mkdir(join(runs, '20261011-200000-catalogue'));
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('studio plan', () => {
  it('prints a summary of the plan of a run (segments, components, speeds, captions, warnings)', async () => {
    const r = await studio('plan', 'demo', '20261011-182524-catalogue');
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.out).toMatch(/^catalogue \(run 20261011-182524-catalogue\) — landscape 1920×1080 @ 30 fps — \d+\.\d\d s/);
    expect(r.out).toMatch(/intro\s+intro\s+—\s+studio\/intro-stack \(theme\)/);
    expect(r.out).toMatch(/availability\s+clip\s+crossfade 0\.37 s\s+studio\/layout-card/);
    expect(r.out).toContain('speed 1× 3.60 s, 1.6× 15.74 s');
    expect(r.out).toContain('zoom 1.3× step 5');
    expect(r.out).toContain('Captions (3)');
    expect(r.out).toContain('"import": page load');
    // The built-in library resolves every component of the theme.
    expect(r.out).not.toContain('MISSING');
    expect(r.out).toContain('Warnings (0)');
    // A component that does not exist: one warning per problem, listing its uses; the renderer draws a stand-in.
    const missing = await studio('plan', 'demo', '20261011-182524-catalogue', '--frame', 'acme/nope');
    expect(missing.code, missing.err).toBe(EXIT.ok);
    expect(missing.out).toMatch(/component "acme\/nope" not found/);
  });

  it('"latest" picks the newest capture run (of --scenario): dry runs and runs without a timeline are skipped', async () => {
    const latest = await studio('plan', 'demo', 'latest', '--scenario', 'catalogue', '--json');
    expect(latest.code, latest.err).toBe(EXIT.ok);
    expect((JSON.parse(latest.out) as EditPlan).meta.run_id).toBe('20261011-182524-catalogue');
    const newest = await studio('plan', 'demo', 'latest', '--json');
    expect((JSON.parse(newest.out) as EditPlan).meta.run_id).toBe('20261011-182706-quote');
    const dry = await studio('plan', 'demo', '20261011-190000-quote');
    expect(dry.code).toBe(EXIT.failure);
    expect(dry.err).toContain('is a dry run');
    const quote = await studio('plan', 'demo', '20261011-182706-quote', '--json');
    const plan = JSON.parse(quote.out) as EditPlan;
    expect(plan.segments.map((s) => s.id)).toEqual(['intro', 'discover', 'chapter-request', 'request', 'interstitial-3', 'proposal', 'outro']);
    expect(plan.source.file).toBe(join(runs, '20261011-182706-quote', 'capture.mp4'));
  });

  it('honours --theme, --frame, --vertical and writes the plan with --out', async () => {
    const out = join(ws, 'plan.json');
    const r = await studio('plan', 'demo', '20261011-182706-quote', '--theme', 'motion', '--frame', 'raw', '--vertical', '--out', out);
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toContain('plan written to');
    const plan = JSON.parse(await readFile(out, 'utf8')) as EditPlan;
    expect([plan.variant, plan.width, plan.height, plan.frame, plan.meta.theme]).toEqual(['vertical', 1080, 1920, 'raw', 'motion']);
    expect(plan.segments.find((s) => s.id === 'discover')?.transition?.kind).toBe('fade-black');
    expect(r.out).toContain('theme motion — frame raw');
  });

  it('reports unknown runs, scenario mismatches and bad frames', async () => {
    const missing = await studio('plan', 'demo', 'nope');
    expect(missing.code).toBe(EXIT.failure);
    expect(missing.err).toContain('run "nope" not found');
    const mismatch = await studio('plan', 'demo', '20261011-182706-quote', '--scenario', 'catalogue');
    expect(mismatch.code).toBe(EXIT.failure);
    expect(mismatch.err).toContain('is a run of scenario "quote", not "catalogue"');
    const frame = await studio('plan', 'demo', 'latest', '--frame', 'Fancy Frame');
    expect(frame.code).toBe(EXIT.usage);
    expect(frame.err).toContain('--frame "Fancy Frame"');
    const none = await studio('plan', 'demo', 'latest', '--scenario', 'ghost');
    expect(none.err).toContain('no capture run of scenario "ghost"');
  });

  it('refuses a run whose run.json a newer Demo Studio wrote; a run.json without version is read (R-PRIN-13)', async () => {
    const dir = join(runs, '20261011-182524-catalogue');
    try {
      await writeFile(join(dir, 'run.json'), JSON.stringify({ id: '20261011-182524-catalogue', env: 'local', status: 'succeeded' }));
      expect((await studio('plan', 'demo', '20261011-182524-catalogue', '--json')).code).toBe(EXIT.ok);
      await writeFile(join(dir, 'run.json'), JSON.stringify({ version: 2, id: '20261011-182524-catalogue', env: 'local' }));
      const newer = await studio('plan', 'demo', '20261011-182524-catalogue');
      expect(newer.code).toBe(EXIT.failure);
      expect(newer.err).toContain(
        'run 20261011-182524-catalogue: this run.json is version 2: it was made for a newer Demo Studio (this one reads version 1) — update Demo Studio',
      );
    } finally {
      await rm(join(dir, 'run.json'), { force: true });
    }
  });

  it('warns when the scenario file changed since the run was captured: the plan is the run\'s (L3.8; stderr, --json too)', async () => {
    const run = '20261011-182706-quote';
    const snapshot = 'video: quote\nscenes:\n  - id: a\n    page: shop\n    open: /\n    steps:\n      - hold: 1\n';
    const file = join(ws, 'projects', 'demo', 'scenarios', 'quote.yaml');
    const warning = `scenario quote changed since run ${run} was captured: a render shows the run as captured — a change to the scenario (steps, captions, timing, title, intro/outro, template) shows only in a new capture: \`studio run demo quote\`, then render`;
    await writeFile(join(runs, run, 'scenario.yaml'), snapshot);
    await mkdir(join(ws, 'projects', 'demo', 'scenarios'), { recursive: true });
    try {
      await writeFile(file, snapshot);
      const same = await studio('plan', 'demo', run);
      expect(same.code, same.err).toBe(EXIT.ok);
      expect(same.err).not.toContain('changed since');
      await writeFile(file, snapshot.replace('hold: 1', 'hold: 3'));
      const changed = await studio('plan', 'demo', run);
      expect(changed.code, changed.err).toBe(EXIT.ok);
      expect(changed.err).toContain(`! ${warning}`);
      const json = await studio('plan', 'demo', 'latest', '--scenario', 'quote', '--json');
      expect(json.err).toContain(warning);
      expect((JSON.parse(json.out) as EditPlan).meta.run_id).toBe(run);
    } finally {
      await rm(file, { force: true });
      await rm(join(runs, run, 'scenario.yaml'), { force: true });
    }
  });
});
