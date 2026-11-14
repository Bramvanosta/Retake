/**
 * L5.11a: the words of Shoot — the status bar's state (a shape AND a word for each), a blocker's short words keyed on
 * the gate that refused (`kind`, critique H3: never the generic `code`, which cannot tell agent trust from a protected
 * host), and the mode's names. "Rehearse" is the Studio's word for a dry run (`retake run … --dry`, MCP `run_dry`):
 * the engine's own text may still say "dry run" (shared with the CLI and MCP) and is shown only in details, beside one
 * mapping line (critique M6).
 */
import type { RunBlocker } from '@retake/engine';
import type { MarkState } from '../ui-kit/index.js';

/** A persona's stored session in words, and its shape (L4.4's words; the Cast, Prepare's sessions, the browser). */
export const STORED_WORDS: Record<string, [string, MarkState]> = {
  valid: ['valid', 'ok'],
  expired: ['expired', 'fail'],
  error: ['last check failed', 'fail'],
  never: ['never signed in', 'warn'],
  unchecked: ['saved, never checked', 'idle'],
};

/** The mapping line Prepare shows once: the engine's and the terminal's words for a rehearsal. */
export const REHEARSE_MAPPING = 'Rehearse = a dry run: retake run … --dry in a terminal, run_dry for Claude.';

/** A run's mode in words: "Rehearsal" / "Capture" (`lower`: inside a sentence). */
export function modeWord(mode: string, lower = false): string {
  const w = mode === 'dry' ? 'Rehearsal' : 'Capture';
  return lower ? w.toLowerCase() : w;
}

/** A blocker in the status bar's few words, and the one action that unblocks it. */
export interface BlockerShort {
  words: string;
  /** `copy`: Copy command (its `fix`); `yaml`: Open the YAML (the file has errors); null: nothing to do here. */
  action: 'copy' | 'yaml' | null;
}

const hooks = (n: number | undefined, what: string) => (n === undefined ? `hooks ${what}` : `${n} hook${n === 1 ? '' : 's'} ${what}`);

/** Short words by the gate that refused; an unknown kind gets an honest fallback, never another gate's reason. */
export function blockerShort(b: Pick<RunBlocker, 'kind' | 'count' | 'fix' | 'fix_file'>): BlockerShort {
  const copy = b.fix ? 'copy' : null;
  switch (b.kind) {
    case 'needs_approval':
      return { words: hooks(b.count, 'to approve'), action: copy };
    case 'too_long':
      return { words: hooks(b.count, 'too long to approve here'), action: copy };
    case 'protected_host':
      return { words: 'protected location', action: copy };
    case 'agent_trust':
      return { words: 'uses a secret or an outside file', action: copy };
    case 'opens_other_site':
      return { words: 'opens another site · add it to project.yaml', action: copy };
    case 'hook_refused':
      return { words: hooks(b.count, 'refused'), action: copy };
    case 'read_only':
      return { words: 'read-only location refuses its hooks', action: copy };
    case 'invalid':
      return b.fix_file ? { words: 'the file has errors', action: 'yaml' } : { words: 'does not check', action: copy };
    default:
      return { words: 'needs the terminal', action: copy };
  }
}

/** The status bar's state of the scenario in context. */
export type ShootState = 'idle' | 'queued' | 'running' | 'paused' | 'stopping' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';

/** Every state: its shape and its word (M15: a pure table, each one said). */
export const SHOOT_STATES: Record<ShootState, { mark: MarkState; word: (mode: string) => string }> = {
  idle: { mark: 'idle', word: () => 'Idle' },
  queued: { mark: 'waiting', word: (m) => `${modeWord(m)} queued` },
  running: { mark: 'running', word: (m) => (m === 'dry' ? 'Rehearsing' : 'Capturing') },
  paused: { mark: 'warn', word: (m) => `${modeWord(m)} paused` },
  stopping: { mark: 'warn', word: (m) => `${modeWord(m)} stopping` },
  succeeded: { mark: 'ok', word: () => 'Last take succeeded' },
  failed: { mark: 'fail', word: () => 'Last take failed' },
  cancelled: { mark: 'warn', word: () => 'Last take stopped' },
  interrupted: { mark: 'fail', word: () => 'Last take interrupted' },
  unknown: { mark: 'idle', word: () => 'Last take: outcome unknown' },
};

/** The state of a run as the status bar says it (finished runs by their status). */
export function shootState(r: { status: string; paused?: boolean; stopping?: boolean } | null): ShootState {
  if (!r) return 'idle';
  if (r.status === 'queued') return r.stopping ? 'stopping' : 'queued';
  if (r.status === 'running') return r.stopping ? 'stopping' : r.paused ? 'paused' : 'running';
  return r.status in SHOOT_STATES ? (r.status as ShootState) : 'unknown';
}
