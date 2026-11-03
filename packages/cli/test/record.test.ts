/**
 * L3.4 `retake record` (R-MCP-24) end to end on the fixture product: the command with Playwright standing in for the
 * person (the command's test hooks: a headless "headed" window) prints the summary — actions, scenes, the saved file,
 * the check replay, the next command — or the outcome as JSON; a window closed at once records nothing (exit 1); a URL
 * of another origin is refused before any window opens. Typed text is never printed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, main, memoryIo } from '../src/index.js';
import { recordCommand } from '../src/commands/record.js';
import type { RecordTestHooks } from '../src/commands/record.js';
import { Ui } from '../src/ui.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

interface Fixture {
  urls: { console: string; shop: string };
  close(): Promise<void>;
}

let fixture: Fixture;
let ws: string;
const home = process.env.RETAKE_HOME;

beforeAll(async () => {
  const mod = (await import(join(REPO, 'fixtures/wholesale/server.mjs'))) as { startFixture(o: { consolePort: number; shopPort: number; host: string }): Promise<Fixture> };
  fixture = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1' });
  ws = await mkdtemp(join(tmpdir(), 'studio-cli-record-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
  const dir = join(ws, 'projects', 'shop');
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(
    join(dir, 'project.yaml'),
    `version: 1\nname: Shop\nenvironments:\n  local:\n    shop: ${fixture.urls.shop.replace(/\/$/, '')}\n    console: ${fixture.urls.console.replace(/\/$/, '')}\ncapture: {width: 1280, height: 800}\n`,
  );
}, 60_000);

afterAll(async () => {
  await fixture?.close();
  if (ws) await rm(ws, { recursive: true, force: true });
  if (home === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = home;
});

/** `retake record` in-process, the window played by `drive`. */
async function record(args: { name?: string; json?: boolean; path?: string }, drive: NonNullable<RecordTestHooks['drive']>) {
  const io = memoryIo();
  const hooks: RecordTestHooks = {
    headless: true,
    windowSize: { width: 1280, height: 900 },
    drive: async (page) => {
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(800);
      await drive(page);
      await page.waitForTimeout(300).catch(() => undefined);
      await page.close().catch(() => undefined);
    },
  };
  const code = await recordCommand(new Ui(io), { root: ws }, 'shop', args.name, { page: 'shop', ...(args.path ? { path: args.path } : {}), ...(args.json ? { json: true } : {}) }, hooks);
  return { code, out: io.stdout(), err: io.stderr() };
}

describe('retake record', () => {
  it('records, saves and checks a draft; prints counts, scenes, the saved file and the next command — never the typed text', async () => {
    const r = await record({ name: 'first' }, async (page) => {
      await page.getByText('Selowa Ridge').first().click();
      await page.getByRole('button', { name: 'Request a quote' }).click();
      await page.getByLabel('Message').click();
      await page.keyboard.type('Typed words stay in the draft');
    });
    expect(r.code, r.err).toBe(EXIT.ok);
    expect(r.err).toContain('a browser window is open on');
    expect(r.err).toMatch(/recorded 4 actions in .* → 2 scenes, 3 steps \(env local, signed out, read-write\)/);
    expect(r.err).toMatch(/scene home +1 step \(opens its page\)/);
    expect(r.err).toContain('saved scenarios/first.yaml');
    expect(r.err).toMatch(/check replay: 3\/3 steps passed — it started from the state the recording left/);
    expect(r.err).toMatch(/next +retake .*run shop first --dry/);
    expect(r.err + r.out).not.toContain('Typed words');
    expect(await readFile(join(ws, 'projects', 'shop', 'scenarios', 'first.yaml'), 'utf8')).toContain('text: Typed words stay in the draft');
  }, 120_000);

  it('--json prints the outcome; a taken name is kept, not saved', async () => {
    const r = await record({ name: 'first', json: true }, async (page) => {
      await page.getByText('Selowa Ridge').first().click();
    });
    expect(r.code, r.err).toBe(EXIT.ok);
    const o = JSON.parse(r.out) as Record<string, unknown>;
    expect(o).toMatchObject({ name: 'first', saved: null, not_saved: 'name_taken', env: 'local', persona: null, access: 'read-write', stop: 'closed', check: { status: 'passed', scope: 'all' } });
    expect(Object.keys(o)).toEqual(expect.arrayContaining(['rec_id', 'dir', 'draft', 'counts', 'stats', 'scenes', 'issues', 'warnings', 'writes']));
  }, 120_000);

  it('a window closed at once records nothing (exit 1); a URL of another origin is refused before any window opens', async () => {
    const r = await record({}, async () => undefined);
    expect(r.code).toBe(EXIT.failure);
    expect(r.err).toContain('nothing recorded');
    const io = memoryIo();
    const code = await main(['node', 'retake', '--root', ws, 'record', 'shop', '--url', 'http://elsewhere.example/'], io);
    expect(code).toBe(EXIT.failure);
    expect(io.stderr()).toMatch(/origin is not one of environment local's pages/);
  }, 120_000);
});
