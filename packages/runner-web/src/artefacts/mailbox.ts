/**
 * The project's test mailbox (R-MAIL-01/02): Mailpit's API or a generic JSON API, read by `wait_for_email`.
 *
 *  - mailpit: GET <url>/api/v1/messages?limit=50 → {messages: [{ID, From: {Name, Address}, To: [...], Subject, Created}]}
 *             GET <url>/api/v1/message/<ID>     → {ID, From, To, Cc, Subject, Date, Text, HTML, Inline: [{PartID, ContentID, ContentType}]}
 *             GET <url>/api/v1/message/<ID>/part/<PartID> → the bytes of an inline part (cid: images)
 *  - http:    GET <url>/messages      → [{id, from, to, subject, date}] or {messages: [...]} (newest first or not)
 *             GET <url>/messages/<id> → {id, from, to, subject, date, text, html}
 *             `from` is "Name <address>", "address" or {name, address}; `to` a string, an array of those, or of objects.
 * The host is checked against the project's allow-list before any request.
 */
import { allowedHosts, interpolate, isHostAllowed } from '@retake/core';
import type { LoadedProject, MailboxConfig, TemplateContext } from '@retake/core';
import { StepError, errorMessage } from '../errors.js';

export interface MailAddress {
  name?: string;
  address: string;
}

/** A message as listed (summary). */
export interface MailSummary {
  id: string;
  from: MailAddress;
  to: MailAddress[];
  subject: string;
  /** ISO 8601, when the API gives one. */
  date?: string;
}

/** A full message. */
export interface MailMessage extends MailSummary {
  cc: MailAddress[];
  date: string;
  text: string;
  html: string;
  /** Inline parts (cid: references in the HTML), fetched as data: URLs. */
  inline: Array<{ cid: string; mime: string; data: string }>;
}

/** "Name <a@b>" | "a@b" | {name, address} | {Name, Address} → MailAddress. */
export function parseAddress(v: unknown): MailAddress {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const address = String(o.address ?? o.Address ?? o.email ?? '').trim();
    const name = String(o.name ?? o.Name ?? '').trim();
    return name ? { name, address } : { address };
  }
  const s = String(v ?? '').trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return m[1].trim() ? { name: m[1].trim(), address: m[2].trim() } : { address: m[2].trim() };
  return { address: s };
}

export function parseAddressList(v: unknown): MailAddress[] {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v.map(parseAddress).filter((a) => a.address !== '');
  if (typeof v === 'string' && v.includes(',') && !v.includes('<')) return v.split(',').map(parseAddress).filter((a) => a.address !== '');
  return [parseAddress(v)].filter((a) => a.address !== '');
}

export function formatAddress(a: MailAddress): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

/** wait_for_email filters: `to` / `from` substrings of address or name, `subject` a substring or /regex/flags. */
export function mailMatches(m: Pick<MailSummary, 'from' | 'to' | 'subject'>, f: { to?: string; from?: string; subject?: string }): boolean {
  const has = (list: MailAddress[], q: string) => {
    const needle = q.toLowerCase();
    return list.some((a) => a.address.toLowerCase().includes(needle) || (a.name ?? '').toLowerCase().includes(needle));
  };
  if (f.to !== undefined && !has(m.to, f.to)) return false;
  if (f.from !== undefined && !has([m.from], f.from)) return false;
  if (f.subject !== undefined) {
    const re = /^\/(.*)\/([a-z]*)$/.exec(f.subject);
    if (re) {
      if (!new RegExp(re[1], re[2]).test(m.subject)) return false;
    } else if (!m.subject.toLowerCase().includes(f.subject.toLowerCase())) return false;
  }
  return true;
}

