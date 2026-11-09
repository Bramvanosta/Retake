/**
 * L2.9 runner: wait_for_email (Mailpit API, baseline of the messages already there, cid images, HTML rendered to a
 * PNG), download (download event and a document opened in a new tab with the session's cookies; PDFs rasterised with
 * pdf.js in Chromium at 2× A4), web notifications (Notification + ServiceWorkerRegistration.showNotification, icon
 * fetched with the session) and project documents named by slots.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { TimelineSchema, PERSON_POLICY } from '@retake/core';
import type { DocumentArtefact, EmailArtefact, NotificationArtefact, Timeline } from '@retake/core';
import { imageSize, mailMatches, parseAddress, runScenario, sandboxedEmail, sniffMime } from '../src/index.js';
import { FAST, makeProject, makeScenario, readTimeline, tempDir } from './helpers.js';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#6e1f2b"/></svg>';

interface Msg {
  ID: string;
  From: { Name: string; Address: string };
  To: Array<{ Name: string; Address: string }>;
  Subject: string;
  Created: string;
  HTML: string;
  Text: string;
}

let pdf: Buffer;
let server: { url: string; close: () => Promise<void> };
let dir: string;
const messages: Msg[] = [];
let cookieSeen = '';

function addMessage(subject: string, to: string): void {
  const id = `m${messages.length + 1}`;
  messages.unshift({
    ID: id,
    From: { Name: 'Northfield', Address: 'hello@northfield.example' },
    To: [{ Name: '', Address: to }],
    Subject: subject,
    Created: new Date().toISOString(),
    HTML: `<html><body style="font-family:sans-serif"><h1 style="color:#6e1f2b">${subject}</h1><p>Welcome aboard.</p><img src="cid:logo@x" width="40" height="40"><img src="https://tracker.example.com/p.gif"><script>document.body.innerHTML='hacked'</script></body></html>`,
    Text: `${subject}\n\nWelcome aboard. Confirm your address within 24 hours.`,
  });
}

const APP = `<!doctype html><html><head><title>App</title></head><body style="font-family:sans-serif;padding:40px">
<button id="signup" onclick="fetch('/signup',{method:'POST'}).then(()=>{document.getElementById('done').textContent='Check your inbox'})">Create account</button>
<p id="done"></p>
<p><a id="dl" href="/files/quote.pdf">Download quote PDF</a></p>
<p><a id="tab" href="/files/view.pdf" target="_blank">Open the terms</a></p>
<p><button id="notify" onclick="new Notification('New quote request', {body: 'Café Lumen asks for 10 bags', icon: '/icon.svg', tag: 'quote-request'})">Notify</button></p>
<p><button id="sw" onclick="navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(r=>r.showNotification('Order shipped',{body:'Your order is on its way'})).then(()=>{document.getElementById('swdone').textContent='sent'})">Notify via worker</button><span id="swdone"></span></p>
<script>document.cookie = 'session=s3cret; path=/';</script>
</body></html>`;

beforeAll(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<h1 style="font-family:sans-serif">Quotation Q-2041</h1><p>Total €720.00</p><div style="page-break-after:always"></div><h2>Terms</h2>');
  pdf = await page.pdf({ format: 'A4', printBackground: true });
  await browser.close();
  addMessage('Welcome back (old message)', 'buyer@cafe.example');
  const srv = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const json = (v: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (path === '/app.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(APP);
    }
    if (path === '/signup' && req.method === 'POST') {
      setTimeout(() => addMessage('Confirm your email', 'buyer@cafe.example'), 400);
      return json({ ok: true });
    }
    if (path === '/files/quote.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Quote_Q-2041.pdf"' });
      return res.end(pdf);
    }
    if (path === '/files/view.pdf') {
      cookieSeen = String(req.headers.cookie ?? '');
      // Only with the session cookie (the runner must fetch with the page's context).
      if (!cookieSeen.includes('session=s3cret')) {
        res.writeHead(403);
        return res.end('no session');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body><h1>Terms of sale</h1><p>Payment 30 days net.</p></body></html>');
    }
    if (path === '/icon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(ICON);
    }
    if (path === '/sw.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end('self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));');
    }
    if (path === '/mailpit/api/v1/messages') return json({ total: messages.length, messages: messages.map(({ HTML: _h, Text: _t, ...m }) => m) });
    const one = /^\/mailpit\/api\/v1\/message\/([^/]+)$/.exec(path);
    if (one) {
      const m = messages.find((x) => x.ID === one[1]);
      return json({ ...m, Date: m?.Created, Cc: [], Inline: [{ PartID: '2', ContentID: 'logo@x', ContentType: 'image/png', FileName: 'logo.png' }] });
    }
    if (/^\/mailpit\/api\/v1\/message\/[^/]+\/part\/2$/.test(path)) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG_1PX);
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  server = {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))),
  };
  dir = await tempDir('rw-artefacts-');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await copyFile(join(dir, '..', 'missing'), join(dir, 'x')).catch(() => undefined);
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('helpers', () => {
  it('parse addresses and match filters', () => {
    expect(parseAddress('Northfield <hello@northfield.example>')).toEqual({ name: 'Northfield', address: 'hello@northfield.example' });
    expect(parseAddress({ Name: '', Address: 'a@b.c' })).toEqual({ address: 'a@b.c' });
    const m = { from: { name: 'Northfield', address: 'hello@n.example' }, to: [{ address: 'buyer@cafe.example' }], subject: 'Confirm your email' };
    expect(mailMatches(m, { to: 'CAFE.example', subject: 'confirm' })).toBe(true);
    expect(mailMatches(m, { from: 'northfield', subject: '/^Confirm/' })).toBe(true);
    expect(mailMatches(m, { subject: '/^confirm/' })).toBe(false);
    expect(mailMatches(m, { to: 'other@' })).toBe(false);
  });

  it('sniff types and sizes, sandbox email HTML', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMime(PNG_1PX)).toBe('image/png');
    expect(sniffMime(Buffer.from(ICON))).toBe('image/svg+xml');
    expect(imageSize(PNG_1PX, 'image/png')).toEqual({ width: 1, height: 1 });
    const html = sandboxedEmail('<html><head><title>x</title></head><body>hi</body></html>');
    expect(html).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:;/);
  });
});

describe('a run with a mailbox, downloads and notifications', () => {
  let tl: Timeline;
  let runDir: string;

  beforeAll(async () => {
    await mkdir(join(dir, 'assets'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'assets', 'terms.pdf'), pdf);
    const project = makeProject(dir, { app: server.url });
    project.config.mailbox = { provider: 'mailpit', url: `${server.url}/mailpit`, poll_ms: 150 };
    const rec = await runScenario({ policy: PERSON_POLICY,
      project,
      scenario: makeScenario('artefacts', {
        pacing: FAST,
        scenes: [
          {
            id: 'flow',
            open: '/app.html',
            steps: [
              { click: { css: '#signup' } },
              { wait_for_email: { to: 'buyer@cafe.example', subject: 'Confirm', timeout: 10, as: 'welcome' } },
              { download: { click: { css: '#dl' }, as: 'quote' } },
              { download: { click: { css: '#tab' }, as: 'terms' } },
              { click: { css: '#notify' } },
              { click: { css: '#sw' } },
              { wait_for: { text: 'sent' } },
              { wait: 0.3 },
            ],
          },
          { card: { component: 'studio/document-pdf', slots: { document: 'assets/terms.pdf' } } },
        ],
      }),
      mode: 'dry',
      runId: `artefacts-${Date.now()}`,
    });
    expect(rec.status, JSON.stringify(rec.error)).toBe('succeeded');
    runDir = rec.dir;
    tl = await readTimeline(rec.timeline!);
  }, 120_000);

  it('the timeline validates and lists every artefact', () => {
    const r = TimelineSchema.safeParse(tl);
    expect(r.success, JSON.stringify(r.error?.issues?.slice(0, 3))).toBe(true);
    expect((tl.artefacts ?? []).map((a) => `${a.kind}:${a.name}`).sort()).toEqual(
      ['document:assets/terms.pdf', 'document:quote', 'document:terms', 'email:welcome', 'notification:notification-2', 'notification:quote-request'].sort(),
    );
  });

  it('wait_for_email takes the NEW message, renders its HTML sandboxed at 600 px (×2) and keeps the data', async () => {
    const e = tl.artefacts!.find((a): a is EmailArtefact => a.kind === 'email')!;
    expect(e.subject).toBe('Confirm your email');
    expect(e.from).toBe('hello@northfield.example');
    expect(e.from_name).toBe('Northfield');
    expect(e.to).toEqual(['buyer@cafe.example']);
    expect(e.preview).toMatch(/^Confirm your email Welcome aboard/);
    expect(e.image?.width).toBe(1200);
    const png = await readFile(join(runDir, e.image!.file));
    expect(imageSize(png, 'image/png')).toEqual({ width: e.image!.width, height: e.image!.height });
    const json = JSON.parse(await readFile(join(runDir, e.file), 'utf8')) as { html: string; text: string };
    expect(json.html).toContain('data:image/png;base64,');
    expect(json.html).not.toContain('cid:logo@x');
    const ev = tl.events.find((x) => x.action === 'wait_for_email')!;
    expect(ev.data).toMatchObject({ artefact: 'email', name: 'welcome', subject: 'Confirm your email' });
  });

  it('download: the download event, rasterised page by page at 2× A4', async () => {
    const d = tl.artefacts!.find((a): a is DocumentArtefact => a.kind === 'document' && a.name === 'quote')!;
    expect(d).toMatchObject({ via: 'download', mime: 'application/pdf', file_name: 'Quote_Q-2041.pdf' });
    expect(d.file).toBe('artefacts/documents/quote.pdf');
    expect(d.pages.length).toBe(2);
    // 2× A4 at 96 dpi ≈ 1587 × 2245 px (Chromium's A4 is 8.27 × 11.7 in: a pixel or two more).
    expect(d.pages[0].file).toBe('artefacts/documents/quote/page-1.png');
    expect(Math.abs(d.pages[0].width - 1587)).toBeLessThanOrEqual(4);
    expect(Math.abs(d.pages[0].height - 2245)).toBeLessThanOrEqual(4);
    expect(Math.abs(d.pages[0].width_pt - 595.28)).toBeLessThan(2);
    expect(existsSync(join(runDir, d.pages[1].file))).toBe(true);
    const ev = tl.events.find((x) => x.action === 'download' && (x.data as { name: string }).name === 'quote')!;
    expect(ev.target?.bbox).toBeTruthy();
    expect(ev.t_click).toBeGreaterThan(0);
  });

  it('download: a document opened in a new tab is fetched with the session cookies and the tab is closed', () => {
    const d = tl.artefacts!.find((a): a is DocumentArtefact => a.kind === 'document' && a.name === 'terms')!;
    expect(d).toMatchObject({ via: 'tab', mime: 'text/html', file_name: 'view.pdf' });
    expect(cookieSeen).toContain('session=s3cret');
    expect(tl.warnings.join('\n')).toMatch(/only PDFs and images can be shown/);
  });

  it('web notifications: Notification and showNotification, icon fetched, event in the scene', async () => {
    const ns = tl.artefacts!.filter((a): a is NotificationArtefact => a.kind === 'notification').sort((a, b) => a.index - b.index);
    expect(ns[0]).toMatchObject({ name: 'quote-request', index: 1, title: 'New quote request', body: 'Café Lumen asks for 10 bags', tag: 'quote-request', via: 'Notification', scene: 'flow' });
    expect(ns[0].icon?.width).toBe(192);
    expect(existsSync(join(runDir, ns[0].icon!.file))).toBe(true);
    expect(ns[1]).toMatchObject({ name: 'notification-2', title: 'Order shipped', via: 'ServiceWorkerRegistration.showNotification' });
    const evs = tl.events.filter((e) => e.action === 'notification');
    expect(evs.map((e) => (e.data as { name: string }).name)).toEqual(['quote-request', 'notification-2']);
    expect(evs.every((e) => e.step === -1 && e.scene === 'flow')).toBe(true);
    const click = tl.events.find((e) => e.action === 'click' && e.step === 4)!;
    expect(evs[0].t_start).toBeGreaterThanOrEqual(click.t_start);
  });

  it('project documents named by slots are rasterised too', () => {
    const d = tl.artefacts!.find((a): a is DocumentArtefact => a.kind === 'document' && a.name === 'assets/terms.pdf')!;
    expect(d).toMatchObject({ via: 'project', t: 0 });
    expect(d.pages.length).toBe(2);
  });
});
