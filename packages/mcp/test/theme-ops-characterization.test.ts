/**
 * The theme, component and library operations (MCP: template_list, template_create_from_brand, template_preview,
 * template_from_site, component_list, component_get, component_validate, component_preview, component_create; the
 * Studio: theme_list, theme_view, theme_edit, theme_copy, theme_create, brand_files, site_list, library_view,
 * library_images, library_render, library_component), characterized through their shells before they became the
 * engine's operations (L7.17): each call's answer through `retake mcp` over stdio (from the sources, the SDK's client)
 * and through the Studio's `POST /v1/call/<op>` (no worker), each shell on its own copy of a fixture workspace (the
 * fixture project, its own templates/, brand files copied from the starters and the built-in library, a workspace
 * card), normalised — the workspace, repository and home paths, ISO stamps, job ids, library keys and sha256s by order
 * of appearance, base64 images, pids, the host name, the repository's address, Node's and Retake's versions — and held
 * against fixtures/theme-ops.json, which was recorded on the commit before the move (RETAKE_WRITE_SNAPSHOTS=1 on this file
 * records it again: review the diff). The refusals are in it: the brand files' (a starter's name, an agent-writable
 * file, a script or linked SVG, a hidden folder, components/, a path out, a missing file), theme_edit's (if_match,
 * a starter, a version never shown) and the theme-edit caller rule, called through `invoke` (shell `studio`) with an
 * engine of the MCP client: parse first, then the caller rule, then the theme's load.
 *
 * Not here: a preview that renders (template_preview / component_preview submit to a worker that draws with a browser:
 * stdio-theme.test.ts and stdio-preview.test.ts), an approved site extraction (stdio-site.test.ts), theme_preview (stays
 * the Studio's: theme-ops.test.ts and player-preview.test.ts).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, cp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RETAKE_REPOSITORY, RETAKE_VERSION } from '@retake/core';
import { STARTER_TEMPLATES_DIR } from '@retake/core/io';
import { LIBRARY_DIR, scaffoldDir } from '@retake/components';
import { createEngine } from '@retake/engine';
import { invoke } from '@retake/engine/contract';
import { REPO, fixtureWorkspace } from '../../engine/test/helpers.js';
import { testChildEnv } from '../../core/test/child-env.js';
import { startStudioServer } from '../../ui/src/index.js';
import type { StudioServer } from '../../ui/src/index.js';
import { raw } from '../../ui/test/http.js';
import { stubTools } from '../../ui/test/studio-tools.js';

const FILE = fileURLToPath(new URL('./fixtures/theme-ops.json', import.meta.url));
const BIN = join(REPO, 'packages', 'cli', 'src', 'bin.ts');
const P = 'northfield-fixture';
const ACCENT = { accent: '#2255aa' };

interface State {
  sha?: string;
  accent?: string;
  key?: string;
  loop?: string;
}
interface Call {
  op: string;
  args: Record<string, unknown> | ((s: State) => Record<string, unknown>);
}

/** The MCP calls, in order. */
const MCP_CALLS: Call[] = [
  { op: 'template_list', args: {} },
  { op: 'template_list', args: { project: P } },
  { op: 'template_list', args: { template: 'editorial' } },
  { op: 'template_list', args: { template: 'editorial', project: P } },
  { op: 'template_list', args: { template: 'no-such' } },
  { op: 'template_list', args: { template: '../x' } },
  { op: 'template_list', args: { project: 'no-such-project' } },
  {
    op: 'template_create_from_brand',
    args: {
      name: 'brand-one',
      colors: ACCENT,
      logo: 'brand/mark.svg',
      fonts: { display: 'brand/Headline.ttf', body: ['brand/Text-Regular.ttf', 'brand/Text-Bold.ttf'] },
      brand: { name: 'Northfield', url: 'northfield.example' },
    },
  },
  { op: 'template_list', args: { template: 'brand-one' } },
  { op: 'template_create_from_brand', args: { name: 'brand-one', colors: { accent: '#aa3311' }, logo: 'brand/logo.png', replace: true } },
  { op: 'template_create_from_brand', args: { name: 'brand-one', colors: ACCENT, logo: 'brand/logo.png' } },
  { op: 'template_create_from_brand', args: { name: 'editorial', colors: ACCENT, logo: 'brand/logo.png' } },
  { op: 'template_create_from_brand', args: { name: 'brand-two', colors: ACCENT, logo: `projects/${P}/scenarios/logo.svg` } },
  { op: 'template_create_from_brand', args: { name: 'brand-two', colors: ACCENT, logo: 'brand/evil.svg' } },
  { op: 'template_create_from_brand', args: { name: 'brand-two', colors: ACCENT, logo: 'brand/script.svg' } },
  { op: 'template_create_from_brand', args: { name: 'brand-two', colors: ACCENT, logo: '.retake/logo.png' } },
  { op: 'template_create_from_brand', args: { name: 'brand-two', colors: ACCENT, logo: 'components/logo.png' } },
  { op: 'template_create_from_brand', args: { name: 'brand-two', colors: ACCENT, logo: '../outside.png' } },
  { op: 'template_create_from_brand', args: { name: 'brand-two', colors: ACCENT, logo: 'brand/none.png' } },
  { op: 'template_create_from_brand', args: { name: 'brand-two', colors: ACCENT, logo: 'brand/logo.png', fonts: { display: 'brand/logo.png' } } },
  { op: 'template_create_from_brand', args: { name: 'brand-two', colors: { accent: 'blue' }, logo: 'brand/logo.png' } },
  { op: 'template_create_from_brand', args: { name: 'Brand Two', colors: ACCENT, logo: 'brand/logo.png' } },
  { op: 'template_preview', args: { project: 'no-such-project' } },
  { op: 'template_preview', args: { project: P, template: 'no-such' } },
  { op: 'template_preview', args: { project: P, template: '../x' } },
  { op: 'template_preview', args: { project: P, wait_s: 9999 } },
  { op: 'template_from_site', args: { url: 'https://example.com/' } },
  { op: 'template_from_site', args: { url: 'https://www.brand.example/' } },
  { op: 'template_from_site', args: { url: 'http://www.brand.example/' } },
  { op: 'template_from_site', args: { url: 'https://www.brand.example/?q=1' } },
  { op: 'template_from_site', args: { url: '' } },
  { op: 'component_list', args: {} },
  { op: 'component_list', args: { kind: 'card' } },
  { op: 'component_list', args: { kind: 'poster' } },
  { op: 'component_get', args: { component: 'studio/card-title' } },
  { op: 'component_get', args: { component: 'acme/held' } },
  { op: 'component_get', args: { component: 'acme/none' } },
  { op: 'component_get', args: { component: '../x' } },
  { op: 'component_validate', args: { component: 'studio/card-title' } },
  { op: 'component_validate', args: { component: 'acme/held' } },
  { op: 'component_validate', args: { component: 'acme/broken' } },
  { op: 'component_validate', args: { component: 'acme/none' } },
  { op: 'component_preview', args: { project: P, component: 'acme/none' } },
  { op: 'component_preview', args: { project: 'no-such-project', component: 'studio/card-title' } },
  { op: 'component_preview', args: { project: P, component: 'studio/card-title', template: 'no-such' } },
  { op: 'component_preview', args: { project: P, component: 'studio/card-title', slots: { 'bad name': 'x' } } },
  { op: 'component_preview', args: { project: P, component: 'studio/card-title', params: { big: 'x'.repeat(9000) } } },
  { op: 'component_create', args: { id: 'acme/new-card', kind: 'card', description: 'A plain card for tests.' } },
  { op: 'component_create', args: { id: 'acme/new-card', kind: 'card', description: 'Again.' } },
  { op: 'component_create', args: { id: 'studio/mine', kind: 'card', description: 'In the built-in namespace.' } },
  { op: 'component_create', args: { id: 'acme/intro', kind: 'poster', description: 'No such kind.' } },
  { op: 'component_create', args: { id: 'acme/named', kind: 'intro', description: 'With a name.', name: 'Named intro' } },
  { op: 'component_validate', args: { component: 'acme/new-card' } },
  { op: 'component_list', args: { kind: 'intro' } },
];