/** Reads the project's mailbox. */
export class MailboxClient {
  readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(
    readonly config: MailboxConfig,
    project: Pick<LoadedProject, 'config'> & { slug?: string },
    template?: TemplateContext,
  ) {
    this.base = config.url.replace(/\/+$/, '');
    let host = '';
    try {
      host = new URL(this.base).hostname;
    } catch {
      throw new StepError(`mailbox url "${config.url}" is not a URL`);
    }
    if (!isHostAllowed(host, project)) {
      throw new StepError(
        `refusing to contact the mailbox at ${host}: it is not in the allow-list of project "${project.slug ?? project.config.name}" ` +
          `(allowed: ${allowedHosts(project).join(', ')}); add it to allow_hosts in project.yaml`,
      );
    }
    this.headers = { accept: 'application/json' };
    for (const [k, v] of Object.entries(config.headers ?? {})) this.headers[k] = template ? interpolate(v, template) : v;
  }

  get pollMs(): number {
    return this.config.poll_ms ?? 500;
  }

  private async json(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers, signal });
    } catch (e) {
      throw new StepError(`mailbox ${this.base} is not reachable: ${errorMessage(e)}`);
    }
    if (!res.ok) throw new StepError(`mailbox answered HTTP ${res.status} for ${path}`);
    try {
      return await res.json();
    } catch {
      throw new StepError(`mailbox answered something that is not JSON for ${path}`);
    }
  }

  /** The latest messages (summaries). */
  async list(signal?: AbortSignal): Promise<MailSummary[]> {
    if (this.config.provider === 'mailpit') {
      const r = (await this.json('/api/v1/messages?limit=50', signal)) as { messages?: unknown[] };
      return (r.messages ?? []).map((m) => {
        const o = m as Record<string, unknown>;
        return { id: String(o.ID), from: parseAddress(o.From), to: parseAddressList(o.To), subject: String(o.Subject ?? ''), date: o.Created ? String(o.Created) : undefined };
      });
    }
    const r = await this.json('/messages', signal);
    const list = Array.isArray(r) ? r : ((r as { messages?: unknown[] }).messages ?? []);
    return list.map((m) => {
      const o = m as Record<string, unknown>;
      return { id: String(o.id ?? o.ID), from: parseAddress(o.from), to: parseAddressList(o.to), subject: String(o.subject ?? ''), date: o.date ? String(o.date) : undefined };
    });
  }

  /** A full message (text, HTML, inline parts as data: URLs for Mailpit). */
  async get(id: string, signal?: AbortSignal): Promise<MailMessage> {
    if (this.config.provider === 'mailpit') {
      const o = (await this.json(`/api/v1/message/${encodeURIComponent(id)}`, signal)) as Record<string, unknown>;
      const inline: MailMessage['inline'] = [];
      for (const part of (o.Inline as Array<Record<string, unknown>> | undefined) ?? []) {
        const cid = String(part.ContentID ?? '').replace(/^<|>$/g, '');
        if (!cid || part.PartID === undefined) continue;
        try {
          const res = await fetch(`${this.base}/api/v1/message/${encodeURIComponent(id)}/part/${encodeURIComponent(String(part.PartID))}`, { headers: this.headers, signal });
          if (!res.ok) continue;
          const mime = String(part.ContentType ?? res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0];
          inline.push({ cid, mime, data: `data:${mime};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}` });
        } catch {
          /* an inline image that cannot be fetched stays broken */
        }
      }
      return {
        id: String(o.ID ?? id),
        from: parseAddress(o.From),
        to: parseAddressList(o.To),
        cc: parseAddressList(o.Cc),
        subject: String(o.Subject ?? ''),
        date: String(o.Date ?? o.Created ?? new Date().toISOString()),
        text: String(o.Text ?? ''),
        html: String(o.HTML ?? ''),
        inline,
      };
    }
    const o = (await this.json(`/messages/${encodeURIComponent(id)}`, signal)) as Record<string, unknown>;
    return {
      id: String(o.id ?? id),
      from: parseAddress(o.from),
      to: parseAddressList(o.to),
      cc: parseAddressList(o.cc),
      subject: String(o.subject ?? ''),
      date: String(o.date ?? new Date().toISOString()),
      text: String(o.text ?? ''),
      html: String(o.html ?? ''),
      inline: [],
    };
  }
}

/** Replace cid: references of an email's HTML with the inline parts' data: URLs. */
export function inlineCids(html: string, inline: MailMessage['inline']): string {
  let out = html;
  for (const p of inline) out = out.split(`cid:${p.cid}`).join(p.data);
  return out;
}
