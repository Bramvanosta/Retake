/**
 * L4.2 part 1: what the Studio's scenario screen reads before any click (engine.scenarios.check) and the reads behind
 * it.
 *
 * - critique #6 / B2: a scenario's own issues are validated WITHOUT agent trust (a person's `{{env:…}}` is valid in
 *   their file), and apart from them `run_blockers` say what would refuse a dry run and a capture submitted from this
 *   client — the submit's own gates run without stopping at the first, nothing queued: the blockers ARE the submit's
 *   refusals. Worded for the client: never "MCP" for the Studio (`ui`), unchanged for MCP.
 * - BL-79 residue: README.md and scenarios are read with core readPlainFile behind the realpath check — a FIFO is
 *   refused without blocking, a file over 2 MiB is "too large" (never "not found"), a link out stays refused; a run
 *   submit reads its scenario the same way first.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineError, READ_TEXT_MAX_BYTES, createEngine, sessionsToConfirm } from '../src/index.js';
import type { Engine, RunBlocker } from '../src/index.js';
import { fixtureWorkspace } from '@retake/test-support/workspace';
import { scratchHome } from '@retake/test-support/home';

let ws: string;
let ui: Engine;
let mcp: Engine;
const P = 'northfield-fixture';
const retakeHome = scratchHome();
const PERSON = 'video: person\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - type: {into: {label: Token}, text: "{{env:API_KEY}}"}\n';

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(EngineError);
  return e as EngineError;
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'studio-scenario-check-'));
  retakeHome.use(join(ws, '.home'));
  await fixtureWorkspace(ws);
  ui = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
});

afterAll(async () => {
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('scenarios.check: own issues and run blockers (B2)', () => {
  it('the fixture from the Studio: every scenario valid; dry runs unblocked; captures of catalogue, off-camera and quote need the terminal — worded for the Studio', async () => {
    const names = (await ui.projects.get(P)).scenarios;
    expect(names.length).toBe(15);
    const blocked: Record<string, string[]> = {};
    for (const name of names) {
      const c = await ui.scenarios.check(P, name);
      expect([name, c.ok, c.file, c.hash]).toEqual([name, true, `scenarios/${name}.yaml`, expect.stringMatching(/^[0-9a-f]{64}$/)]);
      expect(c.yaml.length).toBeGreaterThan(0);
      expect(c.run_blockers.dry, name).toEqual([]);
      if (c.run_blockers.capture.length) blocked[name] = c.run_blockers.capture.map((b) => b.code);
      for (const b of c.run_blockers.capture) {
        expect(b.message, name).not.toMatch(/MCP|elicitation/);
        expect(b.message, name).toContain('The Studio cannot approve hooks yet: run it in a terminal');
        expect(b.fix, name).toMatch(new RegExp(`^retake -C .* run ${P} ${name}$`));
      }
    }
    // off-camera (L5.8): its named hook's shell entry needs a person, like a setup hook's.
    expect(blocked).toEqual({ catalogue: ['needs_approval'], 'off-camera': ['needs_approval'], quote: ['needs_approval'] });
    const quote = await ui.scenarios.check(P, 'quote');
    expect(quote.run_blockers.capture[0].message).toBe(
      'the capture of scenario quote has hooks a human must approve before they run: setup hook 2 "prepare-proposal" (its rollback: HTTP DELETE). The Studio cannot approve hooks yet: run it in a terminal',
    );
  });

  it('the blockers are the submit’s refusals: each blocked submit fails with the first blocker; each unblocked one queues (then cancelled)', async () => {
    for (const name of (await ui.projects.get(P)).scenarios) {
      const { run_blockers } = await ui.scenarios.check(P, name);
      for (const mode of ['dry', 'capture'] as const) {
        const want: RunBlocker[] = run_blockers[mode];
        // The personas a capture must confirm are confirmed (the sessions_ack admission rule is not a blocker).
        const ack = mode === 'capture' ? sessionsToConfirm(await ui.auth.forScenario(P, name, { mode })).map((p) => p.persona) : [];
        const got = await ui.runs.submit({ project: P, scenario: name, mode, ...(ack.length ? { sessions_ack: ack } : {}) }).then(
          (r) => r,
          (e: unknown) => e as EngineError,
        );
        if (want.length) {
          expect(got, `${name} ${mode}`).toBeInstanceOf(EngineError);
          const e = got as EngineError;
          expect([e.code, e.message, e.fix], `${name} ${mode}`).toEqual([want[0].code, want[0].message, want[0].fix]);
        } else {
          expect(got, `${name} ${mode}`).not.toBeInstanceOf(EngineError);
          const r = got as Awaited<ReturnType<Engine['runs']['submit']>>;
          expect(r.job.input.submitted_by).toBe('ui');
          await ui.runs.cancel(P, r.run_id);
        }
      }
    }
  });

  it('through MCP the wording stays the MCP one (the rules are the same)', async () => {
    const c = await mcp.scenarios.check(P, 'catalogue');
    expect(c.run_blockers.capture[0].message).toContain('This MCP client cannot ask its user (no elicitation support)');
    expect(c.run_blockers.dry).toEqual([]);
  });

  it('a person’s scenario with {{env:…}}: valid for the screen (no agent trust), refused to run from the Studio — "from the Studio", never "MCP"', async () => {
    await writeFile(join(ws, 'projects', P, 'scenarios', 'person.yaml'), PERSON);
    const c = await ui.scenarios.check(P, 'person');
    expect([c.ok, c.issues.filter((i) => i.severity === 'error')]).toEqual([true, []]);
    for (const mode of ['dry', 'capture'] as const) {
      expect(c.run_blockers[mode].map((b) => b.code)).toEqual(['refused']);
      expect(c.run_blockers[mode][0].message).toMatch(/^refused from the Studio: the scenario uses \{\{env:API_KEY\}\}: from the Studio a scenario never resolves a secret/);
      expect(c.run_blockers[mode][0].message).not.toContain('MCP');
    }
    // Validation from the Studio's editor path (validate) keeps agent trust: there it is an error.
    expect((await ui.scenarios.validate(P, PERSON)).ok).toBe(false);
    const m = await mcp.scenarios.check(P, 'person');
    expect(m.run_blockers.dry[0].message).toMatch(/^refused through MCP: /);
  });

  it('an invalid scenario: its issues, and the same refusal blocks both runs', async () => {
    await writeFile(join(ws, 'projects', P, 'scenarios', 'broken.yaml'), 'video: broken\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - clik: Save\n');
    const c = await ui.scenarios.check(P, 'broken');
    expect(c.ok).toBe(false);
    expect(c.issues.map((i) => i.message)).toContain('unknown action "clik" (did you mean "click"?)');
    expect(c.run_blockers.dry.map((b) => b.code)).toEqual(['invalid']);
    expect(c.run_blockers.capture).toEqual(c.run_blockers.dry);
    expect((await refusal(ui.scenarios.check(P, 'nope'))).code).toBe('not_found');
  });
});

describe('safe small-file reads (BL-79 residue): FIFO, size cap, links', () => {
  it('a FIFO named as a scenario: get, check and a run submit refuse it at once (never wait on it)', async () => {
    execFileSync('mkfifo', [join(ws, 'projects', P, 'scenarios', 'pipe.yaml')]);
    const t0 = Date.now();
    for (const call of [() => ui.scenarios.get(P, 'pipe'), () => ui.scenarios.check(P, 'pipe'), () => ui.runs.submit({ project: P, scenario: 'pipe', mode: 'dry' })]) {
      const e = await refusal(call());
      expect([e.code, e.message]).toEqual(['refused', expect.stringContaining('is not a regular file (a FIFO, a device, a folder…): not read')]);
    }
    expect(Date.now() - t0).toBeLessThan(2000);
  }, 10_000);

  it('a scenario over 2 MiB is "too large" (invalid), not "not found"; at the cap it reads', async () => {
    const head = 'video: big\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 1\n';
    await writeFile(join(ws, 'projects', P, 'scenarios', 'big.yaml'), `${head}#${'x'.repeat(READ_TEXT_MAX_BYTES)}\n`);
    const e = await refusal(ui.scenarios.get(P, 'big'));
    expect([e.code, e.message, e.details?.reason]).toEqual(['invalid', expect.stringMatching(/big\.yaml is too large: [\d,]+ bytes, at most 2,097,152 — not read$/), 'too_large']);
    await writeFile(join(ws, 'projects', P, 'scenarios', 'big.yaml'), `${head}#${'x'.repeat(READ_TEXT_MAX_BYTES - head.length - 2)}\n`);
    expect((await ui.scenarios.get(P, 'big')).yaml.length).toBe(READ_TEXT_MAX_BYTES);
  });

  it('README.md as a FIFO or over the cap: the project still opens, readme_error says why', async () => {
    const readme = join(ws, 'projects', P, 'README.md');
    await rm(readme);
    execFileSync('mkfifo', [readme]);
    const t0 = Date.now();
    expect((await ui.projects.get(P)).readme_error).toBe('README.md is not a regular file (a FIFO, a device, a folder…): not read (replace it with a regular file)');
    expect(Date.now() - t0).toBeLessThan(2000);
    await rm(readme);
    await writeFile(readme, 'x'.repeat(READ_TEXT_MAX_BYTES + 1));
    const view = await ui.projects.get(P);
    expect([view.readme, view.readme_error]).toEqual([null, 'README.md is too large to show here (over 2,097,152 bytes): shorten it in an editor']);
    await writeFile(readme, '# Northfield\n');
    expect((await ui.projects.get(P)).readme).toBe('# Northfield\n');
  }, 10_000);

  it('a scenario linked out of the project: check and a run submit refuse it (the submit used to follow it)', async () => {
    const outside = join(ws, 'outside.yaml');
    await writeFile(outside, 'video: out\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      - hold: 1\n');
    await symlink(outside, join(ws, 'projects', P, 'scenarios', 'out.yaml'));
    for (const call of [() => ui.scenarios.check(P, 'out'), () => ui.runs.submit({ project: P, scenario: 'out', mode: 'dry' }), () => mcp.runs.submit({ project: P, scenario: 'out', mode: 'dry' })]) {
      const e = await refusal(call());
      expect([e.code, e.message]).toEqual(['refused', expect.stringContaining('leads out of the project folder (a symbolic link): not read')]);
      expect(e.message).not.toContain(outside);
    }
  });
});
