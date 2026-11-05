/**
 * One Studio server per workspace (L4.1, critique B8): `launchStudio` reuses the running server when the Retake home
 * holds its token record (`<Retake home>/ui/<hash>.token`, engine discovery.ts) and its holder is alive — a new
 * bootstrap code minted through it, sent to the port of that record with its token, never to a port the workspace
 * names. Else it starts one, binds it, and only then claims `.retake/ui.json` (pid, port, URL: no secret) exclusively
 * — the loser of a simultaneous start closes its own listener and reuses the winner — and writes the token record.
 * Closing the server removes both files when they are still its own.
 * A workspace whose ui.json names a live server with no token record in this home (a server of another RETAKE_HOME, or
 * of an older Retake whose record held the token) is told, and nothing is opened.
 * L5.2: each answer names the player origin (`player`) — the desktop shell allows navigations to it; undefined when an
 * older running server's bootstrap answer has none.
 */
import {
  DISCOVERY_VERSION,
  EngineError,
  claimDiscovery,
  discoveryFile,
  holderAlive,
  readDiscovery,
  readStudioToken,
  releaseDiscovery,
  releaseStudioToken,
  selfIdentity,
  studioTokenDir,
  studioTokenFile,
  tokenHolderAlive,
  writeStudioToken,
} from '@retake/engine';
import type { DiscoveryRecord, StudioTokenRecord } from '@retake/engine';
import { startStudioServer } from './studio.js';
import type { StudioServer, StudioServerOptions } from './studio.js';

export type Launched =
  | { reused: false; server: StudioServer; url: string; port: number; pid: number; file: string; player: string }
  | { reused: true; url: string; port: number; pid: number; file: string; player: string | undefined };

/** How long a start waits for the token record of a server that just claimed ui.json (it writes it right after). */
const TOKEN_WAIT_MS = 2000;

/** A new bootstrap URL (and the player origin) from the running server `r` names (its token proves who asks). */
async function codeFrom(r: StudioTokenRecord, file: string): Promise<{ url: string; player: string | undefined }> {
  const base = `http://127.0.0.1:${r.port}/`;
  let res: Response;
  try {
    res = await fetch(`${base}v1/bootstrap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    res = new Response(null, { status: 599 });
  }
  const body = res.ok ? ((await res.json().catch(() => ({}))) as { url?: unknown; player?: unknown }) : {};
  if (typeof body.url !== 'string' || !body.url.startsWith(base)) {
    throw new EngineError('unavailable', `a Studio server (pid ${r.pid}) holds ${file} but does not answer on port ${r.port}`, { fix: `stop that process (kill ${r.pid}), then run retake ui again` });
  }
  const player = typeof body.player === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(body.player) ? body.player : undefined;
  return { url: body.url, player };
}

/** The live server of this home's token record for `root`, or null. */
async function ownRunning(root: string, tokenFile: string): Promise<StudioTokenRecord | null> {
  const mine = await readStudioToken(tokenFile, root);
  return mine && (await tokenHolderAlive(mine)) ? mine : null;
}

/**
 * The running server to reuse: the one of this home's token record when alive; null when nothing serves the workspace.
 * A live holder of ui.json without a token record here (after a short wait: a server that just claimed it writes its
 * record right after) is refused with what to do — its port is never sent anything.
 */
async function running(root: string, file: string, tokenFile: string, holder?: DiscoveryRecord): Promise<Extract<Launched, { reused: true }> | null> {
  const reuse = async (r: StudioTokenRecord) => ({ reused: true as const, ...(await codeFrom(r, file)), port: r.port, pid: r.pid, file });
  const mine = await ownRunning(root, tokenFile);
  if (mine) return reuse(mine);
  const existing = holder ?? (await readDiscovery(file));
  if (!existing || !(await holderAlive(existing))) return null;
  const stop = `stop it (Ctrl-C in its terminal, quit the app, or kill ${existing.pid}), then run retake ui again`;
  if (existing.version !== DISCOVERY_VERSION) {
    throw new EngineError('busy', `a Studio server of an older Retake (pid ${existing.pid}) serves this workspace (${file}, version ${existing.version})`, { fix: stop });
  }
  for (const end = Date.now() + TOKEN_WAIT_MS; Date.now() < end; ) {
    await new Promise((r) => setTimeout(r, 50));
    const late = await ownRunning(root, tokenFile);
    if (late) return reuse(late);
    if (!(await holderAlive(existing))) return null;
  }
  throw new EngineError('busy', `a Studio server (pid ${existing.pid}) serves this workspace, but its token is not in this Retake home (${studioTokenDir()})`, {
    fix: `run retake ui with the RETAKE_HOME that server was started with, or ${stop}`,
  });
}

export async function launchStudio(o: StudioServerOptions): Promise<Launched> {
  const file = discoveryFile(o.root);
  const tokenFile = await studioTokenFile(o.root);
  const found = await running(o.root, file, tokenFile);
  if (found) return found;
  const server = await startStudioServer(o);
  const me = await selfIdentity();
  const record: DiscoveryRecord = {
    version: DISCOVERY_VERSION,
    kind: 'ui',
    pid: me.pid,
    ...(me.started_at ? { started_at: me.started_at } : {}),
    port: server.port,
    url: server.url,
    since: new Date().toISOString(),
  };
  let claim;
  try {
    claim = await claimDiscovery(file, record);
  } catch (e) {
    await server.close();
    throw e;
  }
  if (!claim.claimed) {
    await server.close();
    const other = await running(o.root, file, tokenFile, claim.holder);
    if (other) return other;
    throw new EngineError('busy', `${file}: another Studio server claimed it at the same time`, { fix: 'run retake ui again' });
  }
  let token: StudioTokenRecord;
  try {
    token = await writeStudioToken(tokenFile, o.root, record, server.token);
  } catch (e) {
    await server.close();
    await releaseDiscovery(file, record);
    throw e;
  }
  const close = server.close;
  let released: Promise<void> | undefined;
  server.close = () => (released ??= close().then(() => releaseStudioToken(tokenFile, token)).then(() => releaseDiscovery(file, record)));
  return { reused: false, server, url: server.launchUrl(), port: server.port, pid: me.pid, file, player: server.player.origin };
}
