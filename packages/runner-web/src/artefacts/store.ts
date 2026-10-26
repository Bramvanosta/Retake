/**
 * Run artefacts (L2.9): captured emails, documents and web notifications, written under runs/<id>/artefacts/ and
 * listed in timeline.json (`artefacts`). Actions record what they capture during the run (the raw message, the file,
 * the notification); `finalize()` renders the images after the capture, in a clean browser (emails → PNG, PDFs → one
 * PNG per page, icons → PNG), and adds the project documents the scenario's slots name (`document: assets/x.pdf`).
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { ARTEFACTS_DIR, isCaptureScene, isCard, isDocumentPath, normalizeStep, writeJson } from '@demo-studio/core';
import type { BBox, BrowserConfig, DocumentArtefact, EmailArtefact, LoadedProject, NotificationArtefact, Scenario, TextArtefact, TimelineArtefact } from '@demo-studio/core';
import { errorMessage } from '../errors.js';
import type { MailboxClient, MailMessage } from './mailbox.js';
import { formatAddress, inlineCids } from './mailbox.js';
import { ArtefactRenderer } from './render.js';

/** Characters of an email's text kept on the timeline (`preview`). */
export const EMAIL_PREVIEW_CHARS = 280;

const EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'text/html': '.html',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

const BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
BY_EXT['.jpeg'] = 'image/jpeg';
BY_EXT['.htm'] = 'text/html';

/** The type of a file from its first bytes, else its name, else the server's content type. */
export function sniffMime(bytes: Uint8Array, name = '', contentType = ''): string {
  const head = Buffer.from(bytes.subarray(0, 16));
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') return ct;
  const byName = BY_EXT[extname(name).toLowerCase()];
  if (byName) return byName;
  const text = Buffer.from(bytes.subarray(0, 256)).toString('utf8').trimStart().toLowerCase();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'image/svg+xml';
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'text/html';
  return 'application/octet-stream';
}

export function extensionFor(mime: string, name = ''): string {
  return EXT[mime] ?? (extname(name).toLowerCase() || '.bin');
}

/** A file-name-safe slug. */
export function artefactSlug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'artefact'
  );
}

/** Text with whitespace collapsed, cut at `n` characters (on a word). */
export function previewText(text: string, n = EMAIL_PREVIEW_CHARS): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/** Plain text of an HTML document (fallback when a message has no text part). */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export interface Where {
  scene?: string;
  step?: number;
}

interface PendingEmail {
  artefact: EmailArtefact;
  html: string;
}

/** Collects the artefacts of one run. */
export class ArtefactStore {
  readonly dir: string;
  readonly items: TimelineArtefact[] = [];
  /** Mailbox message ids present when the run started (wait_for_email only takes messages that are not among them). */
  baseline: Set<string> | null = null;
  /** Message ids already captured by a wait_for_email of this run. */
  readonly claimed = new Set<string>();
  mailbox: MailboxClient | null = null;
  private readonly emails: PendingEmail[] = [];
  private readonly icons: Array<{ artefact: NotificationArtefact; bytes: Promise<{ data: Buffer; mime: string } | null> }> = [];
  private notificationCount = 0;

  constructor(
    readonly runDir: string,
    private readonly warn: (message: string) => void,
  ) {
    this.dir = join(runDir, ARTEFACTS_DIR);
  }

  /** Run-relative path. */
  rel(abs: string): string {
    return relative(this.runDir, abs).split('\\').join('/');
  }

  has(kind: TimelineArtefact['kind'], name: string): boolean {
    return this.items.some((a) => a.kind === kind && a.name === name);
  }

  async ensure(sub: string): Promise<string> {
    const d = join(this.dir, sub);
    await mkdir(d, { recursive: true });
    return d;
  }

