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
 * apps/desktop/bundle/tauri-cli.json (bundle.mjs `freshTauriCli`), made right before the update archive is signed and
 * removed right after, with HOME in that copy and no other folder of its module lookup path present.
 * `pnpm desktop:bundle` and `pnpm desktop:release` run the same `finishApp` after laying the app out.
 *
 * - `unpack`: the build job's archive into an empty folder — only its two parts (`unpackBuild`): app/Retake.app and
 *   tauri-cli/, real folders; its members read here first, and an archive with any other member, a hard link, a
 *   device, a link out of the app or an AppleDouble name is refused before anything is written.
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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { PRODUCT, StageError, TAURI_CLI_PINS, UPDATE_ARCHIVE, appProblems, buildEnv, checkFolder, checkPubkey, checkTauriCliDir, dmgCreateArgs, freshTauriCli, hdiutil, linkCount, makeUpdateArchive, manifestPath, refreshManifestHashes, signUpdateArchive, useBuildEnv, verifyDmg, walk } from './bundle.mjs';
import { SignError, notarizeApp, notarizeDmg, readTable, signApp, signDmg, signPayload, signer, verifyApp, verifyRelease } from './sign.mjs';

/** What `sign` writes in its `--out` folder first: a later run may empty it (and nothing else). */
export const RELEASE_MARK = '.retake-release';

/** A version as the app carries it (semver: the DMG's name is made of it). */
export const APP_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The build job's archive holds these, and only these: the app's folder and the Tauri CLI's folder. */
export const BUILD_PARTS = ['app', 'tauri-cli'];

/**
 * Why a member name of the build job's archive is refused (null: it is one of its parts). Accepted: `app`,
 * `app/Retake.app` and what is under it, `tauri-cli` and what is under it (a folder's trailing `/` aside). Refused: an
 * empty or absolute name, an empty, `.` or `..` part, an AppleDouble name (`._…`: tar would apply it as another
 * file's metadata), anything else.
 */
export function buildMemberProblem(name) {
  const n = String(name).replace(/\/+$/, '');
  if (!n || n.startsWith('/')) return 'an empty or absolute name';
  const parts = n.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'an empty, . or .. part';
  if (parts.some((p) => p.startsWith('._'))) return 'an AppleDouble name';
  if (n === 'app' || parts[0] === 'tauri-cli') return null;
  if (parts[0] === 'app' && parts[1] === `${PRODUCT}.app`) return null;
  return `not a part of the build (app/${PRODUCT}.app, tauri-cli)`;
}

/**
 * Why a member of the build job's archive is refused for its type (null: fine), its name accepted already: `app`,
 * `app/Retake.app` and `tauri-cli` are folders; under `tauri-cli` files and folders only; under the app files, folders
 * and symbolic links whose target is relative and stays inside the app. Never a hard link, a device or a fifo.
 */
export function buildMemberTypeProblem({ name, type, link }) {
  const n = String(name).replace(/\/+$/, '');
  const app = `app/${PRODUCT}.app`;
  if (n === 'app' || n === app || n === 'tauri-cli') return type === 'dir' ? null : `a ${type}, not a folder`;
  if (type === 'file' || type === 'dir') return null;
  if (type !== 'link' || !n.startsWith(`${app}/`)) return `a ${type} (only files, folders${n.startsWith(`${app}/`) ? ' and links inside the app' : ''})`;
  if (!link || link.startsWith('/')) return `a link to an absolute path (${JSON.stringify(link)})`;
  const to = posix.normalize(posix.join(posix.dirname(n), link));
  return to === app || to.startsWith(`${app}/`) ? null : `a link out of ${PRODUCT}.app (${JSON.stringify(link)})`;
}

/**
 * The members of an uncompressed POSIX tar archive (ustar headers, pax extended headers: path, linkpath, size), as
 * `{ name, type, link, size }` — type 'file', 'dir', 'link', 'hardlink', 'device' or 'fifo'. Read strictly, so tar
 * walks the archive exactly as this does: every header's checksum and ustar magic, octal fields, a size of 0 for
 * anything but a file, the end marker followed by zeros only; refused: GNU long names, global or sparse pax headers,
 * another character set, any other type. StageError otherwise.
 */
