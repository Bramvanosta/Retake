//! Demo Studio's desktop shell (L5.2, DESIGN §4j): a macOS window on the workspace's own Studio server — nothing in
//! Rust but OS glue. It runs `node <cli> --root <workspace> ui --supervised` (the Node.js and CLI pinned by
//! `pnpm desktop:build` in launch.json), opens a WKWebView window on the one-time URL that prints, and holds no token:
//! the page redeems its code and keeps its token in its own sessionStorage, as in a browser.
//!
//! - The page gets no IPC command (no capability, no command handler), its WebKit store is ephemeral
//!   (`incognito`: nothing of the filmed product lands in ~/Library), the drag-drop handler is off (the Studio's block
//!   drag & drop needs WebKit's own), every frame's navigation is held to the Studio's and the player's origins (none
//!   once the server stopped), every download is cancelled and every media-capture request denied.
//! - Owned server (it serves): Quit (menu, ⌘Q, SIGTERM / SIGINT / SIGHUP) stops it — SIGTERM and EOF, SIGKILL after
//!   5 s; a crash of the app is its stdin's EOF, so it stops too. Attached (another process already serves the
//!   workspace): never stopped, not watched. The shared jobs worker is never the app's: it finishes its jobs.
//! - Closing the window hides it (the page and its event stream stay alive); the Dock icon or Window › Show Studio
//!   Window (⌘0) shows it again.
//! - Workspace: `--root`, DEMO_STUDIO_ROOT, the last one opened (`<studio home>/desktop.json`), the current folder's
//!   studio.yaml, else the folder picker; File › Open Workspace… switches (a folder that is no workspace changes
//!   nothing; the owned server stops first; a start that fails reopens the previous workspace — never a quit).
//! - Printed: origins only — never the one-time URL, a capability path or the token (log filter, desktop_core::redact).

mod child;
mod logfilter;
mod macos;
mod menu;

use desktop_core as dc;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::webview::{DownloadEvent, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const WINDOW: &str = "main";

/// The binary's name (Cargo.toml `name`): the prefix of every line the shell prints, in one place (review B L12).
pub const BIN: &str = env!("CARGO_PKG_NAME");

/// The app's name: tauri.conf.json `productName`, its one place (the bundle id is its `identifier`; desktop.mjs reads
/// both from there).
static APP_NAME: OnceLock<String> = OnceLock::new();
pub fn app_name() -> &'static str {
    APP_NAME.get().map(String::as_str).unwrap_or("the app")
}

fn pick_message() -> String {
    format!("Choose the folder of a {} workspace (it holds studio.yaml or a projects/ folder).", app_name())
}

/// DEMO_STUDIO_DESKTOP_TEST=1: no modal dialog ever (tests), `--route` is honoured in a release build, and SIGUSR1 is
/// File › Open Workspace… (the picker answers DEMO_STUDIO_DESKTOP_TEST_PICK once: macos.rs).
pub fn test_mode() -> bool {
    std::env::var("DEMO_STUDIO_DESKTOP_TEST").as_deref() == Ok("1")
}