  /** A captured email: artefacts/emails/<name>.json now, its image at finalize(). */
  async addEmail(name: string, m: MailMessage, t: number, where: Where, persona?: string): Promise<EmailArtefact> {
    const dir = await this.ensure('emails');
    const file = join(dir, `${artefactSlug(name)}.json`);
    const html = inlineCids(m.html, m.inline);
    const text = m.text.trim() ? m.text : htmlText(html);
    await writeJson(file, {
      id: m.id,
      from: formatAddress(m.from),
      to: m.to.map(formatAddress),
      cc: m.cc.map(formatAddress),
      subject: m.subject,
      date: m.date,
      text,
      html,
    });
    const a: EmailArtefact = {
      kind: 'email',
      name,
      t,
      ...where,
      file: this.rel(file),
      from: m.from.address,
      ...(m.from.name ? { from_name: m.from.name } : {}),
      to: m.to.map((x) => x.address),
      subject: m.subject,
      date: new Date(m.date).toString() === 'Invalid Date' ? m.date : new Date(m.date).toISOString(),
      preview: previewText(text),
      ...(persona ? { persona } : {}),
    };
    this.items.push(a);
    if (html.trim()) this.emails.push({ artefact: a, html });
    return a;
  }

  /** A text read by capture_text: artefacts/texts/<name>.json. */
  async addText(name: string, v: { value: string; text: string; target: string; bbox?: BBox; pattern?: string }, t: number, where: Where): Promise<TextArtefact> {
    const dir = await this.ensure('texts');
    const file = join(dir, `${artefactSlug(name)}.json`);
    await writeJson(file, { value: v.value, text: v.text, target: v.target, ...(v.bbox ? { bbox: v.bbox } : {}), ...(v.pattern ? { pattern: v.pattern } : {}) });
    const a: TextArtefact = {
      kind: 'text',
      name,
      t,
      ...where,
      file: this.rel(file),
      value: v.value,
      text: v.text,
      target: v.target,
      ...(v.bbox ? { bbox: { ...v.bbox } } : {}),
      ...(v.pattern ? { pattern: v.pattern } : {}),
    };
    this.items.push(a);
    return a;
  }

  /** A captured document (file already written under artefacts/documents/). */
  addDocument(a: DocumentArtefact): DocumentArtefact {
    this.items.push(a);
    return a;
  }

  /**
   * A web notification: artefacts/notifications/<name>.json now; its icon (fetched by the caller with the session)
   * becomes a PNG at finalize(). Name: the notification's tag when no other notification uses it, else
   * "notification-<n>".
   */
  async addNotification(
    n: { title: string; body: string; tag?: string; icon?: string; origin: string; via: NotificationArtefact['via']; time: number; page?: string },
    t: number,
    where: Where,
    icon: Promise<{ data: Buffer; mime: string } | null> | null,
  ): Promise<NotificationArtefact> {
    const index = ++this.notificationCount;
    const tagName = n.tag ? artefactSlug(n.tag) : '';
    const name = tagName && !this.has('notification', tagName) && !/^\d+$/.test(tagName) ? tagName : `notification-${index}`;
    const dir = await this.ensure('notifications');
    const file = join(dir, `${name}.json`);
    const a: NotificationArtefact = {
      kind: 'notification',
      name,
      t,
      ...where,
      file: this.rel(file),
      index,
      title: n.title,
      body: n.body,
      ...(n.tag ? { tag: n.tag } : {}),
      ...(n.icon ? { icon_url: n.icon } : {}),
      origin: n.origin,
      ...(n.page ? { page: n.page } : {}),
      via: n.via,
      time: new Date(n.time).toISOString(),
    };
    await writeJson(file, a);
    this.items.push(a);
    if (icon) this.icons.push({ artefact: a, bytes: icon });
    return a;
  }

