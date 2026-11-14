/**
 * L5.6 — capture reliability (R-FLD-10 – R-FLD-16): a take fails early, loudly and completely, never silently wrong.
 * `type` into a field below the fold of a scrolling modal dialog whose page behind holds a field of the same label,
 * a field a calendar covers (the focus check fails before typing), a field that loses the focus (value warning); every
 * missing target of a scene in one error; dead clicks reported at once and `retry_click`; transient download failures
 * retried, real ones not; `defaults.timeout_s`; persona mail addresses and mailbox diagnostics; failed optional steps
 * in the run result; `capture.step_shots`.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { EmailArtefact, LoadedProject, RunProgress, RunRecord, Scenario, TimelineEvent } from '@retake/core';
import { runScenario } from '../src/index.js';
import type { RunOptions } from '../src/index.js';
import { FAST, makeScenario } from '@retake/test-support/capture';
import { makeProject, readTimeline, tempDir } from './helpers.js';
import { PERSON_POLICY } from '@retake/core';
// Calibrated on the Mac Retake is made for (frame rates, freezes, paint and wait timings): skipped on a shared CI
// runner, where ci.yml sets RETAKE_TEST_SHARED_RUNNER=1 (fewer cores, no GPU).
const MAC_TIMING = process.env.RETAKE_TEST_SHARED_RUNNER !== '1';

const CSS = `*{box-sizing:border-box} body{margin:0;font:15px/1.4 system-ui,sans-serif;background:#f6f3ef}
button{font:inherit;padding:8px 14px;border:1px solid #c9bfb7;border-radius:8px;background:#fff;cursor:pointer}
input{font:inherit;padding:4px 8px;width:300px;height:30px} label{display:block;font-weight:600}`;
const page = (title: string, body: string, script = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>${body}<script>${script}</script></body></html>`;

/**
 * A modal dialog whose body scrolls, over a page holding a "Quantity (kg)" field right where the dialog's "Delivery
 * date" field lies: the page's field is visible, covered by the dialog. The dialog's "Quantity (kg)" is below the fold
 * of its body. The calendar under "Delivery date" keeps the focus in it (its days do not take it) and covers the fields
 * below it; `?tall=1` makes it cover "Quantity (kg)" too.
 */
function dialogPage(tall: boolean): string {
  return page(
    'Pro forma',
    `<main style="padding:24px"><h1 style="margin:0 0 20px">Pro forma invoices</h1>
  <button id="open">New pro forma</button>
  <div style="position:absolute;left:116px;top:156px"><label for="bg-qty">Quantity (kg)</label><input id="bg-qty"></div>
  <p id="out" style="margin-top:420px">-</p></main>
<div id="overlay" hidden style="position:fixed;inset:0;background:rgba(30,20,20,.35)">
  <div role="dialog" aria-modal="true" aria-labelledby="t" style="position:absolute;left:100px;top:100px;width:520px;background:#fff;border-radius:12px">
    <h2 id="t" style="margin:0;padding:12px 16px;height:46px;font-size:18px">New pro forma</h2>
    <div id="body" style="max-height:260px;overflow-y:auto;padding:4px 16px 16px">
      <div style="position:relative"><label for="date">Delivery date</label><input id="date" autocomplete="off">
        <div id="cal" hidden style="position:absolute;top:58px;left:0;width:420px;height:${tall ? 900 : 120}px;background:#ece4dc;z-index:5;border-radius:8px">
          <button id="day" style="margin:8px">12</button> November 2026</div></div>
      <div style="height:560px;padding-top:16px;color:#7a6a64">Payment terms, incoterm, notes…</div>
      <label for="qty">Quantity (kg)</label><input id="qty">
    </div>
  </div>
</div>`,
    `const $ = (id) => document.getElementById(id);
const show = () => { $('out').textContent = 'qty=' + $('qty').value + ' date=' + $('date').value + ' bg=' + $('bg-qty').value; };
for (const id of ['qty', 'date', 'bg-qty']) $(id).addEventListener('input', show);
$('open').onclick = () => { $('overlay').hidden = false; document.querySelector('main').setAttribute('aria-hidden', 'true'); };
$('date').onfocus = () => { $('cal').hidden = false; };
$('cal').addEventListener('mousedown', (e) => e.preventDefault());
$('day').onclick = () => { $('date').value = '12/11/2026'; $('cal').hidden = true; show(); };
document.addEventListener('pointerdown', (e) => { if (!$('cal').hidden && !e.target.closest('#cal') && e.target !== $('date')) $('cal').hidden = true; }, true);`,
  );
}

