/**
 * At a terminal: `retake project export` / `import` / `trust` (R-SHR-34, R-SHR-36, R-SHR-37). In process (main +
 * memoryIo), two scratch workspaces; nothing runs or renders.
 * - export prints what goes in and what the project needs (names only); `--json` the engine's answer;
 * - import lands the project untrusted and lists its code files; every command that runs its code is refused before it
 *   starts (the preAction gate), reads pass;
 * - trust: a y/N at a terminal, always (refused without one, no `--yes` in any shell; a no writes nothing), `--list`
 *   lists only, `--discard` sets the folder aside on a yes;
 * - the gate judges a link to an import as the import, and a folder named by path when no workspace opens.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { productPorts } from '@retake/compose';
import { EXIT, main, memoryIo } from '../src/index.js';

let a: string;
let b: string;
const proj = (root: string, slug = 'demo') => join(root, 'projects', slug);
/** A person's shell (no agent variables), or an agent's. */
const PERSON = { ...process.env, CLAUDECODE: undefined, RETAKE_AGENT: undefined };
const AGENT = { ...PERSON, RETAKE_AGENT: '1', CLAUDECODE: '1' };

async function retake(root: string, args: string[], o: { answers?: string[]; env?: Record<string, string | undefined> } = {}) {
  const io = memoryIo(o.answers ? { answers: o.answers } : {});
  const code = await main(['node', 'retake', '--root', root, ...args], io, productPorts({ env: o.env ?? PERSON }));
  return { code, out: io.stdout(), err: io.stderr(), questions: io.questions() };
}

