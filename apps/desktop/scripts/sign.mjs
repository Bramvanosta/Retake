/**
 * Signing of the bundled app (L5.16, DESIGN §4p) — used by `bundle.mjs build` (`pnpm desktop:bundle`). We sign, Tauri
 * only lays the app out (critique M1: `tauri build` runs with no secret in its environment):
 *
 * - the payload (the stage, before Tauri copies it into Contents/Resources), inside-out — files before the bundle that
 *   holds them, helpers before the framework, the framework before Chromium.app — after a walk that fails on any Mach-O
 *   (thin or FAT, by its magic) that apps/desktop/bundle/sign-table.json does not name;
 * - then the shell (Contents/MacOS) and the outer app, which seals Resources (launch.json, the launcher, the engine's
 *   JavaScript);
 * - every Mach-O with the hardened runtime. Entitlements per the table (apps/desktop/bundle/entitlements/*.plist): the
 *   release set; the dry (ad hoc) set adds disable-library-validation where the table says ad hoc needs it, nothing
 *   else (`entitlementsFor`).
 *
 * Dry mode (the default of `pnpm desktop:bundle`): ad hoc (`-s -`, `--timestamp=none`). The release path
 * (`pnpm desktop:release`: a Developer ID identity, notarisation, stapling) is `releaseConfig` + `notarizeApp` /
 * `notarizeDmg` + `verifyRelease`: `signer('release', env)` refuses before anything runs unless the whole APPLE_* set is
 * there — the person's own run (MACOS-CHECKLIST 15b). Tests run it against recording stand-ins of codesign / xcrun /
 * ditto / spctl only. No credential is ever on a command line or in a child's environment: notarytool reads a keychain
 * profile (stored once by the person: `xcrun notarytool store-credentials`) or an App Store Connect API key file; a
 * failure's text redacts every credential flag's value (`redactArgs`). Nothing here touches a keychain itself.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machOKind, walk } from './bundle.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TABLE_FILE = join(APP_DIR, 'bundle', 'sign-table.json');
export const ENTITLEMENTS_DIR = join(APP_DIR, 'bundle', 'entitlements');
export const DLV = 'com.apple.security.cs.disable-library-validation';
const GET_TASK_ALLOW = 'com.apple.security.get-task-allow';

export class SignError extends Error {}

/** The signing table (sign-table.json): its entries, checked for shape. */
export function readTable(file = TABLE_FILE) {
  const t = JSON.parse(readFileSync(file, 'utf8'));
  if (t.v !== 1 || !Array.isArray(t.entries)) throw new SignError(`${file}: v 1 with entries expected`);
  const ids = new Set();
  for (const e of t.entries) {
    if (typeof e.id !== 'string' || ids.has(e.id)) throw new SignError(`${file}: entry id ${e.id} missing or twice`);
    ids.add(e.id);
    if (!['file', 'bundle'].includes(e.kind)) throw new SignError(`${file}: ${e.id}: kind is file or bundle`);
    if (typeof e.path !== 'string' || !e.path || e.path.startsWith('/') || e.path.split('/').includes('..')) throw new SignError(`${file}: ${e.id}: path must be relative, inside the payload`);
    if (e.entitlements !== null && !/^[a-z0-9-]+$/.test(e.entitlements ?? '')) throw new SignError(`${file}: ${e.id}: entitlements is a plist name or null`);
    if (typeof e.dryDLV !== 'boolean') throw new SignError(`${file}: ${e.id}: dryDLV is true or false`);
  }
  return t.entries;
}

/** The keys set true in an entitlements plist (XML, as codesign writes and our plists are). */
export function entitlementKeys(xml) {
  return [...String(xml).matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g)].map((m) => m[1]).sort();
}

/** An entry's entitlements: the release set (its plist), or the dry set — the release set plus DLV when `dryDLV`. */
export function entitlementsFor(entry, mode, dir = ENTITLEMENTS_DIR) {
  const release = entry.entitlements ? entitlementKeys(readFileSync(join(dir, `${entry.entitlements}.plist`), 'utf8')) : [];
  if (mode === 'release' || !entry.dryDLV || release.includes(DLV)) return release;
  return [...release, DLV].sort();
}

