/**
 * Web notifications within limits: only a page's own document reports (a frame inside it is ignored, for the cursor
 * too), the payload is checked and cut, a run keeps at most 50 notifications and reads at most 20 icons, and an icon is
 * a data: URL of at most 1 MiB or an http(s) URL of the notifying page's origin or the environment's, fetched without
 * following a redirect and cut off beyond 1 MiB. The cursor binding takes finite times and points only, and at most
 * CURSOR_EFFECTS_PER_SECOND effects from a page in a second (one warning).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationArtefact, Timeline } from '@retake/core';
import { runScenario } from '../src/index.js';
import { iconRefusal, NOTIFICATION_ICON_MAX_BYTES, NOTIFICATION_ICON_RUN_MAX, NOTIFICATION_RUN_MAX } from '../src/notifications.js';
import { NOTIFICATION_TEXT_MAX, readNotificationPayload } from '../src/session.js';
import { CURSOR_EFFECTS_PER_SECOND } from '../src/runtime.js';
import { FAST, makeProject, makeScenario, readTimeline, tempDir } from './helpers.js';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1f4e6e"/></svg>';

interface Srv {
  url: string;
  /** Paths the runner requested (without the query): the browser itself, which loads a notification's icon too, is left out. */
  hits: string[];
  close: () => Promise<void>;
}

async function serve(handle: (path: string, res: import('node:http').ServerResponse) => void): Promise<Srv> {
  const hits: string[] = [];
  const srv = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    // The browser's own loads say what they are for (`sec-fetch-dest`); a fetch by the runner does not.
    if (req.headers['sec-fetch-dest'] === undefined) hits.push(path);
    handle(path, res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))) };
}

function svg(res: import('node:http').ServerResponse): void {
  res.writeHead(200, { 'content-type': 'image/svg+xml' });
  res.end(ICON);
}

const valid = { via: 'Notification', title: 't', body: 'b', time: Date.now(), url: 'http://x.example/', origin: 'http://x.example' };

