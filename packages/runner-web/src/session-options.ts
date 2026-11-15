/** A browser session's options and its realms (one browser per persona): BrowserSession. */
import { rm } from 'node:fs/promises';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import type { BrowserConfig } from '@retake/core/project';
import type { PageHttpCredentials } from '@retake/core/environment';
import type { WorkPolicy } from '@retake/core/policy';
import type { KitConfig } from './kit/types.js';
import type { WriteGuardOptions } from './write-guard.js';
import type { StorageStateFile } from './browser-state.js';

export interface SessionOptions {
  /** What the work runs under (core WorkPolicy): which Chromium and ffmpeg, which switches, under its agent policy. */
  policy: WorkPolicy;
  width: number;
  height: number;
  /** deviceScaleFactor. */
  scale: number;
  kit: KitConfig;
  browser?: BrowserConfig;
  /** Persistent profile directory. Default: a fresh temporary profile, deleted on close. */
  profileDir?: string;
  /** Playwright storageState JSON (cookies + localStorage) applied to the context. */
  storageState?: string;
  headed?: boolean;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /**
   * One browser per persona ("realms"): each launched like the single context above, on its own profile. Without
   * it the session is that single context (profileDir / storageState / a temp profile) — the realm named "".
   */
  realms?: RealmSpec[];
  /** The realm a capture page id is created in (default: ""). A tab opened by a page goes to that page's realm. */
  realmOf?: (pageId: string) => string;
  /** The realm of a js hook tab (environment page key; default: ""). */
  hookRealmOf?: (key: string) => string;
  /**
   * A read-only run: every realm is armed with the write guard at launch (write-guard.ts), realms launched later
   * too; its pages are closed through about:blank.
   */
  writes?: WriteGuardOptions;
  /**
   * The environment's HTTP credentials (core environmentHttpCredentials: the sign-in details of its page URLs), given to
   * every realm's browser for their origin only.
   */
  httpCredentials?: PageHttpCredentials;
}

/** One persona's browser: a persistent context of its own. */
export interface RealmSpec {
  /** The persona; "" = the default browser (pages without a persona). */
  name: string;
  /** Chromium user-data-dir (a per-run copy of the persona's profile). Default: a fresh temporary profile. */
  userDataDir?: string;
  /** Applied at launch: an object, or a storage-state file (cookies + localStorage). */
  storageState?: StorageStateFile | string;
  /** Directories removed when the session closes (the per-run copy), or when the launch fails. */
  cleanup?: string[];
}

/** A launched realm (BrowserSession): its context, its spare initial tab and what is removed when it closes. */
export interface Realm {
  name: string;
  context: BrowserContext;
  /** The context's initial tab, reused by the first page created in this realm. */
  spare: Page[];
  /** Temporary profile created for the realm (removed on close). */
  temp: string | null;
  cleanup: string[];
  /** The browser-level session that fails file: requests (armFileGuard), alive as long as the realm. */
  fileGuard?: CDPSession;
}

/** Close a realm's browser and remove its temporary profile and copies. */
export async function closeRealm(r: Realm): Promise<void> {
  await r.context.close().catch(() => undefined);
  for (const dir of [...(r.temp ? [r.temp] : []), ...r.cleanup]) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
