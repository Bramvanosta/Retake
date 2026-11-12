/**
 * L7.33: a person's `retake run` (and `retake hooks run <scenario>:setup|teardown`) lists the sql hooks of a scenario
 * an agent wrote with its shell hooks — each statement as it will run (a file's text), rendered with the run's
 * context, a secret kept as its token, its database key and its rollback — and runs none of them before the person
 * says yes. A scenario the person wrote, or one without shell or sql hooks, runs as before; `retake hooks trust` lists
 * and settles them too. The runner's `runScenario` is replaced (no browser): it records that the run started.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({ runs: [] as Array<Record<string, unknown>> }));

vi.mock('@retake/runner-web', async (importOriginal) => {
  const real = await importOriginal<typeof import('@retake/runner-web')>();
  return {
    ...real,
    runScenario: async (o: Record<string, unknown>) => {
      fakes.runs.push(o);
      const id = `20260101-12000${fakes.runs.length % 10}-x`;
      return {
        version: 1,
        id,
        project: 'demo',
        scenario: (o.scenario as { name: string }).name,
        mode: o.mode,
        status: 'succeeded',
        started_at: '2026-01-01T12:00:00.000Z',
        finished_at: '2026-01-01T12:00:01.000Z',
        dir: join(String((o.project as { dir: string }).dir), 'runs', id),
        env: 'staging',
        options: { hooks: o.hooks ?? 'run', headed: false },
        steps_total: 1,
        steps_done: 1,
        screenshots: [],
        hooks: { setup: 'none', teardown: 'none' },
        warnings: [],
      };
    },
  };
});

import { createEngine } from '@retake/engine';
import type { Engine } from '@retake/engine';
import { EXIT, main, memoryIo } from '../src/index.js';

let ws: string;
let projectDir: string;
let mcp: Engine;
let person: Engine;
const savedHome = process.env.RETAKE_HOME;

const SCENES = 'scenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - hold: 1\n';
/** An sql setup hook (inline, rendered with the vars and the page, with its rollback) and an sql teardown from a file. */
const SQL = (video: string) =>
  [
    `video: ${video}`,
    'vars:',
    '  table: replies',
    'setup:',
    '  - name: seed',
    '    sql: {query: "INSERT INTO {{vars.table}} (text) VALUES (\'{{app}}\')", rollback: "INSERT INTO undone VALUES (1)"}',
    'teardown:',
    '  - sql: {file: hooks/tidy.sql, db: main}',
    SCENES,
  ].join('\n');
const MIXED = `video: mixed\nsetup:\n  - shell: "touch seeded.txt"\n  - sql: "SELECT 1"\n${SCENES}`;

async function retake(args: string[], answers?: string[]) {
  const io = memoryIo(answers !== undefined ? { answers } : {});
  const code = await main(['node', 'retake', '--root', ws, '--no-color', ...args], io);
  return { code, out: io.stdout(), err: io.stderr(), questions: io.questions() };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-run-agent-sql-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  projectDir = join(ws, 'projects', 'demo');
  await mkdir(join(projectDir, 'scenarios'), { recursive: true });
  await mkdir(join(projectDir, 'hooks'), { recursive: true });
  await writeFile(
    join(projectDir, 'project.yaml'),
    'name: Demo\nenvironments:\n  staging:\n    app: http://app.example.test\ncapture: {width: 1280, height: 720, scale: 1, fps: 30}\ndatabases:\n  main: {url: "postgres://app:{{env:RETAKE_TEST_UNSET_PW}}@127.0.0.1:1/demo"}\n',
  );
  await writeFile(join(projectDir, 'hooks', 'tidy.sql'), 'SELECT {{env:RETAKE_TEST_UNSET_PW}} FROM replies;\n');
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  person = await createEngine({ root: ws, client: 'cli', autoStartWorker: false });
  await mcp.scenarios.save('demo', 'agent', SQL('agent'));
  await mcp.scenarios.save('demo', 'mixed', MIXED);
  await person.scenarios.save('demo', 'personal', SQL('personal'));
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(ws, { recursive: true, force: true });
});

