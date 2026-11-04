/**
 * Signed-in profiles and the Chromium that opens them (L5.16c, critique M6): the installed app brings its own Chromium,
 * a repository checkout uses the one its Playwright pins, and both read the same profiles in the Retake home. A profile
 * a newer Chromium wrote, opened by an older one, is a downgrade Chromium does not support — its sessions may be lost.
 * So every launch on a persona's profile records the Chromium major that opened it (`retake-browser.json` in the
 * profile; Chromium's own `Last Version` file counts too), and a launch with an older major is refused before Chromium
 * starts, with what to do.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RunnerError } from './errors.js';

/** The record a launch leaves in a profile. */
export const PROFILE_BROWSER_FILE = 'retake-browser.json';
/** Chromium's own record of the last version that opened a profile. */
const CHROMIUM_LAST_VERSION = 'Last Version';

function major(version: string | undefined | null): number | null {
  const m = /^(\d{1,4})\.\d+/.exec(version?.trim() ?? '');
  return m ? Number(m[1]) : null;
}

/** The browser versions playwright-core pins (browsers.json), by name; {} when it cannot be read. */
function pinned(): Record<string, string> {
  try {
    const root = dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
    const j = JSON.parse(readFileSync(join(root, 'browsers.json'), 'utf8')) as { browsers?: Array<{ name?: string; browserVersion?: string }> };
    return Object.fromEntries((j.browsers ?? []).filter((b) => b.name && b.browserVersion).map((b) => [b.name!, b.browserVersion!]));
  } catch {
    return {};
  }
}

/**
 * The Chromium major a launch would run (session.ts launchTarget's values): an explicit executable inside a macOS app
 * by its Info.plist, Playwright's own build by the version playwright-core pins (the headless shell when no channel and
 * no executable); null when it cannot be told (an executable outside an app): then nothing is checked or recorded.
 */
export function launchMajor(target: { executablePath?: string; channel?: string }, versions: () => Record<string, string> = pinned): number | null {
  if (target.executablePath) {
    const app = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(target.executablePath);
    if (!app) return null;
    try {
      const plist = readFileSync(join(app[1]!, 'Contents', 'Info.plist'), 'utf8');
      return major(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]);
    } catch {
      return null;
    }
  }
  const v = versions();
  return major(target.channel === undefined ? v['chromium-headless-shell'] : target.channel === 'chromium' ? v.chromium : undefined);
}

/** The newest Chromium major recorded in a profile (ours and Chromium's own), or null. */
export function profileMajor(dir: string): number | null {
  let ours: number | null = null;
  try {
    const j = JSON.parse(readFileSync(join(dir, PROFILE_BROWSER_FILE), 'utf8')) as { chromium_major?: unknown };
    if (typeof j.chromium_major === 'number' && Number.isInteger(j.chromium_major) && j.chromium_major > 0 && j.chromium_major < 10_000) ours = j.chromium_major;
  } catch {
    /* none */
  }
  let theirs: number | null = null;
  try {
    theirs = major(readFileSync(join(dir, CHROMIUM_LAST_VERSION), 'utf8'));
  } catch {
    /* none */
  }
  return ours === null ? theirs : theirs === null ? ours : Math.max(ours, theirs);
}

/** Refuse to open `dir` with Chromium `launching` when a newer one opened it last (both known); else nothing. */
export function checkProfileBrowser(dir: string, launching: number | null, persona?: string): void {
  if (launching === null || !existsSync(dir)) return;
  const recorded = profileMajor(dir);
  if (recorded === null || launching >= recorded) return;
  throw new RunnerError(
    `the signed-in profile${persona ? ` of ${persona}` : ''} (${dir}) was last opened by Chromium ${recorded}, and this copy of Retake runs Chromium ${launching}: an older Chromium would downgrade the profile and may lose its sessions, so it is not opened — run this with the copy of Retake that signed in last (the app or the repository: retake doctor says which runs the worker), or update this copy`,
  );
}

/** Record that Chromium `launching` opened `dir` (best effort; nothing when the major is unknown). */
export function recordProfileBrowser(dir: string, launching: number | null): void {
  if (launching === null) return;
  try {
    writeFileSync(join(dir, PROFILE_BROWSER_FILE), `${JSON.stringify({ chromium_major: launching, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch {
    /* the profile went away: the next launch records it */
  }
}
