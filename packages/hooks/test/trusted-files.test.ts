/**
 * L7.39: the files a person's trust in an agent's hooks binds (trusted-files.ts hookTrustFiles: code bound strictly,
 * data when it exists), and a run held to them (HookContext.trustedFiles): a hook whose files are no longer those is
 * refused before it runs; an sql or js file whose bytes differ when read is refused (kinds/common.ts readHookFile).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Journal, hookFiles, hookFingerprint, hookTrustFiles, runHooks, scriptTokens } from '@retake/hooks';
import { trustedFileChanges } from '@retake/core';
import type { HookStep } from '@retake/core';
import { readHookFile } from '../src/kinds/common.js';
import { makeContext, makeProject, tempProject, writeFiles } from './helpers.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
let tmp: Awaited<ReturnType<typeof tempProject>>;
let dir: string;
const PREP = 'touch prepped.txt\n';

beforeAll(async () => {
  tmp = await tempProject('retake-trusted-files-');
  dir = join(tmp.dir, 'demo');
  await writeFiles(dir, {
    'tools/prep.sh': PREP,
    'prep.sh': 'echo decoy\n',
    'tools/q.sql': 'select 1;\n',
    'tools/data.json': '{}\n',
    'runs/r1/out.json': '{}\n',
    'scenarios/b.yaml': 'video: b\n',
    'hooks/x.js': 'return 1',
  });
});

afterAll(async () => {
  await tmp.cleanup();
});

const files = (hook: HookStep, vars: Record<string, unknown> = {}) => hookTrustFiles(hook, { projectDir: dir, workspaceDir: tmp.dir, vars });
const keys = async (hook: HookStep, vars?: Record<string, unknown>) => {
  const f = await files(hook, vars);
  return { code: Object.keys(f.code).sort(), data: Object.keys(f.data).sort() };
};

describe('the files a trust binds (hookTrustFiles)', () => {
  it('follows a cd / pushd to the script that runs (never the decoy alone), and an agent-writable script', async () => {
    expect(await keys({ shell: 'cd tools && ./prep.sh' })).toEqual({ code: ['prep.sh', 'tools/prep.sh'], data: [] });
    expect(await keys({ shell: 'pushd scenarios; sh b.yaml' })).toEqual({ code: ['scenarios/b.yaml'], data: [] });
    expect((await files({ shell: 'cd tools && ./prep.sh' })).code['tools/prep.sh']).toBe(sha(PREP));
  });

  it('renders a working folder and words with the vars only; a {{run.*}} working folder binds no relative word', async () => {
    expect(await keys({ shell: { run: './prep.sh', cwd: '{{vars.d}}' } }, { d: 'tools' })).toEqual({ code: ['tools/prep.sh'], data: [] });
    expect(await keys({ shell: 'sh {{d}}/prep.sh' }, { d: 'tools' })).toEqual({ code: ['tools/prep.sh'], data: [] });
    expect(await keys({ shell: { run: './prep.sh', cwd: '{{run.dir}}' } })).toEqual({ code: [], data: [] });
    expect(await keys({ shell: 'sh {{env:X}}/prep.sh' })).toEqual({ code: [], data: [] });
  });

  it('splits a glued redirect; an input redirect’s target is code, an output’s is not bound; env values, glued short options and psql -f', async () => {
    expect(await keys({ shell: 'sh <tools/prep.sh' })).toEqual({ code: ['tools/prep.sh'], data: [] });
    expect(await keys({ shell: 'bash<tools/prep.sh' })).toEqual({ code: ['tools/prep.sh'], data: [] });
    expect(await keys({ shell: 'cat tools/q.sql > tools/data.json' })).toEqual({ code: [], data: ['tools/q.sql'] });
    expect(await keys({ shell: { run: 'sh "$S"', env: { S: 'tools/prep.sh' } } })).toEqual({ code: [], data: ['tools/prep.sh'] });
    expect(await keys({ shell: 'psql -ftools/q.sql' })).toEqual({ code: ['tools/q.sql'], data: [] });
    expect(await keys({ shell: 'psql --file=tools/q.sql && psql -f tools/q.sql' })).toEqual({ code: ['tools/q.sql'], data: [] });
    expect(await keys({ shell: 'tool -itools/data.json --in=tools/q.sql' })).toEqual({ code: [], data: ['tools/data.json', 'tools/q.sql'] });
  });

  it('an absolute path inside the project or workspace is bound, one outside is not; sh -c is followed', async () => {
    expect(await keys({ shell: `sh ${join(dir, 'tools', 'prep.sh')} /etc/hosts` })).toEqual({ code: ['tools/prep.sh'], data: [] });
    expect(await keys({ shell: 'bash -c "node hooks/x.js tools/data.json"' })).toEqual({ code: ['hooks/x.js'], data: ['tools/data.json'] });
  });

  it('data: bound only when it exists, never under Retake’s own folders; code: sql / js files, missing ones unreadable', async () => {
    expect(await keys({ shell: 'cp runs/r1/out.json tools/data.json missing.txt' })).toEqual({ code: [], data: ['tools/data.json'] });
    expect(await files({ sql: { file: 'tools/q.sql', rollback: { file: 'gone.sql' } } } as HookStep)).toEqual({
      code: { 'tools/q.sql': sha('select 1;\n'), 'gone.sql': 'unreadable' },
      data: {},
      codeNames: ['gone.sql', 'tools/q.sql'],
    });
    expect(await keys({ js: { file: 'hooks/x.js' } } as HookStep)).toEqual({ code: ['hooks/x.js'], data: [] });
    // A code word that does not exist yet is not bound: once it appears it is "added".
    const none = await files({ shell: './gen.sh || true' });
    expect(none.code).toEqual({});
    await writeFile(join(dir, 'gen.sh'), 'echo gen\n');
    expect(trustedFileChanges(none, await files({ shell: './gen.sh || true' }))).toEqual([{ path: 'gen.sh', change: 'added' }]);
  });

  it('a file named __proto__ is a key like any other, in the trust and in an approval’s fingerprint', async () => {
    await writeFile(join(dir, '__proto__'), 'x\n');
    expect(Object.keys((await files({ shell: 'sh __proto__' })).code)).toEqual(['__proto__']);
    const bound = hookFiles({ shell: 'sh __proto__' }, { projectDir: dir });
    expect(Object.keys(bound.files)).toEqual(['__proto__']);
    // The fingerprints of other hooks are unchanged by the map's prototype.
    expect(hookFingerprint({ shell: 'true' }, { phase: 'setup', index: 0, env: 'local', files: hookFiles({ shell: 'true' }, { projectDir: dir }).files })).toBe(
      hookFingerprint({ shell: 'true' }, { phase: 'setup', index: 0, env: 'local' }),
    );
  });

  it('a plain redirect’s target is generated (not an appended one, not a rollback’s), each candidate folder', async () => {
    expect((await files({ shell: 'echo x > gen.sh && echo y >> log.txt' })).generated).toEqual(['gen.sh']);
    expect((await files({ shell: { run: 'cd tools && date +%N >out.txt', rollback: 'echo z > undo.txt' } })).generated).toEqual(['out.txt', 'tools/out.txt']);
    expect((await files({ shell: 'echo x >> log.txt' })).generated).toBeUndefined();
  });

  it('a quoted or escaped redirect sign is a word, never a redirect: the file it names stays bound, nothing is generated', async () => {
    expect(scriptTokens(`echo '>' a "<" b \\> c`)).toEqual([{ word: 'echo' }, { word: '>' }, { word: 'a' }, { word: '<' }, { word: 'b' }, { word: '>' }, { word: 'c' }]);
    expect(scriptTokens('sh<x 2>err &>log')).toEqual([{ word: 'sh' }, { redirect: '<' }, { word: 'x' }, { redirect: '>' }, { word: 'err' }, { redirect: '&>' }, { word: 'log' }]);
    const f = await files({ shell: "echo '>' tools/prep.sh && echo \\> tools/q.sql" });
    expect(f.generated).toBeUndefined();
    expect(Object.keys(f.data).sort()).toEqual(['tools/prep.sh', 'tools/q.sql']);
  });

  it('a FIFO is bound as unreadable, a folder is no file; a large file is hashed whole', async () => {
    execFileSync('mkfifo', [join(dir, 'tools', 'pipe.sh')]);
    expect((await files({ shell: 'sh tools/pipe.sh tools' })).code).toEqual({ 'tools/pipe.sh': 'unreadable' });
    const big = Buffer.alloc(5 * 1024 * 1024 + 3, 7);
    await writeFile(join(dir, 'tools', 'big.bin'), big);
    expect((await files({ shell: 'cat tools/big.bin' })).data).toEqual({ 'tools/big.bin': sha(big) });
  });
});

describe('a run held to the files a person checked (HookContext.trustedFiles)', () => {
  const fresh = (code: Record<string, string> = {}, data: Record<string, string> = {}) => ({ code: { ...code }, data: { ...data } });
  const runTwice = async (hooks: HookStep[], hold: () => ReturnType<typeof fresh>) => {
    const out: string[][] = [];
    for (let n = 0; n < 2; n++) {
      const { ctx } = makeContext(makeProject(dir), { trustedFiles: hold() });
      const res = await runHooks(hooks, ctx, { phase: 'teardown', journal: await Journal.open(journalFile()) });
      out.push(res.results.map((r) => r.status));
    }
    return out;
  };

  it('a script one hook generates and the next runs: run after run (the hold refreshed after each hook)', async () => {
    await rm(join(dir, 'gen-ran.txt'), { force: true });
    const hooks: HookStep[] = [{ shell: 'echo "echo ran >> gen-ran.txt" > gen.sh' }, { shell: 'sh gen.sh' }];
    expect(await runTwice(hooks, () => fresh())).toEqual([
      ['ok', 'ok'],
      ['ok', 'ok'],
    ]);
    expect(await readFile(join(dir, 'gen-ran.txt'), 'utf8')).toBe('ran\nran\n');
  });

  it('a data file one hook generates and the next reads: run after run', async () => {
    const hooks: HookStep[] = [{ shell: 'date +%N > out.txt' }, { shell: 'cat out.txt' }];
    expect(await runTwice(hooks, () => fresh())).toEqual([
      ['ok', 'ok'],
      ['ok', 'ok'],
    ]);
  });

  it('only a file a hook names as written becomes its output: a held file another hook changes, or that changes while a hook runs, is refused to later readers', async () => {
    await writeFile(join(dir, 'tools', 'next.json'), '{"n":2}\n');
    const data = { 'tools/data.json': sha(await readFile(join(dir, 'tools', 'data.json'))), 'tools/next.json': sha('{"n":2}\n') };
    // cp does not name its target as written (no plain redirect): its change is not credited.
    const hooks: HookStep[] = [{ shell: 'cp tools/next.json tools/data.json' }, { shell: 'cat tools/data.json' }];
    const { ctx } = makeContext(makeProject(dir), { trustedFiles: fresh({}, data) });
    expect((await runHooks(hooks, ctx, { phase: 'teardown', journal: await Journal.open(journalFile()) })).results.map((r) => r.status)).toEqual(['ok', 'refused']);
    await writeFile(join(dir, 'tools', 'data.json'), '{}\n');
    // A script written by the first hook, changed by someone else while a long hook runs: refused, nothing of it ran.
    const marker = join(dir, 'pwned-long.txt');
    const long: HookStep[] = [{ shell: "echo 'echo fine' > gen5.sh" }, { shell: 'sleep 0.6' }, { shell: 'sh gen5.sh' }];
    const { ctx: held } = makeContext(makeProject(dir), { trustedFiles: fresh() });
    const swap = new Promise<void>((done) => setTimeout(() => void writeFile(join(dir, 'gen5.sh'), `touch ${marker}\n`).then(() => done()), 250));
    const res = await runHooks(long, held, { phase: 'teardown', journal: await Journal.open(journalFile()) });
    await swap;
    expect(res.results.map((r) => r.status)).toEqual(['ok', 'ok', 'refused']);
    expect(existsSync(marker)).toBe(false);
  });

  it('a writer whose output a later hook runs as code: its inputs are code — one that appeared since the check is refused', async () => {
    await rm(join(dir, 'n.txt'), { force: true });
    await rm(join(dir, 'gen4.sh'), { force: true });
    const hooks: HookStep[] = [{ shell: 'cat n.txt > gen4.sh' }, { shell: 'sh gen4.sh' }];
    const marker = join(dir, 'pwned-input.txt');
    // As the check before the run gives it: gen4.sh is a code output, its writer's inputs code; n.txt absent then.
    const checked = { code: {}, data: {}, codeOutputs: ['gen4.sh'] };
    await writeFile(join(dir, 'n.txt'), `touch ${marker}\n`);
    const { ctx } = makeContext(makeProject(dir), { trustedFiles: { ...checked, code: {}, data: {} } });
    const res = await runHooks(hooks, ctx, { phase: 'teardown', journal: await Journal.open(journalFile()) });
    expect(res.results[0]).toMatchObject({ status: 'refused', error: expect.stringContaining('n.txt (newly read as code)') });
    expect(res.results[1]?.status).not.toBe('ok');
    expect(existsSync(marker)).toBe(false);
    // An input under Retake's own folders counts too.
    const quiet: HookStep[] = [{ shell: 'cat runs/r1/out.json > gen6.sh' }, { shell: 'sh gen6.sh' }];
    const { ctx: q } = makeContext(makeProject(dir), { trustedFiles: { code: {}, data: {}, codeOutputs: ['gen6.sh'] } });
    expect((await runHooks(quiet, q, { phase: 'teardown', journal: await Journal.open(journalFile()) })).results[0]).toMatchObject({
      status: 'refused',
      error: expect.stringContaining('runs/r1/out.json (newly read as code)'),
    });
    // As trusted (n.txt bound as it is): runs.
    await writeFile(join(dir, 'n.txt'), 'echo fine\n');
    const { ctx: ok } = makeContext(makeProject(dir), { trustedFiles: { code: { 'n.txt': sha('echo fine\n') }, data: {}, codeOutputs: ['gen4.sh'] } });
    expect((await runHooks(hooks, ok, { phase: 'teardown', journal: await Journal.open(journalFile()) })).results.map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('a writer behind a condition that writes nothing: a planted file is not its output — the reader is refused; a rewrite of the same bytes is', async () => {
    await writeFile(join(dir, 'gen2.sh'), 'touch pwned.txt\n');
    const hooks: HookStep[] = [{ shell: "test -f gen2.sh || echo 'echo hi' > gen2.sh" }, { shell: 'sh gen2.sh' }];
    const { ctx } = makeContext(makeProject(dir), { trustedFiles: fresh() });
    expect((await runHooks(hooks, ctx, { phase: 'teardown', journal: await Journal.open(journalFile()) })).results.map((r) => r.status)).toEqual(['ok', 'refused']);
    expect(existsSync(join(dir, 'pwned.txt'))).toBe(false);
    // Held as trusted, then planted: the writer names it too (`test -f`) and is refused; so is the reader.
    const { ctx: trusted } = makeContext(makeProject(dir), { trustedFiles: fresh({ 'gen2.sh': sha('echo hi\n') }) });
    expect((await runHooks(hooks, trusted, { phase: 'teardown', journal: await Journal.open(journalFile()) })).results.map((r) => r.status)).toEqual(['refused', 'refused']);
    // A writer that writes the same bytes again did write: its output.
    await writeFile(join(dir, 'same.sh'), 'echo same\n');
    const { ctx: again } = makeContext(makeProject(dir), { trustedFiles: fresh() });
    const rewrite: HookStep[] = [{ shell: "sleep 0.01; echo 'echo same' > same.sh" }, { shell: 'sh same.sh' }];
    expect((await runHooks(rewrite, again, { phase: 'teardown', journal: await Journal.open(journalFile()) })).results.map((r) => r.status)).toEqual(['ok', 'ok']);
  });

  it('a reader whose writer did not succeed is refused (it would read the old bytes)', async () => {
    const hooks: HookStep[] = [{ shell: 'echo hi > w.txt && false' }, { shell: 'cat w.txt' }];
    const { ctx } = makeContext(makeProject(dir), { trustedFiles: fresh() });
    const res = await runHooks(hooks, ctx, { phase: 'teardown', journal: await Journal.open(journalFile()) });
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'refused']);
  });

  const journalFile = () => join(tmp.dir, `journal-${Math.random().toString(36).slice(2)}.json`);

  it('a shell hook whose script changed since the check is refused before it runs; unchanged, it runs', async () => {
    const project = makeProject(dir);
    const hook: HookStep = { shell: 'sh tools/prep.sh' };
    const checked = await files(hook);
    await writeFile(join(dir, 'tools', 'prep.sh'), 'touch other.txt\n');
    const { ctx } = makeContext(project, { trustedFiles: checked });
    const res = await runHooks([hook], ctx, { phase: 'teardown', journal: await Journal.open(journalFile()) });
    expect(res.results[0]).toMatchObject({ status: 'refused', error: expect.stringContaining('tools/prep.sh (changed since)') });
    expect(existsSync(join(dir, 'other.txt'))).toBe(false);
    await writeFile(join(dir, 'tools', 'prep.sh'), PREP);
    const again = await runHooks([hook], ctx, { phase: 'teardown', journal: await Journal.open(journalFile()) });
    expect(again.results[0]).toMatchObject({ status: 'ok' });
    expect(existsSync(join(dir, 'prepped.txt'))).toBe(true);
    // Without a check: as before.
    const { ctx: plain } = makeContext(project);
    await writeFile(join(dir, 'tools', 'prep.sh'), 'touch other.txt\n');
    expect((await runHooks([hook], plain, { phase: 'teardown', journal: await Journal.open(journalFile()) })).results[0]).toMatchObject({ status: 'ok' });
    await writeFile(join(dir, 'tools', 'prep.sh'), PREP);
  });

  it('a js file is refused when it is not as checked; an sql / js file read under the check must have the bound bytes', async () => {
    const project = makeProject(dir);
    const hook = { js: { file: 'hooks/x.js' } } as HookStep;
    const checked = await files(hook);
    const { ctx } = makeContext(project, { trustedFiles: checked });
    ctx.evalInPage = async () => 1;
    await writeFile(join(dir, 'hooks', 'x.js'), 'return 2');
    expect((await runHooks([hook], ctx, { phase: 'teardown', journal: await Journal.open(journalFile()) })).results[0]).toMatchObject({
      status: 'refused',
      error: expect.stringContaining('hooks/x.js (changed since)'),
    });
    // At read time (the window between the hook's check and its read): other bytes, or a file not checked, refused.
    await expect(readHookFile(ctx, dir, 'hooks/x.js', 'JS file')).rejects.toThrow('JS file hooks/x.js is not as you checked it before the run (its bytes changed since)');
    await expect(readHookFile(ctx, dir, 'tools/q.sql', 'SQL file')).rejects.toThrow('it was not among the files checked');
    await writeFile(join(dir, 'hooks', 'x.js'), 'return 1');
    expect(await readHookFile(ctx, dir, 'hooks/x.js', 'JS file')).toBe('return 1');
    const { ctx: plain } = makeContext(project);
    expect(await readHookFile(plain, dir, 'tools/q.sql', 'SQL file')).toBe('select 1;\n');
  });

  it('a data file the run itself made since the check is not looked at; one changed since is', async () => {
    const project = makeProject(dir);
    await mkdir(join(dir, 'out'), { recursive: true });
    const hook: HookStep = { shell: 'cat tools/data.json out/made.json' };
    const checked = await files(hook);
    await writeFile(join(dir, 'out', 'made.json'), '{}\n');
    const { ctx } = makeContext(project, { trustedFiles: checked });
    expect((await runHooks([hook], ctx, { phase: 'teardown', journal: await Journal.open(journalFile()) })).results[0]).toMatchObject({ status: 'ok' });
    await writeFile(join(dir, 'tools', 'data.json'), '{"x":1}\n');
    expect((await runHooks([hook], ctx, { phase: 'teardown', journal: await Journal.open(journalFile()) })).results[0]).toMatchObject({
      status: 'refused',
      error: expect.stringContaining('tools/data.json (changed since)'),
    });
  });
});
