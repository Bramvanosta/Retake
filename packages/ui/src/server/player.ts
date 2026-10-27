/**
 * The player origin (L4.5, DESIGN §4g; critiques B4, B6, B15, B16): a second loopback listener of the Studio process,
 * `http://127.0.0.1:<Q>`, that serves the sandboxed preview frame and nothing else — no `/v1`, no op, no event.
 *
 * A capability `<cap>` (32 random bytes) is in every path, one per SCOPE (review A L3: the Studio scopes by project):
 * a scope's capability reaches only the files registered in that scope; it is created on the scope's first use,
 * replaced by `rotate()`, dropped by `release(scope)` (the Studio releases a project when its last timeline page left)
 * and revoked by `close()` — every older URL then answers 404. It is never logged (errors name the route family only),
 * never in a Referer (`no-referrer` everywhere), and the page that holds it is the Studio page that framed it.
 *
 * - `GET /s/<cap>/frame` — the frame document: no inline script, its first script `boot.<hash>.js` (WebRTC removed), the
 *   bundle `b.<hash>.js` (bundle-player.ts), the Studio origins allowed to frame it in a `<meta>`; the frame CSP below
 *   as a header, with `sandbox allow-scripts` (sandboxed even when opened on its own). Never cached.
 * - `GET /s/<cap>/boot.<hash>.js`, `/s/<cap>/b.<hash>.js` — the scripts (immutable: the hash names the build).
 * - `GET /m/<cap>/plan/<id>.json` — a preview plan (editor previewPlan: capability URLs, no path, no product URL hidden
 *   from the bar, no display table, notes or warnings), served from memory (critique B4: never in a JSON op).
 * - `GET|HEAD /m/<cap>/<file id>/<name>` — a registered file: the capture, page tracks, fonts, logo, music, card media
 *   and artefact pages of a plan, i.e. the files planRun's trust gate 2 put inside the project, the run or the theme —
 *   registered only when its real path lies in one of those folders, the path is no link and the file has one name
 *   (a hard link may be a file outside the folders: review A N4); ids are random and stable per (device, inode,
 *   size, mtime) for the scope (critique B6: a switch keeps every media URL, so no `<video>`
 *   reloads), and each read opens the file without following a link and checks it is still that regular file (a file
 *   swapped for a link or a FIFO since → 404). Range requests; `immutable` caching (the id changes with the file).
 *
 * Gate: engine checkRequest with `allowNullOrigin` (the frame's fetches carry `Origin: null`): Host exactly
 * `127.0.0.1:Q` / `localhost:Q` (421), GET / HEAD only (405), Origin absent, `null` or this origin (403). CORS
 * (`Access-Control-Allow-Origin: null`) only on `/m/` — fonts, the plan and Lottie JSON are CORS fetches of the frame's
 * opaque origin, the one origin allowed to read them (review A L3: no page of a real origin reads a capability URL);
 * the Studio port itself never sends an `Access-Control-*` header.
 *
 * The frame CSP also requires Trusted Types with no policy (review A H1 b): no string reaches an HTML parser
 * (innerHTML, insertAdjacentHTML, document.write, DOMParser, srcdoc…), so markup a component writes cannot add
 * elements the frame's first script (boot.ts) does not see being made.
 */
import { randomBytes, createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, createReadStream, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { checkRequest, listenLoopback, newSecret, secretEquals } from '@demo-studio/engine';
import type { RouteSpec } from '@demo-studio/engine';
import type { EditPlan } from '@demo-studio/editor';
import type { PlayerBundle } from '../player/bundle-player.js';

/** Files registered per scope (a plan has a few dozen). */
export const PLAYER_FILES_MAX = 4096;
/** Preview plans kept per scope (most recent first). */
export const PLAYER_PLANS_KEEP = 16;
/** Scopes kept (the least recently used one is dropped beyond). */
export const PLAYER_SCOPES_MAX = 32;
/** The scope of calls that name none (tests, probes). */
export const DEFAULT_SCOPE = '';
/** Largest preview plan served. */
export const PLAYER_PLAN_MAX = 16 * 1024 * 1024;

const ASSET_ROUTE: RouteSpec = { methods: ['GET', 'HEAD'], token: false, api: false };
const CAP_RE = '[A-Za-z0-9_-]{43}';
const ID_RE = '[A-Za-z0-9_-]{22}';
const FRAME_PATH = new RegExp(`^/s/(${CAP_RE})/frame$`);
const SCRIPT_PATH = new RegExp(`^/s/(${CAP_RE})/(b|boot)\\.([0-9a-f]{16})\\.js$`);
const PLAN_PATH = new RegExp(`^/m/(${CAP_RE})/plan/(${ID_RE})\\.json$`);
const FILE_PATH = new RegExp(`^/m/(${CAP_RE})/(${ID_RE})/([A-Za-z0-9._-]{1,80})$`);
const MEDIA_HEADERS = {
  'Access-Control-Allow-Origin': 'null',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Cache-Control': 'private, max-age=86400, immutable',
  // Never a document: a file opened on its own (an SVG) runs nothing.
  'Content-Security-Policy': "default-src 'none'; sandbox",
} as const;
const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-DNS-Prefetch-Control': 'off',
  // The frame's requests come from an opaque origin: cross-origin to every resource.
  'Cross-Origin-Resource-Policy': 'cross-origin',
} as const;

