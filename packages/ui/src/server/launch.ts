/**
 * One Studio server per workspace (L4.1, critique B8): `launchStudio` reuses the server the discovery file names when
 * its holder is alive (a new bootstrap code minted through it with the file's token), else starts one, binds it, and
 * only then claims `.demo-studio/ui.json` exclusively — the loser of a simultaneous start closes its own listener and
 * reuses the winner. Closing the server removes the file when it is still its own.
 */
import { EngineError, claimDiscovery, discoveryFile, holderAlive, readDiscovery, releaseDiscovery, selfIdentity } from '@demo-studio/engine';
import type { DiscoveryRecord } from '@demo-studio/engine';
import { startStudioServer } from './studio.js';
import type { StudioServer, StudioServerOptions } from './studio.js';

export type Launched =
  | { reused: false; server: StudioServer; url: string; port: number; pid: number; file: string }
  | { reused: true; url: string; port: number; pid: number; file: string };

/** A new bootstrap URL from the running server `r` names (its token proves who asks). */
async function codeFrom(r: DiscoveryRecord, file: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${r.port}/v1/bootstrap`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    res = new Response(null, { status: 599 });
  }
  const body = res.ok ? ((await res.json().catch(() => ({}))) as { url?: unknown }) : {};
  if (typeof body.url !== 'string' || !body.url.startsWith(r.url)) {
    throw new EngineError('unavailable', `a Studio server (pid ${r.pid}) holds ${file} but does not answer on port ${r.port}`, { fix: `stop that process (kill ${r.pid}), then run studio ui again` });
  }
  return body.url;
}

export async function launchStudio(o: StudioServerOptions): Promise<Launched> {
  const file = discoveryFile(o.root);
  const existing = await readDiscovery(file);
  if (existing && (await holderAlive(existing))) {
    return { reused: true, url: await codeFrom(existing, file), port: existing.port, pid: existing.pid, file };
  }
  const server = await startStudioServer(o);
  const me = await selfIdentity();
  const record: DiscoveryRecord = {
    version: 1,
    kind: 'ui',
    pid: me.pid,
    ...(me.started_at ? { started_at: me.started_at } : {}),
    port: server.port,
    url: server.url,
    token: server.token,
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
    return { reused: true, url: await codeFrom(claim.holder, file), port: claim.holder.port, pid: claim.holder.pid, file };
  }
  const close = server.close;
  let released: Promise<void> | undefined;
  server.close = () => (released ??= close().then(() => releaseDiscovery(file, record)));
  return { reused: false, server, url: server.launchUrl(), port: server.port, pid: me.pid, file };
}
