/**
 * The product's adapter of the Outputs port (outputs.ts): the run folders on node:fs. Named only here and in ports.ts
 * `enginePorts` (the import-rules ratchet's `output-read` check).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Outputs } from './outputs.js';
import { runOutputsOn } from './output-files.js';
import type { OutputFs } from './output-files.js';

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
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

const nodeOutputFs: OutputFs = {
  lstat,
  stat,
  readFile: (path) => readFile(path, 'utf8'),
  readdir: (path) => readdir(path, { withFileTypes: true }),
  mkdir: (path, opts) => mkdir(path, opts),
  writeAtomic,
  hash: hashFile,
  realpath: (path) => realpath(path),
};

/** The outputs of the projects on this machine's disk. */
export const diskOutputs: Outputs = { runs: runOutputsOn(nodeOutputFs) };
