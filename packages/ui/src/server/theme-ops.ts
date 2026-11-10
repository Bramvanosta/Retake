/**
 * The Studio's theme ops (L4.7, R-UI-07 / R-DEC-04; critique B1, B7, B9–B11, B14, B15). Not MCP tools: MCP never edits a
 * theme (template_list's wording stays true); Claude makes new ones with template_create_from_brand.
 *
 * - `theme_list {project}` (L4.7 part D2): every theme of the workspace — the listed ones and the project's own folder —
 *   editable or read-only with why (by real path), its hex colours, what uses it; the components a theme picks from, by
 *   id and kind; the project's scenarios (Use in this scenario). Path-free.
 * - `theme_view {theme}`: engine templates.view — editable or read-only with why (by real path), template.yaml's text
 *   and sha256 (what undo restores), the allow-listed fields, components per kind, its font and image files checked by
 *   name, palette checks, used by. Path-free; a font's name table under `untrusted`.
 * - `theme_edit {theme, if_match, edit}`: engine templates.edit — one verified write (set_field over the allow-list,
 *   set_background, set_component, restore of a version shown or written), under the `ui` client's agent trust (a
 *   channel, not person presence: BL-106). Writes of one theme run one at a time on the op chain (`theme:<name>`): a
 *   double click finds the new sha256 and gets its 409.
 * - `theme_copy {from, name}`: "Copy to edit" (engine templates.copy); `theme_create`: New theme — L3.5's brand form
 *   through engine templates.create under trust `mcp` exactly as MCP, `replace` never offered (pinned out).
 * - `brand_files {kind}`: the workspace's image / font files a new theme may take (names and sizes).
 * - `site_list {url?}`: the newest site extractions (hex roles, checks, candidates by `site:<id>/logo-<n>`; URL, host and
 *   page text under `untrusted`: a CLI extraction has no signed job, B11). With `url`: the URL checked (public, not an
 *   environment of a project) and the `retake theme from-site` command to copy — no Studio op queues a site job (the
 *   extraction needs a person's approval of the URL, BL-106).
 * - `theme_preview {project, theme, target, draft?, lease}`: the theme editor's live preview — the editor's
 *   ComponentPreviewSpec (motion mode) of the theme's intro, its layout with its caption over the sample screen (`clip`),
 *   its outro, or one component in the theme, built here with every file served by the player origin under the
 *   project's capability (the theme's fonts / logo, the sample screens) and published as a `component-preview` (the
 *   `forbid` scan of every string); `draft` colours apply in memory, never written. A workspace component the spec
 *   renders is held out of the frame's bundle until the person allows it (`preview_held`, the timeline's Allow card:
 *   preview_allow). A theme whose intro / outro is its own video, image or Lottie (B10) is not previewed here — said.
 *   The page's lease is one of the timeline's (timeline_leave ends it).
 */
import { homedir } from 'node:os';
import { z } from 'zod';
import { BrandInputSchema, COMPONENT_ID_RE, COMPONENT_KINDS, HEX_COLOR_RE, PROJECT_SLUG_RE, THEME_EDIT_MAX_CHARS, THEME_FIELD_PATHS, isTemplateMediaRef, zNewThemeName, zThemeName } from '@retake/core';
import type { ComponentKind, LoadedTemplate } from '@retake/core';
import { EngineError, checkSiteUrl, firstErrorLine, memoRegistry, openProjectBySlug, siteCommandLine, siteHostConflicts, themeAssetProblems, themeEditList, themeForWork } from '@retake/engine';
import type { Engine, SiteList, ThemeEditList, ThemeEditResult, ThemeEditView } from '@retake/engine';
import type { ComponentRegistry } from '@retake/components';
import { defineTool } from '@retake/engine/contract';
import { fileFacts } from '@retake/core/io';
import { pathFree } from './comment-ops.js';
import type { OpChain } from './op-chain.js';
import { opChain } from './op-chain.js';
import type { PreviewLeases, PreviewHeld } from './preview-leases.js';
import type { PlayerServer } from './player.js';
import type { PreviewAllowList } from './preview-allow.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const project = z.string().max(100).regex(PROJECT_SLUG_RE, 'a project slug (project_list names them), never a path');
const theme = zThemeName('a theme name (the themes list names them), never a path');
/** A NEW theme's name: at most 60 characters, whatever creates it; a theme that exists under a longer name is named with `theme`. */
const newName = zNewThemeName('a new theme name: lower-case letters, digits and "-", never a path');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 (64 lower-case hex characters)');
const hex = z.string().regex(HEX_COLOR_RE, 'a hex colour: #rgb or #rrggbb');
const componentId = z.string().max(120).regex(COMPONENT_ID_RE, 'a component id "namespace/name", never a path');
const kind = z.enum(COMPONENT_KINDS as unknown as [ComponentKind, ...ComponentKind[]]);
const lease = z.string().regex(/^[A-Za-z0-9_-]{16,43}$/, 'a random lease id of the page (16 to 43 base64url characters)');