const FIELDS_PAGE = page(
  'Fields',
  `<main style="padding:24px"><label for="lose">Bags</label><input id="lose"><label for="fmt">Amount</label><input id="fmt">
  <label for="other">Other</label><input id="other"><p id="out">-</p></main>`,
  `const $ = (id) => document.getElementById(id);
// Loses the focus after the first character (a page that re-renders the field): "300" becomes "3".
$('lose').addEventListener('input', () => { if ($('lose').value.length === 1) $('other').focus(); });
// Formats as it goes: "1500" shows "1,500".
$('fmt').addEventListener('input', () => { const d = $('fmt').value.replace(/\\D/g, ''); $('fmt').value = d ? Number(d).toLocaleString('en-US') : ''; });`,
);

const RENAMED_PAGE = page(
  'Renamed',
  `<main style="padding:24px"><button>Save draft</button> <button>Download spreadsheet</button> <button>Archive quote</button>
  <button>Send a reminder</button><label for="c">Customer</label><input id="c"></main>`,
);

const CLICKS_PAGE = page(
  'Clicks',
  `<main style="padding:24px"><button id="dead">Preview</button> <button id="live">Refresh</button> <button id="dom">Show</button>
  <button id="late">Open later</button> <label><input type="checkbox" id="cb" style="width:auto"> Gift wrap</label>
  <label for="notes">Notes</label><input id="notes"><p id="out">-</p></main>`,
  `const $ = (id) => document.getElementById(id);
// The page polls (a list refreshed every 300 ms): its requests never make a dead click look alive.
setInterval(() => fetch('/poll').catch(() => {}), 300);
$('live').onclick = () => fetch('/ping');
$('dom').onclick = () => { $('out').textContent = 'shown'; };
let n = 0;
$('late').onclick = () => { if (++n >= 2) $('out').textContent = 'opened'; };`,
);

const FILES_PAGE = page(
  'Files',
  `<main style="padding:24px">
  <p><a id="broken" href="/files/broken.pdf">Pro forma PDF</a></p>
  <p><a id="tab" href="/files/tab-flaky" target="_blank">Terms (new tab)</a></p>
  <p><a id="missing" href="/files/missing" target="_blank">Missing document</a></p>
  <p><a id="down" href="/files/always-down" target="_blank">Unreachable document</a></p>
  <p><button id="send" onclick="fetch('/send',{method:'POST'}).then(()=>{document.getElementById('sent').textContent='Pro forma sent'})">Send to customer</button></p>
  <p id="sent"></p><p id="later"></p></main>`,
  `setTimeout(() => { document.getElementById('later').textContent = 'Ready now'; }, 1500);`,
);

let pdf: Buffer;
let server: { url: string; close: () => Promise<void> };
const hits = new Map<string, number>();
const messages: Array<Record<string, unknown>> = [];
let dir: string;

