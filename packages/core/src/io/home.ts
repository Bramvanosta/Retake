/**
 * The Retake home: the folder of this machine's own state (signed-in sessions, the signing key).
 */
import { lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { defaultRetakeHome, iosDeviceLocks, iosDriverCache } from '../layout.js';
import { expandHome } from '../util.js';
import { assertOutsideBundle, bundleInfoOrNull } from './bundle.js';

/**
 * The Retake home: $RETAKE_HOME (~ expanded, made absolute), else ~/.retake. A $RETAKE_HOME inside the app bundle is
 * refused (BundleError): the signed-in profiles are written there, and nothing writes inside the app.
 */
export function retakeHome(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.RETAKE_HOME;
  if (v && v.trim() !== '') {
    const home = resolve(expandHome(v.trim()));
    assertOutsideBundle(home, '$RETAKE_HOME', bundleInfoOrNull());
    return home;
  }
  return defaultRetakeHome(homedir());
}

/** The iOS driver's build folder for `key` (an Xcode build and the driver's sources) in this machine's Retake home. */
export function homeIosDriverCache(key: string, env: NodeJS.ProcessEnv = process.env): string {
  return iosDriverCache(retakeHome(env), key);
}

/**
 * The folder of this user's iOS simulator locks (core iosDeviceLocks), made private (0700) on first use; refused when
 * what is there is not this user's own folder (a link, another user's).
 */
export function iosDeviceLockDir(root = '/tmp', uid: number = process.getuid?.() ?? 0): string {
  const dir = iosDeviceLocks(uid, root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not this user's private folder of simulator locks: remove it and run again`);
  }
  return dir;
}