/** The frame document's CSP (pure; the capability scopes every source). */
export function frameCsp(origin: string, cap: string, studioPort: number): string {
  const m = `${origin}/m/${cap}/`;
  return [
    "default-src 'none'",
    `script-src ${origin}/s/${cap}/`,
    // The Player and the components set inline styles; with img / font / connect pinned to /m/, CSS sends nothing out.
    "style-src 'unsafe-inline'",
    `img-src ${m} data:`,
    // data: the Player's silent audio tag.
    `media-src ${m} data:`,
    `font-src ${m} data:`,
    `connect-src ${m}`,
    "worker-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors http://127.0.0.1:${studioPort} http://localhost:${studioPort}`,
    'sandbox allow-scripts',
    // Review A H1 (b): no HTML parsing from a string anywhere in the frame (no policy can be created).
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join('; ');
}

/** The frame document (pure). */
export function frameHtml(cap: string, hash: string, studioPort: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="ds-parent" content="http://127.0.0.1:${studioPort} http://localhost:${studioPort}">
<title>Preview</title>
<script src="/s/${cap}/boot.${hash}.js"></script>
<script src="/s/${cap}/b.${hash}.js" defer></script>
</head>
<body style="margin:0;background:#000;overflow:hidden">
<div id="root" style="position:fixed;inset:0"></div>
</body>
</html>
`;
}

interface FileRecord {
  real: string;
  name: string;
  ext: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface PlayerServerOptions {
  /** The Studio's port: only `http://127.0.0.1:<it>` and `http://localhost:<it>` may frame the preview. */
  studioPort: number;
  /** The current bundle (the server asks for it on each frame document; PlayerBundles memoises it). */
  bundle: () => Promise<PlayerBundle>;
  /** Diagnostics: the route family and the error's name, never a path or a capability. */
  log?: (message: string) => void;
  /** 0 or absent: a free port. */
  port?: number;
}

export interface PublishedPreview {
  /** The frame's URL (it holds the session capability). */
  frame_url: string;
  /** The preview plan's URL (`load {plan_url}`). */
  plan_url: string;
}

export interface PlayerServer {
  /** `http://127.0.0.1:<port>` (no secret). */
  readonly origin: string;
  readonly port: number;
  /** `<origin>/s/<cap>/frame` of a scope (default: DEFAULT_SCOPE). */
  frameUrl(scope?: string): string;
  /**
   * Serve `file` under a scope's capability, when its real path lies inside one of `within`, the path is no link and
   * the file has one name: its URL (the same file → the same URL in that scope), or undefined (refused).
   */
  register(file: string, within: readonly string[], scope?: string): string | undefined;
  /**
   * The preview of a planned view (engine timeline.view's `plan` and `folders`): every asset registered in `scope`, the
   * preview plan built (editor previewPlan; `forbid` adds folders no string of it may name) and served. Throws
   * PreviewPlanError when an asset cannot be served.
   */
  publish(view: { plan: EditPlan; folders: { project: string; run: string; theme: string } }, o?: { forbid?: readonly string[]; scope?: string }): Promise<PublishedPreview>;
  /** A new capability for every scope: every URL given so far answers 404. */
  rotate(): void;
  /** Drop a scope: its capability, files and plans — its URLs answer 404 (a later use starts it again, new capability). */
  release(scope: string): void;
  /** Scopes alive (tests). */
  readonly scopes: number;
  /** Requests received (tests). */
  readonly requests: number;
  /** Revoke the capability and stop listening. */
  close(): Promise<void>;
}

const newCap = () => newSecret();
const newId = () => randomBytes(16).toString('base64url');

function realOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function isInside(file: string, dir: string): boolean {
  const r = relative(dir, file);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
}

/** The file's name as served: its base name in URL-safe characters (the content type comes from its extension). */
export function servedName(file: string): string {
  const ext = extname(file).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
  const stem = basename(file, extname(file)).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'file';
  return `${stem}${ext}`;
}

/** The descriptor of `rec`'s file when it is still that regular file with one name (opened without following a link), else undefined. */
function openRecorded(rec: FileRecord): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(rec.real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (st.isFile() && st.nlink === 1 && st.dev === rec.dev && st.ino === rec.ino && st.size === rec.size && st.mtimeMs === rec.mtimeMs) return fd;
  } catch {
    // missing, a link, unreadable: refused below
  }
  if (fd !== undefined) closeSync(fd);
  return undefined;
}

