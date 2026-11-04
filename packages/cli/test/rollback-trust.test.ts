/**
 * L5.14: a terminal's replay of rollbacks (`retake hooks rollback`, `retake env reset`) lists what it is about to replay
 * before replaying it, and shows in full the entries Retake did not record in their journal with this home (their entry
 * is not signed); those are replayed only with `--replay-unsigned`, in a terminal, on a yes to each.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, main, memoryIo } from '../src/index.js';

let ws: string;
let project: string;
const savedHome = process.env.RETAKE_HOME;

async function retake(...args: Array<string | { answers: string[] }>) {
  const opts = typeof args[args.length - 1] === 'object' ? (args.pop() as { answers: string[] }) : undefined;
  const io = memoryIo(opts ? { answers: opts.answers } : {});
  const code = await main(['node', 'retake', '--root', ws, ...(args as string[])], io);
  return { code, out: io.stdout(), err: io.stderr(), questions: io.questions() };
}
const read = (name: string) => (existsSync(join(project, name)) ? readFileSync(join(project, name), 'utf8') : '');

function placed(rollback: string): string {
  return JSON.stringify({
    version: 1,
    created_at: '2026-11-04T09:00:00.000Z',
    updated_at: '2026-11-04T09:00:00.000Z',
    entries: [
      {
        seq: 1,
        kind: 'shell',
        phase: 'setup',
        description: 'shell "true"',
        env: 'local',
        started_at: '2026-11-04T09:00:00.000Z',
        finished_at: '2026-11-04T09:00:01.000Z',
        status: 'ok',
        rollback: { kind: 'shell', run: rollback, description: `shell "${rollback}"`, data: {} },
      },
    ],
  });
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-rollback-trust-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  project = join(ws, 'projects', 'demo');
  await mkdir(join(project, 'hooks'), { recursive: true });
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  await writeFile(join(project, 'project.yaml'), 'name: Demo\nenvironments:\n  local:\n    app: http://127.0.0.1:9\n');
  await writeFile(join(project, 'hooks', 'mark.yaml'), '- name: mark\n  shell: {run: "printf x >> marks.log", rollback: "printf u >> undo.log"}\n');
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('a terminal replay lists before it replays (L5.14)', () => {
  it('lists each pending rollback, shows the unsigned one in full, replays only the signed one; --replay-unsigned asks about it (y/N) in a terminal only', async () => {
    const run = await retake('hooks', 'run', 'demo', 'hooks/mark.yaml');
    expect(run.code, run.err).toBe(EXIT.ok);
    const long = `printf placed >> placed.log # ${'x'.repeat(120)}`;
    await mkdir(join(project, 'runs', '20261104-091000-placed'), { recursive: true });
    await writeFile(join(project, 'runs', '20261104-091000-placed', 'hooks-journal.json'), placed(long));

    const first = await retake('hooks', 'rollback', 'demo');
    expect(first.code).toBe(EXIT.failure);
    const listed = first.err.indexOf('pending rollbacks (2 journals)');
    expect(listed).toBeGreaterThanOrEqual(0);
    // The unsigned entry: its journal, then every field of its action in full (never cut), not its own description.
    expect(first.err).toContain(`journal ${join(project, 'runs', '20261104-091000-placed', 'hooks-journal.json')}`);
    expect(first.err).toMatch(/#1 · env local not signed by this Retake home: not replayed without --replay-unsigned \(in a terminal\)\n {6}kind: shell\n {6}run: printf placed >> placed\.log # x{120}\n/);
    expect(first.err).toMatch(/#1 shell "printf u >> undo\.log" · env local\n/);
    // The list comes before any replay.
    expect(first.err.indexOf('rollback ')).toBeGreaterThan(listed);
    expect(first.err).toMatch(/not replayed: its journal entry \(20261104-091000-placed #1\) is not signed by this Retake home/);
    expect(read('undo.log')).toBe('u');
    expect(read('placed.log')).toBe('');

    // A dry run lists it and succeeds (nothing is replayed).
    const reset = await retake('env', 'reset', 'demo', '--dry');
    expect(reset.code, reset.err).toBe(EXIT.ok);
    expect(reset.err).toMatch(/pending rollbacks \(1 journal\)[\s\S]*not signed by this Retake home: not replayed without --replay-unsigned/);
    const dryOne = await retake('hooks', 'rollback', 'demo', '20261104-091000-placed', '--dry');
    expect(dryOne.code, dryOne.err).toBe(EXIT.ok);
    expect(dryOne.err).toMatch(/#1 · env local not signed by this Retake home: listed only \(dry run\)\n {6}kind: shell\n[\s\S]*not executed \(dry run\); not signed by this Retake home: not replayed without --replay-unsigned/);

    // Not in a terminal: refused before anything runs.
    const noTty = await retake('hooks', 'rollback', 'demo', '--replay-unsigned');
    expect(noTty.code).toBe(EXIT.usage);
    expect(noTty.err).toMatch(/--replay-unsigned asks about each rollback Retake did not sign, in a terminal/);
    expect(read('placed.log')).toBe('');

    // In a terminal: asked about, shown in full again; the default answer is no.
    const no = await retake('hooks', 'rollback', 'demo', '--replay-unsigned', { answers: [''] });
    expect(no.code).toBe(EXIT.failure);
    expect(no.questions).toEqual(['Replay this rollback (#1), exactly as shown?']);
    expect(no.err).toMatch(/not signed by this Retake home journal \S+hooks-journal\.json #1 · env local\n {6}kind: shell\n {6}run: printf placed >> placed\.log # x{120}\n/);
    expect(no.err).toMatch(/not replayed: .*; you said no/);
    expect(read('placed.log')).toBe('');

    // The single-run path lists the journal and asks the same way; yes replays it.
    const yes = await retake('hooks', 'rollback', 'demo', '20261104-091000-placed', '--replay-unsigned', { answers: ['y'] });
    expect(yes.code, yes.err).toBe(EXIT.ok);
    // Listed first: the journal's line, then its entry in full — before the question.
    const listing = `rollback 20261104-091000-placed (1 entry)\njournal ${join(project, 'runs', '20261104-091000-placed', 'hooks-journal.json')}\n  #1 · env local not signed by this Retake home: asked about below\n      kind: shell\n      run: printf placed`;
    expect(yes.err).toContain(listing);
    expect(yes.err.indexOf(listing)).toBeLessThan(yes.err.indexOf('Replay this rollback (#1)'));
    expect(read('placed.log')).toBe('placed');
  });
});
