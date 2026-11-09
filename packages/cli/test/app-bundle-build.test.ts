/**
 * L5.16b — the bundled app's build, its rules without building (fast; the gated build + acceptance is
 * app-bundle-acceptance.test.ts): the generated Tauri overlay (tauri.conf.json keeps no bundle section), the signing
 * table, its walk and its entitlement sets (dry = release + disable-library-validation only), ad hoc signing and the
 * app's verification on a mini app, one allow-listed environment for every child of the build, the release path
 * (refusals first, notarisation of a zip then stapling, no credential on a command line or in a failure's text, the
 * team / Gatekeeper / ticket checks), the folders a build may write, launch.json version 2, the launcher script (code
 * loaders dropped, found through links, the module lookup guard), the module lookup guard itself (no module from a
 * node_modules folder above the app), the DMG commands and checks, the app's checks beyond its signatures, the Tauri CLI
 * rebuilt from the pnpm store (pinned sha512), the manifest's hashes, the generated folder of the checkout.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const APP = join(REPO, 'apps', 'desktop');
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'retake-app-bundle-build-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const MAC = process.platform === 'darwin';

/* eslint-disable @typescript-eslint/no-explicit-any */
const bundleModule = async () => (await import(pathToFileURL(join(APP, 'scripts', 'bundle.mjs')).href)) as any;
const signModule = async () => (await import(pathToFileURL(join(APP, 'scripts', 'sign.mjs')).href)) as any;

const THIN = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1, 0, 0, 0, 0]);
const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2, 0, 0, 0, 0]);
let n = 0;
const dir = (name: string) => {
  const d = join(tmp, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const put = (root: string, rel: string, data: string | Buffer = '', mode = 0o644) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), data);
  chmodSync(join(root, rel), mode);
};

const CHR = 'browsers/chromium-1194/chrome-mac/Chromium.app';
const FW = `${CHR}/Contents/Frameworks/Chromium Framework.framework`;
const V = `${FW}/Versions/141.0.7390.37`;
const HS = 'browsers/chromium_headless_shell-1194/chrome-mac';
const COMP = 'engine/node_modules/@remotion/compositor-darwin-arm64';

/** A payload laid out as the real stage is, every native file a few bytes of Mach-O magic (one FAT). */
function fakePayload(): string {
  const root = dir('payload');
  const macho = (rel: string, data = THIN) => put(root, rel, data, 0o755);
  macho('node/bin/node', FAT);
  macho('ffmpeg/bin/ffmpeg');
  macho('ffmpeg/bin/ffprobe');
  macho('engine/node_modules/esbuild/bin/esbuild');
  macho('engine/node_modules/@esbuild/darwin-arm64/bin/esbuild');
  macho('engine/node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node');
  macho('engine/node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.17.3.dylib');
  macho('engine/node_modules/@rspack/binding-darwin-arm64/rspack.darwin-arm64.node');
  for (const f of ['libavcodec.dylib', 'libavutil.dylib', 'remotion', 'ffmpeg', 'ffprobe']) macho(`${COMP}/${f}`);
  put(root, `${COMP}/package.json`, '{}');
  put(root, 'engine/dist/bin.js', '#!/usr/bin/env node\n');
  for (const f of ['libEGL.dylib', 'libGLESv2.dylib']) macho(`${V}/Libraries/${f}`);
  for (const f of ['chrome_crashpad_handler', 'app_mode_loader', 'web_app_shortcut_copier']) macho(`${V}/Helpers/${f}`);
  for (const h of ['Chromium Helper', 'Chromium Helper (Renderer)', 'Chromium Helper (GPU)', 'Chromium Helper (Plugin)', 'Chromium Helper (Alerts)']) {
    macho(`${V}/Helpers/${h}.app/Contents/MacOS/${h}`);
    put(root, `${V}/Helpers/${h}.app/Contents/Info.plist`, '<plist/>');
  }
  macho(`${V}/Chromium Framework`);
  put(root, `${V}/Resources/Info.plist`, '<plist/>');
  for (const [link, to] of [['Versions/Current', '141.0.7390.37'], ['Chromium Framework', 'Versions/Current/Chromium Framework'], ['Resources', 'Versions/Current/Resources'], ['Libraries', 'Versions/Current/Libraries'], ['Helpers', 'Versions/Current/Helpers']]) {
    symlinkSync(to, join(root, FW, link));
  }
  macho(`${CHR}/Contents/MacOS/Chromium`);
  put(root, `${CHR}/Contents/Info.plist`, '<plist/>');
  for (const f of ['headless_shell', 'libEGL.dylib', 'libGLESv2.dylib']) macho(`${HS}/${f}`);
  put(root, `${HS}/resources.pak`, 'not code');
  return root;
}

