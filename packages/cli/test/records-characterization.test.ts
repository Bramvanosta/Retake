/**
 * The run `latest` names at a terminal (L7.6a) — `retake plan`, as render, still and export-capture: one rule, the
 * editor's findRun — state by state, with what the command says of it on stderr (the newer captures passed over, a
 * capture stopped by `--until`), and the plan command's own refusals. The states are those of
 * core/test/fixtures/records/states.json (OLD: a good capture of `quote`; NEW: the state named), one project per state
 * in a temp workspace.
 *
 * A row marked `D-<n>` is an outcome a decision of the lot changed; `F-<n>` one a fix made on the way changed; `U-1`
 * the row of a capture stopped by `--until` (the marks: core/test/fixtures/records/README.md). The comment says what the
 * row answered before.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@retake/core/io';
import { EXIT, main, memoryIo } from '../src/index.js';
import { findRunOf } from '@retake/engine';
import { latestNotice } from '../src/commands/render.js';
import { STATES, buildState, stateIds, writeRunFolder, writeWorkspace } from '../../core/test/fixtures/records/build.js';
import type { BuiltState } from '../../core/test/fixtures/records/build.js';
import { buildRenderState, renderStateIds } from '../../core/test/fixtures/records/build-renders.js';
import type { BuiltRenders } from '../../core/test/fixtures/records/build-renders.js';
import { makeCase, scenesTimeline, workspace } from '../../review/test/helpers.js';

let root: string;
const built = new Map<string, BuiltState>();
const state = (id: string, old: 'good' | 'none' = 'good'): BuiltState => {
  const key = `${id}/${old}`;
  if (!built.has(key)) built.set(key, buildState(root, id, { old, slug: `s-${id.toLowerCase()}${old === 'none' ? '-none' : ''}` }));
  return built.get(key)!;
};
const who = (b: BuiltState, id: string): string => (id === b.old ? 'OLD' : id === b.new ? 'NEW' : id);
const named = (b: BuiltState, text: string): string => text.replaceAll(root, '<root>').replaceAll(b.new, 'NEW').replaceAll(b.old, 'OLD');
/** The run `latest` names, then each line the commands print on stderr about it (OLD and NEW for the two run ids). */
async function latest(b: BuiltState, of: string | null = STATES.scenario): Promise<string> {
  const p = await loadProject(b.slug, root);
  const scenario = of ?? undefined;
  try {
    const run = await findRunOf(p, 'latest', scenario);
    return [who(b, run.id), ...latestNotice(run, scenario !== undefined ? { scenario } : {}).map((l) => named(b, l))].join(' | ');
  } catch (e) {
    return `${(e as Error).name}: ${named(b, (e as Error).message)}`;
  }
}
async function retake(...args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', root, '--no-color', ...args], io);
  return { code, err: io.stderr().replaceAll(root, '<root>').trim(), out: io.stdout() };
}
const NONE = (slug: string) => `RenderError: no capture run of scenario "quote" in <root>/projects/${slug}/runs: capture one with \`retake run ${slug} quote\``;
/** The line about the newer captures passed over, as render and still say it. */
const PASSED = (why: string) => `OLD | run OLD is used: 1 newer capture of "quote" passed over — NEW (${why}) (name one with --run <id>)`;
/** A record that says `running` or `queued` does not say whether its process still is: both are said. */
const UNFINISHED = 'not finished, or interrupted';
/** The line about newer run folders whose run.json is missing or is no record: counted, never named. */
const UNREAD = 'OLD | run OLD is used: 1 newer run folder without a run.json that reads as a record was not considered (name one with --run <id>)';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'retake-records-cli-'));
  writeWorkspace(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * Per state: the run `latest` of `quote` names, and the lines said of it. The comment says what the row was before the
 * lot (the plan command then had its own rule: any folder whose name ends in -quote with a capture timeline).
 */
const LATEST: Record<string, string> = {
  ctl: 'NEW',
  a: PASSED(UNFINISHED), // D-2: OLD before too, without a word (a newer capture queued or still filming is said)
  b: PASSED(UNFINISHED), // D-2: as a
  c: PASSED('failed'), // D-1, D-2: was NEW (the failed take was planned)
  d: PASSED('failed'), // D-1: was NEW
  e: PASSED('cancelled'), // D-1: was NEW
  f: 'OLD', // a newer dry run is no capture: nothing is said
  g: PASSED('its film is missing'), // D-1: was NEW
  gn: PASSED('its timeline is missing'), // D-2: OLD before too, without a word
  gf: PASSED('its film is missing'), // D-1: was NEW
  h: 'NEW',
  i: 'NEW', // D-8: did not move
  j: UNREAD, // D-3: was NEW (a run.json cut short: the folder is not taken, never named — and counted, so the change is said)
  k: UNREAD, // D-3: was NEW
  l: PASSED('its timeline does not read'), // D-2: OLD before too, without a word
  o: PASSED('written by a newer Retake'), // D-6: was NEW (then the command refused it)
  of: PASSED('written by a newer Retake'), // D-6: was NEW
  p: 'OLD', // D-5: was NEW (its name says quote, its record another scenario)
  p2: 'OLD', // D-5: was NEW
  r: PASSED('its status is not one Retake writes'), // D-1: was NEW
  s: UNREAD, // D-3: was NEW
  m: 'OLD', // D-4: was NEW (a folder named to sort above the dates)
  m2: 'OLD', // D-4: was NEW
  q: 'NEW', // D-5: was OLD (its record says quote)
  t5: 'NEW',
  t6: 'NEW | run NEW stops at step catalog.1 (`--until`): the capture holds the scenario up to there', // U-1: NEW, and now said
  t7: PASSED(UNFINISHED), // D-1: was NEW (its record still says running: its process is gone, and naming it works)
  t9: PASSED('its files are links'), // D-7 (small point 3.1): was NEW
  hr: PASSED('its timeline does not read'), // a timeline made by hand (no run id): was NEW; named, it plans as before (below)
  hf: PASSED('its timeline does not read'), // the same, its capture block naming no film
  v: 'NEW', // D-8: a record of a later version of the same format
  k1: 'OLD', // D-7: was NEW (a linked run folder)
  k1f: 'OLD', // D-7: was NEW
  k2: 'OLD', // F-1: was "no capture run" (a dangling link in runs/)
  k3: 'OLD',
  z: 'NEW',
};

describe('the run `latest` names at a terminal, state by state', () => {
  it('every state of the table', async () => {
    expect(Object.keys(LATEST).sort()).toEqual(stateIds().sort());
    const got: Record<string, string> = {};
    for (const id of Object.keys(LATEST)) got[id] = await latest(state(id));
    expect(got).toEqual(LATEST);
  });

  it('the column reads the folders it answers about: OLD gone changes the answer', async () => {
    expect(await latest(state('a'))).toBe(PASSED(UNFINISHED));
    expect(await latest(state('a', 'none'))).toBe(`${NONE('s-a-none')} — 1 capture of it cannot be edited: not finished, or interrupted (1)`);
    expect(await latest(state('m', 'none'))).toBe('NEW');
    // D-5: was "no capture run" (its record says quote).
    expect(await latest(state('q', 'none'))).toBe('NEW');
    // Nothing usable: the sentence, then what was passed over as counts and fixed words (never a folder's name).
    expect(await latest(state('c', 'none'))).toBe(`${NONE('s-c-none')} — 1 capture of it cannot be edited: failed (1)`);
    expect(await latest(state('k', 'none'))).toBe(`${NONE('s-k-none')} — 1 run folder without a readable run.json was not considered (name one with \`--run <id>\`)`);
    // A newer dry run of any format is no capture: alone it is "no capture run", never "update Retake"; above OLD nothing is said.
    const dry = buildState(root, 'f', { slug: 'n-newer-dry' });
    writeFileSync(join(dry.newDir, 'run.json'), JSON.stringify({ ...(JSON.parse(readFileSync(join(dry.newDir, 'run.json'), 'utf8')) as object), version: 2 }));
    expect(await latest(dry)).toBe('OLD');
    rmSync(join(dry.runs, dry.old), { recursive: true });
    expect(await latest(dry)).toBe(NONE('n-newer-dry'));
    // D-6: only captures of a newer Retake — the "update Retake" sentence, not "no capture run".
    expect(await latest(state('o', 'none'))).toBe('RenderError: run NEW: this run.json is version 2: it was made for a newer Retake (this one reads version 1) — update Retake');
  });

  it('without a scenario: the newest usable capture of any scenario, and the line names none', async () => {
    expect(await latest(state('ctl'), null)).toBe('NEW');
    expect(await latest(state('c'), null)).toBe('OLD | run OLD is used: 1 newer capture passed over — NEW (failed) (name one with --run <id>)');
    // A good capture of another scenario is the latest of the project.
    expect(await latest(state('p'), null)).toBe('NEW');
  });

  it('more than five newer captures passed over: five are named, newest first, the rest counted', async () => {
    const b = buildState(root, 'k3', { slug: 'n-many' });
    const ids: string[] = [];
    for (let n = 0; n < 8; n++) {
      const id = `202611${String(n + 1).padStart(2, '0')}-100000-quote`;
      ids.push(id);
      writeRunFolder(join(b.runs, id), id, b.slug, STATES.states[n % 2 ? 'c' : 'e']);
    }
    expect(await latest(b)).toBe(
      `OLD | run OLD is used: 8 newer captures of "quote" passed over — ${ids[7]} (failed); ${ids[6]} (cancelled); ${ids[5]} (failed); ${ids[4]} (cancelled); ${ids[3]} (failed); and 3 more (name one with --run <id>)`,
    );
  });

  it('how to name one instead is always said: a take whose record still says running may be one whose process is gone', async () => {
    const b = buildState(root, 'a', { slug: 'n-mixed' });
    const failed = '20261003-100000-quote';
    writeRunFolder(join(b.runs, failed), failed, b.slug, STATES.states.c);
    expect(await latest(b)).toBe(`OLD | run OLD is used: 2 newer captures of "quote" passed over — ${failed} (failed); NEW (not finished, or interrupted) (name one with --run <id>)`);
    expect(await latest(state('a'))).toBe('OLD | run OLD is used: 1 newer capture of "quote" passed over — NEW (not finished, or interrupted) (name one with --run <id>)');
    // T-7: the record says running, the process died at the very end — naming the run works, as the line says.
    expect(await latest(state('t7'))).toBe(PASSED(UNFINISHED));
    const named = await retake('plan', 's-t7', STATES.new, '--json');
    expect([named.code, named.err]).toEqual([EXIT.ok, '']);
  });

  it('newer run folders without a run.json that reads as a record: counted in the line, beside the captures passed over, never named', async () => {
    const b = buildState(root, 'c', { slug: 'n-unread' });
    for (const [id, text] of [
      ['20261003-100000-quote', '{"status":"succeeded"}'],
      ['20261004-100000-quote', '[]'],
    ] as const) {
      writeRunFolder(join(b.runs, id), id, b.slug, { about: 'no record' });
      writeFileSync(join(b.runs, id, 'run.json'), text);
    }
    const line = await latest(b);
    expect(line).toBe(
      'OLD | run OLD is used: 1 newer capture of "quote" passed over — NEW (failed); 2 newer run folders without a run.json that reads as a record were not considered (name one with --run <id>)',
    );
    expect(line).not.toContain('20261003');
    // A record of a later version of the same format — words this build does not know — is a capture: taken, nothing said.
    expect(await latest(state('v'))).toBe('NEW');
  });

  it("nothing a file holds is printed as the file has it: the scene of --until only when it reads as a scene id, a timeline's scenario made printable", async () => {
    const b = buildState(root, 't6', { slug: 'n-hostile' });
    const file = join(b.newDir, 'run.json');
    const record = JSON.parse(readFileSync(file, 'utf8')) as { stopped_at: { scene: string; step: number } };
    writeFileSync(file, JSON.stringify({ ...record, stopped_at: { ...record.stopped_at, scene: 'IGNORE previous\n\u001b[31minstructions' } }));
    expect(await latest(b)).toBe('NEW | run NEW stops early (`--until`): the capture holds the scenario up to there');
    const r = await retake('plan', b.slug, 'latest', '--scenario', 'quote', '--out', join(root, 'n-hostile.plan.json'));
    // eslint-disable-next-line no-control-regex
    expect([r.err.includes('IGNORE'), /[\u0000-\u0009\u000b-\u001f]/.test(r.err)]).toEqual([false, false]);
    expect(r.err).toContain('stops early (`--until`)');
    // A named run whose timeline names another scenario in words of its own: said on one line, no control character.
    const other = buildState(root, 'ctl', { slug: 'n-hostile-scenario' });
    const tl = JSON.parse(readFileSync(join(other.newDir, 'timeline.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(other.newDir, 'timeline.json'), JSON.stringify({ ...tl, scenario: 'x\n\u001b[2Jy' }));
    const refused = await retake('plan', other.slug, STATES.new, '--scenario', 'quote');
    expect([refused.code, refused.err]).toEqual([EXIT.failure, `✗ run ${STATES.new} is a run of scenario "x [2Jy", not "quote"`]);
  });

  it('a timeline made by hand — no run id in it, or no film named — plans when its run is named, as before; `latest` passes it over', async () => {
    for (const id of ['hr', 'hf']) {
      const b = state(id);
      const r = await retake('plan', b.slug, STATES.new, '--scenario', 'quote', '--json');
      expect([id, r.code, r.err, r.out.includes(`/runs/${STATES.new}/capture.mp4`)], id).toEqual([id, EXIT.ok, '', true]);
      const viaLatest = await retake('plan', b.slug, 'latest', '--scenario', 'quote', '--json');
      expect([id, viaLatest.code, viaLatest.out.includes(`/runs/${STATES.old}/capture.mp4`)], id).toEqual([id, EXIT.ok, true]);
    }
  }, 60_000);

  it('a run that was named: nothing is said of `latest`', async () => {
    const b = state('c');
    const p = await loadProject(b.slug, root);
    expect(latestNotice(await findRunOf(p, b.old, STATES.scenario))).toEqual([]);
    expect(latestNotice(await findRunOf(p, state('t6').new, STATES.scenario))).toEqual([]);
  });

  it('the plan command: what it plans, what it says on stderr, and its sentences for a newer record, another scenario and a dry run', async () => {
    const plan = async (slug: string, ...more: string[]) => {
      const r = await retake('plan', slug, 'latest', '--scenario', 'quote', '--json', ...more);
      return {
        code: r.code,
        err: r.err.replaceAll(STATES.new, 'NEW').replaceAll(STATES.old, 'OLD'),
        plans: r.out.includes(`/runs/${STATES.new}/capture.mp4`) ? 'NEW' : r.out.includes(`/runs/${STATES.old}/capture.mp4`) ? 'OLD' : '-',
      };
    };
    const said = async (slug: string) => {
      const r = await retake('plan', slug, 'latest', '--scenario', 'quote', '--out', join(root, `${slug}.plan.json`));
      return r.err
        .replaceAll(STATES.new, 'NEW')
        .replaceAll(STATES.old, 'OLD')
        .split('\n')
        .filter((l) => l.includes('is used') || l.includes('stops at'));
    };
    const LINE = (why: string) => `! run OLD is used: 1 newer capture of "quote" passed over — NEW (${why}) (name one in place of "latest")`;
    // The control plans NEW and says nothing.
    expect(await plan('s-ctl')).toEqual({ code: EXIT.ok, err: '', plans: 'NEW' });
    expect(await said('s-ctl')).toEqual([]);
    // D-1, D-2: after a failed take the plan is OLD's, and stderr says what was passed over — not with --json.
    expect(await plan('s-c')).toEqual({ code: EXIT.ok, err: '', plans: 'OLD' });
    expect(await said('s-c')).toEqual([LINE('failed')]);
    // A newer capture still running — or interrupted: the record cannot say which —: said too, with the way to name one.
    expect(await said('s-a')).toEqual([LINE('not finished, or interrupted')]);
    // D-6: was a refusal of the whole command (the newer record's sentence).
    expect(await plan('s-o')).toEqual({ code: EXIT.ok, err: '', plans: 'OLD' });
    expect(await said('s-o')).toEqual([LINE('written by a newer Retake')]);
    // D-5: was the refusal "run NEW is a run of scenario "other", not "quote"".
    expect(await plan('s-p')).toEqual({ code: EXIT.ok, err: '', plans: 'OLD' });
    expect(await said('s-p')).toEqual([]);
    // A newer dry run: nothing is said.
    expect(await said('s-f')).toEqual([]);
    // U-1: a capture stopped by --until is planned, and said.
    expect(await plan('s-t6')).toEqual({ code: EXIT.ok, err: '', plans: 'NEW' });
    expect(await said('s-t6')).toEqual(['! run NEW stops at step catalog.1 (`--until`): the capture holds the scenario up to there']);
    // Nothing to plan: the editor's sentence (it names the scenario in the command; the plan command's own said <scenario>).
    state('f', 'none');
    expect(await retake('plan', 's-f-none', 'latest', '--scenario', 'quote')).toMatchObject({
      code: EXIT.failure,
      err: '✗ no capture run of scenario "quote" in <root>/projects/s-f-none/runs: capture one with `retake run s-f-none quote`',
    });
    // A run that is named: the named run's sentences, as before.
    expect(await retake('plan', 's-o', STATES.new)).toMatchObject({
      code: EXIT.failure,
      err: `✗ run ${STATES.new}: this run.json is version 2: it was made for a newer Retake (this one reads version 1) — update Retake`,
    });
    expect(await retake('plan', 's-p', STATES.new, '--scenario', 'quote')).toMatchObject({ code: EXIT.failure, err: `✗ run ${STATES.new} is a run of scenario "other", not "quote"` });
    expect(await retake('plan', 's-f', STATES.new)).toMatchObject({ code: EXIT.failure, err: `✗ run ${STATES.new} is a dry run: there is no capture to plan` });
    // F-4: a timeline cut short was a JSON parser's message.
    expect(await retake('plan', 's-l', STATES.new)).toMatchObject({ code: EXIT.failure, err: `✗ run ${STATES.new}: its timeline does not read (timeline.json is not JSON)` });
    expect(await retake('plan', 's-gn', STATES.new)).toMatchObject({ code: EXIT.failure, err: `✗ run ${STATES.new} has no timeline.json (<root>/projects/s-gn/runs/${STATES.new})` });
    // Named, a run works whatever its record says, and a plan reads no film: failed, still running, without its film.
    for (const slug of ['s-c', 's-t7', 's-g', 's-k']) {
      const r = await retake('plan', slug, STATES.new, '--json');
      expect([slug, r.code, r.err, r.out.includes(`/runs/${STATES.new}/capture.mp4`)], slug).toEqual([slug, EXIT.ok, '', true]);
    }
  }, 120_000);

  it('export-capture latest says the same of the run it picked, before it exports', async () => {
    // (The fixture's film is not a video: the export itself fails further on; the line comes first.)
    const r = await retake('export-capture', 's-c', 'latest', '--scenario', 'quote', '--out', join(root, 'raw-c'));
    expect(r.err.replaceAll(STATES.new, 'NEW').replaceAll(STATES.old, 'OLD').split('\n')[0]).toBe(
      '! run OLD is used: 1 newer capture of "quote" passed over — NEW (failed) (name one in place of "latest")',
    );
    const json = await retake('export-capture', 's-c', 'latest', '--scenario', 'quote', '--json', '--out', join(root, 'raw-c-json'));
    expect(json.err).not.toContain('is used');
    // A run the package refuses is refused in the package's words, before the theme is looked for.
    writeFileSync(join(root, 'projects', 's-l', 'project.yaml'), 'name: P\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: no-such-theme\n');
    expect(await retake('export-capture', 's-l', STATES.new)).toMatchObject({ code: EXIT.failure, err: `✗ run ${STATES.new}: its timeline does not read (timeline.json is not JSON)` });
    expect(await retake('export-capture', 's-f', STATES.new)).toMatchObject({ code: EXIT.failure, err: `✗ run ${STATES.new} is a dry run: it has no capture to export` });
  }, 120_000);
});

// ── The render records at a terminal (L7.6b), state by state ────────────────
//
// `retake review` and `retake export` with `latest` and with the file's name, and `retake prune`, on the states of
// core/test/fixtures/records/render-states.json. Each cell holds the exit code, the notes the command says first
// (`! …`: what `latest` passed over, a record renamed by hand) and its first other line of stderr (a stack is cut;
// sizes and times are not compared). The cells were written before the lot (its P0) and flipped by its parts on
// purpose: a cell that changed is marked `moved: <row>` (the lead's plan §4 and §1b) and says what it held before.
//
// The `prune` column is done: the lot's prune part flipped its cells (rows 1 to 5, 10, 12 to 15, 19, 20 and 28 — a
// file of renders/ that is no render of its own name, or a record that lacks a member, is left alone with a line
// `kept render <file> <reason>`, and the take it names with a line `kept run`; where prune stopped on a raw TypeError
// it answers its first list) — each on purpose, none other moved. The `review` and `export` columns were flipped by
// the editor part: a terminal's `latest` takes the newest succeeded complete record whatever its file is called and
// the command then works on THAT FILE (ruling 2: never a second lookup by the id it says); what it passed over is one
// line; a record renamed by hand is said in one line, and refused only when its video is now another render's.
//
// The fixture's plan is too thin for a whole review: one that found its render and the render it compares with stops
// in its checks, which the cell says as `review starts` — what the lot must keep is that it gets there. (The checks
// read `plan.source.fps`: the fixture's plan has no `source`, `layout` or `frame`, which only the planner makes. A
// whole review and export at a terminal run in the last describe of this file, on real synthetic renders.)
//
// D-11, pinned here and in the engine's file: a terminal's `latest` is the newest succeeded record of ANY name (the
// `out-name` row: quote-final), the engine's is the newest render of its scenario (quote-v1 there).

describe('the render records at a terminal, state by state', () => {
  let film: Buffer;
  beforeAll(() => {
    const file = join(root, 'film.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
    film = readFileSync(file);
  }, 60_000);
  const NAME: Record<string, string> = {
    ctl: 'quote-v1',
    'renamed-newest': 'quote-final',
    'renamed-fixed': 'quote-final',
    'renamed-old': 'quote-final',
    'renamed-reused': 'quote-final',
    copy: 'quote-v1 copy',
    'copy-backup': 'quote-v1-backup',
    'out-name': 'quote-final',
    'empty-id': 'x',
    'keep-json': 'keep',
    'keep-json-without': 'quote-v1',
    'final-files': 'quote-v1.final',
  };
  /** The exit code and what stderr says first, without what changes from a machine to another. */
  async function said(b: BuiltRenders, ...args: string[]): Promise<string> {
    const r = await retake(...args);
    const lines = r.err
      .replaceAll(b.new, 'NEW')
      .replaceAll(b.old, 'OLD')
      .split('\n')
      .filter((l) => l.trim() !== '' && !/^\s+at /.test(l) && !/^(TypeError|Error): /.test(l));
    if (args[0] === 'prune')
      return `${r.code} ${lines
        .map((l) =>
          l
            .trim()
            .replace(/· [\d.]+ [kMG]B/g, '· N')
            .replace(/\([\d.]+ [kMG]B\)/, '(N)')
            .replace(/\s+/g, ' '),
        )
        .join(' / ')}`;
    // The notes a command says first on stderr (`! …`: what `latest` passed over, a record renamed by hand), then its first line.
    const notes: string[] = [];
    let k = 0;
    while (k < lines.length && lines[k]!.startsWith('! ')) notes.push(lines[k++]!);
    const head = notes.length ? `${notes.join(' / ')} / ` : '';
    const first = (lines[k] ?? '').replace(/ \d+ ms$/, '').replace(/· [\d.]+ [kMG]B/g, '· N');
    if (args[0] === 'review' && first === "✗ unexpected error: Cannot read properties of undefined (reading 'fps')") {
      // Past findRender and findPrevious, in the checks: which render it took is the id of the review folder it made.
      return `${r.code} ${head}review starts`;
    }
    return `${r.code} ${head}${first}`;
  }
  const rsites = {
    reviewLatest: (b: BuiltRenders) => said(b, 'review', b.slug, 'latest', '--scenario', 'quote'),
    reviewNamed: (b: BuiltRenders) => said(b, 'review', b.slug, NAME[b.state] ?? 'quote-v2'),
    exportLatest: (b: BuiltRenders) => said(b, 'export', b.slug, 'latest', '--scenario', 'quote', '--formats', 'mp4_1080p'),
    exportNamed: (b: BuiltRenders) => said(b, 'export', b.slug, NAME[b.state] ?? 'quote-v2', '--formats', 'mp4_1080p'),
    prune: (b: BuiltRenders) => said(b, 'prune', b.slug),
  };
  type RRow = Record<keyof typeof rsites, string>;
  // Fix pass of L7.6b — moved, in 25 cells, each on purpose: (H2) a record whose id is another file's of renders/ (a
  // copy, quote-v1-backup, keep.json saying quote-v1) is exported and reviewed under its own file's name — before:
  // into exports/quote-v1, the real render's — and the line about it says so (`— its exports and review are named
  // …`, also for an empty id); (review B L-8) prune's `kept:` counts the files of renders/ that are no render apart
  // (`1 render and 1 other file of renders/`; before: `2 renders`).
  const RTABLE: Record<string, RRow> = {
    ctl: {
      reviewLatest: '1 review starts',
      reviewNamed: '1 review starts',
      exportLatest: '0 export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-ctl/exports/quote-v1',
      exportNamed: '0 export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-ctl/exports/quote-v1',
      prune: '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 1 render (the last 3 per scenario), 0 reviews — retake prune r-ctl --yes deletes them',
    },
    v2: {
      reviewLatest: '1 review starts',
      reviewNamed: '1 review starts',
      exportLatest: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-v2/exports/quote-v2',
      exportNamed: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-v2/exports/quote-v2',
      prune: '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-v2 --yes deletes them',
    },
    // N3 — named, it exports (did not move). moved: rows 1, 20 and 21 — `latest` of review and export answer quote-v1 and say the file passed over,
    // the review by name starts, prune answers its first list (before: a raw TypeError in all four)
    'no-created': {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario, its creation time or its plan / review starts',
      reviewNamed: '1 review starts',
      exportLatest:
        '0 ! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario, its creation time or its plan / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-no-created/exports/quote-v1',
      exportNamed: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-no-created/exports/quote-v2',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v2.json its record lacks its scenario, its creation time or its plan / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-no-created --yes deletes them',
    },
    // N3 — as above. moved: rows 1, 20 and 21
    'created-5': {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario, its creation time or its plan / review starts',
      reviewNamed: '1 review starts',
      exportLatest:
        '0 ! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario, its creation time or its plan / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-created-5/exports/quote-v1',
      exportNamed: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-created-5/exports/quote-v2',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v2.json its record lacks its scenario, its creation time or its plan / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-created-5 --yes deletes them',
    },
    // moved: rows 24 and 8 — `latest` takes the renamed record BY ITS FILE and says so (its video is missing, as named); named, one line more
    // (before: `latest` looked renders/quote-v2.json up again by the id the record says: `render "quote-v2" not found`)
    'renamed-newest': {
      reviewLatest: '1 ! renders/quote-final.json says it is quote-v2 / ✗ the video of render quote-v2 is missing: <root>/projects/r-renamed-newest/renders/quote-v2.mp4',
      reviewNamed: '1 ! renders/quote-final.json says it is quote-v2 / ✗ the video of render quote-v2 is missing: <root>/projects/r-renamed-newest/renders/quote-v2.mp4',
      exportLatest: '1 ! renders/quote-final.json says it is quote-v2 / ✗ the video of render quote-v2 is missing (<root>/projects/r-renamed-newest/renders/quote-v2.mp4)',
      exportNamed: '1 ! renders/quote-final.json says it is quote-v2 / ✗ the video of render quote-v2 is missing (<root>/projects/r-renamed-newest/renders/quote-v2.mp4)',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-final.json its record says another id / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-renamed-newest --yes deletes them',
    },
    // N1 — named, it reviews and exports (did not move; row 8 adds one line). moved: row 24 — `latest` takes it by its file (before: not found)
    'renamed-fixed': {
      reviewLatest: '1 ! renders/quote-final.json says it is quote-v2 / review starts',
      reviewNamed: '1 ! renders/quote-final.json says it is quote-v2 / review starts',
      exportLatest: '0 ! renders/quote-final.json says it is quote-v2 / export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-renamed-fixed/exports/quote-v2',
      exportNamed: '0 ! renders/quote-final.json says it is quote-v2 / export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-renamed-fixed/exports/quote-v2',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-final.json its record says another id / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-renamed-fixed --yes deletes them',
    },
    // prune: rows 2 and 19 (part D). moved: row 8 — named, one line more
    'renamed-old': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 ! renders/quote-final.json says it is quote-v0 / ✗ the video of render quote-v0 is missing: <root>/projects/r-renamed-old/renders/quote-v0.mp4',
      exportLatest: '0 export quote-v3 (1920×1080, 1.00 s) → <root>/projects/r-renamed-old/exports/quote-v3',
      exportNamed: '1 ! renders/quote-final.json says it is quote-v0 / ✗ the video of render quote-v0 is missing (<root>/projects/r-renamed-old/renders/quote-v0.mp4)',
      prune:
        '0 nothing to prune in r-renamed-old (kept: 2 takes, 3 renders and 1 other file of renders/, 0 reviews) / kept run OLD a file of renders/ that is no render names it / kept render quote-final.json its record says another id',
    },
    // moved: row 9 — named, export and review are refused: renders/quote-v1.mp4 is now another render's video (before: taken, exit 0 — the other video exported); prune: row 3
    'renamed-reused': {
      reviewLatest: '1 review starts',
      reviewNamed:
        '1 ✗ renders/quote-final.json says it is quote-v1, and renders/quote-v1.mp4 is now the video of another render: nothing to review — correct "file" in the record, or render again with --out',
      exportLatest: '0 export quote-v4 (1920×1080, 1.00 s) → <root>/projects/r-renamed-reused/exports/quote-v4',
      exportNamed:
        '1 ✗ renders/quote-final.json says it is quote-v1, and renders/quote-v1.mp4 is now the video of another render: nothing to export — correct "file" in the record, or render again with --out',
      prune:
        '0 nothing to prune in r-renamed-reused (kept: 2 takes, 4 renders and 1 other file of renders/, 0 reviews) / kept run OLD a file of renders/ that is no render names it / kept render quote-final.json its record says another id',
    },
    // N1 — named, it reviews and exports (did not move). moved: row 8 — one line more; prune: row 19
    copy: {
      reviewLatest: '1 review starts',
      reviewNamed: '1 ! renders/quote-v1 copy.json says it is quote-v1 — its exports and review are named quote-v1 copy / review starts',
      exportLatest: '0 export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-copy/exports/quote-v1',
      exportNamed:
        '0 ! renders/quote-v1 copy.json says it is quote-v1 — its exports and review are named quote-v1 copy / export quote-v1 copy (1920×1080, 1.00 s) → <root>/projects/r-copy/exports/quote-v1 copy',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v1 copy.json its record says another id / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-copy --yes deletes them',
    },
    // N1 — the same. moved: row 8; prune: row 19
    'copy-backup': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 ! renders/quote-v1-backup.json says it is quote-v1 — its exports and review are named quote-v1-backup / review starts',
      exportLatest: '0 export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-copy-backup/exports/quote-v1',
      exportNamed:
        '0 ! renders/quote-v1-backup.json says it is quote-v1 — its exports and review are named quote-v1-backup / export quote-v1-backup (1920×1080, 1.00 s) → <root>/projects/r-copy-backup/exports/quote-v1-backup',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v1-backup.json its record says another id / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-copy-backup --yes deletes them',
    },
    'video-gone': {
      reviewLatest: '1 ✗ the video of render quote-v2 is missing: <root>/projects/r-video-gone/renders/quote-v2.mp4',
      reviewNamed: '1 ✗ the video of render quote-v2 is missing: <root>/projects/r-video-gone/renders/quote-v2.mp4',
      exportLatest: '1 ✗ the video of render quote-v2 is missing (<root>/projects/r-video-gone/renders/quote-v2.mp4)',
      exportNamed: '1 ✗ the video of render quote-v2 is missing (<root>/projects/r-video-gone/renders/quote-v2.mp4)',
      prune: '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-video-gone --yes deletes them',
    },
    'scenario-other': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 review starts',
      exportLatest: '0 export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-scenario-other/exports/quote-v1',
      exportNamed: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-scenario-other/exports/quote-v2',
      prune:
        '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-scenario-other --yes deletes them',
    },
    // N2 — named, it reviews and exports (did not move); prune: row 11. moved: `latest` says the file passed over (it lacks its scenario)
    'scenario-7': {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario, its creation time or its plan / review starts',
      reviewNamed: '1 review starts',
      exportLatest:
        '0 ! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario, its creation time or its plan / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-scenario-7/exports/quote-v1',
      exportNamed: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-scenario-7/exports/quote-v2',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v2.json its record lacks its scenario, its creation time or its plan / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-scenario-7 --yes deletes them',
    },
    // N2 — named, it reviews and exports (did not move); prune: row 11. moved: `latest` says the file passed over (it lacks its scenario)
    'no-scenario': {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario, its creation time or its plan / review starts',
      reviewNamed: '1 review starts',
      exportLatest:
        '0 ! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario, its creation time or its plan / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-no-scenario/exports/quote-v1',
      exportNamed: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-no-scenario/exports/quote-v2',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v2.json its record lacks its scenario, its creation time or its plan / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-no-scenario --yes deletes them',
    },
    'no-variant': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 review starts',
      exportLatest: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-no-variant/exports/quote-v2',
      exportNamed: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-no-variant/exports/quote-v2',
      prune: '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-no-variant --yes deletes them',
    },
    'lock-only': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 ✗ render "quote-v2" not found in <root>/projects/r-lock-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
      exportLatest: '0 export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-lock-only/exports/quote-v1',
      exportNamed: '1 ✗ render "quote-v2" not found in <root>/projects/r-lock-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
      prune: '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 1 render (the last 3 per scenario), 0 reviews — retake prune r-lock-only --yes deletes them',
    },
    'video-only': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 ✗ render "quote-v2" not found in <root>/projects/r-video-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
      exportLatest: '0 export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-video-only/exports/quote-v1',
      exportNamed: '1 ✗ render "quote-v2" not found in <root>/projects/r-video-only/renders (renders: quote-v1); use a render id, a .json/.mp4 path or "latest"',
      prune: '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 1 render (the last 3 per scenario), 0 reviews — retake prune r-video-only --yes deletes them',
    },
    // N10 — export's sentence stays; a review by name starts (ruling 26: did not move). moved: `latest` says the file passed over; prune: row 12
    paused: {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its status is not one Retake writes / review starts',
      reviewNamed: '1 review starts',
      exportLatest: '0 ! 1 newer file of renders/ passed over — quote-v2.json: its status is not one Retake writes / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-paused/exports/quote-v1',
      exportNamed: '1 ✗ render quote-v2 paused: nothing to export',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v2.json its status is not one Retake writes / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-paused --yes deletes them',
    },
    // N10 — export's sentence stays; prune offers a failed record as before. moved: `latest` says the newer failed file it passed over
    failed: {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: failed or cancelled / review starts',
      reviewNamed: '1 ✗ the video of render quote-v2 is missing: <root>/projects/r-failed/renders/quote-v2.mp4',
      exportLatest: '0 ! 1 newer file of renders/ passed over — quote-v2.json: failed or cancelled / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-failed/exports/quote-v1',
      exportNamed: '1 ✗ render quote-v2 failed: nothing to export',
      prune:
        '0 would delete run OLD older capture nothing uses · N / would delete render quote-v2 failed render · N / 2 items (N) can go; kept: 1 take, 1 render (the last 3 per scenario), 0 reviews — retake prune r-failed --yes deletes them',
    },
    // moved: row 22 — the export refuses in one sentence, the word made printable (before: a raw TypeError)
    'variant-cube': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 review starts',
      exportLatest: '1 ✗ render quote-v2: its record says variant "cube", which this Retake does not export (landscape, vertical or square)',
      exportNamed: '1 ✗ render quote-v2: its record says variant "cube", which this Retake does not export (landscape, vertical or square)',
      prune: '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-variant-cube --yes deletes them',
    },
    // moved: row 10 — named: the newer-Retake sentence (before: `… is not a render record`); `latest` says the file passed over; prune: row 10
    'version-2': {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: written by a newer Retake / review starts',
      reviewNamed: '1 ✗ <root>/projects/r-version-2/renders/quote-v2.json: this render record is version 2: it was made for a newer Retake (this one reads version 1) — update Retake',
      exportLatest: '0 ! 1 newer file of renders/ passed over — quote-v2.json: written by a newer Retake / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-version-2/exports/quote-v1',
      exportNamed: '1 ✗ <root>/projects/r-version-2/renders/quote-v2.json: this render record is version 2: it was made for a newer Retake (this one reads version 1) — update Retake',
      prune:
        '0 nothing to prune in r-version-2 (kept: 2 takes, 1 render and 1 other file of renders/, 0 reviews) / kept run OLD a file of renders/ that is no render names it / kept render quote-v2.json written by a newer Retake',
    },
    // N7 — named at a terminal, read through the link (did not move). moved: row 14 — `latest` takes quote-v1 and says the file it passed over (before: quote-v2)
    link: {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its record is a link / review starts',
      reviewNamed: '1 review starts',
      exportLatest: '0 ! 1 newer file of renders/ passed over — quote-v2.json: its record is a link / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-link/exports/quote-v1',
      exportNamed: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-link/exports/quote-v2',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v2.json its record is a link / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-link --yes deletes them',
    },
    // N8, D-11 — a terminal's `latest` is quote-final (the engine's is quote-v1): must not move
    'out-name': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 review starts',
      exportLatest: '0 export quote-final (1920×1080, 1.00 s) → <root>/projects/r-out-name/exports/quote-final',
      exportNamed: '0 export quote-final (1920×1080, 1.00 s) → <root>/projects/r-out-name/exports/quote-final',
      prune: '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-out-name --yes deletes them',
    },
    // moved: row 13 — named: the record has no plan (before: `… is not a render record`); `latest` says the file passed over; prune: row 13
    'no-plan': {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario, its creation time or its plan / review starts',
      reviewNamed: '1 ✗ render quote-v2 has no plan (<root>/projects/r-no-plan/renders/quote-v2.json): nothing to review',
      exportLatest:
        '0 ! 1 newer file of renders/ passed over — quote-v2.json: its record lacks its scenario, its creation time or its plan / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-no-plan/exports/quote-v1',
      exportNamed: '1 ✗ render quote-v2 has no plan (<root>/projects/r-no-plan/renders/quote-v2.json): nothing to export',
      prune: '0 nothing to prune in r-no-plan (kept: 2 takes, 2 renders, 0 reviews) / kept render quote-v2.json its record lacks its scenario, its creation time or its plan',
    },
    // moved: row 15 — named: the file does not read as a render record (before: a JSON parser's message); `latest` says the file passed over
    'cut-short': {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its record does not read / review starts',
      reviewNamed: '1 ✗ <root>/projects/r-cut-short/renders/quote-v2.json does not read as a render record (it is not JSON)',
      exportLatest: '0 ! 1 newer file of renders/ passed over — quote-v2.json: its record does not read / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-cut-short/exports/quote-v1',
      exportNamed: '1 ✗ <root>/projects/r-cut-short/renders/quote-v2.json does not read as a render record (it is not JSON)',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v2.json its record does not read / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-cut-short --yes deletes them',
    },
    // moved: row 15 (before: `… is not a render record`)
    array: {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its record does not read / review starts',
      reviewNamed: '1 ✗ <root>/projects/r-array/renders/quote-v2.json does not read as a render record',
      exportLatest: '0 ! 1 newer file of renders/ passed over — quote-v2.json: its record does not read / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-array/exports/quote-v1',
      exportNamed: '1 ✗ <root>/projects/r-array/renders/quote-v2.json does not read as a render record',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v2.json its record does not read / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-array --yes deletes them',
    },
    // moved: row 15 (before: the same)
    'null': {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its record does not read / review starts',
      reviewNamed: '1 ✗ <root>/projects/r-null/renders/quote-v2.json does not read as a render record',
      exportLatest: '0 ! 1 newer file of renders/ passed over — quote-v2.json: its record does not read / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-null/exports/quote-v1',
      exportNamed: '1 ✗ <root>/projects/r-null/renders/quote-v2.json does not read as a render record',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v2.json its record does not read / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-null --yes deletes them',
    },
    // moved: rows 15 and 28 — named: the file does not read as a render record (status) (before: a review of it started, and export said `render quote-v2 undefined` — bugs); prune leaves it alone
    'no-status': {
      reviewLatest: '1 ! 1 newer file of renders/ passed over — quote-v2.json: its record does not read / review starts',
      reviewNamed: '1 ✗ <root>/projects/r-no-status/renders/quote-v2.json does not read as a render record (status)',
      exportLatest: '0 ! 1 newer file of renders/ passed over — quote-v2.json: its record does not read / export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-no-status/exports/quote-v1',
      exportNamed: '1 ✗ <root>/projects/r-no-status/renders/quote-v2.json does not read as a render record (status)',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render quote-v2.json its record does not read / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-no-status --yes deletes them',
    },
    // N9 — named, it exports (did not move). moved: row 23 — a review of it starts (before: a raw TypeError, a path made from the missing run id)
    'no-run-id': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 review starts',
      exportLatest: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-no-run-id/exports/quote-v2',
      exportNamed: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-no-run-id/exports/quote-v2',
      prune: '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-no-run-id --yes deletes them',
    },
    // moved: row 25 — `latest` acts on x.json BY ITS FILE, its id said in fixed words, the export goes into exports/x (before: `render "" not found`; named, the export went straight into exports/ and a review into review/ itself)
    'empty-id': {
      reviewLatest: '1 ! renders/x.json says an empty id — its exports and review are named x / review starts',
      reviewNamed: '1 ! renders/x.json says an empty id — its exports and review are named x / review starts',
      exportLatest: '0 ! renders/x.json says an empty id — its exports and review are named x / export x (1920×1080, 1.00 s) → <root>/projects/r-empty-id/exports/x',
      exportNamed: '0 ! renders/x.json says an empty id — its exports and review are named x / export x (1920×1080, 1.00 s) → <root>/projects/r-empty-id/exports/x',
      prune:
        '0 would delete run OLD older capture nothing uses · N / kept render x.json its record says another id / 1 item (N) can go; kept: 1 take, 1 render and 1 other file of renders/ (the last 3 per scenario), 0 reviews — retake prune r-empty-id --yes deletes them',
    },
    // N9 — named at a terminal, taken (must not move)
    'file-outside': {
      reviewLatest: '1 ✗ cannot read the video /etc/hosts (ffprobe failed: is ffmpeg installed and the file a video?)',
      reviewNamed: '1 ✗ cannot read the video /etc/hosts (ffprobe failed: is ffmpeg installed and the file a video?)',
      exportLatest: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-file-outside/exports/quote-v2',
      exportNamed: '0 export quote-v2 (1920×1080, 1.00 s) → <root>/projects/r-file-outside/exports/quote-v2',
      prune: '0 would delete run OLD older capture nothing uses · N / 1 item (N) can go; kept: 1 take, 2 renders (the last 3 per scenario), 0 reviews — retake prune r-file-outside --yes deletes them',
    },
    // prune: row 4. moved: row 8 — named, one line more
    'keep-json': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 ! renders/keep.json says it is quote-v1 — its exports and review are named keep / review starts',
      exportLatest: '0 export quote-v4 (1920×1080, 1.00 s) → <root>/projects/r-keep-json/exports/quote-v4',
      exportNamed: '0 ! renders/keep.json says it is quote-v1 — its exports and review are named keep / export keep (1920×1080, 1.00 s) → <root>/projects/r-keep-json/exports/keep',
      prune: '0 nothing to prune in r-keep-json (kept: 2 takes, 4 renders and 1 other file of renders/, 0 reviews) / kept render keep.json its record says another id',
    },
    'keep-json-without': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 review starts',
      exportLatest: '0 export quote-v4 (1920×1080, 1.00 s) → <root>/projects/r-keep-json-without/exports/quote-v4',
      exportNamed: '0 export quote-v1 (1920×1080, 1.00 s) → <root>/projects/r-keep-json-without/exports/quote-v1',
      prune:
        '0 would delete run OLD older capture nothing uses · N / would delete render quote-v1 older render · N / 2 items (N) can go; kept: 1 take, 3 renders (the last 3 per scenario), 0 reviews — retake prune r-keep-json-without --yes deletes them',
    },
    // D-11 — a terminal's `latest` (must not move). (prune's line does not show an item's paths: the engine's table holds row 5)
    'final-files': {
      reviewLatest: '1 review starts',
      reviewNamed: '1 review starts',
      exportLatest: '0 export quote-v1.final (1920×1080, 1.00 s) → <root>/projects/r-final-files/exports/quote-v1.final',
      exportNamed: '0 export quote-v1.final (1920×1080, 1.00 s) → <root>/projects/r-final-files/exports/quote-v1.final',
      prune:
        '0 would delete run OLD older capture nothing uses · N / would delete render quote-v1 older render · N / 2 items (N) can go; kept: 1 take, 4 renders (the last 3 per scenario), 0 reviews — retake prune r-final-files --yes deletes them',
    },
  };

  it('every state of the table: review and export with `latest` and by name, and prune', async () => {
    const got: Record<string, RRow> = {};
    for (const id of renderStateIds()) {
      const b = buildRenderState(root, id, { film, runFilm: film });
      const row = {} as RRow;
      // Prune first (dry): an export writes exports/, which prune never reads, but the order is the one a person follows.
      row.prune = await rsites.prune(b);
      for (const k of ['reviewLatest', 'reviewNamed', 'exportLatest', 'exportNamed'] as const) row[k] = await rsites[k](b);
      got[id] = { reviewLatest: row.reviewLatest, reviewNamed: row.reviewNamed, exportLatest: row.exportLatest, exportNamed: row.exportNamed, prune: row.prune };
    }
    expect(got).toEqual(RTABLE);
  }, 240_000);
});

