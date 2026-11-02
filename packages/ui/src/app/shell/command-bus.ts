/**
 * L5.11a: the shell's command bus for the Scenario menu's commands (Rehearse ⌘R, Capture ⇧⌘R, Render ⌘B, Stop ⌘.; the
 * palette's Scenario group) — whoever owns a command acts on it. Ownership is by explicit priority, never by the order
 * React ran effects in (critique H1: on a fresh load a screen's effect runs before the status bar's, so "the newest
 * wins" handed ⌘. to the defaults after a reload of a terminal's live run or of a live recording): the status bar's
 * defaults 0, a screen 10 (Prepare, the live screen), a live recording 20; a tie goes to the latest registration. The
 * handler is held in a ref: a new function at each render neither re-registers nor reorders anything. One owner acts —
 * there is one Stop at a time.
 */
import { useEffect, useRef } from 'react';
import type { IconName } from '../ui-kit/index.js';

export type ShellCommand = 'rehearse' | 'capture' | 'render' | 'stop';
export const SHELL_COMMANDS: readonly ShellCommand[] = ['rehearse', 'capture', 'render', 'stop'];

/** Who outranks whom. */
export const PRIORITY = { defaults: 0, screen: 10, recording: 20 } as const;

interface Registration {
  id: ShellCommand;
  priority: number;
  order: number;
  handler: { current: () => void };
}

const registry = new Set<Registration>();
let order = 0;

export function isShellCommand(id: unknown): id is ShellCommand {
  return typeof id === 'string' && (SHELL_COMMANDS as readonly string[]).includes(id);
}

function owner(id: ShellCommand): Registration | null {
  let best: Registration | null = null;
  for (const r of registry) {
    if (r.id !== id) continue;
    if (!best || r.priority > best.priority || (r.priority === best.priority && r.order > best.order)) best = r;
  }
  return best;
}

/** The registration that acts on `id` now: the highest priority, then the latest. */
export function ownerOf(id: ShellCommand): { priority: number } | null {
  const o = owner(id);
  return o ? { priority: o.priority } : null;
}

/** Run `id` through its owner; false when nobody owns it. */
export function runShellCommand(id: ShellCommand): boolean {
  const o = owner(id);
  if (!o) return false;
  o.handler.current();
  return true;
}

/** Own `id` at `priority` (the handler read at each run); returns the release. The hook below is the screens' way. */
export function registerShellCommand(id: ShellCommand, handler: { current: () => void }, priority: number): () => void {
  const r: Registration = { id, priority, order: ++order, handler };
  registry.add(r);
  return () => {
    registry.delete(r);
  };
}

/** Own `id` at `priority` while mounted and `enabled` (the latest `handler` acts). */
export function useShellCommand(id: ShellCommand, handler: () => void, priority: number, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => (enabled ? registerShellCommand(id, ref, priority) : undefined), [id, priority, enabled]);
}

/**
 * L5.11b fixes (review A-M2 / A-L1): a screen whose commands are not the scenario's — a live recording — gives the ⌘K
 * palette's commands its own entries while it owns them ("Stop recording · <recording>", "Discard…"), in place of
 * Rehearse / Capture / Render / Stop of the scenario remembered in context (never named there).
 * L5.12b (R4-Palette): generalised to the palette's screen groups (`paletteGroup`) — a screen registers entries under a
 * slot while it is mounted: `scenario` (the recording's commands, above), `scenes` (the Scenario screen's and Edit's
 * scenes: a pick, a seek), `review` (Review › Comments' "Comment at this frame"), `report` (the Review report entry with
 * the last render's words, from a screen that holds the renders), `themes` (the theme set for the scenario shown). One
 * screen per slot: the latest mounted wins; null gives the slot back. An entry only goes somewhere or selects something:
 * the palette never writes (a test counts the ops a palette entry sends).
 */
export interface ScreenCommand {
  id: string;
  label: string;
  hint?: string;
  /** The row's icon (a kit icon name: decorative, the label names the row). */
  icon?: IconName;
  run: () => void;
}

export type PaletteSlot = 'scenario' | 'scenes' | 'review' | 'report' | 'themes';

const groups = new Map<PaletteSlot, ScreenCommand[]>();
let groupVersion = 0;
const groupListeners = new Set<() => void>();

export const paletteGroup = {
  subscribe(fn: () => void): () => void {
    groupListeners.add(fn);
    return () => {
      groupListeners.delete(fn);
    };
  },
  get(slot: PaletteSlot): ScreenCommand[] | null {
    return groups.get(slot) ?? null;
  },
  version(): number {
    return groupVersion;
  },
};

function setGroup(slot: PaletteSlot, next: ScreenCommand[] | null): void {
  if (next) groups.set(slot, next);
  else groups.delete(slot);
  groupVersion++;
  for (const fn of groupListeners) fn();
}

/** The palette's `slot` group while mounted with `commands` (null: none from this screen); each run reads the latest. */
export function usePaletteGroup(slot: PaletteSlot, commands: ScreenCommand[] | null): void {
  const ref = useRef(commands);
  ref.current = commands;
  // The entries' words (ids, labels, hints, icons) decide a new group; their handlers are read at each run.
  const words = commands ? JSON.stringify(commands.map((c) => [c.id, c.label, c.hint ?? '', c.icon ?? ''])) : null;
  useEffect(() => {
    if (words === null) return undefined;
    const ids = (JSON.parse(words) as Array<[string, string, string, string]>).map(([id, label, hint, icon]) => ({
      id,
      label,
      ...(hint ? { hint } : {}),
      ...(icon ? { icon: icon as IconName } : {}),
      run: () => ref.current?.find((c) => c.id === id)?.run(),
    }));
    setGroup(slot, ids);
    return () => {
      if (groups.get(slot) === ids) setGroup(slot, null);
    };
  }, [slot, words]);
}

/** The palette's commands while mounted with `commands` (null: the scenario's Rehearse, Capture, Render, Stop). */
export function useScenarioGroup(commands: ScreenCommand[] | null): void {
  usePaletteGroup('scenario', commands);
}
