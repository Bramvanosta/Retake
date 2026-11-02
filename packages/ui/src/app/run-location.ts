/**
 * L5.11a: the location a scenario's runs use — ONE choice per scenario in this tab, shared by the Scenario screen's
 * Location (Script), Prepare's (Shoot) and the status bar's actions; never stored (a reload goes back to the file's
 * own: BL-129). A choice equal to the file's own is no choice (`env` is sent only when it differs: critique M1 of
 * L5.10b). A remembered location project.yaml no longer has is dropped once the project is read (review A M1 of L5.10b)
 * and its notice kept until a screen shows it (critique M2: the status bar says it on a route whose screen does not).
 */
import { useEffect, useSyncExternalStore } from 'react';

const chosen = new Map<string, string>();
const dropped = new Map<string, string>();
let version = 0;
const watchers = new Set<() => void>();
const bump = () => {
  version++;
  for (const w of [...watchers]) w();
};
const subscribe = (fn: () => void) => {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
};
const snapshot = () => version;

export const locationKey = (slug: string, name: string) => `${slug}\0${name}`;

/** The tab's choice for a scenario (undefined: the file's own). */
export function chosenLocation(slug: string, name: string): string | undefined {
  return chosen.get(locationKey(slug, name));
}

/** Choose a location (the file's own, or undefined: no choice); a pending "dropped" notice goes with it. */
export function chooseLocation(slug: string, name: string, env: string | undefined): void {
  const k = locationKey(slug, name);
  if (env === undefined) chosen.delete(k);
  else chosen.set(k, env);
  dropped.delete(k);
  bump();
}

/** A dropped location's name, until a screen shows it (`takeDropped`) or a location is chosen. */
export function droppedLocation(slug: string, name: string): string | undefined {
  return dropped.get(locationKey(slug, name));
}

/** Read and forget a dropped location's notice (the status bar, once it said it). */
export function takeDropped(slug: string, name: string): string | undefined {
  const k = locationKey(slug, name);
  const d = dropped.get(k);
  if (d !== undefined) {
    dropped.delete(k);
    bump();
  }
  return d;
}

/**
 * The location to send for a scenario: the tab's choice when the project has it (undefined: the file's own). `envs`:
 * the project's environments, null while project_get is not read — then `ready` is false and no action may start
 * (critique M2: a start before the read would send a location that may be gone).
 */
export function useRunLocation(slug: string | null, name: string | null, envs: readonly { name: string }[] | null): { sent: string | undefined; ready: boolean; dropped: string | undefined } {
  useSyncExternalStore(subscribe, snapshot);
  const k = slug !== null && name !== null ? locationKey(slug, name) : null;
  const env = k ? chosen.get(k) : undefined;
  const stale = env !== undefined && envs !== null && !envs.some((e) => e.name === env);
  useEffect(() => {
    if (!k || !stale || env === undefined) return;
    chosen.delete(k);
    dropped.set(k, env);
    bump();
  }, [k, stale, env]);
  return { sent: stale ? undefined : env, ready: envs !== null, dropped: k ? dropped.get(k) : undefined };
}