function mail(subject: string, to: string): void {
  messages.unshift({
    ID: `m${messages.length + 1}`,
    From: { Name: 'Northfield Roasters', Address: 'maja@northfield.example' },
    To: [{ Name: '', Address: to }],
    Subject: subject,
    Created: new Date().toISOString(),
    HTML: `<html><body><h1>${subject}</h1></body></html>`,
    Text: subject,
  });
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0];
  const n = (hits.get(path) ?? 0) + 1;
  hits.set(path, n);
  const html = (body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  const json = (v: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(v));
  };
  const pages: Record<string, string> = {
    '/dialog.html': dialogPage(false),
    '/dialog-tall.html': dialogPage(true),
    '/fields.html': FIELDS_PAGE,
    '/renamed.html': RENAMED_PAGE,
    '/clicks.html': CLICKS_PAGE,
    '/files.html': FILES_PAGE,
  };
  if (pages[path]) return html(pages[path]);
  if (path === '/poll' || path === '/ping') return json({ ok: true });
  // Every transfer the browser makes (the link's, then its download manager's own new attempt) breaks after its headers
  // and half its bytes; the runner's request (Accept: */*) is served.
  if (path === '/files/broken.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(pdf.length), 'content-disposition': 'attachment; filename="PF-2043.pdf"' });
    const accept = req.headers.accept;
    if (accept === undefined || accept.includes('text/html')) {
      res.write(pdf.subarray(0, pdf.length >> 1));
      setTimeout(() => res.socket?.destroy(), 50);
      return;
    }
    return void res.end(pdf);
  }
  // Request 1: the new tab (served); 2: the runner's fetch (socket hang up); 3: its retry (served).
  if (path === '/files/tab-flaky') {
    if (n === 2) return void req.socket.destroy();
    return html('<html><body><h1>Terms of sale</h1></body></html>');
  }
  if (path === '/files/missing') {
    res.writeHead(404, { 'content-type': 'text/html' });
    return void res.end('<h1>Not found</h1>');
  }
  if (path === '/files/always-down') {
    if (n === 1) return html('<html><body><h1>Soon</h1></body></html>');
    return void req.socket.destroy();
  }
  if (path === '/send' && req.method === 'POST') {
    // The same subject to the café's accounts address and a copy to the supplier — not to the buyer's address.
    setTimeout(() => {
      mail('Pro forma PF-2043', 'accounts@cafe.example');
      mail('Pro forma PF-2043', 'maja@northfield.example');
    }, 250);
    return json({ ok: true });
  }
  if (path === '/mailpit/api/v1/messages') return json({ total: messages.length, messages: messages.map(({ HTML: _h, Text: _t, ...m }) => m) });
  const one = /^\/mailpit\/api\/v1\/message\/([^/]+)$/.exec(path);
  if (one) {
    const m = messages.find((x) => x.ID === one[1]);
    return json({ ...m, Date: m?.Created, Cc: [], Inline: [] });
  }
  res.writeHead(404);
  res.end('not found');
}

beforeAll(async () => {
  const browser = await chromium.launch();
  const p = await browser.newPage();
  await p.setContent('<h1>Pro forma PF-2043</h1><p>Demo Café</p>');
  pdf = await p.pdf({ format: 'A4' });
  await browser.close();
  const srv = createServer(handle);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  server = { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => (srv.closeAllConnections(), srv.close(() => r()))) };
  dir = await tempDir('rw-reliability-');
}, 60_000);