/** A theme field's value as the page shows or sends it: a scalar, or the body font files. */
const fieldValue = z.union([z.string().max(400), z.number().finite(), z.array(z.string().max(200)).min(1).max(4)]);
/** A background as written (theme_view `background`), for `from`: a small map of scalars. */
const writtenBackground = z.record(z.string().max(40), z.union([z.string().max(200), z.number().finite()]));
const background = z.union([
  z.strictObject({ type: z.literal('solid'), color: hex }),
  z.strictObject({ type: z.enum(['radial', 'linear']), from: hex, to: hex }),
]);

/** The edits theme_edit takes (core ThemeEdit), each pinned: an allow-listed field, ids by regex, bounded text. */
const ThemeEditSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('set_field'),
    field: z.enum(THEME_FIELD_PATHS),
    from: fieldValue.optional().describe('What the page showed there (absent: not written).'),
    to: fieldValue.optional().describe('The new value (absent: removed — the removable fields only).'),
    ripple: z.boolean().optional().describe('With colors.accent: the cursor ripple follows the accent.'),
  }),
  z.strictObject({
    kind: z.literal('set_background'),
    from: writtenBackground.optional().describe('The background as theme_view showed it (absent: not written).'),
    to: background,
  }),
  z.strictObject({
    kind: z.literal('set_component'),
    component: kind,
    from: componentId.nullable().optional().describe('The id the page showed for that kind (null: none; absent: not written).'),
    id: componentId.nullable().describe('The new component, or null (no captions / a cut: caption and transition only).'),
    params: z.enum(['keep', 'drop']).describe("The old entry's params: kept (checked against the new component) or dropped."),
  }),
  z.strictObject({
    kind: z.literal('restore'),
    text: z.string().max(THEME_EDIT_MAX_CHARS).describe('A version theme_view showed or theme_edit wrote (undo / redo), byte for byte.'),
    text_hash: sha256.describe('Its sha256.'),
  }),
]);

const ListInput = z.strictObject({ project });
const ViewInput = z.strictObject({ theme });
const EditInput = z.strictObject({
  theme,
  if_match: sha256.describe('template.yaml as theme_view showed it (its sha256): refused (409) when it changed since.'),
  edit: ThemeEditSchema,
});
const CopyInput = z.strictObject({ from: theme.describe('The theme to copy (a starter, another workspace theme).'), name: newName.describe('The new theme folder of templates_dir.') });
const CreateInput = BrandInputSchema.omit({ replace: true });
const FilesInput = z.strictObject({ kind: z.enum(['image', 'font']).describe('Image files (logos, wordmarks) or font files.') });
const SitesInput = z.strictObject({ url: z.string().min(1).max(2048).optional().describe('A public page to extract colours and logos from: answered with the command to run (never queued from the Studio).') });

