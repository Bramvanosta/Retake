/**
 * From a checked archive (or a copied folder) to an installed Tool: the listing checked (archive.ts), the
 * archive extracted by a fixed system program into a fresh `.tmp-<rand>` folder of the Tools folder (`/usr/bin/ditto`
 * for a zip: it keeps the links and modes; `/usr/bin/tar` for a tgz, without the archive's owners), the tree checked
 * (archive.ts treeProblem), the manifest's `prune` paths removed, the tree digest compared with the manifest's, the
 * markers and the `.verified` stamp written — and only then the folder renamed into place, on the same file system
 * (atomic: a crash before leaves the old state; `.tmp-*` and `.trash-*` are swept by the next install). An existing
 * folder is moved aside first (an install only replaces a Tool that is not ready). The installed tree is made
 * read-only (files 0444 / 0555, folders 0555).
 *
 * No variable of the person's environment reaches the programs (PATH /usr/bin:/bin only); a program that fails
 * removes its temporary folder.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { VERIFIED_FILE, toolFolder, treeDigest, treeSummary } from '@retake/core/io';
import type { ToolEntry, ToolStamp } from '@retake/core/io';
import { stampOf } from '../clock.js';
import type { Clock } from '../clock.js';
import { ArchiveRefused, checkListing, tgzListing, treeProblem, zipListing } from './archive.js';

/** The programs an install runs, by absolute path. */
export const DITTO = '/usr/bin/ditto';
export const TAR = '/usr/bin/tar';
const CHILD_ENV = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };

/** The tree an install left does not hold what this version records (its digest differs): the folder is discarded. */
export class TreeMismatch extends Error {
  constructor(
    message: string,
    readonly expected: string,
    readonly got: string,
  ) {
    super(message);
    this.name = 'TreeMismatch';
  }
}

function runProgram(file: string, args: readonly string[]): Promise<void> {
  return new Promise((ok, fail) => {
    execFile(file, [...args], { env: CHILD_ENV, maxBuffer: 4 * 1024 * 1024 }, (e, _out, err) =>
      e
        ? fail(
            new Error(
              `${file.split('/').pop()} failed: ${
                String(err || e.message)
                  .trim()
                  .split('\n')[0]
              }`,
            ),
          )
        : ok(),
    );
  });
}

