/**
 * R-ISS-14 for real: a client-side route change of a step's click, press or Enter is held until the route is ready.
 * A small app (pushState routes) shows a yellow skeleton (no text) while its data request takes 1.2 s; a pulsing "Live"
 * badge with text (`animate-pulse`) stays in view all along — no loading state. Captured with its frames kept: the
 * route's skeleton is in no frame, `timeline.loading` has its `same_document` span ended `ready` with the part where
 * the skeleton showed (`indicator`), and the click step ends after it. Also held: a `#/` hash route, textless
 * `animate-pulse` placeholders (the wide selectors), an Enter in a search box, `press: Enter` on a focused link, a
 * plain or holding `wait_for` after the click; the data that comes 400 ms after the skeleton went is waited for (the
 * network quiet). Never held: a query-only change, a path rewritten while scrolling or pushed while typing, a route a
 * marked wait films, a route that changes after the pressing step returned. A header spinner and a page that polls
 * every 200 ms never hold a route to the limit; a route ready after an 80 ms fetch films its rows sliding in. A route
 * still showing its skeleton after 3 s is shown as it is, with a run warning naming the indicator.
 */
import { execFileSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_POLICY, TimelineSchema } from '@retake/core';
import type { Timeline, TimelineLoading } from '@retake/core';
import { runScenario } from '../src/index.js';
import { ROUTE_HOLD_MAX_MS, ROUTE_PRESS_KEEP_MS } from '../src/hold.js';
import { FAST, debugTemplate, inRunsOf, makeScenario, startServer } from '@retake/test-support/capture';
import type { TestServer } from '@retake/test-support/capture';
import { makeProject, readTimeline, tempDir } from './helpers.js';

