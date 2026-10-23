/**
 * node:sqlite, loaded lazily (L4.1, the workspace index). Node 22.13+ loads it without a flag and prints one
 * ExperimentalWarning ("SQLite is an experimental feature…"; Node 24.15+ prints none); Node 22.0–22.12 do not have it
 * (`ERR_UNKNOWN_BUILTIN_MODULE`) — the Studio then runs without its index, and nothing else changes.
 *
 * The warning filter is scoped twice (critique B11): it lives only while the module is imported, and it swallows only
 * the warning whose message names SQLite — any other warning emitted in that window (a DeprecationWarning…) still prints.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface SqliteModule {
  DatabaseSync: typeof DatabaseSync;
}

/** Loads node:sqlite; null when this Node.js has none. Injected by tests (a Node.js without it, a broken module). */
export type SqliteLoader = () => Promise<SqliteModule | null>;

/** The one warning the loader swallows: node:sqlite's experimental notice, matched on its message. */
export const SQLITE_WARNING = /^SQLite is an experimental feature/;

function warningText(warning: unknown): string {
  return typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : String(warning);
}

let loaded: Promise<SqliteModule | null> | undefined;

/** node:sqlite, imported once per process with the scoped warning filter; null on a Node.js without it. */
export const loadSqlite: SqliteLoader = () =>
  (loaded ??= (async () => {
    const emit = process.emitWarning;
    process.emitWarning = function (this: typeof process, warning: string | Error, ...rest: unknown[]) {
      if (SQLITE_WARNING.test(warningText(warning))) return;
      return (emit as (...a: unknown[]) => void).call(this, warning, ...rest);
    } as typeof process.emitWarning;
    try {
      return (await import('node:sqlite')) as SqliteModule;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ERR_UNKNOWN_BUILTIN_MODULE') return null;
      throw e;
    } finally {
      process.emitWarning = emit;
    }
  })());

/** SQLITE_CORRUPT (11) and SQLITE_NOTADB (26): a file to delete and rebuild. node:sqlite's `code` is generic. */
export function isCorruptionError(e: unknown): boolean {
  const errcode = (e as { errcode?: unknown } | null)?.errcode;
  return errcode === 11 || errcode === 26;
}
