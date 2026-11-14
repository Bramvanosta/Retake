/**
 * L4.3 part 1: the Studio's scenario write path (engine scenarios.edit, the `ui` client) and the view's `edit` field.
 * `replace_text` (the YAML tab) and `restore` (undo / redo, byte-exact) write the file the view read with its hash as
 * if_match (a conflict names the current hash, nothing written); a file the Studio may not write — not UTF-8, too
 * large, holding a secret reference or an outside file — is refused whole and the view says why with the lines before
 * any edit (critique B3, B11); the new text adds no hidden character (B9) and leaves hooks and mocks unchanged (B3);
 * it is validated with agent trust worded "from the Studio" (errors refuse with their lines, warnings save) — and
 * scenarios.validate / save now pass that channel too (the pre-existing defect); the mode is kept and a `.yml` is
 * written in place. getScenario keeps the `utf8` flag.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScenarioError } from '@retake/core';
import { EngineError, createEngine } from '../src/index.js';
import type { Engine } from '../src/index.js';
import { scratchHome } from '@retake/test-support/home';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const RLO = String.fromCodePoint(0x202e);
const LS = String.fromCodePoint(0x2028);
const NEL = String.fromCodePoint(0x85);
const ZWSP = String.fromCodePoint(0x200b);

let ws: string;
let dir: string;
let ui: Engine;
let mcp: Engine;
let cli: Engine;
const retakeHome = scratchHome();

const PROJECT = 'name: W\nenvironments:\n  local:\n    console: http://127.0.0.1:4997\ncapture: {width: 1280, height: 720, scale: 1, fps: 30}\ntemplate: default\n';
const SHORT = 'video: short\nscenes:\n  - id: a\n    page: console\n    open: /\n    steps:\n      # first a pause\n      - hold: 0.2\n';
const HOOKED = SHORT.replace('scenes:', 'setup:\n  - http: {method: POST, url: "{{console}}/x"}\nscenes:');
const file = (name: string) => join(dir, 'scenarios', name);

async function failure(p: Promise<unknown>): Promise<Error> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(Error);
  return e as Error;
}

/** Write a scenario and return its hash. */
async function put(name: string, text: string | Buffer): Promise<string> {
  await writeFile(file(name), text);
  return sha(text);
}

/** The file's bytes and mtime: unchanged after a refusal. */
async function snapshot(name: string): Promise<{ bytes: string; mtime: number }> {
  return { bytes: (await readFile(file(name))).toString('hex'), mtime: (await stat(file(name))).mtimeMs };
}

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ds-scenario-edit-'));
  retakeHome.use(join(ws, '.home'));
  await writeFile(join(ws, 'retake.yaml'), 'projects_dir: projects\n');
  dir = join(ws, 'projects', 'w');
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), PROJECT);
  // The files the planted references name exist: only agent trust refuses them.
  await writeFile(join(ws, 'projects', 'outside.txt'), 'outside\n');
  await writeFile(join(dir, 'scenarios', 'x.js'), 'return 1;\n');
  ui = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
  mcp = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  cli = await createEngine({ root: ws, client: 'cli', autoStartWorker: false });
});

afterAll(async () => {
  retakeHome.restore();
  if (ws) await rm(ws, { recursive: true, force: true });
});