/** A fresh temporary folder of the Tools folder (`.tmp-<rand>`, 0700): on its file system, swept by the next install. */
export function freshTmp(tools: string): string {
  const dir = join(tools, `.tmp-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** Make a tree writable by its owner again (an installed Tool is read-only), so it can be removed. */
export function makeWritable(dir: string): void {
  if (!existsSync(dir)) return;
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(dir, 0o700);
    for (const e of readdirSync(dir)) makeWritable(join(dir, e));
  } else chmodSync(dir, st.mode | 0o200);
}

/** Remove a folder of the Tools folder, read-only or not. */
export function removeTree(dir: string): void {
  try {
    makeWritable(dir);
  } catch {
    /* removed below as far as it can be */
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Make an installed tree read-only: files 0444 (0555 when executable), folders 0555; links as they are. */
export function makeReadOnly(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const e of readdirSync(dir)) makeReadOnly(join(dir, e));
    chmodSync(dir, 0o555);
  } else chmodSync(dir, st.mode & 0o111 ? 0o555 : 0o444);
}

/** Extract a checked archive into `into` (which must not exist): the listing first, then the system's program. */
export async function extractArchive(entry: ToolEntry, archive: string, into: string): Promise<void> {
  const listing = entry.archive === 'zip' ? zipListing(archive) : await tgzListing(archive);
  checkListing(listing, entry.root ? { root: entry.root } : {});
  if (entry.archive === 'zip') {
    mkdirSync(into, { mode: 0o700 });
    await runProgram(DITTO, ['-x', '-k', '--noqtn', archive, into]);
    return;
  }
  const raw = `${into}.raw`;
  mkdirSync(raw, { mode: 0o700 });
  try {
    await runProgram(TAR, ['-xzf', archive, '--no-same-owner', '-C', raw]);
    const top = entry.root ? join(raw, entry.root) : raw;
    if (!lstatSync(top).isDirectory()) throw new ArchiveRefused(`the archive has no ${entry.root}/ folder`);
    renameSync(top, into);
  } finally {
    rmSync(raw, { recursive: true, force: true });
  }
}

/** Remove the manifest's `prune` paths of a tree (each inside it, never through a link). */
function prune(entry: ToolEntry, dir: string): void {
  const real = realpathSync(dir);
  for (const rel of entry.prune ?? []) {
    const p = join(dir, ...rel.split('/'));
    if (!existsSync(dirname(p))) continue;
    const parent = realpathSync(dirname(p));
    const r = relative(real, parent);
    if (r.startsWith(`..${sep}`) || r === '..' || resolve(real, r) !== parent) throw new ArchiveRefused(`${rel}: its folder lies outside the tree`);
    rmSync(p, { force: true });
  }
}

/**
 * Check a tree as the installer leaves it, in `dir` (extracted or copied): the tree rules, the pruned paths, its
 * digest against the manifest's (TreeMismatch otherwise), then its markers and stamp. Returns the stamp.
 */
export async function verifyTree(entry: ToolEntry, dir: string, clock: Pick<Clock, 'now'>): Promise<ToolStamp> {
  const bad = treeProblem(dir);
  if (bad) throw new ArchiveRefused(`the extracted ${entry.label.toLowerCase()} is refused: ${bad}`);
  prune(entry, dir);
  const markers = entry.markers ?? [];
  for (const m of markers) rmSync(join(dir, m), { force: true });
  rmSync(join(dir, VERIFIED_FILE), { force: true });
  const got = await treeDigest(dir, markers);
  if (got !== entry.tree) {
    throw new TreeMismatch(`the extracted ${entry.label.toLowerCase()} is not the one this version records (tree digest ${got}, recorded ${entry.tree})`, entry.tree, got);
  }
  for (const m of markers) writeFileSync(join(dir, m), '');
  const sum = treeSummary(dir, markers);
  const stamp: ToolStamp = { v: 1, tree: got, entries: sum.entries, bytes: sum.bytes, at: stampOf(clock) };
  writeFileSync(join(dir, VERIFIED_FILE), `${JSON.stringify(stamp)}\n`);
  return stamp;
}

/**
 * Put a checked tree (`built`, in a `.tmp-*` of the Tools folder) in place as `entry`'s folder: renamed (atomic), then
 * made read-only. A folder already there is always moved aside first (`.trash-<rand>`) and removed after: an install
 * only reaches here for a Tool that is not ready (installTools' toDo), and what made it not ready — a marker or its
 * stamp gone, a stamp that says damaged, a folder others may write, a file changed — is not all in its tree digest, so
 * keeping an old folder whose digest is right would leave it damaged for good.
 */
export function placeTree(entry: ToolEntry, tools: string, built: string): void {
  const target = toolFolder(entry, tools);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let there = false;
  try {
    lstatSync(target);
    there = true;
  } catch {
    there = false;
  }
  if (there) {
    const trash = join(tools, `.trash-${randomBytes(6).toString('hex')}`);
    makeWritable(target);
    renameSync(target, trash);
    removeTree(trash);
  }
  renameSync(built, target);
  makeReadOnly(target);
}

/** Sweep what a crashed install left: `.tmp-*` and `.trash-*` folders of the Tools folder (under its lock only). */
export function sweepLeftovers(tools: string): string[] {
  if (!existsSync(tools)) return [];
  const gone: string[] = [];
  for (const name of readdirSync(tools)) {
    if (!/^\.(?:tmp|trash)-[0-9a-f]+(?:\.raw)?$/.test(name)) continue;
    removeTree(join(tools, name));
    gone.push(name);
  }
  return gone;
}
