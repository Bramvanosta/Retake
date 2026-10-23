/**
 * Secrets of the engine's local HTTP servers (L4.1): a per-launch bearer token and one-time bootstrap codes, both 32
 * random bytes in base64url, compared in constant time.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A fresh secret: 32 random bytes, base64url (43 characters). */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time equality of two strings of any length (their sha256 digests are compared). */
export function secretEquals(a: string, b: string): boolean {
  const d = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(d(a), d(b)) && a.length === b.length;
}

/** The token of an `Authorization: Bearer <token>` header; undefined when the header is absent or of another scheme. */
export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer ([A-Za-z0-9_-]{1,512})$/i.exec(header ?? '');
  return m ? m[1] : undefined;
}

/** How long a bootstrap code stays valid (ms). */
export const BOOTSTRAP_CODE_TTL_MS = 60_000;
/** Codes waiting to be exchanged, at most (the oldest is dropped beyond). */
export const BOOTSTRAP_CODES_MAX = 16;

/**
 * One-time bootstrap codes (critique B9): the URL a person opens carries a code, never the session token; the page
 * exchanges it once, within 60 s, for the token (`POST /v1/session`), so a copy of the URL (browser history, terminal
 * scrollback, `open`'s arguments) is dead. Codes are kept as sha256 digests: a lookup reveals nothing by its timing.
 */
export class BootstrapCodes {
  private readonly codes = new Map<string, number>();

  constructor(
    private readonly ttlMs = BOOTSTRAP_CODE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private static key(code: string): string {
    return createHash('sha256').update(code, 'utf8').digest('hex');
  }

  /** A new code, valid once for `ttlMs`. */
  mint(): string {
    this.prune();
    while (this.codes.size >= BOOTSTRAP_CODES_MAX) this.codes.delete(this.codes.keys().next().value as string);
    const code = newSecret();
    this.codes.set(BootstrapCodes.key(code), this.now() + this.ttlMs);
    return code;
  }

  /** Spend a code: true once, while it is valid; false for an unknown, spent or expired code. */
  redeem(code: string): boolean {
    const k = BootstrapCodes.key(code);
    const until = this.codes.get(k);
    this.codes.delete(k);
    return until !== undefined && this.now() <= until;
  }

  get size(): number {
    this.prune();
    return this.codes.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, until] of this.codes) if (t > until) this.codes.delete(k);
  }
}