describe('the notification payload', () => {
  it('a payload of the wrong types is ignored; the URL and origin are the frame’s, not the payload’s', () => {
    expect(readNotificationPayload(valid, 'http://127.0.0.1:4971/app')).toMatchObject({ title: 't', body: 'b', url: 'http://127.0.0.1:4971/app', origin: 'http://127.0.0.1:4971' });
    for (const bad of [null, 'x', [], { ...valid, via: 'Other' }, { ...valid, title: 42 }, { ...valid, body: {} }, { ...valid, tag: 1 }, { ...valid, icon: [] }, { ...valid, time: 'now' }, { ...valid, time: Number.NaN }, { ...valid, time: 1e20 }]) {
      expect(readNotificationPayload(bad, 'http://127.0.0.1:4971/')).toBeNull();
    }
  });

  it('title, body and tag are cut at the limit; an over-long icon URL is dropped', () => {
    const long = 'x'.repeat(10_000);
    const n = readNotificationPayload({ ...valid, title: long, body: long, tag: long, icon: `http://127.0.0.1:4971/${long}` }, 'http://127.0.0.1:4971/')!;
    expect(n.title.length).toBe(NOTIFICATION_TEXT_MAX);
    expect(n.body.length).toBe(NOTIFICATION_TEXT_MAX);
    expect(n.tag!.length).toBe(NOTIFICATION_TEXT_MAX);
    expect(n.title.endsWith('…')).toBe(true);
    expect(n.icon).toBeUndefined();
    expect(n.iconTooLong).toBe(true);
    const ok = readNotificationPayload({ ...valid, icon: `data:image/png;base64,${'A'.repeat(1_000_000)}` }, 'http://127.0.0.1:4971/')!;
    expect(ok.icon?.length).toBe(1_000_022);
  });

  it('an icon is read from a data: URL or an http(s) URL of the allowed origins only', () => {
    const origins = ['http://127.0.0.1:4971', 'http://localhost:4972'];
    expect(iconRefusal('data:image/png;base64,AAAA', origins)).toBeNull();
    expect(iconRefusal('http://127.0.0.1:4971/icon.svg', origins)).toBeNull();
    expect(iconRefusal('http://LOCALHOST:4972/i.png', origins)).toBeNull();
    expect(iconRefusal('http://127.0.0.1:4973/icon.svg', origins)).toMatch(/neither the notifying page's origin/);
    expect(iconRefusal('https://127.0.0.1:4971/icon.svg', origins)).toMatch(/neither/);
    for (const other of ['file:///etc/hosts', 'blob:http://127.0.0.1:4971/x', 'chrome://favicon/x', 'ftp://127.0.0.1:4971/i']) expect(iconRefusal(other, origins)).toMatch(/only from a data: URL or an http\(s\) URL/);
  });
});

describe('a run whose pages notify', () => {
  let app: Srv;
  let assets: Srv;
  let other: Srv;
  let dir: string;

  beforeAll(async () => {
    other = await serve((path, res) => {
      if (path === '/child.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        // A frame inside the page: its calls to the bindings (direct or through the kit) are ignored.
        return res.end(`<!doctype html><body><script>
addEventListener('message', () => {
  try { new Notification('from the frame', { body: 'kit' }); } catch {}
  try { window.__retakeNotification({ via: 'Notification', title: 'frame direct', body: '', time: Date.now(), url: location.href, origin: location.origin }); } catch {}
  try { window.__retakeCursor({ type: 'ripple', time: Date.now(), x: 7777, y: 7777 }); } catch {}
  parent.postMessage('frame-done', '*');
});
</script></body>`);
      }
      if (path === '/icon.svg') return svg(res);
      res.writeHead(404);
      res.end();
    });
    assets = await serve((path, res) => {
      if (path === '/icon.svg') return svg(res);
      res.writeHead(404);
      res.end();
    });
    app = await serve((path, res) => {
      if (path === '/icon.svg') return svg(res);
      if (path === '/redirect-icon') {
        res.writeHead(302, { location: `${other.url}/icon.svg` });
        return res.end();
      }
      if (path === '/big-declared.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': String(NOTIFICATION_ICON_MAX_BYTES + 10) });
        return res.end(Buffer.alloc(NOTIFICATION_ICON_MAX_BYTES + 10, 0x20));
      }
      if (path === '/big-chunked.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        for (let i = 0; i < 40; i++) res.write(chunk);
        return res.end(ICON);
      }
      if (path === '/app.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        const big = `data:image/png;base64,${'A'.repeat(1_430_000)}`;
        return res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:20px">
<iframe id="f" src="${other.url}/child.html" width="200" height="60"></iframe>
<p><button id="frame" onclick="document.getElementById('f').contentWindow.postMessage('go','*')">Frame</button><span id="fd"></span></p>
<p><button id="direct" onclick="window.__retakeNotification({via:'Notification',title:'direct',body:'main',time:Date.now(),url:'http://elsewhere.example/',origin:'http://elsewhere.example'});window.__retakeNotification({via:'Notification',title:42,body:'',time:Date.now()});window.__retakeNotification({via:'Popup',title:'bad via',body:'',time:Date.now()});window.__retakeCursor({type:'ripple',time:Date.now(),x:6666,y:6666});document.getElementById('dd').textContent='direct-done'">Direct</button><span id="dd"></span></p>
<p><button id="long" onclick="new Notification('L'.repeat(10000),{body:'B'.repeat(10000),tag:'T'.repeat(5000)})">Long</button></p>
<p><button id="good" onclick="new Notification('same origin',{icon:'/icon.svg',tag:'good'})">Good</button></p>
<p><button id="env" onclick="new Notification('environment origin',{icon:'${assets.url}/icon.svg',tag:'env'})">Env</button></p>
<p><button id="cross" onclick="new Notification('other origin',{icon:'${other.url}/icon.svg',tag:'cross'})">Cross</button></p>
<p><button id="redir" onclick="new Notification('redirected',{icon:'/redirect-icon',tag:'redir'})">Redirect</button></p>
<p><button id="bigdata" onclick="new Notification('big data',{icon:'${big}',tag:'bigdata'})">Big data</button></p>
<p><button id="bigdecl" onclick="new Notification('big declared',{icon:'/big-declared.svg',tag:'bigdecl'})">Big declared</button></p>
<p><button id="bigchunk" onclick="new Notification('big chunked',{icon:'/big-chunked.svg',tag:'bigchunk'})">Big chunked</button></p>
<p><button id="many" onclick="for(let i=0;i<60;i++)new Notification('n'+i,{icon:'/icon.svg?i='+i,tag:'many-'+i});document.getElementById('md').textContent='many-done'">Many</button><span id="md"></span></p>
<p><button id="cursor-odd" onclick="const c=window.__retakeCursor;c({type:'ripple',time:NaN,x:4001,y:1});c({type:'icon',time:Infinity,icon:'hand'});c({type:'ripple',time:Date.now(),x:Infinity,y:4002});c(null);c('ripple');document.getElementById('cod').textContent='odd-done'">Odd</button><span id="cod"></span></p>
<p><button id="cursor-burst" onclick="setTimeout(()=>{for(let i=0;i<300;i++)window.__retakeCursor({type:'ripple',time:Date.now(),x:5000+i,y:5000});document.getElementById('cbd').textContent='burst-done'},50)">Burst</button><span id="cbd"></span></p>
<script>addEventListener('message', (e) => { if (e.data === 'frame-done') document.getElementById('fd').textContent = 'frame-done'; });</script>
</body></html>`);
      }
      res.writeHead(404);
      res.end();
    });
    dir = await tempDir('rw-notifications-');
  }, 60_000);

  afterAll(async () => {
    await Promise.all([app?.close(), assets?.close(), other?.close()]);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function run(name: string, steps: unknown[]): Promise<{ tl: Timeline; runDir: string; ns: NotificationArtefact[] }> {
    const project = makeProject(dir, { app: app.url, assets: assets.url });
    const rec = await runScenario({
      project,
      scenario: makeScenario(name, { pacing: FAST, scenes: [{ id: 'flow', open: '/app.html', steps: steps as never }] }),
      mode: 'dry',
      runId: `${name}-${Date.now()}`,
    });
    expect(rec.status, JSON.stringify(rec.error)).toBe('succeeded');
    const tl = await readTimeline(rec.timeline!);
    const ns = (tl.artefacts ?? []).filter((a): a is NotificationArtefact => a.kind === 'notification').sort((a, b) => a.index - b.index);
    return { tl, runDir: rec.dir, ns };
  }

  describe('the rules', () => {
    let tl: Timeline;
    let runDir: string;
    let ns: NotificationArtefact[];
    const hitsBefore = { other: 0, assets: 0 };

    beforeAll(async () => {
      hitsBefore.other = other.hits.length;
      hitsBefore.assets = assets.hits.length;
      ({ tl, runDir, ns } = await run('notify-rules', [
        { click: { css: '#frame' } },
        { wait_for: { text: 'frame-done' } },
        { click: { css: '#direct' } },
        { wait_for: { text: 'direct-done' } },
        ...['#long', '#good', '#env', '#cross', '#redir', '#bigdata', '#bigdecl', '#bigchunk'].map((css) => ({ click: { css } })),
        { wait: 0.5 },
      ]));
    }, 120_000);

    const byTag = (tag: string) => ns.find((n) => n.tag === tag);

    it('a call from a frame inside the page is ignored, for the notification and the cursor', () => {
      expect(ns.map((n) => n.title)).not.toContain('frame direct');
      expect(ns.map((n) => n.title)).not.toContain('from the frame');
      const ripples = (tl.cursor_effects ?? []).filter((e) => e.type === 'ripple');
      expect(ripples.some((e) => e.x === 6666)).toBe(true);
      expect(ripples.some((e) => e.x === 7777)).toBe(false);
    });

    it('a payload of the wrong types is ignored; the origin recorded is the page’s', () => {
      const direct = ns.filter((n) => n.title === 'direct');
      expect(direct).toHaveLength(1);
      expect(direct[0].origin).toBe(app.url);
      expect(ns.map((n) => n.title)).not.toContain('bad via');
      expect(ns.some((n) => (n.title as unknown) === 42 || n.title === '42')).toBe(false);
    });

    it('title, body and tag are cut at the limit', () => {
      const long = ns.find((n) => n.title.startsWith('LLL'))!;
      expect(long.title.length).toBe(NOTIFICATION_TEXT_MAX);
      expect(long.body.length).toBe(NOTIFICATION_TEXT_MAX);
      expect(long.tag!.length).toBe(NOTIFICATION_TEXT_MAX);
    });

    it('an icon of the page’s origin or the environment’s is read', () => {
      expect(byTag('good')?.icon?.file).toBeTruthy();
      expect(existsSync(join(runDir, byTag('good')!.icon!.file))).toBe(true);
      expect(byTag('env')?.icon?.file).toBeTruthy();
      expect(assets.hits.slice(hitsBefore.assets)).toContain('/icon.svg');
    });

    it('an icon of another origin (another port of localhost) is never requested; the artefact keeps its URL', () => {
      expect(other.hits.slice(hitsBefore.other).filter((p) => p === '/icon.svg')).toEqual([]);
      expect(byTag('cross')).toMatchObject({ icon_url: `${other.url}/icon.svg` });
      expect(byTag('cross')?.icon).toBeUndefined();
      expect(tl.warnings.some((w) => w.includes('"other origin"') && /is not fetched \(.*neither the notifying page's origin/.test(w))).toBe(true);
    });

    it('a redirect is not followed', () => {
      expect(byTag('redir')?.icon).toBeUndefined();
      expect(tl.warnings.some((w) => w.includes('"redirected"') && w.includes('a redirect is not followed'))).toBe(true);
    });

    it('an icon beyond 1 MiB is refused: a data: URL decoded, a declared or a streamed response', () => {
      for (const tag of ['bigdata', 'bigdecl', 'bigchunk']) expect(byTag(tag)?.icon, tag).toBeUndefined();
      expect(tl.warnings.some((w) => w.includes('"big data"') && w.includes(`more than ${NOTIFICATION_ICON_MAX_BYTES}`))).toBe(true);
      expect(tl.warnings.some((w) => w.includes('"big declared"') && w.includes(`it is ${NOTIFICATION_ICON_MAX_BYTES + 10} bytes`))).toBe(true);
      expect(tl.warnings.some((w) => w.includes('"big chunked"') && w.includes(`more than ${NOTIFICATION_ICON_MAX_BYTES} bytes`))).toBe(true);
      // A warning shows a data: URL by its size, never its text.
      expect(tl.warnings.every((w) => w.length < 2_000)).toBe(true);
    });

    it('the artefacts are written as recorded', async () => {
      const a = JSON.parse(await readFile(join(runDir, byTag('good')!.file), 'utf8')) as NotificationArtefact;
      expect(a).toMatchObject({ title: 'same origin', origin: app.url, icon_url: `${app.url}/icon.svg` });
    });
  });

  it(`a run keeps ${NOTIFICATION_RUN_MAX} notifications and reads ${NOTIFICATION_ICON_RUN_MAX} icons, with one warning each`, async () => {
    const before = app.hits.length;
    const { tl, ns } = await run('notify-caps', [{ click: { css: '#many' } }, { wait_for: { text: 'many-done' } }, { wait: 0.5 }]);
    expect(ns).toHaveLength(NOTIFICATION_RUN_MAX);
    expect(app.hits.slice(before).filter((p) => p === '/icon.svg')).toHaveLength(NOTIFICATION_ICON_RUN_MAX);
    expect(ns.filter((n) => n.icon).length).toBe(NOTIFICATION_ICON_RUN_MAX);
    expect(ns.filter((n) => !n.icon).every((n) => n.icon_url?.includes('/icon.svg?i='))).toBe(true);
    expect(tl.warnings.filter((w) => w.includes(`more than ${NOTIFICATION_RUN_MAX} notifications`))).toHaveLength(1);
    expect(tl.warnings.filter((w) => w.includes(`more than ${NOTIFICATION_ICON_RUN_MAX} icons`))).toHaveLength(1);
    expect(tl.events.filter((e) => e.action === 'notification')).toHaveLength(NOTIFICATION_RUN_MAX);
  }, 120_000);

  it(`the cursor binding takes finite times and points only, and at most ${CURSOR_EFFECTS_PER_SECOND} effects from a page in a second, with one warning`, async () => {
    const { tl } = await run('cursor-caps', [
      { click: { css: '#cursor-odd' } },
      { wait_for: { text: 'odd-done' } },
      { wait: 1.1 },
      { click: { css: '#cursor-burst' } },
      { wait_for: { text: 'burst-done' } },
      { wait: 0.3 },
    ]);
    const effects = tl.cursor_effects ?? [];
    expect(effects.every((e) => Number.isFinite(e.t))).toBe(true);
    expect(effects.some((e) => e.x === 4001)).toBe(false);
    expect(effects.some((e) => e.type === 'icon' && e.icon === 'hand' && !Number.isFinite(e.t))).toBe(false);
    expect(effects.every((e) => e.x === undefined || Number.isFinite(e.x))).toBe(true);
    const burst = effects.filter((e) => e.type === 'ripple' && typeof e.x === 'number' && e.x >= 5000);
    expect(burst.length).toBeGreaterThan(0);
    expect(burst.length).toBeLessThanOrEqual(2 * CURSOR_EFFECTS_PER_SECOND);
    expect(tl.warnings.filter((w) => w.includes(`more than ${CURSOR_EFFECTS_PER_SECOND} cursor effects in a second`))).toHaveLength(1);
  }, 120_000);
});
