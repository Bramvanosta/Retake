/**
 * L5.2 — the desktop shell's configuration, read statically (no Rust needed): what Tauri may give the page, and how
 * the app is built. The page must reach no app command: Tauri grants commands through capabilities (a `capabilities/`
 * folder or `app.security.capabilities` inline) and treats a page under `build.devUrl` / `build.frontendDist` as a
 * LOCAL origin (tauri webview `is_local_url`), which reaches app commands without one — so none of them exists, and
 * the Studio is an External URL (critique M6). The window keeps an ephemeral WebKit store (H2), WebKit's own drag &
 * drop (H1), a download handler that cancels every download (review A M1: without one, wry lets WebKit save a response
 * it cannot show into ~/Downloads), a permission handler that denies every media-capture request and an Info.plist with
 * no camera / microphone / location use (review A L2), no new-window handler (wry's default refuses), one `.eval` (the
 * `--route` setter), one `Command::new` (node, never a shell; a release build drops the code loaders from its
 * environment: review A L4), a panic hook writing to the real stderr (review B L7). The dependencies stay a short
 * allow-list, Tauri with no extra feature, cargo `--locked` everywhere (M9), never /Applications, an ad-hoc signature
 * only; the rules crate declares no `rust-version` (review B M4).
 * Prepared for the redesign (lead addendum): the menu from one command table binding no Studio shortcut (⌘R ⇧⌘R ⌘B ⌘.
 * ⌘S ⌘Enter stay the page's; no Reload; ⌘O and Window › Show Studio Window ⌘0 are the shell's: review B M3), one
 * title-bar switch (standard today), no forced theme, the app's name and bundle id in tauri.conf.json only, the binary
 * name in Cargo.toml only (review B L12).
 * L5.2b (job notifications, quit guard): two more dependencies, already in Cargo.lock (block2, objc2-user-notifications
 * with its feature list pinned: no new package); `applicationShouldTerminate:` added to the delegate class; UN called
 * only behind the bundle check and never in test mode; no `terminate:` from a Tauri closure (critique H1) — the test
 * hook sends it from its signal thread, and only while no question is up (GUARD_OPEN, H2), the restart alerts wait for
 * an open question, signals set QUIT_NOW before `app.exit` (M1), a panic in the hook answers Now (L7); still no
 * osascript, one `.eval`, one Command, no capability. Review fixes: every shell modal counted while it runs and ended by
 * a signal only while AppKit runs one (B M1), the hook answering Cancel while one is up (B L13), no picker inside a
 * question (B L10), the dead server's ports refused before its alert waits (B L11), test mode never for a launchd
 * launch (A L2), and the pipe's enum lists the same in TypeScript and Rust (B L8).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const APP = join(REPO, 'apps', 'desktop');
const read = (p: string) => readFileSync(join(APP, p), 'utf8');

/** Files under apps/desktop but the build output, the generated schemas and binary files. */
function files(dir = APP): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (['target', 'gen', 'node_modules'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (!/\.(png|icns|lock)$/.test(name)) out.push(p);
  }
  return out;
}

const rustSources = () => readdirSync(join(APP, 'src')).filter((f) => f.endsWith('.rs')).map((f) => read(join('src', f))).join('\n');

/** The `[section]` of a Cargo.toml as `name → value text` (one line per entry). */
function section(toml: string, name: string): Map<string, string> {
  const m = new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(toml);
  const entries = new Map<string, string>();
  for (const line of (m?.[1] ?? '').split('\n')) {
    const e = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line.trim());
    if (e) entries.set(e[1], e[2]);
  }
  return entries;
}