afterAll(async () => {
  await server?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function project(): LoadedProject {
  const p = makeProject(dir, { app: server.url });
  p.config.mailbox = { provider: 'mailpit', url: `${server.url}/mailpit`, poll_ms: 150 };
  return p;
}

async function run(
  name: string,
  scenario: Omit<Scenario, 'video'>,
  opts: Partial<RunOptions> & { project?: LoadedProject } = {},
): Promise<{ rec: RunRecord; events: TimelineEvent[]; progress: RunProgress[]; warnings: string[]; ms: number }> {
  const progress: RunProgress[] = [];
  const t0 = Date.now();
  const rec = await runScenario({
    policy: PERSON_POLICY,
    project: opts.project ?? project(),
    scenario: makeScenario(name, { pacing: FAST, ...scenario }),
    mode: 'dry',
    runId: `${name}-${Date.now()}`,
    onProgress: (e) => progress.push(e),
    ...opts,
  });
  const ms = Date.now() - t0;
  const tl = rec.timeline ? await readTimeline(rec.timeline) : null;
  return { rec, events: (tl?.events ?? []).filter((e) => e.step >= 0), progress, warnings: tl?.warnings ?? rec.warnings, ms };
}

describe('type into the right field (R-FLD-11)', () => {
  it("a field below the fold of a scrolling modal dialog, with a field of the same label behind it: types into the dialog's, scrolled into view", async () => {
    const { rec, events } = await run('dialog-type', {
      scenes: [
        {
          id: 'pf',
          open: '/dialog.html',
          steps: [{ click: 'New pro forma' }, { type: { into: { label: 'Quantity (kg)' }, text: '300' } }, { assert: { text: 'qty=300 date= bg=' } }],
        },
      ],
    });
    expect(rec.error?.message).toBeUndefined();
    const typed = events.find((e) => e.action === 'type')!;
    expect(typed.target?.desc).toContain('Quantity (kg)');
    // The click point is inside the dialog's body (top 146 + 260 px), not on the page's field behind (y ≈ 186).
    expect(typed.point!.y).toBeGreaterThan(200);
    expect(typed.point!.y).toBeLessThan(410);
  });

  it('a field the open calendar covers: the step fails before typing, naming the field that kept the focus, with a screenshot', async () => {
    const { rec, events } = await run('dialog-covered', {
      scenes: [
        {
          id: 'pf',
          open: '/dialog-tall.html',
          steps: [
            { click: 'New pro forma' },
            { type: { into: { label: 'Delivery date' }, text: '12/11/2026' } },
            { type: { into: { label: 'Quantity (kg)' }, text: '300' }, optional: true },
            { assert: { text: 'qty= date=12/11/2026 bg=' } },
          ],
        },
      ],
    });
    expect(rec.status, rec.error?.message).toBe('succeeded');
    expect(events.map((e) => e.status)).toEqual(['ok', 'ok', 'failed', 'ok']);
    // Listed in the run result (R-FLD-16), with the error screenshot.
    expect(rec.optional_failures).toHaveLength(1);
    const f = rec.optional_failures![0];
    expect(f).toMatchObject({ scene: 'pf', step: 2, action: 'type' });
    expect(f.error).toMatch(/put the focus on textbox "Delivery date" instead: nothing was typed/);
    expect(existsSync(f.screenshot!)).toBe(true);
  });

  it('a field that loses the focus warns ("300" became "3"); a value the page only formats does not', async () => {
    const { rec, warnings } = await run('values', {
      scenes: [
        {
          id: 'f',
          open: '/fields.html',
          steps: [{ type: { into: { label: 'Bags' }, text: '300' } }, { type: { into: { label: 'Amount' }, text: '1500' } }],
        },
      ],
    });
    expect(rec.status, rec.error?.message).toBe('succeeded');
    const value = warnings.filter((w) => w.includes('the field holds'));
    expect(value).toEqual([expect.stringMatching(/^f\.0: after typing "300" into textbox "Bags", the field holds "3": some keys went elsewhere/)]);
  });
});

describe('every missing target of a scene in one take (R-FLD-10)', () => {
  it('lists the later targets missing from the page too, with the closest visible elements; a later target that is there is not listed', async () => {
    const { rec } = await run('renamed', {
      scenes: [
        {
          id: 'quotes',
          open: '/renamed.html',
          steps: [
            { click: 'Save draft' },
            { click: 'Download CSV', timeout: 0.5 },
            { type: { into: { label: 'Customer name' }, text: 'Demo Café' } },
            { click: 'Archive quote' },
            { click: { role: 'button', name: 'Send reminder', exact: true } },
          ],
        },
      ],
    });
    expect(rec.status).toBe('failed');
    expect(rec.error?.step).toBe(1);
    const missing = rec.error!.missing_targets!;
    expect(missing.map((m) => `${m.step} ${m.action} ${m.target}`)).toEqual(['2 type label="Customer name"', '4 click role=button name="Send reminder" exact']);
    expect(missing[0].near[0]).toMatchObject({ role: 'textbox', name: 'Customer' });
    expect(missing[1].near[0]).toMatchObject({ role: 'button', name: 'Send a reminder' });
    expect(rec.error!.message).toMatch(/2 later targets of scene quotes not on this page either/);
    expect(rec.error!.message).toMatch(/step 4 \(click\) role=button name="Send reminder" exact: closest: button "Send a reminder"/);
  });
});

describe('dead clicks (R-FLD-12)', () => {
  it('a click that changes nothing is reported at once with a screenshot, even on a page that polls; live clicks are not', async () => {
    const { rec, warnings, progress } = await run('dead', {
      scenes: [
        {
          id: 'c',
          open: '/clicks.html',
          steps: [{ click: '#dead' }, { wait: 1.8 }, { click: '#live' }, { click: '#dom' }, { click: 'Gift wrap' }, { click: { label: 'Notes' } }, { click: '#dead' }],
        },
      ],
    });
    expect(rec.status, rec.error?.message).toBe('succeeded');
    const dead = warnings.filter((w) => w.includes('produced nothing'));
    expect(dead.map((w) => w.split(':')[0])).toEqual(['c.0', 'c.6']);
    const shot = /screenshot: (\S+\.png)/.exec(dead[0])![1];
    expect(basename(shot)).toBe('dead-click-c-0.png');
    expect(existsSync(shot)).toBe(true);
    // At once: during the `wait` that follows the click, not after it.
    const i = progress.findIndex((e) => e.type === 'log' && e.message.includes('produced nothing'));
    const waitEnd = progress.findIndex((e) => e.type === 'step_end' && e.step === 1);
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(waitEnd);
  });

  it('retry_click clicks once more: a second click that works passes, a second dead click fails the step', async () => {
    const ok = await run('retry', {
      scenes: [{ id: 'c', open: '/clicks.html', steps: [{ click: '#late', retry_click: true }, { wait_for: { text: 'opened', timeout: 1 } }] }],
    });
    expect(ok.rec.status, ok.rec.error?.message).toBe('succeeded');
    expect(ok.events[0].data).toMatchObject({ retried: true });
    expect(ok.warnings.some((w) => w.includes('clicking once more (retry_click)'))).toBe(true);
    const bad = await run('retry-dead', { scenes: [{ id: 'c', open: '/clicks.html', steps: [{ click: '#dead', retry_click: true }] }] });
    expect(bad.rec.status).toBe('failed');
    expect(bad.rec.error?.message).toMatch(/clicking button "Preview" twice produced nothing within 1 s each time/);
    expect(existsSync(bad.rec.error!.screenshot!)).toBe(true);
  });
});

describe('download retries (R-FLD-13)', () => {
  it('retries a transient failure (a broken transfer, a socket hang up) and fails at once on a real error', async () => {
    hits.clear();
    const { rec, events, warnings } = await run('downloads', {
      scenes: [
        {
          id: 'd',
          open: '/files.html',
          steps: [
            { download: { click: '#broken', as: 'proforma' } },
            { download: { click: '#tab', as: 'terms' } },
            { download: { click: '#missing', as: 'missing' }, optional: true },
            { download: { click: '#down', as: 'down' }, optional: true },
          ],
        },
      ],
    });
    expect(rec.status, rec.error?.message).toBe('succeeded');
    expect(events[0].data).toMatchObject({ name: 'proforma', mime: 'application/pdf', attempts: 2 });
    expect(events[1].data).toMatchObject({ name: 'terms', via: 'tab', attempts: 2 });
    expect(hits.get('/files/tab-flaky')).toBe(3);
    expect(warnings.some((w) => w.includes('download "terms": socket hang up — trying again in 1 s (attempt 2 of 3)'))).toBe(true);
    // 404: once, no retry. Unreachable: three attempts, then the step fails.
    expect(rec.optional_failures!.map((f) => [f.step, f.error.replace(/ at http\S+/, '')])).toEqual([
      [2, 'download: the document answered HTTP 404'],
      [3, expect.stringMatching(/^download: the document could not be fetched after 3 attempts \(socket hang up/)],
    ]);
    expect(hits.get('/files/missing')).toBe(2);
    expect(hits.get('/files/always-down')).toBe(4);
    expect(warnings.filter((w) => w.includes('download "missing"'))).toEqual([]);
  }, 90_000);
});

describe('defaults.timeout_s (R-FLD-14)', () => {
  it("the project's default timeout applies to every step without one; the scenario's wins", async () => {
    const short = project();
    short.config.defaults = { timeout_s: 0.6 };
    const a = await run(
      'defaults-short',
      {
        scenes: [
          {
            id: 's',
            open: '/files.html',
            steps: [
              { wait_for: { text: 'Never shown' }, optional: true },
              { click: 'No such button', optional: true },
              { wait_for_email: { subject: 'Never sent', as: 'never' }, optional: true },
            ],
          },
        ],
      },
      { project: short },
    );
    expect(a.rec.status).toBe('succeeded');
    expect(a.rec.optional_failures!.map((f) => f.error)).toEqual([
      expect.stringMatching(/^wait_for timed out after 0\.6 s: text "Never shown"/),
      expect.stringMatching(/^no visible element matches text="No such button" after 0\.6 s/),
      expect.stringMatching(/^wait_for_email: no new message \(subject Never sent\) within 0\.6 s/),
    ]);
    // Ignored, the three steps would wait 15 + 15 + 30 s.
    expect(a.ms).toBeLessThan(12_000);
    const b = await run('defaults-scenario', { defaults: { timeout_s: 4 }, scenes: [{ id: 's', open: '/files.html', steps: [{ wait_for: { text: 'Ready now' } }] }] }, { project: short });
    expect(b.rec.status, b.rec.error?.message).toBe('succeeded');
  }, 60_000);
});

describe('persona mail addresses and mailbox diagnostics (R-FLD-15)', () => {
  it.skipIf(!MAC_TIMING)(
    'to: persona:<name> matches its address; no match lists what came; several matches warn; the artefact keeps the persona',
    async () => {
      messages.length = 0;
      const p = project();
      p.config.auth = { personas: { buyer: { email: 'orders@cafe.example' }, supplier: { email: 'maja@northfield.example' } } };
      const { rec, warnings } = await run(
        'mail',
        {
          scenes: [
            {
              id: 'm',
              open: '/files.html',
              steps: [
                { click: 'Send to customer' },
                { wait_for_email: { to: 'persona:buyer', subject: 'Pro forma', timeout: 1.5, as: 'buyer' }, optional: true },
                { wait_for_email: { subject: 'Pro forma', as: 'any' } },
                { wait_for_email: { to: 'persona:supplier', as: 'copy' } },
              ],
            },
          ],
        },
        { project: p },
      );
      expect(rec.status, rec.error?.message).toBe('succeeded');
      const err = rec.optional_failures![0].error;
      expect(err).toMatch(/no new message \(to persona:buyer, subject Pro forma = orders@cafe\.example\) within 1\.5 s/);
      expect(err).toMatch(
        /received during the wait: "Pro forma PF-2043" from maja@northfield\.example to accounts@cafe\.example; "Pro forma PF-2043" from maja@northfield\.example to maja@northfield\.example/,
      );
      expect(warnings.filter((w) => w.includes('new messages match'))).toEqual([
        expect.stringMatching(/^m\.2: wait_for_email: 2 new messages match \(subject Pro forma\): "Pro forma PF-2043" from maja@northfield\.example to accounts@cafe\.example; .* took the first one/),
      ]);
      const tl = await readTimeline(rec.timeline!);
      const mails = (tl.artefacts ?? []).filter((a): a is EmailArtefact => a.kind === 'email');
      expect(mails.map((a) => [a.name, a.to[0], a.persona ?? null])).toEqual([
        ['any', 'accounts@cafe.example', null],
        ['copy', 'maja@northfield.example', 'supplier'],
      ]);
    },
    60_000,
  );

  it('a persona without an email fails the step and says where to add it', async () => {
    const p = project();
    p.config.auth = { personas: { buyer: {} } };
    const { rec } = await run('mail-none', { scenes: [{ id: 'm', open: '/files.html', steps: [{ wait_for_email: { to: 'persona:buyer', as: 'x' } }] }] }, { project: p });
    expect(rec.status).toBe('failed');
    expect(rec.error?.message).toMatch(/persona "buyer" has no `email` on environment test \(auth\.personas\.buyer\.email/);
  });
});

describe('optional failures and step pictures (R-FLD-16)', () => {
  it('capture.step_shots keeps one picture per step of a capture (its frame at the end of the step); without it, none', async () => {
    const scenario = (shots: boolean): Omit<Scenario, 'video'> => ({
      capture: { step_shots: shots },
      scenes: [{ id: 'shots', open: '/clicks.html', steps: [{ click: '#dom' }, { wait_for: { text: 'shown' } }, { click: 'Nothing here', timeout: 0.3, optional: true }] }],
    });
    const on = await run('shots-on', scenario(true), { mode: 'capture' });
    expect(on.rec.status, on.rec.error?.message).toBe('succeeded');
    expect(on.rec.screenshots.map((f) => basename(f))).toEqual(['shots-00-click.jpg', 'shots-01-wait_for.jpg', 'shots-02-click.jpg']);
    for (const f of on.rec.screenshots) expect(existsSync(f)).toBe(true);
    expect(on.rec.optional_failures).toEqual([expect.objectContaining({ scene: 'shots', step: 2, action: 'click' })]);
    const off = await run('shots-off', scenario(false), { mode: 'capture' });
    expect(off.rec.screenshots).toEqual([]);
  }, 90_000);
});
