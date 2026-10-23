/**
 * The listener of the engine's local HTTP servers (L4.1): 127.0.0.1 only — never every interface, never IPv6 — on a
 * free port (0) or a fixed one; refused when the bound address is anything but 127.0.0.1. No option names another host.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { EngineError } from '../errors.js';
import type { EngineErrorCode } from '../errors.js';

export const LOOPBACK = '127.0.0.1';

/** An address bound to 127.0.0.1. */
export function isLoopbackAddress(a: string | AddressInfo | null): a is AddressInfo {
  return a !== null && typeof a === 'object' && a.address === LOOPBACK;
}

/** Listen on 127.0.0.1:`port` (0: a free port) and return the port; `busy` when the port is taken. */
export async function listenLoopback(server: Server, port = 0): Promise<number> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new EngineError('invalid', `port must be a whole number from 0 to 65535, got ${port}`);
  await new Promise<void>((ok, fail) => {
    const onError = (e: NodeJS.ErrnoException) => {
      const code: EngineErrorCode = e.code === 'EADDRINUSE' ? 'busy' : e.code === 'EACCES' ? 'refused' : 'internal';
      fail(new EngineError(code, `cannot listen on ${LOOPBACK}:${port}: ${e.code ?? e.message}`, code === 'busy' ? { fix: 'pass another --port, or leave it out for a free one' } : {}));
    };
    server.once('error', onError);
    server.listen({ port, host: LOOPBACK, exclusive: true }, () => {
      server.off('error', onError);
      ok();
    });
  });
  const address = server.address();
  if (!isLoopbackAddress(address)) {
    server.close();
    throw new EngineError('internal', `the server is bound to ${JSON.stringify(address)}, not ${LOOPBACK}: closed`);
  }
  return address.port;
}
