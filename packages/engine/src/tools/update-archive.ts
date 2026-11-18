/**
 * The Tools an update brings, read from its archive before the restart (DESIGN §4p (d)): the desktop shell kept the
 * update's archive it verified (`<cache>/updates/update-<pid>.tar.gz`, 0600) and told its server the path and the
 * SHA-256 of the bytes it verified. Here:
 *
 * - the file: a plain file (no link) of this account's, the shell's archive name in an `updates` folder, at most
 *   ARCHIVE_MAX bytes, and its SHA-256 computed again must be the one the shell gave (nothing changed it since);
 * - the new version's bundle.json read from it with /usr/bin/tar (a fixed program and member, no shell, PATH
 *   /usr/bin:/bin, a bounded output, a time limit), then checked: a version 2 manifest of the version announced, its
 *   `tools` against the manifest's rules and the hosts' allow-list (core parseToolEntries).
 *
 * What comes back is only a list of entries; the install is the same installer as a person's download (tools-work.ts
 * installUpdateTools). A new version's manifest this version cannot read whole — no bundle.json at that member, another
 * manifest version, a Tool id it does not know or one it lacks, a field past its rules — is no reason to refuse the
 * update (this version's code must never decide which later releases install): it answers `skip`, the update goes on,
 * and the new version downloads its Tools at its first start. Only an archive that is not the one the shell verified
 * is refused.
 */
import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parseToolEntries } from '@retake/core/io';
import type { ToolEntry } from '@retake/core/io';
import { fileSha256 } from './install.js';

/** The shell's archive, as the shell's update_flow archive_path names it. */
export const ARCHIVE_NAME_RE = /^update-\d{1,10}\.tar\.gz$/;
/** The largest archive taken (the shell's download cap). */
export const ARCHIVE_MAX = 1_500_000_000;
/** The new version's manifest inside the archive (the stage's archive: `<product>.app` at its top). */
export const BUNDLE_JSON_MEMBER = 'Retake.app/Contents/Resources/bundle.json';
/** The longest bundle.json read (bytes), and tar's time limit. */
export const BUNDLE_JSON_MAX = 512 * 1024;
export const TAR_MS = 5 * 60 * 1000;

/** What the shell said of the archive. */
export interface UpdateArchive {
  version: string;
  path: string;
  sha256: string;
}

/** Why the file the shell named may not be read (null: it may), its digest checked last. */
export async function archiveProblem(a: UpdateArchive, uid: number): Promise<string | null> {
  if (!ARCHIVE_NAME_RE.test(basename(a.path)) || basename(dirname(a.path)) !== 'updates') return 'not the update archive the app keeps';
  let st: import('node:fs').Stats;
  try {
    st = lstatSync(a.path);
  } catch {
    return 'the update archive is gone';
  }
  if (!st.isFile()) return 'the update archive is not a plain file';
  if (st.uid !== uid) return 'the update archive is not this account’s';
  if (st.size > ARCHIVE_MAX) return 'the update archive is larger than an update can be';
  if ((await fileSha256(a.path)) !== a.sha256) return 'the update archive changed since it was verified';
  return null;
}

/** The new version's bundle.json, read from the archive with /usr/bin/tar. */
export function readArchiveManifest(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/tar', ['-xzOf', path, BUNDLE_JSON_MEMBER], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, maxBuffer: BUNDLE_JSON_MAX, timeout: TAR_MS, encoding: 'utf8' }, (err, out) =>
      err ? reject(new Error(`its bundle.json could not be read (${err.message.split('\n')[0]})`)) : resolve(String(out)),
    );
  });
}

/** The archive's bundle.json names another version than the one announced: not the update the shell verified (refused). */
export class UpdateVersionMismatch extends Error {
  override name = 'UpdateVersionMismatch';
}

/**
 * The Tools a new version's bundle.json names, checked (throws with why). A bundle.json whose `app` is another version
 * than the one announced throws UpdateVersionMismatch (the update is refused); anything else it throws is a manifest
 * this version cannot read whole (the pre-download is skipped: readUpdateArchive).
 */
export function updateEntries(text: string, version: string): ToolEntry[] {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    throw new Error('its bundle.json is not JSON');
  }
  const app = m && typeof m === 'object' ? (m as { app?: unknown }).app : undefined;
  if (typeof app === 'string' && app !== version) throw new UpdateVersionMismatch(`its bundle.json is version ${app.slice(0, 64)}, not ${version}`);
  if (!m || typeof m !== 'object' || (m as { v?: unknown }).v !== 2) throw new Error('its bundle.json is not a version 2 bundle manifest');
  if (app !== version) throw new Error(`its bundle.json names no version (${version} announced)`);
  return parseToolEntries((m as { tools?: unknown }).tools, "the update's bundle.json");
}

/** What the update's archive says of its Tools: the entries to download first, or why they are left to its first start. */
export type UpdateArchiveTools = { entries: ToolEntry[] } | { skip: string };

/**
 * The update's Tools from its archive: the file checked (throws with why: not the archive the shell verified), then
 * its bundle.json read and checked — `skip` with why when this version cannot read it (see the module comment).
 */
export async function readUpdateArchive(a: UpdateArchive, uid: number = process.getuid?.() ?? -1): Promise<UpdateArchiveTools> {
  const problem = await archiveProblem(a, uid);
  if (problem) throw new Error(problem);
  try {
    return { entries: updateEntries(await readArchiveManifest(a.path), a.version) };
  } catch (e) {
    if (e instanceof UpdateVersionMismatch) throw e;
    return { skip: e instanceof Error ? e.message : String(e) };
  }
}