/** The app; `busy`: a spinner in its header and a request every 200 ms, all along (a live dashboard). */
const app = (busy: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>Routes</title>
<style>body{margin:0;font-family:sans-serif;background:#fff} nav{position:fixed;left:0;top:0;width:180px;height:100%;background:#203040}
nav a{display:block;color:#fff;padding:12px;font-size:18px} .skeleton{height:70px;background:#f5d000;margin:10px 0}
@keyframes pulse{50%{opacity:.6}} .animate-pulse{animation:pulse 1s infinite} .live{display:block;margin:12px;padding:8px;background:#e04040;color:#fff;height:40px}
.ph{height:70px;margin:10px 0;background:#f5d000} .spinner{width:40px;height:40px;margin:12px;border:6px solid #888;border-radius:50%}
.slide{transition:transform .6s linear;transform:translateX(900px)} .in{transform:none}
main{margin-left:200px;padding:20px} .row{height:70px;margin:10px 0;background:#dde3ea;font-size:24px}
#far{position:fixed;right:20px;bottom:20px;font-size:20px}</style></head><body>
<nav><a id="to-quotes" href="/quotes">Quotes</a><a id="to-hash" href="#/hash">Hash</a><a id="to-query" href="?sort=name">Sort</a>
<a id="to-stuck" href="/stuck">Stuck</a><a id="to-pulse" href="/pulse">Pulse</a><a id="to-late" href="/late-data">Late data</a>
<a id="to-slide" href="/slide">Slide</a><a id="to-plain" href="/plain">Plain</a><a id="to-later" href="/later">Later</a>
<span class="animate-pulse live">Live</span>${busy ? '<div class="spinner"></div>' : ''}</nav>
<main><h1 id="title">Home</h1><input id="q" placeholder="Filter" style="font-size:20px"> <input id="search" placeholder="Search" style="font-size:20px">
<div id="body"><div class="row">Welcome</div></div><div style="height:2400px"></div><h2 id="setup">Setup</h2></main>
<button id="far">Far away</button>
<script>
const body = document.getElementById('body');
const title = document.getElementById('title');
const skeleton = () => { body.innerHTML = '<div class="skeleton"></div>'.repeat(3); };
const rows = (url) => fetch(url).then((r) => r.json()).then((list) => { body.innerHTML = list.map((t) => '<div class="row">' + t + '</div>').join(''); });
function route() {
  const where = location.hash.startsWith('#/') ? location.hash : location.pathname;
  title.textContent = where + location.search;
  if (where === '/quotes' || where === '#/hash' || where === '/results' || where === '/later' || location.search) { skeleton(); rows('/api/rows'); }
  else if (where === '/stuck') skeleton();
  else if (where === '/pulse') { body.innerHTML = '<div class="ph animate-pulse"></div>'.repeat(3); rows('/api/rows'); }
  else if (where === '/late-data') { skeleton(); setTimeout(() => { body.innerHTML = ''; }, 600); rows('/api/rows-late'); }
  else if (where === '/slide') fetch('/api/fast').then(() => {
    body.innerHTML = '<div class="row slide">One</div><div class="row slide">Two</div>';
    requestAnimationFrame(() => requestAnimationFrame(() => body.querySelectorAll('.slide').forEach((e) => e.classList.add('in'))));
  });
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  const go = () => { history.pushState({}, '', a.getAttribute('href')); route(); };
  // An app that saves first, then opens the page (600 ms after the click).
  if (a.id === 'to-later') fetch('/api/save').then(go); else go();
});
document.getElementById('q').addEventListener('input', (e) => history.pushState({}, '', '/search/' + e.target.value));
document.getElementById('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { history.pushState({}, '', '/results'); route(); } });
addEventListener('scroll', () => { if (scrollY > 300 && location.pathname !== '/docs/setup') history.replaceState({}, '', '/docs/setup'); });
if (location.pathname === '/focus') document.getElementById('to-quotes').focus();
${busy ? "setInterval(() => fetch('/api/ping').catch(() => {}), 200);" : ''}
</script></body></html>`;

let server: TestServer;
let dir: string;
let tl: Timeline;
let runDir: string;

/** Yellow pixels (the skeleton and the placeholders) in a frame file, scaled down. */
function yellow(file: string): number {
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=80:60', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  let n = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] > 200 && px[i + 1] > 170 && px[i + 2] < 80) n++;
  return n;
}

const ROWS = JSON.stringify(['Café Lirandel — 12 kg', 'Selowa Ridge — 6 kg']);

beforeAll(async () => {
  server = await startServer({
    '/': app(false),
    '/focus': app(false),
    '/busy': app(true),
    '/api/rows': { body: ROWS, type: 'application/json', delay_ms: 1200 },
    '/api/rows-late': { body: ROWS, type: 'application/json', delay_ms: 1000 },
    '/api/fast': { body: '{}', type: 'application/json', delay_ms: 80 },
    '/api/save': { body: '{}', type: 'application/json', delay_ms: 600 },
    '/api/ping': { body: '{}', type: 'application/json' },
  });
  dir = await tempDir('rw-route-');
  const project = makeProject(dir, { app: server.url });
  const click = (id: string) => ({ click: { css: `#${id}` } });
  const scene = (id: string, open: string, steps: unknown[]) => ({ id, page: 'app', open, steps: [...steps, { hold: 0.3 }] });
  const scenario = makeScenario('routes', {
    pacing: { ...FAST, after_navigation_ms: 600 },
    scenes: [
      scene('quotes', '/', [click('to-quotes')]),
      scene('query', '/', [click('to-query')]),
      scene('hash', '/', [click('to-hash')]),
      scene('scrolled', '/', [{ scroll: { to: { css: '#setup' } } }]),
      scene('typed', '/', [{ type: { into: { css: '#q' }, text: 'abc' } }]),
      scene('stuck', '/', [click('to-stuck')]),
      scene('pulse', '/', [click('to-pulse')]),
      scene('late', '/', [click('to-late')]),
      scene('slide', '/', [click('to-slide')]),
      scene('search', '/', [{ type: { into: { css: '#search' }, text: 'roast', enter: true } }]),
      scene('focused', '/focus', [{ press: 'Enter' }]),
      scene('later', '/', [click('to-later'), click('far')]),
      scene('busy-quotes', '/busy', [click('to-quotes')]),
      scene('busy-plain', '/busy', [click('to-plain')]),
      // A plain wait, or a wait with a hold, after the click: the route is held all the same.
      scene('waited', '/', [click('to-quotes'), { wait_for: { text: 'Selowa Ridge' } }]),
      scene('waited-hold', '/', [click('to-quotes'), { wait_for: { text: 'Selowa Ridge' }, hold: 0.4 }]),
      // The scenario films the wait on purpose (a marked wait): not held.
      scene('filmed', '/', [click('to-quotes'), { wait_for: { text: 'Selowa Ridge' }, mark: 'rows' }]),
    ],
  } as never);
  const rec = await runScenario(inRunsOf({ policy: PERSON_POLICY, project, scenario, template: debugTemplate(), mode: 'capture', runId: `routes-${Date.now()}` }));
  expect(rec.error?.message).toBeUndefined();
  tl = await readTimeline(rec.timeline!);
  runDir = rec.dir;
}, 300_000);

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const sceneOf = (t: number) => tl.scenes.find((s) => s.kind === 'scene' && t < s.t_end)!;
const routeHolds = (scene: string): TimelineLoading[] => (tl.loading ?? []).filter((l) => l.same_document === true && sceneOf(l.t_start)?.id === scene);
const stepOf = (scene: string, step = 0) => tl.events.find((e) => e.scene === scene && e.step === step)!;
/** The route's page segment: when the route changed. */
const routeAt = (scene: string) => {
  const s = tl.scenes.find((x) => x.id === scene)!;
  return tl.pages.filter((p) => p.t_start > stepOf(scene).t_start && p.t_start < s.t_end)[0]!.t_start;
};
const frames = async () =>
  (await readFile(join(runDir, 'frames.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x) as { file: string; t: number });

describe('client-side route changes in the capture (R-ISS-14)', () => {
  it('a click that changes the route films no skeleton: the held span ends ready, the press stays on screen before it', async () => {
    expect(TimelineSchema.safeParse(tl).success).toBe(true);
    const [l] = routeHolds('quotes');
    expect(l, JSON.stringify(tl.loading)).toMatchObject({ until: 'ready', same_document: true, page: 'app' });
    const click = stepOf('quotes');
    // The record starts after the press's feedback, and covers the data request (1.2 s); the skeleton's part is noted.
    expect(l.t_start).toBeGreaterThanOrEqual(click.t_click! + ROUTE_PRESS_KEEP_MS / 1000 - 0.02);
    expect(l.t_end - click.t_click!).toBeGreaterThan(1.2);
    expect(l.t_end - click.t_click!).toBeLessThan(ROUTE_HOLD_MAX_MS / 1000);
    expect(l.indicator!.t_end - l.indicator!.t_start).toBeGreaterThan(0.8);
    // The click step ends on the ready route; no wait after it is left to shorten.
    expect(click.t_end).toBeGreaterThan(l.t_end);
    expect((tl.busy ?? []).filter((b) => b.t_start >= click.t_click! && b.t_start < click.t_end)).toEqual([]);
    // No kept frame of the scene shows the skeleton.
    const scene = tl.scenes.find((s) => s.id === 'quotes')!;
    const shown = (await frames()).filter((f) => f.t >= click.t_click! && f.t < scene.t_end);
    expect(shown.length).toBeGreaterThan(3);
    expect(shown.filter((f) => yellow(join(runDir, 'frames', f.file)) > 20).map((f) => f.t)).toEqual([]);
  });

  it('held like a path: a `#/` hash route, textless animate-pulse placeholders, an Enter in a search box, press: Enter on a link, a click before a plain or holding wait', () => {
    for (const s of ['hash', 'pulse', 'search', 'focused', 'waited', 'waited-hold']) {
      const [l] = routeHolds(s);
      expect(l, s).toMatchObject({ until: 'ready' });
      // Each waited for its rows (1.2 s), not only for the first poll.
      expect(l.t_end - routeAt(s), s).toBeGreaterThan(1.1);
    }
  });

  it('the data that comes 400 ms after the skeleton went is waited for: the network was not quiet yet', () => {
    const [l] = routeHolds('late');
    expect(l).toMatchObject({ until: 'ready' });
    expect(l.t_end - routeAt('late')).toBeGreaterThan(1.0);
    expect(l.indicator!.t_end - routeAt('late')).toBeLessThan(0.85);
  });

  it('never held: a query-only change, a path rewritten while scrolling or pushed while typing, a wait the scenario marks', () => {
    expect(routeHolds('query')).toEqual([]);
    expect(routeHolds('scrolled')).toEqual([]);
    expect(routeHolds('typed')).toEqual([]);
    expect(routeHolds('filmed')).toEqual([]);
  });

  it('a route that changes after the pressing step returned is not held: nothing lands in the next step', () => {
    const next = stepOf('later', 1);
    expect(routeHolds('later')).toEqual([]);
    expect((tl.loading ?? []).filter((l) => l.t_start < next.t_end && l.t_end > next.t_start)).toEqual([]);
  });

  it('a header spinner and a page polling every 200 ms never hold a route to the limit; with no indicator the route is ready at once', () => {
    const [plain] = routeHolds('busy-plain');
    // Nothing the route brought ever showed: no indicator, nothing the edit cuts.
    expect(plain === undefined || (plain.until === 'ready' && plain.indicator === undefined && plain.t_end - plain.t_start < 0.15), JSON.stringify(plain)).toBe(true);
    const [q] = routeHolds('busy-quotes');
    expect(q).toMatchObject({ until: 'ready' });
    expect(tl.warnings.filter((w) => /^busy-/.test(w))).toEqual([]);
  });

  it('a route ready after an 80 ms fetch films its rows sliding in', async () => {
    const at = routeAt('slide');
    const [l] = routeHolds('slide');
    expect(l === undefined || l.t_end - at < 0.3, JSON.stringify(l)).toBe(true);
    // Frames keep coming while the rows slide (0.6 s).
    expect((await frames()).filter((f) => f.t > at + 0.25 && f.t < at + 0.75).length).toBeGreaterThan(5);
  });

  it('a route still showing its skeleton after 3 s is shown as it is, with a run warning naming it', () => {
    const [l] = routeHolds('stuck');
    expect(l).toMatchObject({ until: 'limit' });
    expect(tl.warnings).toContainEqual(expect.stringMatching(/^stuck\.0: the route its press opened at [\d.]+ s still showed a loading indicator \(skeleton ×3\) 3 s after it changed: shown as it is/));
    expect(tl.warnings.filter((w) => /^(quotes|hash|pulse)\.0/.test(w))).toEqual([]);
  });
});