const draftColors = z.strictObject({ accent: hex.optional(), text: hex.optional(), muted: hex.optional(), paper: hex.optional(), dark: hex.optional() });
const PreviewInput = z.strictObject({
  project,
  theme,
  target: z
    .union([z.enum(['intro', 'clip', 'outro']), z.strictObject({ component: componentId })])
    .describe("The theme's intro, its layout with its caption over the sample screen (clip), its outro, or one component in the theme."),
  draft: z
    .strictObject({ colors: draftColors.optional(), background: background.optional() })
    .optional()
    .describe('Colours being changed (in memory only, never written): the page sends at most 5 a second.'),
  // Required (review A N2): a scope no lease holds would lose its URLs when the last timeline page leaves.
  lease: lease.describe("The page's lease (timeline_leave ends it): the project's preview URLs are revoked once no page holds one."),
});

/**
 * What theme_preview answers: the preview's capability URLs, its length, and `frame` (the moment a still of it shows:
 * where to load / settle) — or why it shows nothing (`not_previewed`, `preview_error`).
 */
export type ThemePreviewAnswer = { theme: string; target: { kind: string; component?: string } } & PreviewHeld &
  ({ frame_url: string; plan_url: string; frames: number; fps: number; frame: number } | { not_previewed: string } | { preview_error: string });

/**
 * What theme_list answers: every theme (editable or read-only with why, by real path), the components a theme may pick
 * per kind (ids — checked names — and kinds; a workspace component's own words are not needed to pick it), and the
 * project's scenarios (Use in this scenario).
 */
export type ThemeListAnswer = ThemeEditList & {
  project: string;
  components: Array<{ id: string; kind: ComponentKind; kinds?: ComponentKind[]; source: 'builtin' | 'workspace' }>;
  scenarios: string[];
};

/** What site_list answers. */
export type SiteListAnswer = SiteList & {
  /** With `url`: the command a person runs (the extraction needs their approval of the URL), and the sentence for Claude. */
  command?: { line: string; claude: string; untrusted: { host: string } };
  /** With `url`: why it cannot be extracted (not public, an environment of a project…). */
  url_problem?: string;
};

/** Every string of an answer made path-free (comment-ops pathFree), at most 8 levels deep. */
function pathFreeDeep<T>(v: T, root: string, depth = 0): T {
  if (typeof v === 'string') return pathFree(v, root) as T;
  if (depth >= 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => pathFreeDeep(x, root, depth + 1)) as T;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, pathFreeDeep(x, root, depth + 1)])) as T;
}

const themeKey = (name: string) => `theme:${name.toLowerCase()}`;

export interface ThemeOpsOptions {
  chain?: OpChain;
  /** The player origin (theme_preview). */
  player?: () => PlayerServer;
  /** Folders no string of a preview may name (the workspace, the home folder). */
  forbid?: () => readonly string[];
  /** The workspace components the person allowed in the preview this session. */
  allow?: PreviewAllowList;
  /** The preview pages' leases (shared with timeline_view / timeline_leave). */
  leases?: PreviewLeases;
}

