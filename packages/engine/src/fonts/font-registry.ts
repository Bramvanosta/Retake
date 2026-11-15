/**
 * The font registry port (ports.ts `fontRegistry`): where font_fetch and `retake theme fetch-font` download a fontsource
 * package from. Only HTTP and its caps live behind it; every trust check — the package's name, version, licence,
 * tarball URL and integrity, the archive's entries — is the engine's (brand/fontsource-fetch.ts), so a test hands a
 * fake registry serving synthetic tarballs in process and the checks are the product's.
 *
 * The product's adapter is fonts/npm-registry.ts: https://registry.npmjs.org only (no redirect followed, no proxy
 * variable honoured), or a loopback registry named by the test hatch; the suite's refuse-all guard stops it before any
 * socket.
 */

export interface FontRegistry {
  /** The registry's base URL, no trailing slash: what the approval form, the answer and the store's record show. */
  readonly base: string;
  /** The test hatch's loopback registry (never set outside tests): the form and the answer say so. */
  readonly test: boolean;
  /** Why nothing can be fetched at all (the suite's guard, a malformed hatch), said before anyone is asked; else undefined. */
  readonly problem?: string;
  /**
   * GET `base + path`: the body of a 200 answer, at most `max` bytes (Content-Length checked first, the body counted
   * while it streams), no redirect followed, before `signal` aborts. EngineError `unavailable` (no answer, a timeout, a
   * redirect, another status), `not_found` (404), `refused` (over `max`).
   */
  get(path: string, o: { max: number; signal: AbortSignal }): Promise<Buffer>;
}
