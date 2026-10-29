/**
 * The preview frame's one piece of shared state (L5.2): what the Player shows — set by the protocol handlers
 * (frame-main.tsx `load`, `rate`, `clear`), read by the React tree with `useSyncExternalStore`. Browser-safe, no
 * dependency.
 *
 * Why a store: a value set before anything subscribed is kept, never dropped. The frame says hello from its window's
 * load event, which WebKit fires before React's first render of the frame has run its effects; the Studio answers
 * `load` at once, and a plan mounted in that gap was lost when the tree took its setter in an effect — the Player never
 * mounted, no `<video>` asked for the capture and the page stayed on "Loading the preview…" (the desktop shell's
 * acceptance, ~half its runs). `useSyncExternalStore` reads the value again once it has subscribed.
 */
export interface Latest<T> {
  get(): T;
  set(value: T): void;
  /** `listener` runs after each `set`; the returned function unsubscribes it. */
  subscribe(listener: () => void): () => void;
}

export function latest<T>(initial: T): Latest<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      value = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