export function tarMembers(buf) {
  const members = [];
  const fail = (at, why) => {
    throw new StageError(`not the build job's archive: ${why} (at byte ${at})`);
  };
  const text = (h, off, len) => {
    const b = h.subarray(off, off + len);
    const z = b.indexOf(0);
    return (z < 0 ? b : b.subarray(0, z)).toString('utf8');
  };
  const octal = (at, h, off, len, what) => {
    const m = /^ *([0-7]+)[ \0]*$/.exec(h.subarray(off, off + len).toString('latin1'));
    if (!m) fail(at, `a header whose ${what} is not an octal number`);
    return parseInt(m[1], 8);
  };
  const types = { 0: 'file', '\0': 'file', 5: 'dir', 2: 'link', 1: 'hardlink', 3: 'device', 4: 'device', 6: 'fifo' };
  let pax = null;
  let at = 0;
  for (;;) {
    if (at + 512 > buf.length) fail(at, 'no end marker');
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) {
      if (pax) fail(at, 'a pax header with no member');
      if (buf.subarray(at).some((b) => b !== 0)) fail(at, 'data after the end marker');
      return members;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (octal(at, h, 148, 8, 'checksum') !== sum) fail(at, 'a damaged header (its checksum)');
    // The magic "ustar" and a NUL, then the version "00" (what bsdtar writes; GNU tar's old format is refused).
    if (h.subarray(257, 265).toString('latin1') !== 'ustar\u0000' + '00') fail(at, 'a header that is not POSIX ustar');
    const flag = String.fromCharCode(h[156]);
    let size = octal(at, h, 124, 12, 'size');
    const data = at + 512;
    if (data + size > buf.length) fail(at, 'a member longer than the archive');
    const next = data + Math.ceil(size / 512) * 512;
    if (flag === 'x') {
      if (pax) fail(at, 'two pax headers in a row');
      pax = {};
      const b = buf.subarray(data, data + size);
      for (let i = 0; i < b.length; ) {
        const sp = b.indexOf(0x20, i);
        const len = sp > i ? b.subarray(i, sp).toString('latin1') : '';
        if (!/^[1-9]\d{0,8}$/.test(len) || i + Number(len) > b.length || b[i + Number(len) - 1] !== 0x0a) fail(at, 'a damaged pax header');
        const record = b.subarray(sp + 1, i + Number(len) - 1).toString('utf8');
        const eq = record.indexOf('=');
        if (eq < 1) fail(at, 'a damaged pax header');
        const key = record.slice(0, eq);
        if (/sparse|realsize|charset/i.test(key)) fail(at, `a pax ${key} record`);
        pax[key] = record.slice(eq + 1);
        i += Number(len);
      }
      if (pax.size !== undefined && !/^\d{1,15}$/.test(pax.size)) fail(at, 'a pax size that is not a number');
      at = next;
      continue;
    }
    const type = Object.hasOwn(types, flag) ? types[flag] : null;
    if (!type) fail(at, `a member of type ${JSON.stringify(flag)} (only files, folders and links)`);
    const prefix = text(h, 345, 155);
    let name = prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100);
    let link = text(h, 157, 100);
    if (pax) {
      if (pax.path !== undefined) name = pax.path;
      if (pax.linkpath !== undefined) link = pax.linkpath;
      if (pax.size !== undefined) size = Number(pax.size);
      pax = null;
    }
    if (name.includes('\0') || link.includes('\0')) fail(at, 'a name with a NUL');
    if (type !== 'file' && size !== 0) fail(at, `a ${type} with data (${name})`);
    const end = data + Math.ceil(size / 512) * 512;
    if (data + size > buf.length) fail(at, 'a member longer than the archive');
    members.push({ name, type, link: type === 'link' || type === 'hardlink' ? link : null, size });
    at = end;
  }
}

/**
 * The build job's archive (`/usr/bin/tar -czf … app tauri-cli`) into `into` (absent or empty): decompressed here and
 * its members read (`tarMembers`) — any name `buildMemberProblem` refuses, any type `buildMemberTypeProblem` refuses,
 * a name twice, or a part missing refuses the whole archive before anything is written —, then only app/Retake.app
 * and tauri-cli extracted by tar from those very bytes (no extended attribute, ACL, file flag or Mac metadata), then
 * checked: `into` holds exactly those two, `app` exactly Retake.app, each a real folder (no link), and every link in
 * the app resolves inside it. A refusal leaves nothing of the archive behind. Returns the parts' paths.
 */
