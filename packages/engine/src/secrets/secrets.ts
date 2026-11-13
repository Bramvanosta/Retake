/**
 * The Secrets port: what resolves a secret reference — `env:VAR` (a variable of the environment), `keychain:service/account`
 * (the system's keychain), `secret:` before either — to its value. The worker (and each composition root) resolves:
 * the engine hands this port's resolver to every run, sign-in, hook context and sandbox it starts, and calls core io's
 * resolvers in system-secrets.ts only (the import-rules ratchet's `secret-resolve` check). An adapter called without
 * a resolver (its own tests) falls back to core io on this process's environment; the engine never calls one so. The
 * product's adapter is system-secrets.ts (core io on the environment its root read); the in-memory one
 * (memory-secrets.ts) serves tests; one contract suite holds both (engine/test/secrets-contract.ts).
 */

export interface Secrets {
  /**
   * The value of one reference; a TemplateError (core) when it cannot be resolved — a variable not set, a keychain item
   * not found, a reference of no known kind — in the words of core io resolveSecretRef.
   */
  resolve(ref: string): Promise<string>;
}