const editor = () => import('@demo-studio/editor');

interface Scope {
  cap: string;
  files: Map<string, FileRecord>;
  idByKey: Map<string, string>;
  plans: Map<string, Buffer>;
}

const newScope = (): Scope => ({ cap: newCap(), files: new Map(), idByKey: new Map(), plans: new Map() });

export async function startPlayerServer(o: PlayerServerOptions): Promise<PlayerServer> {
  const log = o.log ?? (() => undefined);
  const unusedToken = newSecret();
  /** Scopes by name, least recently used first; null once closed. */
  let scopes: Map<string, Scope> | null = new Map();
  let port = 0;
  let requests = 0;
  let origin = '';

  /** A scope, made on its first use (the least recently used one dropped beyond PLAYER_SCOPES_MAX). */
  const scopeNamed = (name: string): Scope | undefined => {
    if (scopes === null) return undefined;
    let sc = scopes.get(name);
    if (sc) {
      scopes.delete(name);
      scopes.set(name, sc);
      return sc;
    }
    sc = newScope();
    scopes.set(name, sc);
    while (scopes.size > PLAYER_SCOPES_MAX) scopes.delete(scopes.keys().next().value!);
    return sc;
  };
  /** The scope whose capability this is (compared in constant time with each), or undefined. */
  const scopeOfCap = (given: string): Scope | undefined => {
    let found: Scope | undefined;
    for (const sc of scopes?.values() ?? []) if (secretEquals(given, sc.cap)) found = sc;
    return found;
  };
  const notFound = (res: ServerResponse) => {
    res.writeHead(404, { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': '9' });
    res.end('not found');
  };

  const register = (file: string, within: readonly string[], scope = DEFAULT_SCOPE): string | undefined => {
    const sc = scopeNamed(scope);
    if (!sc) return undefined;
    const real = realOrUndefined(file);
    if (!real) return undefined;
    if (!within.some((d) => {
      const r = realOrUndefined(d);
      return r !== undefined && isInside(real, r);
    })) return undefined;
    try {
      // The path given is no link (its folders may be: the real path is what is read, then never through a link).
      if (lstatSync(file).isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }
    let fd: number | undefined;
    let key: string;
    let rec: FileRecord;
    try {
      fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      const st = fstatSync(fd);
      // One name only: a hard link inside the folders may be a file that lies outside them too (review A N4).
      if (!st.isFile() || st.nlink > 1) return undefined;
      key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
      rec = { real, name: servedName(real), ext: extname(real).toLowerCase(), dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    let id = sc.idByKey.get(key);
    if (id === undefined) {
      if (sc.files.size >= PLAYER_FILES_MAX) return undefined;
      id = newId();
      sc.idByKey.set(key, id);
      sc.files.set(id, rec);
    }
    return `${origin}/m/${sc.cap}/${id}/${sc.files.get(id)!.name}`;
  };

  const serveFile = async (req: IncomingMessage, res: ServerResponse, rec: FileRecord, id: string) => {
    const ed = await editor();
    const fd = openRecorded(rec);
    if (fd === undefined) return notFound(res);
    const etag = `"${id}"`;
    const headers: Record<string, string> = { ...COMMON_HEADERS, ...MEDIA_HEADERS, 'Content-Type': ed.CONTENT_TYPES[rec.ext] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: etag };
    if (req.headers['if-none-match'] === etag) {
      closeSync(fd);
      res.writeHead(304, headers).end();
      return;
    }
    const range = ed.parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, rec.size);
    if (range === 'invalid') {
      closeSync(fd);
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${rec.size}`, 'Content-Length': '0' }).end();
      return;
    }
    const [start, end] = range ?? [0, rec.size - 1];
    const length = rec.size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': String(length), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${rec.size}` } : {}) });
    if (req.method === 'HEAD' || length === 0) {
      closeSync(fd);
      res.end();
      return;
    }
    const stream = createReadStream('', { fd, start, end, autoClose: true });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<string> => {
    requests++;
    const g = checkRequest(req, { port, token: unusedToken, allowNullOrigin: true, route: (p) => (p.startsWith('/s/') || p.startsWith('/m/') ? ASSET_ROUTE : undefined) });
    if (!g.ok) {
      res.writeHead(g.status, { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close', ...(g.allow ? { Allow: g.allow } : {}) });
      res.end(g.message);
      return 'gate';
    }
    const path = g.path;
    let m = FRAME_PATH.exec(path);
    if (m) {
      if (!scopeOfCap(m[1])) return (notFound(res), 'frame');
      const b = await o.bundle();
      const sc = scopeOfCap(m[1]);
      if (!sc) return (notFound(res), 'frame');
      const html = Buffer.from(frameHtml(sc.cap, b.hash, o.studioPort), 'utf8');
      res.writeHead(200, { ...COMMON_HEADERS, 'Content-Security-Policy': frameCsp(origin, sc.cap, o.studioPort), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(html.length) });
      res.end(req.method === 'HEAD' ? undefined : html);
      return 'frame';
    }
    m = SCRIPT_PATH.exec(path);
    if (m) {
      if (!scopeOfCap(m[1])) return (notFound(res), 'script');
      const b = await o.bundle();
      if (b.hash !== m[3] || !scopeOfCap(m[1])) return (notFound(res), 'script');
      const body = m[2] === 'b' ? b.js : b.boot;
      res.writeHead(200, { ...COMMON_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=86400, immutable', 'Content-Length': String(body.length) });
      res.end(req.method === 'HEAD' ? undefined : body);
      return 'script';
    }
    m = PLAN_PATH.exec(path);
    if (m) {
      const body = scopeOfCap(m[1])?.plans.get(m[2]);
      if (!body) return (notFound(res), 'plan');
      res.writeHead(200, { ...COMMON_HEADERS, ...MEDIA_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.length) });
      res.end(req.method === 'HEAD' ? undefined : body);
      return 'plan';
    }
    m = FILE_PATH.exec(path);
    if (m) {
      const rec = scopeOfCap(m[1])?.files.get(m[2]);
      if (!rec || rec.name !== m[3]) return (notFound(res), 'media');
      await serveFile(req, res, rec, m[2]);
      return 'media';
    }
    notFound(res);
    return 'other';
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      // The route family only: a path here holds the capability (critique B16).
      const family = (req.url ?? '').startsWith('/s/') ? 'frame' : (req.url ?? '').startsWith('/m/') ? 'media' : 'other';
      log(`studio player: a ${family} request failed: ${e instanceof Error ? e.name : 'error'}`);
      if (!res.headersSent) {
        res.writeHead(500, { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('internal error');
      } else res.destroy();
    });
  });
  port = await listenLoopback(server, o.port ?? 0);
  origin = `http://127.0.0.1:${port}`;
  let closed: Promise<void> | undefined;

  return {
    origin,
    port,
    frameUrl: (scope = DEFAULT_SCOPE) => {
      const sc = scopeNamed(scope);
      return sc ? `${origin}/s/${sc.cap}/frame` : `${origin}/s/revoked/frame`;
    },
    register,
    async publish(view, po = {}) {
      const scope = po.scope ?? DEFAULT_SCOPE;
      if (!scopeNamed(scope)) throw new Error('the preview server is closed');
      const ed = await editor();
      const within = [view.folders.project, view.folders.run, view.folders.theme];
      const preview = ed.previewPlan(view.plan, {
        urlFor: (_asset, file) => register(resolve(file), within, scope),
        forbid: [...within, ...(po.forbid ?? [])],
      });
      const body = Buffer.from(JSON.stringify(preview), 'utf8');
      if (body.length > PLAYER_PLAN_MAX) throw new ed.PreviewPlanError(`the preview plan is over ${PLAYER_PLAN_MAX} bytes`);
      const id = createHash('sha256').update(body).digest('base64url').slice(0, 22);
      // The scope as it is now (registering made or kept it): a release while planning drops this plan with it.
      const sc = scopeNamed(scope);
      if (!sc) throw new Error('the preview server is closed');
      sc.plans.delete(id);
      sc.plans.set(id, body);
      while (sc.plans.size > PLAYER_PLANS_KEEP) sc.plans.delete(sc.plans.keys().next().value!);
      return { frame_url: `${origin}/s/${sc.cap}/frame`, plan_url: `${origin}/m/${sc.cap}/plan/${id}.json` };
    },
    rotate() {
      if (scopes === null) return;
      for (const name of [...scopes.keys()]) scopes.set(name, newScope());
    },
    release(scope) {
      scopes?.delete(scope);
    },
    get scopes() {
      return scopes?.size ?? 0;
    },
    get requests() {
      return requests;
    },
    close: () =>
      (closed ??= new Promise<void>((done) => {
        scopes = null;
        server.close(() => done());
        server.closeAllConnections();
      })),
  };
}
