/**
 * R-SHR-30…37: a project archive (engine project-archive/), on the disk: export (what goes in, what never does, the
 * workspace themes and components embedded, the needs by name, the literal-token warnings, a path theme refused, MCP's
 * limits), import (a person only; the manifest checked both ways; the never-list refused; records validated; the
 * slug, `as`, a conflict; the mark written before the rename and removed when the import fails; the code files computed
 * from the files written), and the trust listing (changed / new since the import), trust and discard.
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createComponent } from '@retake/components';
import { runRecordOnDisk } from '@retake/core/base';
import { PROJECT_ARCHIVE_MANIFEST } from '@retake/core/project';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import { syntheticRunRecord } from '@retake/test-support/render';
import { createZip } from '../src/archive/zip-write.js';
import { openZip } from '../src/archive/zip-read.js';
import { createEngine } from '../src/index.js';
import type { Engine, EngineError } from '../src/index.js';
import { importMarkFile, importMarkerFile, importTrust, readImportMark } from '../src/project-archive/trust.js';
import type { ProjectManifest } from '../src/project-archive/manifest.js';
import { importProjectArchive } from '../src/project-archive/import.js';
import { placeArchive } from '../src/project-archive/export.js';
import { ManualClock } from '../src/clock.js';
import { callerOf } from '../src/caller.js';
import { diskProjectStores } from '../src/store/project-store.js';
import type { ProjectStore, ProjectStores } from '../src/store/store.js';
import { openWorkspace } from '../src/workspace.js';
import { diskWorkspaceReads } from '../src/workspace-reads/disk-reads.js';
import { diskOutputs } from '../src/outputs/disk-outputs.js';
import { packageRegistries } from '@retake/compose';
import { invoke } from '../src/operations/invoke.js';
import { OPERATIONS_BY_NAME } from '../src/operations/index.js';
import type { ToolDef } from '../src/operations/define.js';

let root: string;
let other: string;
let cli: Engine;
let mcp: Engine;
let there: Engine;
const proj = (slug = 'demo', at = root) => join(at, 'projects', slug);
const RUN = '20260101-120000-demo-up';
const SECRET = 'sk-live-0123456789abcdefABCDEF';

async function refusal(p: Promise<unknown>): Promise<EngineError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x as EngineError,
  );
  if (!e) throw new Error('expected a refusal');
  return e;
}

async function write(file: string, text: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** demo: a workspace theme (brand) and a workspace component (acme/shared) it uses, planted secrets and a run. */
async function demo(): Promise<void> {
  await cp(join(STARTER_TEMPLATES_DIR, 'editorial'), join(root, 'templates', 'brand'), { recursive: true });
  await createComponent(root, {
    id: 'acme/shared',
    kind: 'intro',
    componentsDir: join(root, 'components'),
    builtinDir: null,
    write: (file, text) => write(file, text),
  });
  const p = proj();
  await write(
    join(p, 'project.yaml'),
    `name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: brand\nauth:\n  storage_state: auth/state.json\nmailbox:\n  provider: http\n  url: http://localhost:8025\n  headers:\n    x-api-key: plain-value\n`,
  );
  await write(join(p, 'README.md'), '# Demo\n');
  await write(join(p, 'scenarios', 'demo-up.yaml'), `video: demo\nscenes:\n  - id: a\n    page: app\n    steps:\n      - hold: 1\n# intro: acme/shared\nvars:\n  pass: "{{env:DEMO_PASSWORD}}"\n`);
  await write(join(p, 'hooks', 'seed.sh'), `#!/bin/sh\necho "{{keychain:demo/admin}}"\n`);
  await write(join(p, 'assets', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await write(join(p, 'notes.md'), `token: ${SECRET}\n`);
  // What never goes in.
  await write(join(p, '.env'), 'DEMO_PASSWORD=hunter2\n');
  await write(join(p, 'sandbox', '.env.local'), 'X=1\n');
  await write(join(p, '.retake', 'scenario-writes.jsonl'), '{}\n');
  await write(join(p, 'exports', 'old.zip'), 'zip');
  await write(join(p, 'keys', 'id_rsa'), 'PRIVATE');
  await write(join(p, 'certs', 'server.pem'), 'PEM');
  await write(join(p, 'auth', 'state.json'), '{"cookies":[]}');
  await symlink('/etc', join(p, 'linked'));
  // A run (its record as the disk holds it: relative paths).
  const runDir = join(p, 'runs', RUN);
  await write(join(runDir, 'capture.mp4'), Buffer.alloc(64));
  await write(join(runDir, 'timeline.json'), '{}');
  await write(join(runDir, 'run.json'), JSON.stringify(runRecordOnDisk(syntheticRunRecord(runDir, { id: RUN, scenario: 'demo-up', project: 'demo' }), p)));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-archive-a-'));
  other = await mkdtemp(join(tmpdir(), 'retake-archive-b-'));
  for (const r of [root, other]) {
    await writeFile(join(r, 'retake.yaml'), 'projects_dir: projects\ntemplates_dir: templates\n');
    await mkdir(join(r, 'projects'), { recursive: true });
  }
  await demo();
  cli = await createEngine({ root, client: 'cli', autoStartWorker: false });
  mcp = await createEngine({ root, client: 'mcp', autoStartWorker: false });
  there = await createEngine({ root: other, client: 'cli', autoStartWorker: false });
});

afterEach(async () => {
  for (const r of [root, other]) if (r) await rm(r, { recursive: true, force: true });
});

/** The entry names and the manifest of an archive. */
async function contents(file: string): Promise<{ names: string[]; manifest: ProjectManifest; bytes: Buffer }> {
  const z = await openZip(file);
  try {
    const last = z.entries[z.entries.length - 1]!;
    const manifest = JSON.parse((await z.readAll(last, 1 << 26)).toString('utf8')) as ProjectManifest;
    const all: Buffer[] = [];
    for (const e of z.entries) all.push(await z.readAll(e, 1 << 26));
    return { names: z.entries.map((e) => e.name), manifest, bytes: Buffer.concat(all) };
  } finally {
    await z.close();
  }
}

describe('project export (R-SHR-30, R-SHR-31)', () => {
  it('takes the project, the workspace theme and component it uses, a manifest last — never the never-list, its secrets by name only', async () => {
    const r = await cli.projects.exportArchive({ project: 'demo', withRuns: true });
    expect(r.file).toMatch(/projects\/demo\/exports\/demo-project-\d{8}-\d{6}\.zip$/);
    const { names, manifest, bytes } = await contents(r.file!);
    expect(names[names.length - 1]).toBe(PROJECT_ARCHIVE_MANIFEST);
    expect(names).toEqual(
      expect.arrayContaining([
        'project/project.yaml',
        'project/hooks/seed.sh',
        'project/templates/brand/template.yaml',
        'project/components/acme/shared/component.yaml',
        `project/runs/${RUN}/run.json`,
      ]),
    );
    for (const n of names) expect(n, n).not.toMatch(/\.env|\.retake|exports\/|id_rsa|\.pem$|linked|auth\/state\.json/);
    expect(manifest.excluded).toEqual({ env: ['.env', 'sandbox/.env.local'], sensitive: ['auth/state.json', 'certs/server.pem', 'keys/id_rsa'], links: ['linked'], special: [], outside_renders: [] });
    expect(manifest.embedded).toEqual({ themes: ['brand'], components: ['acme/shared'] });
    expect(manifest.needs).toMatchObject({ env_vars: ['DEMO_PASSWORD'], keychain: ['demo/admin'] });
    expect(manifest.files.find((f) => f.path === 'hooks/seed.sh')).toMatchObject({ mode: '644', origin: 'project' });
    expect(manifest.files.find((f) => f.path === 'templates/brand/template.yaml')?.origin).toBe('workspace-theme');
    // Values never: the .env password, the key file; the token is flagged where it lies (and stays: warned, not removed).
    expect(bytes.includes(Buffer.from('hunter2'))).toBe(false);
    expect(bytes.includes(Buffer.from('PRIVATE'))).toBe(false);
    expect(manifest.warnings.literal_tokens.map((w) => [w.file, w.lines])).toEqual([
      ['notes.md', [1]],
      ['project.yaml', [11]],
    ]);
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
  });

  it('without --with-runs no run; a dry run writes nothing; MCP: no runs, no --out, its own exports/ folder', async () => {
    const dry = await mcp.projects.exportArchive({ project: 'demo', dryRun: true });
    expect([dry.dry_run, dry.file, dry.with_runs]).toEqual([true, undefined, false]);
    expect(existsSync(join(proj(), 'exports')) && (await readdir(join(proj(), 'exports')))).toEqual(['old.zip']);
    const r = await mcp.projects.exportArchive({ project: 'demo' });
    expect((await contents(r.file!)).names.some((n) => n.startsWith('project/runs/'))).toBe(false);
    expect((await refusal(mcp.projects.exportArchive({ project: 'demo', withRuns: true }))).message).toMatch(/without its runs/);
    expect((await refusal(mcp.projects.exportArchive({ project: 'demo', out: other }))).message).toMatch(/exports\/ folder/);
    // A person's --out: never inside the project but its exports/, never over a file.
    expect((await refusal(cli.projects.exportArchive({ project: 'demo', out: join(proj(), 'x.zip') }))).message).toMatch(/inside the project/);
    const out = await cli.projects.exportArchive({ project: 'demo', out: join(other, 'a.zip') });
    expect(out.file).toBe(join(other, 'a.zip'));
    expect((await refusal(cli.projects.exportArchive({ project: 'demo', out: join(other, 'a.zip') }))).code).toBe('conflict');
  });

  it('a theme named by a path outside the project is refused: adopt it first', async () => {
    await writeFile(join(proj(), 'project.yaml'), 'name: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: ../../templates/brand\n');
    const e = await refusal(cli.projects.exportArchive({ project: 'demo' }));
    expect([e.code, e.message]).toEqual(['refused', expect.stringMatching(/by a path outside the project.*retake project adopt demo --theme/)]);
  });
});

describe('project import (R-SHR-34, R-SHR-35)', () => {
  it('a person imports it whole under its slug or --as, untrusted: marker and mark agree, the code files computed here', async () => {
    const { file } = await cli.projects.exportArchive({ project: 'demo', withRuns: true });
    expect((await refusal(createEngine({ root: other, client: 'mcp', autoStartWorker: false }).then((e) => e.projects.importArchive(file!)))).message).toMatch(/by a person/);
    const r = await there.projects.importArchive(file!);
    expect([r.project, r.dir, r.exported_as]).toEqual(['demo', proj('demo', other), 'demo']);
    expect(await readFile(join(r.dir, 'templates', 'brand', 'template.yaml'), 'utf8')).toBe(await readFile(join(root, 'templates', 'brand', 'template.yaml'), 'utf8'));
    expect(existsSync(join(r.dir, 'components', 'acme', 'shared', 'component.yaml'))).toBe(true);
    expect(existsSync(join(r.dir, 'runs', RUN, 'capture.mp4'))).toBe(true);
    // Computed from the files written: the hooks, the embedded component's files, project.yaml, the theme's SVG logo.
    expect(r.code_files.map((c) => [c.path, c.why])).toEqual(
      expect.arrayContaining([
        ['hooks/seed.sh', 'hooks'],
        ['components/acme/shared/component.yaml', 'component'],
        ['project.yaml', 'settings'],
        ['assets/logo.svg', 'theme'],
      ]),
    );
    // The exporter's list and the one computed here agree (embedded theme and component files included).
    expect(r.warnings.filter((w) => /code file/.test(w))).toEqual([]);
    const mark = await readImportMark(other, 'demo');
    expect(typeof mark === 'object' && mark.trusted).toBe(undefined);
    expect(JSON.parse(await readFile(importMarkerFile(r.dir), 'utf8')).import_id).toBe(typeof mark === 'object' ? mark.import_id : 'none');
    expect((await importTrust({ root: other, dir: r.dir, slug: 'demo' }, process.env)).state).toBe('untrusted');
    // The same slug again: a conflict, never a replace; --as another slug lands beside it.
    const taken = await refusal(there.projects.importArchive(file!));
    expect([taken.code, taken.message, taken.fix]).toEqual(['conflict', expect.stringMatching(/a project demo exists already in this workspace/), 'retake project import <archive> --as demo-2']);
    expect((await there.projects.importArchive(file!, { as: 'demo-2' })).dir).toBe(proj('demo-2', other));
  });

  it('refuses an archive whose entries and manifest disagree, or that holds .retake/, .env or a key file', async () => {
    const { file } = await cli.projects.exportArchive({ project: 'demo' });
    const good = await contents(file!);
    const craft = async (name: string, entries: Array<[string, string]>, manifest: ProjectManifest = good.manifest) => {
      const f = join(other, name);
      const z = await createZip(f);
      for (const [n, t] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) await z.add(n, { data: Buffer.from(t) }, { mode: 0o644, mtime: new Date(0) });
      await z.add(PROJECT_ARCHIVE_MANIFEST, { data: Buffer.from(JSON.stringify(manifest)) }, { mode: 0o644, mtime: new Date(0) });
      await z.close();
      return f;
    };
    const tries = async (f: string, why: RegExp) => {
      const e = await refusal(there.projects.importArchive(f));
      expect(e.message, f).toMatch(why);
      expect(existsSync(proj('demo', other)), f).toBe(false);
      expect(existsSync(importMarkFile(other, 'demo')), f).toBe(false);
    };
    const one = { path: 'README.md', size: 7, sha256: 'b'.repeat(64), mode: '644' as const, origin: 'project' as const };
    await tries(await craft('unlisted.zip', [['project/README.md', '# Demo\n']], { ...good.manifest, files: [] }), /not listed/);
    await tries(await craft('missing.zip', [], { ...good.manifest, files: [one] }), /does not hold/);
    await tries(await craft('sha.zip', [['project/README.md', '# Demo\n']], { ...good.manifest, files: [one] }), /sha256/);
    for (const [i, [n, why]] of (
      [
        ['project/.retake/import.json', /state folder/],
        ['project/.ENV', /env file/],
        ['project/keys/ID_ED25519', /key or credential/],
      ] as const
    ).entries())
      await tries(await craft(`bad-${i}.zip`, [[n, 'x']], { ...good.manifest, files: [{ ...one, path: n.slice(8), size: 1 }] }), why);
    await tries(await craft('newer.zip', [], { ...good.manifest, version: 2 as 1, files: [] }), /newer Retake/);
  });

  it('a run, render or review record naming a path outside its folder is refused with what it owns, the rest imported', async () => {
    const runDir = join(proj(), 'runs', RUN);
    const rec = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    await writeFile(join(runDir, 'run.json'), JSON.stringify({ ...rec, capture: '/etc/hosts' }));
    await write(join(proj(), 'runs', 'other-run', 'run.json'), JSON.stringify({ ...rec, dir: '.', capture: '../../../x.mp4' }));
    // A render record's bound is its project: a path climbing out of it is refused, the render's files with it.
    await write(join(proj(), 'renders', 'demo-up-v1.json'), JSON.stringify({ version: 2, record: 'demo-up-v1.json', file: '../../outside.mp4', run_dir: `../runs/${RUN}` }));
    await write(join(proj(), 'renders', 'demo-up-v1.mp4'), Buffer.alloc(8));
    const exported = await cli.projects.exportArchive({ project: 'demo', withRuns: true });
    // The render whose record leaves the project is left out at the export already (its import would refuse it).
    expect(exported.excluded.outside_renders).toEqual(['demo-up-v1']);
    const r = await there.projects.importArchive(exported.file!);
    expect(r.refused_records).toEqual([
      expect.stringMatching(/^runs\/20260101-120000-demo-up\/run\.json: it names an absolute path — runs\/20260101-120000-demo-up left out$/),
      expect.stringMatching(/^runs\/other-run\/run\.json: it names a path outside its folder/),
    ]);
    expect(existsSync(join(r.dir, 'runs'))).toBe(false);
    expect(existsSync(join(r.dir, 'renders'))).toBe(false);
    expect(existsSync(join(r.dir, 'scenarios', 'demo-up.yaml'))).toBe(true);
  });

  it('the mark is written before the folder lands, and removed when the import fails after it', async () => {
    const { file } = await cli.projects.exportArchive({ project: 'demo' });
    const ws = await openWorkspace({ root: other, agent: false, reads: diskWorkspaceReads, outputs: diskOutputs, registries: packageRegistries() });
    const seen: boolean[] = [];
    // The recheck runs after the stage is built, right before the rename: the mark is there already; a folder of the
    // slug made then is a conflict — nothing replaced, the mark removed.
    const stores: ProjectStores = {
      ...diskProjectStores,
      at: (r, sc, o) => {
        const st = diskProjectStores.at(r, sc, o);
        return new Proxy(st, {
          get: (t, k) =>
            k === 'createFolder'
              ? (parent: string, name: string, opts: Parameters<ProjectStore['createFolder']>[2]) =>
                  t.createFolder(parent, name, {
                    ...opts,
                    recheck: async () => {
                      seen.push(existsSync(importMarkFile(other, 'demo')));
                      await mkdir(join(parent, name));
                      return opts.recheck();
                    },
                  })
              : (Reflect.get(t, k) as unknown),
        });
      },
    };
    const scope = { workspace: other, caller: callerOf('cli'), clock: new ManualClock('2026-11-18T00:00:00.000Z'), stores };
    const e = await refusal(importProjectArchive(ws, file!, { trust: 'author', scope, env: process.env, now: '2026-11-18T00:00:00.000Z', archiveSha256: 'a'.repeat(64) }));
    expect([e.code, seen]).toEqual(['conflict', [true]]);
    expect(existsSync(importMarkFile(other, 'demo'))).toBe(false);
    expect(await readdir(proj('demo', other))).toEqual([]);
  });
});

describe('project trust (R-SHR-37)', () => {
  it('lists the code files changed or new since the import, trusts them signed, and discards an import nobody trusted', async () => {
    const { file } = await cli.projects.exportArchive({ project: 'demo' });
    const r = await there.projects.importArchive(file!);
    await writeFile(join(r.dir, 'hooks', 'seed.sh'), '#!/bin/sh\necho changed\n');
    await write(join(r.dir, 'hooks', 'new.sh'), 'echo new\n');
    const v = await there.projects.trustView('demo');
    expect(v.state).toBe('untrusted');
    expect(v.files.filter((f) => f.path.startsWith('hooks/')).map((f) => [f.path, f.since])).toEqual([
      ['hooks/new.sh', 'new'],
      ['hooks/seed.sh', 'changed'],
    ]);
    // Changed while read: refused, nothing signed.
    await writeFile(join(r.dir, 'hooks', 'new.sh'), 'echo newer\n');
    expect((await refusal(there.projects.trust('demo', v))).code).toBe('conflict');
    const t = await there.projects.trust('demo', await there.projects.trustView('demo'));
    expect(t.state).toBe('trusted');
    expect((await importTrust({ root: other, dir: r.dir, slug: 'demo' }, process.env)).state).toBe('trusted');
    expect((await refusal(there.projects.discardImport('demo'))).message).toMatch(/is trusted/);
    // Another import, discarded: its folder set aside, its mark gone.
    const d2 = await there.projects.importArchive(file!, { as: 'demo-2' });
    const d = await there.projects.discardImport('demo-2');
    expect(existsSync(d2.dir)).toBe(false);
    expect(existsSync(join(d.moved_to, 'project.yaml'))).toBe(true);
    expect(existsSync(importMarkFile(other, 'demo-2'))).toBe(false);
    // An ordinary project: nothing to trust; MCP: never.
    expect((await refusal(cli.projects.trustView('demo'))).message).toMatch(/nothing to trust/);
    expect((await refusal(mcp.projects.trustView('demo'))).message).toMatch(/a person trusts/);
  });
});

describe('MCP and the Studio (R-SHR-38, R-SHR-39)', () => {
  it('project_export through MCP: a dry run, then the archive in exports/; the imported project refused through MCP and flagged on the board', async () => {
    const op = OPERATIONS_BY_NAME.project_export as ToolDef;
    const o = { shell: 'mcp' as const, startedIn: root, signal: new AbortController().signal };
    const dry = await invoke(op, mcp, { project: 'demo', dry_run: true }, o);
    expect(dry.ok).toBe(true);
    const d = dry.ok ? (dry.output as { summary: string; data: Record<string, unknown> & { untrusted: { needs: { env_vars: string[] } } } }) : undefined;
    expect(d?.summary).toMatch(/^would export project demo: \d+ files/);
    expect(d?.data.untrusted.needs.env_vars).toEqual(['DEMO_PASSWORD']);
    const done = await invoke(op, mcp, { project: 'demo' }, o);
    const file = done.ok ? (done.output as { data: { file: string } }).data.file : '';
    expect(file).toMatch(/projects\/demo\/exports\//);
    expect((await invoke(op, mcp, { project: 'demo', with_runs: true }, o)).ok).toBe(false);
    // Imported elsewhere: refused through MCP (a dry run, a render), readable; the Studio's board says so.
    await there.projects.importArchive(file);
    const mcpThere = await createEngine({ root: other, client: 'mcp', autoStartWorker: false });
    const run = await invoke(OPERATIONS_BY_NAME.run_dry as ToolDef, mcpThere, { project: 'demo', scenario: 'demo-up', wait_s: 0 }, o);
    expect(!run.ok && run.error.message).toMatch(/^demo was imported from a project archive and is not trusted/);
    const get = await invoke(OPERATIONS_BY_NAME.scenario_get as ToolDef, mcpThere, { project: 'demo', name: 'demo-up' }, o);
    expect(get.ok).toBe(true);
    const ui = await createEngine({ root: other, client: 'ui', autoStartWorker: false });
    expect((await ui.projects.board('demo')).imported).toEqual({ trusted: false, command: 'retake project trust demo' });
    expect((await cli.projects.board('demo')).imported).toBeUndefined();
  });
});

/** An archive of `entries` and the manifest of an export of demo (its files list emptied): judged before any listing. */
async function hostile(name: string, entries: Array<[string, string]>): Promise<string> {
  const { file } = await cli.projects.exportArchive({ project: 'demo', out: join(other, `${name}.src.zip`) });
  const z0 = await openZip(file!);
  const manifest = JSON.parse((await z0.readAll(z0.entries[z0.entries.length - 1]!, 1 << 26)).toString('utf8')) as ProjectManifest;
  await z0.close();
  const f = join(other, name);
  const z = await createZip(f);
  for (const [n, t] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) await z.add(n, { data: Buffer.from(t) }, { mode: 0o644, mtime: new Date(0) });
  await z.add(PROJECT_ARCHIVE_MANIFEST, { data: Buffer.from(JSON.stringify({ ...manifest, files: [] })) }, { mode: 0o644, mtime: new Date(0) });
  await z.close();
  return f;
}

describe('what an archive may never hold, what the trust list shows', () => {
  it('refuses .git/, node_modules/ and .DS_Store (Retake never archives them) and a layout name spelt otherwise', async () => {
    for (const [i, [n, why]] of (
      [
        ['project/.git/config', /a git folder, node_modules or a Finder file/],
        ['project/node_modules/x/index.js', /a git folder, node_modules or a Finder file/],
        ['project/.DS_Store', /a git folder, node_modules or a Finder file/],
        ['project/Runs/r1/RUN.JSON', /spells a name of the project's layout otherwise than Retake does: Runs \(the layout's runs\)/],
        ['project/runs/r1/RUN.JSON', /RUN\.JSON \(the layout's run\.json\)/],
        ['project/renders/Quote-V1.JSON', /a render's names are lower case/],
      ] as const
    ).entries()) {
      const e = await refusal(there.projects.importArchive(await hostile(`h-${i}.zip`, [[n, '{"capture": "/etc/hosts"}']])));
      expect(e.message, n).toMatch(why);
      expect(existsSync(proj('demo', other)), n).toBe(false);
      expect(existsSync(importMarkFile(other, 'demo')), n).toBe(false);
    }
  });

  it('lists tool configs, any Lottie, a sql file a hook names, .sql scripts; the per-environment sign-in profile; a scenario theme outside', async () => {
    const p = proj();
    await write(join(p, '.vscode', 'tasks.json'), '{"tasks": []}');
    await write(join(p, '.claude', 'settings.json'), '{}');
    await write(join(p, 'docs', 'CLAUDE.md'), '# instructions\n');
    await write(join(p, 'media', 'intro.json'), JSON.stringify({ v: '5.7.0', layers: [{ ks: { o: { x: 'eval()' } } }] }));
    await write(join(p, 'data', 'seed.sql'), 'delete from orders;\n');
    await write(join(p, 'data', 'named.txt'), 'x');
    await write(join(p, 'scenarios', 'lottie.yaml'), 'video: x\nsetup:\n  - sql: {file: data/named.txt, database: db}\nscenes:\n  - id: a\n    page: app\n    steps:\n      - hold: 1\n');
    await writeFile(join(p, 'project.yaml'), `${await readFile(join(p, 'project.yaml'), 'utf8')}`.replace('auth:\n  storage_state: auth/state.json\n', 'auth:\n  local:\n    profile: "~/Library/Application Support/Browser/Default"\n'));
    const { file } = await cli.projects.exportArchive({ project: 'demo' });
    const r = await there.projects.importArchive(file!);
    const listed = Object.fromEntries(r.code_files.map((c) => [c.path, c.why]));
    expect(listed).toMatchObject({
      '.vscode/tasks.json': 'tool-config',
      '.claude/settings.json': 'tool-config',
      'docs/CLAUDE.md': 'tool-config',
      'media/intro.json': 'theme',
      'data/seed.sql': 'code',
      'data/named.txt': 'named',
      'scenarios/lottie.yaml': 'scenario',
    });
    expect(r.settings).toEqual(expect.arrayContaining([expect.stringMatching(/^auth\.local\.profile: ~\/Library\/Application Support\/Browser\/Default \(outside the project\)/)]));
    // A scenario's theme leading outside (an archive not made by our export may hold one): said in the listing.
    await writeFile(join(r.dir, 'scenarios', 'lottie.yaml'), `template: ../../elsewhere/theme\n${await readFile(join(r.dir, 'scenarios', 'lottie.yaml'), 'utf8')}`);
    expect((await there.projects.trustView('demo')).settings).toContain('scenario lottie.yaml: template ../../elsewhere/theme (outside the project)');
    // Changed after the import: said so.
    await writeFile(join(r.dir, 'data', 'named.txt'), 'y');
    expect((await there.projects.trustView('demo')).files.find((f) => f.path === 'data/named.txt')?.since).toBe('changed');
  });

  it('never archives the wider credential files; flags a token in a file of any extension', async () => {
    const p = proj();
    for (const f of ['.aws/credentials', '.git-credentials', '.docker/config.json', 'secrets/prod.env', 'app.env.local', '.ssh/config', 'infra/terraform.tfstate', 'playwright/.auth/user.json', 'vault.kdbx', 'keys/service-account.json'])
      await write(join(p, f), 'ghp_0123456789abcdefghijABCDEFGHIJ\n');
    await write(join(p, 'notes.conf'), 'token = sk-live-0123456789abcdefXYZ\n');
    const r = await cli.projects.exportArchive({ project: 'demo', dryRun: true });
    const out = [...r.excluded.env, ...r.excluded.sensitive];
    for (const f of ['.aws/credentials', '.git-credentials', '.docker/config.json', 'secrets/prod.env', 'app.env.local', '.ssh/config', 'infra/terraform.tfstate', 'playwright/.auth/user.json', 'vault.kdbx', 'keys/service-account.json'])
      expect(out, f).toContain(f);
    expect(r.warnings.literal_tokens.map((w) => w.file)).toContain('notes.conf');
  });

  it('with the runs, a render made with a theme outside the project is left out with its review, and said', async () => {
    const p = proj();
    await write(join(p, 'renders', 'demo-up-v1.json'), JSON.stringify({ version: 2, record: 'demo-up-v1.json', file: 'demo-up-v1.mp4', run_dir: `../runs/${RUN}`, plan: { assets: { logo: join(STARTER_TEMPLATES_DIR, 'editorial', 'logo.svg') } } }));
    await write(join(p, 'renders', 'demo-up-v1.mp4'), Buffer.alloc(8));
    await write(join(p, 'review', 'demo-up-v1', 'report.json'), '{}');
    const r = await cli.projects.exportArchive({ project: 'demo', withRuns: true });
    expect(r.excluded.outside_renders).toEqual(['demo-up-v1']);
    const names = (await contents(r.file!)).names;
    expect(names.filter((n) => /demo-up-v1/.test(n))).toEqual([]);
    expect(names).toContain(`project/runs/${RUN}/run.json`);
  });

  it('an import leaves out the review of a render it refuses', async () => {
    const p = proj();
    await write(join(p, 'renders', 'demo-up-v2.json'), JSON.stringify({ version: 2, record: 'demo-up-v2.json', file: '../../x.mp4' }));
    await write(join(p, 'review', 'demo-up-v2', 'report.json'), '{}');
    // An archive made by hand around our export's choice: the export leaves such a render out, so plant it after.
    const { file } = await cli.projects.exportArchive({ project: 'demo', withRuns: true });
    expect((await contents(file!)).names.some((n) => n.includes('demo-up-v2'))).toBe(false);
    const z0 = await openZip(file!);
    const manifest = JSON.parse((await z0.readAll(z0.entries[z0.entries.length - 1]!, 1 << 26)).toString('utf8')) as ProjectManifest;
    const kept: Array<[string, Buffer]> = [];
    for (const e of z0.entries.slice(0, -1)) kept.push([e.name, await z0.readAll(e, 1 << 26)]);
    await z0.close();
    const add: Array<[string, Buffer]> = [
      ['project/renders/demo-up-v2.json', await readFile(join(p, 'renders', 'demo-up-v2.json'))],
      ['project/review/demo-up-v2/report.json', Buffer.from('{}')],
    ];
    const all = [...kept, ...add].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const f = join(other, 'planted.zip');
    const z = await createZip(f);
    const files = [...manifest.files];
    for (const [n, data] of all) {
      const a = await z.add(n, { data }, { mode: 0o644, mtime: new Date(0) });
      if (add.some(([x]) => x === n)) files.push({ path: n.slice(8), size: a.size, sha256: a.sha256, mode: '644', origin: 'project' });
    }
    await z.add(PROJECT_ARCHIVE_MANIFEST, { data: Buffer.from(JSON.stringify({ ...manifest, files })) }, { mode: 0o644, mtime: new Date(0) });
    await z.close();
    const r = await there.projects.importArchive(f);
    expect(r.refused_records).toEqual([expect.stringMatching(/^renders\/demo-up-v2\.json: it names a path outside its folder/)]);
    expect(existsSync(join(r.dir, 'review', 'demo-up-v2'))).toBe(false);
    expect(existsSync(join(r.dir, 'runs', RUN, 'run.json'))).toBe(true);
  });

  it('a 20 MB file of zeros exports and imports (stored past the bomb ratio)', async () => {
    await write(join(proj(), 'data', 'silence.bin'), Buffer.alloc(20 * 1024 * 1024));
    const { file } = await cli.projects.exportArchive({ project: 'demo' });
    const r = await there.projects.importArchive(file!);
    expect((await readFile(join(r.dir, 'data', 'silence.bin'))).length).toBe(20 * 1024 * 1024);
  });

  it('the archive is put in place without hard links (exFAT), never over a file; other failures in words', async () => {
    const partial = join(other, 'a.partial');
    const target = join(other, 'a.zip');
    await writeFile(partial, 'zip');
    const noLinks = { link: async () => Promise.reject(Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' })), copyFile: (await import('node:fs/promises')).copyFile };
    await placeArchive(partial, target, noLinks);
    expect([await readFile(target, 'utf8'), existsSync(partial)]).toEqual(['zip', false]);
    await writeFile(partial, 'other');
    expect((await refusal(placeArchive(partial, target, noLinks))).code).toBe('conflict');
    expect(await readFile(target, 'utf8')).toBe('zip');
    await writeFile(partial, 'x');
    const broken = { link: async () => Promise.reject(Object.assign(new Error('i/o'), { code: 'EIO' })), copyFile: noLinks.copyFile };
    const e = await refusal(placeArchive(partial, join(other, 'b.zip'), broken));
    expect([e.code, e.message]).toEqual(['refused', expect.stringMatching(/could not be put at .*b\.zip \(EIO: i\/o\): choose another place with --out/)]);
  });

  it('trust, --list and --discard take a slug, never a path', async () => {
    for (const bad of ['../x', 'a/b', 'Demo']) expect((await refusal(there.projects.trustView(bad))).message, bad).toMatch(/a project slug .*never a path/);
    expect((await refusal(there.projects.discardImport('../x'))).message).toMatch(/a project slug .*never a path/);
    // The mark's file itself is named by a slug only.
    expect(() => importMarkFile(other, '../x')).toThrow(/not a project slug/);
  });
});
