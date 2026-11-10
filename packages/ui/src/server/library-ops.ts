/**
 * The Studio's component library ops (L4.7, R-UI-06 / R-UI-06b; critique B3, B5, B6, B8, B15, B16, B18, C1). Not MCP
 * tools: Claude has component_list, component_get and component_preview.
 *
 * - `library_view {project, theme?}`: every usable component (workspace first) with its kind, kinds, version, source,
 *   slot names, the themes listed for the project that pick it (and the kinds the selected theme picks it as), and for
 *   the selected theme (default: the project's) its poster and loop — each with the key the worker writes under (engine
 *   `components.library`: the ONE key builder the worker uses too, B3), the cache state (`committed`, `cached`,
 *   `too_large`, `failed`, `missing`) and `queued` while a library job of that key is queued or running; the registry's
 *   notices (worded without a path, with the `retake components validate <id>` command); the themes for the switcher.
 *   A workspace component's name, description and a failure's reason are agent-writable text: under `untrusted` (B16).
 *   Memoised (B5) on file-level stat walks — every file of the component folders (workspace and built-in), the theme
 *   folder, project.yaml, every theme of templates_dir (what picks each component) and the cache folder — so a component rewritten in place by Claude is a new key
 *   at once, while a re-read after an unrelated event computes nothing.
 * - `library_images {project, keys, committed?}`: cached posters (PNG) and loops (GIF) by key (engine readLibraryImage:
 *   a complete entry, plain files, magic-checked; it touches the entry for the cache's LRU) and committed posters of
 *   built-in components by id (their preview.png: a built-in only — a workspace component of that id never shows the
 *   built-in's picture, B15) — as base64, checked again here (magic) and capped (B6: POSTER_DATA_MAX, LOOP_DATA_MAX
 *   characters, the answer LIBRARY_IMAGES_ANSWER_MAX), at most LIBRARY_JOB_MAX of each per call. Never a path or a URL.
 * - `library_render {project, theme?, items, retry?}`: queue posters / loops of at most LIBRARY_JOB_MAX components (B8:
 *   the page sends the next chunk when one finishes, so a capture submitted meanwhile runs first), each with the key
 *   library_view gave (B18: the worker writes under its own and reports a mismatch). Keys already queued or running are
 *   skipped (C1: no merge of queued jobs); nothing left → no job. The engine refuses under 1 GB free (B4). Calls of a
 *   project run one at a time (the op chain), so two clicks never queue a key twice.
 * - `library_component {project, component}` (L4.7 part D1): the library's detail of one component — kinds, version,
 *   source, kit compatibility (`engines.kit` against this Retake's kit API), duration bounds, variants, slots (name,
 *   type, required, default_from, max_chars: what the manifest schema checks) — and, under `untrusted`, the manifest
 *   author's words: name, description, slot descriptions, the params table (names, types, defaults, enums, bounds,
 *   descriptions), tags, tokens and the README as text. No folder, entry or file list; path-free.
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { COMPONENT_ID_RE, LIBRARY_JOB_MAX, LIBRARY_PREVIEW_KEY_RE, PROJECT_SLUG_RE, TEMPLATE_NAME_RE } from '@retake/core';
import { readPlainFile, fileFacts } from '@retake/core/io';
import { EngineError, libraryCacheDir, memoRegistry, openProjectBySlug, readLibraryImage, themeForWork } from '@retake/engine';
import type { Engine, LibraryStatesView, TemplateSummary } from '@retake/engine';
import { defineTool } from '@retake/engine/contract';
import { pathFree } from './comment-ops.js';
import type { OpChain } from './op-chain.js';
import { opChain } from './op-chain.js';
import { themeSignatures, treeSignature, watchBudget } from './library-watch.js';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** A poster's base64, at most (B6: PREVIEW_MAX_BYTES 204,800 raw × 4/3, rounded up — every committed poster fits). */
export const POSTER_DATA_MAX = 280_000;
/** A loop's base64, at most (LOOP_FORMAT.max_bytes 1.5 MB raw × 4/3 = the app's SHEET_DATA_MAX). */
export const LOOP_DATA_MAX = 2_000_000;
/** One library_images answer's base64, at most (the rest: `missing` with reason `budget`, asked again). */
export const LIBRARY_IMAGES_ANSWER_MAX = 8_000_000;
/** library_view answers memoised, at most. */
export const LIBRARY_VIEW_MEMO_MAX = 8;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF_MAGIC = Buffer.from('GIF89a', 'latin1');