/** A plist of `keys` (all true). */
export function entitlementsPlist(keys) {
  const body = keys.map((k) => `\t<key>${k}</key>\n\t<true/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}${body ? '\n' : ''}</dict>\n</plist>\n`;
}

/** A table path as a regular expression on payload-relative paths (`*`: any run of characters but `/`). */
export function pathPattern(glob) {
  return new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
}

const segments = (p) => p.split('/').length;
const toSlash = (p) => p.split(sep).join('/');

/** Whether `inner` is `outer` or inside it (payload-relative paths). */
const inside = (inner, outer) => inner === outer || inner.startsWith(`${outer}/`);

/** The Mach-O a bundle entry covers itself: an app's Contents/MacOS/* files, a framework's Versions/<v>/<Name>. */
function bundleMain(bundle, file) {
  if (!file.startsWith(`${bundle}/`)) return false;
  const rest = file.slice(bundle.length + 1).split('/');
  if (bundle.endsWith('.app')) return rest.length === 3 && rest[0] === 'Contents' && rest[1] === 'MacOS';
  if (bundle.endsWith('.framework')) return rest.length === 3 && rest[0] === 'Versions' && rest[2] === bundle.slice(bundle.lastIndexOf('/') + 1, -'.framework'.length);
  return false;
}

/**
 * What signing `root` (the payload) means, without signing: `{ items, machO, problems }`. `items` — what codesign is
 * run on, inside-out (deepest first), each with its entry — and `machO`, every Mach-O file of the payload with the
 * entry that covers it. `problems`: a Mach-O no entry covers (or two do), an entry (not optional) that matches
 * nothing, a bundle entry that is no bundle folder. Links are never followed (Chromium's framework links).
 */
export function signPlan(root, entries = readTable()) {
  const problems = [];
  const files = [];
  const dirs = [];
  for (const abs of walk(root)) {
    const st = lstatSync(abs);
    const rel = toSlash(relative(root, abs));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) dirs.push(rel);
    else if (st.isFile() && st.size >= 8 && machOKind(abs)) files.push({ path: rel, kind: machOKind(abs) });
  }
  const items = [];
  const matched = new Map(entries.map((e) => [e.id, 0]));
  for (const e of entries) {
    const re = pathPattern(e.path);
    const pool = e.kind === 'bundle' ? dirs : files.map((f) => f.path);
    for (const p of pool.filter((x) => re.test(x))) {
      if (e.kind === 'bundle' && !/\.(app|framework)$/.test(p)) problems.push(`${p}: ${e.id} names a bundle (.app / .framework)`);
      items.push({ path: p, entry: e });
      matched.set(e.id, matched.get(e.id) + 1);
    }
  }
  for (const e of entries) if (!e.optional && matched.get(e.id) === 0) problems.push(`sign-table entry ${e.id} (${e.path}) matches nothing in the payload`);
  const machO = [];
  for (const f of files) {
    const by = items.filter((i) => (i.entry.kind === 'file' ? i.path === f.path : bundleMain(i.path, f.path)));
    if (by.length === 0) problems.push(`${f.path}: a Mach-O (${f.kind}) the signing table does not name — add it to apps/desktop/bundle/sign-table.json on purpose`);
    else if (by.length > 1) problems.push(`${f.path}: named by ${by.map((i) => i.entry.id).join(' and ')}`);
    machO.push({ ...f, entry: by[0]?.entry ?? null });
  }
  // Inside-out: a path inside another is longer than it — deepest first, then by path for a stable order.
  items.sort((a, b) => segments(b.path) - segments(a.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { items, machO, problems };
}

/** Whether `items` is inside-out: nothing is signed before something inside it. */
export function insideOut(items) {
  return items.every((a, i) => items.slice(i + 1).every((b) => !inside(b.path, a.path) || b.path === a.path));
}

/** notarytool's flags whose value names a credential or an account (the long forms: the only ones used): never printed. */
export const SECRET_FLAGS = new Set(['--password', '--apple-id', '--team-id', '--key', '--key-id', '--issuer', '--keychain-profile', '--keychain']);

/** `args` as a failure may print them: the value after (or `=` of) every SECRET_FLAGS flag replaced by `<redacted>`. */
export function redactArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const eq = a.indexOf('=');
    if (a.startsWith('-') && eq > 0 && SECRET_FLAGS.has(a.slice(0, eq))) out.push(`${a.slice(0, eq)}=<redacted>`);
    else if (SECRET_FLAGS.has(a) && i + 1 < args.length) out.push(a, '<redacted>'), i++;
    else out.push(a);
  }
  return out;
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new SignError(`${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0) throw new SignError(`${cmd} ${redactArgs(args).join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' | ')}`);
  return { stdout: r.stdout, stderr: r.stderr };
}

/**
 * The release credentials from the environment: the identity (`Developer ID Application: <name> (<TEAM>)`),
 * APPLE_TEAM_ID (the same team), and how notarytool authenticates — APPLE_KEYCHAIN_PROFILE (a profile the person stored
 * once with `xcrun notarytool store-credentials`), or an App Store Connect API key: APPLE_API_KEY (its id) +
 * APPLE_API_ISSUER + APPLE_API_KEY_PATH (the .p8 file). An Apple ID's app-specific password is not taken: notarytool
 * only reads it from its command line, where any local process sees it (`ps`) — store it in a keychain profile instead.
 * An empty variable counts as absent. Throws, naming what is missing, before anything runs.
 */
export function releaseConfig(env = process.env) {
  const v = (k) => (typeof env[k] === 'string' && env[k].trim() ? env[k].trim() : null);
  const missing = ['APPLE_SIGNING_IDENTITY', 'APPLE_TEAM_ID'].filter((k) => !v(k));
  const byProfile = v('APPLE_KEYCHAIN_PROFILE');
  const byKey = v('APPLE_API_KEY') && v('APPLE_API_ISSUER') && v('APPLE_API_KEY_PATH');
  if (!byProfile && !byKey) {
    const password = v('APPLE_PASSWORD') ? ' (APPLE_PASSWORD is not used: notarytool would show it to every process on its command line — store it once with xcrun notarytool store-credentials <profile> and set APPLE_KEYCHAIN_PROFILE)' : '';
    missing.push(`APPLE_KEYCHAIN_PROFILE (or APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH)${password}`);
  }
  if (missing.length) throw new SignError(`a release build signs with your Developer ID and notarises: set ${missing.join(', ')} — nothing was signed`);
  const m = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(v('APPLE_SIGNING_IDENTITY'));
  if (!m) throw new SignError('APPLE_SIGNING_IDENTITY must be "Developer ID Application: <name> (<TEAM ID>)" — nothing was signed');
  if (m[1] !== v('APPLE_TEAM_ID')) throw new SignError(`APPLE_SIGNING_IDENTITY's team (${m[1]}) is not APPLE_TEAM_ID — nothing was signed`);
  return {
    identity: v('APPLE_SIGNING_IDENTITY'),
    team: v('APPLE_TEAM_ID'),
    notary: byProfile ? { profile: byProfile } : { key: v('APPLE_API_KEY'), issuer: v('APPLE_API_ISSUER'), keyPath: v('APPLE_API_KEY_PATH') },
  };
}

