/**
 * The lines the desktop shell writes on the supervised server's stdin (the update's state), parsed
 * strictly: the Set-up sheet's answers (the folder the person picked, the notification permission) and the update's
 * state (update-ops.ts parseUpdateLine). The lines the server writes to the shell are desktop.ts DesktopPipe's.
 */
import { VERSION_RE, parseUpdateLine } from './update-ops.js';
import type { UpdateLine } from './update-ops.js';
import type { UpdateArchiveLine } from './update-tools.js';

/** The longest line the shell writes on the server's stdin (bytes). */
export const SHELL_LINE_MAX = 8192;

/** A line the desktop shell wrote on the supervised server's stdin (the update's state). */
export type ShellLine =
  | { type: 'cli_folder'; path: string }
  | { type: 'cli_folder_open' }
  | { type: 'cli_refresh' }
  | { type: 'cli_folder_cancelled' }
  | { type: 'notifications'; state: 'on' | 'off' | 'unknown' }
  | UpdateArchiveLine
  | UpdateLine;

/**
 * One line of the shell on stdin, or null for anything but its exact shapes: `{"type":"cli_folder_open"}` (its native
 * folder panel is up — the sheet says "choose in the panel" only then), `{"type":"cli_folder","path":
 * <absolute>}` (the folder the person picked there), `{"type":"cli_folder_cancelled"}` (none: cancelled, or the panel
 * could not open while another question was up), `{"type":"notifications","state":"on"|"off"|"unknown"}`. Strict: no
 * other field, a path absolute, one line, no NUL, at most 4096 characters; the line at most SHELL_LINE_MAX bytes (UTF-8).
 * `{"type":"cli_refresh"}` — the shell's window became key: read the command's link again (its Help items follow it).
 * `{"type":"update","state":…}` — the update's state (update-ops.ts parseUpdateLine: fixed keys per state).
 * `{"type":"update_archive","version","path","sha256"}` — the update downloaded and verified, kept at `path` (absolute,
 * the shell's `updates/update-<pid>.tar.gz`), the SHA-256 of its bytes: its Tools are wanted (update-tools.ts).
 */
export function parseShellLine(line: string): ShellLine | null {
  if (Buffer.byteLength(line, 'utf8') > SHELL_LINE_MAX) return null;
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (o.type === 'cli_folder' && keys === 'path,type' && typeof o.path === 'string' && o.path.startsWith('/') && o.path.length <= 4096 && !/[\0\n\r]/.test(o.path))
    return { type: 'cli_folder', path: o.path };
  if (o.type === 'cli_folder_open' && keys === 'type') return { type: 'cli_folder_open' };
  if (o.type === 'cli_folder_cancelled' && keys === 'type') return { type: 'cli_folder_cancelled' };
  if (o.type === 'cli_refresh' && keys === 'type') return { type: 'cli_refresh' };
  if (o.type === 'notifications' && keys === 'state,type' && (o.state === 'on' || o.state === 'off' || o.state === 'unknown')) return { type: 'notifications', state: o.state };
  if (o.type === 'update') return parseUpdateLine(o);
  if (o.type === 'update_archive' && keys === 'path,sha256,type,version') return updateArchive(o);
  return null;
}

/** The update_archive line's fields, each of its shape. */
function updateArchive(o: Record<string, unknown>): UpdateArchiveLine | null {
  const { version, path, sha256 } = o;
  if (typeof version !== 'string' || version.length > 64 || !VERSION_RE.test(version)) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || /[\0-\x1f\x7f]/.test(path) || path.split('/').includes('..') || !/\/updates\/update-\d{1,10}\.tar\.gz$/.test(path)) return null;
  return { type: 'update_archive', version, path, sha256 };
}
