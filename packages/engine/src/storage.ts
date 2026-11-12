/**
 * Media storage abstraction (R-ARC-03), local only: project artefacts are addressed by a ref — a project-relative POSIX
 * path such as `runs/20261017-142233-quote/capture.mp4` — with a sha256 where the content matters. Clients get the ref
 * (what a later remote storage keeps) and the local path (what Claude reads). The producers (runner, editor, review)
 * still write absolute paths into their own records: moving them to refs is a format change (L3.6 / BL-70).
 */
import { createHash, randomBytes } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { SCENARIO_COMPARE_MAX_BYTES, pathInside } from '@retake/core';
import { readPlainFile } from '@retake/core/io';
import type { TakeLock } from '@retake/core/io';
import { EngineError } from './errors.js';
import { lockHolder, takeProjectLock } from './project-lock.js';

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
  /**
   * The text of a ref, the sha256 of its bytes and whether they are valid UTF-8 (when not, `text` has U+FFFD in place of
   * the bytes it could not decode); undefined when it does not exist. Refused (`refused`) when a symbolic link takes it
   * out of the project (an agent writes files in the workspace and must not read outside it this way) or when it is
   * not a regular file (a FIFO would hold the reader); `invalid` when it is over READ_TEXT_MAX_BYTES (2 MiB).
   */
  readText(ref: string): Promise<{ text: string; sha256: string; utf8: boolean } | undefined>;
  /**
   * Write atomically (temporary file + rename). `ifMatch`: a hash → the file must exist with that content hash (checked
   * again just before the rename); null → the file must not exist (an atomic link: never overwrites); undefined → no
   * check. A mismatch is an EngineError `conflict` with `details.current` (the current hash, or null). A file that is a
   * symbolic link to another file of the project is written through it (the link stays a link); a link leading out of
   * the project, or to nothing, is refused. L4.3: a write with an `ifMatch` hash holds the target's write lock
   * (`.retake/locks/write-*.lock`, shared across processes) from the check to the rename — unless `locked`: the
   * caller holds a lock that serialises every write of that file (a comment thread's) —; a replaced file keeps its mode.
   */
  writeText(ref: string, text: string, opts?: { ifMatch?: string | null; locked?: boolean }): Promise<WriteResult>;
}

/**
 * The largest file `readText` reads (README.md, a scenario): the size a scenario snapshot is compared at (core
 * SCENARIO_COMPARE_MAX_BYTES); a README the Studio edits holds 200,000 characters (≤ 800 KB of UTF-8).
 */
export const READ_TEXT_MAX_BYTES = SCENARIO_COMPARE_MAX_BYTES;

/** How long an `if_match` write waits for another write of the same file to finish (ms). */
export const WRITE_LOCK_WAIT_MS = 3000;

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
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

/** The local path of a ref of the folder `root` (checkRef: refused when it is not a folder-relative POSIX path). */
export function resolveIn(root: string, ref: string): string {
  return join(root, ...checkRef(ref).split('/'));
}

/**
 * The ref of an absolute path inside the folder `root`; refused (`invalid`) outside it or for the folder itself, the
 * folder named as `folder` says ("the project folder", "the components folder"…). Every store adapter refuses in these
 * words (LocalStorage, the memory store).
 */
export function refOfIn(root: string, path: string, folder = 'the project folder'): string {
  if (!isAbsolute(path) || !pathInside(path, root, { dotDotPrefix: true })) throw new EngineError('invalid', `${path} is outside ${folder} ${root}`);
  const rel = relative(root, path);
  if (rel === '') throw new EngineError('invalid', `${path} is ${folder} itself, not a file of it`);
  return rel.split(sep).join('/');
}

/** Why an `if_match` write found another version: a hash on a missing file, a stale hash, null on an existing file, a change during the write. */
export type ConflictWhy = 'missing' | 'stale' | 'exists' | 'raced';

const CONFLICT_WORDS: Readonly<Record<ConflictWhy, string>> = {
  missing: 'does not exist (if_match names a content it never had)',
  stale: 'changed since it was read (if_match does not match its content)',
  exists: 'already exists',
  raced: 'changed while it was being written (if_match no longer matches)',
};