pub fn log(msg: &str) {
    eprintln!("{BIN}: {msg}");
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
struct Args {
    root: Option<String>,
    route: Option<String>,
}

fn parse_args() -> Args {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(x) = it.next() {
        match x.as_str() {
            "--root" => a.root = it.next(),
            "--route" => a.route = it.next(),
            _ => {
                if let Some(v) = x.strip_prefix("--root=") {
                    a.root = Some(v.to_string());
                } else if let Some(v) = x.strip_prefix("--route=") {
                    a.route = Some(v.to_string());
                }
            }
        }
    }
    a
}

struct Session {
    server: child::Server,
    workspace: PathBuf,
    source: dc::Source,
}

struct Shell {
    cfg: dc::LaunchConfig,
    home: Option<PathBuf>,
    session: Mutex<Option<Session>>,
    /// The origins the window may navigate to (`Allowed::NONE` once the server stopped).
    allowed: Arc<Mutex<dc::Allowed>>,
    /// The `--route` hash, set once on the first page (debug builds and tests).
    route: Mutex<Option<String>>,
}

/// Start the server of `candidate`, else of a picked folder, until one serves; None when the person cancels (or quits,
/// on the `first` launch).
fn open(shell: &Shell, mut candidate: Option<(PathBuf, dc::Source)>, mut note: Option<String>, first: bool) -> Option<Session> {
    loop {
        let (ws, source) = match candidate.take() {
            Some(c) => c,
            None => (macos::pick_folder(&note.take().unwrap_or_else(pick_message))?, dc::Source::Picker),
        };
        let ws = std::fs::canonicalize(&ws).unwrap_or(ws);
        log(&format!("workspace {} ({})", ws.display(), source.label()));
        match child::start(&shell.cfg, &ws) {
            Ok(server) => {
                let l = &server.line;
                if server.owned() {
                    log(&format!("the Studio server serves {} (pid {}, owned: Quit stops it)", dc::origin(l.port), l.pid));
                } else {
                    log(&format!(
                        "attached to the Studio server of pid {} on {} (not watched: Quit leaves it running; if it stops, open the workspace again)",
                        l.pid,
                        dc::origin(l.port)
                    ));
                }
                if let Some(h) = &shell.home {
                    if let Err(e) = dc::write_remembered(h, &ws) {
                        log(&format!("could not remember the workspace: {e}"));
                    }
                }
                return Some(Session { server, workspace: ws, source });
            }
            Err(child::StartError::NotWorkspace(_)) => {
                log(&format!("{} is not a workspace", ws.display()));
                note = Some(format!("{} is not a {} workspace (no studio.yaml or projects/ folder). Choose another folder.", ws.display(), app_name()));
            }
            Err(e) => {
                log("the Studio server did not start");
                let text = format!("{}\n\nWorkspace: {}", e.text(), ws.display());
                if macos::alert("The Studio could not start", &text, &["Choose Another Folder…", if first { "Quit" } else { "Cancel" }]) != 0 {
                    return None;
                }
            }
        }
    }
}

fn workspace_title(ws: &Path) -> String {
    format!("{} — {}", app_name(), ws.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| ws.display().to_string()))
}

