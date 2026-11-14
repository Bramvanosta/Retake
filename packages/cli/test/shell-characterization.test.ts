/**
 * What `retake validate`, `retake list`, `retake auth status`, `retake new`'s refusal and `retake init` print, pinned byte for byte —
 * the text, the exit code and the `--json` shape: a published surface. The work behind them moved into the engine
 * (the commands keep their parsing, printing and exit codes), and this file holds that the move changed nothing a
 * reader sees. The workspace's temporary folder and the Retake home are written as `<ws>` and `<home>`.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratchHome } from '@retake/test-support/home';
import { main, memoryIo } from '../src/index.js';

const TEMPLATES = fileURLToPath(new URL('../../../templates', import.meta.url));
const PINNED = fileURLToPath(new URL('./fixtures/shell-characterization.json', import.meta.url));

let ws: string;
let home: string;
const homes = scratchHome();

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'retake-shell-pin-'));
  home = join(ws, 'home');
  homes.use(home);
  await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(TEMPLATES)}\n`);
  const shop = join(ws, 'projects', 'shop');
  await mkdir(join(shop, 'scenarios'), { recursive: true });
  await writeFile(
    join(shop, 'project.yaml'),
    [
      'name: Shop',
      'environments:',
      '  staging: {app: "https://app.staging.example.com"}',
      'auth:',
      '  staging:',
      '    login_url: /login',
      '    personas:',
      '      editor: {pages: [app], check: {expect_text: Jane}}',
      '      viewer: {pages: [app]}',
      '',
    ].join('\n'),
  );
  await writeFile(join(shop, 'scenarios', 'good.yaml'), 'video: good\nscenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - click: Sign in\n');
  // An error and a warning: the loader reports the error, the file parsed again lists the warning too.
  await writeFile(join(shop, 'scenarios', 'bad.yaml'), 'video: bad\nscenes:\n  - id: home\n    page: app\n    open: /\n    steps:\n      - clik: Sign in\n      - wait: 99\n');
  await writeFile(join(shop, 'scenarios', 'broken.yaml'), 'video: [unclosed\n');
  const odd = join(ws, 'projects', 'odd');
  await mkdir(join(odd, 'scenarios'), { recursive: true });
  await writeFile(join(odd, 'project.yaml'), 'name: Odd\ntemplate: no-such-theme\nenvironments:\n  prod: {app: "https://app.example.com", bogus: 3}\n');
});

afterAll(async () => {
  homes.restore();
  await rm(ws, { recursive: true, force: true });
});

const CASES: Array<[string, string[]]> = [
  ['validate shop', ['validate', 'shop']],
  ['validate shop --json', ['validate', 'shop', '--json']],
  ['validate shop good', ['validate', 'shop', 'good']],
  ['validate shop bad --env staging', ['validate', 'shop', 'bad', '--env', 'staging']],
  ['validate shop missing', ['validate', 'shop', 'missing']],
  ['validate odd --json', ['validate', 'odd', '--json']],
  ['validate nope', ['validate', 'nope']],
  ['list', ['list']],
  ['list --json', ['list', '--json']],
  ['auth status', ['auth', 'status']],
  ['auth status --json', ['auth', 'status', '--json']],
  ['auth status --project shop --env staging', ['auth', 'status', '--project', 'shop', '--env', 'staging']],
  ['auth status --env staging', ['auth', 'status', '--env', 'staging']],
  ['new shop', ['new', 'shop']],
];

/** `retake init` on a new folder, on the workspace itself, on a folder that is not empty, on a file (made at run time: their paths). */
const INITS = (): Array<[string, string[]]> => [
  ['init fresh', ['init', join(ws, 'fresh')]],
  ['init the workspace', ['init', ws]],
  ['init a folder not empty', ['init', join(ws, 'projects')]],
  ['init a file', ['init', join(ws, 'projects', 'shop', 'project.yaml')]],
];

async function outputs(): Promise<Record<string, { code: number; out: string; err: string }>> {
  const named = (s: string) => s.replaceAll(home, '<home>').replaceAll(ws, '<ws>').replaceAll(TEMPLATES, '<templates>');
  const out: Record<string, { code: number; out: string; err: string }> = {};
  for (const [name, args] of [...CASES, ...INITS()]) {
    const io = memoryIo();
    const code = await main(['node', 'retake', '--root', ws, ...args], io);
    out[name] = { code, out: named(io.stdout()), err: named(io.stderr()) };
  }
  return out;
}

describe('the shell commands: their whole output, pinned', () => {
  it('validate, list, auth status, new and init print what they printed, with the same exit codes', async () => {
    expect(await outputs()).toEqual(JSON.parse(await readFile(PINNED, 'utf8')));
  });
});
