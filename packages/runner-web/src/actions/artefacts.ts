/**
 * `wait_for_email` and `download` (L2.9, R-MAIL-02, R-DOC-01): capture an email from the project's test mailbox and a
 * file a click produces, as run artefacts (runs/<id>/artefacts/; images rendered after the capture, see
 * ../artefacts/store.ts).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Download, Page } from 'playwright-core';
import type { DocumentArtefact, NormalizedArgsMap, WaitForEmailArgs } from '@demo-studio/core';
import { MailboxClient, formatAddress, mailMatches } from '../artefacts/mailbox.js';
import type { MailSummary } from '../artefacts/mailbox.js';
import { imageSize, sniffMime } from '../artefacts/store.js';
import { StepError, errorMessage } from '../errors.js';
import { resolveTarget } from '../resolve.js';
import type { Runtime, StepContext } from '../runtime.js';
import { wallNow } from '../util.js';
import { clickResolved } from './click.js';
import type { ClickRun } from './click.js';
import type { ActionResult } from './types.js';

/** Default seconds of wait_for_email / download. */
export const ARTEFACT_TIMEOUT_S = 30;

/** The project's mailbox client (created once per run). */
export function mailboxOf(rt: Runtime): MailboxClient {
  if (rt.artefacts.mailbox) return rt.artefacts.mailbox;
  const cfg = rt.project.config.mailbox;
  if (!cfg) throw new StepError(`wait_for_email: project "${rt.project.slug}" has no \`mailbox\` (add mailbox: {provider: mailpit, url: …} to project.yaml)`);
  rt.artefacts.mailbox = new MailboxClient(cfg, rt.project, rt.template);
  return rt.artefacts.mailbox;
}

/**
 * Remember the messages already in the mailbox (before the setup hooks): wait_for_email only takes messages that
 * arrive during the run. A mailbox that cannot be read now is retried by the first wait_for_email (which then takes
 * any matching message it has not captured yet, with a warning).
 */
export async function snapshotMailbox(rt: Runtime): Promise<void> {
  try {
    const list = await mailboxOf(rt).list(rt.signal);
    rt.artefacts.baseline = new Set(list.map((m) => m.id));
  } catch (e) {
    rt.warn(`mailbox: could not read the messages already there (${errorMessage(e)}); wait_for_email may take an older message`);
  }
}