export function themeOps(o: ThemeOpsOptions = {}) {
  const oneAtATime = o.chain ?? opChain();

  const list = defineTool({
    name: 'theme_list',
    title: 'The themes of the workspace',
    description: "Every theme (workspace, starters, the project's own folder): editable or read-only with why, its colours, what uses it; the components a theme may pick per kind; the project's scenarios.",
    input: ListInput,
    annotations: READ,
    async run(a, { engine }) {
      const ws = engine.workspace;
      const [themes, comps, p] = await Promise.all([themeEditList(ws, a.project), engine.components.list(), openProjectBySlug(ws, a.project)]);
      const data: ThemeListAnswer = {
        project: a.project,
        ...pathFreeDeep(themes, ws.root),
        components: comps.components
          .filter((c) => COMPONENT_ID_RE.test(c.id))
          .map((c) => ({ id: c.id, kind: c.kind, ...(c.kinds?.length ? { kinds: [...c.kinds] } : {}), source: c.source })),
        scenarios: [...p.scenarios],
      };
      return {
        summary: `${data.themes.length} themes (${data.themes.filter((t) => t.editable === true).length} editable), ${data.components.length} components`,
        data,
      };
    },
  });

  const view = defineTool({
    name: 'theme_view',
    title: 'A theme in the editor',
    description: "One theme as the editor shows it: editable or read-only with why, template.yaml and its sha256, the editable fields, components per kind, its font and image files, palette checks, and what uses it.",
    input: ViewInput,
    annotations: READ,
    async run(a, { engine }) {
      const v: ThemeEditView = await engine.templates.view(a.theme);
      // template.yaml's text stays byte for byte (undo restores it by its sha256); every other string is path-free.
      const { yaml, ...rest } = v;
      return {
        summary: `theme ${v.name} (${v.source}${v.editable === true ? ', editable' : ', read-only'})${v.issues.length ? `, ${v.issues.length} issues` : ''}`,
        data: { ...pathFreeDeep(rest, engine.workspace.root), yaml },
      };
    },
  });

  const edit = defineTool({
    name: 'theme_edit',
    title: 'Edit a theme from the Studio',
    description: "One verified write of a workspace theme's template.yaml (an allow-listed field, the background, a kind's component, or undo / redo's exact earlier version), on the version the editor showed.",
    input: EditInput,
    annotations: WRITE,
    async run(a, { engine }) {
      const r: ThemeEditResult = await oneAtATime(themeKey(a.theme), () => engine.templates.edit(a.theme, { if_match: a.if_match, edit: a.edit }));
      return {
        summary: `${r.label}: ${r.name} (sha256 ${r.sha256.slice(0, 12)})${r.removed.length ? `, removed ${r.removed.join(', ')}` : ''}${r.warnings.length ? `, ${r.warnings.length} warnings` : ''}`,
        data: pathFreeDeep(r, engine.workspace.root),
      };
    },
  });

  const copy = defineTool({
    name: 'theme_copy',
    title: 'Copy a theme to edit it',
    description: 'A new workspace theme copied from a listed one (a starter, another theme): its files verbatim, only its name changed.',
    input: CopyInput,
    annotations: WRITE,
    async run(a, { engine }) {
      const r = await oneAtATime(themeKey(a.name), () => engine.templates.copy({ from: a.from, name: a.name }));
      return { summary: `theme ${r.name} copied from ${r.from} (${r.files.length} files)`, data: pathFreeDeep(r, engine.workspace.root) };
    },
  });

  const create = defineTool({
    name: 'theme_create',
    title: 'New theme from brand files',
    description: "A NEW workspace theme from the brand's colours, logo and fonts (workspace files or a site candidate), over a base theme — as template_create_from_brand makes it, never replacing one.",
    input: CreateInput,
    annotations: WRITE,
    async run(a, { engine }) {
      const c = await oneAtATime(themeKey(a.name), () => engine.templates.create(a));
      // Path-free: the folder is the theme's name; files are relative to it.
      const { dir: _dir, ...rest } = c;
      return {
        summary: `theme ${c.name} created over ${c.base} (${c.files.length} files)${c.warnings.length ? `, ${c.warnings.length} warnings` : ''}`,
        data: pathFreeDeep(rest, engine.workspace.root),
      };
    },
  });

  const files = defineTool({
    name: 'brand_files',
    title: 'Brand files of the workspace',
    description: "The workspace's image or font files a new theme may take (names relative to the workspace and sizes; hidden, agent-writable and components folders left out).",
    input: FilesInput,
    annotations: READ,
    async run(a, { engine }) {
      const r = await engine.templates.files(a.kind);
      return { summary: `${r.files.length} ${a.kind} files${r.truncated ? ' (not all listed)' : ''}`, data: r };
    },
  });

  const sites = defineTool({
    name: 'site_list',
    title: 'Site extractions',
    description: "The newest site extractions (colour roles with contrast, logo candidates; the page's URL, host and text as untrusted data) — and, for a URL, the command that extracts it (never queued from the Studio).",
    input: SitesInput,
    annotations: READ,
    async run(a, { engine }) {
      const out: SiteListAnswer = pathFreeDeep({ ...(await engine.templates.sites()) }, engine.workspace.root);
      if (a.url !== undefined) {
        try {
          const u = checkSiteUrl(a.url);
          const conflicts = await siteHostConflicts(engine.workspace, u.host);
          if (conflicts.length) out.url_problem = pathFree(`${u.host} is ${conflicts.join('; ')}: an environment of a project is filmed through runs, never extracted as a site`, engine.workspace.root);
          else {
            out.command = {
              line: siteCommandLine(engine.cli, u.href),
              claude: 'Or ask Claude: template_from_site asks you to approve the URL in Claude Code.',
              untrusted: { host: u.host },
            };
          }
        } catch (e) {
          out.url_problem = pathFree(firstErrorLine(e instanceof Error ? e.message : String(e)), engine.workspace.root);
        }
      }
      // The command keeps the workspace (`retake -C <root>`): the person copies it into a terminal, like an error's `fix`.
      return {
        summary: `${out.sites.length} site extractions${out.command ? '; command ready' : out.url_problem ? `; ${out.url_problem}` : ''}`,
        data: out,
      };
    },
  });

  const preview = defineTool({
    name: 'theme_preview',
    title: "A theme's live preview",
    description: "The theme editor's live preview of the theme's intro, its layout with its caption (clip), its outro or one component in the theme — with colours being changed applied in memory — as the preview frame's capability URLs.",
    input: PreviewInput,
    annotations: READ,
    async run(a, { engine }) {
      if (!o.player) throw new EngineError('unavailable', 'this server has no preview origin');
      const r = await themePreview(engine, a, o);
      const head = `${a.theme}: ${'component' in r.target && r.target.component ? r.target.component : r.target.kind}`;
      const summary = 'frame_url' in r ? `${head}, ${r.frames} frames` : 'not_previewed' in r ? `${head}: not previewed (${r.not_previewed})` : `${head}: no preview`;
      return { summary, data: r };
    },
  });

  return [list, view, edit, copy, create, files, sites, preview] as const;
}