/** The Studio calls, in order. */
const STUDIO_CALLS: Call[] = [
  { op: 'theme_list', args: { project: P } },
  { op: 'theme_list', args: { project: 'no-such-project' } },
  { op: 'theme_view', args: { theme: 'editorial' } },
  { op: 'theme_view', args: { theme: 'no-such' } },
  { op: 'theme_view', args: { theme: '../x' } },
  { op: 'theme_copy', args: { from: 'editorial', name: 'mine' } },
  { op: 'theme_copy', args: { from: 'editorial', name: 'mine' } },
  { op: 'theme_copy', args: { from: 'no-such', name: 'other' } },
  { op: 'theme_copy', args: { from: 'editorial', name: 'Mine' } },
  { op: 'theme_view', args: { theme: 'mine' } },
  { op: 'theme_edit', args: (s) => ({ theme: 'mine', if_match: s.sha, edit: { kind: 'set_field', field: 'colors.accent', to: '#224466' } }) },
  { op: 'theme_edit', args: (s) => ({ theme: 'mine', if_match: s.sha, edit: { kind: 'set_field', field: 'style_bias', to: 'motion' } }) },
  { op: 'theme_edit', args: (s) => ({ theme: 'editorial', if_match: s.sha, edit: { kind: 'set_field', field: 'colors.accent', to: '#224466' } }) },
  { op: 'theme_edit', args: (s) => ({ theme: 'no-such', if_match: s.sha, edit: { kind: 'set_field', field: 'colors.accent', to: '#224466' } }) },
  { op: 'theme_edit', args: (s) => ({ theme: 'mine', if_match: s.sha, edit: { kind: 'set_field', field: 'captions.kicker.color', to: '#000000' } }) },
  { op: 'theme_edit', args: (s) => ({ theme: 'mine', if_match: s.sha, edit: { kind: 'restore', text: 'made: up\n', text_hash: 'ab'.repeat(32) } }) },
  { op: 'theme_edit', args: (s) => ({ theme: 'mine', if_match: s.sha, edit: { kind: 'restore', text: 'made: up\n', text_hash: createHash('sha256').update('made: up\n').digest('hex') } }) },
  { op: 'theme_edit', args: (s) => ({ theme: 'mine', if_match: s.sha, edit: { kind: 'set_field', field: 'colors.accent', from: s.accent, to: '#224466' } }) },
  { op: 'theme_edit', args: (s) => ({ theme: 'mine', if_match: 'cd'.repeat(32), edit: { kind: 'set_field', field: 'colors.accent', from: '#224466', to: '#224477' } }) },
  { op: 'theme_view', args: { theme: 'mine' } },
  { op: 'theme_edit', args: (s) => ({ theme: 'mine', if_match: s.sha, edit: { kind: 'set_component', component: 'card', from: 'studio/card-title', id: 'acme/held', params: 'drop' } }) },
  { op: 'theme_create', args: { name: 'brand-two', colors: ACCENT, logo: 'brand/logo.png' } },
  { op: 'theme_create', args: { name: 'brand-two', colors: ACCENT, logo: 'brand/logo.png' } },
  { op: 'theme_create', args: { name: 'brand-three', colors: ACCENT, logo: 'brand/logo.png', replace: true } },
  { op: 'theme_create', args: { name: 'editorial', colors: ACCENT, logo: 'brand/logo.png' } },
  { op: 'theme_create', args: { name: 'brand-three', colors: ACCENT, logo: `projects/${P}/scenarios/logo.svg` } },
  { op: 'theme_create', args: { name: 'brand-three', colors: ACCENT, logo: 'brand/evil.svg' } },
  { op: 'theme_create', args: { name: 'brand-three', colors: ACCENT, logo: 'brand/script.svg' } },
  { op: 'theme_create', args: { name: 'brand-three', colors: ACCENT, logo: '.retake/logo.png' } },
  { op: 'theme_create', args: { name: 'brand-three', colors: ACCENT, logo: 'components/logo.png' } },
  { op: 'theme_create', args: { name: 'brand-three', colors: ACCENT, logo: '../outside.png' } },
  { op: 'theme_create', args: { name: 'brand-three', colors: ACCENT, logo: 'brand/none.png' } },
  { op: 'brand_files', args: { kind: 'image' } },
  { op: 'brand_files', args: { kind: 'font' } },
  { op: 'brand_files', args: { kind: 'video' } },
  { op: 'site_list', args: {} },
  { op: 'site_list', args: { url: 'https://example.com/pricing' } },
  { op: 'site_list', args: { url: 'https://www.brand.example/' } },
  { op: 'site_list', args: { url: 'http://127.0.0.1:4401/' } },
  { op: 'site_list', args: { url: 'not a url' } },
  { op: 'theme_list', args: { project: P } },
  { op: 'library_view', args: { project: P } },
  { op: 'library_view', args: { project: P, theme: 'mine' } },
  { op: 'library_view', args: { project: P, theme: 'no-such' } },
  { op: 'library_view', args: { project: 'no-such-project' } },
  { op: 'library_images', args: (s) => ({ project: P, keys: [s.key], committed: ['studio/card-title', 'acme/held', 'acme/none'] }) },
  { op: 'library_images', args: { project: P, keys: ['nope'] } },
  { op: 'library_render', args: (s) => ({ project: P, items: [{ component: 'studio/card-title', poster: s.key, loop: s.loop }] }) },
  { op: 'library_render', args: (s) => ({ project: P, items: [{ component: 'studio/card-title', poster: s.key }] }) },
  {
    op: 'library_render',
    args: (s) => ({
      project: P,
      items: [
        { component: 'studio/card-title', poster: s.key },
        { component: 'studio/card-title', loop: s.loop },
      ],
    }),
  },
  { op: 'library_render', args: { project: P, items: [{ component: 'acme/held' }] } },
  { op: 'library_render', args: { project: P, items: [] } },
  { op: 'library_view', args: { project: P } },
  { op: 'library_component', args: { project: P, component: 'studio/card-title' } },
  { op: 'library_component', args: { project: P, component: 'acme/held' } },
  { op: 'library_component', args: { project: P, component: 'acme/none' } },
  { op: 'library_component', args: { project: 'no-such-project', component: 'studio/card-title' } },
];

