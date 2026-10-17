/**
 * The names a client outside the CLI may use (the MCP server): slugs and ids, never a path. They are checked here,
 * before anything reaches core — core's loaders also accept absolute and cwd-relative paths, which only the CLI may use.
 */
import { PROJECT_SLUG_RE, SLUG_RE } from '@demo-studio/core';
import { EngineError } from './errors.js';

/** "20261017-142233-quote" (and any other folder name of runs/ made of letters, digits, ".", "_" and "-"). */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export { PROJECT_SLUG_RE, SLUG_RE };

export function checkProjectSlug(slug: string): string {
  if (typeof slug !== 'string' || !PROJECT_SLUG_RE.test(slug) || slug.length > 100) {
    throw new EngineError('invalid', `invalid project "${String(slug)}": a project slug (lower-case letters, digits and "-"), never a path`);
  }
  return slug;
}

export function checkScenarioName(name: string): string {
  if (typeof name !== 'string' || !SLUG_RE.test(name) || name.length > 100) {
    throw new EngineError('invalid', `invalid scenario name "${String(name)}": letters, digits, "-" or "_" (it is scenarios/<name>.yaml), never a path`);
  }
  return name;
}

export function checkRunId(id: string): string {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id) || id.length > 200) {
    throw new EngineError('invalid', `invalid run id "${String(id)}": a folder name of runs/ (e.g. 20261017-142233-quote), never a path`);
  }
  return id;
}
