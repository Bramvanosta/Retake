/**
 * Raw HTTP requests for the Studio server tests: every header as given (Host included), nothing added by fetch; a free
 * port for a test that must name one before it listens.
 */
import { request } from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  json<T = Record<string, unknown>>(): T;
}

/** A request to 127.0.0.1:`port`; Host defaults to `127.0.0.1:<port>`; a body gets its Content-Length. */
export function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const h: OutgoingHttpHeaders = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = String(Buffer.byteLength(body));
    const req = request({ host: '127.0.0.1', port, method, path, headers: h, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json: <T>() => JSON.parse(text) as T });
      });
      res.on('error', reject);
    });
    // A server that refuses a body (413) answers and closes while the body is still being written: the answer counts.
    let answered = false;
    req.on('response', () => (answered = true));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (answered) return;
      if (e.code === 'ECONNRESET' || e.code === 'EPIPE') resolve({ status: -1, headers: {}, body: '', json: <T>() => ({}) as T });
      else reject(e);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Listens on `host`:`port` and closes again: the port it got (0: the system picks one), or null when it is taken. */
function tryListen(host: string, port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.once('error', () => resolve(null));
    s.listen({ port, host, exclusive: true }, () => {
      const got = (s.address() as AddressInfo).port;
      s.close(() => resolve(got));
    });
  });
}

/**
 * A TCP port free on every one of `hosts` right now (the first host picks it, the others are checked), for a test that
 * must name a port before something listens on it — never a fixed number, which another session or a stray listener
 * may hold. Another program can still take it in between: the test then fails on its own listen, as it would anyway.
 */
export async function freePort(hosts: string[] = ['127.0.0.1']): Promise<number> {
  const [first, ...others] = hosts;
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await tryListen(first ?? '127.0.0.1', 0);
    if (port === null) break;
    let free = true;
    for (const h of others) if ((await tryListen(h, port)) === null) free = false;
    if (free) return port;
  }
  throw new Error(`no port free on ${hosts.join(' and ')}`);
}
