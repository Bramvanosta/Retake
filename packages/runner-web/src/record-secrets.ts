/** The secret memory of a recording session, and the masking of paths and typed queries (record-session.ts). */
import { randomBytes } from 'node:crypto';
import { SECRET_MASK, SECRET_MIN, looksLikeToken, secretHash } from './kit/record-script.js';
import type { SecretHash } from './kit/record-script.js';
import { decodeOrKeep } from '@retake/core/base';

/** Query keys a typed navigation never keeps (they may carry a token). */
export const SENSITIVE_QUERY_KEY = /token|code|state|session|sig|auth|key|pass|secret|otp|pwd|nonce|ticket|jwt|saml|credential/i;

/** The secret memory of the session: salted hashes of the final secret values (never the values). */
export class SecretMemory {
  readonly salt = randomBytes(4).readUInt32LE(0);
  private readonly byLength = new Map<number, Set<string>>();
  readonly list: SecretHash[] = [];

  add(n: number, h: string): void {
    if (!Number.isInteger(n) || n < SECRET_MIN || n > 4096 || typeof h !== 'string' || h.length > 20) return;
    let set = this.byLength.get(n);
    if (!set) this.byLength.set(n, (set = new Set()));
    if (set.has(h) || this.list.length >= 1000) return;
    set.add(h);
    this.list.push([n, h]);
  }

  mask(s: string): { s: string; hit: boolean } {
    let out = s;
    let hit = false;
    for (const [n, set] of this.byLength) {
      if (out.length < n) continue;
      let res = '';
      let from = 0;
      for (let i = 0; i + n <= out.length; ) {
        if (set.has(secretHash(out.slice(i, i + n), this.salt))) {
          res += out.slice(from, i) + SECRET_MASK;
          i += n;
          from = i;
          hit = true;
        } else i++;
      }
      if (from > 0) out = res + out.slice(from);
    }
    return { s: out, hit };
  }

  maskDeep<T>(v: T, count: { n: number }): T {
    if (this.byLength.size === 0) return v;
    if (typeof v === 'string') {
      const r = this.mask(v);
      if (r.hit) count.n++;
      return r.s as T;
    }
    if (Array.isArray(v)) return v.map((x) => this.maskDeep(x, count)) as T;
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = this.maskDeep(x, count);
      return out as T;
    }
    return v;
  }
}

/**
 * A path segment or query value that may be a credential or a person's address: an e-mail address, a long hex string
 * (a UUID included), a JWT, a key-like value (looksLikeToken) or a long run of letters and digits (base64url). A slug
 * (`single-origin-2024`) is none of these.
 */
export function looksLikeSecretSegment(raw: string): boolean {
  const s = decodeOrKeep(raw).trim();
  if (/^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/.test(s)) return true;
  if (s.length < 16) return false;
  if (/^[0-9a-f]{32,}$/i.test(s.replace(/-/g, ''))) return true;
  if (/^[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}$/.test(s) && s.length >= 20) return true;
  if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s) && looksLikeToken(s)) return true;
  return s.split(/[-_.~+=]/).some((run) => run.length >= 20 && /[0-9]/.test(run) && /[a-z]/i.test(run));
}

/** A path (or a label `POST host/path`) with its segments that look like a secret masked. */
export function maskPathSecrets(path: string): string {
  if (!path) return path;
  return path
    .split('/')
    .map((seg) => (seg && looksLikeSecretSegment(seg) ? SECRET_MASK : seg))
    .join('/');
}

/** A typed navigation's query: keys that may carry a token removed, values that look like one (or the memory knows) too. */
export function keptQuery(url: URL, memory: SecretMemory): string | undefined {
  const kept = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (SENSITIVE_QUERY_KEY.test(k) || looksLikeSecretSegment(k) || looksLikeSecretSegment(v)) continue;
    const m = memory.mask(v);
    if (m.hit) continue;
    kept.append(k, v);
  }
  const q = kept.toString();
  return q ? `?${q}`.slice(0, 2048) : undefined;
}
