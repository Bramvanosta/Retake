/**
 * The Studio front end's `bestEffort` (core base's, written again here: the front end imports types only from other
 * packages): `p`, or `fallback` when it rejects, with the reason the failure can be dropped written where it is done.
 */
export function bestEffort<T>(p: PromiseLike<T>, why: string): Promise<T | undefined>;
export function bestEffort<T, F>(p: PromiseLike<T>, why: string, fallback: F): Promise<T | F>;
export function bestEffort<T, F>(p: PromiseLike<T>, _why: string, fallback?: F): Promise<T | F | undefined> {
  return Promise.resolve(p).catch(() => fallback);
}
