#!/usr/bin/env node
/**
 * The release's last half (L5.16e fixes, review e A-H1; DESIGN §4p (e)): from an app laid out and signed ad hoc by
 * `bundle.mjs build` to what a release ships — the Developer ID signature, notarisation and stapling, the update
 * archive and its signature, the DMG.
 *
 *   node apps/desktop/scripts/release.mjs unpack <archive> --into <dir>
 *   node apps/desktop/scripts/release.mjs sign --app <dir>/Retake.app --out <dir> [--release]
 *        [--app-version <version>] [--tauri-cli <dir>]
 *
 * The release workflow's `sign` job runs it on a fresh runner that runs no dependency code: no `pnpm install`, no
 * package script, no build tool — its whole import graph is Node.js built-ins and files of this repository (a test
 * walks it). It holds the signing keys, so it never runs anything it was handed but the Tauri CLI, and that only from a
 * fresh copy, in a temporary folder of its own, of bytes that matched the sha512 pinned in
 * apps/desktop/bundle/tauri-cli.json (bundle.mjs `freshTauriCli`).
 * `pnpm desktop:bundle` and `pnpm desktop:release` run the same `finishApp` after laying the app out.
 *
 * - `unpack`: the build job's archive into an empty folder — only its three parts (`unpackBuild`): app/Retake.app,
 *   tauri-cli/ and bundle-report.json, each a real folder or file; an archive with any other member is refused.
 *
 * - `--release`: re-signed inside-out with the Developer ID (APPLE_SIGNING_IDENTITY, APPLE_TEAM_ID, notarytool's
 *   credentials — sign.mjs releaseConfig, which refuses first without the whole set; APPLE_KEYCHAIN in the workflow),
 *   bundle.json's hashes refreshed, verified, notarised as a zip and stapled; the DMG signed, notarised and stapled;
 *   the team, Gatekeeper and both tickets checked. Without it: the ad hoc app as it is, checked, and an ad hoc DMG.
 * - an app built with the updater (launch.json `updates: on`): Retake.app.tar.gz, signed with TAURI_SIGNING_PRIVATE_KEY
 *   (+ _PASSWORD) by the pinned Tauri CLI (`--tauri-cli`: the folder `bundle.mjs build` wrote; the signature is then
 *   checked against RETAKE_UPDATE_PUBKEY) — unsigned, and said, without the key.
 * - `--app-version`: the version the app must carry (Info.plist CFBundleShortVersionString and bundle.json's `app`; the
 *   workflow passes the tag's) — the update archive is signed for it, the DMG named after it.
 * - `--out`: an empty folder of its own (or one an earlier run marked: emptied first — no stale archive survives).
 *   The app's folder becomes the DMG's: it holds the app and at most its Applications link.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCT, StageError, UPDATE_ARCHIVE, appProblems, buildEnv, checkFolder, checkPubkey, dmgCreateArgs, freshTauriCli, hdiutil, linkCount, makeUpdateArchive, refreshManifestHashes, signUpdateArchive, useBuildEnv, verifyDmg } from './bundle.mjs';
import { SignError, notarizeApp, notarizeDmg, readTable, signApp, signDmg, signPayload, signer, verifyApp, verifyRelease } from './sign.mjs';

/** What `sign` writes in its `--out` folder first: a later run may empty it (and nothing else). */
export const RELEASE_MARK = '.retake-release';

/** A version as the app carries it (semver: the DMG's name is made of it). */
export const APP_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The build job's archive holds these, and only these: the app's folder, the Tauri CLI's folder, the report. */
export const BUILD_PARTS = ['app', 'bundle-report.json', 'tauri-cli'];

/**
 * Why a member name of the build job's archive is refused (null: it is one of its parts). Accepted: `app`,
 * `app/Retake.app` and what is under it, `tauri-cli` and what is under it, `bundle-report.json` (a folder's trailing
 * `/` aside). Refused: an empty or absolute name, an empty, `.` or `..` part, anything else.
 */