const project = z.string().max(100).regex(PROJECT_SLUG_RE, 'a project slug (project_list names them), never a path');
const theme = z.string().max(100).regex(TEMPLATE_NAME_RE, 'a theme name (library_view lists them), never a path');
const component = z.string().max(120).regex(COMPONENT_ID_RE, 'a component id "namespace/name" (library_view lists them), never a path');
const key = z.string().regex(LIBRARY_PREVIEW_KEY_RE, 'a library preview key (32 hex characters, library_view gives them)');

const ViewInput = z.strictObject({
  project,
  theme: theme.optional().describe("The theme the posters and loops show (default: the project's)."),
});
const ImagesInput = z.strictObject({
  project,
  keys: z.array(key).max(LIBRARY_JOB_MAX).default([]).describe(`Cached posters / loops by key (library_view), at most ${LIBRARY_JOB_MAX}.`),
  committed: z.array(component).max(LIBRARY_JOB_MAX).optional().describe('Built-in components whose committed poster to read (library_view state `committed`).'),
});
const RenderInput = z.strictObject({
  project,
  theme: theme.optional().describe("The theme (default: the project's) — the one library_view showed the keys for."),
  items: z
    .array(
      z.strictObject({
        component,
        poster: key.optional().describe('The poster key library_view gave.'),
        loop: key.optional().describe('The loop key library_view gave.'),
      }),
    )
    .min(1)
    .max(LIBRARY_JOB_MAX)
    .describe(`At most ${LIBRARY_JOB_MAX} components (the page sends the next chunk when this one finished).`),
  retry: z.boolean().optional().describe('Render keys that failed before again (an explicit Retry).'),
});
const ComponentInput = z.strictObject({ project, component });

/** One component of the library as library_view shows it. */
export interface LibraryItem {
  component: string;
  kind: string;
  kinds?: string[];
  version: string;
  source: 'workspace' | 'builtin';
  slots: string[];
  /** Themes listed for the project that pick it for some kind. */
  picked_by: string[];
  /** Kinds the selected theme picks it as ("Theme default"). */
  theme_default: string[];
  poster: { key: string; state: 'committed' | 'cached' | 'failed' | 'missing'; queued?: true; untrusted?: { reason: string } };
  loop: { key: string; state: 'cached' | 'too_large' | 'failed' | 'missing'; queued?: true; untrusted?: { reason: string } };
  /** The manifest's words (a workspace component's are agent-writable): rendered as text only. */
  untrusted: { name: string; description: string };
}

/** What library_view answers (path-free). */
export interface LibraryViewAnswer {
  project: string;
  theme: { name: string; hash: string; editorial_starter: boolean; project_default: boolean };
  /** The theme switcher: every theme the project may use (the project's own marked). */
  themes: Array<{ name: string; source: TemplateSummary['source']; default: boolean }>;
  items: LibraryItem[];
  /** Overrides of built-ins, invalid components, kit API mismatches: the command checks one. */
  notices: Array<{ severity: 'warning' | 'error'; id?: string; issues: number; command?: string; untrusted: { message: string } }>;
  /** Keys of this theme queued or running now (library jobs of this project). */
  queued: number;
  /**
   * The newest finished library job of this theme failed as a whole (its words: untrusted, path-free — review B H1):
   * gone once a later one succeeds.
   */
  job_error?: { job: string; at?: string; untrusted: { message: string } };
}

export interface LibraryImage {
  /** The key asked (a cached entry), or absent for a committed poster. */
  key?: string;
  component: string;
  kind: 'poster' | 'loop';
  format: 'png' | 'gif';
  /** Base64 of the image (shown as a data URL by the page, never stored). */
  data: string;
}

export interface LibraryImagesAnswer {
  images: LibraryImage[];
  /** `missing`: not a complete entry (yet); `too_large`: over its cap; `budget`: the answer was full (ask again); `not_builtin`: no committed poster. */
  missing: Array<{ key?: string; component?: string; reason: 'missing' | 'too_large' | 'budget' | 'not_builtin' }>;
}

export interface LibraryRenderAnswer {
  /** The job queued, or null when every key asked was already queued or running. */
  job: { id: string; state: string } | null;
  theme?: string;
  /** Components the job renders. */
  components: string[];
  /** Keys left out: already queued or running (C1). */
  skipped: Array<{ component: string; kind: 'poster' | 'loop' }>;
  worker?: { pid?: number; spawned: boolean };
}

