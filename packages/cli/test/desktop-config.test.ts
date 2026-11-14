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
 * osascript, one `.eval` (L5.9: two — the `--route` setter and a menu table's page command — and one constant
 * main-frame init script), one Command, no capability. Review fixes: every shell modal counted while it runs and ended by
 * a signal only while AppKit runs one (B M1), the hook answering Cancel while one is up (B L13), no picker inside a
 * question (B L10), the dead server's ports refused before its alert waits (B L11), test mode never for a launchd
 * launch (A L2), and the pipe's enum lists the same in TypeScript and Rust (B L8).
 * L5.12d: the quit question asked in the page — the detail's keys, the events and the id rule compared between the
 * shell (guard_flow.rs), the page (shell/quit.ts) and the server (desktop.ts); no TerminateLater; the page only for a
 * plain Quit on the Studio's origin (test mode's RETAKE_DESKTOP_TEST_QUIT=native aside); every exit closes it.
 * L5.16d: the updater — tauri-plugin-updater 2.14.0, optional, behind the cargo `updater` feature, registered only with
 * a feed and a key in the config (the only `.plugin(` of the shell; still no command, handler or capability); Help ›
 * Check for Updates…; Install and Restart as a quit through the guard; the lists of the update line and the click the
 * same in Rust and TypeScript; no `plugins.updater`, key, endpoint or real URL in the repository.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMAND_EVENT, MENU_COMMANDS } from '../../ui/src/app/ui-kit/commands.js';
import { QUIT_CLOSE_EVENT, QUIT_DETAIL_KEYS, QUIT_EVENT, QUIT_ID_RE as PAGE_QUIT_ID_RE, QUIT_LABEL_MAX, QUIT_TEXT_MAX } from '../../ui/src/app/shell/quit.js';
import { QUIT_ID_RE as SERVER_QUIT_ID_RE, SETUP_ACTIONS } from '../../ui/src/server/desktop.js';
import { SHELL_LINE_MAX } from '../../ui/src/server/shell-line.js';
import { SETUP_EVENT, SETUP_SECTIONS } from '../../ui/src/app/shell/setup.js';
import { UPDATE_EVENT } from '../../ui/src/app/shell/update.js';
import { UPDATE_ACTIONS, UPDATE_FAILURES, UPDATE_OFF_REASONS, UPDATE_STATES } from '../../ui/src/server/update-ops.js';
import { UPDATES_FILE, UPDATE_DISABLE_ENV } from '../../engine/src/integrations/app-setup.js';

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

