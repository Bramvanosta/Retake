/**
 * Component resolution for the planner: every use goes through a precedence chain (override by segment id →
 * override by kind → scenario → theme → built-in default), each candidate is resolved by the registry (params
 * defaults + validation, kind check) and the first one that resolves wins. A candidate that does not resolve is
 * reported and the next one is tried; when none resolves, the use keeps the most specific id marked `missing` (the
 * renderer draws a stand-in of the kind). Slots are filled with `fillSlots` (given values, then `default_from`).
 */
import { resolve as resolvePath } from 'node:path';
import { FRAME_STYLE_LAYOUTS, MULTI_PAGE_LAYOUTS } from '@retake/core/model';
import { normalizeComponentRef, resolveThemeComponents } from '@retake/core/theme';
import type {
  ComponentKind,
  ComponentRef,
  FrameSpec,
  FrameStyle,
  LoadedTemplate,
  MultiPageFrame,
  SceneTransition,
  TransitionKind,
} from '@retake/core/model';
import { fillSlots } from '@retake/components/geometry';
import type { ComponentManifest, ComponentRegistry, MediaValue, ResolvedComponentRef, SlotContext } from '@retake/components/geometry';
import type { ResolvedComponent } from './plan-types.js';
import type { MessageList } from './util.js';
import { firstLine } from './util.js';

/** The built-in default of each kind (the reference look), used when nothing else resolves. */
export const BUILTIN_DEFAULTS: Readonly<Record<ComponentKind, string>> = {
  intro: 'studio/intro-stack',
  outro: 'studio/outro-stack',
  card: 'studio/card-title',
  interstitial: 'studio/interstitial-clock',
  caption: 'studio/caption-below',
  layout: 'studio/layout-card',
  overlay: 'studio/overlay-callout',
  transition: 'studio/transition-crossfade',
};

/** Built-in transition component of each transition kind (cut = none). */
export const TRANSITION_COMPONENTS: Readonly<Record<Exclude<TransitionKind, 'cut'>, string>> = {
  crossfade: 'studio/transition-crossfade',
  'fade-black': 'studio/transition-fade-black',
};

const FRAME_STYLES = Object.keys(FRAME_STYLE_LAYOUTS) as FrameStyle[];

export function isFrameStyle(spec: string): spec is FrameStyle {
  return (FRAME_STYLES as string[]).includes(spec);
}

/** One step of a precedence chain. `ref: null` = explicitly none (no captions, cut…). */
export interface Candidate {
  ref: ComponentRef | null;
  source: ResolvedComponent['source'];
  /** For messages: "overrides.components.intro", "the scenario", "the theme"… */
  label: string;
  /** The ref is the theme's own choice for the kind (already resolved by `registry.resolveTheme` when it succeeded). */
  fromTheme?: boolean;
  /** Slot values this candidate brings (a user file in studio/media's `file` slot, L2.12), over the use's own. */
  slots?: Record<string, string>;
  /** Seconds on screen this candidate sets (a theme's own file, L2.12). */
  duration?: number;
}

export interface SlotInput {
  /** Slot values written by the scenario for this use (all reported when the component lacks them). */
  explicit?: Record<string, string | undefined>;
  /** Values the scenario/theme gives for well-known slot names (used only when the component declares the slot). */
  named?: Record<string, string | undefined>;
  ctx?: SlotContext;
}

/** What a transition component does: crossfade (overlap), fade-black (dip through a colour) or cut (none). */
export function transitionKindOf(rc: { id: string; params: Record<string, unknown> } | null): TransitionKind {
  if (!rc) return 'cut';
  const k = rc.params.kind;
  if (k === 'crossfade' || k === 'fade-black' || k === 'cut') return k;
  if (/fade-black$/.test(rc.id)) return 'fade-black';
  if (typeof rc.params.through === 'string' && rc.params.through !== 'none') return 'fade-black';
  return 'crossfade';
}

/** Resolves the artefact slots of a use (`email: welcome`…) into media (the planner's artefact index). */
export type MediaResolver = (manifest: ComponentManifest, slots: Record<string, string | undefined>, where: string) => Record<string, MediaValue> | undefined;

export class ComponentResolver {
  private readonly manifests = new WeakMap<ResolvedComponent, ComponentManifest>();
  private readonly winners = new WeakMap<ResolvedComponent, Candidate>();
  private readonly theme: ReturnType<typeof resolveThemeComponents>;
  private readonly themeResolved: Record<ComponentKind, ResolvedComponentRef | null> | null;
  /** Component problems, reported once with every use they affect (message → uses). */
  private readonly problems = new Map<string, string[]>();

