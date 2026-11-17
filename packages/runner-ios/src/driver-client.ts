/**
 * The HTTP client of the XCUITest driver (driver/RetakeDriverUITests/Server.swift): `POST /cmd` with a JSON body
 * `{op, deadline_ms, …}` and the run's token in `X-Retake-Token` — the driver drops a command it gets past its
 * deadline (the host gave up on it) —, `GET /status` without the token but with a fresh nonce in `X-Retake-Nonce`: the
 * driver proves it holds the token (HMAC-SHA256 of the nonce, keyed by the token) before anything is sent to it, so a
 * program that took the port first is never handed the token or a command. Each call has its own time limit and the
 * run's cancel (the clean-up's calls: not the cancel); what went wrong becomes a DriverError (refused, invalid,
 * failed, unreachable, timeout).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A frame on the device's screen, in points. */
export interface DriverFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What `find` (and a query `tap`) says of an element. */
export interface DriverElement {
  exists: boolean;
  hittable: boolean;
  frame?: DriverFrame;
  label?: string;
  value?: string;
  placeholder?: string;
  type?: string;
}

/** Every reply: its wall-clock times (epoch ms, the host's clock). */
export interface DriverReply {
  ok: true;
  t_begin: number;
  t_end: number;
  [k: string]: unknown;
}

export type DriverErrorKind = 'refused' | 'invalid' | 'failed' | 'unreachable' | 'timeout' | 'cancelled';

export class DriverError extends Error {
  constructor(
    message: string,
    readonly kind: DriverErrorKind,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

/** The header the driver checks on /cmd. */
export const TOKEN_HEADER = 'x-retake-token';
/** The header of /status's nonce. */
export const NONCE_HEADER = 'x-retake-nonce';

/** The driver's proof of the token for a nonce: hex HMAC-SHA256(key: the token's bytes, the nonce's bytes). Pure. */
export function statusProof(token: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(nonce, 'utf8').digest('hex');
}

/** Whether `given` is the proof of `nonce` (constant time). Pure. */
export function proofMatches(token: string, nonce: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const want = Buffer.from(statusProof(token, nonce), 'utf8');
  const got = Buffer.from(given, 'utf8');
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface DriverClientOptions {
  port: number;
  token: string;
  /** The run's cancel. */
  signal?: AbortSignal;
  /** Default time limit of a call (ms). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class DriverClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private sent = Date.now();
  /** Whether the driver proved it holds the token (no command goes out before). */
  private proven = false;

  constructor(private readonly o: DriverClientOptions) {
    this.base = `http://127.0.0.1:${o.port}`;
    this.fetchFn = o.fetch ?? fetch;
  }

  /** When the last command was sent (epoch ms). */
  get lastSent(): number {
    return this.sent;
  }

  /** Whether the driver answers /status (within `timeoutMs`) with the proof of the token for a fresh nonce. */
  async status(timeoutMs = 1000): Promise<boolean> {
    const nonce = randomBytes(16).toString('hex');
    try {
      const res = await this.fetchFn(`${this.base}/status`, { headers: { [NONCE_HEADER]: nonce }, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (res.status !== 200) return false;
      const ok = proofMatches(this.o.token, nonce, (JSON.parse(text) as { proof?: unknown }).proof);
      if (ok) this.proven = true;
      return ok;
    } catch {
      return false;
    }
  }

  /**
   * One command; its reply, or a DriverError. `o.uncancelled`: a clean-up's call, not under the run's cancel (its own
   * time limit only). Refused before the driver proved it holds the token (status).
   */
  async cmd<T = Record<string, unknown>>(op: string, body: Record<string, unknown> = {}, timeoutMs?: number, o: { uncancelled?: boolean } = {}): Promise<DriverReply & T> {
    if (!this.proven) throw new DriverError(`the iOS driver has not proved it holds the run's token: ${op} not sent`, 'refused');
    const limit = timeoutMs ?? this.o.timeoutMs ?? 60_000;
    const timeout = AbortSignal.timeout(limit);
    const runSignal = o.uncancelled ? undefined : this.o.signal;
    const signal = runSignal ? AbortSignal.any([runSignal, timeout]) : timeout;
    let res: Response;
    let text: string;
    this.sent = Date.now();
    try {
      res = await this.fetchFn(`${this.base}/cmd`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TOKEN_HEADER]: this.o.token },
        // The driver drops it when it gets to it past this (the simulator shares the host's clock).
        body: JSON.stringify({ ...body, op, deadline_ms: this.sent + limit }),
        signal,
      });
      text = await res.text();
    } catch (e) {
      if (runSignal?.aborted) throw new DriverError(`the iOS driver's ${op} was cancelled`, 'cancelled');
      if (timeout.aborted) throw new DriverError(`the iOS driver did not answer ${op} within ${(limit / 1000).toFixed(0)} s`, 'timeout');
      throw new DriverError(`the iOS driver is not reachable (${(e as Error).message})`, 'unreachable');
    }
    if (res.status === 403) throw new DriverError(`the iOS driver refused the run's token (${op})`, 'refused');
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new DriverError(`the iOS driver's answer to ${op} is no JSON (HTTP ${res.status})`, 'failed');
    }
    if (json.ok !== true) {
      const kind = json.code === 'invalid' ? 'invalid' : json.code === 'expired' ? 'timeout' : 'failed';
      throw new DriverError(`${op}: ${typeof json.error === 'string' ? json.error : `HTTP ${res.status}`}`, kind);
    }
    return json as DriverReply & T;
  }
}