const rustSources = () =>
  readdirSync(join(APP, 'src'))
    .filter((f) => f.endsWith('.rs'))
    .map((f) => read(join('src', f)))
    .join('\n');

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
    expect(conf.identifier).toBe('local.retake.desktop');
    expect(conf.productName).toBe('Retake');
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
    expect(src).not.toMatch(/#\[tauri::command\]|invoke_handler|generate_handler!|open_devtools|\bdevtools\(/);
    // L5.16d: one plugin, the updater, in a build with the `updater` feature and a configured feed only (its commands
    // stay unreachable: no capability grants them).
    expect([...src.matchAll(/\.plugin\(/g)].length).toBe(1);
    expect(read('src/update.rs')).toMatch(
      /#\[cfg\(feature = "updater"\)\]\s*\{\s*let _ = BUILT\.set\(configured\);\s*if configured \{\s*return builder\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\);/,
    );
  });

  it('the window: ephemeral WebKit store, WebKit drag & drop, every download cancelled, every capture denied, no new-window handler, one init script and two evals, one Command (node)', () => {
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
    expect(src).not.toMatch(/on_new_window|on_web_resource_request|register_uri_scheme_protocol|initialization_script_for_all_frames/);
    // L5.9: one init script, main frame only, a constant (the page's title-bar flag); two evals (--route; a page command).
    expect(src.match(/initialization_script\(/g)).toHaveLength(1);
    expect(src).toContain('.initialization_script(menu::SHELL_FLAG_JS)');
    expect(src.match(/\.eval\(/g)).toHaveLength(2);
    // L5.12d: the second eval is eval_in_window's — called with a menu table's page command or the quit flow's scripts only.
    expect(src).toMatch(/pub\(crate\) fn eval_in_window\(app: &AppHandle, js: String\) \{\n\s*if let Some\(w\) = app\.get_webview_window\(WINDOW\) \{\n\s*let _ = w\.eval\(js\);/);
    expect(src).toContain('if let Some(js) = menu::page_command_js(id) {\n                    eval_in_window(app, js);');
    // L5.16c: and the Help menu's Set-up sheet (desktop_core setup_page_js: a constant shape).
    // L5.16d: and Help › Check for Updates…'s `studio:update` (update_flow update_page_js: a constant).
    expect(src.match(/eval_in_window\(/g)).toHaveLength(6);
    expect(src).toContain('crate::eval_in_window(&h, uf::update_page_js());');
    expect(src).toContain('if let Some(js) = dc::setup::setup_page_js(section) {\n        eval_in_window(app, js);');
    expect(read('src/guard.rs').match(/crate::eval_in_window\(app, js\)/g)).toHaveLength(2);
    // L5.16c: and the first run's `retake init` — the same Node.js, both argv only.
    // L5.16d: plus the restart of test mode — the app's own binary, directly (never a shell, never LaunchServices).
    expect(src.match(/Command::new\(/g)).toHaveLength(3);
    expect(src.match(/Command::new\(&cfg\.node\)/g)).toHaveLength(2);
    expect(src.match(/std::process::Command::new\(&exe\)/g)).toHaveLength(1);
    expect(src).not.toMatch(/"sh"|"\/bin\/sh"|"bash"|"-c"|osascript/);
    // Review A L4: a release build removes the code loaders from the child's environment.
    expect(read('src/child.rs')).toMatch(
      /if !cfg!\(debug_assertions\) \{\n\s*for \(k, _\) in std::env::vars_os\(\) \{\n\s*if k\.to_str\(\)\.is_some_and\(child_env_dropped\) \{\n\s*cmd\.env_remove\(&k\);/,
    );
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
    expect([...section(toml, 'dependencies').keys()].sort()).toEqual([
      'block2',
      'desktop-core',
      'libc',
      'objc2',
      'objc2-app-kit',
      'objc2-foundation',
      'objc2-user-notifications',
      'serde_json',
      'tauri',
      'tauri-plugin-updater',
    ]);
    // L5.16d: the updater pinned and optional — only the `updater` feature (bundle.mjs, with a feed and a key) has it.
    expect(section(toml, 'dependencies').get('tauri-plugin-updater')).toBe('{ version = "=2.14.0", optional = true }');
    // serde_json: tauri::generate_context! embeds the config's `plugins` as serde_json values (an updater build only).
    expect(section(toml, 'dependencies').get('serde_json')).toBe('{ version = "1", optional = true }');
    expect(section(toml, 'features').get('updater')).toBe('["dep:tauri-plugin-updater", "dep:serde_json"]');
    expect(section(toml, 'features').get('default')).toBeUndefined();
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
    // L5.16d: the updater is the one Tauri plugin in the lockfile.
    expect([...read('Cargo.lock').matchAll(/name = "(tauri-plugin-[a-z-]+)"/g)].map((m) => m[1])).toEqual(['tauri-plugin-updater']);
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
    // L5.16c: the Set-up sheet's Allow… asks through UN too — never in test mode, only in a bundle.
    expect(notify.match(/currentNotificationCenter\(\)/g)).toHaveLength(4);
    const request = /pub fn request_permission\(_app: &AppHandle\) \{[\s\S]*?\n\}\n/.exec(notify)?.[0] ?? '';
    expect(request.indexOf('if test_mode() {')).toBeGreaterThan(0);
    expect(request.indexOf('if test_mode() {')).toBeLessThan(request.indexOf('if !bundled() {'));
    expect(request.indexOf('if !bundled() {')).toBeLessThan(request.indexOf('currentNotificationCenter'));
    // add() posts: called only from post (its granted branch and the permission answer).
    expect(notify.match(/\badd\(&/g)).toHaveLength(2);
    for (const call of notify.match(/\badd\(&[^\n]*/g) ?? []) expect(post).toContain(call);
    expect(notify).toContain('UNAuthorizationOptions::Alert,');
    expect(notify).not.toMatch(/UNAuthorizationOptions::Sound|setSound/);
    // H1: no terminate inside a run_on_main_thread closure (bracket-matched arguments); the only terminate: is
    // request_terminate's performSelectorOnMainThread, called from the signal thread when no question is up (H2).
    // L5.12d fixes: one exception, the flow's re-entry `run_on_main_thread(request_terminate)` — queued behind the
    // page's close script, it only POSTS terminate: (waitUntilDone NO), which arrives after the callback returned.
    expect(src.match(/run_on_main_thread\(request_terminate\)/g)).toHaveLength(1);
    expect(guard).toMatch(/pub fn request_terminate\(\) \{[\s\S]{0,400}waitUntilDone: Bool::NO\]/);
    for (let i = src.indexOf('run_on_main_thread('); i >= 0; i = src.indexOf('run_on_main_thread(', i + 1)) {
      if (src.startsWith('run_on_main_thread(request_terminate)', i)) continue;
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
    // (L5.12d: read first and handed to the flow, which answers Cancel then — guard_flow's own tests.)
    expect(guard).toMatch(/fn decide\(\) -> NSApplicationTerminateReply \{\n\s*let other_modal = GUARD_OPEN\.load\(Ordering::SeqCst\) \|\| crate::macos::modal_up\(\);/);
    expect(main).toMatch(/fn open_other\(app: &AppHandle\) \{\n(?:\s*\/\/[^\n]*\n)*\s*if guard::GUARD_OPEN\.load\(Ordering::SeqCst\) \|\| macos::modal_up\(\) \{/);
    // Review A L2: test mode only with its variable and a parent other than launchd, decided at launch.
    expect(main).toContain('*MODE.get_or_init(|| dc::test_mode_allowed(std::env::var("RETAKE_DESKTOP_TEST").ok().as_deref(), unsafe { libc::getppid() }))');
    expect(src.match(/std::env::var\("RETAKE_DESKTOP_TEST"\)/g)).toHaveLength(1);
    // The guard's facts are an owned server's pipe only (an attached one has none: never its stale snapshot).
    expect(read('src/child.rs')).toContain('self.proc.as_ref().map(|_| lock(&self.pending).clone())');
  });

  it("⚑ L5.12d: the quit question in the page — the detail's keys, events and id rule the same in Rust and the page; no TerminateLater; the page only for a plain Quit on the Studio's origin; every exit closes it", () => {
    const flow = read('core/src/guard_flow.rs');
    const guard = read('src/guard.rs');
    const main = read('src/main.rs');
    const src = rustSources();
    const rsKeys = (text: string) => [...(/pub const QUIT_DETAIL_KEYS: \[&str; \d+\] = \[([^\]]*)\];/.exec(text)?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(rsKeys(flow)).toEqual([...QUIT_DETAIL_KEYS]);
    // Planted: a key renamed on one side fails the comparison.
    expect(rsKeys(flow.replace('"destructive"]', '"danger"]'))).not.toEqual([...QUIT_DETAIL_KEYS]);
    // page_quit_js builds the detail from that list (no key of its own), and the events are the page's.
    expect(flow).toMatch(/let detail = QUIT_DETAIL_KEYS\.iter\(\)\.zip\(values\)/);
    expect(flow).toContain(`pub const QUIT_EVENT: &str = "${QUIT_EVENT}";`);
    expect(flow).toContain(`pub const QUIT_CLOSE_EVENT: &str = "${QUIT_CLOSE_EVENT}";`);
    // One bound for the question's words (review A-L1 / B-L1): the shell's — which its longest question fits (words.rs
    // the_longest_question_fits_the_page_bound) and past which it asks natively at once (page_fits) — is the page's.
    const rsConst = (text: string, name: string) => Number(new RegExp(`pub const ${name}: usize = ([0-9_]+);`).exec(text)?.[1]?.replace(/_/g, ''));
    expect(rsConst(flow, 'QUIT_TEXT_MAX')).toBe(QUIT_TEXT_MAX);
    expect(rsConst(flow, 'QUIT_LABEL_MAX')).toBe(QUIT_LABEL_MAX);
    expect(QUIT_TEXT_MAX).toBe(4000);
    expect(rsConst(flow.replace('QUIT_TEXT_MAX: usize = 4000', 'QUIT_TEXT_MAX: usize = 2000'), 'QUIT_TEXT_MAX')).not.toBe(QUIT_TEXT_MAX);
    expect(flow).toContain('if fallback || !a.page || !page_fits(&q) {');
    // One id rule: 22 base64url characters in the shell, the page and the server.
    expect(flow).toContain("s.len() == 22 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')");
    expect(String(PAGE_QUIT_ID_RE)).toBe('/^[A-Za-z0-9_-]{22}$/');
    expect(String(SERVER_QUIT_ID_RE)).toBe('/^[A-Za-z0-9_-]{22}$/');
    // No TerminateLater (critique H1: a reply from a tao callback hangs); the re-entry is request_terminate's post.
    expect(src.replace(/\/\/[^\n]*/g, '')).not.toMatch(/TerminateLater|replyToApplicationShouldTerminate/);
    expect(guard).toMatch(/Effect::Terminate => \{\n(?:\s*\/\/[^\n]*\n)*\s*let _ = app\.run_on_main_thread\(request_terminate\);/);
    // The page is asked for a plain Quit only (L5.16d: and Install and Restart's quit), on the Studio's own origin, unless
    // test mode keeps the native alert.
    expect(guard).toContain('let page = question.is_some() && matches!(action, Action::Quit | Action::Update) && page_question_on() && crate::window_on_studio(app);');
    expect(guard).toMatch(/fn page_question_on\(\) -> bool \{\n\s*!\(crate::test_mode\(\) && std::env::var\("RETAKE_DESKTOP_TEST_QUIT"\)/);
    expect(main).toMatch(/fn window_on_studio\([\s\S]{0,400}dc::loopback_port\(url\.as_str\(\)\)\.is_some_and\(\|\(p, _\)\| p == studio\)/);
    // The window is shown before the dispatch (the flow's effects in order: guard_flow tests), the id logged in test mode only.
    expect(guard).toMatch(/if crate::test_mode\(\) \{\n[^\n]*\n\s*log\(&format!\("\(test mode\) page question \{id\}"\)\);/);
    // The page's lines reach the flow from the owned server's pipe only.
    expect(src.match(/guard::from_page\(/g)).toHaveLength(1);
    expect(read('src/child.rs')).toMatch(/msg @ \(PipeMsg::Answer \{ \.\. \} \| PipeMsg::Shown \{ \.\. \}\) => \{\n\s*crate::guard::from_page\(msg\);/);
    // Every exit from a page question closes it: the server gone or exited, a signal, Open Workspace…'s question.
    expect(main).toMatch(/fn server_gone\([\s\S]{0,300}guard::drop_page_question\(app\);/);
    expect(/fn server_exited\([^)]*\) \{[\s\S]*?\n\}\n/.exec(main)?.[0]).toContain('guard::drop_page_question(app);');
    expect(main).toMatch(/macos::end_modals\(\);\n[^\n]*\n\s*guard::drop_page_question\(&app\);/);
    expect(guard).toMatch(/pub fn confirm_open_other\([\s\S]{0,400}drop_page_question\(app\);/);
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
    for (const [ts, rs] of pairs)
      expect(
        rsList(rs).map((x) => x[1]),
        `${ts} / ${rs}`,
      ).toEqual(tsList(supervise, ts));
    expect(rsList('JobState').map((x) => x[1])).toEqual(['running', 'queued']);
    const unsaved = tsList(ui('server/unsaved.ts'), 'UNSAVED_KINDS');
    expect(rsList('UnsavedKind').map((x) => x[1])).toEqual(unsaved);
    // The page's own union (drafts.ts UnsavedItem) names the same kinds.
    const union = /kind: ((?:'[a-z_]+'(?: \| )?)+);/.exec(ui('app/drafts.ts'))![1]!;
    expect([...union.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toEqual(unsaved);
    // Each Rust variant is its wire name in CamelCase (yaml_draft is YamlDraft).
    for (const rs of ['JobKind', 'Outcome', 'Reason', 'UnsavedKind', 'JobState']) {
      for (const [variant, wire] of rsList(rs))
        expect(variant, rs).toBe(
          wire
            .split('_')
            .map((w) => w[0]!.toUpperCase() + w.slice(1))
            .join(''),
        );
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
    expect(plist).toContain('<key>CFBundleIdentifier</key>\n\t<string>local.retake.desktop</string>');
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

  it("⚑ L5.13b: the icns's 16 and 32 pt slots are the drawn icons — all four required, each a PNG of its slot's size (no silent sips fallback)", async () => {
    type Drawn = { DRAWN_ICONS: Record<string, number>; drawnIconProblems: (dir?: string) => string[] };
    const { DRAWN_ICONS, drawnIconProblems } = (await import(join(APP, 'scripts', 'desktop.mjs'))) as Drawn;
    expect(DRAWN_ICONS).toEqual({ 'icon_16x16.png': 16, 'icon_16x16@2x.png': 32, 'icon_32x32.png': 32, 'icon_32x32@2x.png': 64 });
    // The committed iconset passes.
    expect(drawnIconProblems()).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'retake-drawn-'));
    try {
      const committed = join(APP, 'icons', 'iconset');
      const fill = () => {
        for (const f of Object.keys(DRAWN_ICONS)) copyFileSync(join(committed, f), join(dir, f));
      };
      fill();
      expect(drawnIconProblems(dir)).toEqual([]);
      // A missing file, a 32 px drawing in the 16 px slot, a file that is no PNG: each named.
      rmSync(join(dir, 'icon_32x32@2x.png'));
      copyFileSync(join(committed, 'icon_32x32.png'), join(dir, 'icon_16x16.png'));
      writeFileSync(join(dir, 'icon_16x16@2x.png'), 'not a png at all, but long enough');
      expect(drawnIconProblems(dir)).toEqual(['icon_16x16.png is 32×32, its slot needs 16×16', 'icon_16x16@2x.png is not a PNG', 'icon_32x32@2x.png is missing']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The build fails on any of them (never a sips downscale for a drawn slot).
    const js = read('scripts/desktop.mjs');
    expect(js).toContain("if (problems.length) fail(`apps/desktop/icons/iconset: ${problems.join('; ')} — run pnpm -F @retake/ui gen:mark`);");
    expect(js).toContain("if (file in DRAWN_ICONS) copyFileSync(join(APP_DIR, 'icons', 'iconset', file), join(set, file));");
  });

  it("prepared for the redesign: one command table, the Scenario menu's keys as page commands only, ⌘S and ⌘Enter left free, one title-bar switch, no forced theme, name and id in one place", () => {
    const menu = read('src/menu.rs');
    const accelerators = [...menu.matchAll(/accelerator: Some\("([^"]+)"\)/g)].map((m) => m[1]);
    // L5.9: the View menu's page commands (⌘K, ⌘1 – ⌘4, ⌥⌘I); L5.11a: the Scenario menu's Rehearse ⌘R, Capture ⇧⌘R,
    // Render ⌘B and Stop ⌘. (page commands: the page's bus gives them to their owner).
    expect(accelerators).toEqual([
      'CmdOrCtrl+O',
      'CmdOrCtrl+K',
      'CmdOrCtrl+1',
      'CmdOrCtrl+2',
      'CmdOrCtrl+3',
      'CmdOrCtrl+4',
      'Alt+CmdOrCtrl+I',
      'CmdOrCtrl+R',
      'Shift+CmdOrCtrl+R',
      'CmdOrCtrl+B',
      'CmdOrCtrl+.',
      'CmdOrCtrl+0',
    ]);
    const scenario = /\(\s*"Scenario",\s*&\[([\s\S]*?)\],\s*\),/.exec(menu)?.[1] ?? '';
    expect([...scenario.matchAll(/Item::Page \{ id: "([^"]+)", label: "([^"]+)", accelerator: Some\("([^"]+)"\) \}/g)].map((m) => [m[1], m[2], m[3]])).toEqual([
      ['rehearse', 'Rehearse', 'CmdOrCtrl+R'],
      ['capture', 'Capture', 'Shift+CmdOrCtrl+R'],
      ['render', 'Render', 'CmdOrCtrl+B'],
      ['stop', 'Stop', 'CmdOrCtrl+.'],
    ]);
    // Between View and Window.
    expect(menu.indexOf('"View",')).toBeLessThan(menu.indexOf('"Scenario",'));
    expect(menu.indexOf('"Scenario",')).toBeLessThan(menu.indexOf('("Window"'));
    const src = rustSources();
    expect(src.match(/MenuItem::with_id\(/g)).toHaveLength(2);
    expect(src).toContain('menu::SHOW_WINDOW => show_window(app),');
    // No Reload item, nothing bound to ⌘S or ⌘Enter (the page's own); the Scenario keys only as page commands.
    expect(src).not.toMatch(/\.reload\(|"reload"|CmdOrCtrl\+(?:Shift\+)?(?:S|Enter)"/);
    expect(src.replace(/Item::Page \{[^}]*\}/g, '')).not.toMatch(/CmdOrCtrl\+(?:R|B|Period|\.)"/);
    expect(menu).toMatch(/^pub const TITLE_BAR: TitleBar = TitleBar::Standard;$/m);
    expect(src.match(/title_bar_style\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/\.theme\(/);
    const code = (text: string) =>
      text
        .split('\n')
        .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
        .join('\n');
    for (const f of [...readdirSync(join(APP, 'src')).map((x) => join('src', x)), 'scripts/desktop.mjs']) {
      expect(code(read(f)), f).not.toMatch(/Retake|local\.retake|retake-desktop/);
    }
    expect(read('Cargo.toml')).toMatch(/^name = "retake-desktop"$/m);
    expect(read('src/main.rs')).toContain('pub const BIN: &str = env!("CARGO_PKG_NAME");');
  });

  it("⚑ L5.9: the menu's page commands are the page's MENU_COMMANDS (one list each side, compared); the flag script is a constant", () => {
    const menu = read('src/menu.rs');
    const page = [...menu.matchAll(/Item::Page \{ id: "([^"]+)", label: "[^"]+", accelerator: Some\("[^"]+"\) \}/g)].map((m) => m[1]);
    expect(page.sort()).toEqual([...MENU_COMMANDS].sort());
    expect(page).toHaveLength(MENU_COMMANDS.length);
    // The dispatch: only a Page id of MENUS, JSON-quoted into one constant shape.
    expect(menu).toContain('known.then(|| format!("window.dispatchEvent(new CustomEvent(\'studio:command\', {{ detail: {{ id: {} }} }}))", desktop_core::json::quote(id)))');
    expect(menu).toContain('matches!(i, Item::Page { id: p, .. } if *p == id)');
    expect(menu).toContain(`TitleBar::Standard => "window.__studioShell = Object.freeze({ titleBar: 'standard' });",`);
    expect(menu).toContain(`TitleBar::Overlay { .. } => "window.__studioShell = Object.freeze({ titleBar: 'overlay' });",`);
    expect(menu).toContain(`CustomEvent('${COMMAND_EVENT}'`);
    // Planted: an id the page does not know would fail the comparison.
    expect([...page, 'reload'].sort()).not.toEqual([...MENU_COMMANDS].sort());
  });
});

describe("L5.16c: the installed app's first run and Set-up sheet, shell side (static)", () => {
  it("the Help menu: Set Up …, Install / Uninstall the retake Command…, no keys, through the page's Set-up sheet", () => {
    const menu = read('src/menu.rs');
    const help = /\(\s*"Help",\s*&\[([\s\S]*?)\],\s*\),/.exec(menu)?.[1] ?? '';
    expect([...help.matchAll(/Item::Cmd \{ id: ([A-Z_]+), label: "([^"]+)", accelerator: None, enabled: true \}/g)].map((m) => [m[1], m[2]])).toEqual([
      ['SET_UP', 'Set Up {app}…'],
      ['CHECK_UPDATES', 'Check for Updates…'],
      ['CLI_INSTALL', 'Install the retake Command…'],
      ['CLI_REMOVE', 'Uninstall the retake Command…'],
    ]);
    expect(menu.indexOf('("Window"')).toBeLessThan(menu.indexOf('"Help",'));
    expect(menu).toContain('label.replace("{app}", name)');
    const main = read('src/main.rs');
    expect(main).toContain('id @ (menu::SET_UP | menu::CLI_INSTALL | menu::CLI_REMOVE) => setup_menu(app, id),');
    // Install from a misplaced app: the "move" alert first, never the sheet.
    expect(main).toMatch(/if id == menu::CLI_INSTALL && loc != dc::InstallLocation::Ok \{[\s\S]*?macos::alert\(dc::setup::MOVE_TO_APPLICATIONS/);
  });

  it('one list each side: the setup event, its sections and the setup actions of the pipe', () => {
    const rs = read('core/src/setup.rs');
    expect(rs).toContain(`pub const SETUP_SECTIONS: [&str; ${SETUP_SECTIONS.length}] = [${SETUP_SECTIONS.map((x) => `"${x}"`).join(', ')}];`);
    expect(rs).toContain(`CustomEvent('${SETUP_EVENT}'`);
    const pipe = read('core/src/pipe.rs');
    const actions = [...(/SetupAction \{ ([^}]+) \}/.exec(pipe)?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(actions).toEqual([...SETUP_ACTIONS]);
  });

  it("the first run: a bundled app without a workspace asks (Create ~/Retake · Choose a Folder… · Quit), Create runs the app's own retake init", () => {
    const main = read('src/main.rs');
    expect(main).toMatch(/None if bundled => match first_run\(&shell\)/);
    expect(main).toContain('macos::ask(dc::setup::FIRST_RUN_TITLE, &text, &dc::setup::FIRST_RUN_BUTTONS, 2, &[])');
    const child = read('src/child.rs');
    expect(child).toContain('cmd.arg(&cfg.cli).arg("init").arg(dir)');
    expect(child).toMatch(/pub fn init_workspace[\s\S]*?cmd\.arg\("--require"\)\.arg\(preload\)[\s\S]*?child_env_dropped/);
    // The folder panel's answer goes on the server's stdin as the core's line, never a path from the page.
    expect(main).toContain('picked.as_deref().and_then(dc::setup::cli_folder_line)');
  });
});

describe('L5.16d: the updater, shell side (static)', () => {
  it('Help › Check for Updates…, the update click from the pipe, Install and Restart through the quit guard, the swap at the exit', () => {
    const main = read('src/main.rs');
    expect(main).toContain('menu::CHECK_UPDATES => update::check_menu(app),');
    expect(main).toContain('let app = update::register(tauri::Builder::default(), &context)');
    // The swap runs after the owned server stopped (RunEvent::Exit), never before.
    expect(main).toMatch(/Some\(s\) if s\.server\.owned\(\) => s\.server\.stop\("quit"\),[\s\S]{0,400}?update::finish\(h\);/);
    expect(read('src/child.rs')).toContain('PipeMsg::Update(a) => {\n                    crate::update_request(a);');
    const guard = read('src/guard.rs');
    // Review d A-M1: the hook takes the quit for the update (update_flow Arm: then no clock).
    expect(guard).toContain('let action = if reason.is_none() && crate::update::take_quit() { Action::Update } else { quit_action(reason) };');
    // Approved only on Now without a signal, or the person's Install and Restart; every Cancel disarms — a page
    // question dropped too (review d A-L1).
    expect(guard).toMatch(/Reply::Now => \{[\s\S]{0,300}?if update && !quit_now \{\s*crate::update::approved\(\);/);
    expect([...guard.matchAll(/crate::update::cancelled\(app\)/g)].length).toBe(4);
    expect(guard).toMatch(/pub fn drop_page_question\(app: &AppHandle\) \{[\s\S]*?run\(app, fx\);\s*crate::update::cancelled\(app\);\s*\}/);
    const upd = read('src/update.rs');
    // Review d A-L1: the update never arms while a quit question is up in the page (its answer would install).
    expect(upd).toContain('if guard::GUARD_OPEN.load(Ordering::SeqCst) || macos::modal_up() || guard::page_question_up() {');
    // Test mode restarts the binary directly. Outside it (hotfix v0.2.4, BL-168) a detached relaunch of the bundle once
    // this process has ended (the app keeps its Dock icon); Tauri's restart only when that cannot start, the log filter
    // flushed first (review d A-L6: the restart exits the process).
    expect(upd).toMatch(
      /fn restart\(app: &AppHandle\) \{\s*if test_mode\(\) \{[\s\S]*?std::process::Command::new\(&exe\)[\s\S]*?return;\s*\}\s*let bundle = [^\n]*dc::relaunch::is_bundle\(b\)\);\s*if let Some\(bundle\) = bundle \{[\s\S]*?dc::relaunch::Relaunch::after_this_process\(bundle, args\)\.spawn\(\) \{\s*Ok\(c\) => \{\s*log\([\s\S]*?\);\s*return;\s*\}\s*Err\(e\) => log\([\s\S]*?\),\s*\}\s*\}\s*crate::logfilter::finish\(\);\s*app\.restart\(\);\s*\}/,
    );
    expect(upd).not.toMatch(/\/usr\/bin\/open|osascript/);
    // …with the real stderr: the log filter's pipe dies with the old process (the e2e test's first run lost every line).
    expect(upd).toContain('if let Some(err) = crate::logfilter::real_stderr() {\n            cmd.stderr(err);');
    // The launch check starts once the first workspace is served (an install never races the start).
    expect(main).toMatch(/Some\(s\) => show\(&h, &shell, s\),[\s\S]{0,600}?update::start\(&h, shell\.home\.clone\(\), loc\);/);
    // The test hook only in test mode and an e2e build (review d A-L7); the install only after the guard approved it.
    expect(upd).toContain('if uf::test_install_allowed(test_mode(), std::env::var("RETAKE_DESKTOP_TEST_UPDATE").ok().as_deref(), test_feed()) {');
    expect(upd).toContain('let _ = TEST_FEED.set(uf::is_test_feed(insecure, &endpoints));');
    expect(upd).toMatch(/match uf::exit_step\(arm, have\) \{\s*Exit::Nothing => \{\}/);
    // Review d A-M2: the check's timeout, the download's own limits (no request timeout on the body), https only, Later
    // aborts it; A-M4: the archive kept on disk, read back and verified again at the exit.
    // L5.16f: the check's and the download's client (the found update keeps the builder's) is https only at every hop —
    // GitHub's releases answer with a redirect to their download host — but in the e2e build.
    expect(upd).toContain('let https = uf::https_only(test_feed());\n    let u = app.updater_builder().timeout(uf::CHECK_TIMEOUT).configure_client(move |b| b.https_only(https)).build()');
    expect([...upd.matchAll(/updater_builder\(\)/g)].length).toBe(1);
    // Review f A-L8 / B-L4: no test sends an https request offline (no TLS listener here), so that an http hop is refused
    // rests on reqwest: its redirect policy checks `https_only` at every hop (src/redirect.rs, TowerRedirectPolicy), in
    // the version Cargo.lock pins — and the plugin applies the builder's client to the check and the download. A bump of
    // either fails here until that is checked again; the locked source is read when cargo has it.
    const lock = read('Cargo.lock');
    const locked = (name: string) => new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(lock)?.[1];
    expect({ reqwest: locked('reqwest'), plugin: locked('tauri-plugin-updater') }).toEqual({ reqwest: '0.13.3', plugin: '2.14.0' });
    const registry = join(process.env.CARGO_HOME || join(homedir(), '.cargo'), 'registry', 'src');
    for (const index of existsSync(registry) ? readdirSync(registry) : []) {
      const redirect = join(registry, index, 'reqwest-0.13.3', 'src', 'redirect.rs');
      if (existsSync(redirect)) expect(readFileSync(redirect, 'utf8')).toMatch(/if self\.https_only && next_url\.scheme\(\) != "https" \{\s*return Err\(crate::error::redirect\(/);
      const updater = join(registry, index, 'tauri-plugin-updater-2.14.0', 'src', 'updater.rs');
      if (existsSync(updater))
        expect([...readFileSync(updater, 'utf8').matchAll(/if let Some\(ref configure_client\) = self\.context\.configure_client \{\s*request = configure_client\(request\);/g)].length).toBe(2);
    }
    expect(upd).toContain('f.timeout = None;');
    // Hotfix v0.2.4 (BL-167): the same limits, each new byte count reported to the Studio (`watch_reporting`).
    expect(upd).toContain('let stop = uf::watch_reporting(&progress, &uf::DOWNLOAD, || task.inner().is_finished(), || GEN.load(Ordering::SeqCst) != gen, report);');
    expect(upd).toMatch(/Some\(s\) => \{\s*task\.abort\(\);/);
    expect(upd).toMatch(/if f\.download_url\.scheme\(\) != "https" && !\(test_feed\(\) && f\.download_url\.as_str\(\)\.starts_with\("http:\/\/127\.0\.0\.1:"\)\) \{\s*return Err/);
    expect(upd).toContain('uf::write_archive(&cache, std::process::id(), &bytes)');
    expect(upd).not.toMatch(/bytes: Option<Vec<u8>>/);
    expect(upd).toMatch(/f\.install\(bytes\)\.map_err/);
    // Review d A-L3: the native alert never shows the feed's notes.
    expect(upd).toContain('uf::available_alert(app_name(), &current(app), version);');
    // Review d B-M1: Help's check refused (and said) while an install is under way.
    expect(upd).toContain('uf::check_refused(&u.state, app_name())');
  });

  it('one list each side: the update event, its states, reasons, failures and clicks, the remembered file, the disable variable', () => {
    const flow = read('core/src/update_flow.rs');
    expect(flow).toContain(`pub const UPDATE_EVENT: &str = "${UPDATE_EVENT}";`);
    expect(flow).toContain(`pub const UPDATES_FILE: &str = "${UPDATES_FILE}";`);
    expect(flow).toContain(`pub const DISABLE_ENV: &str = "${UPDATE_DISABLE_ENV}";`);
    const wire = (fn: string) => [...(new RegExp(`pub fn ${fn}\\(self\\) -> &'static str \\{[\\s\\S]*?\\n    \\}`).exec(flow)?.[0] ?? '').matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1]);
    expect(wire('wire').length).toBeGreaterThan(0);
    const off = /impl Off \{[\s\S]*?\n\}/.exec(flow)?.[0] ?? '';
    expect([...off.matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1])).toEqual([...UPDATE_OFF_REASONS]);
    const failure = /impl Failure \{[\s\S]*?\n\}/.exec(flow)?.[0] ?? '';
    expect([...(/pub fn wire\(self\)[\s\S]*?\n    \}/.exec(failure)?.[0] ?? '').matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1])).toEqual([...UPDATE_FAILURES]);
    const states = [...flow.matchAll(/head\("([a-z]+)"\)/g)].map((m) => m[1]);
    expect([...states].sort()).toEqual([...UPDATE_STATES].sort());
    const pipe = read('core/src/pipe.rs');
    expect([...(/UpdateAction \{ ([^}]+) \}/.exec(pipe)?.[1] ?? '').matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...UPDATE_ACTIONS]);
    // Review d B-L4: the stdin line cap in bytes, the same number on both sides.
    expect(read('core/src/setup.rs')).toContain(`pub const SHELL_LINE_MAX: usize = ${SHELL_LINE_MAX};`);
  });

  it('nothing of a feed in the repository: no plugins.updater, key or endpoint in the config, the crates or the shell; no real URL', () => {
    const conf = read('tauri.conf.json');
    expect(JSON.parse(conf).plugins).toBeUndefined();
    const sources = [conf, read('Cargo.toml'), read('core/Cargo.toml'), rustSources(), ...readdirSync(join(APP, 'core', 'src')).map((f) => read(join('core', 'src', f)))].join('\n');
    expect(sources).not.toMatch(/"pubkey"\s*:|"endpoints"\s*:|untrusted comment: minisign|RW[A-Za-z0-9+/]{50,}|dW50cnVzdGVkIGNvbW1lbnQ6/);
    // Every host named: an IP literal or a one-label name (the rules' tests), an example / .test name, Tauri's schema.
    for (const m of sources.matchAll(/https?:\/\/(?:[^/@\s"']*@)?(\[[^\]\s]*\]?|[^/:\s"'<>)\]]+)/g)) {
      expect(m[1], m[0]).toMatch(/^(?:\[.*|[\d.]+|[a-z0-9-]+|(?:[a-z0-9.-]+\.)?example\.(?:com|net|org)|[a-z0-9.-]+\.(?:example|test)|schema\.tauri\.app|\{[^}]*\}?)$/);
    }
    // The bundle's scripts carry no key or real host either (the feed and the key come from the environment).
    const scripts = ['scripts/bundle.mjs', 'scripts/sign.mjs'].map(read).join('\n') + readFileSync(join(REPO, 'scripts', 'publish-update.mjs'), 'utf8');
    expect(scripts).not.toMatch(/RW[A-Za-z0-9+/]{50,}|dW50cnVzdGVkIGNvbW1lbnQ6|updates\.[a-z]+\.(?:com|dev|net|org|io)/);
  });
});
