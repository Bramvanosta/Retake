/**
 * The network guard of a render's Chromium (L3.2, BACKLOG guard-rail): what a render through MCP loads is the files
 * of its plan, nothing else. Component code runs in Remotion's Chromium, and Remotion opens it with Private Network
 * Access checks off: without a guard, a component could reach other hosts and the user's own local services.
 *
 * - Browser side: CDP `Fetch.enable` on the browser connection (every target, no per-page attach) pauses each
 *   request; the asset server's URLs (random port + token) and Remotion's bundle server (a port picked here) go on,
 *   anything else fails (`BlockedByClient`) and its origin becomes a render warning. Remotion's `/proxy?src=` (the
 *   bundle server downloads `src` in Node for OffthreadVideo) passes only when `src` is an asset-server URL.
 * - Node side: `onDownload` of renderMedia / renderStill sees the `<Audio>` / `<Video>` sources Remotion downloads
 *   itself (they never pass through Chromium): a source that is not an asset-server or bundle-server URL throws
 *   before the download starts (the render fails).
 * - WebSocket requests are not paused by CDP Fetch: the bundle's index.html carries a CSP meta whose connect-src
 *   allows no `ws:` / `wss:` (bundle.ts). WebRTC and DNS prefetch stay uncovered (BACKLOG, full isolation).
 *
 * Used by renders of the jobs worker (trust `mcp`); a `studio render` of a human keeps its full network (remote images
 * in slots are a CLI feature).
 */
import { createServer } from 'node:net';

/** What a guarded render may load. */
export interface NetworkAllowList {
  /** The asset server's `<origin>/<token>/` (AssetServer.prefix). */
  assetPrefix: string;
  /** The port of Remotion's bundle server (`http://localhost:<port>`), passed to Remotion as `port`. */
  bundlePort: number;
}

/** The origin of a URL ("http://127.0.0.1:4410"), or its scheme for one without ("data:"). */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin !== 'null' ? u.origin : `${u.protocol}`;
  } catch {
    return url.slice(0, 60);
  }
}

/** Whether a request of the render's Chromium may go on. */
export function allowedRequest(url: string, allow: NetworkAllowList): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  if (url.startsWith(allow.assetPrefix)) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' || u.hostname !== 'localhost' || u.port !== String(allow.bundlePort) || u.username || u.password) return false;
  // Remotion's /proxy downloads `src` in Node: only the asset server's files.
  if (u.pathname.startsWith('/proxy')) return (u.searchParams.get('src') ?? '').startsWith(allow.assetPrefix);
  return true;
}

/** Whether Remotion may download a media source itself (Node side): the asset server's files and the bundle's own. */
export function allowedDownload(src: string, allow: NetworkAllowList): boolean {
  if (src.startsWith('data:')) return true;
  return allowedRequest(src, allow) && !/^http:\/\/localhost:\d+\/proxy/.test(src);
}

/** A free local port for Remotion's bundle server (free on 127.0.0.1 and, when the machine has it, ::1). */
export async function pickFreePort(): Promise<number> {
  const listen = (port: number, host: string) =>
    new Promise<number | null>((ok) => {
      const srv = createServer();
      srv.once('error', (e: NodeJS.ErrnoException) => ok(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT' ? port : null));
      srv.listen({ port, host, exclusive: true }, () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => ok(p));
      });
    });
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await listen(0, '127.0.0.1');
    if (port && (await listen(port, '::1')) === port) return port;
  }
  throw new Error('no free local port for the render bundle server');
}

/** The part of Remotion's HeadlessBrowser the guard uses: its CDP connection to the browser. */
interface CdpConnection {
  send(method: string, params?: unknown): Promise<unknown>;
  on(event: string, handler: (e: unknown) => void): unknown;
  off(event: string, handler: (e: unknown) => void): unknown;
}

export interface NetworkGuard {
  readonly allow: NetworkAllowList;
  /** Origins it blocked, first seen first, with how many requests each. */
  readonly blocked: ReadonlyMap<string, number>;
  /** renderMedia / renderStill `onDownload`: throws for a source outside the allow-list. */
  onDownload(src: string): undefined;
  /** "the render blocked 3 requests to http://…": one warning per origin (origins only, never paths). */
  warnings(): string[];
  dispose(): Promise<void>;
}

/**
 * Arm the guard on a browser Remotion opened (`openBrowser`): from now on, every request of every page of it is
 * paused and checked. Throws when the browser does not accept it (the render must not run unguarded).
 */
export async function armNetworkGuard(browser: { connection: unknown }, allow: NetworkAllowList): Promise<NetworkGuard> {
  const conn = browser.connection as CdpConnection;
  const blocked = new Map<string, number>();
  const block = (url: string) => {
    const o = originOf(url);
    blocked.set(o, (blocked.get(o) ?? 0) + 1);
  };
  const onPaused = (e: unknown) => {
    const ev = e as { requestId: string; request: { url: string } };
    if (allowedRequest(ev.request.url, allow)) {
      conn.send('Fetch.continueRequest', { requestId: ev.requestId }).catch(() => undefined);
    } else {
      block(ev.request.url);
      conn.send('Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
    }
  };
  conn.on('Fetch.requestPaused', onPaused);
  try {
    await conn.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  } catch (e) {
    conn.off('Fetch.requestPaused', onPaused);
    throw new Error(`the render browser refused the network guard: ${(e as Error).message}`);
  }
  return {
    allow,
    blocked,
    onDownload(src: string): undefined {
      if (allowedDownload(src, allow)) return undefined;
      block(src);
      throw new Error(`blocked download of ${originOf(src)}: a render through MCP loads only the files of its plan`);
    },
    warnings: () =>
      [...blocked].map(
        ([origin, n]) => `the render blocked ${n === 1 ? 'a request' : `${n} requests`} to ${origin}: a render through MCP loads only the files of its plan (put remote files in the project's assets/)`,
      ),
    dispose: async () => {
      conn.off('Fetch.requestPaused', onPaused);
      await conn.send('Fetch.disable').catch(() => undefined);
    },
  };
}

/** The render browser's process (to kill it after its parent was killed: Remotion starts it detached). */
export interface BrowserProcessInfo {
  pid: number;
  /** --user-data-dir of the browser (a temporary profile folder Remotion creates). */
  user_data_dir?: string;
}

/** The browser process of a HeadlessBrowser, through CDP; undefined when the browser does not say. */
export async function browserProcessInfo(browser: { connection: unknown }): Promise<BrowserProcessInfo | undefined> {
  const conn = browser.connection as CdpConnection;
  const unwrap = (r: unknown) => ((r as { value?: unknown })?.value ?? r) as Record<string, unknown>;
  try {
    const info = unwrap(await conn.send('SystemInfo.getProcessInfo'));
    const proc = (info.processInfo as Array<{ type: string; id: number }> | undefined)?.find((p) => p.type === 'browser');
    if (!proc || !Number.isInteger(proc.id) || proc.id <= 0) return undefined;
    let dir: string | undefined;
    try {
      const cl = unwrap(await conn.send('Browser.getBrowserCommandLine'));
      const arg = (cl.arguments as string[] | undefined)?.find((a) => a.startsWith('--user-data-dir='));
      dir = arg?.slice('--user-data-dir='.length).replace(/^"|"$/g, '');
    } catch {
      /* the pid alone */
    }
    return { pid: proc.id, ...(dir ? { user_data_dir: dir } : {}) };
  } catch {
    return undefined;
  }
}
