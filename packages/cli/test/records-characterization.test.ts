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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@retake/core/io';
import { EXIT, main, memoryIo } from '../src/index.js';
import { findRunOf } from '@retake/engine';
import { latestNotice } from '../src/commands/render.js';
import { STATES, buildState, stateIds, writeRunFolder, writeWorkspace } from '../../core/test/fixtures/records/build.js';
import type { BuiltState } from '../../core/test/fixtures/records/build.js';

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
    for (const [id, text] of [['20261003-100000-quote', '{"status":"succeeded"}'], ['20261004-100000-quote', '[]']] as const) {
      writeRunFolder(join(b.runs, id), id, b.slug, { about: 'no record' });
      writeFileSync(join(b.runs, id, 'run.json'), text);
    }
    const line = await latest(b);
    expect(line).toBe('OLD | run OLD is used: 1 newer capture of "quote" passed over — NEW (failed); 2 newer run folders without a run.json that reads as a record were not considered (name one with --run <id>)');
    expect(line).not.toContain('20261003');
    // A record of a later version of the same format — words this build does not know — is a capture: taken, nothing said.
    expect(await latest(state('v'))).toBe('NEW');
  });

  it('nothing a file holds is printed as the file has it: the scene of --until only when it reads as a scene id, a timeline\'s scenario made printable', async () => {
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
      return { code: r.code, err: r.err.replaceAll(STATES.new, 'NEW').replaceAll(STATES.old, 'OLD'), plans: r.out.includes(`/runs/${STATES.new}/capture.mp4`) ? 'NEW' : r.out.includes(`/runs/${STATES.old}/capture.mp4`) ? 'OLD' : '-' };
    };
    const said = async (slug: string) => {
      const r = await retake('plan', slug, 'latest', '--scenario', 'quote', '--out', join(root, `${slug}.plan.json`));
      return r.err.replaceAll(STATES.new, 'NEW').replaceAll(STATES.old, 'OLD').split('\n').filter((l) => l.includes('is used') || l.includes('stops at'));
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
    expect(await retake('plan', 's-f-none', 'latest', '--scenario', 'quote')).toMatchObject({ code: EXIT.failure, err: '✗ no capture run of scenario "quote" in <root>/projects/s-f-none/runs: capture one with `retake run s-f-none quote`' });
    // A run that is named: the named run's sentences, as before.
    expect(await retake('plan', 's-o', STATES.new)).toMatchObject({ code: EXIT.failure, err: `✗ run ${STATES.new}: this run.json is version 2: it was made for a newer Retake (this one reads version 1) — update Retake` });
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
    expect(r.err.replaceAll(STATES.new, 'NEW').replaceAll(STATES.old, 'OLD').split('\n')[0]).toBe('! run OLD is used: 1 newer capture of "quote" passed over — NEW (failed) (name one in place of "latest")');
    const json = await retake('export-capture', 's-c', 'latest', '--scenario', 'quote', '--json', '--out', join(root, 'raw-c-json'));
    expect(json.err).not.toContain('is used');
    // A run the package refuses is refused in the package's words, before the theme is looked for.
    writeFileSync(join(root, 'projects', 's-l', 'project.yaml'), 'name: P\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: no-such-theme\n');
    expect(await retake('export-capture', 's-l', STATES.new)).toMatchObject({ code: EXIT.failure, err: `✗ run ${STATES.new}: its timeline does not read (timeline.json is not JSON)` });
    expect(await retake('export-capture', 's-f', STATES.new)).toMatchObject({ code: EXIT.failure, err: `✗ run ${STATES.new} is a dry run: it has no capture to export` });
  }, 120_000);
});