describe('replace_text and restore (the YAML tab, undo / redo)', () => {
  it('saves the text with its hash as if_match, adds the final line break, keeps comments as typed; restore puts the exact bytes back', async () => {
    const h0 = await put('one.yaml', SHORT);
    const edited = SHORT.replace('hold: 0.2', 'hold: 0.5  # longer');
    const r = await ui.scenarios.edit('w', 'one', { hash: h0, edit: { kind: 'replace_text', text: edited.slice(0, -1) } });
    expect(r).toMatchObject({ name: 'one', file: 'scenarios/one.yaml', label: 'Saved the YAML', select: null, notices: [] });
    expect(r.warnings.map((w) => w.message)).toEqual(['video "short" differs from the file name "one"']);
    expect(await readFile(file('one.yaml'), 'utf8')).toBe(edited);
    expect(r.hash).toBe(sha(edited));
    const back = await ui.scenarios.edit('w', 'one', { hash: r.hash, edit: { kind: 'restore', text: SHORT, text_hash: h0 } });
    expect(back.label).toBe('Restored an earlier version');
    expect(sha(await readFile(file('one.yaml')))).toBe(h0);
  });

  it('restore is byte-exact on a CR LF file without a final line break (critique B5); replace_text adds a CR LF break there', async () => {
    const crlf = SHORT.replace(/\n/g, '\r\n').replace(/\r\n$/, '');
    const h0 = await put('crlf.yaml', crlf);
    const typed = crlf.replace('hold: 0.2', 'hold: 0.3');
    const r = await ui.scenarios.edit('w', 'crlf', { hash: h0, edit: { kind: 'replace_text', text: typed } });
    expect(await readFile(file('crlf.yaml'), 'utf8')).toBe(`${typed}\r\n`);
    await ui.scenarios.edit('w', 'crlf', { hash: r.hash, edit: { kind: 'restore', text: crlf, text_hash: h0 } });
    expect(await readFile(file('crlf.yaml'), 'utf8')).toBe(crlf);
    const wrong = await failure(ui.scenarios.edit('w', 'crlf', { hash: h0, edit: { kind: 'restore', text: typed, text_hash: h0 } }));
    expect((wrong as EngineError).code).toBe('invalid');
    expect(wrong.message).toBe('the text to restore is not the version named by text_hash: nothing written');
  });

  it('a stale hash is a conflict naming the current hash: nothing written (bytes and mtime)', async () => {
    const h0 = await put('stale.yaml', SHORT);
    const before = await snapshot('stale.yaml');
    const e = (await failure(ui.scenarios.edit('w', 'stale', { hash: sha('something else'), edit: { kind: 'replace_text', text: HOOKED } }))) as EngineError;
    expect(e.code).toBe('conflict');
    expect(e.details).toEqual({ current: h0 });
    expect(await snapshot('stale.yaml')).toEqual(before);
    for (const kind of ['restore'] as const) {
      const e2 = (await failure(ui.scenarios.edit('w', 'stale', { hash: sha('x'), edit: { kind, text: SHORT, text_hash: h0 } }))) as EngineError;
      expect(e2.code).toBe('conflict');
    }
  });

  it('two concurrent edits of one version (no queue in front): one saved, the other a conflict — 20 times', async () => {
    let h = await put('both.yaml', SHORT);
    for (let i = 0; i < 20; i++) {
      const texts = [SHORT.replace('0.2', `1.${i}`), SHORT.replace('0.2', `2.${i}`)];
      const out = await Promise.all(
        texts.map((text) =>
          ui.scenarios.edit('w', 'both', { hash: h, edit: { kind: 'replace_text', text } }).then(
            () => 'ok',
            (e: unknown) => (e as EngineError).code,
          ),
        ),
      );
      expect(out.sort()).toEqual(['conflict', 'ok']);
      h = sha(await readFile(file('both.yaml')));
      expect(texts.map(sha)).toContain(h);
    }
  });

  it('errors refuse the save with their lines (file unchanged); warnings save and come back', async () => {
    const h0 = await put('valid.yaml', SHORT);
    const before = await snapshot('valid.yaml');
    const broken = SHORT.replace('hold: 0.2', 'hold: -1');
    const e = await failure(ui.scenarios.edit('w', 'valid', { hash: h0, edit: { kind: 'replace_text', text: broken } }));
    expect(e).toBeInstanceOf(ScenarioError);
    const issue = (e as ScenarioError).issues.find((i) => i.severity === 'error');
    expect(issue?.line).toBe(8);
    expect(await snapshot('valid.yaml')).toEqual(before);
    const notYaml = await failure(ui.scenarios.edit('w', 'valid', { hash: h0, edit: { kind: 'replace_text', text: 'scenes: [\n' } }));
    expect(notYaml).toBeInstanceOf(ScenarioError);
    // A duplicate mark is a warning: saved.
    const warned = SHORT.replace('      - hold: 0.2\n', '      - hold: 0.2\n        mark: m\n      - hold: 0.3\n        mark: m\n');
    const r = await ui.scenarios.edit('w', 'valid', { hash: h0, edit: { kind: 'replace_text', text: warned } });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.every((w) => w.severity === 'warning')).toBe(true);
    expect(await readFile(file('valid.yaml'), 'utf8')).toBe(warned);
  });

  it('a .yml scenario is written in place (no .yaml created); a missing scenario is never created', async () => {
    const h0 = await put('legacy.yml', SHORT);
    const r = await ui.scenarios.edit('w', 'legacy', { hash: h0, edit: { kind: 'replace_text', text: SHORT.replace('0.2', '0.4') } });
    expect(r.file).toBe('scenarios/legacy.yml');
    expect(await readFile(file('legacy.yml'), 'utf8')).toContain('hold: 0.4');
    expect((await readdir(join(dir, 'scenarios'))).filter((f) => f.startsWith('legacy'))).toEqual(['legacy.yml']);
    const missing = (await failure(ui.scenarios.edit('w', 'nothing', { hash: h0, edit: { kind: 'replace_text', text: SHORT } }))) as EngineError;
    expect(missing.code).toBe('not_found');
    expect(existsSync(file('nothing.yaml'))).toBe(false);
  });

  it("keeps the file's mode (0600) and leaves no temp or lock file", async () => {
    const h0 = await put('private.yaml', SHORT);
    await chmod(file('private.yaml'), 0o600);
    await ui.scenarios.edit('w', 'private', { hash: h0, edit: { kind: 'replace_text', text: SHORT.replace('0.2', '0.6') } });
    expect((await stat(file('private.yaml'))).mode & 0o777).toBe(0o600);
    expect((await readdir(join(dir, 'scenarios'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await readdir(join(dir, '.retake', 'locks'))).filter((f) => f.startsWith('write-'))).toEqual([]);
  });
});

describe('agent trust from the Studio, worded for the channel (the pre-existing defect fixed)', () => {
  const planted: Array<[string, string]> = [
    ['an env secret', SHORT.replace('      - hold: 0.2', '      - type: {into: {label: Name}, text: "{{env:SHOP_TOKEN}}"}')],
    ['a keychain secret', SHORT.replace('      - hold: 0.2', '      - type: {into: {label: Password}, text: "{{keychain:demo/agent}}"}')],
    ['a file out of the project', SHORT.replace('      - hold: 0.2', '      - drop_file: {zone: {label: Upload}, path: ../outside.txt}')],
    ['code in an agent-writable file', SHORT.replace('      - hold: 0.2', '      - eval: {file: scenarios/x.js}')],
    ['a template folder', SHORT.replace('video: short', 'video: short\ntemplate: ./mine')],
  ];
  for (const [what, text] of planted) {
    it(`replace_text adding ${what} is refused "from the Studio", at its line`, async () => {
      const h0 = await put('trust.yaml', SHORT);
      const before = await snapshot('trust.yaml');
      const e = await failure(ui.scenarios.edit('w', 'trust', { hash: h0, edit: { kind: 'replace_text', text } }));
      expect(e).toBeInstanceOf(ScenarioError);
      expect(e.message).toContain('from the Studio');
      expect(e.message).not.toContain('through MCP');
      const trust = (e as ScenarioError).issues.filter((i) => i.message.includes('from the Studio'));
      expect(trust.length).toBeGreaterThan(0);
      const line = text.split('\n').findIndex((l) => /\{\{|\.\.\/|scenarios\/x|\.\/mine/.test(l)) + 1;
      expect(trust[0].line).toBe(line);
      expect(await snapshot('trust.yaml')).toEqual(before);
    });
  }

  it('validate and save say "from the Studio" for the ui client and "through MCP" for the MCP client', async () => {
    const leak = planted[0][1];
    const v = await ui.scenarios.validate('w', leak);
    expect(v.ok).toBe(false);
    expect(v.issues.find((i) => i.message.includes('{{env:SHOP_TOKEN}}'))?.message).toContain('from the Studio a scenario never resolves a secret');
    expect(v.issues.find((i) => i.message.includes('{{env:SHOP_TOKEN}}'))?.line).toBe(8);
    const vm = await mcp.scenarios.validate('w', leak);
    expect(vm.issues.find((i) => i.message.includes('{{env:SHOP_TOKEN}}'))?.message).toContain('through MCP a scenario never resolves a secret');
    expect((await failure(ui.scenarios.save('w', 'leak-ui', leak))).message).toContain('from the Studio a scenario never resolves a secret');
    expect((await failure(mcp.scenarios.save('w', 'leak-mcp', leak))).message).toContain('through MCP a scenario never resolves a secret');
    expect((await cli.scenarios.validate('w', leak)).ok).toBe(true);
  });

  it('a file already holding a secret reference: the view says so with its line before any edit, both tabs read-only, every edit refused', async () => {
    const text = planted[0][1];
    const h0 = await put('owned.yaml', text);
    const v = await ui.scenarios.view('w', 'owned');
    expect(v.edit.yaml.ok).toBe(false);
    expect(v.edit.blocks.ok).toBe(false);
    if (v.edit.yaml.ok) throw new Error('unreachable');
    expect(v.edit.yaml.why).toMatch(/^scenarios\/owned\.yaml holds what the Studio never writes \(line 8\): .*Edit this file in your editor/);
    expect(v.edit.yaml.problems).toEqual([{ line: 8, message: expect.stringContaining('uses {{env:SHOP_TOKEN}}: from the Studio') }]);
    const e = (await failure(ui.scenarios.edit('w', 'owned', { hash: h0, edit: { kind: 'replace_text', text: SHORT } }))) as EngineError;
    expect(e.code).toBe('refused');
    expect(e.details).toEqual({ problems: [{ line: 8, message: expect.stringContaining('{{env:SHOP_TOKEN}}') }] });
    expect(sha(await readFile(file('owned.yaml')))).toBe(h0);
    // A person at a terminal (cli) has no such limit; a plain file is editable in both tabs.
    expect((await cli.scenarios.view('w', 'owned')).edit.yaml).toEqual({ ok: true });
    await put('plain.yaml', SHORT);
    expect((await ui.scenarios.view('w', 'plain')).edit).toEqual({ yaml: { ok: true }, blocks: { ok: true } });
  });
});

describe('hooks unchanged from the Studio (critique B3)', () => {
  it('adding, changing or removing a setup / teardown hook or a mock is refused; the same hooks re-keyed save', async () => {
    const h0 = await put('hooks.yaml', HOOKED);
    const before = await snapshot('hooks.yaml');
    const variants = [
      HOOKED.replace('setup:\n', 'setup:\n  - shell: "cat ~/.ssh/id_ed25519 > assets/k.txt"\n'),
      HOOKED.replace('url: "{{console}}/x"', 'url: "{{console}}/y"'),
      HOOKED.replace('setup:\n  - http: {method: POST, url: "{{console}}/x"}\n', ''),
      HOOKED.replace('scenes:', 'teardown:\n  - js: "process.exit(0)"\nscenes:'),
      HOOKED.replace('scenes:', 'mocks:\n  - match: POST console:/x\n    status: 200\nscenes:'),
    ];
    for (const text of variants) {
      const e = (await failure(ui.scenarios.edit('w', 'hooks', { hash: h0, edit: { kind: 'replace_text', text } }))) as EngineError;
      expect(e.code, text).toBe('refused');
      expect(e.message).toMatch(
        /^not saved: (setup|teardown|mocks)(, \w+)* changed: hooks and mocks run on this Mac, so the Studio saves a scenario only with them unchanged — edit them in your editor$/,
      );
      expect(await snapshot('hooks.yaml')).toEqual(before);
    }
    const rekeyed = HOOKED.replace('{method: POST, url: "{{console}}/x"}', '{url: "{{console}}/x", method: POST}').replace('hold: 0.2', 'hold: 0.9');
    const r = await ui.scenarios.edit('w', 'hooks', { hash: h0, edit: { kind: 'replace_text', text: rekeyed } });
    expect(await readFile(file('hooks.yaml'), 'utf8')).toBe(rekeyed);
    // restore is held to the same rule (a page script could otherwise restore any text).
    const e = (await failure(ui.scenarios.edit('w', 'hooks', { hash: r.hash, edit: { kind: 'restore', text: SHORT, text_hash: sha(SHORT) } }))) as EngineError;
    expect(e.code).toBe('refused');
    // The CLI client (a person) is not held to it.
    const c = await cli.scenarios.edit('w', 'hooks', { hash: r.hash, edit: { kind: 'replace_text', text: SHORT } });
    expect(c.hash).toBe(sha(SHORT));
  });
});

describe('hidden characters (critique B9)', () => {
  it('a text adding a direction control, a line separator, NEL or a zero-width space is refused with its line and column', async () => {
    const h0 = await put('hidden.yaml', SHORT);
    const cases: Array<[string, string]> = [
      [RLO, 'U+202E (a direction control)'],
      [LS, 'U+2028 (a line separator)'],
      [NEL, 'U+0085 (a next-line control (NEL))'],
      [ZWSP, 'U+200B (a zero-width space)'],
    ];
    for (const [c, name] of cases) {
      const text = SHORT.replace('# first a pause', `# first a ${c}pause`);
      const e = (await failure(ui.scenarios.edit('w', 'hidden', { hash: h0, edit: { kind: 'replace_text', text } }))) as EngineError;
      expect(e.code).toBe('invalid');
      expect(e.message).toBe(`not saved: line 7, column 17 holds ${name}: the Studio never writes one (it reads as nothing, or as a line break, in an editor) — remove it`);
    }
    expect(sha(await readFile(file('hidden.yaml')))).toBe(h0);
  });

  it('a file that already holds one keeps it when another line is edited; an emoji sequence (ZWJ) and a leading BOM are fine', async () => {
    const withMark = SHORT.replace('# first a pause', `# first a ${RLO}pause`);
    const h0 = await put('marked.yaml', withMark);
    const r = await ui.scenarios.edit('w', 'marked', { hash: h0, edit: { kind: 'replace_text', text: withMark.replace('0.2', '0.7') } });
    const family = ['1f468', '200d', '1f469', '200d', '1f467'].map((h) => String.fromCodePoint(parseInt(h, 16))).join('');
    const bom = String.fromCodePoint(0xfeff);
    const text = `${bom}${withMark.replace('scenes:', `# ${family} the family\nscenes:`)}`;
    const r2 = await ui.scenarios.edit('w', 'marked', { hash: r.hash, edit: { kind: 'replace_text', text } });
    expect(await readFile(file('marked.yaml'), 'utf8')).toBe(text);
    // Review A L2: kept only on a line the file has word for word — the marked line itself edited is refused.
    const e = await failure(ui.scenarios.edit('w', 'marked', { hash: r2.hash, edit: { kind: 'replace_text', text: text.replace('# first a', '# then a') } }));
    expect(e.message).toMatch(/^not saved: line 8, column 16 holds U\+202E \(a direction control\)/);
  });
});

describe('files the Studio does not write', () => {
  it('not UTF-8: getScenario flags it, the view says why, an edit is refused (never rewritten with U+FFFD)', async () => {
    const latin = Buffer.concat([Buffer.from(SHORT.replace('# first a pause', '# caf')), Buffer.from([0xe9, 0x0a])]);
    const h0 = await put('latin.yaml', latin);
    const s = await ui.scenarios.get('w', 'latin');
    expect(s.utf8).toBe(false);
    expect((await ui.scenarios.get('w', 'one')).utf8).toBe(true);
    const v = await ui.scenarios.view('w', 'latin');
    expect(v.edit.yaml).toMatchObject({ ok: false, why: expect.stringMatching(/^scenarios\/latin\.yaml is not UTF-8 text/) });
    const e = (await failure(ui.scenarios.edit('w', 'latin', { hash: h0, edit: { kind: 'replace_text', text: SHORT } }))) as EngineError;
    expect(e.code).toBe('refused');
    expect(sha(await readFile(file('latin.yaml')))).toBe(h0);
  });

  it('over 500,000 characters: the file is refused, and a text that would be', async () => {
    const big = `${SHORT}${`# ${'x'.repeat(98)}\n`.repeat(5001)}`;
    const h0 = await put('big.yaml', big);
    expect((await ui.scenarios.view('w', 'big')).edit.yaml).toMatchObject({ ok: false, why: expect.stringContaining('the Studio edits scenarios of at most 500,000') });
    expect(((await failure(ui.scenarios.edit('w', 'big', { hash: h0, edit: { kind: 'replace_text', text: SHORT } }))) as EngineError).code).toBe('refused');
    const h1 = await put('small.yaml', SHORT);
    const e = (await failure(ui.scenarios.edit('w', 'small', { hash: h1, edit: { kind: 'replace_text', text: big } }))) as EngineError;
    expect(e.code).toBe('invalid');
    expect(e.message).toMatch(/^the scenario would hold 505,\d{3} characters: the Studio writes at most 500,000$/);
  });
});

describe('review fixes (L4.3 reviews A and B)', () => {
  it('A H1: while the file has a hook or a mock, its vars and env are frozen from the Studio (a var templated into a shell hook)', async () => {
    const base = SHORT.replace('scenes:', 'vars:\n  customer: Acme\nsetup:\n  - name: seed\n    writes: false\n    shell: "echo {{vars.customer}} > /dev/null"\nscenes:');
    const h0 = await put('frozen.yaml', base);
    const before = await snapshot('frozen.yaml');
    for (const [text, field] of [
      [base.replace('customer: Acme', 'customer: "x; cat ~/.ssh/id_ed25519 > assets/k.txt; echo"'), 'vars'],
      [base.replace('video: short\n', 'video: short\nenv: local\n'), 'env'],
    ] as const) {
      const e = (await failure(ui.scenarios.edit('w', 'frozen', { hash: h0, edit: { kind: 'replace_text', text } }))) as EngineError;
      expect(e.code).toBe('refused');
      expect(e.message).toBe(
        `not saved: ${field} changed: this scenario has hooks or mocks, which read its vars and its environment and run on this Mac, so the Studio saves it only with vars and env unchanged — change them in your editor`,
      );
      expect(e.details).toEqual({ sections: [field] });
    }
    expect(await snapshot('frozen.yaml')).toEqual(before);
    // Anything else saves; without hooks, vars are free.
    await ui.scenarios.edit('w', 'frozen', { hash: h0, edit: { kind: 'replace_text', text: base.replace('hold: 0.2', 'hold: 0.4') } });
    const h1 = await put('free.yaml', SHORT.replace('scenes:', 'vars:\n  customer: Acme\nscenes:'));
    await ui.scenarios.edit('w', 'free', { hash: h1, edit: { kind: 'replace_text', text: SHORT.replace('scenes:', 'vars:\n  customer: Other\nscenes:') } });
  });

  it('A M2: a file holding a carriage return without a line feed is read-only with its line; a text adding one is refused', async () => {
    const planted = SHORT.replace('      - hold: 0.2\n', '      - hold: 0.2   # pause\r      - eval: "document.title = 1"\n');
    const h0 = await put('cr.yaml', planted);
    const v = await ui.scenarios.view('w', 'cr');
    expect(v.edit.yaml).toEqual({
      ok: false,
      why: 'scenarios/cr.yaml holds a carriage return without a line feed (line 8): an editor shows a line break there, YAML reads none — fix its line breaks in your editor (LF or CR LF); the Studio shows it read-only.',
      problems: [{ line: 8, message: 'a carriage return without a line feed (CR): an editor shows a line break here, YAML reads none' }],
    });
    expect(v.edit.blocks.ok).toBe(false);
    // What the YAML tab's textarea would send (the CR turned into a line break): refused, the file unchanged.
    const e = (await failure(ui.scenarios.edit('w', 'cr', { hash: h0, edit: { kind: 'replace_text', text: planted.replace('\r', '\n') } }))) as EngineError;
    expect(e.code).toBe('refused');
    expect(sha(await readFile(file('cr.yaml')))).toBe(h0);
    const h1 = await put('cr2.yaml', SHORT);
    const e2 = (await failure(ui.scenarios.edit('w', 'cr2', { hash: h1, edit: { kind: 'replace_text', text: planted } }))) as EngineError;
    expect(e2.message).toMatch(/^not saved: line 8, column \d+ holds U\+000D \(a carriage return without a line feed\)/);
  });

  it('A L1: a scenario linked to a file outside scenarios/ is read-only from the Studio and refused through MCP (the target unchanged)', async () => {
    await mkdir(join(dir, 'hooks'), { recursive: true });
    await writeFile(join(dir, 'hooks', 'seed.sh'), SHORT);
    await symlink('../hooks/seed.sh', file('lnk.yaml'));
    const v = await ui.scenarios.view('w', 'lnk');
    expect(v.edit.yaml).toEqual({
      ok: false,
      why: 'scenarios/lnk.yaml is a symbolic link to hooks/seed.sh, outside scenarios/: the Studio writes scenarios only inside scenarios/ — edit it in your editor; the Studio shows it read-only.',
    });
    const e = (await failure(ui.scenarios.edit('w', 'lnk', { hash: sha(SHORT), edit: { kind: 'replace_text', text: SHORT.replace('0.2', '0.3') } }))) as EngineError;
    expect(e.code).toBe('refused');
    const m = (await failure(mcp.scenarios.save('w', 'lnk', SHORT.replace('0.2', '0.3'), { ifMatch: sha(SHORT) }))) as EngineError;
    expect(m.message).toBe('scenarios/lnk.yaml is a symbolic link to a file outside scenarios/: an agent writes scenarios only inside scenarios/ — edit it in your editor');
    expect(await readFile(join(dir, 'hooks', 'seed.sh'), 'utf8')).toBe(SHORT);
    // A person at a terminal edits it as before.
    expect((await cli.scenarios.view('w', 'lnk')).edit.yaml).toEqual({ ok: true });
  });

  it('A L3: restore takes only a version the Studio showed or wrote — undo of a delete of a step holding a zero-width space works', async () => {
    const t = SHORT.replace('      - hold: 0.2\n', `      - wait_for: "a${ZWSP}b"\n      - hold: 0.2\n`);
    await put('u.yaml', t);
    const shown = await ui.scenarios.view('w', 'u');
    const step = shown.blocks.entries.find((x) => x.type === 'scene');
    if (step?.type !== 'scene') throw new Error('scene');
    const d = await ui.scenarios.edit('w', 'u', { hash: shown.hash, edit: { kind: 'delete_step', at: { scene: 'a', index: 0, guard: step.steps[0].guard! } } });
    const r = await ui.scenarios.edit('w', 'u', { hash: d.hash, edit: { kind: 'restore', text: t, text_hash: sha(t) } });
    expect(await readFile(file('u.yaml'), 'utf8')).toBe(t);
    // A text no one showed: refused, whatever it holds.
    const made = SHORT.replace('0.2', '0.9');
    const e = (await failure(ui.scenarios.edit('w', 'u', { hash: r.hash, edit: { kind: 'restore', text: made, text_hash: sha(made) } }))) as EngineError;
    expect(e.code).toBe('refused');
    expect(e.message).toBe('the text to restore is not a version of scenarios/u.yaml the Studio showed or wrote: nothing written — read the file again');
    expect(sha(await readFile(file('u.yaml')))).toBe(r.hash);
  });

  it('A L4: from the Studio and through MCP, a file outside the project is "outside" whether it exists or not (no stat)', async () => {
    const mk = (f: string) => SHORT.replace('scenes:', `music: {file: "${f}"}\nscenes:`);
    for (const engine of [ui, mcp]) {
      const words = engine === ui ? 'from the Studio' : 'through MCP';
      const msgs = await Promise.all(
        ['/etc/hosts', '/etc/nonexistent-ds-zz'].map(async (f) =>
          (await engine.scenarios.validate('w', mk(f), {})).issues.filter((i) => i.path?.[0] === 'music').map((i) => i.message.replace(f, '<f>')),
        ),
      );
      expect(msgs[0]).toEqual([`music file "<f>" resolves outside the project folder: ${words} only files of the project folder are read`]);
      expect(msgs[1]).toEqual(msgs[0]);
    }
    const h0 = await put('music.yaml', SHORT);
    const errs = await Promise.all(
      ['/etc/hosts', '/etc/nonexistent-ds-zz'].map(async (f) =>
        ((await failure(ui.scenarios.edit('w', 'music', { hash: h0, edit: { kind: 'replace_text', text: mk(f) } }))) as ScenarioError).issues.map((i) => i.message.replace(f, '<f>')),
      ),
    );
    expect(errs[1]).toEqual(errs[0]);
    // A person at a terminal still learns the file is missing.
    expect((await cli.scenarios.validate('w', mk('/etc/nonexistent-ds-zz'), {})).issues.some((i) => i.message.includes('not found'))).toBe(true);
  });

  it('A M1: a name spelt with another case than the file is not that scenario (one file, one name, one lock)', async () => {
    await put('quote.yaml', SHORT);
    let insensitive = true;
    try {
      await stat(file('QUOTE.yaml'));
    } catch {
      insensitive = false;
    }
    if (!insensitive) return;
    const e = (await failure(ui.scenarios.get('w', 'QUOTE'))) as EngineError;
    expect(e.code).toBe('not_found');
    expect(e.message).toBe('scenario "QUOTE" not found in w: the file is scenarios/quote.yaml (scenario names are case-sensitive)');
    const m = (await failure(mcp.scenarios.save('w', 'Quote', SHORT, { ifMatch: sha(SHORT) }))) as EngineError;
    expect(m.code).toBe('conflict');
    expect(await readdir(join(dir, 'scenarios'))).toContain('quote.yaml');
    expect(await readdir(join(dir, 'scenarios'))).not.toContain('Quote.yaml');
  });
});
