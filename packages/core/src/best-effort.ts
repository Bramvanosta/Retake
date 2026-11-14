/**
 * Work whose failure is not worth reporting, said so where it is done: `bestEffort(p, why)` is `p`, or `fallback`
 * (undefined by default) when it rejects. `why` names the reason the failure can be dropped — written for the reader
 * and greppable (`bestEffort(`), so a swallowed rejection is never silent by accident. A failure that hides something
 * a person needs to know is not best effort: it is logged or reported instead.
 */
export function bestEffort<T>(p: PromiseLike<T>, why: string): Promise<T | undefined>;
export function bestEffort<T, F>(p: PromiseLike<T>, why: string, fallback: F): Promise<T | F>;
export function bestEffort<T, F>(p: PromiseLike<T>, _why: string, fallback?: F): Promise<T | F | undefined> {
  return Promise.resolve(p).catch(() => fallback);
}
