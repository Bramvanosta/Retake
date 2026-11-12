/**
 * The component library screen's pure rules (L4.7 part D1, R-UI-06 / R-UI-06b): filters and groups, the words of a
 * card's poster and loop states, the source badge ("Built-in" / "Workspace" — the tool cannot tell who wrote a workspace
 * component, so it never says "made with Claude"), which events re-read the library, the theme write behind "Set as
 * theme default" (one `set_component` through theme_edit; a starter or read-only theme is copied first), and the
 * "Create with Claude" prompt — a text the person copies: the Studio calls no model. The prompt carries only the
 * person's own words (cleaned and quoted) and names checked against their patterns (a component id, a project slug, a
 * theme name), never a manifest string or a name from the address bar that does not match.
 */
import type { ThemeEditView } from '@retake/engine';
import type { LibraryItem } from '../../server/library-ops.js';
import type { ThemeEditInput } from '../data/themes.js';
import type { StudioEvent } from '../events.js';
import { APP_NAME } from '../brand.js';
import { ANY_THEME_NAME, ANY_THEME_NAME_MAX, NEW_THEME_NAME, NEW_THEME_NAME_MAX, PROJECT_SLUG, okNewThemeName } from '../id-words.js';

/** The kinds in the library's order (core COMPONENT_KINDS). */
export const KIND_ORDER = ['intro', 'outro', 'card', 'interstitial', 'caption', 'layout', 'overlay', 'transition'] as const;
export type Kind = (typeof KIND_ORDER)[number];

/** A kind's words: one, many. */
export const KIND_WORDS: Record<Kind, [string, string]> = {
  intro: ['Intro', 'Intros'],
  outro: ['Outro', 'Outros'],
  card: ['Card', 'Cards'],
  interstitial: ['Interstitial', 'Interstitials'],
  caption: ['Caption', 'Captions'],
  layout: ['Layout', 'Layouts'],
  overlay: ['Overlay', 'Overlays'],
  transition: ['Transition', 'Transitions'],
};

export const isKind = (k: unknown): k is Kind => typeof k === 'string' && (KIND_ORDER as readonly string[]).includes(k);

/** core COMPONENT_ID_RE (mirrored: the app imports no runtime code from core; a test pins them equal). */
export const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
/** Longest component id (the server's cap). */
export const COMPONENT_ID_MAX = 120;
/** Longest project slug (the server's cap). A theme that exists: ANY_THEME_NAME_MAX; a NEW theme's name: NEW_THEME_NAME_MAX. */
export const NAME_MAX = 100;

export const okId = (id: unknown): id is string => typeof id === 'string' && id.length <= COMPONENT_ID_MAX && COMPONENT_ID_RE.test(id);
/** A project slug (at most 100 characters). Not the test of a new theme's name: okNewThemeName (id-words.ts). */
export const okName = (n: unknown): n is string => typeof n === 'string' && n.length <= NAME_MAX && PROJECT_SLUG.test(n);
/** The name of a theme that exists (at most 100 characters), whatever made it. */
export const okTheme = (n: unknown): n is string => typeof n === 'string' && n.length <= ANY_THEME_NAME_MAX && ANY_THEME_NAME.test(n);

export type SourceFilter = 'all' | 'builtin' | 'workspace';

export interface LibraryFilter {
  /** A kind, or 'all'. */
  kind: string;
  source: SourceFilter;
  /** Words to find in the name, id or description (case-insensitive). */
  text: string;
}

export const NO_FILTER: LibraryFilter = { kind: 'all', source: 'all', text: '' };

/** The kinds a component serves: its own, then the others it can be used as. */
export function kindsOf(item: Pick<LibraryItem, 'kind' | 'kinds'>): string[] {
  return [item.kind, ...(item.kinds ?? []).filter((k) => k !== item.kind)];
}

