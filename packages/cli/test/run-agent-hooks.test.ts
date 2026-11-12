/**
 * L7.27: a person's `retake run` (and `retake hooks run <scenario>:setup|teardown`) lists the shell hooks of a scenario
 * whose bytes an agent wrote — by the workspace journal — and runs them only on a person's yes: a terminal's answer,
 * or `--yes`; without a terminal and without `--yes` it refuses, naming the hooks and the flag; a dry run without its
 * hooks lists them and asks nothing. A person's later save, a hand edit, or a scenario the person wrote: as before.
 *
 * The scenarios are written for real (an MCP engine's save, a CLI engine's save, a hand edit), so the journal lines
 * are the ones the store writes. The runner's `runScenario` is replaced (no browser): it records that the run started;
 * `hooks run` runs its shell hook for real (a marker file in the project).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { agentHooksListing } from '../src/agent-hooks.js';
import { scratchHome } from '@retake/test-support/home';

let ws: string;
let projectDir: string;
let mcp: Engine;
let person: Engine;
const retakeHome = scratchHome();

const SCENES = 'scenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - hold: 1\n';
/** A scenario with a shell setup hook (with its rollback) and a shell teardown. */
const AGENT = (video: string) => `video: ${video}\nsetup:\n  - name: seed\n    shell: {run: "touch seeded.txt", rollback: "rm -f seeded.txt"}\nteardown:\n  - shell: "touch cleaned.txt"\n${SCENES}`;
const PLAIN = (video: string) => `video: ${video}\n${SCENES}`;

async function retake(args: string[], answers?: string[]) {
  const io = memoryIo(answers !== undefined ? { answers } : {});
  const code = await main(['node', 'retake', '--root', ws, '--no-color', ...args], io);
  return { code, out: io.stdout(), err: io.stderr(), questions: io.questions() };
}

