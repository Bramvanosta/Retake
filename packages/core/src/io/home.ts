/**
 * The Retake home: the folder of this machine's own state (signed-in sessions, the signing key).
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { defaultRetakeHome } from '../layout.js';
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
