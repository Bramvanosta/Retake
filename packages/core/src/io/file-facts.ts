/**
 * The Node implementation of core's FileFacts port (core file-facts.ts): node:fs answers. A work's videos are probed by
 * its VideoProber (fileFacts(policy), work-files.ts), with the ffprobe of that work.
 */
import { accessSync, closeSync, constants as fsConstants, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import type { ProgramPolicyOptions } from '../agent-policy.js';
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

/**
 * FileFacts read from this machine's file system: kinds, real paths, texts, executables, whether case counts. No
 * VideoProber: a video is probed under a work's policy (fileFacts(policy)); a check given nodeFileFacts that must probe
 * one throws FileFactsMissingError.
 */
export const nodeFileFacts: FileFacts = Object.freeze({
  kind,
  realpath,
  nativeRealpath,
  readText: (p: string) => readFileSync(p, 'utf8'),
  readHead,
  isExecutable,
  ignoresCase: process.platform === 'darwin' || process.platform === 'win32',
});

/**
 * How this process finds the program a policy checks (core ProgramPolicyOptions): its PATH, read when called, and
 * nodeFileFacts.
 */
export function programLookup(): ProgramPolicyOptions {
  return { path: process.env.PATH ?? '', files: nodeFileFacts };
}
