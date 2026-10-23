/**
 * The stable token of MCP over HTTP (L4.1, R-MCP-02): `<studio home>/mcp-http.token`, so Claude Code registers the
 * server once (`studio mcp --print-config --http`) and the registration survives restarts — unlike the Studio's
 * per-launch token. One per studio home (a person), whatever the workspace or port.
 *
 * - Created atomically: a 0600 temporary file (chmod: the umask never widens it) hard-linked into place, so two
 *   starts never write two tokens; the loser reads the winner's.
 * - Renewed with `--rotate-token`: a new 0600 file renamed over the old one (every registration with the old token
 *   stops working; a running server keeps the token it started with until it restarts).
 * - Trusted only as a regular file of this user with no group or other permission bits, holding one token; anything
 *   else (a link, 0644, another owner, garbage) is refused, never followed or repaired silently.
 *
 * Whoever holds it reaches the 44 MCP tools of the workspace a server serves and answers its approval forms (as any
 * MCP client of `studio mcp` over stdio does): it is a secret of the person, like their shell.
 */
import { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { studioHome } from '@demo-studio/core';
import { EngineError } from '../errors.js';
import { newSecret } from './token.js';

export const MCP_HTTP_TOKEN_FILE = 'mcp-http.token';

/** `<studio home>/mcp-http.token`. */
export function mcpHttpTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(studioHome(env), MCP_HTTP_TOKEN_FILE);
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32,512}$/;

/** The token in `file`; null when there is none. Refused (`refused`) when the file is not private to this user. */
export async function readPrivateToken(file: string): Promise<string | null> {
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const uid = process.getuid?.();
  const unsafe = !st.isFile() ? 'is not a regular file' : uid !== undefined && st.uid !== uid ? 'belongs to another user' : (st.mode & 0o077) !== 0 ? `has permissions ${(st.mode & 0o777).toString(8)} (expected 600)` : undefined;
  if (unsafe) throw new EngineError('refused', `${file} ${unsafe}: not trusted`, { fix: `remove ${file}, then run studio mcp --http again (it writes a new token: register the server again)` });
  const token = (await readFile(file, 'utf8')).trim();
  if (!TOKEN_RE.test(token)) throw new EngineError('refused', `${file} holds no valid token`, { fix: `run studio mcp --http --rotate-token (then register the server again)` });
  return token;
}

async function privateTemp(file: string, token: string): Promise<string> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(tmp, 0o600);
  return tmp;
}

/**
 * The stable token: the one in `file`, else a new one created atomically; `rotate` replaces it with a new one.
 * `created` / `rotated` say what happened (the caller tells the person to register again).
 */
export async function stableToken(file: string, o: { rotate?: boolean } = {}): Promise<{ token: string; created: boolean; rotated: boolean }> {
  if (o.rotate) {
    const token = newSecret();
    const tmp = await privateTemp(file, token);
    try {
      // Only a regular private file (or none) is replaced: a link or another user's file stays refused.
      await readPrivateToken(file).catch((e: unknown) => {
        if (!(e instanceof EngineError) || !/holds no valid token/.test(e.message)) throw e;
      });
      await rename(tmp, file);
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
    return { token, created: false, rotated: true };
  }
  const existing = await readPrivateToken(file);
  if (existing) return { token: existing, created: false, rotated: false };
  const token = newSecret();
  const tmp = await privateTemp(file, token);
  try {
    await link(tmp, file);
    return { token, created: true, rotated: false };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // Another start won the race: its token is the token.
    const theirs = await readPrivateToken(file);
    if (!theirs) throw new EngineError('busy', `${file} appeared and vanished while it was being created`, { fix: 'run the command again' });
    return { token: theirs, created: false, rotated: false };
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