beforeEach(async () => {
  a = await mkdtemp(join(tmpdir(), 'retake-archive-cli-a-'));
  b = await mkdtemp(join(tmpdir(), 'retake-archive-cli-b-'));
  for (const r of [a, b]) {
    await writeFile(join(r, 'retake.yaml'), 'projects_dir: projects\n');
    await mkdir(join(r, 'projects'), { recursive: true });
  }
  await mkdir(join(proj(a), 'scenarios'), { recursive: true });
  await mkdir(join(proj(a), 'hooks'), { recursive: true });
  await writeFile(join(proj(a), 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\n');
  await writeFile(join(proj(a), 'scenarios', 'quote.yaml'), 'video: quote\nscenes:\n  - id: a\n    page: app\n    steps:\n      - hold: 1\n');
  await writeFile(join(proj(a), 'hooks', 'reset.sh'), 'echo "{{env:DEMO_TOKEN}}"\n');
  await writeFile(join(proj(a), '.env'), 'DEMO_TOKEN=secret\n');
});

afterEach(async () => {
  for (const r of [a, b]) await rm(r, { recursive: true, force: true });
});

async function exported(): Promise<string> {
  const r = await retake(a, ['project', 'export', 'demo', '--json']);
  expect(r.code, r.err).toBe(EXIT.ok);
  return JSON.parse(r.out).file as string;
}

describe('retake project export / import / trust', () => {
  it('export says what goes in and what is needed; import lands it untrusted with its code files listed', async () => {
    const words = await retake(a, ['project', 'export', 'demo', '--dry-run']);
    expect(words.code, words.err).toBe(EXIT.ok);
    expect(words.out + words.err).toMatch(/would export 3 files/);
    expect(words.out + words.err).toMatch(/left out: \.env/);
    expect(words.out + words.err).toMatch(/environment variables: DEMO_TOKEN/);
    const file = await exported();
    const imp = await retake(b, ['project', 'import', file, '--as', 'shared']);
    expect(imp.code, imp.err).toBe(EXIT.ok);
    const text = imp.out + imp.err;
    expect(text).toMatch(/project shared imported: .* — exported as demo/);
    expect(text).toMatch(/shared is NOT trusted/);
    expect(text).toMatch(/hooks\s+hooks\/reset\.sh/);
    expect(text).toMatch(/next: retake project trust shared/);
    expect(existsSync(join(proj(b, 'shared'), '.env'))).toBe(false);
  });

  it('every command that runs its code is refused before it starts; reads and the allow-list pass', async () => {
    const file = await exported();
    expect((await retake(b, ['project', 'import', file])).code).toBe(EXIT.ok);
    for (const args of [
      ['hooks', 'run', 'demo', 'reset', '--dry'],
      ['run', 'demo', 'quote', '--dry'],
      ['render', 'demo', 'quote'],
      ['project', 'adopt', 'demo', '--theme', 'x'],
      ['components', 'preview', '--project', 'demo'],
    ]) {
      const r = await retake(b, args);
      expect(r.code, args.join(' ')).toBe(EXIT.failure);
      expect(r.err, args.join(' ')).toMatch(/demo was imported from a project archive and is not trusted [\s\S]* retake project trust demo/);
    }
    const v = await retake(b, ['validate', 'demo', 'quote']);
    expect(v.code, v.err).toBe(EXIT.ok);
    expect((await retake(b, ['project', 'export', 'demo', '--dry-run'])).code).toBe(EXIT.ok);
  });

  it('trust: refused without a terminal whatever the shell, no --yes, a no writes nothing, a yes trusts; --list and --discard', async () => {
    const file = await exported();
    expect((await retake(b, ['project', 'import', file])).code).toBe(EXIT.ok);
    const none = await retake(b, ['project', 'trust', 'demo']);
    expect([none.code, none.err]).toEqual([EXIT.failure, expect.stringMatching(/refused: trusting demo takes a person's yes at a terminal/)]);
    // A yes ready to be read but no terminal on stdin (a pipe, an agent's shell): refused all the same, never asked.
    const piped = { ...memoryIo({ answers: ['y'] }), canPrompt: false };
    expect(await main(['node', 'retake', '--root', b, 'project', 'trust', 'demo'], piped, productPorts({ env: PERSON }))).toBe(EXIT.failure);
    expect(piped.questions()).toEqual([]);
    // No --yes in any shell (a person's or an agent's: their environments cannot be told apart).
    for (const env of [PERSON, AGENT]) {
      const yes = await retake(b, ['project', 'trust', 'demo', '--yes'], { env });
      expect([yes.code, yes.err], JSON.stringify(env.RETAKE_AGENT)).toEqual([EXIT.usage, expect.stringMatching(/unknown option '--yes'/)]);
    }
    expect((await retake(b, ['render', 'demo', 'quote'])).err).toMatch(/not trusted/);
    const list = await retake(b, ['project', 'trust', 'demo', '--list', '--json']);
    expect(JSON.parse(list.out)).toMatchObject({ project: 'demo', state: 'untrusted' });
    const no = await retake(b, ['project', 'trust', 'demo'], { answers: ['n'] });
    expect([no.code, no.questions]).toEqual([EXIT.failure, [expect.stringMatching(/^Trust demo: let its \d+ code files, as listed, run on this machine\?/)]]);
    expect((await retake(b, ['render', 'demo', 'quote'])).err).toMatch(/not trusted/);
    const yes = await retake(b, ['project', 'trust', 'demo'], { answers: ['y'] });
    expect(yes.code, yes.err).toBe(EXIT.ok);
    expect(yes.out + yes.err).toMatch(/demo is trusted/);
    // The render now gets past the gate (it fails later: no capture of quote here).
    expect((await retake(b, ['render', 'demo', 'quote'])).err).not.toMatch(/not trusted/);
    // Another import, discarded on a person's yes at a terminal (refused without one).
    expect((await retake(b, ['project', 'import', file, '--as', 'gone'])).code).toBe(EXIT.ok);
    expect((await retake(b, ['project', 'trust', 'gone', '--discard'])).err).toMatch(/takes a person's yes at a terminal/);
    const d = await retake(b, ['project', 'trust', 'gone', '--discard'], { answers: ['y'] });
    expect(d.code, d.err).toBe(EXIT.ok);
    expect(existsSync(proj(b, 'gone'))).toBe(false);
    expect((await readdir(join(b, '.retake', 'imports', 'discarded'))).length).toBe(1);
  });

  it('the gate judges a link to an import as the import, and a folder named by path from outside any workspace', async () => {
    const file = await exported();
    expect((await retake(b, ['project', 'import', file])).code).toBe(EXIT.ok);
    await symlink(proj(b), proj(b, 'alias'));
    for (const args of [
      ['export-capture', 'alias', 'latest'],
      ['comment', 'add', 'alias', 'latest', 'x'],
      ['export-capture', proj(b, 'alias'), 'latest'],
    ]) {
      const r = await retake(b, args);
      expect([r.code, r.err], args.join(' ')).toEqual([EXIT.failure, expect.stringMatching(/^✗ demo was imported from a project archive and is not trusted/)]);
    }
    // Named by its path from a root that holds no mark of it: refused (fails closed).
    const nowhere = await mkdtemp(join(tmpdir(), 'retake-archive-cli-none-'));
    try {
      const io = memoryIo();
      const code = await main(['node', 'retake', '--root', nowhere, 'run', proj(b), 'quote', '--dry'], io, productPorts({ env: PERSON }));
      expect([code, io.stderr()]).toEqual([EXIT.failure, expect.stringMatching(/demo was imported from a project archive and is not trusted/)]);
    } finally {
      await rm(nowhere, { recursive: true, force: true });
    }
  });
});