const journalLines = async () => (await readFile(join(ws, '.retake', 'journal.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
const historyLines = async () => (await readFile(join(ws, '.retake', 'history.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean);

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-run-agent-hooks-'));
  retakeHome.use(join(ws, '.home'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  projectDir = join(ws, 'projects', 'demo');
  await mkdir(join(projectDir, 'scenarios'), { recursive: true });
  await writeFile(
    join(projectDir, 'project.yaml'),
    'name: Demo\nenvironments:\n  staging:\n    app: http://app.example.test\ncapture: {width: 1280, height: 720, scale: 1, fps: 30}\nhooks:\n  reset-cart:\n    shell: "touch cart.txt"\n',
  );
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  person = await createEngine({ root: ws, client: 'cli', autoStartWorker: false });
  // Written through MCP (the agent): the journal says so.
  await mcp.scenarios.save('demo', 'agent', AGENT('agent'));
  // A step hook: the scenario's own named hook and project.yaml's.
  await mcp.scenarios.save(
    'demo',
    'steps',
    `video: steps\nsetup:\n  - http: {method: GET, url: "http://app.example.test/health"}\nhooks:\n  mine:\n    shell: "touch mine.txt"\n${SCENES.replace('      - hold: 1\n', '      - hook: mine\n      - hook: reset-cart\n      - hold: 1\n')}`,
  );
  // Written by the person in a terminal (the CLI's engine), or by hand (no line).
  await person.scenarios.save('demo', 'personal', AGENT('personal'));
  await writeFile(join(projectDir, 'scenarios', 'byhand.yaml'), AGENT('byhand'));
  await mcp.scenarios.save('demo', 'plain', PLAIN('plain'));
  // What the commands will run comes from the vars, the env and the cwd too, and from an earlier hook's response.
  await mcp.scenarios.save(
    'demo',
    'rendered',
    [
      'video: rendered',
      'vars:',
      '  c: "touch made-by-vars.txt"',
      'setup:',
      '  - shell: "{{vars.c}}"',
      '  - shell: {run: "git status", cwd: "scenarios", env: {GIT_CONFIG_COUNT: "1", GIT_CONFIG_VALUE_0: "touch made-by-env.txt", WHERE: "{{app}}/x"}}',
      '  - http: {method: POST, url: "{{app}}/token", save_as: tok}',
      '  - shell: "echo {{hooks.tok.body}} {{run.id}}"',
      SCENES,
    ].join('\n'),
  );
}, 60_000);

afterAll(async () => {
  retakeHome.restore();
  await rm(ws, { recursive: true, force: true });
});

beforeEach(() => {
  fakes.runs.length = 0;
});

describe('retake run: the shell hooks of a scenario an agent wrote', () => {
  it('the journal names the agent as the writer of the scenario (the premise)', async () => {
    const line = (await journalLines()).map((l) => JSON.parse(l) as { path: string; by: { trust: string } }).find((e) => e.path.endsWith('scenarios/agent.yaml'));
    expect(line?.by.trust).toBe('mcp');
  });

  it('without a terminal and without --yes: refused in one sentence naming the hooks and --yes; nothing runs', async () => {
    const before = (await historyLines()).length;
    const r = await retake(['run', 'demo', 'agent']);
    expect(r.code).toBe(EXIT.failure);
    expect(fakes.runs).toHaveLength(0);
    expect(r.err).toContain('the hooks of scenario agent were last written by an agent (through MCP, ');
    expect(r.err).toContain('  setup 1 (seed): touch seeded.txt');
    expect(r.err).toContain('      rollback: rm -f seeded.txt');
    expect(r.err).toContain('  teardown 1: touch cleaned.txt');
    const refusal = r.err.split('\n').find((l) => l.includes('refused:'));
    expect(refusal).toBe('✗ refused: the shell hooks of scenario agent (setup 1 (seed), teardown 1), last written by an agent, run only once a person says yes — answer in a terminal, or pass --yes');
    expect((await historyLines()).length).toBe(before);
    // The run id reserved for the listing is given back: no run folder is left.
    expect(await readdir(join(projectDir, 'runs')).catch(() => [])).toEqual([]);
  });

  it('input that is not a terminal is never read as an answer (a piped "y" does not count)', async () => {
    const io = { ...memoryIo({ answers: ['y'] }), canPrompt: false };
    const code = await main(['node', 'retake', '--root', ws, '--no-color', 'run', 'demo', 'agent'], io);
    expect(code).toBe(EXIT.failure);
    expect(io.questions()).toEqual([]);
    expect(io.stderr()).toContain('or pass --yes');
    expect(fakes.runs).toHaveLength(0);
  });

  it('a terminal asks: no → nothing runs (exit 1); yes → the run starts with its hooks', async () => {
    const no = await retake(['run', 'demo', 'agent'], ['n']);
    expect(no.questions).toEqual(['Run these 2 shell hooks, as listed?']);
    expect(no.code).toBe(EXIT.failure);
    expect(no.err).toContain('not run: the shell hooks of scenario agent were declined (nothing ran)');
    expect(fakes.runs).toHaveLength(0);
    const yes = await retake(['run', 'demo', 'agent'], ['y']);
    expect(yes.questions).toEqual(['Run these 2 shell hooks, as listed?']);
    expect(yes.code).toBe(EXIT.ok);
    expect(fakes.runs).toHaveLength(1);
    expect(fakes.runs[0]!.mode).toBe('capture');
  });

  it('--yes runs them without a question, and says so', async () => {
    const r = await retake(['run', 'demo', 'agent', '--yes']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.questions).toEqual([]);
    expect(r.err).toContain('the shell hooks are accepted by --yes');
    expect(fakes.runs).toHaveLength(1);
  });

  it('a dry run without its hooks, or --hooks skip, lists them and asks nothing; --dry --hooks run asks', async () => {
    const dry = await retake(['run', 'demo', 'agent', '--dry']);
    expect(dry.code).toBe(EXIT.ok);
    expect(dry.err).toContain('  setup 1 (seed): touch seeded.txt');
    expect(dry.err).toContain('not run (dry run): nothing asked');
    const skip = await retake(['run', 'demo', 'agent', '--hooks', 'skip']);
    expect(skip.code).toBe(EXIT.ok);
    expect(skip.err).toContain('not run (--hooks skip): nothing asked');
    expect(fakes.runs).toHaveLength(2);
    const dryHooks = await retake(['run', 'demo', 'agent', '--dry', '--hooks', 'run']);
    expect(dryHooks.code).toBe(EXIT.failure);
    expect(dryHooks.err).toContain('refused: the shell hooks of scenario agent');
    expect(fakes.runs).toHaveLength(2);
  });

  it('step hooks: the scenario’s named hook and the project.yaml hook its steps run', async () => {
    const r = await retake(['run', 'demo', 'steps']);
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toContain('  hook "mine" 1: touch mine.txt');
    expect(r.err).toContain('  hook "reset-cart" 1 (project.yaml): touch cart.txt');
    expect(r.err).toContain('the shell hooks of scenario steps (hook "mine" 1, hook "reset-cart" 1 (project.yaml)), last written by an agent, run only once');
    expect(r.err).not.toContain('health');
    expect(fakes.runs).toHaveLength(0);
  });

  it('--json: the listing and the refusal are log events on stdout', async () => {
    const r = await retake(['run', 'demo', 'agent', '--json']);
    expect(r.code).toBe(EXIT.failure);
    const events = r.out
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; level: string; message: string });
    expect(events.map((e) => e.level)).toEqual(['warn', 'error']);
    expect(events[0]!.message).toContain('\n  setup 1 (seed): touch seeded.txt');
    expect(events[1]!.message).toContain('pass --yes');
  });

  it('a scenario the person wrote (a CLI save, or never through Retake), or one without shell hooks: nothing listed, nothing asked', async () => {
    for (const name of ['personal', 'byhand', 'plain']) {
      const r = await retake(['run', 'demo', name]);
      expect(r.code, name).toBe(EXIT.ok);
      expect(r.err, name).not.toContain('shell hook');
      expect(r.questions, name).toEqual([]);
    }
    expect(fakes.runs).toHaveLength(3);
  });

  it('a later save by the person clears it; the agent writing the same hooks again does not bring them back; changed hooks do', async () => {
    const got = await mcp.scenarios.save('demo', 'later', AGENT('later'));
    expect((await retake(['run', 'demo', 'later'])).code).toBe(EXIT.failure);
    // The person saves it from a terminal (the same hooks, a comment added).
    const saved = await person.scenarios.save('demo', 'later', `# checked\n${AGENT('later')}`, { ifMatch: got.hash });
    const afterPerson = await retake(['run', 'demo', 'later']);
    expect(afterPerson.code).toBe(EXIT.ok);
    expect(afterPerson.err).not.toContain('shell hook');
    // The agent writes the same hooks again (its own text): still the person's hooks.
    const again = await mcp.scenarios.save('demo', 'later', AGENT('later'), { ifMatch: saved.hash });
    expect((await retake(['run', 'demo', 'later'])).code).toBe(EXIT.ok);
    // The agent changes a hook: asked again.
    await mcp.scenarios.save('demo', 'later', AGENT('later').replace('touch cleaned.txt', 'touch other.txt'), { ifMatch: again.hash });
    expect((await retake(['run', 'demo', 'later'])).code).toBe(EXIT.failure);
  });

  it('an edit by hand that leaves the hooks as they were keeps them the agent’s; one that changes the hooks makes them the person’s', async () => {
    const file = join(projectDir, 'scenarios', 'handed.yaml');
    await mcp.scenarios.save('demo', 'handed', AGENT('handed'));
    await writeFile(file, `${AGENT('handed')}# a comment, a caption: the hooks as they were\n`);
    const kept = await retake(['run', 'demo', 'handed']);
    expect(kept.code).toBe(EXIT.failure);
    expect(kept.err).toContain('the hooks of scenario handed were last written by an agent');
    await writeFile(file, AGENT('handed').replace('touch cleaned.txt', 'touch mine-now.txt'));
    const changed = await retake(['run', 'demo', 'handed']);
    expect(changed.code).toBe(EXIT.ok);
    expect(changed.err).not.toContain('shell hook');
  });

  it('the listing shows what will run: the command rendered with the scenario’s vars, its working folder and environment entries, a response-filled value as unknown, the run id the run gets', async () => {
    const r = await retake(['run', 'demo', 'rendered', '--yes']);
    expect(r.code).toBe(EXIT.ok);
    const runId = String(fakes.runs[0]!.runId);
    expect(runId).toMatch(/^\d{8}-\d{6}-rendered$/);
    const listing = r.err.split('\n');
    const from = listing.findIndex((l) => l.includes('the hooks of scenario rendered'));
    expect(listing.slice(from + 1, from + 12)).toEqual([
      '  setup 1: touch made-by-vars.txt',
      '      as written: {{vars.c}}',
      '  setup 2: git status',
      '      cwd: scenarios',
      '      env GIT_CONFIG_COUNT=1',
      '      env GIT_CONFIG_VALUE_0=touch made-by-env.txt',
      '      env WHERE=http://app.example.test/x',
      '        as written: {{app}}/x',
      `  setup 4: echo <unknown until the run: {{hooks.tok.body}}> ${runId}`,
      '      as written: echo {{hooks.tok.body}} {{run.id}}',
      "      filled at run time from an earlier hook's response, unknown now: {{hooks.tok.body}}",
    ]);
  });

  it('the listing writes out every hidden character, its later lines indented', () => {
    const t = (text: string) => ({ written: text, shown: text, unknown: [] });
    const { lines } = agentHooksListing('x', {
      by: { client: 'mcp', channel: 'mcp', trust: 'mcp' },
      at: '2026-11-12T10:00:00.000Z',
      hooks: [{ kind: 'shell', phase: 'setup', position: 1, run: t('echo a\u202e\nrm -rf b'), env: [{ name: 'A\u200b', value: t('v\u0007') }], rollback: t('true\u200b') }],
    });
    expect(lines).toEqual(['  setup 1: echo a\\u{202e}\n      rm -rf b', '      env A\\u{200b}=v\\u{7}', '      rollback: true\\u{200b}']);
  });

  it('a Studio write is said to be the Studio’s or an agent’s', () => {
    const { header } = agentHooksListing('x', { by: { client: 'ui', channel: 'studio', trust: 'mcp' }, at: '2026-11-12T10:00:00.000Z', hooks: [] });
    expect(header).toContain('the hooks of scenario x were last written through the Studio or by an agent (2026-11-12T10:00:00.000Z)');
  });

  it('the file named by its path is the same file', async () => {
    const r = await retake(['run', 'demo', join(projectDir, 'scenarios', 'agent.yaml')]);
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toContain('the hooks of scenario agent were last written by an agent');
  });

  it('from another workspace, the project given as a folder: the project’s own record still decides', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'retake-run-agent-hooks-elsewhere-'));
    try {
      const io = memoryIo();
      const code = await main(['node', 'retake', '--root', elsewhere, '--no-color', 'hooks', 'run', projectDir, 'agent:setup'], io);
      expect(code).toBe(EXIT.failure);
      expect(io.stderr()).toContain('refused: the shell hooks of scenario agent (setup 1 (seed)), last written by an agent');
      expect(existsSync(join(projectDir, 'seeded.txt'))).toBe(false);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('a record that cannot be read: asked, as when the writer cannot be told', async () => {
    const record = join(projectDir, '.retake', 'scenario-writes.jsonl');
    await chmod(record, 0o000);
    try {
      const r = await retake(['run', 'demo', 'byhand']);
      expect(r.code).toBe(EXIT.failure);
      expect(r.err).toContain("Retake cannot tell who wrote the hooks of scenario byhand (the project's record of scenario writes cannot be read");
      expect(r.err).toContain('whose writer Retake cannot tell, run only once a person says yes');
    } finally {
      await chmod(record, 0o600);
    }
  });
});

describe('retake hooks run <scenario>:setup|teardown: the same rule', () => {
  const marker = () => join(projectDir, 'seeded.txt');

  it('refused without a terminal and without --yes, declined at the question: the hook does not run', async () => {
    await rm(marker(), { force: true });
    const r = await retake(['hooks', 'run', 'demo', 'agent:setup']);
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toContain('  setup 1 (seed): touch seeded.txt');
    expect(r.err).toContain('refused: the shell hooks of scenario agent (setup 1 (seed)), last written by an agent, run only once a person says yes — answer in a terminal, or pass --yes');
    expect(r.err).not.toContain('teardown 1');
    const no = await retake(['hooks', 'run', 'demo', 'agent:setup'], ['n']);
    expect(no.questions).toEqual(['Run this shell hook, as listed?']);
    expect(no.code).toBe(EXIT.failure);
    expect(existsSync(marker())).toBe(false);
  });

  it('--dry lists without asking; yes at the question, or --yes, runs it', async () => {
    await rm(marker(), { force: true });
    const dry = await retake(['hooks', 'run', 'demo', 'agent:teardown', '--dry']);
    expect(dry.code).toBe(EXIT.ok);
    expect(dry.err).toContain('  teardown 1: touch cleaned.txt');
    expect(dry.err).toContain('not run (--dry): nothing asked');
    const yes = await retake(['hooks', 'run', 'demo', 'agent:setup'], ['y']);
    expect(yes.code).toBe(EXIT.ok);
    expect(existsSync(marker())).toBe(true);
    await rm(marker(), { force: true });
    const flag = await retake(['hooks', 'run', 'demo', 'agent:setup', '--yes']);
    expect(flag.code).toBe(EXIT.ok);
    expect(flag.questions).toEqual([]);
    expect(existsSync(marker())).toBe(true);
  });

  it('a scenario the person wrote: runs as before, nothing listed', async () => {
    await rm(marker(), { force: true });
    const r = await retake(['hooks', 'run', 'demo', 'personal:setup']);
    expect(r.code).toBe(EXIT.ok);
    expect(r.err).not.toContain('last written');
    expect(existsSync(marker())).toBe(true);
  });
});

describe('retake hooks trust: the person marks an agent’s hooks as theirs', () => {
  const recordLines = async () => (await readFile(join(projectDir, '.retake', 'scenario-writes.jsonl'), 'utf8')).split('\n').filter(Boolean).length;

  it('no terminal → refused; asked and declined → nothing written; yes → the next run does not ask; the agent changing them asks again', async () => {
    const first = await mcp.scenarios.save('demo', 'trustme', AGENT('trustme'));
    expect((await retake(['run', 'demo', 'trustme'])).code).toBe(EXIT.failure);
    const before = await recordLines();
    const refused = await retake(['hooks', 'trust', 'demo', 'trustme']);
    expect(refused.code).toBe(EXIT.failure);
    expect(refused.err).toContain('  setup 1 (seed): touch seeded.txt');
    expect(refused.err).toContain("refused: marking the hooks of scenario trustme as yours takes a person's yes — answer in a terminal, or pass --yes");
    const no = await retake(['hooks', 'trust', 'demo', 'trustme'], ['n']);
    expect(no.questions).toEqual(['Mark these 2 shell hooks as yours, as listed (runs no longer ask until they change)?']);
    expect(no.code).toBe(EXIT.failure);
    expect(await recordLines()).toBe(before);
    expect((await retake(['run', 'demo', 'trustme'])).code).toBe(EXIT.failure);
    const yes = await retake(['hooks', 'trust', 'demo', 'trustme'], ['y']);
    expect(yes.code).toBe(EXIT.ok);
    expect(await recordLines()).toBe(before + 1);
    const line = JSON.parse((await readFile(join(projectDir, '.retake', 'scenario-writes.jsonl'), 'utf8')).trim().split('\n').at(-1)!) as { path: string; by: unknown };
    expect(line).toMatchObject({ path: 'scenarios/trustme.yaml', by: { client: 'cli', channel: 'cli', trust: 'author' } });
    const after = await retake(['run', 'demo', 'trustme']);
    expect(after.code).toBe(EXIT.ok);
    expect(after.err).not.toContain('shell hook');
    // A hand edit that leaves the hooks as they were: still the person's.
    await writeFile(join(projectDir, 'scenarios', 'trustme.yaml'), `${AGENT('trustme')}# a note\n`);
    expect((await retake(['run', 'demo', 'trustme'])).code).toBe(EXIT.ok);
    expect((await retake(['hooks', 'trust', 'demo', 'trustme'])).err).toContain('are already yours');
    // The agent changes a hook: asked again.
    const text = await readFile(join(projectDir, 'scenarios', 'trustme.yaml'), 'utf8');
    void first;
    await mcp.scenarios.save('demo', 'trustme', AGENT('trustme').replace('touch cleaned.txt', 'touch changed.txt'), { ifMatch: createHash('sha256').update(text).digest('hex') });
    expect((await retake(['run', 'demo', 'trustme'])).code).toBe(EXIT.failure);
  });
});
