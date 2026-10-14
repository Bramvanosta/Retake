// A test mailbox with a Mailpit-compatible API (the subset Demo Studio's `wait_for_email` reads), served by the fixture
// under /mailbox on both ports:
//   GET    /mailbox/api/v1/messages[?limit=N]          → {total, count, messages: [{ID, From, To, Subject, Created, Snippet, …}]} newest first
//   GET    /mailbox/api/v1/message/:id                 → {ID, From, To, Cc, Subject, Date, Text, HTML, Inline: [{PartID, ContentID, ContentType, FileName}]}
//   GET    /mailbox/api/v1/message/:id/part/:partId    → the bytes of an inline part (cid: images)
//   DELETE /mailbox/api/v1/messages                    → delete every message
// The fixture "sends" mail by appending to it (sign-up confirmations); POST /api/reset empties it. With an SMTP relay
// (server/smtp.mjs: NORTHFIELD_SMTP=host:port) every message is also delivered to that server — a real Mailpit.

import { sendError, sendJson, sendText } from './http.mjs';

const addr = (a) => (typeof a === 'string' ? { Name: '', Address: a } : { Name: a.name ?? '', Address: a.address });

export class Mailbox {
  /** @param {{ relay?: import('./smtp.mjs').SmtpRelay }} [opts] */
  constructor(opts = {}) {
    this.messages = [];
    this.seq = 0;
    this.relay = opts.relay ?? null;
    /** Deliveries over SMTP still running (flush() waits for them). */
    this.pending = new Set();
  }

  /** Resolves when every SMTP delivery started so far has ended (delivered or logged as failed). */
  async flush() {
    await Promise.all([...this.pending]);
  }

  clear() {
    this.messages = [];
  }

  /**
   * @param {{ from: {name?: string, address: string}, to: Array<string | {name?: string, address: string}>, subject: string, html: string, text: string,
   *           inline?: Array<{ cid: string, type: string, name: string, data: Buffer }> }} m
   */
  send(m) {
    const id = `m${String(++this.seq).padStart(4, '0')}-${Date.now().toString(36)}`;
    const msg = {
      ID: id,
      MessageID: `${id}@northfield.example`,
      From: addr(m.from),
      To: m.to.map(addr),
      Cc: [],
      Subject: m.subject,
      Created: new Date().toISOString(),
      Text: m.text,
      HTML: m.html,
      inline: (m.inline ?? []).map((p, i) => ({ PartID: String(i + 2), ContentID: p.cid, ContentType: p.type, FileName: p.name, data: p.data })),
    };
    this.messages.unshift(msg);
    if (this.relay) {
      const delivery = this.relay.deliver(m, { messageId: msg.MessageID }).finally(() => this.pending.delete(delivery));
      this.pending.add(delivery);
    }
    return msg;
  }

  summary(m) {
    return {
      ID: m.ID,
      MessageID: m.MessageID,
      Read: false,
      From: m.From,
      To: m.To,
      Cc: m.Cc,
      Subject: m.Subject,
      Created: m.Created,
      Size: m.HTML.length + m.Text.length,
      Attachments: 0,
      Snippet: m.Text.replace(/\s+/g, ' ').trim().slice(0, 120),
    };
  }
}

/** Handles /mailbox/api/v1/*. Returns false when the path is not a mailbox route. */
export function handleMailbox(req, res, url, mailbox) {
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/mailbox/api/v1/messages') {
    if (req.method === 'DELETE') {
      mailbox.clear();
      sendJson(res, 200, { ok: true });
      return true;
    }
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 50) || 50));
    const list = mailbox.messages.slice(0, limit).map((m) => mailbox.summary(m));
    sendJson(res, 200, { total: mailbox.messages.length, unread: mailbox.messages.length, count: list.length, messages_count: mailbox.messages.length, start: 0, tags: [], messages: list });
    return true;
  }
  const part = /^\/mailbox\/api\/v1\/message\/([^/]+)\/part\/([^/]+)$/.exec(path);
  if (part) {
    const m = mailbox.messages.find((x) => x.ID === decodeURIComponent(part[1]));
    const p = m?.inline.find((x) => x.PartID === part[2]);
    if (!p) sendError(res, 404, 'not_found', 'No such part');
    else sendText(res, 200, p.ContentType, p.data);
    return true;
  }
  const one = /^\/mailbox\/api\/v1\/message\/([^/]+)$/.exec(path);
  if (one) {
    const m = mailbox.messages.find((x) => x.ID === decodeURIComponent(one[1]));
    if (!m) {
      sendError(res, 404, 'not_found', `No message ${one[1]}`);
      return true;
    }
    sendJson(res, 200, {
      ...mailbox.summary(m),
      ReturnPath: m.From.Address,
      Date: m.Created,
      Text: m.Text,
      HTML: m.HTML,
      Inline: m.inline.map(({ data: _d, ...p }) => ({ ...p, Size: _d.length })),
      Attachments: [],
    });
    return true;
  }
  if (path.startsWith('/mailbox')) {
    sendError(res, 404, 'not_found', `No mailbox route ${url.pathname} (GET /mailbox/api/v1/messages lists the messages)`);
    return true;
  }
  return false;
}
