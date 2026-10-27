/**
 * Hash routes of the Studio (one document; the server never sees the fragment): `#/` projects, `#/p/<slug>` a project,
 * `#/p/<slug>/readme` its README editor, `#/p/<slug>/s/<name>` a scenario as blocks and `#/p/<slug>/s/<name>/yaml`
 * its YAML (L4.2), `#/p/<slug>/s/<name>/run` its Run screen (the preflight, then Start) and
 * `#/p/<slug>/s/<name>/run/<run_id>` one run of it watched live (L4.4), `#/p/<slug>/s/<name>/timeline` the timeline of
 * its latest capture and `#/p/<slug>/s/<name>/timeline/<run_id>[/<step key>]` of one capture, at one of its steps
 * (L4.5), `#/p/<slug>/s/<name>/comments` its frame comments (L4.6: the list and a render's frames),
 * `…/comments/<comment id>` one thread open and `…/comments/at/<render id>/<frame>` a render's frame, ready to comment,
 * `#/p/<slug>/s/<name>/proposal/<comment id>/<entry id>` the timeline previewing the change Claude proposed on a thread
 * (L4.6 part D2: planned in memory, nothing written), `#/p/<slug>/library[/<theme>[/<namespace>/<name>]]` the component
 * library in the project's theme or another, and one component's detail (L4.7 part D1), `#/p/<slug>/themes[/<theme>]` the
 * theme list and one theme's editor (L4.7 part D2).
 * A slug, a scenario name, a run id, a comment or render id is whatever
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
  | { name: 'comments'; slug: string; scenario: string; thread?: string; at?: { render: string; frame: number } }
  | { name: 'proposal'; slug: string; scenario: string; thread: string; entry: string }
  | { name: 'library'; slug: string; theme?: string; component?: string }
  | { name: 'themes'; slug: string; theme?: string }
  | { name: 'not-found'; path: string };

const SLUG_MAX = 200;
/** A frame in an address: a whole number, at most this (the server checks it against the render). */
const FRAME_MAX = 10_000_000;

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
  const c = /^\/p\/([^/]+)\/s\/([^/]+)\/comments(?:\/at\/([^/]+)\/(\d{1,8})|\/([^/]+))?\/?$/.exec(path);
  const cSlug = c ? decode(c[1]) : null;
  const cScenario = c ? decode(c[2]) : null;
  const cRender = c?.[3] !== undefined ? decode(c[3]) : undefined;
  const cFrame = c?.[4] !== undefined ? Number(c[4]) : undefined;
  const cThread = c?.[5] !== undefined ? decode(c[5]) : undefined;
  if (c && cSlug !== null && cScenario !== null && cRender !== null && cThread !== null && (cFrame === undefined || cFrame <= FRAME_MAX) && cThread !== 'at') {
    return {
      name: 'comments',
      slug: cSlug,
      scenario: cScenario,
      ...(cThread !== undefined ? { thread: cThread } : {}),
      ...(cRender !== undefined && cFrame !== undefined ? { at: { render: cRender, frame: cFrame } } : {}),
    };
  }
  const pr = /^\/p\/([^/]+)\/s\/([^/]+)\/proposal\/([^/]+)\/([^/]+)\/?$/.exec(path);
  const prParts = pr ? [pr[1], pr[2], pr[3], pr[4]].map(decode) : null;
  if (prParts && prParts.every((x) => x !== null)) {
    const [pSlug, pScenario, pThread, pEntry] = prParts as string[];
    return { name: 'proposal', slug: pSlug, scenario: pScenario, thread: pThread, entry: pEntry };
  }
  const lb = /^\/p\/([^/]+)\/library(?:\/([^/]+)(?:\/([^/]+)\/([^/]+))?)?\/?$/.exec(path);
  const lbParts = lb ? [lb[1], lb[2], lb[3], lb[4]].map((x) => (x === undefined ? undefined : decode(x))) : null;
  if (lbParts && lbParts.every((x) => x !== null)) {
    const [lSlug, lTheme, lNs, lName] = lbParts as Array<string | undefined>;
    // A component id is two segments, neither holding a "/" once decoded (the server checks the id itself).
    if (lNs === undefined || (!lNs.includes('/') && !lName!.includes('/'))) {
      return { name: 'library', slug: lSlug!, ...(lTheme !== undefined ? { theme: lTheme } : {}), ...(lNs !== undefined ? { component: `${lNs}/${lName}` } : {}) };
    }
  }
  const th = /^\/p\/([^/]+)\/themes(?:\/([^/]+))?\/?$/.exec(path);
  const thSlug = th ? decode(th[1]) : null;
  const thTheme = th?.[2] !== undefined ? decode(th[2]) : undefined;
  if (th && thSlug !== null && thTheme !== null) return { name: 'themes', slug: thSlug, ...(thTheme !== undefined ? { theme: thTheme } : {}) };
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
    case 'comments': {
      // A thread, or a render's frame (a whole number within the address's range), or the list.
      const frame = r.at && Number.isInteger(r.at.frame) && r.at.frame >= 0 && r.at.frame <= FRAME_MAX ? r.at.frame : undefined;
      const rest = r.thread !== undefined ? `/${encodeURIComponent(r.thread)}` : r.at && frame !== undefined ? `/at/${encodeURIComponent(r.at.render)}/${frame}` : '';
      return `#/p/${encodeURIComponent(r.slug)}/s/${encodeURIComponent(r.scenario)}/comments${rest}`;
    }
    case 'proposal':
      return `#/p/${encodeURIComponent(r.slug)}/s/${encodeURIComponent(r.scenario)}/proposal/${encodeURIComponent(r.thread)}/${encodeURIComponent(r.entry)}`;
    case 'library': {
      // A component needs its theme (the detail shows it in one) and is "namespace/name": anything else is dropped.
      const parts = r.component?.split('/');
      const comp = r.theme !== undefined && parts?.length === 2 && parts[0] && parts[1] ? `/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}` : '';
      return `#/p/${encodeURIComponent(r.slug)}/library${r.theme !== undefined ? `/${encodeURIComponent(r.theme)}${comp}` : ''}`;
    }
    case 'themes':
      return `#/p/${encodeURIComponent(r.slug)}/themes${r.theme !== undefined ? `/${encodeURIComponent(r.theme)}` : ''}`;
  }
}