/// Point the window at a session's server (creating the window the first time), watch an owned server.
fn show(app: &AppHandle, shell: &Arc<Shell>, session: Session) {
    let line = session.server.line.clone();
    let attached = (!session.server.owned()).then_some(line.pid);
    *lock(&shell.allowed) = dc::Allowed { studio: line.port, player: line.player_port, attached };
    let url: tauri::Url = match line.url.parse() {
        Ok(u) => u,
        Err(_) => {
            log("the server's URL does not parse");
            app.exit(1);
            return;
        }
    };
    let title = workspace_title(&session.workspace);
    let window = match app.get_webview_window(WINDOW) {
        Some(w) => {
            let _ = w.navigate(url);
            let _ = w.set_title(&title);
            let _ = w.show();
            let _ = w.set_focus();
            Some(w)
        }
        None => {
            let (allowed, h) = (shell.allowed.clone(), app.clone());
            // No theme set: the window is the system's appearance (DarkAqua in Dark mode: alerts, the picker, menus)
            // and WebKit gives the page its `prefers-color-scheme`, but the standard title bar takes the colour of the
            // page's top (WKWebView, macOS 26: review B M2) — light today, the Studio pins `color-scheme: light`. The
            // title bar's style is menu::TITLE_BAR.
            let built = menu::title_bar(WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(url)))
                .title(&title)
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                // An ephemeral WebKit store (critique H2): no cache of capture media, no per-port storage in ~/Library.
                .incognito(true)
                // WebKit's own drag & drop (critique H1): Tauri's handler would swallow the Studio's block drags.
                .disable_drag_drop_handler()
                .on_navigation(move |u| {
                    let mut a = lock(&allowed);
                    match dc::navigation_decision(u.as_str(), *a, pid_alive) {
                        dc::Navigation::Allow => true,
                        dc::Navigation::Refuse => {
                            log(&format!("refused a navigation to {}", dc::redact(u.as_str())));
                            false
                        }
                        dc::Navigation::ServerGone => {
                            // Review A L3: the attached server is gone; its port is nobody's now.
                            let pid = a.attached.unwrap_or(0);
                            *a = dc::Allowed::NONE;
                            log(&format!("refused a navigation to {}: the attached Studio server (pid {pid}) is gone", dc::redact(u.as_str())));
                            let h2 = h.clone();
                            let _ = h.run_on_main_thread(move || server_gone(&h2, pid));
                            false
                        }
                    }
                })
                // Review A M1: wry answers Allow to a response WebKit cannot show when no download handler is set, and
                // WebKit then saves it in ~/Downloads; with this handler every download (main frame or frame) is
                // routed to wry's download delegate and cancelled.
                .on_download(|_, event| {
                    if let DownloadEvent::Requested { url, .. } = event {
                        log(&format!("refused a download of {}", dc::redact(url.as_str())));
                    }
                    false
                })
                // Review A L2: wry grants every media-capture request when no handler is set; none is ever granted.
                .on_permission_request(|_, _| PermissionResponse::Deny)
                .build();
            match built {
                Ok(w) => Some(w),
                Err(e) => {
                    log(&format!("the window could not be opened: {e}"));
                    app.exit(1);
                    None
                }
            }
        }
    };
    if session.server.owned() {
        let (h, pid) = (app.clone(), line.pid);
        session.server.watch(move |status, tail| {
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || server_exited(&h2, pid, status, tail));
        });
    }
    if let (Some(w), Some(route)) = (window, lock(&shell.route).take()) {
        set_route(w, line.port, route);
    }
    *lock(&shell.session) = Some(session);
}

/// `--route`: once the page has taken its code out of the URL, go to that screen (debug builds and tests only).
fn set_route(w: tauri::WebviewWindow, studio_port: u16, route: String) {
    if !(cfg!(debug_assertions) || test_mode()) {
        log("--route is ignored by a release build");
        return;
    }
    if !dc::route_ok(&route) {
        log("--route refused: #/ and letters, digits, / _ . - only");
        return;
    }
    thread::spawn(move || {
        for _ in 0..150 {
            thread::sleep(Duration::from_millis(200));
            let Ok(u) = w.url() else { continue };
            let s = u.as_str();
            if matches!(dc::loopback_port(s), Some((p, _)) if p == studio_port) && !s.contains("#c=") {
                thread::sleep(Duration::from_millis(500));
                let _ = w.eval(format!("location.hash = {}", dc::json::quote(&route)));
                log("route set");
                return;
            }
        }
        log("route not set: the page did not load");
    });
}

