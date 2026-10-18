/**
 * Page inspection helpers (L3.3, `page_inspect`): the synthetic scenario that opens one page of an environment, the
 * origin check of an inspected page, and the serialisation of a suggested target as a scenario writes it.
 */
import { parse, stringify } from 'yaml';
import { hasErrors } from './issues.js';
import { parseScenario } from './scenario.js';
import type { ScenarioCheckOptions } from './scenario.js';
import { normalizeTarget } from './targets.js';
import type { LoadedScenario, TargetObject, TargetSpec } from './types.js';

/** The id of the one scene of an inspection scenario. */
export const INSPECT_SCENE = 'inspect';
/** Longest path an inspection opens. */
export const INSPECT_PATH_MAX = 2048;

/**
 * Why a path cannot be inspected (null when it can): a relative path under the page (`/…`), no scheme, no `//host`, no
 * backslash, no `{{…}}` template (no `{{env:}}` / `{{keychain:}}` through an inspection), no control character.
 */
export function inspectPathProblem(path: string): string | null {
  if (path.length > INSPECT_PATH_MAX) return `the path is longer than ${INSPECT_PATH_MAX} characters`;
  if (!path.startsWith('/')) return 'the path must start with "/" (it is opened under the page\'s URL)';
  if (path.startsWith('//')) return 'the path may not start with "//" (another host)';
  if (path.includes('\\')) return 'the path may not contain a backslash';
  if (path.includes('{{')) return 'the path may not contain a {{…}} template';
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'the path may not contain control characters';
  return null;
}

/**
 * A one-scene scenario that opens `path` on the environment page `page` and stops (a `wait: 0` step): an inspection of
 * a plain page runs through the same run path as any dry run (personas, sign-in, guards). `persona` signs the page in
 * as that persona (`none`: signed out; default the persona whose `pages` list it); `check` validates it against a
 * project and an environment (the page key, the persona). Throws on a bad path or an invalid scenario.
 */
export function inspectScenario(page: string, path = '/', opts: { persona?: string; check?: ScenarioCheckOptions } = {}): LoadedScenario {
  const problem = inspectPathProblem(path);
  if (problem) throw new Error(`cannot inspect ${JSON.stringify(path)}: ${problem}`);
  const scene = { id: INSPECT_SCENE, page, open: path, ...(opts.persona !== undefined ? { persona: opts.persona } : {}), steps: [{ wait: 0 }] };
  const value = { version: 1, video: 'inspect', scenes: [scene] };
  const text = stringify(value, { lineWidth: 0 });
  const { scenario, issues } = parseScenario(text, opts.check ?? {});
  if (!scenario || hasErrors(issues)) {
    // The scenario is built here, never shown: each error is told by the argument it comes from, without a position.
    const arg: Record<string, string> = { persona: 'persona', open: 'path', page: 'page' };
    const errors = issues.filter((i) => i.severity === 'error').map((i) => {
      const key = i.path[0] === 'scenes' ? i.path[2] : undefined;
      return `${typeof key === 'string' && arg[key] ? `${arg[key]}: ` : ''}${i.message}`;
    });
    throw new Error(`cannot inspect page ${page}: ${errors.join('; ') || 'invalid'}`);
  }
  return { name: 'inspect', file: '<inspect>', text, scenario, issues };
}

/** The origins (scheme://host:port) of an environment's pages. */
export function pageOrigins(pages: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const url of Object.values(pages)) {
    try {
      out.add(new URL(url).origin);
    } catch {
      /* not a URL: no origin */
    }
  }
  return [...out];
}

/**
 * True when `url` (http or https) has the exact origin of one of the environment's pages — not merely one of its
 * hosts: another port of localhost (another local app) is another origin.
 */
export function isPageOrigin(url: string, pages: Record<string, string>): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return pageOrigins(pages).includes(u.origin);
}

/** Two targets are the same object (keys in any order). */
export function sameTarget(a: TargetObject, b: TargetObject): boolean {
  const canon = (o: unknown): unknown =>
    o && typeof o === 'object' && !Array.isArray(o)
      ? Object.fromEntries(Object.keys(o as object).sort().map((k) => [k, canon((o as Record<string, unknown>)[k])]))
      : Array.isArray(o)
        ? o.map(canon)
        : o;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/**
 * How a scenario writes `t`: the bare string for a lone `text` that reads back as that text (a string that looks like
 * CSS — "#2 Save" — keeps the object form), else the object.
 */
export function targetValue(t: TargetObject): TargetSpec {
  const keys = Object.keys(t);
  if (keys.length === 1 && typeof t.text === 'string' && sameTarget(normalizeTarget(t.text), t)) return t.text;
  return { ...t };
}

/** One-line YAML (flow style) of a value: `{text: Save, in: dialog}`, `"Save"`, `{click: …}`. */
export function flowYaml(value: unknown): string {
  return stringify(value, { collectionStyle: 'flow', lineWidth: 0 }).trim();
}

/**
 * The round trip a suggestion must survive: written as YAML, read back and normalised as the runner does, it is the
 * target that was verified.
 */
export function roundTrips(yamlText: string, t: TargetObject): boolean {
  let back: unknown;
  try {
    back = parse(yamlText);
  } catch {
    return false;
  }
  if (typeof back !== 'string' && (back === null || typeof back !== 'object' || Array.isArray(back))) return false;
  return sameTarget(normalizeTarget(back as TargetSpec), t);
}