/**
 * Who signs: `dry` — ad hoc, no timestamp; `release` — the identity of `releaseConfig(env)` (which refuses first),
 * with a secure timestamp. `childEnv` is the environment of every codesign / xcrun / ditto / spctl run (the build's
 * allow-listed one: bundle.mjs buildEnv — no APPLE_* variable in it).
 */
export function signer(mode, env = process.env, childEnv = env) {
  if (mode === 'dry') return { mode, identity: '-', timestamp: false, env: childEnv };
  if (mode === 'release') return { mode, ...releaseConfig(env), timestamp: true, env: childEnv };
  throw new SignError(`signing mode is dry or release, not ${mode}`);
}

/** codesign's arguments for one path. */
export function codesignArgs(s, path, entitlementsFile) {
  return ['--force', '--options', 'runtime', s.timestamp ? '--timestamp' : '--timestamp=none', '-s', s.identity, ...(entitlementsFile ? ['--entitlements', entitlementsFile] : []), path];
}

/**
 * Sign the payload `root` per the plan (refused when the plan has problems). Entitlement plists of the mode are
 * written to `work` first (the release set as committed, the dry set with DLV added). Returns the plan.
 */
export function signPayload(root, s, { entries = readTable(), work, entitlementsDir = ENTITLEMENTS_DIR } = {}) {
  const plan = signPlan(root, entries);
  if (plan.problems.length) throw new SignError(`the payload cannot be signed:\n  ${plan.problems.join('\n  ')}`);
  mkdirSync(work, { recursive: true });
  const plists = new Map();
  for (const e of entries) {
    const keys = entitlementsFor(e, s.mode, entitlementsDir);
    if (!keys.length) continue;
    const file = join(work, `${e.id}.${s.mode}.plist`);
    writeFileSync(file, entitlementsPlist(keys));
    plists.set(e.id, file);
  }
  for (const it of plan.items) run('codesign', codesignArgs(s, join(root, it.path), plists.get(it.entry.id)), s.env);
  return plan;
}

