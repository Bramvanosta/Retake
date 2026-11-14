/**
 * Typed engine errors for clients outside the CLI (the MCP server; later the jobs worker and the HTTP API). The CLI keeps
 * its native errors, messages and exit codes: `toEngineError` maps them at the client boundary only.
 */
import { ERROR_KINDS, docsUrl, errorKindOf } from '@retake/core/base';
import type { KindedError } from '@retake/core/base';

/** The codes of an EngineError: core's error kinds (core error-kind.ts, each documented there). */
export const ENGINE_ERROR_CODES = ERROR_KINDS;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    /**
     * `docs`: the documentation URL of the guide page about it (core docsUrl of the page the error class it was mapped
     * from names), which MCP clients and the Studio receive with the error.
     */
    readonly opts: { fix?: string; details?: Record<string, unknown>; docs?: string } = {},
  ) {
    super(message);
    this.name = 'EngineError';
  }

  get fix(): string | undefined {
    return this.opts.fix;
  }

  get details(): Record<string, unknown> | undefined {
    return this.opts.details;
  }

  get docs(): string | undefined {
    return this.opts.docs;
  }

  /** Its code, as every error raised on purpose states its kind (core error-kind.ts). */
  get errorKind(): EngineErrorCode {
    return this.code;
  }
}

/**
 * A scenario read with other bytes than a job pinned (core ScenarioChangedError: a `conflict` with the sha256 it
 * `expected` and the `actual` one, read from its kind and fields, whatever module copy it comes from) → `conflict` with
 * `message`, the submitted and current sha256 in its details; any other error unchanged.
 */
export function scenarioChangedConflict(e: unknown, message: string): unknown {
  if (e instanceof EngineError || errorKindOf(e) !== 'conflict') return e;
  const { expected, actual } = e as Error & { expected?: unknown; actual?: unknown };
  if (typeof expected !== 'string' || typeof actual !== 'string') return e;
  return new EngineError('conflict', message, { details: { submitted: expected, current: actual } });
}

/** The options an EngineError of another module copy of this class carries (its fix, details and docs), when present. */
function copiedOptions(e: Error): EngineError['opts'] {
  const o = e.name === 'EngineError' ? (e as { opts?: unknown }).opts : undefined;
  if (!o || typeof o !== 'object') return {};
  const { fix, details, docs } = o as Record<string, unknown>;
  return {
    ...(typeof fix === 'string' ? { fix } : {}),
    ...(details && typeof details === 'object' && !Array.isArray(details) ? { details: details as Record<string, unknown> } : {}),
    ...(typeof docs === 'string' ? { docs } : {}),
  };
}

/**
 * Any error → an EngineError, in one place: an error raised on purpose states its kind (core error-kind.ts: `errorKind`,
 * and the guide page `errorDocs`, given as its URL, a client message `clientMessage` when it differs), read here whatever package and
 * module copy it comes from; its validation issues (`issues`) go to `details.issues`. Anything else → internal (its
 * message kept, no stack). An EngineError of another module copy keeps its code, fix, details and docs. The classes and
 * their kinds: engine test/error-kinds.test.ts.
 */
/** A thrown value that is no Error, as text: `String(x)` throws on an object without a prototype or a throwing toString. */
function thrownText(e: unknown): string {
  try {
    return String(e);
  } catch {
    return 'a value that cannot be shown as text was thrown';
  }
}

export function toEngineError(e: unknown): EngineError {
  if (e instanceof EngineError) return e;
  if (!(e instanceof Error)) return new EngineError('internal', thrownText(e));
  const kind = errorKindOf(e);
  if (kind === undefined) return new EngineError('internal', e.message);
  const { issues, errorDocs, clientMessage } = e as Partial<KindedError> & { issues?: unknown };
  const details = Array.isArray(issues) && issues.length ? { issues } : undefined;
  return new EngineError(kind, typeof clientMessage === 'string' ? clientMessage : e.message, {
    ...copiedOptions(e),
    ...(details ? { details } : {}),
    ...(typeof errorDocs === 'string' ? { docs: docsUrl(errorDocs) } : {}),
  });
}

/** Any thrown value's message, for a log line: an Error's message, else the value as text (never a throw of its own). */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : thrownText(e);
}
