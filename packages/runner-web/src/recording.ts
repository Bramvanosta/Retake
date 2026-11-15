/** A recording session's state (record-session.ts): the events it keeps, secrets masked, and the writes it lists. */
import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import type { BrowserContext } from 'playwright-core';
import { type compileWritePolicy, describeWriteRequest, graphqlOf, graphqlReadsOnly, guardsWrites, isGuardedHost, isWriteMethod } from '@retake/core/environment';
import { RecordedEventSchema } from '@retake/core/run';
import type { ResolvedEnvironment } from '@retake/core/environment';
import type { LoginMatcher } from '@retake/core/environment';
import type { RecordedEvent } from '@retake/core/run';
import { armWriteGuard } from './write-guard.js';
import { SecretMemory, maskPathSecrets } from './record-secrets.js';
import type { Log, RecordSessionOptions, RecordSessionResult } from './record-options.js';

/** The environment page whose URL is the longest prefix of `url` (same origin, path under its base). */
export function pageKeyOf(url: string, pages: Record<string, string>): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  let best: { key: string; len: number } | null = null;
  for (const [key, base] of Object.entries(pages)) {
    let b: URL;
    try {
      b = new URL(base);
    } catch {
      continue;
    }
    if (b.origin !== u.origin) continue;
    const bp = b.pathname.replace(/\/+$/, '');
    if (bp && u.pathname !== bp && !u.pathname.startsWith(`${bp}/`)) continue;
    if (!best || bp.length > best.len) best = { key, len: bp.length };
  }
  return best?.key ?? null;
}

/** What the recording keeps and counts, shared by the listeners. */
export interface Recording {
  options: RecordSessionOptions;
  log: Log;
  matchers: LoginMatcher[];
  started: number;
  events: RecordedEvent[];
  memory: SecretMemory;
  dropped: RecordSessionResult['counts']['dropped'];
  redactedTotal: number;
  windowSize: { width: number; height: number } | null;
  stream: WriteStream | null;
  streamError: unknown;
  seq: number;
  open: boolean;
  stopReason: RecordSessionResult['stop'];
  driveError: unknown;
}

/** The recording's state, its events file opened (append, 0600). */
export function newRecording(o: RecordSessionOptions, log: Log, matchers: LoginMatcher[]): Recording {
  const rec: Recording = {
    options: o,
    log,
    matchers,
    started: Date.now(),
    events: [],
    memory: new SecretMemory(),
    dropped: { sign_in: 0, frame: 0, invalid: 0, new_page: 0 },
    redactedTotal: 0,
    windowSize: null,
    stream: null,
    streamError: null,
    seq: 0,
    open: true,
    stopReason: 'closed',
    driveError: null,
  };
  if (o.eventsFile) {
    const stream = createWriteStream(o.eventsFile, { flags: 'a', mode: 0o600 });
    rec.stream = stream;
    stream.on('error', (e) => {
      rec.streamError = e;
    });
  }
  return rec;
}

/** Keeps one event: secrets masked, checked by the schema, streamed to the events file. */
export function keep(rec: Recording, body: Record<string, unknown> & { kind: string }, path: string, age = 0): void {
  if (!rec.open) return;
  const count = { n: 0 };
  const t = Math.max(0, Date.now() - rec.started - age);
  const candidate: Record<string, unknown> = rec.memory.maskDeep({ ...body, seq: rec.seq, t, page: 'p1', path: rec.memory.mask(maskPathSecrets(path)).s }, count);
  const prior = typeof candidate.redacted === 'number' ? candidate.redacted : 0;
  if (count.n + prior > 0) candidate.redacted = count.n + prior;
  // A typing event whose text the runner's memory masked is a secret one.
  if (candidate.kind === 'type' && count.n > 0 && candidate.text !== undefined) {
    delete candidate.text;
    candidate.secret = true;
    if (['text', 'search', 'multiline', 'contenteditable'].includes(String(candidate.field_kind))) candidate.field_kind = 'secret';
  }
  let parsed = RecordedEventSchema.safeParse(candidate);
  const el = candidate.el as Record<string, unknown> | null | undefined;
  if (!parsed.success && el && typeof el === 'object' && ('alternatives' in el || 'alternatives_partial' in el)) {
    // Alternatives the schema refuses never cost the action: it is kept without them.
    delete el.alternatives;
    delete el.alternatives_partial;
    parsed = RecordedEventSchema.safeParse(candidate);
  }
  if (!parsed.success) {
    rec.dropped.invalid++;
    rec.log('debug', `recording: an event was refused by the schema (${parsed.error.issues.map((i) => i.path.join('.')).join(', ')})`);
    return;
  }
  rec.seq++;
  rec.redactedTotal += parsed.data.redacted ?? 0;
  rec.events.push(parsed.data);
  rec.stream?.write(`${JSON.stringify(parsed.data)}\n`);
  try {
    rec.options.onEvent?.(parsed.data);
  } catch {
    /* a listener error must not stop the recording */
  }
}

export function isSignIn(rec: Recording, url: string): boolean {
  return rec.matchers.some((m) => m.test(url));
}

/**
 * Writes: the guard's own report (a read-only environment's, every host it sees a write to; the protected hosts of
 * a read-write one); on a read-write environment, every other write request of the window as seen — whatever its
 * host (an API on another host, a read_only.hosts entry), a form post or a beacon: the check replay stops before
 * the first step one followed. A GraphQL body that only reads is not a write. Labels never carry the query.
 */
export async function watchWrites(context: BrowserContext, rec: Recording, policy: ReturnType<typeof compileWritePolicy>, env: ResolvedEnvironment): Promise<void> {
  const label = (method: string, url: string) => maskPathSecrets(describeWriteRequest(method, url, env.pages));
  if (guardsWrites(policy)) {
    await armWriteGuard(context, { policy, onWrite: (w) => keep(rec, { kind: 'write', method: w.method.toUpperCase(), label: maskPathSecrets(w.label), outcome: w.outcome }, '') }, () => 'capture');
  }
  if (policy.readOnly) return;
  context.on('request', (r) => {
    if (!isWriteMethod(r.method())) return;
    let host: string;
    try {
      const u = new URL(r.url());
      if (!/^https?:$/.test(u.protocol)) return;
      host = u.hostname;
    } catch {
      return;
    }
    // The guard reports the writes it stops (another environment's hosts).
    if (guardsWrites(policy) && isGuardedHost(host, policy)) return;
    let body: string | null = null;
    try {
      body = r.postData();
    } catch {
      body = null;
    }
    const gql = body ? graphqlOf(body) : null;
    if (gql && graphqlReadsOnly(gql)) return;
    keep(rec, { kind: 'write', method: r.method().toUpperCase(), label: label(r.method(), r.url()), outcome: 'passed' }, '');
  });
}