beforeEach(() => {
  fakes.runs.length = 0;
});

describe('retake run: the sql hooks of a scenario an agent wrote', () => {
  it('without a terminal and without --yes: listed as they will run, then refused; nothing runs', async () => {
    const r = await retake(['run', 'demo', 'agent']);
    expect(r.code).toBe(EXIT.failure);
    expect(fakes.runs).toHaveLength(0);
    expect(r.err).toContain('the hooks of scenario agent were last written by an agent (through MCP, ');
    expect(r.err).toContain('its 2 sql hooks run statements on a database');
    expect(r.err).toContain("  setup 1 (seed) (sql, database the environment's first):");
    expect(r.err).toContain("      INSERT INTO replies (text) VALUES ('http://app.example.test')");
    expect(r.err).toContain('      rollback: INSERT INTO undone VALUES (1)');
    expect(r.err).toContain('  teardown 1 (sql, file hooks/tidy.sql, database main):');
    // The file's text, its secret kept as a token (never resolved for a listing).
    expect(r.err).toContain('      SELECT {{env:RETAKE_TEST_UNSET_PW}} FROM replies;');
    const refusal = r.err.split('\n').find((l) => l.includes('refused:'));
    expect(refusal).toBe('✗ refused: the sql hooks of scenario agent (setup 1 (seed), teardown 1), last written by an agent, run only once a person says yes — answer in a terminal, or pass --yes');
  });

  it('a terminal asks: no → nothing runs; yes → the run starts; --yes accepts', async () => {
    const no = await retake(['run', 'demo', 'agent'], ['n']);
    expect(no.questions).toEqual(['Run these 2 sql hooks, as listed?']);
    expect(no.code).toBe(EXIT.failure);
    expect(no.err).toContain('not run: the sql hooks of scenario agent were declined (nothing ran)');
    expect(fakes.runs).toHaveLength(0);
    const yes = await retake(['run', 'demo', 'agent'], ['y']);
    expect(yes.code).toBe(EXIT.ok);
    expect(fakes.runs).toHaveLength(1);
    const flag = await retake(['run', 'demo', 'agent', '--yes']);
    expect(flag.code).toBe(EXIT.ok);
    expect(flag.err).toContain('the sql hooks are accepted by --yes');
  });

  it('shell and sql hooks together are listed and asked about at once', async () => {
    const r = await retake(['run', 'demo', 'mixed'], ['n']);
    expect(r.err).toContain('its 1 shell hook runs a command on this machine, and its 1 sql hook runs statements on a database');
    expect(r.err).toContain('  setup 1: touch seeded.txt');
    expect(r.err).toContain("  setup 2 (sql, database the environment's first):");
    expect(r.questions).toEqual(['Run these 2 shell and sql hooks, as listed?']);
    expect(fakes.runs).toHaveLength(0);
  });

  it("the person's scenario runs as before: nothing listed, nothing asked", async () => {
    const r = await retake(['run', 'demo', 'personal']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.questions).toEqual([]);
    expect(r.err).not.toContain('sql hook');
    expect(fakes.runs).toHaveLength(1);
  });

  it('hooks run <scenario>:setup lists its sql hook and refuses without a terminal', async () => {
    const r = await retake(['hooks', 'run', 'demo', 'agent:setup']);
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toContain("  setup 1 (seed) (sql, database the environment's first):");
    expect(r.err).toContain('refused: the sql hooks of scenario agent (setup 1 (seed)), last written by an agent');
    expect(r.err).not.toContain('teardown 1');
  });

  it('hooks trust lists the sql hooks and, on yes, makes them the person’s: the next run does not ask', async () => {
    const t = await retake(['hooks', 'trust', 'demo', 'agent'], ['y']);
    expect(t.questions).toEqual(['Mark these 2 sql hooks as yours, as listed (runs no longer ask until they change)?']);
    expect(t.code).toBe(EXIT.ok);
    const r = await retake(['run', 'demo', 'agent']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.questions).toEqual([]);
    expect(fakes.runs).toHaveLength(1);
  });
});
