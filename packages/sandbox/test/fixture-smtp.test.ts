/**
 * The fixture's SMTP relay (fixtures/wholesale/server/smtp.mjs, L1.8): what its Docker sandbox uses to deliver mail to
 * a real Mailpit. Against a tiny SMTP server in the test: the conversation (EHLO, MAIL FROM, one RCPT per recipient,
 * DATA, QUIT; HELO when EHLO is refused), the MIME message (RFC 2047 subject, multipart/related with the cid: logo,
 * base64 bodies with short lines, dot-stuffing), failures logged and never thrown, and the fixture server delivering
 * a sign-up confirmation with `smtp` while its in-memory mailbox keeps it too.
 */
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = join(REPO, 'fixtures/wholesale');

interface Mail {
  from: { name?: string; address: string };
  to: Array<string | { name?: string; address: string }>;
  subject: string;
  html: string;
  text: string;
  inline?: Array<{ cid: string; type: string; name: string; data: Buffer }>;
}
interface SmtpModule {
  parseSmtpTarget(v: string): { host: string; port: number };
  encodeWord(s: string): string;
  buildMime(m: Mail, o: { messageId: string; date?: Date; boundary?: string }): string;
  dataPayload(mime: string): string;
  smtpSend(o: { host: string; port: number; from: string; to: string[]; data: string; timeoutMs?: number }): Promise<void>;
  SmtpRelay: new (target: string, opts?: { log?: (m: string) => void; timeoutMs?: number }) => { label: string; deliver(m: Mail, meta: { messageId: string }): Promise<boolean> };
}
const smtp = async () => (await import(join(FIXTURE, 'server/smtp.mjs'))) as SmtpModule;

/** One SMTP session as the test server saw it. */
interface Session {
  commands: string[];
  data: string;
}

/**
 * A minimal SMTP server: 220, then 250 to every command but DATA (354, then 250 after the "." line) and QUIT (221).
 * `reply` overrides the answer to a command (by its first word).
 */