function describeFilter(a: WaitForEmailArgs): string {
  const parts = [a.to && `to ${a.to}`, a.from && `from ${a.from}`, a.subject && `subject ${a.subject}`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'any new message';
}

export async function waitForEmail(ctx: StepContext, args: WaitForEmailArgs): Promise<ActionResult> {
  const { rt } = ctx;
  const mb = mailboxOf(rt);
  if (rt.artefacts.has('email', args.as)) throw new StepError(`wait_for_email: an email named "${args.as}" was already captured in this run`);
  const timeoutMs = (args.timeout ?? ctx.step.timeout ?? ARTEFACT_TIMEOUT_S) * 1000;
  const deadline = wallNow() + timeoutMs;
  const baseline = rt.artefacts.baseline;
  let seen = 0;
  let found: MailSummary | undefined;
  for (;;) {
    const list = await mb.list(rt.signal);
    seen = list.length;
    // Oldest first: the first message that arrived for this filter, not one captured already.
    const fresh = list.filter((m) => !rt.artefacts.claimed.has(m.id) && !(baseline?.has(m.id) ?? false)).reverse();
    found = fresh.find((m) => mailMatches(m, args));
    if (found) break;
    if (wallNow() >= deadline) {
      throw new StepError(`wait_for_email: no new message (${describeFilter(args)}) within ${Math.round(timeoutMs / 100) / 10} s (${seen} messages in the mailbox)`);
    }
    await rt.sleep(Math.min(mb.pollMs, Math.max(50, deadline - wallNow())));
  }
  rt.artefacts.claimed.add(found.id);
  const message = await mb.get(found.id, rt.signal);
  const where = rt.current ? { scene: rt.current.scene, step: rt.current.step } : {};
  const a = await rt.artefacts.addEmail(args.as, message, rt.now(), where);
  rt.log('info', `wait_for_email: captured "${message.subject}" from ${formatAddress(message.from)} as ${args.as}`);
  return { data: { artefact: 'email', name: args.as, file: a.file, subject: a.subject, from: formatAddress(message.from), to: a.to } };
}

type Captured = { via: 'download'; download: Download } | { via: 'tab'; page: Page };

export async function download(ctx: StepContext, args: NormalizedArgsMap['download']): Promise<ActionResult> {
  const { rt } = ctx;
  if (rt.artefacts.has('document', args.as)) throw new StepError(`download: a document named "${args.as}" was already captured in this run`);
  const timeoutMs = (args.timeout ?? ARTEFACT_TIMEOUT_S) * 1000;
  const page = rt.page;
  const context = page.context();
  const r = await resolveTarget(ctx, args.click);
  // Listen before clicking: the download event (on this page or on a tab the click opens), or a new tab's document.
  let settle: (c: Captured) => void = () => undefined;
  const got = new Promise<Captured>((resolve) => (settle = resolve));
  const onDownload = (d: Download) => settle({ via: 'download', download: d });
  const tabs: Page[] = [];
  const onPage = (p: Page) => {
    tabs.push(p);
    p.on('download', onDownload);
    // A tab that shows a document (not a download): once it has left about:blank (the popup may already have
    // navigated when the page event fires), give a navigation that becomes a download a moment to say so.
    void (async () => {
      const until = wallNow() + timeoutMs;
      while (!p.isClosed() && (p.url() === '' || p.url() === 'about:blank') && wallNow() < until) {
        await new Promise((res) => setTimeout(res, 50));
      }
      if (p.isClosed() || p.url() === 'about:blank' || p.url() === '') return;
      await p.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
      await new Promise((res) => setTimeout(res, 300));
      settle({ via: 'tab', page: p });
    })();
  };
  page.on('download', onDownload);
  context.on('page', onPage);
  let run: ClickRun;
  let captured: Captured;
  try {
    run = await clickResolved(ctx, r, { expect_popup: false });
    const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const c = await Promise.race([got, timer]);
    if (!c) throw new StepError(`download: clicking ${r.desc} produced no download and opened no document within ${timeoutMs / 1000} s`);
    captured = c;
  } finally {
    page.off('download', onDownload);
    context.off('page', onPage);
  }

  // Never a sign-in page saved as the document (L1.6): the URL of the download, of the tab and of the fetched document
  // are checked like the page's own (its persona's sign-in pages) — a landing fails the run, which keeps nothing.
  const signIn = (u: string): void => {
    const e = rt.guard?.check(rt.activeId ?? '', page, u, `the document of download "${args.as}"`);
    if (e) throw e;
  };
  let bytes: Buffer;
  let fileName: string;
  let contentType = '';
  let url: string | undefined;
  try {
    if (captured.via === 'download') {
      const d = captured.download;
      url = d.url();
      signIn(url);
      fileName = d.suggestedFilename();
      const path = await d.path().catch((e: unknown) => {
        throw new StepError(`download: the file could not be downloaded (${errorMessage(e)})`);
      });
      bytes = await readFile(path);
    } else {
      url = captured.page.url();
      signIn(url);
      const res = await context.request.get(url, { timeout: timeoutMs }).catch((e: unknown) => {
        throw new StepError(`download: the document at ${url} could not be fetched with the session (${errorMessage(e)})`);
      });
      signIn(res.url());
      if (!res.ok()) throw new StepError(`download: the document at ${url} answered HTTP ${res.status()}`);
      bytes = await res.body();
      contentType = res.headers()['content-type'] ?? '';
      const disposition = res.headers()['content-disposition'] ?? '';
      const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
      fileName = named ? decodeURIComponent(named[1]) : basename(new URL(url).pathname) || args.as;
    }
  } finally {
    // Close the tabs the click opened: the recording stays on this page.
    for (const t of tabs) await t.close().catch(() => undefined);
    if (tabs.length) await page.bringToFront().catch(() => undefined);
  }

  const mime = sniffMime(bytes, fileName, contentType);
  const file = await rt.artefacts.writeDocument(args.as, bytes, mime, fileName);
  const where = rt.current ? { scene: rt.current.scene, step: rt.current.step } : {};
  const a: DocumentArtefact = {
    kind: 'document',
    name: args.as,
    t: rt.now(),
    ...where,
    file: rt.artefacts.rel(file),
    mime,
    file_name: fileName,
    via: captured.via,
    ...(url ? { url } : {}),
    bytes: bytes.length,
    pages: [],
  };
  if (mime.startsWith('image/')) {
    const size = imageSize(bytes, mime);
    if (size) a.pages = [{ file: a.file, ...size, width_pt: Math.round(size.width * 75) / 100, height_pt: Math.round(size.height * 75) / 100 }];
  } else if (mime !== 'application/pdf') {
    rt.warn(`download "${args.as}": ${fileName} is ${mime}; only PDFs and images can be shown by document components`);
  }
  rt.artefacts.addDocument(a);
  rt.log('info', `download: ${fileName} (${mime}, ${bytes.length} bytes, via ${captured.via}) as ${args.as}`);
  return {
    target: { desc: r.desc, bbox: r.bbox },
    point: run.point,
    t_click: run.t_click,
    strategy: run.strategy,
    data: { artefact: 'document', name: args.as, file: a.file, file_name: fileName, mime, via: captured.via, bytes: bytes.length },
  };
}

/** A `capture_text` pattern: `/source/flags` or a plain source. */
export function textPattern(pattern: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/.exec(pattern);
  return m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
}

/** What capture_text keeps of a text: the pattern's first group, else its match, else the whole text; null = no match. */
export function captureValue(text: string, pattern?: string): string | null {
  if (!pattern) return text;
  const m = textPattern(pattern).exec(text);
  if (!m) return null;
  return (m[1] ?? m[0]).trim();
}

/**
 * `capture_text` (L2.10, R-STO-01): read the target's rendered text (a field's value) and keep it — or the part the
 * pattern selects — as the text artefact `as` (artefacts/texts/<as>.json), for a figure card. The text is polled until
 * the pattern matches (a figure still loading), up to the step timeout. No cursor move: nothing to film.
 */
export async function captureText(ctx: StepContext, args: NormalizedArgsMap['capture_text']): Promise<ActionResult> {
  const { rt } = ctx;
  if (rt.artefacts.has('text', args.as)) throw new StepError(`capture_text: a text named "${args.as}" was already captured in this run`);
  const deadline = wallNow() + ctx.timeoutMs;
  const r = await resolveTarget(ctx, args.target);
  let text = '';
  let value: string | null = null;
  for (;;) {
    text = (await rt.kit.visibleText(r.ref)) ?? '';
    value = text ? captureValue(text, args.pattern) : null;
    if (value !== null && value !== '') break;
    if (wallNow() >= deadline) {
      throw new StepError(
        args.pattern
          ? `capture_text: the text of ${r.desc} does not match ${args.pattern} (text: ${JSON.stringify(text.slice(0, 160))})`
          : `capture_text: ${r.desc} has no text`,
      );
    }
    await rt.sleep(150);
  }
  const where = rt.current ? { scene: rt.current.scene, step: rt.current.step } : {};
  // The target description comes from the scenario (a secret in its target spec): artefacts are kept as captured.
  const target = rt.secrets.redactText(r.desc);
  const a = await rt.artefacts.addText(args.as, { value, text, target, bbox: r.bbox, ...(args.pattern ? { pattern: args.pattern } : {}) }, rt.now(), where);
  rt.log('info', `capture_text: "${value}" from ${r.desc} as ${args.as}`);
  return { target: { desc: r.desc, bbox: r.bbox }, data: { artefact: 'text', name: args.as, file: a.file, value } };
}