// ── A review at a terminal run to its end (L7.6b fix pass, review B M-6) ───────────────────────────────────────
// The table above stops every review in its checks: the fixture's plan holds one card and no `source`, `layout` or
// `frame` (a planned plan's), and the checks read `plan.source.fps` — the cell `review starts` says it got past the
// render's lookup and the render compared with. Here real synthetic renders (the review's own test helpers: a capture
// drawn by ffmpeg, a plan made by the planner, a render drawn from it) are reviewed and exported through the CLI to
// their end: by `latest` and by name, and — the fix pass's H2 — a renamed newest record whose id is a live render's.
describe('a review and an export at a terminal, run to their end on real synthetic renders', () => {
  const can = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!can)(
    "`latest` and by name: the review of the render picked, in review/<its name>; a renamed newest record that says a live render's id is reviewed and exported under its file's name, the live render's folders untouched",
    async () => {
      const ws = await workspace();
      try {
        const tl = scenesTimeline([3]);
        const v1 = await makeCase(ws, 'clean', tl);
        await makeCase(ws, 'clean', tl, { version: 2, run: v1.run });
        const cli = async (...args: string[]) => {
          const io = memoryIo();
          const code = await main(['node', 'retake', '--root', ws.root, '--no-color', ...args], io);
          // The exit code and the notes about renders/ (the review's own summary line is a warning too: left out).
          return `${code} ${io
            .stderr()
            .replaceAll(ws.root, '<root>')
            .split('\n')
            .filter((l) => l.startsWith('! ') && l.includes('renders/'))
            .join(' / ')}`.trim();
        };
        const dir = (...p: string[]) => join(ws.project.dir, ...p);
        const reviewed = (name: string): string => (JSON.parse(readFileSync(dir('review', name, 'report.json'), 'utf8')) as { render: { id: string } }).render.id;
        const exported = (name: string): string =>
          readdirSync(dir('exports', name))
            .filter((f) => f.endsWith('.mp4'))
            .join(' ');
        // `latest`: the newest render, reviewed to its end and compared with the one before it.
        expect(await cli('review', 'demo', 'latest', '--scenario', 'clean')).toBe('0');
        expect([reviewed('clean-v2'), (JSON.parse(readFileSync(dir('review', 'clean-v2', 'report.json'), 'utf8')) as { diff?: { previous: string } }).diff?.previous]).toEqual([
          'clean-v2',
          'clean-v1',
        ]);
        // By name.
        expect(await cli('review', 'demo', 'clean-v1', '--no-previous')).toBe('0');
        expect(reviewed('clean-v1')).toBe('clean-v1');
        expect(await cli('export', 'demo', 'clean-v1', '--formats', 'mp4_1080p')).toBe('0');
        expect(exported('clean-v1')).toBe('clean-v1-1080p.mp4');
        const keptReview = readFileSync(dir('review', 'clean-v1', 'report.json'));
        const keptExport = readFileSync(dir('exports', 'clean-v1', 'manifest.json'));
        // H2: clean-v2 renamed by hand to clean-final, its video too, its `file` corrected — and its id made clean-v1's.
        const v2 = JSON.parse(readFileSync(dir('renders', 'clean-v2.json'), 'utf8')) as Record<string, unknown>;
        renameSync(dir('renders', 'clean-v2.mp4'), dir('renders', 'clean-final.mp4'));
        rmSync(dir('renders', 'clean-v2.json'));
        writeFileSync(dir('renders', 'clean-final.json'), JSON.stringify({ ...v2, id: 'clean-v1', file: dir('renders', 'clean-final.mp4'), record: dir('renders', 'clean-final.json') }));
        const line = '! renders/clean-final.json says it is clean-v1 — its exports and review are named clean-final';
        expect(await cli('review', 'demo', 'latest', '--scenario', 'clean', '--no-previous')).toBe(`0 ${line}`);
        expect(reviewed('clean-final')).toBe('clean-final');
        expect(await cli('export', 'demo', 'latest', '--scenario', 'clean', '--formats', 'mp4_1080p')).toBe(`0 ${line}`);
        expect(exported('clean-final')).toBe('clean-final-1080p.mp4');
        // The live render's folders are as they were.
        expect([readFileSync(dir('review', 'clean-v1', 'report.json')).equals(keptReview), readFileSync(dir('exports', 'clean-v1', 'manifest.json')).equals(keptExport)]).toEqual([true, true]);
        // Upper case: on a disk that ignores case renders/CLEAN-V1.json is clean-v1.json — named after its file there.
        writeFileSync(dir('renders', 'clean-final.json'), JSON.stringify({ ...v2, id: 'CLEAN-V1', file: dir('renders', 'clean-final.mp4'), record: dir('renders', 'clean-final.json') }));
        const caseless = existsSync(dir('renders', 'CLEAN-V1.json'));
        const upper = await cli('export', 'demo', 'clean-final', '--formats', 'mp4_1080p');
        expect(upper).toBe(
          caseless ? '0 ! renders/clean-final.json says an id that is no render id — its exports and review are named clean-final' : '0 ! renders/clean-final.json says an id that is no render id',
        );
        expect(readFileSync(dir('exports', 'clean-v1', 'manifest.json')).equals(keptExport)).toBe(true);
      } finally {
        await ws.cleanup();
      }
    },
    600_000,
  );
});
