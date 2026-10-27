/**
 * Hash routes of the Studio (one document; the server never sees the fragment): `#/` projects, `#/p/<slug>` a project,
 * `#/p/<slug>/readme` its README editor, `#/p/<slug>/s/<name>` a scenario as blocks and `#/p/<slug>/s/<name>/yaml`
 * its YAML (L4.2), `#/p/<slug>/s/<name>/run` its Run screen (the preflight, then Start) and
 * `#/p/<slug>/s/<name>/run/<run_id>` one run of it watched live (L4.4), `#/p/<slug>/s/<name>/timeline` the timeline of
 * its latest capture and `#/p/<slug>/s/<name>/timeline/<run_id>[/<step key>]` of one capture, at one of its steps
 * (L4.5). A slug, a scenario name or a run id is whatever
 * the address bar holds, percent-decoded and capped — the server checks it (`project_get` / `scenario_blocks` refuse anything but a slug); here it is only ever a text node or an
 * argument. `hrefTo` is the only way the app builds an `href` (the source lint test enforces it).
 */
export type ScenarioTab = 'blocks' | 'yaml';

export type Route =
  | { name: 'projects' }
  | { name: 'project'; slug: string }
  | { name: 'readme'; slug: string }
  | { name: 'scenario'; slug: string; scenario: string; tab: ScenarioTab }
  | { name: 'run'; slug: string; scenario: string; run?: string }
  | { name: 'timeline'; slug: string; scenario: string; run?: string; step?: string }
  | { name: 'not-found'; path: string };

const SLUG_MAX = 200;

function decode(s: string): string | null {
  try {
    const d = decodeURIComponent(s);
    return d.length > 0 && d.length <= SLUG_MAX ? d : null;
  } catch {
    return null;
  }
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '' || path === '/') return { name: 'projects' };
  const m = /^\/p\/([^/]+)(\/readme)?\/?$/.exec(path);
  const slug = m ? decode(m[1]) : null;
  if (m && slug !== null) return m[2] ? { name: 'readme', slug } : { name: 'project', slug };
  const s = /^\/p\/([^/]+)\/s\/([^/]+)(\/yaml)?\/?$/.exec(path);
  const sSlug = s ? decode(s[1]) : null;
  const scenario = s ? decode(s[2]) : null;
  if (s && sSlug !== null && scenario !== null) return { name: 'scenario', slug: sSlug, scenario, tab: s[3] ? 'yaml' : 'blocks' };
  const r = /^\/p\/([^/]+)\/s\/([^/]+)\/run(?:\/([^/]+))?\/?$/.exec(path);
  const rSlug = r ? decode(r[1]) : null;
  const rScenario = r ? decode(r[2]) : null;
  const run = r?.[3] !== undefined ? decode(r[3]) : undefined;
  if (r && rSlug !== null && rScenario !== null && run !== null) return { name: 'run', slug: rSlug, scenario: rScenario, ...(run !== undefined ? { run } : {}) };
  const t = /^\/p\/([^/]+)\/s\/([^/]+)\/timeline(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/.exec(path);
  const tSlug = t ? decode(t[1]) : null;
  const tScenario = t ? decode(t[2]) : null;
  const tRun = t?.[3] !== undefined ? decode(t[3]) : undefined;
  const tStep = t?.[4] !== undefined ? decode(t[4]) : undefined;
  if (t && tSlug !== null && tScenario !== null && tRun !== null && tStep !== null) {
    return { name: 'timeline', slug: tSlug, scenario: tScenario, ...(tRun !== undefined ? { run: tRun } : {}), ...(tStep !== undefined ? { step: tStep } : {}) };
  }
  return { name: 'not-found', path: path.slice(0, SLUG_MAX) };
}

export function hrefTo(r: Route): string {
  switch (r.name) {
    case 'projects':
    case 'not-found':
      return '#/';
    case 'project':
      return `#/p/${encodeURIComponent(r.slug)}`;
    case 'readme':
      return `#/p/${encodeURIComponent(r.slug)}/readme`;
    case 'scenario':
      return `#/p/${encodeURIComponent(r.slug)}/s/${encodeURIComponent(r.scenario)}${r.tab === 'yaml' ? '/yaml' : ''}`;
    case 'run':
      return `#/p/${encodeURIComponent(r.slug)}/s/${encodeURIComponent(r.scenario)}/run${r.run !== undefined ? `/${encodeURIComponent(r.run)}` : ''}`;
    case 'timeline': {
      // A step needs its run (the step key is the run's own): without a run, no step.
      const run = r.run !== undefined ? `/${encodeURIComponent(r.run)}${r.step !== undefined ? `/${encodeURIComponent(r.step)}` : ''}` : '';
      return `#/p/${encodeURIComponent(r.slug)}/s/${encodeURIComponent(r.scenario)}/timeline${run}`;
    }
  }
}
