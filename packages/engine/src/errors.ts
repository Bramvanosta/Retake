/**
 * Typed engine errors for clients outside the CLI (the MCP server; later the jobs worker and the HTTP API). The CLI keeps
 * its native errors, messages and exit codes: `toEngineError` maps them at the client boundary only.
 */

export const ENGINE_ERROR_CODES = [
  /** No such project, scenario, run, persona, sandbox… */
  'not_found',
  /** The input or a file it names is invalid (validation issues in `details.issues`). */
  'invalid',
  /** `if_match` did not match (the current hash in `details.current`), or a file that must not exist does. */
  'conflict',
  /** Refused by a safety rule (read-only or production environment, hook security). */
  'refused',
  /** A human must approve it first (the command a human runs is in `fix`). */
  'needs_approval',
  /** Another command holds what this one needs (a sandbox's take lock). */
  'busy',
  /** Something it needs is not running (a sandbox that is down). */
  'unavailable',
  'cancelled',
  /** A bug or an unexpected failure. */
  'internal',
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    readonly opts: { fix?: string; details?: Record<string, unknown> } = {},
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
}

/** A ConfigError / ScenarioError that says something is missing. */
const NOT_FOUND = /\bnot found\b|\bno such\b|\bdoes not exist\b/i;

/**
 * Any error → an EngineError, in one place. Matched by name (the classes live in packages the engine does not load
 * eagerly): ScenarioError / ConfigError → not_found or invalid; AccessError, HookSecurityError, WriteRefusedError,
 * HostRefusedError → refused; HooksSourceError → invalid (not a source) or not_found (nothing to run); SandboxError busy → busy, down → unavailable, interrupted → cancelled; CancelledError →
 * cancelled; ReviewError / ExportError → not_found or invalid; ComponentError → not_found, conflict (exists) or invalid; anything unknown → internal (its message kept, no stack).
 */
export function toEngineError(e: unknown): EngineError {
  if (e instanceof EngineError) return e;
  if (!(e instanceof Error)) return new EngineError('internal', String(e));
  const issues = (e as { issues?: unknown }).issues;
  const details = Array.isArray(issues) && issues.length ? { issues } : undefined;
  switch (e.name) {
    case 'ScenarioError':
    case 'ConfigError':
    case 'SandboxConfigError':
    case 'EnvironmentError':
      return new EngineError(NOT_FOUND.test(e.message) && !details ? 'not_found' : 'invalid', e.message, details ? { details } : {});
    case 'TemplateError':
    case 'ClockError':
    case 'StepError':
    case 'RenderError':
    case 'PlanError':
      return new EngineError('invalid', e.message);
    case 'ComponentError':
      return new EngineError(/already exists/.test(e.message) ? 'conflict' : NOT_FOUND.test(e.message) && !details ? 'not_found' : 'invalid', e.message, details ? { details } : {});
    case 'AccessError':
    case 'PlanTrustError':
    case 'HookSecurityError':
    case 'WriteRefusedError':
    case 'HostRefusedError':
      return new EngineError('refused', e.message);
    case 'CancelledError':
    case 'RenderCancelledError':
    case 'ReviewCancelledError':
      return new EngineError('cancelled', e.message);
    case 'ReviewError':
    case 'ExportError':
      return new EngineError(NOT_FOUND.test(e.message) ? 'not_found' : 'invalid', e.message);
    case 'RunOptionError':
    case 'HookError':
    case 'JournalError':
      return new EngineError('invalid', e.message);
    case 'HooksSourceError':
      return new EngineError((e as { usage?: boolean }).usage ? 'invalid' : 'not_found', e.message);
    case 'SandboxError':
    case 'SandboxTakeError': {
      const code = (e as { code?: string }).code;
      return new EngineError(code === 'busy' ? 'busy' : code === 'down' ? 'unavailable' : code === 'interrupted' ? 'cancelled' : /^unknown|has no sandbox|not a sandbox/.test(e.message) ? 'not_found' : e.name === 'SandboxTakeError' ? 'unavailable' : 'internal', e.message);
    }
    default:
      return new EngineError('internal', e.message);
  }
}
