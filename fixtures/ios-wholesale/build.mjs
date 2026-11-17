#!/usr/bin/env node
// Builds the Northfield Buyer fixture app for the iOS Simulator and prints the .app's path.
// Usage: node build.mjs --out <dir>   (the derived data, logs and the app all go under <dir>; nothing in the checkout)
// Needs Xcode (xcodebuild); no signing identity, no team: the simulator build is signed ad hoc.

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(ROOT, 'NorthfieldBuyer.xcodeproj');
const SCHEME = 'NorthfieldBuyer';

function parseArgs(argv) {
  const at = argv.indexOf('--out');
  const out = at >= 0 ? argv[at + 1] : undefined;
  if (!out || out.startsWith('--')) {
    process.stderr.write('usage: node build.mjs --out <dir>\n');
    process.exit(2);
  }
  return { out: resolve(out) };
}

/**
 * Runs xcodebuild for the simulator; its output goes to <out>/xcodebuild.log.
 * @param {{ out: string }} opts
 * @returns {Promise<string>} the built .app's absolute path
 */
export async function buildApp({ out }) {
  await mkdir(out, { recursive: true });
  const derived = join(out, 'DerivedData');
  const logPath = join(out, 'xcodebuild.log');
  const args = [
    'build',
    '-project', PROJECT,
    '-scheme', SCHEME,
    '-configuration', 'Debug',
    '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', derived,
    'CODE_SIGN_IDENTITY=-',
    'CODE_SIGNING_REQUIRED=NO',
  ];
  const log = createWriteStream(logPath);
  const code = await new Promise((done, fail) => {
    const child = spawn('xcodebuild', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', fail);
    child.on('close', done);
  });
  log.end();
  const app = join(derived, 'Build', 'Products', 'Debug-iphonesimulator', `${SCHEME}.app`);
  if (code !== 0 || !existsSync(app)) {
    throw new Error(`xcodebuild failed (exit ${code}); see ${logPath}`);
  }
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildApp(parseArgs(process.argv.slice(2))).then(
    (app) => process.stdout.write(`${app}\n`),
    (err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    },
  );
}
