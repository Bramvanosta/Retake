/**
 * Named hooks (L5.8, R-FLD-31): `hooks:` of a scenario or project.yaml — name → one hook entry or a list of them — and
 * the `hook: <name>` steps that run them during a take. A scenario's name wins over project.yaml's. Each entry runs
 * under the hook's name unless it has its own (logs, journals, approvals).
 */
import type { HookStep, NamedHooks, Scenario, Scene } from './types.js';
import { isCaptureScene } from './types.js';

export interface ResolvedNamedHook {
  name: string;
  /** Where it is declared: the scenario's `hooks:` or project.yaml's. */
  source: 'scenario' | 'project';
  /** Its entries, in order, each named (its own name, else the hook's). */
  hooks: HookStep[];
}

/** The name a `hook` step runs (its string or `{name}`), or undefined when the step is not one. */
export function hookStepName(step: unknown): string | undefined {
  if (!step || typeof step !== 'object') return undefined;
  const v = (step as { hook?: unknown }).hook;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') return (v as { name: string }).name;
  return undefined;
}

/** A named hook's entries, each with a name: its own, else the hook's. */
export function namedHookEntries(name: string, v: HookStep | HookStep[]): HookStep[] {
  return (Array.isArray(v) ? v : [v]).map((h) => ({ ...h, name: h.name ?? name }));
}

/** The hook `name` resolves to for a scenario: its own `hooks:` first, then project.yaml's; undefined when neither has it. */
export function resolveNamedHook(name: string, sc: Pick<Scenario, 'hooks'>, project?: { config: { hooks?: NamedHooks } }): ResolvedNamedHook | undefined {
  const own = sc.hooks && Object.hasOwn(sc.hooks, name) ? sc.hooks[name] : undefined;
  if (own !== undefined) return { name, source: 'scenario', hooks: namedHookEntries(name, own) };
  const shared = project?.config.hooks && Object.hasOwn(project.config.hooks, name) ? project.config.hooks[name] : undefined;
  if (shared !== undefined) return { name, source: 'project', hooks: namedHookEntries(name, shared) };
  return undefined;
}

/** The names the `hook:` steps of a scenario's capture scenes run (skipped scenes left out), in first-use order. */
export function hookStepNames(sc: Pick<Scenario, 'scenes'>): string[] {
  const out = new Set<string>();
  for (const entry of sc.scenes ?? []) {
    if (!isCaptureScene(entry) || (entry as Scene).skip) continue;
    for (const step of (entry as Scene).steps ?? []) {
      const name = hookStepName(step);
      if (name !== undefined) out.add(name);
    }
  }
  return [...out];
}

/** Every named hook a scenario's steps run, resolved (a name neither file declares is left out: validation reports it). */
export function usedNamedHooks(sc: Pick<Scenario, 'scenes' | 'hooks'>, project?: { config: { hooks?: NamedHooks } }): ResolvedNamedHook[] {
  return hookStepNames(sc)
    .map((n) => resolveNamedHook(n, sc, project))
    .filter((h): h is ResolvedNamedHook => h !== undefined);
}

/** The hook entries of a scenario's steps, flattened: what its take may run besides setup and teardown. */
export function stepHookList(sc: Pick<Scenario, 'scenes' | 'hooks'>, project?: { config: { hooks?: NamedHooks } }): HookStep[] {
  return usedNamedHooks(sc, project).flatMap((h) => h.hooks);
}