/** Sign what Tauri laid out around the payload: the shell (Contents/MacOS/*), then the outer app — no entitlements. */
export function signApp(app, s) {
  const macos = join(app, 'Contents', 'MacOS');
  for (const f of readdirSync(macos)) run('codesign', codesignArgs(s, join(macos, f)), s.env);
  run('codesign', codesignArgs(s, app), s.env);
}

/** The keys set true in what `path` is signed with (empty when none). */
export function signedEntitlements(path, env = process.env) {
  const r = spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', path], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new SignError(`codesign -d ${path}: ${(r.stderr || '').trim()}`);
  return entitlementKeys(r.stdout);
}

/** codesign -dv's `flags=0x…(adhoc,runtime)` words for `path`. */
export function signatureFlags(path, env = process.env) {
  const r = spawnSync('codesign', ['-dv', '--verbose=2', path], { encoding: 'utf8', env });
  const m = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(`${r.stderr}${r.stdout}`);
  return m ? m[1].split(',') : [];
}

/**
 * The checks of a signed app (`app`, its payload in Contents/Resources): `codesign --verify --deep --strict`; every
 * Mach-O of the whole app carries the hardened runtime and no get-task-allow; each table entry's entitlements read back
 * equal `entitlementsFor(entry, mode)`; the shell and the outer app have none. Returns the problems (none: []).
 */
