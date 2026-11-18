/**
 * The names a project archive may hold (the ZIP writer and reader of the engine share them): POSIX names with `/`
 * separators, relative, each segment a plain file name a Mac's disk keeps as written. A name is judged as text only —
 * nothing here touches a disk — and two names that one disk could take for one file (case, Unicode normal forms) share
 * one folded key (foldedArchiveKey). Pure.
 */

/** The longest name, in UTF-8 bytes. */
export const ARCHIVE_NAME_MAX_BYTES = 1024;
/** The most segments a name may have. */
export const ARCHIVE_DEPTH_MAX = 32;
/** The longest segment, in UTF-8 bytes (a file name on APFS). */
export const ARCHIVE_SEGMENT_MAX_BYTES = 255;

const ENCODER = new TextEncoder();
const utf8Bytes = (s: string): number => ENCODER.encode(s).length;

/** C0 and C1 controls and DEL (NUL is said on its own). */
const CONTROL = /[\u0001-\u001f\u007f-\u009f]/;
/** Unicode format characters: zero-width, direction controls, the byte-order mark. */
const FORMAT = /\p{Cf}/u;

/** Why one segment is not a plain file name, or undefined. */
function segmentProblem(segment: string): string | undefined {
  if (segment === '') return 'an empty segment';
  if (segment === '.' || segment === '..') return `a "${segment}" segment`;
  if (/[. ]$/.test(segment)) return 'a segment ending with a dot or a space';
  if (utf8Bytes(segment) > ARCHIVE_SEGMENT_MAX_BYTES) return `a segment over ${ARCHIVE_SEGMENT_MAX_BYTES} bytes`;
  return undefined;
}

/**
 * Why `name` is not a name a project archive may hold, as a short lower-case phrase, or undefined when it is one. A
 * directory entry's name (`o.dir`) ends with exactly one `/`; any other name never does.
 */
export function archiveNameProblem(name: string, o: { dir?: boolean } = {}): string | undefined {
  if (name === '') return 'an empty name';
  if (name.includes('\0')) return 'a name with a NUL character';
  if (CONTROL.test(name)) return 'a name with a control character';
  if (FORMAT.test(name)) return 'a name with an invisible format character';
  if (name.includes('\\')) return 'a name with a backslash';
  if (name.startsWith('/')) return 'an absolute name';
  if (/^[A-Za-z]:/.test(name)) return 'a name with a drive letter';
  if (utf8Bytes(name) > ARCHIVE_NAME_MAX_BYTES) return `a name over ${ARCHIVE_NAME_MAX_BYTES} bytes`;
  let body = name;
  if (o.dir) {
    if (!name.endsWith('/')) return 'a folder name without its trailing "/"';
    body = name.slice(0, -1);
    if (body === '') return 'an empty name';
  }
  const segments = body.split('/');
  if (segments.length > ARCHIVE_DEPTH_MAX) return `a name over ${ARCHIVE_DEPTH_MAX} levels deep`;
  for (const s of segments) {
    const p = segmentProblem(s);
    if (p) return p;
  }
  return undefined;
}

/**
 * The key two names share when one disk could take them for one file: NFC, then lower, upper and lower case again
 * (a fold that refuses more than any disk would, which is safe).
 */
export function foldedArchiveKey(name: string): string {
  return name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase();
}
