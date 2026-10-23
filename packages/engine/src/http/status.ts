/**
 * HTTP status of each engine error code (L4.1, critique B12): the engine's HTTP API answers a tool error with this
 * status and `{ok: false, error: {code, message, fix?, details?}}` — the same error the MCP server returns.
 */
import type { EngineErrorCode } from '../errors.js';

export const ERROR_STATUS: Readonly<Record<EngineErrorCode, number>> = {
  invalid: 400,
  refused: 403,
  needs_approval: 403,
  not_found: 404,
  conflict: 409,
  cancelled: 409,
  busy: 423,
  unavailable: 503,
  internal: 500,
};