export function verifyApp(app, mode, { entries = readTable(), env = process.env, entitlementsDir = ENTITLEMENTS_DIR } = {}) {
  const problems = [];
  const v = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { encoding: 'utf8', env });
  if (v.status !== 0) problems.push(`codesign --verify --deep --strict: ${(v.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
  const res = join(app, 'Contents', 'Resources');
  const plan = signPlan(res, entries);
  problems.push(...plan.problems);
  for (const it of plan.items) {
    const want = entitlementsFor(it.entry, mode, entitlementsDir);
    const got = signedEntitlements(join(res, it.path), env);
    if (got.join(' ') !== want.join(' ')) problems.push(`${it.path}: entitlements ${JSON.stringify(got)}, the table says ${JSON.stringify(want)}`);
  }
  for (const f of [...readdirSync(join(app, 'Contents', 'MacOS')).map((n) => join(app, 'Contents', 'MacOS', n)), app]) {
    const got = signedEntitlements(f, env);
    if (got.length) problems.push(`${relative(dirname(app), f)}: entitlements ${JSON.stringify(got)}, none expected`);
  }
  for (const abs of walk(app)) {
    const st = lstatSync(abs);
    if (!st.isFile() || st.size < 8 || !machOKind(abs)) continue;
    const flags = signatureFlags(abs, env);
    if (!flags.includes('runtime')) problems.push(`${relative(dirname(app), abs)}: no hardened runtime (flags ${flags.join(',') || 'none'})`);
    if (signedEntitlements(abs, env).includes(GET_TASK_ALLOW)) problems.push(`${relative(dirname(app), abs)}: get-task-allow`);
  }
  return problems;
}

/**
 * xcrun notarytool's arguments for `file` — a .zip or a .dmg (notarytool takes no app folder: `notarizeApp` zips it) —
 * with the credentials of `releaseConfig`: a keychain profile's name, or the API key's file, id and issuer. Never a
 * password.
 */
export function notarizeArgs(s, file) {
  if (!/\.(zip|dmg)$/.test(file)) throw new SignError(`notarytool submits a .zip or a .dmg, not ${file}`);
  const n = s.notary;
  const creds = n.profile ? ['--keychain-profile', n.profile] : ['--key', n.keyPath, '--key-id', n.key, '--issuer', n.issuer];
  return ['notarytool', 'submit', file, '--wait', ...creds];
}

/**
 * Notarise the signed app (release only, the person's run): a zip of it (`ditto -c -k --keepParent`, in `work`)
 * submitted and waited for, then the ticket stapled to the app itself; the zip removed.
 */
export function notarizeApp(s, app, work) {
  if (s.mode !== 'release') throw new SignError('notarisation is the release run only');
  mkdirSync(work, { recursive: true });
  const zip = join(work, `${app.slice(app.lastIndexOf(sep) + 1).replace(/\.app$/, '')}-notarize.zip`);
  rmSync(zip, { force: true });
  run('ditto', ['-c', '-k', '--keepParent', app, zip], s.env);
  try {
    run('xcrun', notarizeArgs(s, zip), s.env);
  } finally {
    rmSync(zip, { force: true });
  }
  run('xcrun', ['stapler', 'staple', app], s.env);
}

/** Notarise then staple the signed DMG (release only). */
export function notarizeDmg(s, dmg) {
  if (s.mode !== 'release') throw new SignError('notarisation is the release run only');
  run('xcrun', notarizeArgs(s, dmg), s.env);
  run('xcrun', ['stapler', 'staple', dmg], s.env);
}

/** codesign -dv's TeamIdentifier for `path` (null: none — ad hoc). */
export function teamOf(path, env = process.env) {
  const r = spawnSync('codesign', ['-dv', '--verbose=2', path], { encoding: 'utf8', env });
  const m = /^TeamIdentifier=(.+)$/m.exec(`${r.stderr}${r.stdout}`);
  return m && m[1] !== 'not set' ? m[1].trim() : null;
}

/**
 * The checks of a release (after stapling): every Mach-O of the app and the app itself signed by APPLE_TEAM_ID's team,
 * none ad hoc; Gatekeeper accepts the app (`spctl -a -vv -t exec`) and the DMG (`spctl -a -t open --context
 * context:primary-signature`); both tickets validate (`stapler validate`). Returns the problems (none: []).
 */
export function verifyRelease(app, dmg, s) {
  if (s.mode !== 'release') throw new SignError('the release checks are the release run only');
  const problems = [];
  const signed = [app, ...walk(app).filter((p) => {
    const st = lstatSync(p);
    return st.isFile() && st.size >= 8 && machOKind(p);
  })];
  for (const f of signed) {
    const team = teamOf(f, s.env);
    if (team !== s.team) problems.push(`${relative(dirname(app), f)}: signed by team ${team ?? 'none'}, not ${s.team}`);
    if (signatureFlags(f, s.env).includes('adhoc')) problems.push(`${relative(dirname(app), f)}: an ad hoc signature`);
  }
  for (const [cmd, args] of [
    ['spctl', ['-a', '-vv', '-t', 'exec', app]],
    ['xcrun', ['stapler', 'validate', app]],
    ['spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', dmg]],
    ['xcrun', ['stapler', 'validate', dmg]],
  ]) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env: s.env });
    if (r.status !== 0) problems.push(`${cmd} ${args.slice(0, -1).join(' ')} ${relative(dirname(app), args[args.length - 1])}: ${(r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').slice(-2).join(' | ')}`);
  }
  return problems;
}

/** Sign a DMG (release only: an ad hoc DMG carries no signature). */
export function signDmg(s, dmg) {
  if (s.mode !== 'release') return;
  run('codesign', ['--force', '--timestamp', '-s', s.identity, dmg], s.env);
}