  constructor(
    private readonly registry: ComponentRegistry,
    readonly template: LoadedTemplate,
    private readonly warnings: MessageList,
    private readonly media?: MediaResolver,
  ) {
    this.theme = resolveThemeComponents(template.template);
    let resolved: Record<ComponentKind, ResolvedComponentRef | null> | null = null;
    try {
      resolved = registry.resolveTheme(template.template);
    } catch {
      // Some kinds do not resolve: each one is tried (and reported) when it is used.
    }
    this.themeResolved = resolved;
  }

  /** The theme's candidate for a kind (`ref: null` = the theme says none). */
  themeCandidate(kind: ComponentKind): Candidate {
    const c = this.theme[kind];
    if (c === null) return { ref: null, source: 'theme', label: `the theme (${kind}: none)` };
    const out: Candidate = { ref: { id: c.id, params: c.params }, source: c.source === 'default' ? 'builtin-default' : 'theme', label: 'the theme', fromTheme: true };
    if (c.file) {
      // The theme's own file (L2.12): its path is relative to the template folder.
      out.slots = { file: resolvePath(this.template.dir, c.file.path) };
      out.label = `the theme's ${c.file.kind} file ${c.file.path}`;
      if (c.duration !== undefined) out.duration = c.duration;
    }
    return out;
  }

  /** The candidate of the chain that produced a resolved use (its slots / duration). */
  candidateOf(rc: ResolvedComponent | null | undefined): Candidate | undefined {
    return rc ? this.winners.get(rc) : undefined;
  }

  builtinCandidate(kind: ComponentKind): Candidate {
    return { ref: BUILTIN_DEFAULTS[kind], source: 'builtin-default', label: 'the built-in default' };
  }

  /** The manifest behind a resolved use (undefined for a missing component). */
  manifest(rc: ResolvedComponent | null | undefined): ComponentManifest | undefined {
    return rc ? this.manifests.get(rc) : undefined;
  }

  /**
   * A layout candidate from a frame spec: a component id as is; a FrameStyle is the theme's own layout when it is
   * the theme's frame style, else the built-in layout of that style (card: with the theme's width/radius/shadow).
   */
  frameCandidate(spec: FrameSpec, source: ResolvedComponent['source'], label: string): Candidate {
    if (spec === 'split' || spec === 'pip') return this.multiPageCandidate(spec, source, label);
    if (!isFrameStyle(spec)) return { ref: spec, source, label };
    const t = this.template.template;
    if (spec === t.frame.style) {
      const theme = this.themeCandidate('layout');
      if (theme.ref !== null) {
        return { ref: theme.ref, source: source === 'override' ? 'override' : theme.source, label: `${label} (frame "${spec}": the theme's layout)`, fromTheme: true };
      }
    }
    const id = FRAME_STYLE_LAYOUTS[spec];
    const params = spec === 'card' ? { width: t.frame.width, radius: t.frame.radius, shadow: t.frame.shadow } : {};
    return { ref: { id, params }, source, label: `${label} (frame "${spec}")` };
  }

  /**
   * A multi-page layout (L2.11) dressed by the theme: its card radius and shadow, a browser bar on each page when the
   * theme frames captures in a browser window (studio/layout-browser), the theme's card width for the main page of a
   * picture in picture.
   */
  multiPageCandidate(kind: MultiPageFrame, source: ResolvedComponent['source'], label: string): Candidate {
    const t = this.template.template;
    const themeLayout = this.theme.layout;
    const tp = themeLayout?.params ?? {};
    const browser = themeLayout?.id === 'studio/layout-browser' || themeLayout?.id === 'studio/layout-laptop';
    const params: Record<string, unknown> = {
      radius: typeof tp.radius === 'number' ? tp.radius : t.frame.radius,
      shadow: typeof tp.shadow === 'string' ? tp.shadow : t.frame.shadow,
      chrome: browser,
    };
    if (kind === 'pip') {
      const width = typeof tp.width === 'number' ? tp.width : t.frame.width;
      if (width >= 800 && width <= 1920) params.width = width;
    }
    return { ref: { id: MULTI_PAGE_LAYOUTS[kind], params }, source, label: `${label} (frame "${kind}"${browser ? ', browser windows like the theme' : ''})` };
  }

  /**
   * A transition candidate from a scene / card `transition`: a kind (see transitionCandidate) or a transition component
   * (an id or {component, params}).
   */
  sceneTransitionCandidate(spec: SceneTransition, source: ResolvedComponent['source'], label: string): Candidate {
    if (typeof spec === 'string' && (spec === 'crossfade' || spec === 'cut' || spec === 'fade-black')) return this.transitionCandidate(spec, source, label);
    const ref = typeof spec === 'string' ? { id: spec, params: {} } : { id: spec.component, params: spec.params ?? {} };
    return { ref, source, label: `${label} (${ref.id})` };
  }

