/**
 * Error kinds: what a client outside the CLI is told about an error the tool raised on purpose — the code of an
 * EngineError (engine errors.ts re-exports the list as ENGINE_ERROR_CODES). Each error class of the packages whose
 * message is written for the person states its kind (`errorKind`, a getter: some depend on the message or a field) and
 * may name the guide page that explains it (`errorDocs`). The engine's toEngineError reads them — no list of class
 * names — and the CLI prints an error that has a kind as one line, without a stack. An error without one is a bug:
 * `internal`, its stack printed.
 */

export const ERROR_KINDS = [
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

export type ErrorKind = (typeof ERROR_KINDS)[number];

/** An error raised on purpose: its kind, the guide page about it, the message a client gets when it is not `message`. */
export interface KindedError extends Error {
  readonly errorKind: ErrorKind;
  /** A repository path under docs/guide/ (e.g. `docs/guide/sandbox.md`). */
  readonly errorDocs?: string;
  readonly clientMessage?: string;
}

/** The kind an error states, or undefined (not an Error, or not one raised on purpose). */
export function errorKindOf(e: unknown): ErrorKind | undefined {
  if (!(e instanceof Error)) return undefined;
  const kind = (e as Partial<KindedError>).errorKind;
  return typeof kind === 'string' && (ERROR_KINDS as readonly string[]).includes(kind) ? (kind as ErrorKind) : undefined;
}

/** A message that says something is missing. */
const NOT_FOUND_MESSAGE = /\bnot found\b|\bno such\b|\bdoes not exist\b/i;

/** `not_found` when the message says something is missing and no validation issue came with it, else `invalid`. */
export function missingOrInvalid(message: string, issues?: unknown): ErrorKind {
  return NOT_FOUND_MESSAGE.test(message) && !(Array.isArray(issues) && issues.length) ? 'not_found' : 'invalid';
}

/**
 * The kind of a sandbox failure (sandbox SandboxError, engine SandboxTakeError): from its code — busy, down (not
 * running), interrupted — else `not_found` for an unknown sandbox (by its message), else `otherwise`.
 */
export function sandboxErrorKind(code: string | undefined, message: string, otherwise: ErrorKind): ErrorKind {
  if (code === 'busy') return 'busy';
  if (code === 'down') return 'unavailable';
  if (code === 'interrupted') return 'cancelled';
  return /^unknown|has no sandbox|not a sandbox/.test(message) ? 'not_found' : otherwise;
}

/** The guide pages error classes point at (repository paths). */
export const GUIDE = {
  scenarios: 'docs/guide/scenarios.md',
  workspace: 'docs/guide/workspace.md',
  environments: 'docs/guide/environments.md',
  security: 'docs/guide/security.md',
  sandbox: 'docs/guide/sandbox.md',
  editing: 'docs/guide/editing.md',
  review: 'docs/guide/review.md',
  components: 'docs/guide/themes-and-components.md',
} as const;
