/**
 * Hotfix v0.2.5 (field point 21): the accounts of a Firebase Auth emulator, put back at every reset. The emulator keeps
 * them in memory: a database snapshot does not cover them, and restarting it loses the seeded ones too. With
 * `reset.firebase_auth: {url, project}` the sandbox empties its accounts before each seed, saves them after it (the
 * emulator's own export: `accounts:batchGet?maxResults=-1`), and at every reset empties them and imports the saved ones
 * (`accounts:batchCreate`, as `firebase emulators:start --import` does) — all with the emulator's `Bearer owner`.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedSandbox } from '@retake/core/model';
import { SandboxError } from './errors.js';
import { pinnedAddress } from './health.js';
import type { SandboxPaths } from './paths.js';

const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const TIMEOUT_MS = 15_000;

/** The saved accounts: `<state dir>/firebase-auth.json` (the emulator's export, with the seed hash it belongs to). */
export function firebaseAuthFile(paths: Pick<SandboxPaths, 'dir'>): string {
  return join(paths.dir, 'firebase-auth.json');
}

interface Saved {
  hash: string;
  project: string;
  users: unknown[];
}

export class FirebaseAuthSnapshot {
  private constructor(
    private readonly env: string,
    private readonly base: string,
    private readonly project: string,
    private readonly file: string,
  ) {}

  /**
   * The emulator of `sandbox` (null when it names none). `address(port)`: where the sandbox's own services publish a
   * port (docker-compose: 127.0.0.1…) — a loopback host name is reached there, never where `localhost` resolves first.
   */
  static async open(sandbox: LoadedSandbox, paths: Pick<SandboxPaths, 'dir'>, address?: (port: number) => Promise<string | undefined>): Promise<FirebaseAuthSnapshot | null> {
    const fa = sandbox.manifest.reset?.firebase_auth;
    if (!fa) return null;
    let base = fa.url.replace(/\/+$/, '');
    try {
      const u = new URL(base);
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      const known = address ? await address(port) : undefined;
      const pinned = known === undefined ? undefined : pinnedAddress(base, new Map([[port, known]]));
      if (pinned) {
        u.hostname = pinned.includes(':') ? `[${pinned}]` : pinned;
        base = u.toString().replace(/\/+$/, '');
      }
    } catch {
      throw new SandboxError(`sandbox ${sandbox.env}: reset.firebase_auth.url is not a URL (${fa.url})`);
    }
    return new FirebaseAuthSnapshot(sandbox.env, base, fa.project, firebaseAuthFile(paths));
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = await fetch(url, { method, headers: OWNER, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      const err = e as Error & { code?: string; cause?: { code?: string } };
      throw new SandboxError(`sandbox ${this.env}: the Firebase Auth emulator did not answer (${method} ${url}): ${err.cause?.code ?? err.code ?? err.message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new SandboxError(`sandbox ${this.env}: the Firebase Auth emulator refused ${method} ${path} (HTTP ${res.status}): ${text.slice(0, 300)}`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }

  private get projectPath(): string {
    return encodeURIComponent(this.project);
  }

  /** Empty the emulator's accounts (before a seed, before an import). */
  async clear(): Promise<void> {
    await this.call('DELETE', `/emulator/v1/projects/${this.projectPath}/accounts`);
  }

  /** Save its accounts after the seed (for seed `hash`): how many. */
  async save(hash: string): Promise<number> {
    const r = (await this.call('GET', `/identitytoolkit.googleapis.com/v1/projects/${this.projectPath}/accounts:batchGet?maxResults=-1`)) as { users?: unknown[] };
    const users = Array.isArray(r.users) ? r.users : [];
    const saved: Saved = { hash, project: this.project, users };
    writeFileSync(this.file, JSON.stringify(saved), { mode: 0o600 });
    return users.length;
  }

  /** The saved accounts are those of seed `hash` (and of this project). */
  valid(hash: string): boolean {
    const s = this.read();
    return s !== null && s.hash === hash && s.project === this.project;
  }

  private read(): Saved | null {
    if (!existsSync(this.file)) return null;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
      return Array.isArray(s.users) && typeof s.hash === 'string' ? s : null;
    } catch {
      return null;
    }
  }

  /** Put the saved accounts back: emptied, then imported. How many; throws when nothing is saved. */
  async restore(): Promise<number> {
    const s = this.read();
    if (!s) throw new SandboxError(`sandbox ${this.env}: no saved accounts of the Firebase Auth emulator: reset with --reseed`);
    await this.clear();
    if (s.users.length) await this.call('POST', `/identitytoolkit.googleapis.com/v1/projects/${this.projectPath}/accounts:batchCreate`, { users: s.users });
    return s.users.length;
  }

  /** Forget the saved accounts (the seed runs again). */
  forget(): void {
    rmSync(this.file, { force: true });
  }
}
