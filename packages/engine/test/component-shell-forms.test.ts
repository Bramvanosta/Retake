/**
 * The shell forms of the component use cases (L7.24, U8d: the CLI's `retake components` on the engine): what the CLI's
 * characterization (packages/cli/test/operations-cli.test.ts) does not reach — a scaffold over a built-in id, a kind's
 * scaffold named for a preview, a component with a manifest that does not validate, the preview READMEs' journal — and
 * the MCP forms beside them, unchanged.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPONENT_KINDS } from '@retake/core';
import {
  componentCreate,
  componentCreateShell,
  componentListEntries,
  componentPreviewTargets,
  componentPreviewTheme,
  componentReadmeWriter,
  componentValidate,
  componentValidateShell,
  enginePorts,
  openWorkspace,
  personScope,
} from '../src/index.js';
import type { OpenedWorkspace } from '../src/index.js';

let root: string;
let ws: OpenedWorkspace;
const savedHome = process.env.RETAKE_HOME;
const scope = () => personScope(root, enginePorts());

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'retake-component-shell-'));
  process.env.RETAKE_HOME = join(root, '.home');
  await writeFile(join(root, 'retake.yaml'), 'version: 1\nprojects_dir: projects\n');
  await mkdir(join(root, 'projects'), { recursive: true });
  ws = await openWorkspace({ root, agent: false });
}, 60_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe('the component use cases a shell calls (L7.24)', () => {
  it('create: a shell may scaffold over a built-in id (overrides names the built-in), the MCP form refuses it; a bad id is the scaffold\'s own words', async () => {
    await expect(componentCreate(ws, { id: 'studio/intro-stack', kind: 'intro', description: 'Mine.' }, scope())).rejects.toMatchObject({ code: 'refused' });
    const created = await componentCreateShell(ws, { id: 'studio/intro-stack', kind: 'intro', description: 'Mine.' }, scope());
    expect(created.overrides).toMatch(/library[/\\]studio[/\\]intro-stack$/);
    expect(created.manifest.id).toBe('studio/intro-stack');
    expect(created.dir).toBe(join(ws.componentsDir, 'studio', 'intro-stack'));
    const bad = await componentCreateShell(ws, { id: 'Badge', kind: 'overlay' }, scope()).catch((e: Error) => e);
    expect((bad as Error).message).toMatch(/^invalid component id "Badge": use "namespace\/name"/);
    expect(bad).not.toHaveProperty('code');
    const list = await componentListEntries(ws, 'intro');
    const mine = list.components.find((c) => c.id === 'studio/intro-stack');
    expect(mine?.source).toBe('workspace');
    expect(list.notices.find((n) => n.id === 'studio/intro-stack')).toMatchObject({ severity: 'warning', source: 'workspace' });
    await rm(join(ws.componentsDir, 'studio'), { recursive: true, force: true });
  });

  it('validate by folder and by id; every workspace component, a broken one by its folder\'s id', async () => {
    await componentCreateShell(ws, { id: 'acme/badge', kind: 'overlay', description: 'A badge.' }, scope());
    const broken = join(ws.componentsDir, 'acme', 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'component.yaml'), 'id: acme/broken\nkind: nonsense\n');
    const byDir = await componentValidateShell(ws, { ref: 'here', dir: join(ws.componentsDir, 'acme', 'badge') });
    expect(byDir.components).toEqual([{ id: 'acme/badge', dir: join(ws.componentsDir, 'acme', 'badge'), ok: true, issues: [] }]);
    const all = await componentValidateShell(ws, { workspace: true });
    expect(all.components.map((c) => [c.id, c.ok])).toEqual([
      ['acme/badge', true],
      ['acme/broken', false],
    ]);
    await expect(componentValidateShell(ws, { ref: 'acme/nope', dir: join(root, 'nowhere') })).rejects.toThrow(/component "acme\/nope" not found/);
    // The MCP form, unchanged: by id only.
    await expect(componentValidate(ws, join(root, 'nowhere'))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('preview targets: a kind\'s scaffold by name, a manifest that does not validate refused, --all with and without the scaffolds', async () => {
    const card = await componentPreviewTargets(ws, { ref: { ref: 'scaffolds/card', dir: join(root, 'scaffolds', 'card') } });
    expect('targets' in card && card.targets.map((t) => t.dir)).toEqual([expect.stringMatching(/scaffolds[/\\]card$/)]);
    expect('theme' in card && card.theme).toBe('editorial');
    // A manifest that loads, an entry that does not compile: not rendered.
    const odd = join(ws.componentsDir, 'acme', 'odd');
    await componentCreateShell(ws, { id: 'acme/odd', kind: 'card', description: 'Odd.' }, scope());
    await writeFile(join(odd, 'index.tsx'), 'export default function (: {\n');
    const invalid = await componentPreviewTargets(ws, { ref: { ref: 'acme/odd', dir: odd } });
    expect('invalid' in invalid && invalid.invalid.id).toBe('acme/odd');
    expect('invalid' in invalid && invalid.invalid.issues.some((i) => i.severity === 'error' && i.file === 'index.tsx')).toBe(true);
    await rm(odd, { recursive: true, force: true });
    const mine = await componentPreviewTargets(ws, { all: true, workspaceOnly: true });
    expect('targets' in mine && mine.targets.map((t) => t.id)).toEqual(['acme/badge']);
    const every = await componentPreviewTargets(ws, { all: true, workspaceOnly: false });
    const dirs = 'targets' in every ? every.targets.map((t) => t.dir) : [];
    expect(dirs.filter((d) => /scaffolds[/\\][a-z]+$/.test(d))).toHaveLength(COMPONENT_KINDS.length);
    // --stale on a theme no preview was made with: every one is stale.
    const stale = await componentPreviewTargets(ws, { all: true, workspaceOnly: true }, { theme: 'motion', stale: true });
    expect('targets' in stale && stale.targets.map((t) => t.id)).toEqual(['acme/badge']);
  });

  it('the preview theme: the previews\' own by default, by name; the README writer journals as its caller, under <components_dir> outside the workspace', async () => {
    const t = await componentPreviewTheme(ws);
    expect([t.theme, t.template.name]).toEqual(['editorial', 'editorial']);
    expect((await componentPreviewTheme(ws, 'motion')).template.name).toBe('motion');
    const readme = join(ws.componentsDir, 'acme', 'badge', 'README.md');
    const w = componentReadmeWriter(ws, scope());
    expect(w.root).toBe(ws.componentsDir);
    const before = await readFile(readme, 'utf8');
    await w.write(readme, `${before}\nA line.\n`, before);
    expect(await readFile(readme, 'utf8')).toMatch(/\nA line\.\n$/);
    const journal = join(root, '.retake', 'journal.jsonl');
    expect(existsSync(journal)).toBe(true);
    const last = JSON.parse((await readFile(journal, 'utf8')).trim().split('\n').at(-1) ?? '{}');
    expect(last).toMatchObject({ op: 'write', what: 'component', path: 'components/acme/badge/README.md', by: { client: 'cli', trust: 'author' }, outcome: 'ok' });
    // A change made since the version read is a conflict, never lost.
    const stale = await w.write(readme, 'other', 'a version read before').catch((e: Error) => e);
    expect((stale as Error).message).toMatch(/changed since it was read/);
    expect(await readFile(readme, 'utf8')).toMatch(/\nA line\.\n$/);
    // A components folder outside the workspace: journaled under its label, never by an absolute path.
    const other = join(root, 'other-ws');
    const outside = join(root, 'shared-components');
    await mkdir(join(outside, 'acme', 'far'), { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'retake.yaml'), `version: 1\nprojects_dir: projects\ncomponents_dir: ${outside}\n`);
    const ws2 = await openWorkspace({ root: other, agent: false });
    expect(ws2.componentsDir).toBe(outside);
    await componentReadmeWriter(ws2, personScope(other, enginePorts())).write(join(outside, 'acme', 'far', 'README.md'), '# Far\n', null);
    const far = JSON.parse((await readFile(join(other, '.retake', 'journal.jsonl'), 'utf8')).trim().split('\n').at(-1) ?? '{}');
    expect(far).toMatchObject({ what: 'component', path: '<components_dir>/acme/far/README.md', if_match: null, outcome: 'ok' });
  });
});
