/**
 * L3.4 recording acceptance through MCP (slow: gated by RETAKE_TEST_SLOW=1 — `pnpm test:slow`). An SDK client
 * drives `retake mcp` (spawned from the sources over stdio) on a copy of projects/northfield-fixture pointed at the
 * fixture product on free ports. No human in CI: the worker that runs the `record` job lives in this process and its
 * injected driver plays the person in a headless "headed" window (Playwright input is trusted, as a person's) — the
 * real window is MACOS-CHECKLIST 12f. Claude's side is scripted with no model:
 *   scenario_record {page: shop} → the person performs the quote flow (scroll, a lot, Request a quote, Increase ×2, two
 *   selects, the date picker, a message, Send request), then types a sentinel into the recording lab's password field
 *   (opened from the address bar) and closes the window → job_status returns the draft (under `untrusted`) with its
 *   counts and check replay (trusted) → scenario_validate of the draft → run_dry of the saved draft on a reset fixture
 *   succeeds. The sentinel is in no tool output, job file, worker log, history line, recording file or scenario.
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { historyFile, jobsDir, readWorkerLock, runWorker, workersDir } from '@retake/engine';
import type { RecordJobTestHooks } from '@retake/engine';
import { REPO } from '../../engine/test/helpers.js';
import { testChildEnv } from '../../core/test/child-env.js';

const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const FIXTURE_PROJECT = join(REPO, 'projects', 'northfield-fixture');
const GENERATED = new Set(['runs', 'renders', 'review', 'exports', '.retake', 'frames']);
const ENABLED = process.env.RETAKE_TEST_SLOW === '1';
const KEEP = process.env.RETAKE_ACCEPTANCE_KEEP;
const PROJECT = 'northfield-fixture';
const STEP = 300_000;

type Page = Parameters<NonNullable<RecordJobTestHooks['drive']>>[0];
type Block = { type: string; text?: string };
type Result = { content: Block[]; structuredContent?: Record<string, unknown>; isError?: boolean };

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let root: string;
let client: Client;
let stderr = '';
const outputs: string[] = [];
const savedHome = process.env.RETAKE_HOME;

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: STEP })) as Result;
  outputs.push(JSON.stringify(r));
  expect(r.isError, `${name}: ${r.content[0]?.text}`).toBeFalsy();
  return r;
}
const summary = (r: Result) => r.content[0]?.text ?? '';

/** Everything but the `untrusted` subtrees. */
function trustedPart(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(trustedPart);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'untrusted').map(([k, x]) => [k, trustedPart(x)]));
  return v;
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else out.push(join(d, e.name));
    }
  };
  if (existsSync(dir)) await walk(dir);
  return out;
}

