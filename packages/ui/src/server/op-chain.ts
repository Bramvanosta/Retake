/** The Studio server's op chains: writes of one key run one at a time in this server. */
import { keyChain } from '@retake/engine';
import type { KeyChain } from '@retake/engine';

/** Runs `fn` after every earlier call of the same key has settled (its outcome ignored): one at a time per key. */
export type OpChain = KeyChain;

/**
 * A chain of calls per key (a double click, two tabs): each call of a key waits for the previous one, so the second
 * finds the first one's result (a new hash: its 409). The Studio passes ONE chain to scenario_edit, scenario_render and
 * thread_apply, keyed by scenarioKey — an apply, an edit and a render submit of one scenario never interleave in this
 * server (the engine's own admission rules chain a submit and its check apart from this one).
 */
export function opChain(): OpChain {
  return keyChain();
}

/** The key of a scenario in the shared chain (scenario_edit, scenario_render, thread_apply). */
export const scenarioKey = (project: string, name: string): string => `${project}\0${name}`;