  /**
   * After the capture: render email images, notification icons, rasterise PDFs, add the project documents named by
   * the scenario's slots. Failures are warnings (the artefact stays, without its image).
   */
  async finalize(opts: { browser?: BrowserConfig; scenario?: Scenario; project?: LoadedProject }): Promise<void> {
    const projectDocs = opts.scenario && opts.project ? projectDocuments(opts.scenario) : [];
    const docs = this.items.filter((a): a is DocumentArtefact => a.kind === 'document' && a.mime === 'application/pdf' && a.pages.length === 0);
    if (this.emails.length === 0 && this.icons.length === 0 && docs.length === 0 && projectDocs.length === 0) return;
    const renderer = new ArtefactRenderer(opts.browser);
    try {
      for (const e of this.emails) {
        try {
          const out = join(this.dir, 'emails', `${artefactSlug(e.artefact.name)}.png`);
          const img = await renderer.email(e.html, out);
          e.artefact.image = { file: this.rel(out), ...img };
        } catch (err) {
          this.warn(`email "${e.artefact.name}": its HTML could not be rendered (${errorMessage(err).split('\n')[0]})`);
        }
      }
      for (const i of this.icons) {
        try {
          const got = await i.bytes;
          if (!got) continue;
          const out = join(this.dir, 'notifications', `${i.artefact.name}-icon.png`);
          const img = await renderer.icon(got.data, got.mime, out);
          i.artefact.icon = { file: this.rel(out), ...img };
          await writeJson(join(this.runDir, i.artefact.file), i.artefact);
        } catch (err) {
          this.warn(`notification "${i.artefact.name}": its icon could not be rendered (${errorMessage(err).split('\n')[0]})`);
        }
      }
      for (const d of docs) await this.rasterize(renderer, d);
      for (const rel of projectDocs) {
        if (this.has('document', rel) || !opts.project) continue;
        const src = isAbsolute(rel) ? rel : resolve(opts.project.dir, rel);
        try {
          const bytes = await readFile(src);
          const mime = sniffMime(bytes, src);
          const dir = await this.ensure('documents');
          const name = artefactSlug(`project-${rel}`.replace(/\.[^.]+$/, ''));
          const file = join(dir, `${name}${extensionFor(mime, src)}`);
          await copyFile(src, file);
          const a: DocumentArtefact = { kind: 'document', name: rel, t: 0, file: this.rel(file), mime, file_name: basename(src), via: 'project', bytes: (await stat(src)).size, pages: [] };
          this.items.push(a);
          if (mime === 'application/pdf') await this.rasterize(renderer, a, name);
          else {
            const size = imageSize(bytes, mime);
            if (!size) throw new Error(`a project document must be a PDF, PNG or JPEG file (${basename(src)} is ${mime})`);
            // An image is a one-page document, its points at 96 dpi.
            const pt = (px: number) => Math.round(((px * 72) / 96) * 100) / 100;
            a.pages = [{ file: a.file, width: size.width, height: size.height, width_pt: pt(size.width), height_pt: pt(size.height) }];
          }
        } catch (err) {
          this.warn(`document "${rel}": ${errorMessage(err).split('\n')[0]}`);
        }
      }
    } finally {
      await renderer.close();
    }
  }

  private async rasterize(renderer: ArtefactRenderer, d: DocumentArtefact, folder = artefactSlug(d.name)): Promise<void> {
    try {
      const outDir = await this.ensure(join('documents', folder));
      const pages = await renderer.pdf(join(this.runDir, d.file), outDir);
      d.pages = pages.map((p) => ({ file: this.rel(p.file), width: p.width, height: p.height, width_pt: p.width_pt, height_pt: p.height_pt }));
      if (pages.length === 0) this.warn(`document "${d.name}": the PDF has no page`);
    } catch (err) {
      this.warn(`document "${d.name}": the PDF could not be rasterised (${errorMessage(err).split('\n')[0]})`);
    }
  }

  /** Write a downloaded file under artefacts/documents/<name>.<ext>. */
  async writeDocument(name: string, bytes: Buffer, mime: string, fileName: string): Promise<string> {
    const dir = await this.ensure('documents');
    const file = join(dir, `${artefactSlug(name)}${extensionFor(mime, fileName)}`);
    await writeFile(file, bytes);
    return file;
  }
}

/** Width/height of a PNG or JPEG. */
export function imageSize(bytes: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png' && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      const len = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

/** Project files named by the scenario's `document:` slots (cards and step overlays). */
export function projectDocuments(s: Scenario): string[] {
  const out = new Set<string>();
  const take = (slots: Record<string, string> | undefined) => {
    const v = slots?.document;
    if (typeof v === 'string' && isDocumentPath(v.trim())) out.add(v.trim());
  };
  s.scenes.forEach((entry) => {
    if (isCard(entry)) take(entry.card.slots);
    else if (isCaptureScene(entry)) (entry.steps ?? []).forEach((raw, i) => take(normalizeStep(raw, i).overlay?.slots));
  });
  return [...out];
}
