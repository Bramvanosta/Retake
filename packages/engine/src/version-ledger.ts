/**
 * The versions of a file one engine showed or wrote (its context holds one ledger per kind), by the file's path: an
 * undo / redo `restore` of a scenario or a theme writes back only one of these (an earlier version the person had on
 * disk may hold a hidden character today's file no longer has). Bounded both ways: the newest `perFile` versions of the
 * `files` files used last.
 */
export class VersionLedger {
  readonly #versions = new Map<string, string[]>();

  constructor(
    private readonly perFile = 128,
    private readonly files = 256,
  ) {}

  /** `hash` is a version of `path` this engine showed or wrote (the newest; the file used last). */
  remember(path: string, hash: string): void {
    const list = this.#versions.get(path) ?? [];
    this.#versions.delete(path);
    const at = list.indexOf(hash);
    if (at !== -1) list.splice(at, 1);
    list.push(hash);
    if (list.length > this.perFile) list.shift();
    this.#versions.set(path, list);
    if (this.#versions.size > this.files) this.#versions.delete(this.#versions.keys().next().value!);
  }

  /** Whether this engine showed or wrote that version of the file. */
  knows(path: string, hash: string): boolean {
    return this.#versions.get(path)?.includes(hash) ?? false;
  }
}