/** The `conflict` of an `if_match` write, with the current hash (or null) in `details.current`: every store adapter's words. */
export function conflictError(ref: string, current: string | null, why: ConflictWhy): EngineError {
  return new EngineError('conflict', `${ref}: ${CONFLICT_WORDS[why]}`, {
    details: { current },
    ...(current ? { fix: `read it again and pass if_match: "${current}"` } : {}),
  });
}

export class LocalStorage implements Storage {
  readonly scheme = 'local' as const;

  constructor(
    readonly root: string,
    /** How refusals name the root ("the project folder"; a store of the components folder: "the components folder"). */
    private readonly folder = 'the project folder',
  ) {}

  resolve(ref: string): string {
    return resolveIn(this.root, ref);
  }

  refOf(path: string): string {
    return refOfIn(this.root, path, this.folder);
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

  async readText(ref: string): Promise<{ text: string; sha256: string; utf8: boolean } | undefined> {
    const buf = await this.readContained(this.resolve(ref), READ_TEXT_MAX_BYTES);
    return buf === null ? undefined : { text: buf.toString('utf8'), sha256: sha256Hex(buf), utf8: isUtf8(buf) };
  }

  /**
   * The bytes of a file of the project, read through its real path; null when it does not exist (a dangling link
   * included). Refused when that real path lies outside the project's real path (a symbolic link leading out, at any
   * level) — the read side of `writableDir`'s rule. A project folder that is itself a link is fine: both are real paths.
   * The refusal never names the link's target (a path outside the project the agent must not learn either). The real
   * path is then read with core readPlainFile (L4.2, the BL-79 residue): a regular file only — a FIFO, a device or a
   * folder is refused without blocking — of at most `max` bytes (`invalid`, "too large", never "not found").
   * `details.reason` says which: `link_out`, `not_file`, `too_large`.
   */
  private async readContained(path: string, max: number): Promise<Buffer | null> {
    let realRoot: string;
    let real: string;
    try {
      [realRoot, real] = await Promise.all([realpath(this.root), realpath(path)]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const fix = { fix: `replace it with a regular file inside ${this.root}` };
    if (!pathInside(real, realRoot, { dotDotPrefix: true })) throw new EngineError('refused', `${path} leads out of ${this.folder} (a symbolic link): not read`, { ...fix, details: { reason: 'link_out' } });
    const r = readPlainFile(real, max);
    if (r.ok) return r.bytes;
    switch (r.reason) {
      case 'missing':
        return null;
      case 'too_large':
        throw new EngineError('invalid', `${path} is too large: ${r.size !== undefined ? `${r.size.toLocaleString('en')} bytes` : 'over the limit'}, at most ${max.toLocaleString('en')} — not read`, {
          fix: 'shorten it (or split it) in an editor',
          details: { reason: 'too_large', max },
        });
      case 'not_file':
      case 'link':
        // `link`: the real path became a link between the realpath and the open (a swap): refused like any non-file.
        throw new EngineError('refused', `${path} is not a regular file (a FIFO, a device, a folder…): not read`, { ...fix, details: { reason: 'not_file' } });
      default:
        throw new EngineError('internal', `${path} could not be read (${r.error ?? 'unreadable'})`);
    }
  }

  /** The folder a write goes to, created if needed, and refused when a symbolic link takes it out of the project. */
  private async writableDir(path: string): Promise<void> {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true });
    const [realRoot, realDir] = await Promise.all([realpath(this.root), realpath(dir)]);
    if (!pathInside(realDir, realRoot, { dotDotPrefix: true })) throw new EngineError('refused', `${dir} leads out of ${this.folder} (a symbolic link): not written`);
  }

  /**
   * Where a write of `path` lands: `path` itself, or — when it is a symbolic link — its target, if that is a file of the
   * project (review B M3: a README.md linked to docs/product.md is saved into docs/product.md, and stays a link).
   * Refused when the link leads out of the project or to nothing.
   */
  private async writeTarget(path: string): Promise<string> {
    let st;
    try {
      st = await lstat(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return path;
      throw e;
    }
    if (!st.isSymbolicLink()) return path;
    const fix = { fix: `replace the link with a regular file inside ${this.root}` };
    let real: string;
    let realRoot: string;
    try {
      [realRoot, real] = await Promise.all([realpath(this.root), realpath(path)]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new EngineError('refused', `${path} is a symbolic link to a file that does not exist: not written`, fix);
      throw e;
    }
    if (!pathInside(real, realRoot, { dotDotPrefix: true })) throw new EngineError('refused', `${path} leads out of ${this.folder} (a symbolic link): not written`, fix);
    return real;
  }

  private async currentHash(path: string): Promise<string | null> {
    const buf = await this.readContained(path, READ_TEXT_MAX_BYTES);
    return buf === null ? null : sha256Hex(buf);
  }

  /**
   * The lock of a write to `target` (critique B1): named after the target's real path in the project, so a write
   * through a link and one to the file itself share it — the existing file's real path as the disk spells it (review A
   * M1: on a case-insensitive disk "quote.yaml" and "QUOTE.yaml" are one file, so one lock).
   */
  private async lockWrite(ref: string, target: string): Promise<TakeLock> {
    const [realRoot, realDir, realFile] = await Promise.all([realpath(this.root), realpath(dirname(target)), realpath(target).catch(() => null)]);
    const key = relative(realRoot, realFile ?? join(realDir, basename(target))).split(sep).join('/');
    return takeProjectLock(this.root, `write-${sha256Hex(key).slice(0, 24)}.lock`, {
      command: `write ${key}`.slice(0, 200),
      what: ref,
      waitMs: WRITE_LOCK_WAIT_MS,
      busy: (lockRef, held) => {
        const { pid } = lockHolder(held);
        return new EngineError('busy', `${ref} is being written by another command${pid ? ` (pid ${pid})` : ''}: try again`, {
          fix: `try again in a moment; if no retake command is running, remove ${lockRef}`,
        });
      },
    });
  }

  async writeText(ref: string, text: string, opts: { ifMatch?: string | null; locked?: boolean } = {}): Promise<WriteResult> {
    const path = this.resolve(ref);
    await this.writableDir(path);
    const target = await this.writeTarget(path);
    const buf = Buffer.from(text, 'utf8');
    const written = { ref, path, sha256: sha256Hex(buf), bytes: buf.length };
    // A write that checks a hash holds the target's lock from the first check to the rename (critique B1): another
    // writer with the same if_match waits, then finds the new content and gets its conflict.
    const lock = typeof opts.ifMatch === 'string' && !opts.locked ? await this.lockWrite(ref, target) : undefined;
    try {
      if (opts.ifMatch !== undefined && opts.ifMatch !== null) {
        const current = await this.currentHash(path);
        if (current !== opts.ifMatch) throw conflictError(ref, current, current === null ? 'missing' : 'stale');
      }
      // The replaced file's permissions are kept (critique B11): set explicitly, since writeFile's `mode` is masked by
      // the umask (a 0600 or 0664 scenario became 0644 after a save). A new file takes the umask's default.
      const mode = await lstat(target).then(
        (st) => (st.isFile() ? st.mode & 0o7777 : undefined),
        () => undefined,
      );
      const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
      // Never readable by others meanwhile (a 0600 file's new text); a new file takes the umask's default.
      await writeFile(tmp, buf, mode !== undefined ? { mode: 0o600 } : {});
      try {
        if (mode !== undefined) await chmod(tmp, mode);
        if (opts.ifMatch === null) {
          // Must not exist: link() fails with EEXIST instead of replacing (no exists-then-rename window).
          try {
            await link(tmp, target);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw conflictError(ref, await this.currentHash(path), 'exists');
            throw e;
          }
          return written;
        }
        if (opts.ifMatch !== undefined) {
          const current = await this.currentHash(path);
          if (current !== opts.ifMatch) throw conflictError(ref, current, 'raced');
        }
        await rename(tmp, target);
        return written;
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
    } finally {
      await lock?.release();
    }
  }
}