export function buildMemberProblem(name) {
  const n = String(name).replace(/\/+$/, '');
  if (!n || n.startsWith('/')) return 'an empty or absolute name';
  const parts = n.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'an empty, . or .. part';
  if (n === 'app' || n === 'bundle-report.json' || parts[0] === 'tauri-cli') return null;
  if (parts[0] === 'app' && parts[1] === `${PRODUCT}.app`) return null;
  return `not a part of the build (app/${PRODUCT}.app, tauri-cli, bundle-report.json)`;
}

/**
 * The build job's archive (`/usr/bin/tar -czf … app tauri-cli bundle-report.json`) into `into` (absent or empty): its
 * members listed first — any name `buildMemberProblem` refuses, or a part missing, refuses the whole archive before
 * anything is written —, then only app/Retake.app, tauri-cli and bundle-report.json extracted (no extended attribute,
 * ACL or file flag), then checked: `into` holds exactly those three, `app` exactly Retake.app, each folder a real folder
 * (no link) and the report a file. A refusal leaves nothing of the archive behind. Returns the parts' paths.
 */
export function unpackBuild(archive, into, { tar = '/usr/bin/tar', env = { PATH: '/usr/bin:/bin' } } = {}) {
  const dest = resolve(into);
  const at = lstatSync(dest, { throwIfNoEntry: false });
  if (at && (!at.isDirectory() || readdirSync(dest).length)) throw new StageError(`--into ${dest}: an empty folder of its own`);
  const list = spawnSync(tar, ['-tzf', archive], { encoding: 'utf8', env, maxBuffer: 1 << 28 });
  if (list.status !== 0) throw new StageError(`${archive}: not a readable archive (${(list.stderr || list.error?.message || '').trim().split('\n').slice(-1)[0]})`);
  const names = list.stdout.endsWith('\n') ? list.stdout.slice(0, -1).split('\n') : list.stdout.split('\n');
  const refused = names.map((n) => [n, buildMemberProblem(n)]).filter(([, p]) => p);
  if (refused.length) throw new StageError(`${archive} is not the build job's archive: ${refused.slice(0, 3).map(([n, p]) => `${JSON.stringify(n)} (${p})`).join(', ')}${refused.length > 3 ? ` (+${refused.length - 3})` : ''} — nothing was unpacked`);
  const want = [`app/${PRODUCT}.app`, 'tauri-cli', 'bundle-report.json'];
  const plain = names.map((n) => n.replace(/\/+$/, ''));
  for (const w of want) if (!plain.some((n) => n === w || n.startsWith(`${w}/`))) throw new StageError(`${archive} holds no ${w} — nothing was unpacked`);
  mkdirSync(dest, { recursive: true });
  try {
    const x = spawnSync(tar, ['-xzf', archive, '--no-xattrs', '--no-acls', '--no-fflags', '-C', dest, ...want], { encoding: 'utf8', env, maxBuffer: 1 << 24 });
    if (x.status !== 0) throw new StageError(`${archive}: tar could not unpack it (${(x.stderr || x.error?.message || '').trim().split('\n').slice(-1)[0]})`);
    const top = readdirSync(dest).sort();
    if (JSON.stringify(top) !== JSON.stringify(BUILD_PARTS)) throw new StageError(`${dest} holds ${top.join(', ') || 'nothing'} once unpacked, not ${BUILD_PARTS.join(', ')}`);
    const kind = (rel) => {
      const st = lstatSync(join(dest, rel));
      return st.isSymbolicLink() ? 'a link' : st.isDirectory() ? 'folder' : st.isFile() ? 'file' : 'not a file';
    };
    for (const [rel, k] of [['app', 'folder'], ['tauri-cli', 'folder'], ['bundle-report.json', 'file'], [`app/${PRODUCT}.app`, 'folder']]) {
      if (rel === `app/${PRODUCT}.app` && JSON.stringify(readdirSync(join(dest, 'app'))) !== JSON.stringify([`${PRODUCT}.app`])) throw new StageError(`${join(dest, 'app')} holds ${readdirSync(join(dest, 'app')).join(', ')}, not ${PRODUCT}.app alone`);
      const got = kind(rel);
      if (got !== k) throw new StageError(`${join(dest, rel)} is ${got === 'folder' || got === 'file' ? `a ${got}` : got}, not a real ${k}`);
    }
    return { app: join(dest, 'app', `${PRODUCT}.app`), tauriCli: join(dest, 'tauri-cli'), report: join(dest, 'bundle-report.json') };
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

/** The app's Info.plist as JSON (plutil, the build's environment). */
function infoOf(app, env) {
  const r = spawnSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8', env });
  if (r.status !== 0) throw new StageError(`${app}: no readable Contents/Info.plist (${(r.stderr || '').trim()})`);
  return JSON.parse(r.stdout);
}

/**
 * Finish an app laid out and signed ad hoc (see the module comment). `mode`: 'dry' or 'release'; `cliJs`: the pinned
 * Tauri CLI's tauri.js (needed only to sign an update archive); `pubkey`: the key the archive's signature is checked
 * with (default RETAKE_UPDATE_PUBKEY; bundle.mjs passes the overlay's); `verified`: the ad hoc app was checked a moment
 * ago (bundle.mjs) — not again; `say(step, message)`: progress and timings; `retry`: hdiutil's retry options (tests').
 * Returns `{ mode, app, dmg, version, update }`.
 */
export function finishApp({ app, out, mode = 'dry', env = process.env, cliJs = null, pubkey, appVersion, entries = readTable(), dmg: makeDmg = true, verified = false, say = () => {}, retry = {} }) {
  const child = buildEnv(env);
  // A release is refused here, before anything is touched, without the whole APPLE_* set.
  const s = signer(mode, env, child);
  useBuildEnv(child);
  const res = join(app, 'Contents', 'Resources');
  for (const f of ['bundle.json', 'launch.json']) if (!existsSync(join(res, f))) throw new StageError(`${app}: no Contents/Resources/${f} — not an app bundle.mjs laid out`);
  const manifest = JSON.parse(readFileSync(join(res, 'bundle.json'), 'utf8'));
  const updates = JSON.parse(readFileSync(join(res, 'launch.json'), 'utf8')).updates === 'on';
  const version = infoOf(app, child).CFBundleShortVersionString;
  if (appVersion !== undefined && version !== appVersion) throw new StageError(`${app} is version ${version} (Info.plist), not ${appVersion}: build the tagged commit — nothing was signed`);
  // bundle.json's version names the DMG: a version, and the app's own (Info.plist, so --app-version's) whenever it is
  // given or a DMG is made (a build without either may lay a newer shell over a reused stage).
  if (typeof manifest.app !== 'string' || !APP_VERSION.test(manifest.app)) throw new StageError(`${app}: bundle.json's app is not a version (${JSON.stringify(manifest.app)?.slice(0, 80)}) — nothing was signed`);
  if ((appVersion !== undefined || makeDmg) && manifest.app !== version) throw new StageError(`${app}: bundle.json says version ${manifest.app}, Info.plist ${version}: not one build — nothing was signed`);
  const key = env.TAURI_SIGNING_PRIVATE_KEY?.trim();
  const pub = pubkey ?? env.RETAKE_UPDATE_PUBKEY?.trim();
  if (updates && key && !pub) throw new StageError('the update archive is signed, so RETAKE_UPDATE_PUBKEY is needed to check its signature — nothing was signed');
  if (updates && key) checkPubkey(pub);
  if (updates && key && !cliJs) throw new StageError('the update archive is signed by the pinned Tauri CLI: give its folder (--tauri-cli, the one bundle.mjs build wrote) — nothing was signed');
  const appDir = dirname(app);
  if (makeDmg) {
    const others = readdirSync(appDir).filter((n) => n !== basename(app) && n !== 'Applications');
    if (others.length) throw new StageError(`${appDir} becomes the DMG: it must hold ${basename(app)} only (it holds ${others.slice(0, 3).join(', ')})`);
  }
  mkdirSync(out, { recursive: true });

  // 1. The signature: re-signed inside-out with the Developer ID (release), or the ad hoc one checked as it is.
  if (mode === 'release') {
    if (spawnSync('xattr', ['-cr', app], { env: child }).status !== 0) throw new StageError(`xattr -cr ${app} failed`);
    const plan = signPayload(res, s, { entries, work: join(out, 'entitlements') });
    refreshManifestHashes(res);
    signApp(app, s);
    const problems = [...verifyApp(app, 'release', { entries, env: child }), ...appProblems(app)];
    if (problems.length) throw new StageError(`the app fails its checks after its Developer ID signature:\n  ${problems.join('\n  ')}`);
    say('sign_release', `app signed with the Developer ID (${plan.items.length} signatures) and verified`);
    notarizeApp(s, app, join(out, 'notarize'));
    say('notarize', 'app notarised and stapled');
  } else if (!verified) {
    const problems = [...verifyApp(app, 'dry', { entries, env: child }), ...appProblems(app)];
    if (problems.length) throw new StageError(`the app fails its checks:\n  ${problems.join('\n  ')}`);
    say('verify', 'ad hoc app verified');
  }

  // 2. The update archive (an app with the updater only), signed when the private key is given. No file of an
  //    earlier run survives: an app without the updater leaves none.
  let update = null;
  for (const f of [UPDATE_ARCHIVE, `${UPDATE_ARCHIVE}.sig`]) rmSync(join(out, f), { force: true });
  if (updates) {
    const archive = makeUpdateArchive(app, out, { env: child });
    const sig = key ? signUpdateArchive({ cliJs, archive, version, pubkey: pub, env }) : null;
    update = { version, archive, signature: sig, size: statSync(archive).size, links: linkCount(app) };
    say('update', sig ? `update archive made and signed (${archive})` : `update archive made, NOT signed: no TAURI_SIGNING_PRIVATE_KEY (${archive})`);
  }

  // 3. The DMG: the app and an Applications link (hdiutil tried again on "Resource busy"), then checked (release:
  //    signed, notarised, stapled, then the team, Gatekeeper and both tickets).
  let dmg = null;
  if (makeDmg) {
    dmg = join(out, `${PRODUCT}_${manifest.app}_aarch64.dmg`);
    rmSync(dmg, { force: true });
    if (!lstatSync(join(appDir, 'Applications'), { throwIfNoEntry: false })) symlinkSync('/Applications', join(appDir, 'Applications'));
    hdiutil(dmgCreateArgs({ src: appDir, dmg }), { env: child, ...retry });
    signDmg(s, dmg);
    if (mode === 'release') notarizeDmg(s, dmg);
    const problems = verifyDmg(dmg, join(out, 'mnt'), { env: child, retry });
    if (mode === 'release') problems.push(...verifyRelease(app, dmg, s));
    if (problems.length) throw new StageError(`the DMG fails its checks:\n  ${problems.join('\n  ')}`);
    say('dmg', `DMG made and verified (${dmg})`);
  }
  return { mode, app, dmg, version, update };
}

/** Claim `--out`: absent or empty, or marked by an earlier run (then emptied); never the app's folder or inside it. */
export function claimReleaseOut(out, app, env = process.env) {
  const dir = checkFolder(out, '--out', env);
  const appAt = resolve(app);
  const inside = (a, b) => a === b || a.startsWith(`${b}${sep}`);
  if (inside(dir, dirname(appAt)) || inside(dirname(appAt), dir)) throw new StageError(`--out ${dir}: a folder of its own, apart from the app's (${dirname(appAt)})`);
  if (existsSync(dir) && readdirSync(dir).length) {
    if (!existsSync(join(dir, RELEASE_MARK))) throw new StageError(`--out ${dir} is not empty and holds no earlier run (${RELEASE_MARK}): give an empty folder of its own`);
    for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RELEASE_MARK), '');
  return dir;
}

/** The command line's flags: `sign --app <dir> --out <dir> [--release] [--app-version <v>] [--tauri-cli <dir>]`. */
export function parseSignArgs(argv) {
  const out = { release: false };
  const names = { '--app': 'app', '--out': 'out', '--app-version': 'appVersion', '--tauri-cli': 'tauriCli' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--release') out.release = true;
    else if (names[a] && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')) out[names[a]] = argv[++i];
    else throw new StageError(`unknown argument "${a}" (sign --app <dir>/${PRODUCT}.app --out <dir> [--release] [--app-version <version>] [--tauri-cli <dir>])`);
  }
  for (const k of ['app', 'out']) if (!out[k]) throw new StageError(`sign needs --${k} <dir>`);
  return out;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...rest] = process.argv.slice(2);
  // The fresh copy of the Tauri CLI goes whatever happens (the finally below; errors set the exit status).
  let fresh = null;
  try {
    if (command === 'unpack') {
      if (rest.length !== 3 || rest[1] !== '--into' || rest[0].startsWith('--')) throw new StageError('usage: release.mjs unpack <archive> --into <dir>');
      const parts = unpackBuild(rest[0], rest[2]);
      process.stdout.write(`${JSON.stringify(parts, null, 1)}\n`);
    } else if (command !== 'sign') {
      throw new StageError(`usage: release.mjs sign --app <dir>/${PRODUCT}.app --out <dir> [--release] [--app-version <version>] [--tauri-cli <dir>] | unpack <archive> --into <dir>`);
    } else {
      const args = parseSignArgs(rest);
      // A release without the whole APPLE_* set is refused before anything is claimed, checked or run.
      signer(args.release ? 'release' : 'dry', process.env, {});
      const app = resolve(args.app);
      if (!existsSync(join(app, 'Contents')) || !app.endsWith('.app')) throw new StageError(`--app ${app}: an app bundle (…/${PRODUCT}.app)`);
      const out = claimReleaseOut(args.out, app);
      // The CLI runs from a fresh copy of its checked bytes, never from the folder it was handed.
      fresh = args.tauriCli ? freshTauriCli(args.tauriCli) : null;
      const cliJs = fresh?.cliJs ?? null;
      const t0 = Date.now();
      const timings = {};
      let last = t0;
      const say = (step, m) => {
        timings[step] = Date.now() - last;
        last = Date.now();
        process.stderr.write(`release: ${m} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
      };
      const r = finishApp({ app, out, mode: args.release ? 'release' : 'dry', env: process.env, cliJs, appVersion: args.appVersion, say });
      const report = { ...r, dmg: r.dmg && relative(out, r.dmg), update: r.update && { ...r.update, archive: relative(out, r.update.archive), signature: r.update.signature && relative(out, r.update.signature) }, timings_ms: { ...timings, total: Date.now() - t0 } };
      if (r.mode === 'dry') process.stderr.write('release: an ad hoc build — not signed with a Developer ID, not notarised (no --release)\n');
      writeFileSync(join(out, 'release-report.json'), `${JSON.stringify(report, null, 1)}\n`);
      process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
    }
  } catch (e) {
    process.stderr.write(`release: ${e instanceof StageError || e instanceof SignError ? e.message : e?.stack ?? e}\n`);
    process.exitCode = 1;
  } finally {
    if (fresh) rmSync(fresh.root, { recursive: true, force: true });
  }
}
