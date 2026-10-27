/** The Studio server's op chains (L4.2 – L4.6): writes of one key run one at a time in this server. */

/** Runs `fn` after every earlier call of the same key has settled (its outcome ignored): one at a time per key. */
export type OpChain = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/**
 * A chain of calls per key (a double click, two tabs): each call of a key waits for the previous one, so the second
 * finds the first one's result (a new hash: its 409). L4.6 (critique B5): the Studio passes ONE chain to scenario_edit,
 * scenario_render and thread_apply, keyed by scenarioKey — an apply, an edit and a render submit of one scenario never
 * interleave in this server.
 */
export function opChain(): OpChain {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return next;
  };
}

/** The key of a scenario in the shared chain (scenario_edit, scenario_render, thread_apply). */
export const scenarioKey = (project: string, name: string): string => `${project}\0${name}`;
