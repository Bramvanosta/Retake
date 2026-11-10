/**
 * The names a client outside the CLI may use (the MCP server): slugs and ids, never a path. They are checked here,
 * before anything reaches core — core's loaders also accept absolute and cwd-relative paths, which only the CLI may use.
 */
import { PROJECT_SLUG_RE, SLUG_RE, parseRunId, renderIdOf } from '@retake/core';
import type { RunId } from '@retake/core';
import { EngineError } from './errors.js';

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

/** `id` as a run id (core `parseRunId`: a folder name of runs/, at most 200 characters), or the refusal. */
export function checkRunId(id: string): RunId {
  const run = parseRunId(id);
  if (run === null) {
    throw new EngineError('invalid', `invalid run id "${String(id)}": a folder name of runs/ (e.g. 20261017-142233-quote), never a path`);
  }
  return run;
}

/**
 * Whether a record of renders/ is a render of the scenario it names: its id is `<that scenario>-v<N>[-vertical|-square]`
 * (core renderIdOf: the grammar, the length, the version's bound). The one definition behind `latest` and prune's count
 * of a scenario's last renders: a by-id call takes a render id, so `latest` never names a record a by-id call refuses,
 * and a record that is no render takes no render's place.
 */
export function isRenderOfItsScenario(r: { id: unknown; scenario: unknown }): boolean {
  return typeof r.scenario === 'string' && renderIdOf(r.id, r.scenario) !== null;
}