/// kill(pid, 0): the process exists (EPERM: it does, another user's).
fn pid_alive(pid: u32) -> bool {
    pid > 0 && (unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

/// Restart (a server this app owns, on the same workspace) or Quit.
fn restart_or_quit(app: &AppHandle, shell: &Arc<Shell>, title: &str, text: &str, ws: PathBuf, source: dc::Source) {
    if macos::alert(title, text, &["Restart", "Quit"]) == 0 {
        lock(&shell.session).take();
        match open(shell, Some((ws, source)), None, true) {
            Some(s) => show(app, shell, s),
            None => app.exit(0),
        }
    } else {
        app.exit(0);
    }
}

/// A navigation found the attached server gone (review A L3).
fn server_gone(app: &AppHandle, pid: u32) {
    let shell = app.state::<Arc<Shell>>().inner().clone();
    let current = match &*lock(&shell.session) {
        Some(x) if !x.server.owned() && x.server.line.pid == pid => Some((x.workspace.clone(), x.source)),
        _ => None,
    };
    let Some((ws, source)) = current else { return };
    let text = format!("The Studio server this window was attached to (pid {pid}) is gone. Restart opens the workspace with a server of this app.");
    restart_or_quit(app, &shell, "The Studio server stopped", &text, ws, source);
}

/// The owned server exited while not being stopped: say so, Restart or Quit.
fn server_exited(app: &AppHandle, pid: u32, status: std::process::ExitStatus, tail: String) {
    let shell = app.state::<Arc<Shell>>().inner().clone();
    let current = {
        let s = lock(&shell.session);
        match &*s {
            Some(x) if x.server.line.pid == pid => Some((x.workspace.clone(), x.source)),
            _ => None,
        }
    };
    let Some((ws, source)) = current else { return };
    // Review A L3: its ports are nobody's now — no reload reaches them while the alert waits.
    *lock(&shell.allowed) = dc::Allowed::NONE;
    log(&format!("the Studio server (pid {pid}) stopped: {status}"));
    let text = format!("It exited ({status}). Its last words:\n\n{}", if tail.is_empty() { "(none)".into() } else { tail });
    restart_or_quit(app, &shell, "The Studio server stopped", &text, ws, source);
}

/// Show the (hidden) window: the Dock icon, Window › Show Studio Window.
fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// File › Open Workspace…: pick a folder. One that is no workspace changes nothing (review B M1); otherwise the owned
/// server stops before the next one starts (never two), and a start that fails or is cancelled reopens the previous
/// workspace. Never a quit.
fn open_other(app: &AppHandle) {
    let shell = app.state::<Arc<Shell>>().inner().clone();
    let Some(folder) = macos::pick_folder(&pick_message()) else { return };
    let folder = std::fs::canonicalize(&folder).unwrap_or(folder);
    if !dc::is_workspace(&folder) {
        log(&format!("{} is not a workspace: the current one stays open", folder.display()));
        let text = format!("{} has no studio.yaml or projects/ folder. The workspace open now stays open.", folder.display());
        macos::alert(&format!("Not a {} workspace", app_name()), &text, &["OK"]);
        return;
    }
    let old = lock(&shell.session).take();
    *lock(&shell.allowed) = dc::Allowed::NONE;
    let previous = old.as_ref().map(|o| (o.workspace.clone(), o.source));
    if let Some(old) = old {
        old.server.stop("another workspace opened");
    }
    if let Some(s) = open(&shell, Some((folder, dc::Source::Picker)), None, false) {
        show(app, &shell, s);
        return;
    }
    let Some(prev) = previous else { return };
    log(&format!("back to {}", prev.0.display()));
    match open(&shell, Some(prev), None, false) {
        Some(s) => show(app, &shell, s),
        None => {
            log("no workspace open: File › Open Workspace… opens one");
            if let (Some(w), Ok(blank)) = (app.get_webview_window(WINDOW), "about:blank".parse()) {
                let _ = w.navigate(blank);
            }
        }
    }
}

static SIGNAL_FD: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(sig: libc::c_int) {
    let fd = SIGNAL_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let b = sig as u8;
        // write(2) is async-signal-safe.
        unsafe {
            libc::write(fd, &b as *const u8 as *const libc::c_void, 1);
        }
    }
}

/// SIGTERM / SIGINT / SIGHUP quit through the event loop (critique M4): the owned server is stopped like on ⌘Q. Under
/// DEMO_STUDIO_DESKTOP_TEST=1, SIGUSR1 is File › Open Workspace… (the gated test's way to the menu).
fn install_signals(app: AppHandle) {
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    for fd in fds {
        unsafe {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        }
    }
    SIGNAL_FD.store(fds[1], Ordering::SeqCst);
    let test = test_mode();
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP].into_iter().chain(test.then_some(libc::SIGUSR1)) {
        unsafe {
            libc::signal(sig, on_signal as *const () as libc::sighandler_t);
        }
    }
    thread::spawn(move || {
        let mut b = [0u8; 1];
        while unsafe { libc::read(fds[0], b.as_mut_ptr() as *mut libc::c_void, 1) } == 1 {
            let name = match b[0] as libc::c_int {
                libc::SIGUSR1 if test => {
                    log("(test mode) SIGUSR1: File › Open Workspace…");
                    let h = app.clone();
                    let _ = app.run_on_main_thread(move || open_other(&h));
                    continue;
                }
                libc::SIGTERM => "SIGTERM",
                libc::SIGINT => "SIGINT",
                libc::SIGHUP => "SIGHUP",
                _ => "a signal",
            };
            log(&format!("quit: {name}"));
            app.exit(0);
            return;
        }
    });
}

