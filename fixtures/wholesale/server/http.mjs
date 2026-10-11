// Minimal HTTP helpers for node:http (no framework).

const MAX_BODY = 1024 * 1024;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

export function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...CORS,
    ...extraHeaders,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

export function sendError(res, status, code, message, details) {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}

export function sendText(res, status, contentType, body, extraHeaders = {}) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'content-type': contentType, 'content-length': buf.length, ...extraHeaders });
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

export function sendPreflight(res) {
  res.writeHead(204, { ...CORS, 'access-control-max-age': '600' });
  res.end();
}

/** Parses a JSON request body. Empty body → undefined. */
export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', `Request body exceeds ${MAX_BODY} bytes`);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError(400, 'invalid_json', `Request body is not valid JSON: ${err.message}`);
  }
}

/**
 * Compiles "/api/products/:slug/refs" into a matcher returning the params or null.
 * @param {string} pattern
 */
export function compilePath(pattern) {
  const keys = [];
  const re = new RegExp(
    `^${pattern
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/')}/?$`,
  );
  return (path) => {
    const m = re.exec(path);
    if (!m) return null;
    return Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  };
}