/** The workspace components among `ids` that the person has not allowed in the preview (empty without an allow-list). */
async function heldOf(registry: ComponentRegistry, ids: readonly string[], allow: PreviewAllowList | undefined): Promise<NonNullable<PreviewHeld['preview_held']>> {
  if (!allow) return [];
  const used = new Set(ids);
  const { workspaceComponents } = await import('../player/bundle-player.js');
  return (await workspaceComponents(registry)).filter((c) => used.has(c.id) && !allow.has(c.id, c.hash));
}

let samplesMemo: Promise<import('@retake/editor').PreviewSamples> | undefined;

/** The theme with the draft's colours (memory only). */
function withDraft(t: LoadedTemplate, draft: z.infer<typeof PreviewInput>['draft']): LoadedTemplate {
  if (!draft) return t;
  const tpl = t.template;
  return {
    ...t,
    template: {
      ...tpl,
      colors: { ...tpl.colors, ...Object.fromEntries(Object.entries(draft.colors ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, (v as string).toLowerCase()])) },
      ...(draft.background ? { background: { ...draft.background } } : {}),
    },
  } as LoadedTemplate;
}

/** theme_preview (see the header). */
export async function themePreview(engine: Engine, a: z.infer<typeof PreviewInput>, o: ThemeOpsOptions): Promise<ThemePreviewAnswer> {
  const ws = engine.workspace;
  const p = await openProjectBySlug(ws, a.project);
  const loaded = await themeForWork(p, a.theme, fileFacts(ws.policy));
  const problems = themeAssetProblems(loaded);
  if (problems.length) throw new EngineError('refused', `${problems.map((x) => pathFree(x, ws.root)).join('; ')}: a theme serves only its own files`);
  const registry = (await memoRegistry(ws)).registry;
  const tpl = withDraft(loaded, a.draft);
  const targetKind = typeof a.target === 'string' ? a.target : 'component';
  const base = { theme: loaded.name, target: { kind: targetKind, ...(typeof a.target === 'object' ? { component: a.target.component } : {}) } };
  // The component shown and its params: the theme's pick for the kind (with its params), or the one asked.
  let id: string;
  let params: Record<string, unknown> | undefined;
  let resolved;
  try {
    resolved = registry.resolveTheme(tpl.template);
  } catch (e) {
    return { ...base, preview_error: firstErrorLine(pathFree(e instanceof Error ? e.message : String(e), ws.root)) };
  }
  if (typeof a.target === 'string') {
    const k: ComponentKind = a.target === 'clip' ? 'layout' : a.target;
    // B10: the theme's own video / image / Lottie: its file is not previewed here (the sample would stand for it).
    if (isTemplateMediaRef(tpl.template.components?.[k] as Parameters<typeof isTemplateMediaRef>[0])) {
      return { ...base, not_previewed: `the theme's ${k} is its own video, image or Lottie file: not previewed here (a render shows it)` };
    }
    const rc = resolved[k];
    if (!rc) return { ...base, not_previewed: `the theme has no ${k}` };
    id = rc.id;
    params = rc.params;
    base.target.component = id;
  } else {
    if (!registry.has(a.target.component)) throw new EngineError('not_found', `component ${a.target.component} is not in the registry (library_view lists them)`);
    id = a.target.component;
    const info = registry.get(id);
    const own = resolved[info.manifest.kind];
    if (own && own.id === id) params = own.params;
  }
  const info = registry.get(id);
  const scope = a.project;
  const player = o.player!();
  o.leases?.prune();
  o.leases?.hold(scope, a.lease);
  const [ed, comps] = [await import('@retake/editor'), await import('@retake/components')];
  samplesMemo ??= Promise.resolve().then(() => ed.loadPreviewSamples());
  samplesMemo.catch(() => (samplesMemo = undefined));
  const samples = await samplesMemo;
  // Every file the spec names is served by the player origin under the project's capability, from its own folder only.
  const serve = (within: string) => (file: string): string => {
    const url = player.register(file, [within], scope);
    if (url === undefined) throw new ed.PreviewPlanError(`a file of ${within === loaded.dir ? `theme ${loaded.name}` : 'the preview samples'} cannot be served (a link, or not a plain file)`);
    return url;
  };
  const themeUrl = serve(loaded.dir);
  let built;
  try {
    const tokens = comps.themeTokens(tpl, {
      logo: themeUrl(tpl.assets.logo),
      ...(tpl.assets.wordmark ? { wordmark: themeUrl(tpl.assets.wordmark) } : {}),
      fonts: { display: themeUrl(tpl.assets.display), body: tpl.assets.body.map(themeUrl) },
    });
    built = ed.buildComponentPreview({
      target: { id, manifest: info.manifest },
      template: tpl,
      tokens,
      registry,
      samples,
      sampleUrl: serve(comps.PREVIEW_SAMPLES_DIR),
      ...(params && Object.keys(params).length ? { params } : {}),
      motion: true,
    });
  } catch (e) {
    return { ...base, preview_error: firstErrorLine(pathFree(e instanceof Error ? e.message : String(e), ws.root)) };
  }
  const held = await heldOf(registry, built.components, o.allow);
  const heldPart: PreviewHeld = held.length ? { preview_held: held } : {};
  try {
    const forbid = [...(o.forbid?.() ?? [ws.root, homedir()]), loaded.dir, comps.PREVIEW_SAMPLES_DIR, p.dir];
    const pub = await player.publishPreview(built.spec, { forbid, scope });
    return { ...base, ...heldPart, frame_url: pub.frame_url, plan_url: pub.plan_url, frames: built.spec.durationInFrames, fps: built.spec.fps, frame: built.spec.frame };
  } catch (e) {
    return { ...base, ...heldPart, preview_error: firstErrorLine(pathFree(e instanceof Error ? e.message : String(e), ws.root)) };
  }
}

/** The theme ops' names. */
export const THEME_OPS = ['theme_list', 'theme_view', 'theme_edit', 'theme_copy', 'theme_create', 'brand_files', 'site_list', 'theme_preview'] as const;