/** The stat signature of one file or folder (no link followed). */
const statSig = (p: string): string => {
  try {
    const st = lstatSync(p);
    return `${st.isSymbolicLink() ? 'link' : st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return '-';
  }
};

/** Keys of library jobs of `project` queued or running now: key → kind. */
async function queuedKeys(engine: Engine, slug: string): Promise<Map<string, { component: string; kind: 'poster' | 'loop' }>> {
  const out = new Map<string, { component: string; kind: 'poster' | 'loop' }>();
  const jobs = await engine.jobs.list({ project: slug, kinds: ['preview'], states: ['queued', 'running'] });
  for (const j of jobs) {
    const input = j.input;
    if (input.kind !== 'preview' || input.target.kind !== 'library') continue;
    for (const it of input.target.items) {
      if (it.poster) out.set(it.poster, { component: it.component, kind: 'poster' });
      if (it.loop) out.set(it.loop, { component: it.component, kind: 'loop' });
    }
  }
  return out;
}

/** The newest finished (succeeded or failed) library job of `theme` in the project, when it failed: its error. */
async function lastJobError(engine: Engine, slug: string, theme: string, projectTheme: string | undefined): Promise<LibraryViewAnswer['job_error']> {
  const jobs = await engine.jobs.list({ project: slug, kinds: ['preview'], states: ['succeeded', 'failed'], limit: 20 });
  for (const j of jobs) {
    const input = j.input;
    if (input.kind !== 'preview' || input.target.kind !== 'library' || (input.template ?? projectTheme) !== theme) continue;
    if (j.state !== 'failed') return undefined;
    const message = pathFree(j.error?.message ?? 'the job failed', engine.workspace.root);
    return { job: j.id, ...(j.finished_at ? { at: j.finished_at } : {}), untrusted: { message } };
  }
  return undefined;
}

/** A notice's words without a path; its id's validate command when it names one. */
function noticeOf(engine: Engine, n: { severity: 'warning' | 'error'; message: string; id?: string; issues: number }): LibraryViewAnswer['notices'][number] {
  const root = engine.workspace.root;
  return {
    severity: n.severity,
    ...(n.id ? { id: n.id, command: `${engine.cli} components validate ${n.id}` } : {}),
    issues: n.issues,
    untrusted: { message: pathFree(n.message, root) },
  };
}

interface ViewMemo {
  sig: string;
  states: LibraryStatesView;
  list: Awaited<ReturnType<Engine['components']['list']>>;
  themes: Awaited<ReturnType<Engine['templates']['list']>>;
}

export function libraryOps(o: { chain?: OpChain } = {}) {
  const oneAtATime = o.chain ?? opChain();
  /** library_view memo: (project, theme asked) → the reads, while the stat walks are unchanged (B5). */
  const memo = new Map<string, ViewMemo>();

  /** The file-level signature of everything a library view depends on (critique B5). */
  const viewSignature = async (engine: Engine, slug: string, asked: string | undefined): Promise<string> => {
    const ws = engine.workspace;
    const p = await openProjectBySlug(ws, slug);
    const t = await themeForWork(p, asked, fileFacts(ws.policy));
    const reg = (await memoRegistry(ws)).registry;
    // One entry budget for the whole signature (review A L4), as the event stream's scan.
    const budget = watchBudget();
    return [
      `theme ${t.name} ${t.dir} ${treeSignature(t.dir, budget)}`,
      `project ${statSig(join(p.dir, 'project.yaml'))}`,
      `templates ${statSig(ws.templatesDir)} ${[...(await themeSignatures(ws.templatesDir, budget))].map(([n, sg]) => `${n}=${sg}`).join(',')}`,
      `builtin ${reg.builtinDir ? treeSignature(reg.builtinDir) : '-'}`,
      `components ${treeSignature(ws.componentsDir, budget)}`,
      `cache ${statSig(libraryCacheDir(ws))}`,
    ].join('\n');
  };

  const view = defineTool({
    name: 'library_view',
    title: 'The component library',
    description: "Every usable component with its poster and loop in a theme (keys, cache states, queued), the themes that pick it, the registry's notices and the theme switcher.",
    input: ViewInput,
    annotations: READ,
    async run(a, { engine }) {
      const sig = await viewSignature(engine, a.project, a.theme);
      const mk = `${a.project}\0${a.theme ?? ''}`;
      let m = memo.get(mk);
      if (!m || m.sig !== sig) {
        const [states, list, themes] = await Promise.all([
          engine.components.library({ project: a.project, ...(a.theme ? { template: a.theme } : {}) }),
          engine.components.list(),
          engine.templates.list({ project: a.project }),
        ]);
        m = { sig, states, list, themes };
        memo.delete(mk);
        memo.set(mk, m);
        while (memo.size > LIBRARY_VIEW_MEMO_MAX) memo.delete(memo.keys().next().value!);
      } else {
        memo.delete(mk);
        memo.set(mk, m);
      }
      const queued = await queuedKeys(engine, a.project);
      const jobError = await lastJobError(engine, a.project, m.states.theme.name, m.themes.project_theme);
      const root = engine.workspace.root;
      /** A failure's words (untrusted, B16) without a path (review A L2: Remotion / esbuild quote absolute files). */
      const reasonOf = (u: { reason: string } | undefined) => (u ? { untrusted: { reason: pathFree(u.reason, root) } } : {});
      const states = new Map(m.states.items.map((i) => [i.component, i]));
      const selected = m.themes.templates.find((t) => t.name === m!.states.theme.name);
      const items: LibraryItem[] = [];
      let queuedHere = 0;
      for (const c of m.list.components) {
        const s = states.get(c.id);
        if (!s) continue;
        const picked_by = m.themes.templates.filter((t) => Object.values(t.components).includes(c.id)).map((t) => t.name);
        const theme_default = selected ? Object.entries(selected.components).filter(([, id]) => id === c.id).map(([k]) => k) : [];
        const pq = queued.has(s.poster.key);
        const lq = queued.has(s.loop.key);
        queuedHere += Number(pq) + Number(lq);
        items.push({
          component: c.id,
          kind: c.kind,
          ...(c.kinds ? { kinds: c.kinds } : {}),
          version: c.version,
          source: c.source,
          slots: c.slots,
          picked_by,
          theme_default,
          poster: { key: s.poster.key, state: s.poster.state, ...(pq ? { queued: true as const } : {}), ...reasonOf(s.poster.untrusted) },
          loop: { key: s.loop.key, state: s.loop.state, ...(lq ? { queued: true as const } : {}), ...reasonOf(s.loop.untrusted) },
          untrusted: { name: c.name, description: c.description },
        });
      }
      const data: LibraryViewAnswer = {
        project: a.project,
        theme: { ...m.states.theme, project_default: m.themes.project_theme === m.states.theme.name },
        themes: m.themes.templates.map((t) => ({ name: t.name, source: t.source, default: t.default === true })),
        items,
        notices: m.list.notices.map((n) => noticeOf(engine, n)),
        queued: queuedHere,
        ...(jobError ? { job_error: jobError } : {}),
      };
      const counts = { cached: items.filter((i) => i.loop.state === 'cached').length };
      return {
        summary: `${items.length} components in ${data.theme.name}: ${counts.cached} loops cached${queuedHere ? `, ${queuedHere} previews queued` : ''}${data.notices.length ? `, ${data.notices.length} notices` : ''}`,
        data,
      };
    },
  });

  const images = defineTool({
    name: 'library_images',
    title: 'Library posters and loops',
    description: 'Cached posters (PNG) and loops (GIF) by key, and committed posters of built-in components, as base64 — magic-checked and capped.',
    input: ImagesInput,
    annotations: READ,
    async run(a, { engine }) {
      const ws = engine.workspace;
      await openProjectBySlug(ws, a.project);
      const out: LibraryImagesAnswer = { images: [], missing: [] };
      let budget = LIBRARY_IMAGES_ANSWER_MAX;
      for (const k of [...new Set(a.keys)]) {
        const img = await readLibraryImage(ws, k);
        if (!img) {
          out.missing.push({ key: k, reason: 'missing' });
          continue;
        }
        const magic = img.kind === 'poster' ? PNG_MAGIC : GIF_MAGIC;
        if (!img.bytes.subarray(0, magic.length).equals(magic)) {
          out.missing.push({ key: k, reason: 'missing' });
          continue;
        }
        const data = img.bytes.toString('base64');
        if (data.length > (img.kind === 'poster' ? POSTER_DATA_MAX : LOOP_DATA_MAX)) {
          out.missing.push({ key: k, reason: 'too_large' });
          continue;
        }
        if (data.length > budget) {
          out.missing.push({ key: k, reason: 'budget' });
          continue;
        }
        budget -= data.length;
        out.images.push({ key: k, component: img.component, kind: img.kind, format: img.kind === 'poster' ? 'png' : 'gif', data });
      }
      if (a.committed?.length) {
        const { PREVIEW_FILE, PREVIEW_MAX_BYTES } = await import('@retake/components');
        const reg = (await memoRegistry(ws)).registry;
        for (const id of [...new Set(a.committed)]) {
          // A built-in only (B15): a workspace component of that id (an override) never shows the built-in's picture.
          const info = reg.has(id) ? reg.get(id) : undefined;
          if (!info || info.source !== 'builtin') {
            out.missing.push({ component: id, reason: 'not_builtin' });
            continue;
          }
          const r = readPlainFile(join(info.dir, PREVIEW_FILE), PREVIEW_MAX_BYTES, { verify: (st) => st.nlink === 1 });
          if (!r.ok || !r.bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
            out.missing.push({ component: id, reason: r.ok || r.reason !== 'too_large' ? 'missing' : 'too_large' });
            continue;
          }
          const data = r.bytes.toString('base64');
          if (data.length > POSTER_DATA_MAX) {
            out.missing.push({ component: id, reason: 'too_large' });
            continue;
          }
          if (data.length > budget) {
            out.missing.push({ component: id, reason: 'budget' });
            continue;
          }
          budget -= data.length;
          out.images.push({ component: id, kind: 'poster', format: 'png', data });
        }
      }
      return { summary: `${out.images.length} images${out.missing.length ? `, ${out.missing.length} missing` : ''}`, data: out };
    },
  });

  const render = defineTool({
    name: 'library_render',
    title: 'Render library previews',
    description: `Queue posters and / or loops of at most ${LIBRARY_JOB_MAX} components in a theme, by the keys library_view gave; keys already queued or running are skipped.`,
    input: RenderInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(a, { engine }) {
      const r = await oneAtATime(`library:${a.project}`, async (): Promise<LibraryRenderAnswer> => {
        const ids = new Set<string>();
        for (const it of a.items) {
          if (ids.has(it.component)) throw new EngineError('invalid', `items: ${it.component} is named twice`);
          ids.add(it.component);
          if (!it.poster && !it.loop) throw new EngineError('invalid', `items: ${it.component} names no key (a poster, a loop or both)`);
        }
        const queued = await queuedKeys(engine, a.project);
        const skipped: LibraryRenderAnswer['skipped'] = [];
        const items: Array<{ component: string; poster?: string; loop?: string }> = [];
        for (const it of a.items) {
          const keep: { component: string; poster?: string; loop?: string } = { component: it.component };
          for (const kind of ['poster', 'loop'] as const) {
            const k = it[kind];
            if (!k) continue;
            if (queued.has(k)) skipped.push({ component: it.component, kind });
            else keep[kind] = k;
          }
          if (keep.poster || keep.loop) items.push(keep);
        }
        if (!items.length) return { job: null, components: [], skipped };
        const sub = await engine.components.libraryRender({ project: a.project, ...(a.theme ? { template: a.theme } : {}), items, ...(a.retry ? { retry: true } : {}) });
        return { job: { id: sub.job.id, state: sub.job.state }, theme: sub.theme, components: items.map((i) => i.component), skipped, ...(sub.worker ? { worker: sub.worker } : {}) };
      });
      return {
        summary: r.job ? `library previews of ${r.components.length} components queued (job ${r.job.id})${r.skipped.length ? `, ${r.skipped.length} already queued` : ''}` : `nothing queued: ${r.skipped.length} previews already queued or running`,
        data: r,
      };
    },
  });
  const detail = defineTool({
    name: 'library_component',
    title: 'One component of the library',
    description: "One component's detail: kinds, version, source, kit compatibility, duration bounds, variants, slots and params (the manifest's words under untrusted), README as text.",
    input: ComponentInput,
    annotations: READ,
    async run(a, { engine }) {
      await openProjectBySlug(engine.workspace, a.project);
      const c = await engine.components.get(a.component);
      const data = await componentAnswer(c, engine.workspace.root);
      return { summary: `${data.component} (${data.kind}, ${data.source}): ${data.slots.length} slots, ${data.untrusted.params.length} params`, data: data };
    },
  });
  return [view, images, render, detail] as const;
}

/** One slot as library_component shows it: what the manifest schema checks (name an identifier, type, numbers). */
export interface LibrarySlot {
  name: string;
  type: string;
  required: boolean;
  default_from?: string;
  max_chars?: number;
}

/** One param (its schema's words are the manifest author's: all under untrusted). */
export interface LibraryParam {
  name: string;
  type?: string;
  /** The default as JSON text. */
  default?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  description?: string;
}

/** What library_component answers (path-free; the manifest's words under `untrusted`). */
export interface LibraryComponentAnswer {
  component: string;
  kind: string;
  kinds?: string[];
  version: string;
  source: 'workspace' | 'builtin';
  /** A workspace component that replaces the built-in of the same id. */
  overrides_builtin?: true;
  /** The kit API major it needs (engines.kit; absent = 1) and the one this Retake provides. */
  kit: { needs: number; provided: number; compatible: boolean };
  duration?: { default: number; min?: number; max?: number };
  variants: string[];
  slots: LibrarySlot[];
  untrusted: {
    name: string;
    description: string;
    /** Slot descriptions by slot name. */
    slots: Record<string, string>;
    params: LibraryParam[];
    tags: string[];
    tokens: string[];
    /** README.md as text (never rendered as Markdown), truncated by the engine. */
    readme?: string;
  };
}

/** A JSON value as short text (a param's default, an enum value). */
const jsonText = (v: unknown): string => {
  let s: string;
  try {
    s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Slots, params at most (a manifest could declare thousands). */
const DETAIL_ROWS_MAX = 64;

/** engine components.get → the library's detail: no dir, entry or file list; every manifest word under untrusted, path-free. */
export async function componentAnswer(c: Awaited<ReturnType<Engine['components']['get']>>, root: string): Promise<LibraryComponentAnswer> {
  const { KIT_API_VERSION, kitMajorOf } = await import('@retake/components');
  const m = c.manifest;
  const free = (s: string) => pathFree(s, root);
  const needs = kitMajorOf(m);
  const slots: LibrarySlot[] = [];
  const slotWords: Record<string, string> = {};
  for (const [name, s] of Object.entries(m.slots ?? {}).slice(0, DETAIL_ROWS_MAX)) {
    slots.push({ name, type: s.type, required: s.required === true, ...(s.default_from ? { default_from: s.default_from } : {}), ...(num(s.max_chars) !== undefined ? { max_chars: s.max_chars } : {}) });
    if (s.description) slotWords[name] = free(s.description);
  }
  const params: LibraryParam[] = [];
  const props = m.params && typeof m.params === 'object' ? (m.params as { properties?: unknown }).properties : undefined;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const [name, raw] of Object.entries(props as Record<string, unknown>).slice(0, DETAIL_ROWS_MAX)) {
      const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const type = Array.isArray(p.type) ? p.type.filter((t) => typeof t === 'string').join(' | ') : str(p.type);
      const description = str(p.description);
      params.push({
        name: free(name),
        ...(type ? { type } : {}),
        ...(name in c.param_defaults ? { default: free(jsonText(c.param_defaults[name])) } : 'default' in p ? { default: free(jsonText(p.default)) } : {}),
        ...(Array.isArray(p.enum) ? { enum: p.enum.slice(0, 32).map((e) => free(jsonText(e))) } : {}),
        ...(num(p.minimum) !== undefined ? { minimum: num(p.minimum) } : {}),
        ...(num(p.maximum) !== undefined ? { maximum: num(p.maximum) } : {}),
        ...(description ? { description: free(description) } : {}),
      });
    }
  }
  return {
    component: c.id,
    kind: c.kind,
    ...(c.kinds?.length ? { kinds: [...c.kinds] } : {}),
    version: c.version,
    source: c.source,
    ...(c.overrides_builtin ? { overrides_builtin: true as const } : {}),
    kit: { needs, provided: KIT_API_VERSION, compatible: needs === KIT_API_VERSION },
    ...(m.duration ? { duration: { default: m.duration.default, ...(m.duration.min !== undefined ? { min: m.duration.min } : {}), ...(m.duration.max !== undefined ? { max: m.duration.max } : {}) } } : {}),
    variants: [...(m.variants ?? ['landscape'])],
    slots,
    untrusted: {
      name: free(c.name),
      description: free(c.description),
      slots: slotWords,
      params,
      tags: (c.tags ?? []).slice(0, 32).map(free),
      tokens: (m.tokens ?? []).slice(0, 64).map(free),
      ...(c.readme !== undefined ? { readme: free(c.readme) } : {}),
    },
  };
}

/** The library ops' names. */
export const LIBRARY_OPS = ['library_view', 'library_images', 'library_render', 'library_component'] as const;