/** The items the filter keeps (a kind filter keeps a component that can also be used as that kind). */
export function filterItems<T extends Pick<LibraryItem, 'component' | 'kind' | 'kinds' | 'source' | 'untrusted'>>(items: readonly T[], f: LibraryFilter): T[] {
  const words = f.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => {
    if (f.kind !== 'all' && !kindsOf(i).includes(f.kind)) return false;
    if (f.source !== 'all' && i.source !== f.source) return false;
    if (!words.length) return true;
    const hay = `${i.component} ${i.untrusted.name} ${i.untrusted.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * One section per kind in KIND_ORDER (a component under its own kind; with a kind filter, every kept item under that
 * kind), then any other kind the server named, empty sections left out.
 */
export function groupByKind<T extends Pick<LibraryItem, 'kind'>>(items: readonly T[], kindFilter = 'all'): Array<{ kind: string; items: T[] }> {
  const by = new Map<string, T[]>();
  for (const i of items) {
    const k = kindFilter !== 'all' ? kindFilter : i.kind;
    let list = by.get(k);
    if (!list) by.set(k, (list = []));
    list.push(i);
  }
  const order = [...KIND_ORDER, ...[...by.keys()].filter((k) => !isKind(k)).sort()];
  return order.filter((k) => by.has(k)).map((k) => ({ kind: k, items: by.get(k)! }));
}

/** Components per kind (a component counts under every kind it serves), for the kind filter's labels. */
export function kindCounts(items: readonly Pick<LibraryItem, 'kind' | 'kinds'>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) for (const k of kindsOf(i)) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/**
 * The kind filter's labels for what the other filters (source, words) keep: a chip counts what choosing it shows, so
 * "Intros (4)" is what the Intros filter lists — the components of that kind plus those that can also serve as one.
 */
export function filterCounts<T extends Pick<LibraryItem, 'component' | 'kind' | 'kinds' | 'source' | 'untrusted'>>(items: readonly T[], f: LibraryFilter): { all: number; kinds: Record<string, number> } {
  const kept = filterItems(items, { ...f, kind: 'all' });
  return { all: kept.length, kinds: kindCounts(kept) };
}

/**
 * The All view's section of a kind lists only the components of that kind: how many kept items of another kind can also
 * serve as it (they appear under the kind filter). Section size + this = the kind's chip count.
 */
export function alsoServing(items: readonly Pick<LibraryItem, 'kind' | 'kinds'>[], kind: string): number {
  return items.filter((i) => i.kind !== kind && kindsOf(i).includes(kind)).length;
}

/** The section's pointer to them (a button that picks the kind filter). */
export const alsoServingWords = (n: number): string => `+ ${n} more that can also serve here`;

export const kindHeading = (k: string, n = 2): string => (isKind(k) ? KIND_WORDS[k][n === 1 ? 0 : 1] : k);

/** The source badge: a word (never colour alone) and what it means. Never "made with Claude": nobody can tell. */
export const SOURCE_WORDS: Record<LibraryItem['source'], { badge: string; title: string }> = {
  builtin: { badge: 'Built-in', title: `Ships with ${APP_NAME}.` },
  workspace: { badge: 'Workspace', title: "Made in this workspace's components folder (by you or with Claude). Its code runs only in the render browser, never in the Studio." },
};

/** What a card's poster box says when it shows no picture (null: the picture is there, or loading it is not said). */
export function posterWords(p: LibraryItem['poster'], o: { asked?: 'asked' | 'ended' } = {}): string | null {
  if (p.queued) return 'Waiting for the worker…';
  if (p.state === 'failed') return 'The poster could not be rendered';
  if (p.state === 'missing') return o.asked === 'ended' ? 'Not rendered: the job ended without it' : o.asked === 'asked' ? 'Rendering asked…' : 'Not rendered yet';
  return null;
}

/** What a card says about its loop (null: nothing to say — it plays, or Play is the only thing to do). */
export function loopWords(l: LibraryItem['loop'], playing: boolean, o: { asked?: 'asked' | 'ended' } = {}): string | null {
  if (l.state === 'too_large') return 'Too large to loop: only the poster';
  if (l.state === 'failed') return 'The loop could not be rendered';
  if (!playing) return null;
  if (l.queued) return 'Rendering the loop: waiting for the worker…';
  if (l.state === 'missing') return o.asked === 'ended' ? 'Not rendered: the job ended without it' : 'Rendering the loop…';
  return null;
}

/** Whether Play can do anything (a loop too large to keep, or failed, cannot play until a Retry). */
export const canPlay = (l: LibraryItem['loop']): boolean => l.state === 'cached' || l.state === 'missing';

/** The `alt` of a card's picture, from checked words only (the id, the theme name), never the manifest's name. */
export function pictureAlt(component: string, theme: string, kind: 'poster' | 'loop'): string {
  return `${component} in ${theme}, ${kind === 'poster' ? 'still' : 'looping'}`;
}

/**
 * Whether an event re-reads the library: a theme or a component changed (any: every theme's picks show), the project's
 * files (project.yaml names its theme), a reconnection; a job change only while previews of this library are queued
 * or asked (`busy`) — a capture's progress re-reads nothing.
 */
export function libraryEventAction(e: StudioEvent, slug: string, o: { busy: boolean }): boolean {
  if (e.type === 'resync') return true;
  if (e.type === 'jobs') return o.busy;
  if (e.type !== 'workspace') return false;
  return (Array.isArray(e.themes) && e.themes.length > 0) || (Array.isArray(e.components) && e.components.length > 0) || (Array.isArray(e.projects) && e.projects.includes(slug));
}

/** theme_edit's `set_component` edit (its input's), as the Library sets a default: a component always, its params dropped. */
export type SetComponentEdit = Extract<ThemeEditInput, { kind: 'set_component' }> & { readonly id: string; readonly params: 'drop' };

export type SetDefaultPlan =
  | { edit: SetComponentEdit; replaces: string | null; drops: string[] }
  | { already: true }
  | { copy: string }
  | { why: string };

/**
 * "Set as theme default" of component `id` as `kind` in a theme (its theme_view): one `set_component` (the old entry's
 * params dropped — they were the old component's), `from` what the view shows written there; a starter or read-only
 * theme → `copy` (the why: copy it first); a kind written as the theme's own file or in another form → why (by hand).
 */
export function setDefaultPlan(view: Pick<ThemeEditView, 'editable' | 'components'>, kind: string, id: string): SetDefaultPlan {
  if (!okId(id)) return { why: 'not a component id' };
  if (!isKind(kind)) return { why: `${kind} is not a kind a theme picks` };
  const c = (view.components as Partial<ThemeEditView['components']>)[kind];
  if (c && c.resolved?.id === id && c.written !== 'file' && c.written !== 'other') return { already: true };
  if (view.editable !== true) return { copy: view.editable.why };
  if (!c) return { why: `the theme has no ${kind} entry the Studio can read` };
  if (c.written === 'file') return { why: `the theme's ${kind} is its own file (a video, image or Lottie): replace it in template.yaml by hand` };
  if (c.written === 'other') return { why: `the theme's ${kind} is written in a form the Studio does not change: edit template.yaml by hand` };
  const from = c.written === 'absent' ? undefined : c.written === 'none' ? null : (c.id ?? undefined);
  return {
    edit: { kind: 'set_component', component: kind, ...(from !== undefined ? { from } : {}), id, params: 'drop' },
    replaces: c.resolved?.id ?? null,
    drops: c.params ? Object.keys(c.params) : [],
  };
}

/** The longest "-copy-<n>" a proposed name ends in ("-copy-999"). */
const COPY_TAIL = 9;

/**
 * A free theme name for the copy of `theme` ("<theme>-copy", "-copy-2"…), within the rules of a new theme's name: the
 * source is any listed theme (up to 100 characters, capitals and "_" lowered and dashed), cut so that the proposal
 * never passes NEW_THEME_NAME_MAX.
 */
export function copyName(theme: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  // The SOURCE is tested as a listed theme and by the lower-case grammar only, never by the new name's cap: a theme
  // of 80 characters is a fine source, its copy's name is cut.
  const lowered = okTheme(theme) ? theme.toLowerCase().replace(/_/g, '-') : '';
  const base = (NEW_THEME_NAME.test(lowered) ? lowered : 'theme').slice(0, NEW_THEME_NAME_MAX - COPY_TAIL);
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${base}-copy` : `${base}-copy-${n}`;
    if (!names.has(name)) return name;
  }
  return `${base}-copy-x`;
}

/** What a form says of a new theme's name that passes the grammar and is too long. */
export const NEW_THEME_TOO_LONG = `At most ${NEW_THEME_NAME_MAX} characters.`;
/**
 * What every field that takes a new theme's name says under it, before anything is typed: the field stops at the
 * limit, so the rule is said where it is met (the kit ties a hint to its field for assistive technology).
 */
export const NEW_THEME_NAME_HINT = `Lower-case letters, digits and "-", at most ${NEW_THEME_NAME_MAX} characters.`;

/** Why a new theme name cannot be used (null: it can). */
export function themeNameProblem(name: string, taken: Iterable<string>): string | null {
  if (!name) return 'Give the copy a name.';
  if (!NEW_THEME_NAME.test(name)) return 'Lower-case letters, digits and "-" only, starting with a letter or a digit.';
  if (!okNewThemeName(name)) return NEW_THEME_TOO_LONG;
  if (new Set(taken).has(name)) return 'A theme of that name exists.';
  return null;
}

/** Why a new component id cannot be used (null: it can): the id pattern, not the built-in namespace, not taken. */
export function idProblem(id: string, taken: Iterable<string>): string | null {
  if (!id) return 'Give it an id: namespace/name.';
  if (!okId(id)) return 'An id is "namespace/name": lower-case letters, digits and "-" on each side.';
  if (id.startsWith('studio/')) return 'studio/ is the built-in namespace: use your own (your team or brand).';
  if (new Set(taken).has(id)) return 'A component of that id exists.';
  return null;
}

/** Longest description carried into the prompt (characters). */
export const PROMPT_WORDS_MAX = 600;

/**
 * Characters never kept in the prompt (review A L1): controls, every format character (`\p{Cf}`: direction marks and
 * overrides, zero widths, the invisible tag characters U+E0000 to U+E007F that smuggle hidden text), line / paragraph
 * separators, variation selectors, the combining grapheme joiner and the Hangul fillers (blank-looking letters).
 */
const PROMPT_HIDDEN = /[\p{Cc}\p{Cf}\u2028-\u202e\u2060-\u206f\u{E0000}-\u{E007F}\ufe00-\ufe0f\u{E0100}-\u{E01EF}\u034f\u115f\u1160\u3164\uffa0]/gu;

/**
 * The person's words as they go into the prompt: hidden characters removed (PROMPT_HIDDEN: a pasted right-to-left
 * override would reorder what Claude reads, tag characters would carry words nobody sees), line breaks and runs of
 * spaces made one space, double quotes made single (the prompt quotes the words), capped.
 */
export function cleanWords(text: string): string {
  const out = text
    .replace(PROMPT_HIDDEN, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > PROMPT_WORDS_MAX ? `${out.slice(0, PROMPT_WORDS_MAX)}…` : out;
}

export interface PromptInput {
  kind: string;
  id: string;
  /** The project (the route's slug: used only when it matches the slug pattern). */
  project: string;
  /** The theme the library shows (used only when it matches the name pattern). */
  theme?: string;
  /** The person's words. */
  description: string;
  /** A component to start from (an id: used only when it matches). */
  like?: string;
}

/**
 * The "Create with Claude" text for Claude Code's component skill, and the scaffold command for a terminal — null when
 * the kind or the id does not pass. Only checked names and the person's cleaned words: no manifest text, ever.
 */
export function createPrompt(p: PromptInput): { prompt: string; command: string } | null {
  if (!isKind(p.kind) || !okId(p.id) || p.id.startsWith('studio/')) return null;
  const words = cleanWords(p.description);
  const parts = [`Use the retake-component skill to make a new ${p.kind} component \`${p.id}\``];
  if (okName(p.project)) parts.push(` for project \`${p.project}\``);
  if (p.like !== undefined && okId(p.like)) parts.push(`, starting from \`${p.like}\``);
  parts.push(words ? `. What it should do, in my words: "${words}".` : '.');
  parts.push(" It is a workspace component (this workspace's components folder), not a built-in.");
  parts.push(` Preview it${p.theme !== undefined && okTheme(p.theme) ? ` in theme \`${p.theme}\`` : ''} with component_preview and validate it with component_validate; ask me before you edit its code.`);
  return { prompt: parts.join(''), command: `retake components create ${p.id} --kind ${p.kind}` };
}

/** "Set the card of mine to acme/x", worded for the confirmation. */
export function setDefaultWords(theme: string, kind: string, id: string, plan: Extract<SetDefaultPlan, { edit: unknown }>): string {
  const what = isKind(kind) ? KIND_WORDS[kind][0].toLowerCase() : kind;
  let s = `Make ${id} the ${what} of ${theme}`;
  s += plan.replaces ? ` (instead of ${plan.replaces}).` : '.';
  if (plan.drops.length) s += ` The params written for the old ${what} (${plan.drops.slice(0, 8).join(', ')}) are dropped.`;
  return s;
}
