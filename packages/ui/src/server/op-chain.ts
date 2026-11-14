/** The Studio server's op chains: writes of one key run one at a time in this server. */
import { opChain as engineOpChain } from '@retake/engine';
import type { OpChain } from '@retake/engine';

/** Runs `fn` after every earlier call of the same key has settled (its outcome ignored): one at a time per key. */
export type { OpChain } from '@retake/engine';

/**
 * A chain of calls per key (a double click, two tabs): each call of a key waits for the previous one, so the second
 * finds the first one's result (a new hash: its 409). The Studio passes ONE chain to scenario_edit, thread_apply and
 * record_save, keyed by scenarioKey — since L7.15 the engine's operation chain (`operationChain(engine)`), which
 * scenario_render (the engine's operation) runs on by its `serialize`: an apply, an edit and a render submit of one
 * scenario never interleave in this server (the engine's own admission rules chain a submit and its check apart from
 * this one). A chain of its own is for stand-ins that never run an op (tests).
 */
export function opChain(): OpChain {
  return engineOpChain();
}

/** The key of a scenario in the shared chain (scenario_edit, scenario_render, thread_apply, record_save): the engine's. */
export { scenarioKey } from '@retake/engine/contract';