  /** A transition candidate from a transition kind: the theme's transition when it is of that kind, else the built-in one. */
  transitionCandidate(kind: TransitionKind, source: ResolvedComponent['source'], label: string): Candidate {
    if (kind === 'cut') return { ref: null, source, label: `${label} (cut)` };
    const theme = this.themeCandidate('transition');
    if (theme.ref !== null && transitionKindOf(normalizeComponentRef(theme.ref)) === kind) {
      return { ref: theme.ref, source, label: `${label} (${kind}: the theme's transition)`, fromTheme: true };
    }
    return { ref: TRANSITION_COMPONENTS[kind], source, label: `${label} (${kind})` };
  }

  private tryResolve(c: Candidate, kind: ComponentKind): ResolvedComponentRef {
    const ready = c.fromTheme ? this.themeResolved?.[kind] : undefined;
    return ready ?? this.registry.resolve(c.ref!, kind);
  }

  /**
   * Resolve one component use through its chain. Returns null when the first candidate that applies says "none".
   * `where` names the use in messages ("intro", `scene "import"`…).
   */
  resolve(kind: ComponentKind, chain: readonly Candidate[], where: string, slots: SlotInput = {}): ResolvedComponent | null {
    const failures: Array<{ c: Candidate; message: string }> = [];
    for (const c of chain) {
      if (c.ref === null) {
        if (failures.length > 0) this.reportFallback(where, kind, failures, `none (${c.label})`);
        return null;
      }
      let resolved: ResolvedComponentRef;
      try {
        resolved = this.tryResolve(c, kind);
      } catch (e) {
        failures.push({ c, message: firstLine(e) });
        continue;
      }
      if (failures.length > 0) this.reportFallback(where, kind, failures, `${resolved.id} (${c.label})`);
      const filled = this.fill(resolved.manifest, c.slots ? { ...slots, explicit: { ...(slots.explicit ?? {}), ...c.slots } } : slots, where, resolved.id);
      const out: ResolvedComponent = {
        id: resolved.id,
        version: resolved.version,
        kind,
        params: resolved.params,
        slots: filled,
        source: c.source,
      };
      const media = this.media?.(resolved.manifest, filled, where);
      if (media && Object.keys(media).length > 0) out.media = media;
      this.manifests.set(out, resolved.manifest);
      this.winners.set(out, c);
      return out;
    }
    // Nothing resolves: keep the most specific wish, marked missing.
    const first = chain.find((c) => c.ref !== null);
    const ref = normalizeComponentRef(first?.ref ?? BUILTIN_DEFAULTS[kind]);
    const ids = [...new Set(failures.map((f) => normalizeComponentRef(f.c.ref!).id))];
    const reasons = [...new Set(failures.map((f) => f.message))];
    this.problem(where, `no ${kind} component could be resolved (${ids.join(', ')}): ${reasons.join('; ')} — the renderer draws a stand-in`);
    const given: Record<string, string | undefined> = { ...(slots.named ?? {}), ...(slots.explicit ?? {}) };
    for (const k of Object.keys(given)) if (given[k] === undefined) delete given[k];
    return { id: ref.id, version: '0.0.0', kind, params: ref.params, slots: given, source: first?.source ?? 'builtin-default', missing: true };
  }

  private reportFallback(where: string, kind: ComponentKind, failures: Array<{ c: Candidate; message: string }>, chosen: string): void {
    for (const f of failures) this.problem(where, `${kind} component from ${f.c.label} not usable — ${f.message}; using ${chosen}`);
  }

  private problem(where: string, message: string): void {
    const uses = this.problems.get(message);
    if (uses) {
      if (!uses.includes(where)) uses.push(where);
    } else this.problems.set(message, [where]);
  }

  /** Report the component problems (one warning per problem, listing the uses it affects). */
  flush(): void {
    for (const [message, uses] of this.problems) this.warnings.add(`${uses.join(', ')}: ${message}`);
    this.problems.clear();
  }

  private fill(manifest: ComponentManifest, slots: SlotInput, where: string, id: string): Record<string, string | undefined> {
    const named: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(slots.named ?? {})) if (v !== undefined && manifest.slots[k] !== undefined) named[k] = v;
    const explicit: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(slots.explicit ?? {})) if (v !== undefined) explicit[k] = v;
    const r = fillSlots(manifest, { ...named, ...explicit }, slots.ctx ?? {});
    for (const name of r.missing) this.warnings.add(`${where}: ${id} needs slot "${name}" and neither the scenario nor the theme gives one`);
    for (const t of r.tooLong) this.warnings.add(`${where}: slot "${t.slot}" of ${id} is ${t.length} characters (max ${t.max}): it will be shrunk or cut`);
    for (const name of r.unknown) {
      if (explicit[name] !== undefined) {
        this.warnings.add(`${where}: ${id} has no slot "${name}" (slots: ${Object.keys(manifest.slots).join(', ') || 'none'}): ignored`);
      }
    }
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(r.slots)) if (v !== undefined) out[k] = v;
    return out;
  }
}
