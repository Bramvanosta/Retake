/**
 * L5.9: the shell's mode switch over today's routes (DESIGN §4k). Script = the scenario (blocks; YAML is the screen's own
 * view), Shoot = its Run screen (and Record), Edit = its timeline (and a proposal's preview), Review = its frame
 * comments. "A scenario in context": the route's own, or — on a route of its project (overview, README, components,
 * themes, Record) — the last scenario this tab opened in that project, while the project still has it. With none, the
 * four are shown disabled.
 */
import type { Route } from '../route.js';

export type Mode = 'script' | 'shoot' | 'edit' | 'review';
export const MODES: Array<{ mode: Mode; label: string }> = [
  { mode: 'script', label: 'Script' },
  { mode: 'shoot', label: 'Shoot' },
  { mode: 'edit', label: 'Edit' },
  { mode: 'review', label: 'Review' },
];

export interface ScenarioContext {
  slug: string;
  scenario: string;
}

/** The last scenario opened per project in this tab. */
const lastScenario = new Map<string, string>();
/** L5.10a: a production selected on the Project screen becomes the scenario in context (the modes act on it). */
let version = 0;
const watchers = new Set<() => void>();
export function rememberScenario(slug: string, scenario: string): void {
  if (lastScenario.get(slug) === scenario) return;
  lastScenario.set(slug, scenario);
  version++;
  for (const w of [...watchers]) w();
}
/** Re-renders the caller when a remembered scenario changes (useSyncExternalStore's subscribe / snapshot). */
export const contextWatch = {
  subscribe(fn: () => void): () => void {
    watchers.add(fn);
    return () => watchers.delete(fn);
  },
  version: () => version,
};

/** The project a route belongs to, or null. */
export function slugOf(route: Route): string | null {
  return 'slug' in route ? route.slug : null;
}

/** The route's own scenario, or null. */
export function ownScenario(route: Route): ScenarioContext | null {
  return 'scenario' in route ? { slug: route.slug, scenario: route.scenario } : null;
}

/**
 * Remember the route's scenario; answer the scenario in context (the route's own or its project's last one). `known`:
 * the project's scenarios as the workspace lists them now — a remembered one no longer there (deleted, renamed) is
 * forgotten, never offered to the modes (review B-L8).
 */
export function scenarioInContext(route: Route, memory = lastScenario, known?: readonly string[]): ScenarioContext | null {
  const own = ownScenario(route);
  if (own) {
    memory.set(own.slug, own.scenario);
    return own;
  }
  const slug = slugOf(route);
  const last = slug !== null ? memory.get(slug) : undefined;
  if (slug === null || last === undefined) return null;
  if (known && !known.includes(last)) {
    memory.delete(slug);
    return null;
  }
  return { slug, scenario: last };
}

/** The mode the route is in, or null (a project-level screen, the projects, the gallery). */
export function modeOf(route: Route, ctx: ScenarioContext | null): Mode | null {
  switch (route.name) {
    case 'scenario':
      return 'script';
    case 'run':
      return 'shoot';
    case 'record':
      return ctx ? 'shoot' : null;
    case 'timeline':
    case 'proposal':
      return 'edit';
    case 'comments':
      return 'review';
    default:
      return null;
  }
}

/** Where a mode goes for a scenario. */
export function modeTarget(mode: Mode, ctx: ScenarioContext): Route {
  switch (mode) {
    case 'script':
      return { name: 'scenario', slug: ctx.slug, scenario: ctx.scenario, tab: 'blocks' };
    case 'shoot':
      return { name: 'run', slug: ctx.slug, scenario: ctx.scenario };
    case 'edit':
      return { name: 'timeline', slug: ctx.slug, scenario: ctx.scenario };
    case 'review':
      return { name: 'comments', slug: ctx.slug, scenario: ctx.scenario };
  }
}

/** The screen's identity: the centre pane scrolls back to the top only when it changes (critique M2) — never on a
 * thread, a frame address, a run or a theme picked inside the same screen. */
export function screenKey(route: Route): string {
  return `${route.name}|${slugOf(route) ?? ''}|${'scenario' in route ? route.scenario : ''}`;
}