export function unpackBuild(archive, into, { tar = '/usr/bin/tar', env = { PATH: '/usr/bin:/bin' } } = {}) {
  const dest = resolve(into);
  const at = lstatSync(dest, { throwIfNoEntry: false });
  if (at && (!at.isDirectory() || readdirSync(dest).length)) throw new StageError(`--into ${dest}: an empty folder of its own`);
  let bytes;
  try {
    bytes = gunzipSync(readFileSync(archive));
  } catch (e) {
    throw new StageError(`${archive}: not a readable archive (${e.code ?? e.message})`);
  }
  let members;
  try {
    members = tarMembers(bytes);
  } catch (e) {
    throw e instanceof StageError ? new StageError(`${archive} is ${e.message} — nothing was unpacked`) : e;
  }
  const seen = new Set();
  const refused = [];
  for (const m of members) {
    const plain = m.name.replace(/\/+$/, '');
    const problem = buildMemberProblem(m.name) ?? buildMemberTypeProblem(m) ?? (seen.has(plain) ? 'a name given twice' : null);
    seen.add(plain);
    if (problem) refused.push([m.name, problem]);
  }
  if (refused.length) throw new StageError(`${archive} is not the build job's archive: ${refused.slice(0, 3).map(([n, p]) => `${JSON.stringify(n)} (${p})`).join(', ')}${refused.length > 3 ? ` (+${refused.length - 3})` : ''} — nothing was unpacked`);
  const want = [`app/${PRODUCT}.app`, 'tauri-cli'];
  for (const w of want) if (!seen.has(w)) throw new StageError(`${archive} holds no ${w} — nothing was unpacked`);
  mkdirSync(dest, { recursive: true });
  try {
    const x = spawnSync(tar, ['-x', '-f', '-', '--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags', '-C', dest, ...want], { input: bytes, encoding: 'utf8', env, maxBuffer: 1 << 24 });
    if (x.status !== 0) throw new StageError(`${archive}: tar could not unpack it (${(x.stderr || x.error?.message || '').trim().split('\n').slice(-1)[0]})`);
    const top = readdirSync(dest).sort();
    if (JSON.stringify(top) !== JSON.stringify(BUILD_PARTS)) throw new StageError(`${dest} holds ${top.join(', ') || 'nothing'} once unpacked, not ${BUILD_PARTS.join(', ')}`);
    const kind = (rel) => {
      const st = lstatSync(join(dest, rel));
      return st.isSymbolicLink() ? 'a link' : st.isDirectory() ? 'folder' : 'not a folder';
    };
    for (const rel of ['app', 'tauri-cli', `app/${PRODUCT}.app`]) {
      if (rel === `app/${PRODUCT}.app` && JSON.stringify(readdirSync(join(dest, 'app'))) !== JSON.stringify([`${PRODUCT}.app`])) throw new StageError(`${join(dest, 'app')} holds ${readdirSync(join(dest, 'app')).join(', ')}, not ${PRODUCT}.app alone`);
      const got = kind(rel);
      if (got !== 'folder') throw new StageError(`${join(dest, rel)} is ${got}, not a real folder`);
    }
    // The system's realpath (realpathSync.native): Node.js's own resolves a link's `..` against the link's name.
    const app = realpathSync.native(join(dest, 'app', `${PRODUCT}.app`));
    for (const p of walk(app)) {
      if (!lstatSync(p).isSymbolicLink()) continue;
      const to = readlinkSync(p);
      const real = (() => {
        try {
          return realpathSync.native(p);
        } catch {
          return null;
        }
      })();
      const inside = (q) => q === app || q.startsWith(`${app}${sep}`);
      if (isAbsolute(to) || !inside(resolve(dirname(p), to)) || (real && !inside(real))) throw new StageError(`${relative(dest, p)} links out of ${PRODUCT}.app (${to})`);
    }
    return { app: join(dest, 'app', `${PRODUCT}.app`), tauriCli: join(dest, 'tauri-cli') };
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

/** A JSON file of the app, parsed — its words never repeated in a refusal (a file handed over may hold anything). */
function readJson(file, app) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new StageError(`${app}: no Contents/Resources/${basename(file)} — not an app bundle.mjs laid out`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StageError(`${app}: Contents/Resources/${basename(file)} is not JSON — nothing was signed`);
  }
}

/**
 * Finish an app laid out and signed ad hoc (see the module comment). `mode`: 'dry' or 'release'; `tauriCli`: the
 * folder of the pinned Tauri CLI (`bundle.mjs build` lays it out; needed only to sign an update archive) — checked
 * against `tauriPins` before anything is signed, then run from a fresh copy (`freshTauriCli`, under `tmp`) made right
 * before the update archive is signed and removed right after, whatever happens; `pubkey`: the key the archive's
 * signature is checked with (default RETAKE_UPDATE_PUBKEY; bundle.mjs passes the overlay's); `verified`: the ad hoc
 * app was checked a moment ago (bundle.mjs) — not again; `say(step, message)`: progress and timings; `retry`:
 * hdiutil's retry options (tests'). Returns `{ mode, app, dmg, version, update }`.
 */
export function finishApp({ app, out, mode = 'dry', env = process.env, tauriCli = null, tauriPins = TAURI_CLI_PINS, tmp = tmpdir(), pubkey, appVersion, entries = readTable(), dmg: makeDmg = true, verified = false, say = () => {}, retry = {} }) {
  const child = buildEnv(env);
  // A release is refused here, before anything is touched, without the whole APPLE_* set.
  const s = signer(mode, env, child);
  useBuildEnv(child);
  const res = join(app, 'Contents', 'Resources');
  const manifest = readJson(join(res, 'bundle.json'), app);
  const updates = readJson(join(res, 'launch.json'), app).updates === 'on';
  // bundle.json's paths (its hashes are refreshed from them) stay inside Resources.
  manifestPath(res, manifest, 'node');
  if (manifest.paths?.ffmpeg !== null) manifestPath(res, manifest, 'ffmpeg');
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
  if (updates && key && !tauriCli) throw new StageError('the update archive is signed by the pinned Tauri CLI: give its folder (--tauri-cli, the one bundle.mjs build wrote) — nothing was signed');
  if (updates && key) checkTauriCliDir(tauriCli, tauriPins);
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
    let sig = null;
    if (key) {
      // The CLI runs from a fresh copy of its checked bytes, never from the folder it was handed, and only now.
      const fresh = freshTauriCli(tauriCli, tauriPins, tmp);
      try {
        sig = signUpdateArchive({ cliJs: fresh.cliJs, cliRoot: fresh.root, archive, version, pubkey: pub, env });
      } finally {
        rmSync(fresh.root, { recursive: true, force: true });
      }
    }
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

/**
 * `release.mjs sign <flags>` (`parseSignArgs`): refused before anything is claimed, checked or run without the whole
 * APPLE_* set (a release) or with a `--tauri-cli` folder that is not the pinned CLI; then `--out` claimed and
 * `finishApp` — the CLI copied fresh under `tmp` only to sign the update archive. Writes and returns the report.
 * `pins`, `tmp` and `finish` (finishApp's test-only options: `entries`, `verified`, `dmg`) are tests' only.
 */
export function signCommand(argv, { env = process.env, pins = TAURI_CLI_PINS, tmp = tmpdir(), finish = {}, log = (m) => process.stderr.write(m) } = {}) {
  const args = parseSignArgs(argv);
  // A release without the whole APPLE_* set is refused before anything is claimed, checked or run.
  signer(args.release ? 'release' : 'dry', env, {});
  const app = resolve(args.app);
  if (!existsSync(join(app, 'Contents')) || !app.endsWith('.app')) throw new StageError(`--app ${app}: an app bundle (…/${PRODUCT}.app)`);
  if (args.tauriCli) checkTauriCliDir(args.tauriCli, pins);
  const out = claimReleaseOut(args.out, app, env);
  const t0 = Date.now();
  const timings = {};
  let last = t0;
  const say = (step, m) => {
    timings[step] = Date.now() - last;
    last = Date.now();
    log(`release: ${m} (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
  };
  const r = finishApp({ ...finish, app, out, mode: args.release ? 'release' : 'dry', env, tauriCli: args.tauriCli ?? null, tauriPins: pins, tmp, appVersion: args.appVersion, say });
  const report = { ...r, dmg: r.dmg && relative(out, r.dmg), update: r.update && { ...r.update, archive: relative(out, r.update.archive), signature: r.update.signature && relative(out, r.update.signature) }, timings_ms: { ...timings, total: Date.now() - t0 } };
  if (r.mode === 'dry') log('release: an ad hoc build — not signed with a Developer ID, not notarised (no --release)\n');
  writeFileSync(join(out, 'release-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'unpack') {
      if (rest.length !== 3 || rest[1] !== '--into' || rest[0].startsWith('--')) throw new StageError('usage: release.mjs unpack <archive> --into <dir>');
      const parts = unpackBuild(rest[0], rest[2]);
      process.stdout.write(`${JSON.stringify(parts, null, 1)}\n`);
    } else if (command === 'sign') {
      process.stdout.write(`${JSON.stringify(signCommand(rest), null, 1)}\n`);
    } else {
      throw new StageError(`usage: release.mjs sign --app <dir>/${PRODUCT}.app --out <dir> [--release] [--app-version <version>] [--tauri-cli <dir>] | unpack <archive> --into <dir>`);
    }
  } catch (e) {
    process.stderr.write(`release: ${e instanceof StageError || e instanceof SignError ? e.message : e?.stack ?? e}\n`);
    process.exitCode = 1;
  }
}
