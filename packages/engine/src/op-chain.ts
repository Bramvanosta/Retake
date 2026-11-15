/** One call at a time per key: what the admission checks, the queues' locks and the append logs order their calls by. */
import { bestEffort } from '@retake/core/base';

/** Runs `fn` after every earlier call of the same key has settled (its outcome ignored): one at a time per key. */
export type OpChain = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

/** A chain of calls per key (two tabs, a double click, two calls of a client at once): the second finds the first's result. */
export function opChain(): OpChain {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = bestEffort(chains.get(key) ?? Promise.resolve(), "the previous call's failure is its own caller's: the chain only orders the calls").then(fn);
    const tail = bestEffort(next, "the chain's tail never rejects: the caller gets the failure from `next`");
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return next;
  };
}
