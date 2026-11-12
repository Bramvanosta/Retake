/**
 * What the Studio's theme editor previews (L4.7 theme_preview; L7.17: built here, the Studio keeps its player origin,
 * leases and allow-list): the editor's ComponentPreviewSpec (motion mode) of a theme's intro, its layout with its
 * caption over the sample screen (`clip`), its outro, or one component in the theme — the draft's colours applied in
 * memory, never written; every file the spec names registered by the shell (`start` hands the registrar, called where
 * the shell's player and leases are first needed: after the theme, the registry and the target are settled). A theme
 * whose intro / outro is its own video, image or Lottie (B10) is not previewed — said.
 */
import type { ComponentKind, LoadedTemplate } from '@retake/core/model';
import { isTemplateMediaRef } from '@retake/core/theme';
import { fileFacts } from '@retake/core/io';
import type { ComponentRegistry } from '@retake/components';
import type { ComponentPreviewSpec, PreviewSamples } from '@retake/editor';
import { components } from './components.js';
import { EngineError } from './errors.js';
import { editor } from './lazy.js';
import { firstErrorLine, openProjectBySlug } from './projects.js';
import { pathFree } from './renders.js';
import { themeAssetProblems, themeForWork } from './templates.js';
import { memoRegistry } from './timeline-view.js';
import type { OpenedWorkspace } from './workspace.js';

/** Colours being changed in the editor (memory only). */
export interface ThemePreviewDraft {
  colors?: { accent?: string; text?: string; muted?: string; paper?: string; dark?: string };
  background?: { type: 'solid'; color: string } | { type: 'radial' | 'linear'; from: string; to: string };
}

export interface ThemePreviewRequest {
  project: string;
  theme: string;
  target: 'intro' | 'clip' | 'outro' | { component: string };
  draft?: ThemePreviewDraft;
}

/** The theme and target a preview names (every answer of theme_preview starts with it). */
export interface ThemePreviewBase {
  theme: string;
  target: { kind: string; component?: string };
}

/** A file of the spec served by the shell: its URL, or undefined (a link, not a plain file). */
export type ThemePreviewServe = (file: string, within: readonly string[]) => string | undefined;

/** A preview built: its spec, the components it renders, the registry they come from, the folders it serves from. */
export interface ThemePreviewBuilt {
  base: ThemePreviewBase;
  spec: ComponentPreviewSpec;
  components: string[];
  registry: ComponentRegistry;
  /** The theme folder, the sample screens' folder and the project's: no string of the spec may name them. */
  folders: string[];
}

/** Or why nothing is previewed (`not_previewed`) or what failed (`preview_error`, path-free). */
export type ThemePreviewBuild = { built: ThemePreviewBuilt } | { answer: ThemePreviewBase & ({ not_previewed: string } | { preview_error: string }) };

let samplesMemo: Promise<PreviewSamples> | undefined;

/** The theme with the draft's colours (memory only). */
function withDraft(t: LoadedTemplate, draft: ThemePreviewDraft | undefined): LoadedTemplate {
  if (!draft) return t;
  const tpl = t.template;
  return {
    ...t,
    template: {
      ...tpl,
      colors: {
        ...tpl.colors,
        ...Object.fromEntries(
          Object.entries(draft.colors ?? {})
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, (v as string).toLowerCase()]),
        ),
      },
      ...(draft.background ? { background: { ...draft.background } } : {}),
    },
  } as LoadedTemplate;
}

/**
 * theme_preview's spec (see the header). Refusals (thrown): the project, the theme, a file the theme may not serve
 * (`refused`), a component not in the registry (`not_found`). `start` is called once the target is settled, and
 * what it throws is thrown.
 */
export async function buildThemePreview(ws: OpenedWorkspace, a: ThemePreviewRequest, o: { start: () => ThemePreviewServe }): Promise<ThemePreviewBuild> {
  const p = await openProjectBySlug(ws, a.project);
  const loaded = await themeForWork(p, a.theme, fileFacts(ws.policy));
  const problems = themeAssetProblems(loaded);
  if (problems.length) throw new EngineError('refused', `${problems.map((x) => pathFree(x, ws.root)).join('; ')}: a theme serves only its own files`);
  const registry = (await memoRegistry(ws)).registry;
  const tpl = withDraft(loaded, a.draft);
  const targetKind = typeof a.target === 'string' ? a.target : 'component';
  const base: ThemePreviewBase = { theme: loaded.name, target: { kind: targetKind, ...(typeof a.target === 'object' ? { component: a.target.component } : {}) } };
  // The component shown and its params: the theme's pick for the kind (with its params), or the one asked.
  let id: string;
  let params: Record<string, unknown> | undefined;
  let resolved;
  try {
    resolved = registry.resolveTheme(tpl.template);
  } catch (e) {
    return { answer: { ...base, preview_error: firstErrorLine(pathFree(e instanceof Error ? e.message : String(e), ws.root)) } };
  }
  if (typeof a.target === 'string') {
    const k: ComponentKind = a.target === 'clip' ? 'layout' : a.target;
    // B10: the theme's own video / image / Lottie: its file is not previewed here (the sample would stand for it).
    if (isTemplateMediaRef(tpl.template.components?.[k] as Parameters<typeof isTemplateMediaRef>[0])) {
      return { answer: { ...base, not_previewed: `the theme's ${k} is its own video, image or Lottie file: not previewed here (a render shows it)` } };
    }
    const rc = resolved[k];
    if (!rc) return { answer: { ...base, not_previewed: `the theme has no ${k}` } };
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
  const register = o.start();
  const [ed, comps] = [await editor(), await components()];
  samplesMemo ??= Promise.resolve().then(() => ed.loadPreviewSamples());
  samplesMemo.catch(() => (samplesMemo = undefined));
  const samples = await samplesMemo;
  // Every file the spec names is served by the shell under the project's capability, from its own folder only.
  const serve =
    (within: string) =>
    (file: string): string => {
      const url = register(file, [within]);
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
    return { answer: { ...base, preview_error: firstErrorLine(pathFree(e instanceof Error ? e.message : String(e), ws.root)) } };
  }
  return { built: { base, spec: built.spec, components: built.components, registry, folders: [loaded.dir, comps.PREVIEW_SAMPLES_DIR, p.dir] } };
}
