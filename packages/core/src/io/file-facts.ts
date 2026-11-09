/**
 * The Node implementation of core's FileFacts port (core file-facts.ts): node:fs answers. Its videos are probed by
 * fileFacts(policy) (work-files.ts), with the ffprobe of a work.
 */
import { accessSync, closeSync, constants as fsConstants, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import type { FileFacts, FileKind } from '../file-facts.js';

function kind(p: string): FileKind | undefined {
  try {
    const st = statSync(p);
    return st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other';
  } catch {
    return undefined;
  }
}

function realpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function nativeRealpath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

function readHead(file: string, n: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const disk = {
  exists: (p: string) => existsSync(p),
  kind,
  realpath,
  nativeRealpath,
  readText: (p: string) => readFileSync(p, 'utf8'),
  readHead,
  isExecutable,
};

/**
 * FileFacts read from this machine's file system for the checks that need no program: existence, kinds, real paths,
 * texts. It probes no video — that needs a work's policy (fileFacts(policy)) — and throws if asked to.
 */
export const nodeFileFacts: FileFacts = Object.freeze({
  ...disk,
  probeVideo(): never {
    throw new Error('nodeFileFacts probes no video: the check of a work\'s files is given fileFacts(policy) (@retake/core/io)');
  },
});