/** The person: the quote flow on the shop, then a password typed in the recording lab (opened from the address bar). */
async function person(page: Page, sentinel: string): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(800);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(800);
  await page.getByText('Selowa Ridge').first().click();
  await page.getByRole('button', { name: 'Request a quote' }).waitFor();
  await page.waitForTimeout(1800);
  await page.getByRole('button', { name: 'Request a quote' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('dialog').getByLabel('Increase').click();
  await page.getByRole('dialog').getByLabel('Increase').click();
  await page.getByRole('combobox', { name: 'Bag size' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('option', { name: '5 kg' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('combobox', { name: 'Grind' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('option', { name: 'Whole bean' }).click();
  await page.waitForTimeout(300);
  await page.getByLabel('Delivery window').click();
  await page.waitForTimeout(400);
  await page.getByLabel('Next month').click();
  await page.waitForTimeout(300);
  await page.getByLabel('10 January 2027').click();
  await page.waitForTimeout(200);
  await page.getByLabel('24 January 2027').click();
  // The popover closes 420 ms after the second date and gives the focus back to its trigger: a person waits for it to
  // go before clicking the next field (else, on a loaded machine, the focus can land on the trigger after the click).
  await page.getByLabel('Choose a delivery window').waitFor({ state: 'hidden' });
  await page.getByLabel('Message').click();
  await page.waitForFunction(() => document.activeElement?.id === 'quote-message', null, { timeout: 5000 });
  await page.keyboard.type('Light roast for filter, please.');
  await page.getByRole('dialog').getByText('Send request').click();
  await page.getByText('Quote request sent').waitFor();
  // A person reaches for the address bar a moment later (a navigation within ~1 s of a press is taken for its effect).
  await page.waitForTimeout(1500);
  await page.goto(new URL('/record-lab', page.url()).href);
  await page.getByRole('heading', { name: 'Recording lab' }).waitFor();
  await page.waitForTimeout(800);
  await page.locator('#lab-password').click();
  await page.keyboard.type(sentinel);
  await page.waitForTimeout(400);
  await page.close();
}

describe.skipIf(!ENABLED)('recording acceptance through MCP: scenario_record → draft → validate → run_dry (RETAKE_TEST_SLOW=1)', () => {
  beforeAll(async () => {
    const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host?: string }): Promise<Fixture> };
    fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
    root = await mkdtemp(join(tmpdir(), 'studio-mcp-record-acc-'));
    process.env.RETAKE_HOME = join(root, '.home');
    await writeFile(join(root, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    const project = join(root, 'projects', PROJECT);
    await cp(FIXTURE_PROJECT, project, { recursive: true, filter: (src) => !GENERATED.has(src.slice(FIXTURE_PROJECT.length + 1).split('/')[0]) });
    const yaml = await readFile(join(project, 'project.yaml'), 'utf8');
    await writeFile(
      join(project, 'project.yaml'),
      yaml.replaceAll('http://localhost:4401', fixture.urls.console.replace(/\/$/, '')).replaceAll('http://localhost:4402', fixture.urls.shop.replace(/\/$/, '')),
    );
    await symlink(join(REPO, 'fixtures'), join(root, 'fixtures'));
    await mkdir(join(root, '.retake'), { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--conditions=source', '--import', 'tsx', BIN, '--root', root, 'mcp'],
      cwd: REPO,
      env: testChildEnv({ RETAKE_HOME: join(root, '.home'), RETAKE_WORKER_IDLE_MS: '5000' }),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    client = new Client({ name: 'retake-record', version: '0' }, { capabilities: {} });
    await client.connect(transport);
  }, 120_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    const w = root ? readWorkerLock(root) : null;
    if (w && w.pid !== process.pid) {
      try {
        process.kill(w.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    await fixture?.close();
    if (root) await rm(root, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = savedHome;
  });

  it('the person records the quote flow; the draft validates and dry-runs; the typed password is nowhere', async () => {
    const sentinel = `Sentinel-${randomBytes(8).toString('hex')}`;
    await fetch(`${fixture.urls.console}/api/reset`, { method: 'POST' });
    // The worker of this process runs the record job (the server sees it alive and spawns none); it exits once idle.
    const worker = runWorker({
      root,
      idleExitMs: 5_000,
      pollMs: 100,
      log: () => undefined,
      recordTest: { headless: true, windowSize: { width: 1400, height: 1000 }, drive: (page) => person(page, sentinel) },
    });
    await new Promise((r) => setTimeout(r, 300));

    // 1. Claude starts the recording and tells the user what to do.
    const started = await call('scenario_record', { project: PROJECT, page: 'shop', scenario: 'quote-recorded' });
    expect(summary(started)).toMatch(/Ask the user to perform the flow there and close the window when done — you do not drive it/);
    const jobId = (started.structuredContent as { job: { id: string } }).job.id;

    // 2. It follows the job until the window is closed and the draft checked.
    let r = await call('job_status', { job_id: jobId, wait_s: 25 });
    for (let i = 0; i < 12 && ['queued', 'running'].includes((r.structuredContent as { job: { state: string } }).job.state); i++) r = await call('job_status', { job_id: jobId, wait_s: 25 });
    const d = r.structuredContent as {
      job: { state: string };
      saved: { file: string; hash: string } | null;
      access: string;
      stats: { scenes: number; steps: number; secrets: number };
      writes: { total: number; by_steps: number };
      check: { status: string; scope: string; steps_passed: number; steps_total: number };
      untrusted: { draft_lines: string[]; scenes: Array<{ id: string; opens: boolean }>; first_write?: { scene: string; step: number }; check?: { until?: string } };
    };
    expect(d.job.state, summary(r)).toBe('succeeded');
    expect(d.saved?.file).toBe('scenarios/quote-recorded.yaml');
    expect(d.access).toBe('read-write');
    expect(d.stats.secrets).toBe(1);
    expect(d.writes).toMatchObject({ total: 1, by_steps: 1 });
    expect(d.check).toMatchObject({ status: 'passed', scope: 'until_write' });
    expect(d.check.steps_passed).toBe(d.check.steps_total);
    expect(d.check.steps_total).toBeGreaterThan(8);
    expect(d.untrusted.scenes.map((s) => [s.id, s.opens])).toEqual([
      ['home', true],
      ['products', false],
      ['record-lab', true],
    ]);
    const draft = `${d.untrusted.draft_lines.join('\n')}\n`;
    expect(draft).toMatch(/^version: 1$/m);
    expect(draft).not.toMatch(/https?:/);
    expect(draft).toMatch(/select: .*Bag size.*5 kg/);
    expect(draft).toMatch(/select: .*Grind.*Whole bean/);
    expect(draft).toContain('Light roast for filter, please.');
    expect(draft).toContain('{{vars.password_1}}');
    expect(draft).toContain('password_1: CHANGE-ME');
    // Typed text only under `untrusted`.
    expect(summary(r)).not.toContain('Light roast');
    expect(JSON.stringify(trustedPart(r.structuredContent))).not.toContain('Light roast');

    // 3. Claude validates the draft it read, then dry-runs the saved scenario on a reset fixture.
    const v = await call('scenario_validate', { project: PROJECT, yaml: draft, name: 'quote-recorded' });
    expect(summary(v)).toMatch(/^Valid/);
    await fetch(`${fixture.urls.console}/api/reset`, { method: 'POST' });
    let run = await call('run_dry', { project: PROJECT, scenario: 'quote-recorded', wait_s: 25 });
    const runId = (run.structuredContent as { id: string }).id;
    for (let i = 0; i < 12 && !(run.structuredContent as { finished?: boolean }).finished; i++) run = await call('run_status', { project: PROJECT, run_id: runId, wait_s: 25 });
    expect(run.structuredContent, summary(run)).toMatchObject({ status: 'succeeded' });
    const rs = run.structuredContent as { steps_done: number; steps_total: number };
    expect(rs.steps_done).toBe(rs.steps_total);
    expect(rs.steps_total).toBe(d.stats.steps);
    await worker;
    if (KEEP) {
      await mkdir(KEEP, { recursive: true });
      await writeFile(join(KEEP, 'quote-recorded.yaml'), draft);
      await writeFile(join(KEEP, 'record-summary.txt'), `${summary(r)}\n\nrun_dry: ${summary(run)}\n`);
    }

    // 4. The password typed in the window: in no tool output, job file, worker log, history line, recording or scenario.
    const all = [
      ...(await files(jobsDir(root))),
      ...(await files(workersDir(root))),
      historyFile(root),
      ...(await files(join(root, 'projects', PROJECT, '.retake', 'records'))),
      ...(await files(join(root, 'projects', PROJECT, 'scenarios'))),
    ];
    expect(all.length).toBeGreaterThan(5);
    for (const f of all.filter((x) => existsSync(x))) expect((await readFile(f)).includes(sentinel), f).toBe(false);
    expect(outputs.join('\n')).not.toContain(sentinel);
    expect(stderr).not.toContain(sentinel);
  }, 900_000);
});
