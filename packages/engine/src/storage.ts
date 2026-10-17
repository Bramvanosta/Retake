/**
 * Media storage abstraction (R-ARC-03), local only: project artefacts are addressed by a ref — a project-relative POSIX
 * path such as `runs/20261017-142233-quote/capture.mp4` — with a sha256 where the content matters. Clients get the ref
 * (what a later remote storage keeps) and the local path (what Claude reads). The producers (runner, editor, review)
 * still write absolute paths into their own records: moving them to refs is a format change (L3.6 / BL-70).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { EngineError } from './errors.js';

export type StoredKind = 'run' | 'render' | 'review' | 'export' | 'journal' | 'asset' | 'scenario' | 'project';

export interface StoredRef {
  /** Project-relative POSIX path. */
  ref: string;
  /** Absolute local path (LocalStorage). */
  path: string;
  kind: StoredKind;
  bytes?: number;
  /** Hex sha256 of the content (when asked for). */
  sha256?: string;
}

export interface WriteResult {
  ref: string;
  path: string;
  /** Hex sha256 of the bytes written. */
  sha256: string;
  bytes: number;
}

export interface Storage {
  readonly scheme: 'local';
  /** The local path of a ref; refuses absolute refs, `..`, backslashes and empty segments. */
  resolve(ref: string): string;
  /** The ref of a local path; throws when it is outside the project. */
  refOf(path: string): string;
  /** stat + (optionally) a streamed sha256; undefined when the file does not exist. */
  describe(ref: string, kind: StoredKind, opts?: { hash?: boolean }): Promise<StoredRef | undefined>;
  /** The text of a ref and the sha256 of its bytes; undefined when it does not exist. */
  readText(ref: string): Promise<{ text: string; sha256: string } | undefined>;
  /**
   * Write atomically (temporary file + rename). `ifMatch`: a hash → the file must exist with that content hash (checked
   * again just before the rename); null → the file must not exist (an atomic link: never overwrites); undefined → no
   * check. A mismatch is an EngineError `conflict` with `details.current` (the current hash, or null).
   */
  writeText(ref: string, text: string, opts?: { ifMatch?: string | null }): Promise<WriteResult>;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A project-relative POSIX path: no absolute path, no `..` / `.` / empty segment, no backslash, no NUL. */
export function checkRef(ref: string): string {
  const bad =
    typeof ref !== 'string' ||
    ref === '' ||
    ref.startsWith('/') ||
    /^[A-Za-z]:/.test(ref) ||
    ref.includes('\\') ||
    ref.includes('\0') ||
    ref.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
  if (bad) throw new EngineError('invalid', `invalid file reference "${String(ref)}": use a path relative to the project folder, without ".." (e.g. scenarios/quote.yaml)`);
  return ref;
}

export class LocalStorage implements Storage {
  readonly scheme = 'local' as const;

  constructor(readonly root: string) {}

  resolve(ref: string): string {
    return join(this.root, ...checkRef(ref).split('/'));
  }

  refOf(path: string): string {
    if (!isAbsolute(path) || !isInside(this.root, path)) throw new EngineError('invalid', `${path} is outside the project folder ${this.root}`);
    const rel = relative(this.root, path);
    if (rel === '') throw new EngineError('invalid', `${path} is the project folder itself, not a file of it`);
    return rel.split(sep).join('/');
  }

  async describe(ref: string, kind: StoredKind, opts: { hash?: boolean } = {}): Promise<StoredRef | undefined> {
    const path = this.resolve(ref);
    let st;
    try {
      st = await stat(path);
    } catch {
      return undefined;
    }
    if (!st.isFile()) return { ref, path, kind };
    return { ref, path, kind, bytes: st.size, ...(opts.hash ? { sha256: await hashFile(path) } : {}) };
  }

  async readText(ref: string): Promise<{ text: string; sha256: string } | undefined> {
    let buf: Buffer;
    try {
      buf = await readFile(this.resolve(ref));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    return { text: buf.toString('utf8'), sha256: sha256Hex(buf) };
  }

  /** The folder a write goes to, created if needed, and refused when a symbolic link takes it out of the project. */
  private async writableDir(path: string): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const [realRoot, realDir] = await Promise.all([realpath(this.root), realpath(dir)]);
    if (!isInside(realRoot, realDir)) throw new EngineError('refused', `${dir} leads out of the project folder (symbolic link to ${realDir}): not written`);
  }

  private async currentHash(path: string): Promise<string | null> {
    try {
      return sha256Hex(await readFile(path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async writeText(ref: string, text: string, opts: { ifMatch?: string | null } = {}): Promise<WriteResult> {
    const path = this.resolve(ref);
    await this.writableDir(path);
    const buf = Buffer.from(text, 'utf8');
    const written = { ref, path, sha256: sha256Hex(buf), bytes: buf.length };
    const conflict = (current: string | null, why: string) =>
      new EngineError('conflict', `${ref}: ${why}`, {
        details: { current },
        ...(current ? { fix: `read it again and pass if_match: "${current}"` } : {}),
      });
    if (opts.ifMatch !== undefined && opts.ifMatch !== null) {
      const current = await this.currentHash(path);
      if (current !== opts.ifMatch) throw conflict(current, current === null ? 'does not exist (if_match names a content it never had)' : 'changed since it was read (if_match does not match its content)');
    }
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, buf);
    try {
      if (opts.ifMatch === null) {
        // Must not exist: link() fails with EEXIST instead of replacing (no exists-then-rename window).
        try {
          await link(tmp, path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw conflict(await this.currentHash(path), 'already exists');
          throw e;
        }
        return written;
      }
      if (opts.ifMatch !== undefined) {
        const current = await this.currentHash(path);
        if (current !== opts.ifMatch) throw conflict(current, 'changed while it was being written (if_match no longer matches)');
      }
      await rename(tmp, path);
      return written;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }
}
