// Optional SMTP relay of the fixture's mailbox: with NORTHFIELD_SMTP=host:port (or --smtp host:port) every message the
// fixture sends (sign-up confirmations) is also delivered to that SMTP server — a real Mailpit in the fixture's Docker
// sandbox — besides the in-memory mailbox (server/mailbox.mjs, the default). A small client on node:net, no dependency:
// EHLO (HELO when refused), MAIL FROM, RCPT TO, DATA, QUIT; no TLS and no authentication (a local mail catcher only).
// The message is MIME: multipart/related { multipart/alternative { text/plain, text/html }, the inline cid: parts },
// bodies in base64 (no line over 76 characters), non-ASCII headers as RFC 2047 encoded words. A delivery that fails is
// logged, never thrown.

import net from 'node:net';

/** "host:port" (or "[::1]:port") → {host, port}; port 25 when none is given. */
export function parseSmtpTarget(value) {
  const s = String(value ?? '').trim();
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
  const port = m?.[2] === undefined ? 25 : Number(m[2]);
  if (!m || !m[1] || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`the SMTP server must be host:port (like mailpit:1025), got "${s}"`);
  }
  return { host: m[1], port };
}

const ASCII = /^[\x20-\x7e]*$/;

/** A header value: as it is when printable ASCII, else RFC 2047 base64 words of at most 75 characters, folded. */
export function encodeWord(text) {
  const s = String(text ?? '');
  if (ASCII.test(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

/** {name?, address} | "address" → `"Name" <address>` (the name encoded when it is not ASCII). */
export function formatMailbox(a) {
  const { name = '', address } = typeof a === 'string' ? { address: a } : a;
  if (!name) return `<${address}>`;
  const shown = ASCII.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeWord(name);
  return `${shown} <${address}>`;
}

const base64Lines = (data) =>
  Buffer.from(data)
    .toString('base64')
    .replace(/.{76}/g, '$&\r\n')
    .replace(/\r\n$/, '');

/**
 * The message as MIME text (CRLF line ends).
 * @param {{ from: {name?: string, address: string}, to: Array<string | {name?: string, address: string}>, subject: string, html: string, text: string,
 *           inline?: Array<{ cid: string, type: string, name: string, data: Buffer }> }} m
 * @param {{ messageId: string, date?: Date, boundary?: string }} opts
 */
export function buildMime(m, opts) {
  const tag = opts.boundary ?? `nf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const alt = `${tag}-alt`;
  const rel = `${tag}-rel`;
  const date = (opts.date ?? new Date()).toUTCString().replace(/GMT$/, '+0000');
  const headers = [
    `From: ${formatMailbox(m.from)}`,
    `To: ${m.to.map(formatMailbox).join(', ')}`,
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${date}`,
    `Message-ID: <${opts.messageId}>`,
    'MIME-Version: 1.0',
  ];
  const alternative = [
    `--${alt}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(m.text),
    `--${alt}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(m.html),
    `--${alt}--`,
  ];
  const inline = m.inline ?? [];
  let body;
  if (!inline.length) {
    headers.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
    body = alternative;
  } else {
    headers.push(`Content-Type: multipart/related; boundary="${rel}"; type="multipart/alternative"`);
    body = [`--${rel}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '', ...alternative, ''];
    for (const p of inline) {
      body.push(
        `--${rel}`,
        `Content-Type: ${p.type}; name="${p.name}"`,
        'Content-Transfer-Encoding: base64',
        `Content-ID: <${p.cid}>`,
        `Content-Disposition: inline; filename="${p.name}"`,
        '',
        base64Lines(p.data),
      );
    }
    body.push(`--${rel}--`);
  }
  return `${[...headers, '', ...body].join('\r\n')}\r\n`;
}

/** DATA's payload: CRLF line ends, a leading "." doubled (dot-stuffing), the terminating "." line. */
export function dataPayload(mime) {
  const crlf = String(mime).replace(/\r?\n/g, '\r\n');
  const stuffed = crlf.replace(/(^|\r\n)\./g, '$1..');
  return `${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`;
}

/**
 * One SMTP transaction. Resolves when the server accepted the message (250 after DATA); rejects with the reply that
 * failed, a socket error or a timeout.
 * @param {{ host: string, port: number, from: string, to: string[], data: string, helo?: string, timeoutMs?: number }} o
 */
export function smtpSend(o) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(o.port, o.host);
    const helo = o.helo ?? 'northfield.local';
    let buf = '';
    let lines = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(o.timeoutMs ?? 10_000, () => finish(new Error(`no answer from ${o.host}:${o.port} within ${o.timeoutMs ?? 10_000} ms`)));
    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish(new Error(`${o.host}:${o.port} closed the connection`)));
    // Each step: the reply codes expected now, and what to send when one arrives (null: done).
    const steps = [
      { want: [220], send: `EHLO ${helo}` },
      { want: [250], send: `MAIL FROM:<${o.from}>` },
      ...o.to.map((addr, i) => ({ want: i === 0 ? [250] : [250, 251], send: `RCPT TO:<${addr}>` })),
      { want: [250, 251], send: 'DATA' },
      { want: [354], send: o.data, raw: true },
      { want: [250], send: 'QUIT' },
      { want: [221], send: null },
    ];
    let i = 0;
    let retried = false;
    const onReply = (code, text) => {
      const step = steps[i];
      if (!step.want.includes(code)) {
        // EHLO refused (an old server): HELO instead, once.
        if (i === 1 && !retried && code >= 500) {
          retried = true;
          socket.write(`HELO ${helo}\r\n`);
          return;
        }
        finish(new Error(`${o.host}:${o.port} answered "${text}" (expected ${step.want.join(' or ')})`));
        return;
      }
      i++;
      if (step.send === null) {
        finish();
        return;
      }
      socket.write(step.raw ? step.send : `${step.send}\r\n`);
    };
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        lines.push(line);
        // A reply ends with "NNN text" (a "NNN-text" line continues it).
        if (/^\d{3}(?: |$)/.test(line)) {
          const reply = lines.join(' | ');
          lines = [];
          onReply(Number(line.slice(0, 3)), reply);
          if (done) return;
        }
      }
    });
  });
}

/** Delivers the fixture's messages to an SMTP server; never throws (a failure is logged). */
export class SmtpRelay {
  /**
   * @param {string | { host: string, port: number }} target "host:port"
   * @param {{ log?: (msg: string) => void, timeoutMs?: number }} [opts]
   */
  constructor(target, opts = {}) {
    this.target = typeof target === 'string' ? parseSmtpTarget(target) : target;
    this.log = opts.log ?? ((msg) => console.log(msg));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get label() {
    return `${this.target.host}:${this.target.port}`;
  }

  /**
   * @param {Parameters<typeof buildMime>[0]} m
   * @param {{ messageId: string }} meta
   * @returns {Promise<boolean>} delivered
   */
  async deliver(m, meta) {
    const to = m.to.map((a) => (typeof a === 'string' ? a : a.address));
    try {
      const data = dataPayload(buildMime(m, { messageId: meta.messageId }));
      await smtpSend({ host: this.target.host, port: this.target.port, from: m.from.address, to, data, timeoutMs: this.timeoutMs });
      this.log(`[northfield] mail "${m.subject}" to ${to.join(', ')} delivered over SMTP to ${this.label}`);
      return true;
    } catch (err) {
      this.log(`[northfield] mail "${m.subject}" to ${to.join(', ')} could not be delivered over SMTP to ${this.label}: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}
