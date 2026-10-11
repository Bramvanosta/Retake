/**
 * Local static HTTP server for the files a render needs (capture, fonts, logo, wordmark, music): bound to 127.0.0.1
 * on a random port for the duration of a render or a still, serving only the registered files (under a random token),
 * with Range requests (the video frame extractor reads the capture by ranges) and CORS (fonts are loaded by a page
 * served from another origin).
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
};

export interface AssetServer {
  /** http://127.0.0.1:<port> */
  readonly origin: string;
  /** Register a file (absolute or relative to the cwd) and get its URL; the same file always gets the same URL. */
  urlFor(file: string): string;
  /** Requests served so far (tests, debugging). */
  readonly requests: number;
  close(): Promise<void>;
}

/** Parse a `Range: bytes=…` header for a file of `size` bytes: [start, end] inclusive, 'invalid' (416) or null (whole file). */
export function parseRange(header: string | undefined, size: number): [number, number] | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return header.trim().startsWith('bytes=') ? 'invalid' : null; // multi-range and other units: whole file
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'invalid';
    return [Math.max(0, size - n), size - 1];
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || end < start) return 'invalid';
  return [start, end];
}

function contentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Start the server. Close it when the render is over (renderVideo / renderStill do). */
export async function startAssetServer(): Promise<AssetServer> {
  const token = randomBytes(9).toString('base64url');
  const byPath = new Map<string, string>();
  const byFile = new Map<string, string>();
  let requests = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    requests++;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS' }).end();
      return;
    }
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = byPath.get(path);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    let size: number;
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`missing file: ${basename(file)}`);
      return;
    }
    const headers: Record<string, string | number> = {
      'Content-Type': contentType(file),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    const [start, end] = range ?? [0, size - 1];
    const length = size === 0 ? 0 : end - start + 1;
    headers['Content-Length'] = length;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || length === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    get requests() {
      return requests;
    },
    urlFor(file: string): string {
      const abs = resolve(file);
      let path = byFile.get(abs);
      if (!path) {
        const name = basename(abs).replace(/[^A-Za-z0-9._-]+/g, '_') || 'file';
        path = `/${token}/${byFile.size}/${name}`;
        byFile.set(abs, path);
        byPath.set(path, abs);
      }
      return `${origin}${path}`;
    },
    close(): Promise<void> {
      return new Promise((ok) => {
        server.closeAllConnections?.();
        server.close(() => ok());
      });
    },
  };
}