describe('the Tauri overlay is generated; tauri.conf.json keeps no bundle section (M8)', () => {
  it('the committed config: the bundle off, the png icon only, no plugin — the developer app is unchanged', () => {
    const conf = JSON.parse(readFileSync(join(APP, 'tauri.conf.json'), 'utf8'));
    expect(conf.bundle).toEqual({ active: false, icon: ['icons/icon.png'] });
    expect(conf.plugins).toBeUndefined();
    expect(existsSync(join(APP, 'Info.plist'))).toBe(false);
    expect(existsSync(join(APP, 'tauri.macos.conf.json'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    expect(pkg.scripts['desktop:bundle']).toBe('node apps/desktop/scripts/bundle.mjs build');
    for (const c of ['dev', 'build', 'test', 'clean']) expect(pkg.scripts[`desktop:${c}`]).toBe(`node apps/desktop/scripts/desktop.mjs ${c}`);
    // No new dependency: the Tauri CLI comes from the pnpm store.
    expect(JSON.stringify(pkg)).not.toContain('@tauri-apps');
  });

  it('the overlay: the app only, the payload through macOS.files (never resources), macOS 15, our Info.plist keys; no signing, updater or plugin', async () => {
    const { bundleOverlay, infoPlistExtras, MINIMUM_MACOS, tauriBuildArgs } = await bundleModule();
    const stage = dir('stage');
    for (const d of ['node', 'engine', 'browsers', 'plugin', 'licenses', 'bin']) mkdirSync(join(stage, d));
    for (const f of ['bundle.json', 'launch.json', '.retake-stage']) writeFileSync(join(stage, f), '');
    const o = bundleOverlay({ stage, icon: '/scratch/icon.icns', infoPlist: '/scratch/Info.plist' });
    expect(MINIMUM_MACOS).toBe('15.0');
    expect(Object.keys(o)).toEqual(['bundle']);
    expect(o.bundle.active).toBe(true);
    expect(o.bundle.targets).toEqual(['app']);
    expect(o.bundle.icon).toEqual(['/scratch/icon.icns']);
    expect(o.bundle.resources).toBeUndefined();
    expect(o.bundle.createUpdaterArtifacts).toBeUndefined();
    expect(o.bundle.macOS.minimumSystemVersion).toBe('15.0');
    expect(o.bundle.macOS.hardenedRuntime).toBe(true);
    expect(o.bundle.macOS.infoPlist).toBe('/scratch/Info.plist');
    expect('signingIdentity' in o.bundle.macOS).toBe(false);
    expect(o.bundle.macOS.files).toEqual(Object.fromEntries(['bin', 'browsers', 'bundle.json', 'engine', 'launch.json', 'licenses', 'node', 'plugin'].map((x) => [`Resources/${x}`, join(stage, x)])));
    expect(JSON.stringify(o)).not.toMatch(/dangerous|updater|pubkey|endpoints|signingIdentity|entitlements|"plugins"/i);
    const plist = infoPlistExtras();
    expect(plist).toContain('<key>NSLocalNetworkUsageDescription</key>');
    expect(plist).toContain('<string>public.app-category.developer-tools</string>');
    expect(plist).not.toMatch(/NSCameraUsageDescription|NSMicrophoneUsageDescription|NSAppTransportSecurity/);
    if (MAC) {
      writeFileSync(join(stage, 'x.plist'), plist);
      expect(spawnSync('plutil', ['-lint', join(stage, 'x.plist')]).status).toBe(0);
    }
    expect(tauriBuildArgs('/scratch/o.json', true)).toEqual(['build', '--bundles', 'app', '--no-sign', '--ci', '--config', '/scratch/o.json', '--', '--locked', '--offline']);
    expect(tauriBuildArgs('/scratch/o.json', false)).toEqual(['build', '--bundles', 'app', '--no-sign', '--ci', '--config', '/scratch/o.json', '--', '--locked']);
  });
});

/** Credentials a person's shell may hold: none may reach any child of a build (critique M1, review A M1). */
const SECRETS = {
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (ABCDE12345)', APPLE_TEAM_ID: 'ABCDE12345', APPLE_ID: 'person@example.com', APPLE_PASSWORD: 'apple-pw-canary',
  APPLE_API_KEY: 'key-id-canary', APPLE_API_ISSUER: 'issuer-canary', APPLE_API_KEY_PATH: '/k-canary.p8', APPLE_KEYCHAIN_PROFILE: 'profile-canary', APPLE_CERTIFICATE: 'cert-canary', APPLE_CERTIFICATE_PASSWORD: 'cpw-canary',
  TAURI_SIGNING_PRIVATE_KEY: 'updater-key-canary', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'kpw-canary', TAURI_PRIVATE_KEY: 'legacy-key-canary', TAURI_PRIVATE_KEY_PATH: '/legacy-canary.key', TAURI_PRIVATE_KEY_PASSWORD: 'legacy-pw-canary', TAURI_KEY_PASSWORD: 'legacy-kpw-canary',
  RETAKE_UPDATE_PUBKEY: 'pub-canary', RETAKE_UPDATE_FEED: 'https://updates.example.com/canary',
  GITHUB_TOKEN: 'gh-canary', NPM_TOKEN: 'npm-canary', AWS_SECRET_ACCESS_KEY: 'aws-canary', AWS_ACCESS_KEY_ID: 'aws-id-canary', CARGO_REGISTRY_TOKEN: 'cargo-canary', NODE_AUTH_TOKEN: 'node-auth-canary',
};
const CANARY = /canary|ABCDE12345|person@example\.com/;

/** Recording stand-ins on a scratch PATH: each dumps its environment and arguments to `<dir>/<tool>.<pid>.env`, then does `body`. */
function fakeTools(tools: Record<string, string>): { bin: string; dumps: () => Array<{ tool: string; text: string }> } {
  const bin = dir('fake-tools');
  const out = join(bin, 'dumps');
  mkdirSync(out);
  for (const [tool, body] of Object.entries(tools)) {
    writeFileSync(join(bin, tool), `#!/bin/sh\n{ echo "argv: $*"; /usr/bin/env; } > ${JSON.stringify(out)}/${tool}.$$.env\n${body}\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  return { bin, dumps: () => readdirSync(out).map((f) => ({ tool: f.split('.')[0]!, text: readFileSync(join(out, f), 'utf8') })) };
}

/** A fake pnpm store holding a fake Tauri CLI (`tauri.js`: `script`), and the pins that match it. */
function fakeTauriStore(version: string, script: string): { store: string; pins: any } {
  const store = dir('store');
  const pins: any = { v: 1, version, packages: { '@tauri-apps/cli': {}, '@tauri-apps/cli-darwin-arm64': {} } };
  const blob = (pkg: string, file: string, data: string, exec = false) => {
    const hex = createHash('sha512').update(data).digest('hex');
    put(store, `files/${hex.slice(0, 2)}/${hex.slice(2)}${exec ? '-exec' : ''}`, data);
    const integrity = `sha512-${Buffer.from(hex, 'hex').toString('base64')}`;
    pins.packages[pkg][file] = integrity;
    return { integrity, mode: exec ? 0o755 : 0o644, size: data.length };
  };
  const index = (name: string, files: Record<string, any>) => put(store, `index/7f/abc-${name.replace('/', '+')}@${version}.json`, JSON.stringify({ name, version, files }));
  index('@tauri-apps/cli', { 'tauri.js': blob('@tauri-apps/cli', 'tauri.js', script, true), 'package.json': blob('@tauri-apps/cli', 'package.json', '{"name":"@tauri-apps/cli"}') });
  index('@tauri-apps/cli-darwin-arm64', { 'cli.darwin-arm64.node': blob('@tauri-apps/cli-darwin-arm64', 'cli.darwin-arm64.node', 'native') });
  return { store, pins };
}

/** A stage `build({ stage })` accepts (its layout check passes), its one Mach-O named by `entries`. */
/** A stage that passes the layout check: its engine's @remotion/renderer carries each patch mark once (bundle.mjs RENDERER_PATCH_MARKS). */
function fakeStage(marks: Record<string, Record<string, number>>): string {
  const stage = dir('stage');
  for (const [rel, want] of Object.entries(marks)) put(stage, `engine/node_modules/@remotion/renderer/${rel}`, Object.entries(want).map(([m, k]) => `// ${m}\n`.repeat(k)).join(''));
  put(stage, '.retake-stage');
  put(stage, 'node/bin/node', THIN, 0o755);
  put(stage, 'node/guard.cjs', readFileSync(join(APP, 'bundle', 'guard.cjs')));
  put(stage, 'node/guard-hooks.mjs', readFileSync(join(APP, 'bundle', 'guard-hooks.mjs')));
  put(stage, 'engine/dist/bin.js', '');
  mkdirSync(join(stage, 'engine', 'node_modules', 'playwright-core'), { recursive: true });
  for (const d of ['browsers', 'engine/templates', 'plugin']) mkdirSync(join(stage, d), { recursive: true });
  put(stage, 'bundle.json', JSON.stringify({ v: 1, app: '0.2.0', ffmpeg: null, paths: { node: 'node/bin/node', engine: 'engine', browsers: 'browsers', ffmpeg: null, templates: 'engine/templates', plugin: 'plugin' }, sha256: { node: 'stale' } }));
  return stage;
}
const NODE_ENTRY = [{ id: 'node', kind: 'file', path: 'node/bin/node', entitlements: 'node', dryDLV: false }];

describe('one allow-listed environment for every child of the build (critique M1, review A M1)', () => {
  it('buildEnv keeps the system, toolchain and pnpm variables, drops every credential — APPLE_*, updater keys (legacy names too), tokens', async () => {
    const { buildEnv } = await bundleModule();
    const keep = { PATH: '/usr/bin:/bin', HOME: '/h', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh', TMPDIR: '/t/', LANG: 'en_US.UTF-8', LC_ALL: 'C', TERM: 'xterm', CARGO_HOME: '/c', CARGO_NET_OFFLINE: 'true', RUSTUP_HOME: '/r', RUSTC_WRAPPER: 'x', RUSTFLAGS: '-C x', SDKROOT: '/sdk', DEVELOPER_DIR: '/d', MACOSX_DEPLOYMENT_TARGET: '15.0', PNPM_HOME: '/p', COREPACK_ENABLE_AUTO_PIN: '0', npm_config_store_dir: '/s', CI: '1', NO_COLOR: '1' };
    const drop = { ...SECRETS, KEEP_ME: '1', RETAKE_HOME: '/scratch/home', NODE_OPTIONS: '--require /x.js', DYLD_INSERT_LIBRARIES: '/x.dylib', SSH_AUTH_SOCK: '/s', CARGO_REGISTRIES_X_TOKEN: 'cargo-canary-2', 'npm_config_//registry.example.com/:_authToken': 'npm-canary-2', npm_config__auth: 'npm-canary-3' };
    expect(buildEnv({ ...keep, ...drop })).toEqual(keep);
    expect(buildEnv({ PATH: '/p', ...SECRETS }, { CARGO_TARGET_DIR: '/t' })).toEqual({ PATH: '/p', CARGO_TARGET_DIR: '/t' });
  });

  it('tauri build: a fake CLI started by tauriBuild dumps an environment without any credential, its cargo variables set', async () => {
    const { tauriBuild } = await bundleModule();
    const env = { ...SECRETS, PATH: process.env.PATH, HOME: tmp, KEEP_ME: '1' };
    const d = dir('fake-tauri');
    const dump = join(d, 'dump.json');
    const cliJs = join(d, 'tauri.js');
    writeFileSync(cliJs, `require('node:fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ env: process.env, argv: process.argv.slice(2), cwd: process.cwd() }));\n`);
    const target = join(d, 'target');
    const out = tauriBuild({ cliJs, overlay: join(d, 'o.json'), targetDir: target, env, offline: true });
    expect(out).toBe(join(target, 'release', 'bundle', 'macos', 'Retake.app'));
    const got = JSON.parse(readFileSync(dump, 'utf8'));
    for (const k of Object.keys(SECRETS)) expect(got.env[k], k).toBeUndefined();
    expect(JSON.stringify(got.env)).not.toMatch(CANARY);
    expect(got.env.KEEP_ME).toBeUndefined();
    expect(got.env.HOME).toBe(tmp);
    expect(got.env.CARGO_TARGET_DIR).toBe(target);
    expect(got.env.CARGO_NET_OFFLINE).toBe('true');
    expect(got.argv).toEqual(['build', '--bundles', 'app', '--no-sign', '--ci', '--config', join(d, 'o.json'), '--', '--locked', '--offline']);
    expect(realpathSync(got.cwd)).toBe(realpathSync(APP));
  });

  it.runIf(MAC)('a build run with stand-ins: git, pnpm, codesign, sips, iconutil, tauri, xattr and plutil all see the allow-listed environment only', async () => {
    const { build, TAURI_CLI_VERSION, useBuildEnv, buildEnv } = await bundleModule();
    const { store, pins } = fakeTauriStore(TAURI_CLI_VERSION, [
      "const fs = require('node:fs'), p = require('node:path');",
      `fs.writeFileSync(${JSON.stringify(join(tmp, 'tauri-dump.json'))}, JSON.stringify(process.env));`,
      "const app = p.join(process.env.CARGO_TARGET_DIR, 'release', 'bundle', 'macos', 'Retake.app');",
      "fs.mkdirSync(p.join(app, 'Contents', 'MacOS'), { recursive: true }); fs.mkdirSync(p.join(app, 'Contents', 'Resources'), { recursive: true });",
      "fs.writeFileSync(p.join(app, 'Contents', 'MacOS', 'retake-desktop'), '');",
    ].join('\n'));
    const tools = fakeTools({
      git: 'exec /usr/bin/git "$@"',
      pnpm: `echo ${JSON.stringify(store)}`,
      codesign: 'exit 0',
      sips: 'exit 0',
      iconutil: 'exit 0',
      xattr: 'exit 0',
      plutil: "echo '{}'",
    });
    // L5.16d: the updater's two variables are checked by the build itself (a feed and a key, or neither): left out
    // here — buildEnv's own test above shows they never reach a child.
    const { RETAKE_UPDATE_FEED: _feed, RETAKE_UPDATE_PUBKEY: _key, ...secrets } = SECRETS;
    const env = { ...secrets, PATH: `${tools.bin}:/usr/bin:/bin`, HOME: join(tmp, 'home'), KEEP_ME: '1' };
    // The stand-ins sign nothing: the build stops at the app's checks — after every child kind before it has run.
    const stage = fakeStage((await bundleModule()).RENDERER_PATCH_MARKS);
    try {
      // The app's checks run in full: the signatures (verifyApp) and the rest (appProblems: Resources vs the signed payload, Info.plist).
      expect(() => build({ out: dir('env-out'), stage, env, entries: NODE_ENTRY, tauriPins: pins })).toThrow(/the app fails its checks:[^]*sign-table entry node[^]*Contents\/Resources: missing from the app[^]*Info\.plist: no local network words/);
    } finally {
      useBuildEnv(buildEnv(process.env));
    }
    // bundle.json's hashes are the signed files' (review B M3).
    expect(JSON.parse(readFileSync(join(stage, 'bundle.json'), 'utf8')).sha256.node).toBe(createHash('sha256').update(readFileSync(join(stage, 'node', 'bin', 'node'))).digest('hex'));
    const seen = new Set<string>();
    for (const { tool, text } of [...tools.dumps(), { tool: 'tauri', text: readFileSync(join(tmp, 'tauri-dump.json'), 'utf8') }]) {
      seen.add(tool);
      expect(text, tool).not.toMatch(CANARY);
      expect(text, tool).not.toMatch(/KEEP_ME|APPLE_|TAURI_(?:SIGNING|PRIVATE|KEY)|_TOKEN/);
      expect(text, tool).toContain(env.HOME);
    }
    expect([...seen].sort()).toEqual(['codesign', 'git', 'iconutil', 'plutil', 'pnpm', 'sips', 'tauri', 'xattr']);
    // What the stand-ins cannot reach: apps/desktop/gen is put back whatever tauri build does (review A L2), and the
    // DMG is checked after it is made.
    const js = readFileSync(join(APP, 'scripts', 'bundle.mjs'), 'utf8');
    expect(js).toMatch(/const saved = saveGenerated\(REPO, dir\);\s*let built;\s*try \{\s*built = tauriBuild\([^)]*\);\s*\} finally \{\s*restoreGenerated\(REPO, saved\);\s*\}/);
    // L5.16e fixes: the DMG is release.mjs finishApp's (made after the app's checks; hdiutil tried again on "Resource busy").
    const rel = readFileSync(join(APP, 'scripts', 'release.mjs'), 'utf8');
    expect(js).toMatch(/const done = appOnly \? \{ dmg: null, update: null \} : finishApp\(\{ app, out: dir, mode, env, tauriCli: join\(dir, 'tauri-cli'\), tauriPins,/);
    expect(rel).toMatch(/hdiutil\(dmgCreateArgs\(\{ src: appDir, dmg \}\), \{ env: child, \.\.\.retry \}\);[^]*const problems = verifyDmg\(dmg, join\(out, 'mnt'\), \{ env: child, retry \}\);/);
  });

  it('pnpm deploy (the stage) runs with the allow-listed environment', async () => {
    const { deployEngine, useBuildEnv, buildEnv } = await bundleModule();
    const tools = fakeTools({ pnpm: 'eval "out=\\${$#}"; mkdir -p "$out/node_modules"; echo "{\\"name\\":\\"x\\"}" > "$out/package.json"' });
    useBuildEnv(buildEnv({ ...SECRETS, PATH: `${tools.bin}:/usr/bin:/bin`, HOME: tmp }));
    try {
      deployEngine(dir('mini-repo'), join(dir('deploy'), 'engine'));
    } finally {
      useBuildEnv(buildEnv(process.env));
    }
    const [d] = tools.dumps();
    expect(d!.text).toMatch(/^argv: .*--prod --offline deploy /);
    expect(d!.text).not.toMatch(CANARY);
  });
});

describe('the signing table (sign-table.json + entitlements/*.plist)', () => {
  it('release entitlements: the least the probe proved (review A L1) — allow-jit for Node.js, the Renderer / GPU helpers and the headless shell; DLV only for Node and the Plugin helper; no library carries any; no get-task-allow', async () => {
    const { readTable, entitlementsFor, entitlementKeys, DLV, ENTITLEMENTS_DIR } = await signModule();
    const entries = readTable();
    const release = Object.fromEntries(entries.map((e: any) => [e.id, entitlementsFor(e, 'release')]));
    expect(entries.filter((e: any) => release[e.id].includes(DLV)).map((e: any) => e.id).sort()).toEqual(['chromium-helper-plugin', 'node']);
    const JIT = 'com.apple.security.cs.allow-jit';
    expect(release.node).toEqual([JIT, DLV]);
    for (const id of ['chromium-helper-renderer', 'chromium-helper-gpu', 'headless-shell']) expect(release[id], id).toEqual([JIT]);
    // The browser process and the plain (utility, network) helper JIT nothing: no entitlement.
    for (const id of ['chromium', 'chromium-helper']) expect(release[id], id).toEqual([]);
    // allow-unsigned-executable-memory: the Plugin helper only (Chromium's own set; Retake never starts it).
    expect(entries.filter((e: any) => release[e.id].includes('com.apple.security.cs.allow-unsigned-executable-memory')).map((e: any) => e.id)).toEqual(['chromium-helper-plugin']);
    expect(release['chromium-helper-plugin']).toEqual(['com.apple.security.cs.allow-unsigned-executable-memory', DLV]);
    expect(release['chromium-helper-alerts']).toEqual([]);
    for (const id of ['ffmpeg', 'ffprobe', 'esbuild', 'compositor-remotion']) expect(release[id], id).toEqual([]);
    const library = (e: any) => /\.(dylib|node)$/.test(e.path) || e.path.endsWith('.framework');
    for (const e of entries.filter(library)) {
      expect(e.entitlements, e.id).toBeNull();
      expect(e.dryDLV, e.id).toBe(false);
    }
    for (const f of readdirSync(ENTITLEMENTS_DIR)) {
      const keys = entitlementKeys(readFileSync(join(ENTITLEMENTS_DIR, f), 'utf8'));
      expect(keys.length, f).toBeGreaterThan(0);
      for (const k of keys) expect(['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory', DLV], `${f}: ${k}`).toContain(k);
      expect(readFileSync(join(ENTITLEMENTS_DIR, f), 'utf8')).not.toMatch(/get-task-allow|allow-dyld-environment|disable-executable-page-protection/);
    }
    // Every plist the table names exists, and every plist is used.
    expect([...new Set(entries.map((e: any) => e.entitlements).filter(Boolean))].sort()).toEqual(readdirSync(ENTITLEMENTS_DIR).map((f) => f.replace(/\.plist$/, '')).sort());
  });

  it('the dry set is the release set plus disable-library-validation where the table says so — nothing else', async () => {
    const { readTable, entitlementsFor, DLV } = await signModule();
    for (const e of readTable()) {
      const release = entitlementsFor(e, 'release');
      const dry = entitlementsFor(e, 'dry');
      const want = e.dryDLV ? [...new Set([...release, DLV])].sort() : release;
      expect(dry, e.id).toEqual(want);
      expect(dry.filter((k: string) => !release.includes(k)), e.id).toEqual(e.dryDLV && !release.includes(DLV) ? [DLV] : []);
    }
  });

  it('the walk: every Mach-O (thin and FAT) of a payload is covered, inside-out; a stray one, an unmatched entry or two entries for one file fail', async () => {
    const { signPlan, readTable, insideOut } = await signModule();
    const root = fakePayload();
    const plan = signPlan(root);
    expect(plan.problems).toEqual([]);
    expect(plan.machO).toHaveLength(28);
    expect(plan.machO.find((m: any) => m.path === 'node/bin/node').kind).toBe('fat');
    expect(insideOut(plan.items)).toBe(true);
    const at = (p: string) => plan.items.findIndex((i: any) => i.path === p);
    expect(at(`${V}/Libraries/libEGL.dylib`)).toBeLessThan(at(FW));
    expect(at(`${V}/Helpers/Chromium Helper (Renderer).app`)).toBeLessThan(at(FW));
    expect(at(FW)).toBeLessThan(at(CHR));
    expect(plan.items.find((i: any) => i.path === CHR).entry.id).toBe('chromium');
    // The links of the framework are not followed (each file once).
    expect(new Set(plan.machO.map((m: any) => m.path)).size).toBe(plan.machO.length);
    // A helper's main executable is its bundle's; the framework's binary is the framework's.
    expect(plan.machO.find((m: any) => m.path.endsWith('MacOS/Chromium Helper (GPU)')).entry.id).toBe('chromium-helper-gpu');
    expect(plan.machO.find((m: any) => m.path === `${V}/Chromium Framework`).entry.id).toBe('chromium-framework');

    const stray = fakePayload();
    put(stray, 'engine/node_modules/some-native/build/Release/addon.node', FAT, 0o644);
    put(stray, 'engine/node_modules/some-tool/bin/tool', THIN, 0o644);
    const p2 = signPlan(stray).problems.join('\n');
    expect(p2).toMatch(/some-native\/build\/Release\/addon\.node: a Mach-O \(fat\) the signing table does not name/);
    expect(p2).toMatch(/some-tool\/bin\/tool: a Mach-O \(thin\) the signing table does not name/);

    const nested = fakePayload();
    put(nested, `${CHR}/Contents/MacOS/extra-tool`, THIN, 0o755);
    expect(signPlan(nested).problems).toEqual([]); // an app's Contents/MacOS is its own
    put(nested, `${V}/Helpers/Chromium Helper.app/Contents/Frameworks/x.dylib`, THIN, 0o755);
    expect(signPlan(nested).problems.join('\n')).toMatch(/Chromium Helper\.app\/Contents\/Frameworks\/x\.dylib: a Mach-O/);

    const noBrowser = fakePayload();
    rmSync(join(noBrowser, HS), { recursive: true });
    expect(signPlan(noBrowser).problems.join('\n')).toMatch(/entry headless-shell .* matches nothing/);
    const noFfmpeg = fakePayload();
    rmSync(join(noFfmpeg, 'ffmpeg'), { recursive: true });
    expect(signPlan(noFfmpeg).problems).toEqual([]); // optional: an app without ffmpeg of its own

    const twice = [...readTable(), { id: 'dup', kind: 'file', path: 'node/bin/*', entitlements: null, dryDLV: false }];
    expect(signPlan(fakePayload(), twice).problems.join('\n')).toMatch(/node\/bin\/node: named by node and dup/);
  });

  it('table paths: * stays inside one path segment', async () => {
    const { pathPattern } = await signModule();
    const re = pathPattern('browsers/chromium-*/chrome-mac/Chromium Helper (GPU).app');
    expect(re.test('browsers/chromium-1194/chrome-mac/Chromium Helper (GPU).app')).toBe(true);
    expect(re.test('browsers/chromium-1194/x/chrome-mac/Chromium Helper (GPU).app')).toBe(false);
    expect(re.test('browsers/chromium-1194/chrome-mac/Chromium Helper xGPUx.app')).toBe(false);
  });
});

describe.runIf(MAC)('ad hoc signing and the app check, on a mini app (real codesign, copies of /usr/bin/true)', () => {
  it('payload inside-out with the dry entitlements, the shell and the app; verifyApp passes, then catches a wrong entitlement and a missing runtime', async () => {
    const { signer, signPayload, signApp, verifyApp, signedEntitlements, signatureFlags, codesignArgs, DLV } = await signModule();
    const entries = [
      { id: 'node', kind: 'file', path: 'node/bin/node', entitlements: 'node', dryDLV: false },
      { id: 'tool', kind: 'file', path: 'tools/tool', entitlements: null, dryDLV: true },
      { id: 'lib', kind: 'file', path: 'tools/*.dylib', entitlements: null, dryDLV: false },
    ];
    const app = join(dir('mini'), 'Mini.app');
    const res = join(app, 'Contents', 'Resources');
    for (const rel of ['node/bin/node', 'tools/tool', 'tools/libx.dylib']) {
      mkdirSync(dirname(join(res, rel)), { recursive: true });
      copyFileSync('/usr/bin/true', join(res, rel));
    }
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    copyFileSync('/usr/bin/true', join(app, 'Contents', 'MacOS', 'mini'));
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>mini</string><key>CFBundleIdentifier</key><string>com.example.mini</string></dict></plist>\n');
    const s = signer('dry', process.env);
    expect(codesignArgs(s, '/x')).toEqual(['--force', '--options', 'runtime', '--timestamp=none', '-s', '-', '/x']);
    const plan = signPayload(res, s, { entries, work: join(dirname(app), 'ent') });
    expect(plan.items.map((i: any) => i.entry.id).sort()).toEqual(['lib', 'node', 'tool']);
    signApp(app, s);
    expect(signedEntitlements(join(res, 'node/bin/node'))).toEqual(['com.apple.security.cs.allow-jit', DLV]);
    expect(signedEntitlements(join(res, 'tools/tool'))).toEqual([DLV]);
    expect(signedEntitlements(join(res, 'tools/libx.dylib'))).toEqual([]);
    expect(signatureFlags(join(res, 'tools/libx.dylib'))).toEqual(['adhoc', 'runtime']);
    expect(verifyApp(app, 'dry', { entries })).toEqual([]);
    // The release set is expected in release mode: the dry DLV on `tool` is then a problem.
    expect(verifyApp(app, 'release', { entries }).join('\n')).toMatch(/tools\/tool: entitlements \["com\.apple\.security\.cs\.disable-library-validation"\], the table says \[\]/);
    // Re-signed without the runtime (and the app's seal broken by it): caught.
    execFileSync('codesign', ['--force', '-s', '-', join(res, 'tools/tool')], { stdio: 'ignore' });
    const p = verifyApp(app, 'dry', { entries }).join('\n');
    expect(p).toMatch(/tools\/tool: no hardened runtime/);
    expect(p).toMatch(/codesign --verify --deep --strict/);
  });
});

describe('the release path: refusals first, a zip notarised then the app stapled, no credential on a command line', () => {
  const ID = 'Developer ID Application: Example Maker (ABCDE12345)';
  const BASE = { APPLE_SIGNING_IDENTITY: ID, APPLE_TEAM_ID: 'ABCDE12345' };
  it('releaseConfig: identity + team + a keychain profile or an API key file; an Apple ID password is refused; empty counts as absent; the identity names the team', async () => {
    const { releaseConfig } = await signModule();
    expect(releaseConfig({ ...BASE, APPLE_KEYCHAIN_PROFILE: 'retake-notary' }).notary).toEqual({ profile: 'retake-notary' });
    expect(releaseConfig({ ...BASE, APPLE_API_KEY: 'K', APPLE_API_ISSUER: 'I', APPLE_API_KEY_PATH: '/k.p8' }).notary).toEqual({ key: 'K', issuer: 'I', keyPath: '/k.p8' });
    const refused: Array<[Record<string, string>, RegExp]> = [
      [{}, /set APPLE_SIGNING_IDENTITY, APPLE_TEAM_ID, APPLE_KEYCHAIN_PROFILE \(or APPLE_API_KEY \+ APPLE_API_ISSUER \+ APPLE_API_KEY_PATH\)/],
      [{ ...BASE, APPLE_ID: 'maker@example.com', APPLE_PASSWORD: 'app-pw' }, /APPLE_PASSWORD is not used: notarytool would show it to every process on its command line/],
      [{ ...BASE, APPLE_KEYCHAIN_PROFILE: ' ' }, /set APPLE_KEYCHAIN_PROFILE/],
      [{ ...BASE, APPLE_API_KEY: 'K', APPLE_API_ISSUER: 'I' }, /set APPLE_KEYCHAIN_PROFILE \(or/],
      [{ ...BASE, APPLE_SIGNING_IDENTITY: '', APPLE_KEYCHAIN_PROFILE: 'p' }, /set APPLE_SIGNING_IDENTITY/],
      [{ ...BASE, APPLE_TEAM_ID: '  ', APPLE_KEYCHAIN_PROFILE: 'p' }, /set APPLE_TEAM_ID/],
      [{ ...BASE, APPLE_SIGNING_IDENTITY: '-', APPLE_KEYCHAIN_PROFILE: 'p' }, /must be "Developer ID Application/],
      [{ ...BASE, APPLE_SIGNING_IDENTITY: 'Apple Development: Example (ABCDE12345)', APPLE_KEYCHAIN_PROFILE: 'p' }, /must be "Developer ID Application/],
      [{ ...BASE, APPLE_TEAM_ID: 'ZZZZZ99999', APPLE_KEYCHAIN_PROFILE: 'p' }, /team \(ABCDE12345\) is not APPLE_TEAM_ID/],
    ];
    for (const [env, msg] of refused) expect(() => releaseConfig(env), JSON.stringify(env)).toThrow(msg);
    for (const [env] of refused) expect(() => releaseConfig(env)).toThrow(/nothing was signed/);
  });

  it('notarytool gets a .zip or a .dmg, and a keychain profile or an API key file — never a password; a failure prints no credential', async () => {
    const { notarizeArgs, redactArgs, signer } = await signModule();
    const byProfile = signer('release', { ...BASE, APPLE_KEYCHAIN_PROFILE: 'profile-canary' }, {});
    const byKey = signer('release', { ...BASE, APPLE_API_KEY: 'key-id-canary', APPLE_API_ISSUER: 'issuer-canary', APPLE_API_KEY_PATH: '/keys/AuthKey.p8' }, {});
    // Waited for at most NOTARY_TIMEOUT, the answer as JSON (review e B-L3: notarize reads its status).
    expect(notarizeArgs(byProfile, '/o/Retake.zip')).toEqual(['notarytool', 'submit', '/o/Retake.zip', '--wait', '--timeout', '75m', '--output-format', 'json', '--keychain-profile', 'profile-canary']);
    expect(notarizeArgs(byKey, '/o/Retake.dmg')).toEqual(['notarytool', 'submit', '/o/Retake.dmg', '--wait', '--timeout', '75m', '--output-format', 'json', '--key', '/keys/AuthKey.p8', '--key-id', 'key-id-canary', '--issuer', 'issuer-canary']);
    expect(() => notarizeArgs(byProfile, '/o/Retake.app')).toThrow(/a \.zip or a \.dmg, not \/o\/Retake\.app/);
    for (const s of [byProfile, byKey]) expect(notarizeArgs(s, '/o/x.zip').join(' ')).not.toMatch(/--password|--apple-id|pw/);
    // Redaction by flag, wherever the flag sits, both spellings.
    expect(redactArgs(['submit', 'f.zip', '--keychain-profile', 'p1', '--wait', '--key-id=k2', '--issuer', 'i3', '--password', 'p4', '--apple-id', 'a5', '--key', '/k6'])).toEqual(['submit', 'f.zip', '--keychain-profile', '<redacted>', '--wait', '--key-id=<redacted>', '--issuer', '<redacted>', '--password', '<redacted>', '--apple-id', '<redacted>', '--key', '<redacted>']);
  });

  it.runIf(MAC)('notarizeApp: ditto -c -k --keepParent, the zip submitted and waited for, then the app stapled; the zip removed; no APPLE_* in any tool\'s environment', async () => {
    const { notarizeApp, notarizeDmg, signDmg, signer } = await signModule();
    const { buildEnv } = await bundleModule();
    const log = join(dir('notary-log'), 'calls');
    const record = `echo "$(basename "$0") $*" >> ${JSON.stringify(log)}`;
    const tools = fakeTools({ ditto: `${record}\neval "z=\\\${$#}"; : > "$z"`, xcrun: `${record}\nif [ "$2" = submit ]; then echo '{"id":"sub-1","status":"Accepted","message":"Processing complete"}'; fi`, codesign: record });
    const full = { ...SECRETS, ...BASE, APPLE_KEYCHAIN_PROFILE: 'profile-canary', PATH: `${tools.bin}:/usr/bin:/bin`, HOME: tmp };
    const s = signer('release', full, buildEnv(full));
    const app = join(dir('notary'), 'Retake.app');
    mkdirSync(app);
    const work = join(dirname(app), 'notarize');
    notarizeApp(s, app, work);
    const zip = join(work, 'Retake-notarize.zip');
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      `ditto -c -k --keepParent ${app} ${zip}`,
      `xcrun notarytool submit ${zip} --wait --timeout 75m --output-format json --keychain-profile profile-canary`,
      `xcrun stapler staple ${app}`,
    ]);
    expect(existsSync(zip)).toBe(false);
    const dmg = join(dirname(app), 'Retake.dmg');
    signDmg(s, dmg);
    notarizeDmg(s, dmg);
    expect(readFileSync(log, 'utf8').trim().split('\n').slice(3)).toEqual([
      `codesign --force --timestamp -s ${ID} ${dmg}`,
      `xcrun notarytool submit ${dmg} --wait --timeout 75m --output-format json --keychain-profile profile-canary`,
      `xcrun stapler staple ${dmg}`,
    ]);
    for (const { tool, text } of tools.dumps()) {
      expect(text.split('\n').filter((l) => !l.startsWith('argv: ')).join('\n'), tool).not.toMatch(CANARY);
      expect(text, tool).not.toMatch(/apple-pw-canary|key-id-canary|updater-key-canary/);
    }
    // Dry runs never notarise; a failing notarytool names no credential.
    expect(() => notarizeApp(signer('dry'), app, work)).toThrow(/release run only/);
    const failing = fakeTools({ ditto: 'eval "z=\\${$#}"; : > "$z"', xcrun: 'echo "Error: HTTP status code: 401" >&2; exit 1' });
    const byKey = { ...BASE, APPLE_API_KEY: 'key-id-canary', APPLE_API_ISSUER: 'issuer-canary', APPLE_API_KEY_PATH: '/keys/canary.p8', PATH: `${failing.bin}:/usr/bin:/bin` };
    let message = '';
    try {
      notarizeApp(signer('release', byKey, buildEnv(byKey)), app, work);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/xcrun notarytool submit .* --key <redacted> --key-id <redacted> --issuer <redacted> failed \(1\): Error: HTTP status code: 401/);
    expect(message).not.toMatch(/canary/);
    expect(existsSync(zip)).toBe(false);
  });

  it.runIf(MAC)('verifyRelease: every Mach-O signed by APPLE_TEAM_ID\'s team and none ad hoc; Gatekeeper and both tickets checked', async () => {
    const { verifyRelease, signer } = await signModule();
    const app = join(dir('release-verify'), 'Retake.app');
    put(app, 'Contents/MacOS/retake-desktop', THIN, 0o755);
    put(app, 'Contents/Resources/node/bin/node', THIN, 0o755);
    put(app, 'Contents/Resources/engine/dist/bin.js', '');
    const dmg = join(dirname(app), 'Retake.dmg');
    const accepted = 'p=$(eval "echo \\${$#}"); echo "$p: accepted" >&2; echo "source=Notarized Developer ID" >&2; echo "origin=Developer ID Application: Example Maker (ABCDE12345)" >&2';
    const run = (codesign: string, spctl = accepted, xcrun = 'exit 0') => {
      const tools = fakeTools({ codesign, spctl, xcrun });
      const s = signer('release', { ...BASE, APPLE_KEYCHAIN_PROFILE: 'p' }, { PATH: `${tools.bin}:/usr/bin:/bin` });
      return { problems: verifyRelease(app, dmg, s) as string[], calls: tools.dumps().map((d) => d.text.split('\n')[0]).sort() };
    };
    const ok = run('echo "TeamIdentifier=ABCDE12345" >&2; echo "CodeDirectory v=20500 flags=0x10000(runtime) hashes=1" >&2');
    expect(ok.problems).toEqual([]);
    expect(ok.calls.filter((c) => !c.startsWith('argv: -dv'))).toEqual([
      `argv: -a -vv -t exec ${app}`,
      `argv: -a -vv -t open --context context:primary-signature ${dmg}`,
      `argv: stapler validate ${app}`,
      `argv: stapler validate ${dmg}`,
    ].sort());
    const adhoc = run('echo "TeamIdentifier=not set" >&2; echo "flags=0x10002(adhoc,runtime)" >&2').problems.join('\n');
    expect(adhoc).toMatch(/Retake\.app: signed by team none, not ABCDE12345/);
    expect(adhoc).toMatch(/node\/bin\/node: an ad hoc signature/);
    expect(run('echo "TeamIdentifier=ZZZZZ99999" >&2').problems.join('\n')).toMatch(/retake-desktop: signed by team ZZZZZ99999/);
    const rejected = run('echo "TeamIdentifier=ABCDE12345" >&2; echo "flags=0x10000(runtime)" >&2', 'echo "rejected" >&2; exit 3', 'echo "does not have a ticket" >&2; exit 65').problems.join('\n');
    expect(rejected).toMatch(/spctl -a -vv -t exec .*: rejected/);
    expect(rejected).toMatch(/xcrun stapler validate .*Retake\.dmg: does not have a ticket/);
    // Gatekeeper's words, not only its exit status (review e B-L2): accepted as a notarised Developer ID.
    const team = 'echo "TeamIdentifier=ABCDE12345" >&2; echo "flags=0x10000(runtime)" >&2';
    const unnotarised = run(team, 'p=$(eval "echo \\${$#}"); echo "$p: accepted" >&2; echo "source=Developer ID" >&2').problems.join('\n');
    expect(unnotarised).toMatch(/spctl -a -vv -t exec .*: accepted, but not as a notarised Developer ID \(Developer ID\)/);
    expect(unnotarised).toMatch(/spctl -a -vv -t open .*Retake\.dmg: accepted, but not as a notarised Developer ID/);
    expect(run(team, 'exit 0').problems.join('\n')).toMatch(/spctl -a -vv -t exec .*: not accepted/);
    const { gatekeeperProblem } = await signModule();
    expect(gatekeeperProblem(0, '/x/Retake.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: E (ABCDE12345)\n')).toBeNull();
    expect(gatekeeperProblem(0, '/x/Retake.app: accepted\nsource=Unnotarized Developer ID\n')).toMatch(/not as a notarised Developer ID \(Unnotarized Developer ID\)/);
    expect(gatekeeperProblem(3, '/x/Retake.app: rejected\n')).toMatch(/rejected/);
    expect(() => verifyRelease(app, dmg, signer('dry'))).toThrow(/release run only/);
  });

  it.runIf(MAC)('notarize (review e B-L3): Accepted passes; Invalid says Apple\'s status and the first issues of its log (same credentials, none printed); no answer: notarytool\'s words', async () => {
    const { notarize, signer } = await signModule();
    const { buildEnv } = await bundleModule();
    const log = join(dir('notarize-log'), 'calls');
    const xcrun = (submit: string, logOut: string) => fakeTools({ xcrun: `echo "$*" >> ${JSON.stringify(log)}\nif [ "$2" = submit ]; then ${submit}; else ${logOut}; fi` });
    const byKey = { APPLE_SIGNING_IDENTITY: ID, APPLE_TEAM_ID: 'ABCDE12345', APPLE_API_KEY: 'key-id-canary', APPLE_API_ISSUER: 'issuer-canary', APPLE_API_KEY_PATH: '/keys/canary.p8' };
    const s = (tools: { bin: string }) => signer('release', byKey, buildEnv({ PATH: `${tools.bin}:/usr/bin:/bin`, HOME: tmp }));
    expect(notarize(s(xcrun(`echo '{"id":"a1","status":"Accepted"}'`, 'exit 1')), '/o/Retake.dmg')).toBe('a1');
    let message = '';
    try {
      notarize(s(xcrun(`echo '{"id":"b2","status":"Invalid","message":"Processing complete"}'; exit 1`, `echo '{"issues":[{"severity":"error","path":"Retake.zip/Retake.app/Contents/Resources/node/bin/node","message":"The binary is not signed with a valid Developer ID certificate."}]}'`)), '/o/Retake-notarize.zip');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/^notarisation of Retake-notarize\.zip: Invalid — Processing complete \(submission b2\):\n  Retake\.zip\/Retake\.app\/Contents\/Resources\/node\/bin\/node: The binary is not signed with a valid Developer ID certificate\.$/);
    expect(readFileSync(log, 'utf8').trim().split('\n').pop()).toBe('notarytool log b2 --key /keys/canary.p8 --key-id key-id-canary --issuer issuer-canary');
    expect(message).not.toMatch(/canary/);
    message = '';
    try {
      notarize(s(xcrun('echo "Error: timed out waiting" >&2; exit 2', 'exit 1')), '/o/Retake.dmg');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/--timeout 75m --output-format json --key <redacted> --key-id <redacted> --issuer <redacted> failed \(2\): Error: timed out waiting/);
  });

  it('build({ mode: "release" }) and pnpm desktop:release without the full set refuse before staging, signing or any tool runs (recording stand-ins on PATH)', async () => {
    const { build } = await bundleModule();
    const shims = dir('shims');
    const log = join(shims, 'calls.log');
    for (const tool of ['codesign', 'xcrun', 'notarytool', 'stapler', 'security', 'hdiutil', 'pnpm', 'xattr', 'ditto', 'git', 'spctl']) {
      writeFileSync(join(shims, tool), `#!/bin/sh\necho "${tool} $*" >> ${JSON.stringify(log)}\nexit 1\n`);
      chmodSync(join(shims, tool), 0o755);
    }
    // A reusable stage that passes the layout check, and a table naming its one Mach-O: a release run that went past
    // the check would reach codesign next.
    const stage = fakeStage((await bundleModule()).RENDERER_PATCH_MARKS);
    const env = { PATH: `${shims}:/usr/bin:/bin`, HOME: tmp, APPLE_SIGNING_IDENTITY: ID, APPLE_ID: 'maker@example.com', APPLE_PASSWORD: 'apple-pw-canary' };
    expect(() => build({ out: dir('release-out'), mode: 'release', stage, env, entries: NODE_ENTRY })).toThrow(/set APPLE_TEAM_ID, APPLE_KEYCHAIN_PROFILE .* nothing was signed/);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(stage, 'launch.json'))).toBe(false);
    // An unknown mode is refused the same way.
    expect(() => build({ out: dir('release-out'), mode: 'ship', stage, env, entries: NODE_ENTRY })).toThrow(/dry or release/);
    // The command line's --release (pnpm desktop:release) goes through the same refusal.
    const out = dir('release-cli-out');
    const r = spawnSync(process.execPath, [join(APP, 'scripts', 'bundle.mjs'), 'build', '--release', '--out', out, '--stage', stage], { env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^bundle: a release build signs with your Developer ID and notarises: set APPLE_TEAM_ID, .* nothing was signed\n$/);
    expect(r.stderr).not.toMatch(/canary/);
    expect(existsSync(log)).toBe(false);
    expect(readdirSync(out)).toEqual([]);
  });
});

describe('the folders a build writes (review A M3, review B L5)', () => {
  it('checkFolder: by real path — never the checkout (through a link too), /Applications, ~/Applications, ~/Library, the home folder or a folder holding it, the Desktop / Documents / Downloads roots', async () => {
    const { checkFolder } = await bundleModule();
    const link = join(dir('links'), 'to-checkout');
    symlinkSync(join(REPO, 'apps', 'desktop'), link);
    expect(() => checkFolder(join(link, 'target', 'x'), '--out')).toThrow(/--out .*: outside the checkout \(a scratch folder\)/);
    expect(() => checkFolder(join(REPO, '..'), '--out')).toThrow(/outside the checkout/);
    for (const p of ['/Applications/Retake', '/System/Volumes/Data/Applications/x']) expect(() => checkFolder(p, '--out'), p).toThrow(/never into \/Applications/);
    const home = dir('home');
    for (const sub of ['Desktop', 'Documents', 'Downloads', 'Library', 'Applications']) mkdirSync(join(home, sub));
    const env = { HOME: home };
    expect(() => checkFolder(home, '--out', env)).toThrow(/the home folder or a folder holding it — use a folder of its own/);
    expect(() => checkFolder(dirname(home), '--stage', env)).toThrow(/--stage .*: the home folder or a folder holding it/);
    for (const sub of ['Desktop', 'Documents', 'Downloads']) {
      expect(() => checkFolder(join(home, sub), '--out', env), sub).toThrow(new RegExp(`a folder of its own is needed .*not ~/${sub} itself`));
      expect(checkFolder(join(home, sub, 'retake-build'), '--out', env)).toBe(join(home, sub, 'retake-build'));
    }
    for (const sub of ['Library', 'Applications']) expect(() => checkFolder(join(home, sub, 'x'), '--out', env), sub).toThrow(new RegExp(`never inside ~/${sub}`));
    // The person's own home (the checkout may sit inside it: only folders beside the checkout are tried; nothing is written).
    expect(() => checkFolder(join(homedir(), 'Desktop'), '--out')).toThrow(/not ~\/Desktop itself/);
    expect(() => checkFolder(join(homedir(), 'Library', 'retake-build'), '--out')).toThrow(/never inside ~\/Library/);
    expect(() => checkFolder('', '--out')).toThrow(/--out <dir> is needed/);
  });

  it('build: an --out folder with content and no mark of an earlier build is refused and kept as is; --stage inside the checkout is refused', async () => {
    const { build, BUILD_MARK } = await bundleModule();
    const out = dir('persons-folder');
    put(out, 'app/keep.txt', 'mine');
    expect(() => build({ out, env: { PATH: '/usr/bin:/bin', HOME: tmp } })).toThrow(/is not empty and holds no earlier build \(\.retake-bundle\): give an empty folder of its own/);
    expect(readFileSync(join(out, 'app', 'keep.txt'), 'utf8')).toBe('mine');
    expect(readdirSync(out)).toEqual(['app']);
    const empty = dir('empty-out');
    expect(() => build({ out: empty, stage: join(REPO, 'apps', 'desktop'), env: { PATH: '/usr/bin:/bin', HOME: tmp } })).toThrow(/--stage .*: outside the checkout/);
    expect(existsSync(join(empty, BUILD_MARK))).toBe(false);
    const inRepo = join(REPO, 'apps', 'desktop', `bundle-out-test-${process.pid}`);
    expect(() => build({ out: inRepo })).toThrow(/: outside the checkout \(a scratch folder\)/);
    expect(existsSync(inRepo)).toBe(false);
    expect(() => build({ out: '/Applications/Retake' })).toThrow(/never into \/Applications/);
    expect(() => build({ out: undefined })).toThrow(/--out <dir> or RETAKE_BUNDLE_OUT/);
  });
});

describe('a reused stage (--stage)', () => {
  it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('of another version than the app\'s is refused before Tauri builds anything when an app or a DMG is made: stage again', async () => {
    const { build, GUARD } = await bundleModule();
    const conf = JSON.parse(readFileSync(join(APP, 'tauri.conf.json'), 'utf8'));
    const staged = (version: string) => {
      const st = dir('old-stage');
      put(st, '.retake-stage');
      put(st, GUARD, '');
      put(st, 'bundle.json', JSON.stringify({ v: 1, app: version, paths: { node: 'node/bin/node' } }));
      return st;
    };
    const env = { PATH: '/usr/bin:/bin', HOME: tmp };
    expect(() => build({ out: dir('reuse-out'), stage: staged('0.0.1'), env })).toThrow(new RegExp(`--stage \\S+ was made for version 0\\.0\\.1, the app is ${conf.version.replace(/\./g, '\\.')} \\(tauri\\.conf\\.json\\): stage again \\(bundle\\.mjs stage\\)`));
    expect(() => build({ out: dir('reuse-out'), stage: staged('0.1.0'), env, appVersion: '0.2.0', appOnly: true })).toThrow(/was made for version 0\.1\.0, the app is 0\.2\.0/);
    // The same version passes this check (and stops further on, at the stage's own check); no app, no DMG: not asked.
    for (const opts of [{ appVersion: '0.1.0' }, { appVersion: '0.2.0', dmg: false }]) {
      let message = '';
      try {
        build({ out: dir('reuse-out'), stage: staged('0.1.0'), env, ...opts });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(opts)).toMatch(/the stage fails its check/);
    }
  });
});

describe('launch.json version 2 and the launcher', () => {
  it('launch.json v2: relative paths inside Resources, bundled, the module lookup guard first — what desktop_core::launch_config reads', async () => {
    const { launchJson, LAUNCHER, GUARD } = await bundleModule();
    const v2 = launchJson({ paths: { node: 'node/bin/node', engine: 'engine' } });
    // L5.16d (review d A-L9): whether the build updates itself (doctor reads it; the shell ignores the key).
    expect(v2).toEqual({ version: 2, bundled: true, node: 'node/bin/node', cli: 'engine/dist/bin.js', preload: 'node/guard.cjs', updates: 'off' });
    expect(launchJson({ paths: { node: 'node/bin/node', engine: 'engine' } }, { updates: true }).updates).toBe('on');
    expect(readFileSync(join(APP, 'scripts', 'bundle.mjs'), 'utf8')).toContain('launchJson(manifest, { updates: !!updates })');
    expect(LAUNCHER).toBe('bin/retake');
    expect(GUARD).toBe('node/guard.cjs');
    const rs = readFileSync(join(APP, 'core', 'src', 'config.rs'), 'utf8');
    expect(rs).toContain('Some(2) => {');
    expect(rs).toContain('bundled must be true');
    expect(rs).toContain('matches!(c, Component::Normal(_))');
    expect(rs).toContain('field("preload")?');
    // The shell's Studio server: the guard as an argument, ws's optional addons off (child.rs).
    const child = readFileSync(join(APP, 'src', 'child.rs'), 'utf8');
    expect(child).toMatch(/if let Some\(preload\) = &cfg\.preload \{\s*cmd\.arg\("--require"\)\.arg\(preload\);/);
    expect(child).toContain('cmd.env("WS_NO_BUFFER_UTIL", "1").env("WS_NO_UTF_8_VALIDATE", "1")');
  });

  it('bin/retake runs the app\'s Node.js on the app\'s engine, its guard first, through any chain of links, without the code loaders', () => {
    const base = dir('launcher');
    const res = join(base, 'My Apps', 'Retake.app', 'Contents', 'Resources');
    put(res, 'bin/retake', readFileSync(join(APP, 'bundle', 'retake.sh')), 0o755);
    put(res, 'engine/dist/bin.js', '');
    put(res, 'node/guard.cjs', '');
    // A fake node: where it runs from, what it got, what the code loaders are.
    put(res, 'node/bin/node', '#!/bin/sh\necho "node=$0"\nfor a in "$@"; do echo "arg=$a"; done\necho "NODE_OPTIONS=${NODE_OPTIONS-unset} NODE_PATH=${NODE_PATH-unset} NODE_REPL_EXTERNAL_MODULE=${NODE_REPL_EXTERNAL_MODULE-unset} LD_PRELOAD=${LD_PRELOAD-unset} LD_AUDIT=${LD_AUDIT-unset} KEEP=${KEEP-unset}"\necho "WS=${WS_NO_BUFFER_UTIL-unset},${WS_NO_UTF_8_VALIDATE-unset}"\n', 0o755);
    const bin = join(base, 'bin');
    mkdirSync(bin);
    symlinkSync(join(res, 'bin', 'retake'), join(bin, 'retake-direct'));
    symlinkSync(join(bin, 'retake-direct'), join(bin, 'retake'));
    const realRes = realpathSync(res);
    const env = { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require=/somewhere/hook.js', NODE_PATH: '/somewhere', NODE_REPL_EXTERNAL_MODULE: '/somewhere/repl.js', LD_PRELOAD: '/x.so', LD_AUDIT: '/y.so', KEEP: 'kept' };
    for (const cmd of [join(res, 'bin', 'retake'), join(bin, 'retake'), join(bin, 'retake-direct')]) {
      const out = execFileSync(cmd, ['--version', 'two words'], { encoding: 'utf8', env });
      expect(out.split('\n'), cmd).toEqual([
        `node=${realRes}/node/bin/node`,
        'arg=--require',
        `arg=${realRes}/node/guard.cjs`,
        `arg=${realRes}/engine/dist/bin.js`,
        'arg=--version',
        'arg=two words',
        'NODE_OPTIONS=unset NODE_PATH=unset NODE_REPL_EXTERNAL_MODULE=unset LD_PRELOAD=unset LD_AUDIT=unset KEEP=kept',
        'WS=1,1',
        '',
      ]);
    }
    expect(readFileSync(join(APP, 'bundle', 'retake.sh'), 'utf8')).toMatch(/^#!\/bin\/sh\n/);
    // A copy outside an app, or an app without its guard: refused, the fake node never runs (review A L4).
    copyFileSync(join(res, 'bin', 'retake'), join(bin, 'copied'));
    chmodSync(join(bin, 'copied'), 0o755);
    const copied = spawnSync(join(bin, 'copied'), ['--version'], { encoding: 'utf8', env });
    expect(copied.status).toBe(1);
    expect(copied.stdout).toBe('');
    expect(copied.stderr).toMatch(/is not inside an app \(Retake\.app\/Contents\/Resources\/bin\/retake\): link to it, do not copy it/);
    rmSync(join(res, 'node', 'guard.cjs'));
    const broken = spawnSync(join(bin, 'retake'), ['--version'], { encoding: 'utf8', env });
    expect(broken.status).toBe(1);
    expect(broken.stdout).toBe('');
    expect(broken.stderr).toMatch(/is not a complete Retake app: install it again from its disk image/);
  });
});

describe('the module lookup guard: the app\'s code never loads a module from a node_modules folder above the app (review A H1)', () => {
  /**
   * A mini tree: canaries in a node_modules folder above the app, above Resources (inside the .app) and in
   * $HOME/.node_modules; a package inside the engine; a workspace file outside the app with its own node_modules and one
   * above it. Each canary records its load in `log`.
   */
  function tree() {
    const base = dir('guard');
    const log = join(base, 'loaded.log');
    const canary = (at: string, name: string) => put(base, `${at}/${name}/index.js`, `require('node:fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${at}/${name}\n`)}); module.exports = 'canary';\n`);
    canary('node_modules', 'canary');
    canary('node_modules', 'bufferutil');
    canary('Retake.app/node_modules', 'canary-app');
    canary('Retake.app/Contents/node_modules', 'canary-contents');
    canary('home/.node_modules', 'canary-home');
    const res = join(base, 'Retake.app', 'Contents', 'Resources');
    put(res, 'node/guard.cjs', readFileSync(join(APP, 'bundle', 'guard.cjs')));
    put(res, 'node/guard-hooks.mjs', readFileSync(join(APP, 'bundle', 'guard-hooks.mjs')));
    put(res, 'engine/node_modules/inner/index.js', "module.exports = 'inner';\n");
    put(res, 'engine/node_modules/inner/package.json', '{"name":"inner","main":"index.js"}');
    put(base, 'node_modules/shared/index.js', "module.exports = 'shared';\n");
    put(base, 'ws/node_modules/wsdep/index.js', "module.exports = 'wsdep';\n");
    // The person's file: its own lookup, from its own folder (its node_modules, then above it).
    put(base, 'ws/comp.mjs', "import w from 'wsdep'; import s from 'shared'; export default `${w}+${s}`;\n");
    const names = ['canary', 'bufferutil', 'canary-app', 'canary-contents', 'canary-home'];
    const probe = `const out = {};
for (const s of ${JSON.stringify(names)}) {
  try { req(s); out['cjs ' + s] = 'loaded'; } catch (e) { out['cjs ' + s] = e.code; }
  try { await import(s); out['esm ' + s] = 'loaded'; } catch (e) { out['esm ' + s] = e.code; }
  // require.resolve with explicit folders inside the app (packages look their peers up so).
  try { req.resolve(s, { paths: [here] }); out['paths ' + s] = 'found'; } catch (e) { out['paths ' + s] = e.code; }
}`;
    put(res, 'engine/main.mjs', `import inner from 'inner';
import Module, { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
const req = createRequire(import.meta.url);
const here = new URL('.', import.meta.url).pathname;
${probe}
// What a module's own lookup folders are (module.paths: what packages that resolve by hand read).
out.lookup = Module._nodeModulePaths(here).every((p) => p.startsWith(${JSON.stringify(`${res}/`)})) ? 'inside' : 'leaves';
out.inner = inner + '/' + req('inner');
out.ws = (await import(${JSON.stringify(pathToFileURL(join(base, 'ws', 'comp.mjs')).href)})).default;
out.thread = await new Promise((ok) => new Worker(new URL('./thread.cjs', import.meta.url)).once('message', ok));
console.log(JSON.stringify(out));
`);
    put(res, 'engine/thread.cjs', `const { parentPort } = require('node:worker_threads');
let r; try { require('canary'); r = 'loaded'; } catch (e) { r = e.code; }
import('bufferutil').then(() => parentPort.postMessage(r + ' / loaded'), (e) => parentPort.postMessage(r + ' / ' + e.code));
`);
    const run = (guard: boolean) => {
      const r = spawnSync(process.execPath, [...(guard ? ['--require', join(res, 'node', 'guard.cjs')] : []), join(res, 'engine', 'main.mjs')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: join(base, 'home') }, cwd: base });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout) as Record<string, string>;
    };
    return { log, run };
  }

  it('with the guard: no canary loads (CommonJS, ES modules, a worker thread); the engine\'s own package loads; a workspace file keeps its own lookup', () => {
    const { log, run } = tree();
    // Without it (control): Node.js walks up out of the app.
    const open = run(false);
    expect(open['cjs canary']).toBe('loaded');
    expect(open['esm bufferutil']).toBe('loaded');
    expect(open['cjs canary-contents']).toBe('loaded');
    expect(open['cjs canary-home']).toBe('loaded');
    expect(open['paths canary']).toBe('found');
    expect(open['paths canary-home']).toBe('found');
    expect(open.lookup).toBe('leaves');
    expect(readFileSync(log, 'utf8')).toContain('node_modules/canary');
    rmSync(log);
    const out = run(true);
    expect(out).toEqual({
      'cjs canary': 'MODULE_NOT_FOUND', 'esm canary': 'ERR_MODULE_NOT_FOUND', 'paths canary': 'MODULE_NOT_FOUND',
      'cjs bufferutil': 'MODULE_NOT_FOUND', 'esm bufferutil': 'ERR_MODULE_NOT_FOUND', 'paths bufferutil': 'MODULE_NOT_FOUND',
      'cjs canary-app': 'MODULE_NOT_FOUND', 'esm canary-app': 'ERR_MODULE_NOT_FOUND', 'paths canary-app': 'MODULE_NOT_FOUND',
      'cjs canary-contents': 'MODULE_NOT_FOUND', 'esm canary-contents': 'ERR_MODULE_NOT_FOUND', 'paths canary-contents': 'MODULE_NOT_FOUND',
      'cjs canary-home': 'MODULE_NOT_FOUND', 'esm canary-home': 'ERR_MODULE_NOT_FOUND', 'paths canary-home': 'MODULE_NOT_FOUND',
      lookup: 'inside',
      inner: 'inner/inner',
      ws: 'wsdep+shared',
      thread: 'MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND',
    });
    expect(existsSync(log)).toBe(false);
  });

  it('the stage carries the guard where the launcher, launch.json and core expect it', async () => {
    const { GUARD } = await bundleModule();
    const core = readFileSync(join(REPO, 'packages', 'core', 'src', 'bundle.ts'), 'utf8');
    expect(core).toContain(`export const BUNDLE_GUARD = '${GUARD}';`);
    expect(readFileSync(join(APP, 'bundle', 'retake.sh'), 'utf8')).toContain('exec "$res/node/bin/node" --require "$res/node/guard.cjs" "$res/engine/dist/bin.js" "$@"');
    const js = readFileSync(join(APP, 'scripts', 'bundle.mjs'), 'utf8');
    expect(js).toContain("[['guard.cjs', GUARD], ['guard-hooks.mjs', join(dirname(GUARD), 'guard-hooks.mjs')]]");
  });
});

describe('the DMG commands, the hygiene of attributes', () => {
  it('hdiutil create: APFS, ULFO, the folder as given; attach for an inspection only: -nobrowse -readonly at a mount point', async () => {
    const { dmgCreateArgs, dmgAttachArgs } = await bundleModule();
    expect(dmgCreateArgs({ src: '/scratch/app', dmg: '/scratch/Retake_0.2.0_aarch64.dmg' })).toEqual(['create', '-volname', 'Retake', '-srcfolder', '/scratch/app', '-fs', 'APFS', '-format', 'ULFO', '-ov', '/scratch/Retake_0.2.0_aarch64.dmg']);
    expect(dmgAttachArgs('/scratch/r.dmg', '/scratch/mnt')).toEqual(['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', '/scratch/mnt', '/scratch/r.dmg']);
    // Every hdiutil attach of the script goes through dmgAttachArgs; no Finder scripting, no /Volumes.
    const js = readFileSync(join(APP, 'scripts', 'bundle.mjs'), 'utf8');
    expect(js.match(/'attach'/g)).toHaveLength(1);
    expect(js).not.toMatch(/osascript|AppleScript|['"`]\/Volumes/);
  });

  it('extended attributes: com.apple.provenance (kernel-kept) is ignored, anything else is a problem', async () => {
    const { foreignXattrs } = await bundleModule();
    expect(foreignXattrs('/a/Retake.app/Contents/MacOS/retake-desktop: com.apple.provenance\n/a/Retake.app/x: com.apple.provenance\n')).toEqual([]);
    expect(foreignXattrs('/a/Retake.app/x: com.apple.provenance\n/a/Retake.app/y: com.apple.quarantine\n/a/b: com.apple.FinderInfo\n')).toEqual(['/a/Retake.app/y: com.apple.quarantine', '/a/b: com.apple.FinderInfo']);
  });
});

/** A mini app laid out like the bundled one: Info.plist with our keys, a payload with a link, a shell binary. */
async function miniApp(name = 'Retake'): Promise<string> {
  const { LOCAL_NETWORK_USAGE } = (await import(pathToFileURL(join(APP, 'scripts', 'desktop.mjs')).href)) as any;
  const app = join(dir('mini-app'), `${name}.app`);
  put(app, 'Contents/MacOS/mini', readFileSync('/usr/bin/true'), 0o755);
  put(app, 'Contents/Info.plist', `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>mini</string><key>CFBundleIdentifier</key><string>com.example.mini</string><key>LSMinimumSystemVersion</key><string>15.0</string><key>NSLocalNetworkUsageDescription</key><string>${LOCAL_NETWORK_USAGE}</string></dict></plist>\n`);
  put(app, 'Contents/Resources/bundle.json', '{}');
  put(app, 'Contents/Resources/engine/dist/bin.js', 'js');
  symlinkSync('engine/dist', join(app, 'Contents', 'Resources', 'dist-link'));
  return app;
}

describe.runIf(MAC)('the app\'s checks beyond its signatures, and the DMG\'s (review B M2, review A L6)', () => {
  it('appProblems: Contents/Resources equals the signed payload byte for byte (links, files, nothing more); no AppleDouble file, no foreign attribute; Info.plist\'s minimum macOS and local network words', async () => {
    const { appProblems, treeDigest } = await bundleModule();
    const base = await miniApp();
    const digest = treeDigest(join(base, 'Contents', 'Resources'));
    expect(appProblems(base, { digest })).toEqual([]);
    const variant = (change: (app: string) => void) => {
      const app = join(dir('variant'), 'Retake.app');
      execFileSync('cp', ['-R', base, app]);
      change(app);
      return appProblems(app, { digest }).join('\n');
    };
    const R = (app: string, rel: string) => join(app, 'Contents', 'Resources', rel);
    expect(variant((a) => writeFileSync(R(a, 'icon.icns'), 'Tauri\'s icon'))).toBe(''); // what Tauri adds itself
    expect(variant((a) => rmSync(R(a, 'dist-link')))).toMatch(/Contents\/Resources: missing from the app — dist-link/);
    expect(variant((a) => {
      rmSync(R(a, 'dist-link'));
      symlinkSync('engine', R(a, 'dist-link'));
    })).toMatch(/changed since the payload was signed — dist-link/);
    expect(variant((a) => writeFileSync(R(a, 'engine/dist/bin.js'), 'edited'))).toMatch(/changed since the payload was signed — engine\/dist\/bin\.js/);
    expect(variant((a) => writeFileSync(R(a, 'extra.js'), ''))).toMatch(/not in the signed payload — extra\.js/);
    expect(variant((a) => writeFileSync(join(a, 'Contents', '._Info.plist'), ''))).toMatch(/Retake\.app\/Contents\/\._Info\.plist: an AppleDouble file/);
    expect(variant((a) => execFileSync('xattr', ['-w', 'com.example.tag', '1', R(a, 'bundle.json')]))).toMatch(/extended attributes: .*bundle\.json: com\.example\.tag/);
    expect(variant((a) => execFileSync('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Example;', a]))).toMatch(/extended attributes: .*com\.apple\.quarantine/);
    expect(variant((a) => execFileSync('plutil', ['-replace', 'LSMinimumSystemVersion', '-string', '14.0', join(a, 'Contents', 'Info.plist')]))).toMatch(/Info\.plist: LSMinimumSystemVersion 14\.0, not 15\.0/);
    expect(variant((a) => execFileSync('plutil', ['-remove', 'NSLocalNetworkUsageDescription', join(a, 'Contents', 'Info.plist')]))).toMatch(/Info\.plist: no local network words/);
  });

  it('verifyDmg: ULFO; attached read-only, the app verifies and is clean, the Applications link is there, nothing else at the root (dot files included)', async () => {
    const { verifyDmg, dmgCreateArgs } = await bundleModule();
    const app = await miniApp('Mini');
    execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp=none', '-s', '-', app], { stdio: 'ignore' });
    const make = (name: string, extra: (src: string) => void, format = 'ULFO') => {
      const src = dir(`dmg-src-${name}`);
      execFileSync('cp', ['-R', app, join(src, 'Mini.app')]);
      extra(src);
      const dmg = join(dirname(src), `${name}.dmg`);
      const args = dmgCreateArgs({ src, dmg, volname: 'Mini' });
      args[args.indexOf('-format') + 1] = format;
      execFileSync('hdiutil', args, { stdio: 'ignore' });
      return dmg;
    };
    const good = make('good', (src) => symlinkSync('/Applications', join(src, 'Applications')));
    expect(verifyDmg(good, join(tmp, 'mnt-good'), { env: process.env, product: 'Mini' })).toEqual([]);
    expect(readdirSync(join(tmp, 'mnt-good'))).toEqual([]); // detached
    const bad = make('bad', (src) => {
      writeFileSync(join(src, '.hidden'), 'x');
      symlinkSync('/Users', join(src, 'Applications'));
    }, 'UDZO');
    const p = verifyDmg(bad, join(tmp, 'mnt-bad'), { env: process.env, product: 'Mini' }).join('\n');
    expect(p).toMatch(/bad\.dmg: not ULFO \(UDZO\)/);
    expect(p).toMatch(/the DMG has no Applications link/);
    expect(p).toMatch(/the DMG holds \.hidden, Applications, Mini\.app/);
    expect(readdirSync(join(tmp, 'mnt-bad'))).toEqual([]);
  });
});

describe('the Tauri CLI from the pnpm store: every file pinned (review A M2)', () => {
  const blobOf = (store: string, data: string, exec = false) => {
    const hex = createHash('sha512').update(data).digest('hex');
    put(store, `files/${hex.slice(0, 2)}/${hex.slice(2)}${exec ? '-exec' : ''}`, data);
    return { integrity: `sha512-${Buffer.from(hex, 'hex').toString('base64')}`, mode: exec ? 0o755 : 0o644, size: data.length };
  };

  it('tauriCli rebuilds both packages from a store that matches the pins; a tampered blob, other (self-consistent) bytes, a wrong name or version, a path out of its package: refused', async () => {
    const { tauriCli, TAURI_CLI_VERSION } = await bundleModule();
    const { store, pins } = fakeTauriStore(TAURI_CLI_VERSION, 'console.log("tauri")\n');
    const dest = join(dir('cli-out'), 'tauri-cli');
    const js = tauriCli(dest, store, pins);
    expect(js).toBe(join(dest, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'));
    expect(readFileSync(js, 'utf8')).toBe('console.log("tauri")\n');
    expect(readFileSync(join(dest, 'node_modules', '@tauri-apps', 'cli-darwin-arm64', 'cli.darwin-arm64.node'), 'utf8')).toBe('native');
    // The store's own index is not trusted alone: an index and a blob rewritten together still fail the pins.
    const other = fakeTauriStore(TAURI_CLI_VERSION, 'console.log("someone else")\n');
    expect(() => tauriCli(dest, other.store, pins)).toThrow(new RegExp(`is not the pinned ${TAURI_CLI_VERSION.replace(/\./g, '\\.')} \\(apps/desktop/bundle/tauri-cli\\.json\\): its files or their sha512 differ`));
    // Tampered content under the right name: refused.
    const tampered = createHash('sha512').update('native').digest('hex');
    writeFileSync(join(store, 'files', tampered.slice(0, 2), tampered.slice(2)), 'evil');
    expect(() => tauriCli(dest, store, pins)).toThrow(/does not match its sha512/);
    // An index naming another package, or another version, under the expected file name: refused.
    const named = fakeTauriStore(TAURI_CLI_VERSION, 'x');
    const idxFile = join(named.store, 'index', '7f', `abc-@tauri-apps+cli@${TAURI_CLI_VERSION}.json`);
    const idx = JSON.parse(readFileSync(idxFile, 'utf8'));
    writeFileSync(idxFile, JSON.stringify({ ...idx, name: '../../x' }));
    expect(() => tauriCli(dest, named.store, named.pins)).toThrow(/it names \.\.\/\.\.\/x@/);
    writeFileSync(idxFile, JSON.stringify({ ...idx, version: '9.9.9' }));
    expect(() => tauriCli(dest, named.store, named.pins)).toThrow(/it names @tauri-apps\/cli@9\.9\.9/);
    // A file path out of its package, even pinned: refused, nothing written outside it.
    const escape = fakeTauriStore(TAURI_CLI_VERSION, 'x');
    const escIdx = join(escape.store, 'index', '7f', `abc-@tauri-apps+cli@${TAURI_CLI_VERSION}.json`);
    const e = JSON.parse(readFileSync(escIdx, 'utf8'));
    e.files['../../../outside.js'] = blobOf(escape.store, 'outside');
    writeFileSync(escIdx, JSON.stringify(e));
    escape.pins.packages['@tauri-apps/cli']['../../../outside.js'] = e.files['../../../outside.js'].integrity;
    const escDest = join(dir('cli-escape'), 'tauri-cli');
    expect(() => tauriCli(escDest, escape.store, escape.pins)).toThrow(/a file outside its package \(\.\.\/\.\.\/\.\.\/outside\.js\)/);
    expect(existsSync(join(dirname(escDest), 'outside.js'))).toBe(false);
    // Absent: the message says how to get it (once, with a network).
    expect(() => tauriCli(dest, dir('empty-store'), pins)).toThrow(/not in the pnpm store/);
  });

  it('the committed pins: both packages, every file a sha512 (the native binary and the JS entries among them); the CLI\'s major.minor is the tauri crate\'s (review B L4)', async () => {
    const { TAURI_CLI_PINS, TAURI_CLI_VERSION } = await bundleModule();
    expect(TAURI_CLI_PINS.v).toBe(1);
    expect(Object.keys(TAURI_CLI_PINS.packages).sort()).toEqual(['@tauri-apps/cli', '@tauri-apps/cli-darwin-arm64']);
    for (const files of Object.values(TAURI_CLI_PINS.packages) as Array<Record<string, string>>) for (const [f, sri] of Object.entries(files)) expect(sri, f).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    for (const f of ['tauri.js', 'main.js', 'index.js', 'package.json']) expect(TAURI_CLI_PINS.packages['@tauri-apps/cli'][f], f).toBeDefined();
    expect(TAURI_CLI_PINS.packages['@tauri-apps/cli-darwin-arm64']['cli.darwin-arm64.node']).toBeDefined();
    const crate = /^tauri\s*=\s*\{\s*version\s*=\s*"=?(\d+)\.(\d+)\./m.exec(readFileSync(join(APP, 'Cargo.toml'), 'utf8'));
    expect(crate, 'Cargo.toml pins the tauri crate').not.toBeNull();
    expect(TAURI_CLI_VERSION.split('.').slice(0, 2).join('.')).toBe(`${crate![1]}.${crate![2]}`);
  });
});

describe('the manifest, the pruned installers, the generated folder of the checkout', () => {
  it('refreshManifestHashes: bundle.json\'s sha256 values are the signed files\' (review B M3)', async () => {
    const { refreshManifestHashes } = await bundleModule();
    const d = dir('manifest');
    put(d, 'node/bin/node', 'signed node');
    put(d, 'ffmpeg/bin/ffmpeg', 'signed ffmpeg');
    put(d, 'ffmpeg/bin/ffprobe', 'signed ffprobe');
    put(d, 'bundle.json', JSON.stringify({ v: 1, app: '0.2.0', paths: { node: 'node/bin/node', ffmpeg: 'ffmpeg/bin' }, ffmpeg: { version: '8.0', sha256: { ffmpeg: 'stale', ffprobe: 'stale' } }, sha256: { node: 'stale' }, sizes: { node: 1 } }));
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    const m = refreshManifestHashes(d);
    const read = JSON.parse(readFileSync(join(d, 'bundle.json'), 'utf8'));
    expect(read).toEqual(m);
    expect(read.sha256).toEqual({ node: sha('signed node') });
    expect(read.ffmpeg).toEqual({ version: '8.0', sha256: { ffmpeg: sha('signed ffmpeg'), ffprobe: sha('signed ffprobe') } });
    expect(read.sizes).toEqual({ node: 1 });
    put(d, 'bundle.json', JSON.stringify({ v: 1, paths: { node: 'node/bin/node', ffmpeg: null }, ffmpeg: null, sha256: { node: 'stale' } }));
    expect(refreshManifestHashes(d)).toMatchObject({ ffmpeg: null, sha256: { node: sha('signed node') } });
  });

  it('the installer scripts nothing runs (playwright-core\'s sudo installers, the framework\'s install.sh) are pruned, and the layout check fails on them (review A L7)', async () => {
    const { prunedIn, checkStage, PRUNED } = await bundleModule();
    expect(PRUNED).toEqual(['engine/node_modules/playwright-core/bin', 'browsers/*/chrome-mac/Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/*/Resources/install.sh']);
    const d = dir('pruned');
    put(d, 'engine/node_modules/playwright-core/bin/reinstall_chrome_stable_mac.sh', '#!/bin/sh\nsudo true\n', 0o755);
    put(d, `${V}/Resources/install.sh`, '#!/bin/sh\n', 0o755);
    put(d, `${V}/Resources/Info.plist`, '<plist/>');
    expect(prunedIn(d).map((p: string) => p.slice(d.length + 1)).sort()).toEqual(['engine/node_modules/playwright-core/bin', `${V}/Resources/install.sh`].sort());
    const problems = checkStage(d, { machinePaths: [] }).problems.join('\n');
    expect(problems).toMatch(/engine\/node_modules\/playwright-core\/bin: an installer script the payload must not carry \(PRUNED\)/);
    expect(problems).toMatch(/Resources\/install\.sh: an installer script the payload must not carry/);
  });

  it('apps/desktop/gen (tauri-build writes it, git ignores it): the snapshot covers it, and the build puts it back as it was (review A L2)', async () => {
    const { repoSnapshot, saveGenerated, restoreGenerated, GENERATED } = await bundleModule();
    expect(GENERATED).toEqual(['apps/desktop/gen']);
    const repo = dir('fake-checkout');
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, '.gitignore'), 'gen/\n');
    const before = repoSnapshot(repo, ['gen']);
    put(repo, 'gen/schemas/a.json', '{}');
    const withGen = repoSnapshot(repo, ['gen']);
    expect(withGen).not.toBe(before);
    expect(withGen).toContain('!! gen/schemas/a.json');
    writeFileSync(join(repo, 'gen', 'schemas', 'a.json'), '{"changed":true}');
    expect(repoSnapshot(repo, ['gen'])).not.toBe(withGen);
    // Absent before: removed after.
    rmSync(join(repo, 'gen'), { recursive: true });
    const work = dir('gen-work');
    let saved = saveGenerated(repo, work, ['gen']);
    put(repo, 'gen/schemas/a.json', 'written by tauri-build');
    restoreGenerated(repo, saved);
    expect(existsSync(join(repo, 'gen'))).toBe(false);
    expect(repoSnapshot(repo, ['gen'])).toBe(before);
    // Present before: put back byte for byte, the copy removed.
    put(repo, 'gen/schemas/a.json', 'the developer app\'s');
    const kept = repoSnapshot(repo, ['gen']);
    saved = saveGenerated(repo, work, ['gen']);
    writeFileSync(join(repo, 'gen', 'schemas', 'a.json'), 'rewritten');
    put(repo, 'gen/schemas/b.json', 'new');
    restoreGenerated(repo, saved);
    expect(repoSnapshot(repo, ['gen'])).toBe(kept);
    expect(readdirSync(work)).toEqual([]);
  });
});
