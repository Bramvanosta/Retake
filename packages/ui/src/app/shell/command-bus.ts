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