fn launch_json() -> PathBuf {
    // <App>.app/Contents/MacOS/demo-studio-desktop → <App>.app/Contents/Resources/launch.json
    let exe = std::env::current_exe().unwrap_or_default();
    exe.parent().and_then(Path::parent).map(|c| c.join("Resources").join("launch.json")).unwrap_or_else(|| PathBuf::from("launch.json"))
}

fn fatal(text: &str) -> ! {
    log(text);
    macos::alert(&format!("{} cannot start", app_name()), text, &["Quit"]);
    logfilter::finish();
    std::process::exit(1);
}

fn main() {
    logfilter::install();
    let args = parse_args();
    let env = |k: &str| std::env::var(k).ok();
    let cfg = dc::launch_config(env("DEMO_STUDIO_NODE").as_deref(), env("DEMO_STUDIO_CLI").as_deref(), cfg!(debug_assertions), &launch_json());
    let cwd = std::env::current_dir().ok();
    let home = dc::studio_home(env("DEMO_STUDIO_HOME").as_deref(), env("HOME").as_deref(), cwd.as_deref());
    let first = dc::choose_workspace(args.root.as_deref(), env("DEMO_STUDIO_ROOT").as_deref(), home.as_deref().and_then(dc::read_remembered), cwd.as_deref());
    let route = args.route.clone();

    let context = tauri::generate_context!();
    let _ = APP_NAME.set(context.package_info().name.clone());
    let app = tauri::Builder::default()
        .menu(|app| menu::build(app, app_name()))
        .on_menu_event(|app, event| match event.id().as_ref() {
            menu::OPEN_WORKSPACE => open_other(app),
            menu::SHOW_WINDOW => show_window(app),
            _ => {}
        })
        .on_window_event(|window, event| {
            // Close / ⌘W hides: the page and its event stream stay; the Dock icon or ⌘0 shows it again.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            let cfg = match cfg {
                Ok(c) => c,
                Err(e) => fatal(&e.to_string()),
            };
            let h = app.handle().clone();
            install_signals(h.clone());
            let shell = Arc::new(Shell { cfg, home, session: Mutex::new(None), allowed: Arc::new(Mutex::new(dc::Allowed::NONE)), route: Mutex::new(route) });
            app.manage(shell.clone());
            match open(&shell, first, None, true) {
                Some(s) => show(&h, &shell, s),
                None => {
                    log("no workspace opened: quit");
                    h.exit(0);
                }
            }
            Ok(())
        })
        .build(context);
    let app = match app {
        Ok(a) => a,
        Err(e) => fatal(&format!("the app could not start: {e}")),
    };
    app.run(|h, event| match event {
        RunEvent::Reopen { .. } => show_window(h),
        RunEvent::Exit => {
            let Some(shell) = h.try_state::<Arc<Shell>>().map(|s| s.inner().clone()) else {
                logfilter::finish();
                return;
            };
            let s = lock(&shell.session).take();
            match s {
                Some(s) if s.server.owned() => s.server.stop("quit"),
                Some(s) => log(&format!("quit: the attached Studio server (pid {}) keeps running", s.server.line.pid)),
                None => log("quit"),
            }
            logfilter::finish();
        }
        _ => {}
    });
}