/** A workspace of the fixture project with its own templates/, brand files and two workspace components. */
async function workspace(name: string): Promise<{ ws: string; home: string }> {
  const ws = await mkdtemp(join(tmpdir(), `retake-theme-ops-${name}-`));
  const home = join(ws, '.home');
  await fixtureWorkspace(ws);
  await writeFile(join(ws, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  await mkdir(join(ws, 'templates'));
  const brand = join(ws, 'brand');
  await mkdir(brand);
  const T = STARTER_TEMPLATES_DIR;
  await cp(join(T, 'default', 'logo.svg'), join(brand, 'mark.svg'));
  await cp(join(LIBRARY_DIR, 'studio', 'card-title', 'preview.png'), join(brand, 'logo.png'));
  await cp(join(T, 'motion', 'fonts', 'SpaceGrotesk-Bold.ttf'), join(brand, 'Headline.ttf'));
  for (const w of ['Regular', 'Bold']) await cp(join(T, 'default', 'fonts', `Inter-${w}.ttf`), join(brand, `Text-${w}.ttf`));
  await writeFile(join(brand, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="https://tracker.test/p.png"/></svg>');
  await writeFile(join(brand, 'script.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>');
  await cp(join(T, 'default', 'logo.svg'), join(ws, 'projects', P, 'scenarios', 'logo.svg'));
  await mkdir(join(ws, '.retake'), { recursive: true });
  await cp(join(brand, 'logo.png'), join(ws, '.retake', 'logo.png'));
  await mkdir(join(ws, 'components'), { recursive: true });
  await cp(join(brand, 'logo.png'), join(ws, 'components', 'logo.png'));
  // A workspace card (held, valid) and a card that does not compile.
  for (const [id, broken] of [
    ['held', false],
    ['broken', true],
  ] as const) {
    const comp = join(ws, 'components', 'acme', id);
    await mkdir(comp, { recursive: true });
    await cp(scaffoldDir('card'), comp, { recursive: true });
    await writeFile(join(comp, 'component.yaml'), (await readFile(join(comp, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, `id: acme/${id}`));
    if (broken) await writeFile(join(comp, 'index.tsx'), 'export default function Card( {\n');
  }
  return { ws, home };
}

/** The answer with what changes between runs replaced (see the header). */
function normalise(v: unknown, o: { paths: Array<[string, string]>; ids: Map<string, string> }): unknown {
  const { ids } = o;
  const byOrder = (kind: string) => (id: string) => {
    const k = `${kind}:${id}`;
    if (!ids.has(k)) ids.set(k, `<${kind}-${[...ids.keys()].filter((x) => x.startsWith(`${kind}:`)).length + 1}>`);
    return ids.get(k)!;
  };
  const text = (s: string): string => {
    let t = s;
    for (const [from, to] of o.paths) t = t.split(from).join(to);
    // The machine's name as a whole word only (a word that merely contains it is kept).
    t = t.replace(new RegExp(`(?<![\\w.-])${hostname().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g'), '<host>');
    t = t.split(RETAKE_REPOSITORY).join('<repository>');
    t = t.split(`/blob/v${RETAKE_VERSION}/`).join('/blob/v<version>/').split(RETAKE_VERSION).join('<version>');
    t = t.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<at>');
    t = t.replace(/\bj_[0-9A-HJKMNP-TV-Z]{26}\b/g, byOrder('job'));
    t = t.replace(/\b[0-9a-f]{64}\b/g, byOrder('sha'));
    t = t.replace(/\b[0-9a-f]{32}\b/g, byOrder('key'));
    return t.replace(/\bpid \d+\b/g, 'pid <pid>');
  };
  const walk = (x: unknown, key?: string): unknown => {
    // The machine's name and Node's version: this machine's (tested before any other string; a site's host is kept).
    if (typeof x === 'string' && ((key === 'host' && x === hostname()) || (key === 'node' && x === process.versions.node))) return `<${key}>`;
    // An image's base64 (library_images, inline previews): its format only.
    if (typeof x === 'string' && key === 'data' && x.length > 64) return `<base64 ${x.startsWith('iVBORw0KGgo') ? 'png' : x.startsWith('R0lGOD') ? 'gif' : 'other'}>`;
    if (typeof x === 'string') return text(x);
    if (typeof x === 'number' && (key === 'pid' || key === 'ppid')) return '<pid>';
    if (Array.isArray(x)) return x.map((y) => walk(y));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, y]) => [text(k), walk(y, k)]));
    return x;
  };
  return walk(v);
}

/** The paths of a workspace, longest first (its real path too: macOS /var → /private/var), with their placeholders. */
async function pathsOf(ws: string, home: string): Promise<Array<[string, string]>> {
  const pairs: Array<[string, string]> = [
    [home, '<home>'],
    [await realpath(home).catch(() => home), '<home>'],
    [ws, '<ws>'],
    [await realpath(ws), '<ws>'],
    [REPO.replace(/\/$/, ''), '<repo>'],
    [process.cwd(), '<cwd>'],
  ];
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

type Answers = Array<{ op: string; args: unknown; answer: unknown }>;

let mcpAnswers: Answers = [];
let studioAnswers: Answers = [];
let callerAnswers: Answers = [];
const cleanup: Array<() => Promise<void>> = [];

async function viaMcp(): Promise<Answers> {
  const { ws, home } = await workspace('mcp');
  cleanup.push(() => rm(ws, { recursive: true, force: true }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--conditions=source', '--import', 'tsx', BIN, '--root', ws, 'mcp'],
    cwd: REPO,
    env: testChildEnv({ RETAKE_HOME: home, RETAKE_WORKER_IDLE_MS: '1500', RETAKE_DISK_WARN: 'off' }),
    stderr: 'pipe',
  });
  // No elicitation: template_from_site answers with the command a person runs (no job is queued).
  const client = new Client({ name: 'retake-test', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  cleanup.unshift(() => client.close());
  const out: Answers = [];
  const n = { paths: await pathsOf(ws, home), ids: new Map<string, string>() };
  for (const c of MCP_CALLS) {
    const args = typeof c.args === 'function' ? c.args({}) : c.args;
    const r = (await client.callTool({ name: c.op, arguments: args }, undefined, { timeout: 120_000 })) as {
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    out.push({ op: c.op, args: normalise(args, n), answer: normalise({ isError: r.isError ?? false, text: r.content[0]?.text, blocks: r.content.map((b) => b.type), data: r.structuredContent }, n) });
  }
  return out;
}

async function viaStudio(): Promise<{ studio: Answers; callers: Answers }> {
  const { ws, home } = await workspace('studio');
  cleanup.push(() => rm(ws, { recursive: true, force: true }));
  const saved = process.env.RETAKE_HOME;
  process.env.RETAKE_HOME = home;
  cleanup.push(async () => {
    if (saved === undefined) delete process.env.RETAKE_HOME;
    else process.env.RETAKE_HOME = saved;
  });
  const studio: StudioServer = await startStudioServer({ root: ws, startWorker: false });
  cleanup.unshift(() => studio.close());
  const state: State = {};
  const out: Answers = [];
  const n = { paths: await pathsOf(ws, home), ids: new Map<string, string>() };
  for (const c of STUDIO_CALLS) {
    const args = typeof c.args === 'function' ? c.args(state) : c.args;
    const r = await raw(studio.port, 'POST', `/v1/call/${c.op}`, { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, JSON.stringify(args));
    const body = r.json<{ ok: boolean; data?: Record<string, unknown> }>();
    if ((c.op === 'theme_view' || c.op === 'theme_edit') && body.ok && typeof body.data?.sha256 === 'string' && (args as { theme?: string }).theme === 'mine') state.sha = body.data.sha256;
    if (c.op === 'theme_view' && body.ok && (args as { theme?: string }).theme === 'mine') state.accent = (body.data?.fields as Record<string, string>)['colors.accent'];
    if (c.op === 'library_view' && body.ok && state.key === undefined) {
      const items = body.data?.items as Array<{ component: string; poster: { key: string }; loop: { key: string } }>;
      const card = items.find((i) => i.component === 'studio/card-title')!;
      state.key = card.poster.key;
      state.loop = card.loop.key;
    }
    out.push({ op: c.op, args: normalise(args, n), answer: normalise({ status: r.status, body }, n) });
  }
  // The theme-edit caller rule: theme_edit as the Studio serves it, called by an engine of the MCP client.
  const mcpEngine = await createEngine({ root: ws, client: 'mcp', autoStartWorker: false });
  const uiEngine = await createEngine({ root: ws, client: 'ui', autoStartWorker: false });
  const edit = stubTools().get('theme_edit')!;
  const valid = (theme: string) => ({ theme, if_match: state.sha, edit: { kind: 'set_field', field: 'colors.accent', to: '#335577' } });
  const callers: Answers = [];
  const cases: Array<[string, typeof mcpEngine, unknown]> = [
    ['mcp, invalid arguments', mcpEngine, { theme: 'no-such', if_match: 'nope', edit: { kind: 'set_field', field: 'colors.accent', to: '#335577' } }],
    ['mcp, a theme that does not exist', mcpEngine, valid('no-such')],
    ['mcp, a starter', mcpEngine, valid('editorial')],
    ['mcp, the workspace theme', mcpEngine, valid('mine')],
    ['ui, a theme that does not exist', uiEngine, valid('no-such')],
  ];
  for (const [label, engine, args] of cases) {
    const r = await invoke(edit, engine, args, { shell: 'studio', signal: new AbortController().signal });
    const answer = r.ok ? { ok: true, summary: r.output.summary } : { ok: false, code: r.error.code, message: r.error.message, ...(r.error.details ? { details: r.error.details } : {}) };
    callers.push({ op: `theme_edit (${label})`, args: normalise(args, n), answer: normalise(answer, n) });
  }
  // Nothing was written by the MCP client's calls.
  expect(await readFile(join(ws, 'templates', 'mine', 'template.yaml'), 'utf8')).not.toContain('#335577');
  return { studio: out, callers };
}

beforeAll(async () => {
  mcpAnswers = await viaMcp();
  const s = await viaStudio();
  studioAnswers = s.studio;
  callerAnswers = s.callers;
}, 300_000);

afterAll(async () => {
  for (const f of cleanup) await f().catch(() => undefined);
});

describe('the theme, component and library operations through their shells (characterization)', () => {
  it('answer as fixtures/theme-ops.json says, through MCP stdio, the Studio and invoke', () => {
    const text = `${JSON.stringify({ mcp: mcpAnswers, studio: studioAnswers, callers: callerAnswers }, null, 1)}\n`;
    if (process.env.RETAKE_WRITE_SNAPSHOTS === '1') writeFileSync(FILE, text);
    expect(text).toBe(readFileSync(FILE, 'utf8'));
    const mcp = [
      'template_list',
      'template_create_from_brand',
      'template_preview',
      'template_from_site',
      'component_list',
      'component_get',
      'component_validate',
      'component_preview',
      'component_create',
    ];
    const studio = ['theme_list', 'theme_view', 'theme_edit', 'theme_copy', 'theme_create', 'brand_files', 'site_list', 'library_view', 'library_images', 'library_render', 'library_component'];
    expect([...new Set(mcpAnswers.map((a) => a.op))].sort()).toEqual([...mcp].sort());
    expect([...new Set(studioAnswers.map((a) => a.op))].sort()).toEqual([...studio].sort());
  });
});