async function smtpServer(reply: Record<string, string> = {}): Promise<{ port: number; sessions: Session[]; server: Server }> {
  const sessions: Session[] = [];
  const server = createServer((socket: Socket) => {
    const s: Session = { commands: [], data: '' };
    sessions.push(s);
    let buf = '';
    let inData = false;
    socket.write('220 test.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          s.data = buf.slice(0, end + 2);
          buf = buf.slice(end + 5);
          inData = false;
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        s.commands.push(line);
        const verb = line.split(/[ :]/)[0].toUpperCase();
        if (reply[verb]) socket.write(`${reply[verb]}\r\n`);
        else if (verb === 'EHLO') socket.write('250-test.local\r\n250-8BITMIME\r\n250 SIZE 10240000\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as { port: number }).port, sessions, server };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});
async function started(reply?: Record<string, string>) {
  const srv = await smtpServer(reply);
  servers.push(srv.server);
  return srv;
}

/** The body of a MIME part found by one of its header lines, base64-decoded. */
function part(mime: string, header: string): string {
  const at = mime.indexOf(header);
  expect(at, header).toBeGreaterThan(-1);
  const start = mime.indexOf('\r\n\r\n', at) + 4;
  const end = mime.indexOf('\r\n--', start);
  return Buffer.from(mime.slice(start, end).replace(/\r\n/g, ''), 'base64').toString('utf8');
}

const LOGO = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
const MAIL: Mail = {
  from: { name: 'Northfield', address: 'hello@northfield.example' },
  to: [{ name: 'Noa Brandt', address: 'noa@cafe-lumen.example' }, 'orders@cafe-lumen.example'],
  subject: 'Confirm your email to open your café account',
  text: `Hi Noa,\n.a line that starts with a dot\n${'long '.repeat(300)}`,
  html: `<p>Hi <b>Noa</b> <img src="cid:northfield-logo"></p>${'<span>x</span>'.repeat(200)}`,
  inline: [{ cid: 'northfield-logo', type: 'image/svg+xml', name: 'logo.svg', data: LOGO }],
};

describe('the fixture SMTP relay (server/smtp.mjs)', () => {
  it('parses host:port targets and refuses malformed ones', async () => {
    const { parseSmtpTarget } = await smtp();
    expect(parseSmtpTarget('mailpit:1025')).toEqual({ host: 'mailpit', port: 1025 });
    expect(parseSmtpTarget('[::1]:2525')).toEqual({ host: '::1', port: 2525 });
    expect(parseSmtpTarget('localhost')).toEqual({ host: 'localhost', port: 25 });
    expect(() => parseSmtpTarget('mailpit:99999')).toThrow(/host:port/);
    expect(() => parseSmtpTarget('')).toThrow(/host:port/);
  });

  it('builds a multipart/related message: encoded subject, text + HTML in base64, the cid: part inline, no line over 76 characters', async () => {
    const { buildMime, encodeWord, dataPayload } = await smtp();
    expect(encodeWord('Plain subject')).toBe('Plain subject');
    const word = encodeWord(MAIL.subject);
    expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(word.length).toBeLessThanOrEqual(75);
    // A long non-ASCII subject: several words of at most 75 characters, folded.
    const long = encodeWord('Café '.repeat(30));
    expect(long.split('\r\n ').every((w) => w.length <= 75 && /^=\?UTF-8\?B\?.+\?=$/.test(w))).toBe(true);
    expect(
      long
        .split('\r\n ')
        .map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8'))
        .join(''),
    ).toBe('Café '.repeat(30));

    const mime = buildMime(MAIL, { messageId: 'm0001@northfield.example', date: new Date('2026-11-02T10:24:00Z'), boundary: 'b' });
    const head = mime.slice(0, mime.indexOf('\r\n\r\n'));
    expect(head.split('\r\n')).toEqual([
      'From: "Northfield" <hello@northfield.example>',
      'To: "Noa Brandt" <noa@cafe-lumen.example>, <orders@cafe-lumen.example>',
      `Subject: ${word}`,
      'Date: Mon, 02 Nov 2026 10:24:00 +0000',
      'Message-ID: <m0001@northfield.example>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="b-rel"; type="multipart/alternative"',
    ]);
    expect(mime).toContain('\r\n--b-rel\r\nContent-Type: multipart/alternative; boundary="b-alt"\r\n');
    expect(part(mime, 'Content-Type: text/plain; charset=utf-8')).toBe(MAIL.text);
    expect(part(mime, 'Content-Type: text/html; charset=utf-8')).toBe(MAIL.html);
    expect(mime).toContain('Content-ID: <northfield-logo>\r\nContent-Disposition: inline; filename="logo.svg"');
    expect(part(mime, 'Content-ID: <northfield-logo>')).toBe(LOGO.toString('utf8'));
    expect(mime.endsWith('--b-rel--\r\n')).toBe(true);
    expect(mime.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(Math.max(...mime.split('\r\n').map((l) => l.length))).toBeLessThanOrEqual(998);
    expect(
      Math.max(
        ...mime
          .split('\r\n')
          .filter((l) => /^[A-Za-z0-9+/=]+$/.test(l))
          .map((l) => l.length),
      ),
    ).toBe(76);

    // Without inline parts: multipart/alternative only.
    const plain = buildMime({ ...MAIL, inline: [] }, { messageId: 'x@y', boundary: 'c' });
    expect(plain).toContain('Content-Type: multipart/alternative; boundary="c-alt"');
    expect(plain).not.toContain('multipart/related');

    // DATA: CRLF everywhere, a line starting with "." doubled, then the "." line.
    expect(dataPayload('A\n.b\r\n..c\nd')).toBe('A\r\n..b\r\n...c\r\nd\r\n.\r\n');
    expect(dataPayload('.first\r\n')).toBe('..first\r\n.\r\n');
  });

  it('delivers over SMTP: EHLO, MAIL FROM, one RCPT per recipient, DATA (dot-stuffed), QUIT', async () => {
    const { SmtpRelay } = await smtp();
    const srv = await started();
    const logs: string[] = [];
    const relay = new SmtpRelay(`127.0.0.1:${srv.port}`, { log: (m) => logs.push(m) });
    expect(await relay.deliver({ ...MAIL, text: '.hidden dot' }, { messageId: 'm1@northfield.example' })).toBe(true);
    expect(srv.sessions).toHaveLength(1);
    const [s] = srv.sessions;
    expect(s.commands).toEqual(['EHLO northfield.local', 'MAIL FROM:<hello@northfield.example>', 'RCPT TO:<noa@cafe-lumen.example>', 'RCPT TO:<orders@cafe-lumen.example>', 'DATA', 'QUIT']);
    expect(s.data).toContain('Message-ID: <m1@northfield.example>');
    expect(s.data).toContain('Subject: =?UTF-8?B?');
    expect(part(s.data, 'Content-Type: text/plain; charset=utf-8')).toBe('.hidden dot');
    expect(logs).toEqual([`[northfield] mail "${MAIL.subject}" to noa@cafe-lumen.example, orders@cafe-lumen.example delivered over SMTP to 127.0.0.1:${srv.port}`]);
  });

  it('says HELO when EHLO is refused', async () => {
    const { SmtpRelay } = await smtp();
    const srv = await started({ EHLO: '502 5.5.2 command not recognized' });
    const relay = new SmtpRelay(`127.0.0.1:${srv.port}`, { log: () => undefined });
    expect(await relay.deliver(MAIL, { messageId: 'm2@x' })).toBe(true);
    expect(srv.sessions[0].commands.slice(0, 3)).toEqual(['EHLO northfield.local', 'HELO northfield.local', 'MAIL FROM:<hello@northfield.example>']);
  });

  it('a refused recipient, a closed port or a silent server is logged and never thrown', async () => {
    const { SmtpRelay } = await smtp();
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const refusing = await started({ RCPT: '550 5.1.1 no such user' });
    expect(await new SmtpRelay(`127.0.0.1:${refusing.port}`, { log }).deliver(MAIL, { messageId: 'a@x' })).toBe(false);
    expect(logs.pop()).toMatch(/could not be delivered over SMTP to 127\.0\.0\.1:\d+: 127\.0\.0\.1:\d+ answered "550 5\.1\.1 no such user" \(expected 250 or 251\)/);

    const closed = await started();
    const port = closed.port;
    await new Promise((r) => closed.server.close(() => r(undefined)));
    servers.splice(servers.indexOf(closed.server), 1);
    expect(await new SmtpRelay(`127.0.0.1:${port}`, { log }).deliver(MAIL, { messageId: 'b@x' })).toBe(false);
    expect(logs.pop()).toMatch(/could not be delivered over SMTP to 127\.0\.0\.1:\d+: .*ECONNREFUSED/);

    const silent = createServer(() => undefined);
    servers.push(silent);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const t0 = Date.now();
    expect(await new SmtpRelay(`127.0.0.1:${(silent.address() as { port: number }).port}`, { log, timeoutMs: 300 }).deliver(MAIL, { messageId: 'c@x' })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(logs.pop()).toMatch(/no answer from 127\.0\.0\.1:\d+ within 300 ms/);
  });

  it('the fixture server with `smtp`: a sign-up confirmation goes to the SMTP server and stays in its own mailbox', async () => {
    const srv = await started();
    const logs: string[] = [];
    const mod = (await import(join(FIXTURE, 'server.mjs'))) as {
      startFixture(o: object): Promise<{
        urls: { console: string; shop: string };
        smtp: string | null;
        mailbox: { messages: Array<{ Subject: string; MessageID: string }>; flush(): Promise<void> };
        close(): Promise<void>;
      }>;
    };
    const fx = await mod.startFixture({ consolePort: 0, shopPort: 0, host: '127.0.0.1', build: false, smtp: `127.0.0.1:${srv.port}`, log: (m: string) => logs.push(m) });
    try {
      expect(fx.smtp).toBe(`127.0.0.1:${srv.port}`);
      const res = await fetch(`${fx.urls.console}/api/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cafe: 'Café Lumen', name: 'Noa Brandt', email: 'noa@cafe-lumen.example' }),
      });
      expect(res.status).toBe(201);
      for (let i = 0; i < 100 && !fx.mailbox.messages.length; i++) await new Promise((r) => setTimeout(r, 50));
      await fx.mailbox.flush();
      expect(fx.mailbox.messages.map((m) => m.Subject)).toEqual(['Confirm your email to open your café account']);
      expect(srv.sessions).toHaveLength(1);
      const data = srv.sessions[0].data;
      expect(data).toContain(`Message-ID: <${fx.mailbox.messages[0].MessageID}>`);
      expect(data).toContain('To: "Noa Brandt" <noa@cafe-lumen.example>');
      expect(part(data, 'Content-Type: text/plain; charset=utf-8')).toContain(`Confirm my email: ${fx.urls.shop}/signup/confirm?token=confirm-0001`);
      expect(part(data, 'Content-Type: text/html; charset=utf-8')).toContain('<img src="cid:northfield-logo"');
      expect(part(data, 'Content-ID: <northfield-logo>')).toMatch(/^<svg /);
      expect(logs.some((l) => l.includes('delivered over SMTP'))).toBe(true);
    } finally {
      await fx.close();
    }
  });
});
