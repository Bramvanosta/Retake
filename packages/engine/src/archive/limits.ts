/**
 * The caps of a project archive, one set for the writer and the reader (zip-write.ts, zip-read.ts): an export never
 * writes what an import would refuse. An entry's cap is asked by its name, so a later kind of entry (an image of a
 * sandbox) may be given its own.
 */

/** Entries of one archive, at most (files and folders). */
export const ZIP_ENTRIES_MAX = 100_000;
/** The manifest's bytes, at most: sized for ZIP_ENTRIES_MAX files listed with their paths and hashes. */
export const ZIP_MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
/** One entry's bytes, at most, unless the caller's `entryMax` says otherwise for its name. */
export const ZIP_ENTRY_MAX_BYTES = 8 * 1024 * 1024 * 1024;
/**
 * The entries of a sandbox's images (`images/sha256-<hex>.tar.gz`): bound by the free space only (an import's
 * `totalMax`), not by ZIP_ENTRY_MAX_BYTES — an image may be larger.
 */
export const ZIP_IMAGES_PREFIX = 'images/';

/** One entry's cap by its name: an image's the free space, any other ZIP_ENTRY_MAX_BYTES. */
export function archiveEntryMax(name: string): number {
  return name.startsWith(ZIP_IMAGES_PREFIX) ? Number.MAX_SAFE_INTEGER : ZIP_ENTRY_MAX_BYTES;
}

/** The largest ratio of an entry's bytes to its compressed bytes, for an entry declared over ZIP_RATIO_FLOOR. */
export const ZIP_RATIO_MAX = 1000;
/** The size from which an entry's compression ratio is checked. */
export const ZIP_RATIO_FLOOR = 10 * 1024 * 1024;

/**
 * Whether an entry of `size` bytes stored as `compressed` bytes reads as a bomb (the reader refuses it): the one rule of
 * the writer and the reader, so an archive our writer makes is never one our reader refuses — the writer stores an
 * entry whose deflated bytes would break it.
 */
export function bombRatio(size: number, compressed: number): boolean {
  return size > ZIP_RATIO_FLOOR && (compressed === 0 || size / compressed > ZIP_RATIO_MAX);
}

/** What one archive may hold. */
export interface ZipLimits {
  /** Entries, at most. */
  entries: number;
  /** One entry's bytes, at most, by its name. */
  entryMax(name: string): number;
  /** Every entry's bytes together, at most (an import passes the free space of its disk less a margin). */
  totalMax: number;
}

/** The default caps: ZIP_ENTRIES_MAX entries, ZIP_ENTRY_MAX_BYTES per entry, no total. */
export function defaultZipLimits(): ZipLimits {
  return { entries: ZIP_ENTRIES_MAX, entryMax: () => ZIP_ENTRY_MAX_BYTES, totalMax: Number.MAX_SAFE_INTEGER };
}

/** The given caps over the defaults. */
export function zipLimits(given: Partial<ZipLimits> = {}): ZipLimits {
  return { ...defaultZipLimits(), ...given };
}
