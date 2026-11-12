/** Raw HTTP requests for the Studio server tests: every header as given (Host included), nothing added by fetch. */
import { request } from 'node:http';
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

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
