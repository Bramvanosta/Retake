/**
 * The product's adapter of the Outputs port (outputs.ts): the generated folders on node:fs. Named only here and in ports.ts
 * `enginePorts` (the import-rules ratchet's `output-read` check).
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants, realpath as realpathCb } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NODE_RECORD_FS, readPlainFile } from '@retake/core/io';
import type { Outputs } from './outputs.js';
import { oneName } from './outputs.js';
import { outputsOn } from './output-files.js';
import type { OutputFs } from './output-files.js';

/**
 * The sha256 of a file's bytes, opened without following a link (O_NOFOLLOW: a link swapped in fails with ELOOP); a
 * file that has another name once opened (a hard link, outputs.ts `oneName`) fails with EMLINK.
 */
async function hashFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!oneName(await handle.stat())) throw Object.assign(new Error(`EMLINK: another name of '${path}'`), { code: 'EMLINK', path });
    const h = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) h.update(chunk as Buffer);
    return h.digest('hex');
  } finally {
    await handle.close();
  }
}

/** A whole file through a temporary one and a rename (a reader never sees half of it), its folder made. */
async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** A new file, never over anything there (open 'wx': EEXIST), its folder made. */
async function createExclusive(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const fh = await open(path, 'wx');
  try {
    await fh.writeFile(text);
  } finally {
    await fh.close();
  }
}

/** The file layer of the disk (exported for the tests of what only the disk has: a file swapped between two reads). */
export const nodeOutputFs: OutputFs = {
  lstat,
  stat,
  readFile: (path) => readFile(path, 'utf8'),
  readBytes: (path) => readFile(path),
  readdir: (path) => readdir(path, { withFileTypes: true }),
  mkdir: (path, opts) => mkdir(path, opts),
  writeAtomic,
  createExclusive,
  hash: hashFile,
  realpath: (path) => realpath(path),
  nativeRealpath: (path) => new Promise((done, fail) => realpathCb.native(path, (e, real) => (e ? fail(e) : done(real)))),
  plain: async (path, max, o) => readPlainFile(path, max, o.oneName ? { verify: oneName } : {}),
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { recursive: true, force: true }),
  rmdir: (path) => rmdir(path),
  removeFile: (path) => rm(path, { force: true }),
  // core's reads of records (renders/): names, a record's text without following a link, a file's identity.
  names: NODE_RECORD_FS.names,
  text: NODE_RECORD_FS.text,
  ...(NODE_RECORD_FS.identity ? { identity: NODE_RECORD_FS.identity } : {}),
};

/** The outputs of the projects on this machine's disk. */
export const diskOutputs: Outputs = outputsOn(nodeOutputFs);