describe('desktop shell configuration (L5.2, static)', () => {
  it('tauri.conf.json: no window, no dev URL or frontend folder, no inline capability, no asset protocol, no plugin config; generic id', () => {
    const conf = JSON.parse(read('tauri.conf.json')) as Record<string, any>;
    expect(conf.identifier).toBe('local.demo-studio.desktop');
    expect(conf.productName).toBe('Demo Studio');
    expect(conf.app.windows).toEqual([]);
    expect(conf.app.withGlobalTauri).not.toBe(true);
    expect(conf.build).toEqual({});
    expect(conf.bundle.active).toBe(false);
    expect(Object.keys(conf.app.security ?? {})).toEqual(['csp']);
    expect(conf.plugins).toBeUndefined();
    expect(JSON.stringify(conf)).not.toMatch(/capabilit|assetProtocol|devUrl|frontendDist|dangerous|remote/i);
  });

  it('no capability anywhere: no capabilities/ folder, no file naming a remote capability; no command, handler or plugin in the shell', () => {
    expect(existsSync(join(APP, 'capabilities'))).toBe(false);
    for (const f of files()) {
      const text = readFileSync(f, 'utf8');
      expect(text, relative(REPO, f)).not.toMatch(/dangerousRemote|"remote"\s*:|\bremote\s*=\s*\{|"permissions"\s*:/);
    }
    const src = rustSources();
    expect(src).not.toMatch(/#\[tauri::command\]|invoke_handler|generate_handler!|\.plugin\(|open_devtools|\bdevtools\(/);
  });

  it('the window: ephemeral WebKit store, WebKit drag & drop, every download cancelled, every capture denied, no new-window handler, one eval, one Command (node)', () => {
    const src = rustSources();
    expect(src).toContain('.incognito(true)');
    expect(src).toContain('.disable_drag_drop_handler()');
    expect(src).toContain('.on_navigation(');
    expect(src).toContain('dc::navigation_decision(');
    // Review A M1: one download handler, and it answers false whatever the event (main frame and frames alike).
    expect(src.match(/\.on_download\(/g)).toHaveLength(1);
    const download = /\.on_download\(([\s\S]*?)\n\s*\}\)/.exec(src)?.[1] ?? '';
    expect(download).toMatch(/\n\s*false$/);
    expect(download).not.toMatch(/\btrue\b/);
    // Review A L2: every media-capture request denied.
    expect(src).toContain('.on_permission_request(|_, _| PermissionResponse::Deny)');
    expect(src).not.toMatch(/PermissionResponse::(?:Allow|Default)/);
    expect(src).not.toMatch(/on_new_window|on_web_resource_request|register_uri_scheme_protocol|initialization_script/);
    expect(src.match(/\.eval\(/g)).toHaveLength(1);
    expect(src.match(/Command::new\(/g)).toHaveLength(1);
    expect(src).toContain('Command::new(&cfg.node)');
    expect(src).not.toMatch(/"sh"|"\/bin\/sh"|"bash"|"-c"|osascript/);
    // Review A L4: a release build removes the code loaders from the child's environment.
    expect(read('src/child.rs')).toMatch(/if !cfg!\(debug_assertions\) \{\n\s*for \(k, _\) in std::env::vars_os\(\) \{\n\s*if k\.to_str\(\)\.is_some_and\(child_env_dropped\) \{\n\s*cmd\.env_remove\(&k\);/);
    // Review A L3: the origins are emptied when the owned server exits (before its alert), and an attached server is
    // probed on navigation (desktop-core navigation_decision → ServerGone).
    expect(src).toMatch(/fn server_exited\([\s\S]*?\*lock\(&shell\.allowed\) = dc::Allowed::NONE;[\s\S]*?restart_or_quit\(/);
    expect(src).toContain('let attached = (!session.server.owned()).then_some(line.pid);');
    expect(src).toMatch(/dc::Navigation::ServerGone => \{[\s\S]{0,200}?\*a = dc::Allowed::NONE;/);
    // Review B M1: Open Workspace… checks the folder before it stops anything, and never quits.
    const other = /fn open_other\([\s\S]*?\n\}\n/.exec(src)?.[0] ?? '';
    expect(other.indexOf('if !dc::is_workspace(&folder) {')).toBeGreaterThan(0);
    expect(other.indexOf('if !dc::is_workspace(&folder) {')).toBeLessThan(other.indexOf('.server.stop('));
    expect(other).not.toMatch(/\.exit\(/);
    // Review B L7: a panic writes to the real stderr itself (an abort would lose it in the filter's pipe).
    expect(read('src/logfilter.rs')).toMatch(/std::panic::set_hook\(Box::new\(move \|info\| \{[\s\S]{0,200}?libc::write\(original,/);
  });

  it('Cargo.toml: a short dependency allow-list, Tauri with no extra feature, objc2-app-kit without default features; the rules crate has no dependency', () => {
    const toml = read('Cargo.toml');
    expect([...section(toml, 'dependencies').keys()].sort()).toEqual(['block2', 'desktop-core', 'libc', 'objc2', 'objc2-app-kit', 'objc2-foundation', 'objc2-user-notifications', 'tauri']);
    // L5.2b: the notification crates without default features, their feature list pinned (L4: NSBundle declared, not
    // borrowed from tao's feature unification).
    expect(section(toml, 'dependencies').get('objc2-user-notifications')).toBe(
      '{ version = "0.3", default-features = false, features = ["std", "bitflags", "block2", "UNUserNotificationCenter", "UNNotification", "UNNotificationContent", "UNNotificationRequest", "UNNotificationResponse", "UNNotificationTrigger"] }',
    );
    expect(section(toml, 'dependencies').get('block2')).toBe('"0.6"');
    expect(section(toml, 'dependencies').get('objc2-foundation')).toBe('{ version = "0.3", default-features = false, features = ["std", "NSBundle", "NSError", "NSString", "NSURL"] }');
    expect([...section(toml, 'build-dependencies').keys()]).toEqual(['tauri-build']);
    const tauri = section(toml, 'dependencies').get('tauri')!;
    expect(tauri).toMatch(/features = \[\]/);
    expect(toml).not.toMatch(/protocol-asset|isolation|unstable|macos-private-api|devtools|tray-icon/);
    expect(section(toml, 'dependencies').get('objc2-app-kit')).toContain('default-features = false');
    expect(section(toml, 'features').get('custom-protocol')).toBe('["tauri/custom-protocol"]');
    expect(toml).toMatch(/^rust-version = "1\.90"$/m);
    const core = read('core/Cargo.toml');
    expect([...section(core, 'dependencies').keys()]).toEqual([]);
    // Review B M4: no MSRV on the rules crate (Tauri's 1.90 would turn `pnpm test` red on an older toolchain).
    expect(core).not.toMatch(/^rust-version/m);
    expect(core).toMatch(/^\[workspace\]$/m);
    for (const lock of ['Cargo.lock', 'core/Cargo.lock']) expect(existsSync(join(APP, lock)), lock).toBe(true);
    // Review B M4: the default suite checks the Xcode command line tools before it runs cargo (the cc shim would open
    // their install dialog), and the gated test probes cargo only when it is asked for.
    const coreTest = readFileSync(join(REPO, 'packages', 'cli', 'test', 'desktop-core.test.ts'), 'utf8');
    expect(coreTest.indexOf("spawnSync('xcode-select', ['-p']")).toBeGreaterThan(0);
    expect(coreTest.indexOf("spawnSync('xcode-select', ['-p']")).toBeLessThan(coreTest.indexOf("spawnSync('cargo'"));
    expect(readFileSync(join(REPO, 'packages', 'cli', 'test', 'desktop-shell.test.ts'), 'utf8')).toMatch(/const ENABLED = WANTED && existsSync\(CLI\) && spawnSync\('cargo'/);
    expect(read('Cargo.lock')).not.toMatch(/name = "tauri-plugin-/);
  });

  it('L5.2b: the quit guard and notifications — the hook added, UN behind the bundle check and never in test mode, no terminate from a Tauri closure', () => {
    const src = rustSources();
    const guard = read('src/guard.rs');
    const notify = read('src/notify.rs');
    const main = read('src/main.rs');
    // The hook: class_addMethod of applicationShouldTerminate: on the delegate's class, type "Q@:@"; a panic answers Now.
    expect(guard).toMatch(/objc2::ffi::class_addMethod\(cls as \*const AnyClass as \*mut AnyClass, sel!\(applicationShouldTerminate:\), imp, c"Q@:@"\.as_ptr\(\)\)/);
    expect(guard).toContain('std::panic::catch_unwind(decide).unwrap_or(NSApplicationTerminateReply::TerminateNow)');
    expect(main).toMatch(/guard::install\(&h\);\n\s*notify::install\(&h\);/);
    // UN: never in test mode, only in a bundle.
    const post = /fn post\(title: String, body: String\) \{[\s\S]*?\n\}\n/.exec(notify)?.[0] ?? '';
    expect(post.indexOf('if test_mode() {')).toBeGreaterThan(0);
    expect(post.indexOf('if test_mode() {')).toBeLessThan(post.indexOf('if !bundled() {'));
    expect(post.indexOf('if !bundled() {')).toBeLessThan(post.indexOf('currentNotificationCenter'));
    const install = /pub fn install\(app: &AppHandle\) \{[\s\S]*?\n\}\n/.exec(notify)?.[0] ?? '';
    expect(install.indexOf('if !test_mode() && bundled() {')).toBeGreaterThan(0);
    expect(install.indexOf('if !test_mode() && bundled() {')).toBeLessThan(install.indexOf('currentNotificationCenter'));
    expect(notify.match(/currentNotificationCenter\(\)/g)).toHaveLength(3);
    // add() posts: called only from post (its granted branch and the permission answer).
    expect(notify.match(/\badd\(&/g)).toHaveLength(2);
    for (const call of notify.match(/\badd\(&[^\n]*/g) ?? []) expect(post).toContain(call);
    expect(notify).toContain('UNAuthorizationOptions::Alert,');
    expect(notify).not.toMatch(/UNAuthorizationOptions::Sound|setSound/);
    // H1: no terminate inside a run_on_main_thread closure (bracket-matched arguments); the only terminate: is
    // request_terminate's performSelectorOnMainThread, called from the signal thread when no question is up (H2).
    for (let i = src.indexOf('run_on_main_thread('); i >= 0; i = src.indexOf('run_on_main_thread(', i + 1)) {
      let depth = 0;
      let j = i + 'run_on_main_thread'.length;
      do {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
        j++;
      } while (depth > 0 && j < src.length);
      expect(src.slice(i, j), src.slice(i, i + 80)).not.toMatch(/terminate|request_terminate/);
    }
    expect(src.match(/sel!\(terminate:\)/g)).toHaveLength(1);
    expect(guard).toMatch(/pub fn request_terminate\(\) \{[\s\S]{0,400}performSelectorOnMainThread: sel!\(terminate:\)/);
    expect(main.match(/guard::request_terminate\(\)/g)).toHaveLength(1);
    expect(main).toMatch(/libc::SIGUSR2 if test => \{\n\s*if guard::GUARD_OPEN\.load\(Ordering::SeqCst\) \{[\s\S]{0,200}\} else \{[\s\S]{0,120}guard::request_terminate\(\);/);
    // H2: the restart alerts wait while a question is up; M1: a signal sets QUIT_NOW before app.exit.
    expect(main).toMatch(/fn server_gone\([^)]*\) \{\n\s*if later_while_guard_open\(/);
    // Review B L11: the dead server's ports are refused before its alert is put off for an open question.
    const exited = /fn server_exited\([^)]*\) \{[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '';
    expect(exited.indexOf('*lock(&shell.allowed) = dc::Allowed::NONE;')).toBeGreaterThan(0);
    expect(exited.indexOf('*lock(&shell.allowed) = dc::Allowed::NONE;')).toBeLessThan(exited.indexOf('if later_while_guard_open('));
    // M1 / review B M1: a signal sets QUIT_NOW before app.exit, then ends whichever modal of the shell is up.
    expect(main).toMatch(/guard::QUIT_NOW\.store\(true, Ordering::SeqCst\);\n\s*app\.exit\(0\);\n[\s\S]{0,160}macos::end_modals\(\);/);
    const macos = read('src/macos.rs');
    // Every modal loop of the shell is counted while it runs (each runModal after a Modal::enter, after a quitting()
    // check), and ended only while AppKit says one runs (modalWindow): abortModal without one raises.
    const runs = [...macos.matchAll(/\.runModal\(\)/g)].map((m) => m.index!);
    expect(runs).toHaveLength(2);
    for (const at of runs) {
      const before = macos.slice(Math.max(0, at - 600), at);
      expect(before, macos.slice(at - 80, at)).toMatch(/let modal = Modal::enter\(\);\n\s*if quitting\(\) \{\n\s*return None;\n\s*\}/);
    }
    expect(macos).toMatch(/fn end_current\(\) \{[\s\S]{0,200}let Some\(window\) = app\.modalWindow\(\) else \{ return \};/);
    expect(macos.match(/abortModal\(\)/g)).toHaveLength(1);
    // Review B L13 / L10: the quit hook answers Cancel while any modal of the shell is up; Open Workspace… never opens
    // the picker inside one.
    expect(guard).toMatch(/fn decide\(\) -> NSApplicationTerminateReply \{\n\s*if GUARD_OPEN\.load\(Ordering::SeqCst\) \|\| crate::macos::modal_up\(\) \{/);
    expect(main).toMatch(/fn open_other\(app: &AppHandle\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if guard::GUARD_OPEN\.load\(Ordering::SeqCst\) \|\| macos::modal_up\(\) \{/);
    // Review A L2: test mode only with its variable and a parent other than launchd, decided at launch.
    expect(main).toContain('*MODE.get_or_init(|| dc::test_mode_allowed(std::env::var("DEMO_STUDIO_DESKTOP_TEST").ok().as_deref(), unsafe { libc::getppid() }))');
    expect(src.match(/std::env::var\("DEMO_STUDIO_DESKTOP_TEST"\)/g)).toHaveLength(1);
    // The guard's facts are an owned server's pipe only (an attached one has none: never its stale snapshot).
    expect(read('src/child.rs')).toContain('self.proc.as_ref().map(|_| lock(&self.pending).clone())');
  });

  it('L5.2b review B L8: the pipe enum lists are the same in TypeScript (server, page) and Rust (desktop_core pipe.rs)', () => {
    const ui = (f: string) => readFileSync(join(REPO, 'packages', 'ui', 'src', f), 'utf8');
    const tsList = (src: string, name: string) => {
      const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(src);
      expect(m, name).not.toBeNull();
      return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    };
    const pipe = read('core/src/pipe.rs');
    const rsList = (name: string) => {
      const m = new RegExp(`\\b${name} \\{([^}]*)\\}`).exec(pipe);
      expect(m, name).not.toBeNull();
      return [...m![1]!.matchAll(/([A-Z][A-Za-z]*) = "([a-z_]+)"/g)].map((x) => [x[1], x[2]] as const);
    };
    const supervise = ui('server/supervise.ts');
    const pairs: Array<[string, string]> = [
      ['PIPE_KINDS', 'JobKind'],
      ['PIPE_OUTCOMES', 'Outcome'],
      ['PIPE_REASONS', 'Reason'],
    ];
    for (const [ts, rs] of pairs) expect(rsList(rs).map((x) => x[1]), `${ts} / ${rs}`).toEqual(tsList(supervise, ts));
    expect(rsList('JobState').map((x) => x[1])).toEqual(['running', 'queued']);
    const unsaved = tsList(ui('server/unsaved.ts'), 'UNSAVED_KINDS');
    expect(rsList('UnsavedKind').map((x) => x[1])).toEqual(unsaved);
    // The page's own union (drafts.ts UnsavedItem) names the same kinds.
    const union = /kind: ((?:'[a-z_]+'(?: \| )?)+);/.exec(ui('app/drafts.ts'))![1]!;
    expect([...union.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toEqual(unsaved);
    // Each Rust variant is its wire name in CamelCase (yaml_draft is YamlDraft).
    for (const rs of ['JobKind', 'Outcome', 'Reason', 'UnsavedKind', 'JobState']) {
      for (const [variant, wire] of rsList(rs)) expect(variant, rs).toBe(wire.split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(''));
    }
  });

  it('the scripts: cargo always --locked through one call, never /Applications, ad-hoc signature only; root scripts and .gitignore', async () => {
    const js = read('scripts/desktop.mjs');
    expect(js.match(/spawnSync\('cargo'/g)).toHaveLength(1);
    expect(js).toMatch(/spawnSync\('cargo', \[\.\.\.args, '--locked', \.\.\.\(offline \? \['--offline'\] : \[\]\)/);
    expect(js).not.toMatch(/['"`]\/Applications|ditto|cargo install|rustup|npm (?:i|install)|curl|https?:\/\/(?!www\.apple\.com\/DTDs)/);
    const signs = [...js.matchAll(/'codesign', \[([^\]]*)\]/g)].map((m) => m[1]);
    expect(signs).toEqual(["'--force', '--sign', '-', app"]);
    const { infoPlist, BUNDLE_ID } = (await import(join(APP, 'scripts', 'desktop.mjs'))) as { infoPlist: (id: string, v: string) => string; BUNDLE_ID: string };
    const plist = infoPlist(BUNDLE_ID, '0.1.0');
    expect(plist).toContain('<key>CFBundleIdentifier</key>\n\t<string>local.demo-studio.desktop</string>');
    expect(plist).toContain('<key>NSLocalNetworkUsageDescription</key>');
    expect(plist).not.toMatch(/NSAppTransportSecurity|NSAllowsArbitraryLoads|entitlements/i);
    // Review A L2: no camera, microphone or location use declared (WebKit then exposes no capture device).
    expect(plist).not.toMatch(/NSCameraUsageDescription|NSMicrophoneUsageDescription|NSLocation\w*UsageDescription|NSScreenCaptureUsageDescription/);
    // Review B L3: clean removes both build folders and Tauri's gen/.
    expect(js).toContain("if (existsSync(coreTarget)) cargo(['clean'], CORE, coreTarget);");
    expect(js).toContain("rmSync(join(APP_DIR, 'gen'), { recursive: true, force: true });");
    expect(js).toContain('(BACKLOG BL-37)');
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const c of ['dev', 'build', 'test', 'clean']) expect(pkg.scripts[`desktop:${c}`]).toBe(`node apps/desktop/scripts/desktop.mjs ${c}`);
    const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8').split('\n');
    for (const p of ['apps/desktop/target/', 'apps/desktop/core/target/', 'apps/desktop/gen/']) expect(ignore).toContain(p);
  });

  it('prepared for the redesign: one command table, no Studio shortcut bound, one title-bar switch, no forced theme, name and id in one place', () => {
    const menu = read('src/menu.rs');
    const accelerators = [...menu.matchAll(/accelerator: Some\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(accelerators).toEqual(['CmdOrCtrl+O', 'CmdOrCtrl+0']);
    const src = rustSources();
    expect(src.match(/MenuItem::with_id\(/g)).toHaveLength(1);
    expect(src).toContain('menu::SHOW_WINDOW => show_window(app),');
    expect(src).not.toMatch(/\.reload\(|"reload"|CmdOrCtrl\+(?:Shift\+)?(?:R|B|S|Period|\.|Enter)"/);
    expect(menu).toMatch(/^pub const TITLE_BAR: TitleBar = TitleBar::Standard;$/m);
    expect(src.match(/title_bar_style\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/\.theme\(/);
    const code = (text: string) => text.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const f of [...readdirSync(join(APP, 'src')).map((x) => join('src', x)), 'scripts/desktop.mjs']) {
      expect(code(read(f)), f).not.toMatch(/Demo Studio|local\.demo-studio|demo-studio-desktop/);
    }
    expect(read('Cargo.toml')).toMatch(/^name = "demo-studio-desktop"$/m);
    expect(read('src/main.rs')).toContain('pub const BIN: &str = env!("CARGO_PKG_NAME");');
  });
});
