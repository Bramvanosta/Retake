/**
 * Tool results (R-MCP-04): a short summary written for Claude first (what happened, what to do next, key paths), then
 * the data as JSON — also as `structuredContent`. Text the filmed site controls only ever appears inside the data,
 * under an `untrusted` key, truncated; never in the summary. Errors are tool errors (`isError`) with a typed code.
 */
import { toEngineError } from '@demo-studio/engine';
import type { CallResult } from './server.js';

export interface ToolOutput {
  summary: string;
  data: Record<string, unknown>;
}

/** Longest untrusted string a result carries. */
export const UNTRUSTED_MAX = 2000;

export function truncate(s: string, max = UNTRUSTED_MAX): string {
  return s.length > max ? `${s.slice(0, max)}… (${s.length - max} more characters)` : s;
}

/** Every string under `untrusted` keys, truncated (at any depth). */
export function capUntrusted<T>(value: T, inside = false): T {
  if (typeof value === 'string') return (inside ? truncate(value) : value) as T;
  if (Array.isArray(value)) return value.map((v) => capUntrusted(v, inside)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, capUntrusted(v, inside || k === 'untrusted')])) as T;
  }
  return value;
}

export function okResult(out: ToolOutput): CallResult {
  const data = capUntrusted(out.data);
  return {
    content: [
      { type: 'text', text: out.summary },
      { type: 'text', text: JSON.stringify(data, null, 2) },
    ],
    structuredContent: data,
  };
}

export function errorResult(e: unknown): CallResult {
  const err = toEngineError(e);
  const data = {
    error: {
      code: err.code,
      message: err.message,
      ...(err.fix ? { fix: err.fix } : {}),
      ...(err.details ? { details: err.details } : {}),
    },
  };
  return {
    isError: true,
    content: [{ type: 'text', text: `${err.code}: ${err.message}${err.fix ? `\nfix: ${err.fix}` : ''}` }],
    structuredContent: data,
  };
}

/** "3 scenarios" / "1 scenario". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
