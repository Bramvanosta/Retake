//! The updater (L5.16d, DESIGN §4p (d)): tauri-plugin-updater from Rust only (no capability: the page has no IPC), the
//! rules in desktop_core::update_flow.
//!
//! - Built in only by the cargo `updater` feature, and registered only when the build's config has a feed and a key
//!   (`plugins.updater`, from bundle.mjs's generated overlay — never from the repository: the plugin would refuse to
//!   start without its key). Any other build says "Updates are off in this build".
//! - The check: at launch when due (at most once a day; at once after an install that failed: update_flow
//!   `launch_check_due`), and Help › Check for Updates… — refused, and said, while an install is under way
//!   (`check_refused`). The feed must answer within CHECK_TIMEOUT. Its result goes to the Studio as a state line on the
//!   owned server's stdin ("Update available · vX" in the status bar); Help shows an alert (up to date, off, could not
//!   check — with the date of the last successful check), or opens the Studio's sheet (a constant page event), or the
//!   native alert when the window shows no Studio page (never the feed's notes: they are not signed).
//! - Install and Restart (the sheet's click through the server's `desktop_update` op, or the native alert): refused when
//!   off, unwritable or with nothing found — the Studio's sheet says why from the state, the native path in an alert;
//!   the archive is downloaded (https only at every hop, redirects included; a byte cap, a stall and a total limit —
//!   `watch`; Later aborts it) and verified (the plugin: minisign against the key compiled in, the signed version must
//!   equal the announced one, never a downgrade), then kept in a 0600 file of the app's cache folder (not in memory); then it waits while a job of this
//!   workspace runs or waits (Later stops the wait, removes the file); then a quit through the quit guard
//!   (Action::Update: the page's sheet, else the native alert, asks about unsaved text). The person's answer holds
//!   however long the question waits (`Arm`). On Now, RunEvent::Exit stops the owned server gracefully and `finish`
//!   reads the file, installs it (the plugin verifies it again) and restarts (test mode: the new binary is started
//!   directly, never through LaunchServices). A failed swap keeps the old app (the plugin restores it): it restarts and
//!   says so; a swap whose old app could not be put back says where it is, and nothing restarts.
//! - Test mode: RETAKE_DESKTOP_TEST_UPDATE=install clicks Install and Restart as soon as the launch check finds an
//!   update — in a build made with the e2e test's overlay only (update_flow `test_install_allowed`).

use crate::{app_name, guard, lock, log, macos, test_mode};
use desktop_core as dc;
use desktop_core::update_flow::{self as uf, Arm, Exit, Failure, Off, Refusal, State, Step, Stop};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Context, Manager, Wry};

/// An update the feed announced (the plugin's); nothing in a build without the updater.
#[cfg(feature = "updater")]
type Found = tauri_plugin_updater::Update;
#[cfg(not(feature = "updater"))]
type Found = std::convert::Infallible;

/// How often the wait for jobs looks again.
const WAIT_STEP: Duration = Duration::from_millis(500);

struct Upd {
    state: State,
    found: Option<Found>,
    /// The archive, downloaded and verified, in the app's cache folder (update_flow `write_archive`).
    archive: Option<PathBuf>,
    remembered: uf::Remembered,
    home: Option<PathBuf>,
    /// The app's cache folder (the archive's).
    cache: Option<PathBuf>,
    location: dc::InstallLocation,
    /// A check is under way.
    checking: bool,
    /// The generation of the download under way.
    dl: Option<u64>,
}

static UPD: Mutex<Option<Upd>> = Mutex::new(None);
/// Later (or a cancelled question) bumps it: a download or a wait of an older generation stops.
static GEN: AtomicU64 = AtomicU64::new(0);
/// Whether the quit under way is Install and Restart's (update_flow Arm).
static ARM: Mutex<Arm> = Mutex::new(Arm::Off);
/// The build has the updater and its config (decided once, by `register`).
static BUILT: OnceLock<bool> = OnceLock::new();
/// The build was made with the e2e test's overlay (an http feed on 127.0.0.1: update_flow `is_test_feed`).
static TEST_FEED: OnceLock<bool> = OnceLock::new();

fn built() -> bool {
    *BUILT.get().unwrap_or(&false)
}

fn test_feed() -> bool {
    *TEST_FEED.get().unwrap_or(&false)
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The arming's clock (monotonic milliseconds).
fn now_ms() -> u64 {
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Register the plugin: a build with the `updater` feature whose config has `plugins.updater` with a key and an
/// endpoint (bundle.mjs's overlay); otherwise nothing (critique H2: the plugin refuses to start without its key).
pub fn register(builder: tauri::Builder<Wry>, context: &Context<Wry>) -> tauri::Builder<Wry> {
    let conf = context.config().plugins.0.get("updater");
    let configured = conf.is_some_and(|c| c.get("pubkey").and_then(|k| k.as_str()).is_some_and(|k| !k.trim().is_empty()) && c.get("endpoints").and_then(|e| e.as_array()).is_some_and(|e| !e.is_empty()));
    let endpoints: Vec<&str> = conf.and_then(|c| c.get("endpoints")).and_then(|e| e.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
    let insecure = conf.and_then(|c| c.get("dangerousInsecureTransportProtocol")).and_then(|v| v.as_bool()) == Some(true);
    let _ = TEST_FEED.set(uf::is_test_feed(insecure, &endpoints));
    #[cfg(feature = "updater")]
    {
        let _ = BUILT.set(configured);
        if configured {
            return builder.plugin(tauri_plugin_updater::Builder::new().build());
        }
        log("updates off: this build has the updater but no feed in its config");
        builder
    }
    #[cfg(not(feature = "updater"))]
    {
        let _ = BUILT.set(false);
        if configured {
            log("updates off: the config names a feed but this build has no updater");
        }
        builder
    }
}

fn current(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn off_now() -> Option<Off> {
    let g = lock(&UPD);
    let loc = g.as_ref().map_or(dc::InstallLocation::Ok, |u| u.location);
    uf::availability(built(), uf::disabled(std::env::var(uf::DISABLE_ENV).ok().as_deref()), loc)
}

/// The words the start line says about updates.
pub fn summary(location: dc::InstallLocation) -> String {
    match uf::availability(built(), uf::disabled(std::env::var(uf::DISABLE_ENV).ok().as_deref()), location) {
        None => "updates on".into(),
        Some(o) => format!("updates off ({})", o.wire()),
    }
}

/// Set the state and tell the owned server (when there is one).
fn set(app: &AppHandle, state: State) {
    let line = uf::state_line(&current(app), &state);
    if let Some(u) = lock(&UPD).as_mut() {
        u.state = state;
    }
    if let Some(l) = line {
        crate::send_to_server(&l);
    }
}

fn state_now() -> Option<State> {
    lock(&UPD).as_ref().map(|u| u.state.clone())
}

/// A new owned server: it learns the current state.
pub fn server_ready(app: &AppHandle) {
    if let Some(s) = state_now() {
        if let Some(l) = uf::state_line(&current(app), &s) {
            crate::send_to_server(&l);
        }
    }
}

fn remember(f: impl FnOnce(&mut uf::Remembered)) {
    let mut g = lock(&UPD);
    let Some(u) = g.as_mut() else { return };
    f(&mut u.remembered);
    if let Some(h) = &u.home {
        if let Err(e) = uf::write_remembered(h, &u.remembered) {
            log(&format!("updates: could not remember the check: {e}"));
        }
    }
}

/// Remove the kept archive (Later, after the install, a new check).
fn drop_archive() {
    let path = lock(&UPD).as_mut().and_then(|u| u.archive.take());
    if let Some(p) = path {
        let _ = std::fs::remove_file(p);
    }
}

/// At launch (after the shell's state exists): the archives a previous run left removed, the state, a failed install
/// said, the check when due (at once after a failed install).
pub fn start(app: &AppHandle, home: Option<PathBuf>, location: dc::InstallLocation) {
    let remembered = home.as_deref().map(uf::read_remembered).unwrap_or_default();
    let checked = remembered.checked;
    let failed = remembered.failed.clone();
    let cache = app.path().app_cache_dir().ok();
    if let Some(c) = &cache {
        let n = uf::remove_stale_archives(c, std::process::id(), |pid| unsafe { libc::kill(pid as libc::pid_t, 0) } == 0);
        if n > 0 {
            log(&format!("updates: removed {n} archive(s) a previous run left"));
        }
    }
    *lock(&UPD) = Some(Upd { state: State::Idle { checked }, found: None, archive: None, remembered, home, cache, location, checking: false, dl: None });
    let off = off_now();
    if let Some((f, v)) = &failed {
        log(&format!("updates: the update to {v} was not installed — {}", f.words(app_name(), &current(app))));
        // No update is known in this process yet: nothing to retry until the check below finds it again.
        set(app, State::Failed { failure: *f, version: Some(v.clone()), checked, retry: false });
    } else if let Some(o) = off {
        set(app, State::Off(o));
    }
    if off.is_none() && uf::launch_check_due(checked, now_s(), failed.is_some()) {
        check(app, false);
    }
}

/// Help › Check for Updates….
pub fn check_menu(app: &AppHandle) {
    if let Some(o) = off_now() {
        let checked = lock(&UPD).as_ref().and_then(|u| u.remembered.checked);
        say(app, "Updates are off", format!("{}\n\n{}", o.words(app_name()), uf::last_check_words(checked)));
        return;
    }
    check(app, true);
}

/// An alert from the main thread, unless another question of the shell is up (then the log only).
fn say(app: &AppHandle, title: &str, text: String) {
    log(&format!("updates: {title}"));
    let title = title.to_string();
    let _ = app.run_on_main_thread(move || {
        if guard::GUARD_OPEN.load(Ordering::SeqCst) || macos::modal_up() {
            log("updates: another question is open — the answer is in the Studio's status bar");
            return;
        }
        macos::alert(&title, &text, &["OK"]);
    });
}

/// Ask the feed. `manual`: Help's — its answer is said (alert, or the Studio's sheet), a refusal too. (A build without
/// the updater never finds one: that branch is unreachable there.)
#[cfg_attr(not(feature = "updater"), allow(unused_variables))]
fn check(app: &AppHandle, manual: bool) {
    let refused = {
        let mut g = lock(&UPD);
        let Some(u) = g.as_mut() else { return };
        let refused = if u.checking { Some(format!("{} is checking for updates already.", app_name())) } else { uf::check_refused(&u.state, app_name()) };
        if refused.is_none() {
            u.checking = true;
        }
        refused
    };
    if let Some(why) = refused {
        log(&format!("updates: check refused — {why}"));
        if manual {
            say(app, "An update is under way", why);
        }
        return;
    }
    set(app, State::Checking);
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        let r = ask_feed(&h).await;
        if let Some(u) = lock(&UPD).as_mut() {
            u.checking = false;
        }
        let checked_before = lock(&UPD).as_ref().and_then(|u| u.remembered.checked);
        match r {
            Ok(Some((found, version, _notes))) => {
                let now = now_s();
                remember(|r| {
                    r.checked = Some(now);
                    r.failed = uf::failed_after_check(r.failed.take(), Some(&version));
                });
                drop_archive();
                let failed = lock(&UPD).as_ref().and_then(|u| u.remembered.failed.clone());
                if let Some(u) = lock(&UPD).as_mut() {
                    u.found = Some(found.clone());
                }
                log(&format!("updates: {} {version} is available", app_name()));
                match failed {
                    // The version whose install failed, offered again: the failure stays said, Install may be tried again.
                    Some((f, v)) if v == version => set(&h, State::Failed { failure: f, version: Some(v), checked: Some(now), retry: f.retry(true) }),
                    _ => set(&h, found_state(&found, Some(now))),
                }
                if uf::test_install_allowed(test_mode(), std::env::var("RETAKE_DESKTOP_TEST_UPDATE").ok().as_deref(), test_feed()) {
                    log("(test mode) Install and Restart");
                    install_request(&h, false);
                } else if manual {
                    offer(&h, &version);
                }
            }
            Ok(None) => {
                let now = now_s();
                remember(|r| {
                    r.checked = Some(now);
                    r.failed = uf::failed_after_check(r.failed.take(), None);
                });
                if let Some(u) = lock(&UPD).as_mut() {
                    u.found = None;
                }
                drop_archive();
                log("updates: up to date");
                set(&h, State::Idle { checked: Some(now) });
                if manual {
                    say(&h, &format!("{} is up to date", app_name()), format!("Version {}. {}", current(&h), uf::last_check_words(Some(now))));
                }
            }
            Err(e) => {
                log(&format!("updates: the check failed: {}", dc::sanitize(&e)));
                set(&h, State::Failed { failure: Failure::Check, version: None, checked: checked_before, retry: false });
                if manual {
                    say(&h, &format!("{} could not check for updates", app_name()), format!("{} {}", Failure::Check.words(app_name(), &current(&h)), uf::last_check_words(checked_before)));
                }
            }
        }
    });
}

/// Help found an update: the Studio's sheet (a constant page event) — or the native alert when the window shows no
/// Studio page of this app's own server (without the feed's notes: not signed).
fn offer(app: &AppHandle, version: &str) {
    let (title, text, buttons) = uf::available_alert(app_name(), &current(app), version);
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        if crate::window_on_studio(&h) && crate::current_pending(&h).is_some() {
            crate::show_window(&h);
            crate::eval_in_window(&h, uf::update_page_js());
            return;
        }
        if guard::GUARD_OPEN.load(Ordering::SeqCst) || macos::modal_up() {
            return;
        }
        if macos::ask(&title, &text, &buttons, 1, &[]) == Some(0) {
            install_request(&h, true);
        }
    });
}

/// The update sheet's click (a pipe line of the owned server).
pub fn from_page(app: &AppHandle, a: dc::UpdateAction) {
    match a {
        dc::UpdateAction::Install => install_request(app, false),
        dc::UpdateAction::Later => later(app, "Later"),
    }
}

/// Stop (Later, a cancelled or dropped question): the download aborted, the wait stopped, the kept archive removed, a
/// remembered failure acknowledged; back to Available (the update stays known) or Idle.
fn later(app: &AppHandle, why: &str) {
    GEN.fetch_add(1, Ordering::SeqCst);
    let was = std::mem::take(&mut *lock(&ARM));
    if was == Arm::Asked {
        // The page's question of this quit closes too (an answer to it would quit without installing).
        guard::drop_page_question(app);
    }
    drop_archive();
    let (back, acknowledged) = {
        let mut g = lock(&UPD);
        g.as_mut().map_or((None, false), |u| {
            u.dl = None;
            let failed = matches!(u.state, State::Failed { .. });
            let back = match (&u.state, &u.found) {
                (State::Downloading { .. } | State::Waiting { .. } | State::Installing { .. } | State::Failed { .. }, Some(f)) => Some(found_state(f, u.remembered.checked)),
                (State::Failed { .. }, None) => Some(State::Idle { checked: u.remembered.checked }),
                _ => None,
            };
            (back, failed && u.remembered.failed.is_some())
        })
    };
    if acknowledged {
        remember(|r| r.failed = None);
    }
    if let Some(s) = back {
        log(&format!("updates: {why} — the update waits for the next click"));
        set(app, s);
    }
}

#[cfg(feature = "updater")]
fn found_state(f: &Found, checked: Option<u64>) -> State {
    State::Available { version: f.version.clone(), notes: f.body.clone().unwrap_or_default(), checked }
}
#[cfg(not(feature = "updater"))]
fn found_state(f: &Found, _: Option<u64>) -> State {
    match *f {}
}

#[cfg(feature = "updater")]
fn found_version(f: &Found) -> String {
    f.version.clone()
}
#[cfg(not(feature = "updater"))]
fn found_version(f: &Found) -> String {
    match *f {}
}

/// The app's folder and its parent may be written by this user (the plugin's renames); false for a bare binary.
fn writable() -> bool {
    let Some(app) = std::env::current_exe().ok().and_then(|e| std::fs::canonicalize(e).ok()).as_deref().and_then(dc::app_of_exe) else { return false };
    let ok = |p: &Path| {
        use std::os::unix::ffi::OsStrExt;
        std::ffi::CString::new(p.as_os_str().as_bytes()).is_ok_and(|c| unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0)
    };
    ok(&app) && app.parent().is_some_and(ok)
}

/// Install and Restart: the rules (update_flow::install_step), the download, the wait for jobs, then the quit.
/// `native`: the click came from the native alert — a refusal is said in an alert too (the Studio's sheet says it from
/// the state).
fn install_request(app: &AppHandle, native: bool) {
    let (has, version, checked, checking, downloading, have_archive) = {
        let g = lock(&UPD);
        let Some(u) = g.as_ref() else { return };
        (u.found.is_some(), u.found.as_ref().map(found_version), u.remembered.checked, u.checking, u.dl.is_some(), u.archive.as_ref().is_some_and(|p| p.is_file()))
    };
    if checking || downloading {
        let why = if checking { "a check is under way: try again in a moment" } else { "the update is downloading already" };
        log(&format!("updates: Install and Restart refused — {why}"));
        if native {
            say(app, "An update is under way", format!("{}: {why}.", app_name()));
        }
        return;
    }
    match uf::install_step(off_now(), has, writable(), crate::current_pending(app).as_ref()) {
        Step::Refuse(r) => {
            let words = uf::refusal_words(r, app_name(), &current(app));
            log(&format!("updates: Install and Restart refused — {words}"));
            match r {
                Refusal::Off(o) => set(app, State::Off(o)),
                Refusal::NotWritable => set(app, State::Failed { failure: Failure::NotWritable, version, checked, retry: false }),
                // Nothing known any more (a failed install's app before its check, say): ask the feed again.
                Refusal::NoUpdate => check(app, false),
            }
            if native {
                say(app, &format!("{} cannot install the update", app_name()), words);
            }
        }
        Step::Wait { .. } | Step::Quit => {
            let gen = GEN.fetch_add(1, Ordering::SeqCst) + 1;
            if have_archive {
                wait_then_quit(app.clone(), gen);
            } else {
                download(app, gen);
            }
        }
    }
}

/// Download and verify (the plugin) under `watch`'s limits, keep the archive on disk, then wait and quit — unless
/// Later came in between (it aborts the download).
fn download(app: &AppHandle, gen: u64) {
    let (found, version, checked, cache) = {
        let mut g = lock(&UPD);
        let Some(u) = g.as_mut() else { return };
        let Some(f) = u.found.clone() else { return };
        u.dl = Some(gen);
        let v = found_version(&f);
        (f, v, u.remembered.checked, u.cache.clone())
    };
    set(app, State::Downloading { version: version.clone() });
    log(&format!("updates: downloading {version}"));
    let h = app.clone();
    std::thread::spawn(move || {
        let progress = Arc::new(uf::Progress::default());
        let p = progress.clone();
        let task = tauri::async_runtime::spawn(async move { fetch_archive(&found, &p).await });
        let stop = uf::watch(&progress, &uf::DOWNLOAD, || task.inner().is_finished(), || GEN.load(Ordering::SeqCst) != gen);
        let r = match stop {
            Some(s) => {
                task.abort();
                Err(s.words(&uf::DOWNLOAD))
            }
            None => tauri::async_runtime::block_on(task).map_err(|e| e.to_string()).and_then(|r| r),
        };
        // This download is over: the next click may start one (unless Later already freed it).
        let mine = lock(&UPD).as_mut().is_some_and(|u| {
            let mine = u.dl == Some(gen);
            if mine {
                u.dl = None;
            }
            mine
        });
        if stop == Some(Stop::Cancelled) || !mine || GEN.load(Ordering::SeqCst) != gen {
            log("updates: the download stopped (Later)");
            return;
        }
        let kept = r.and_then(|bytes| {
            let n = bytes.len();
            let cache = cache.ok_or_else(|| "the app has no cache folder to keep it in".to_string())?;
            uf::write_archive(&cache, std::process::id(), &bytes).map(|p| (p, n)).map_err(|e| format!("could not keep it: {e}"))
        });
        match kept {
            Ok((path, n)) => {
                log(&format!("updates: {version} downloaded and verified ({} MB), kept in the cache folder", n / 1_000_000));
                if let Some(u) = lock(&UPD).as_mut() {
                    u.archive = Some(path);
                }
                wait_then_quit(h, gen);
            }
            Err(e) => {
                log(&format!("updates: the download failed — {}", dc::sanitize(&e)));
                set(&h, State::Failed { failure: Failure::Download, version: Some(version), checked, retry: true });
            }
        }
    });
}

/// Wait while jobs of this workspace run or wait (critique M6), then arm and quit through the guard (from this thread:
/// never `terminate:` from a Tauri callback — guard.rs H1) — not while another question is up (the shell's, or a quit
/// question in the page: its answer would install). A posting that never reaches the guard lapses (back to Available).
fn wait_then_quit(app: AppHandle, gen: u64) {
    std::thread::spawn(move || {
        let mut said: Option<u32> = None;
        loop {
            if GEN.load(Ordering::SeqCst) != gen || guard::QUIT_NOW.load(Ordering::SeqCst) {
                return;
            }
            let version = lock(&UPD).as_ref().and_then(|u| u.found.as_ref().map(found_version));
            let Some(version) = version else { return };
            match uf::install_step(off_now(), true, true, crate::current_pending(&app).as_ref()) {
                Step::Wait { jobs } => {
                    if said != Some(jobs) {
                        log(&format!("updates: waiting for {jobs} job(s) of this workspace to end"));
                        set(&app, State::Waiting { version, jobs });
                        said = Some(jobs);
                    }
                }
                Step::Quit => {
                    if guard::GUARD_OPEN.load(Ordering::SeqCst) || macos::modal_up() || guard::page_question_up() {
                        // Another question is up: asked again once it is answered.
                    } else {
                        set(&app, State::Installing { version: version.clone() });
                        *lock(&ARM) = Arm::Posted { at: now_ms() };
                        log(&format!("updates: quitting to install {version}"));
                        guard::request_terminate();
                        break;
                    }
                }
                Step::Refuse(_) => return,
            }
            std::thread::sleep(WAIT_STEP);
        }
        // The posted quit must reach the guard; if it never does, the update goes back to Available.
        loop {
            std::thread::sleep(WAIT_STEP);
            if GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            let arm = *lock(&ARM);
            if arm.lapsed(now_ms()) {
                later(&app, "the quit did not start");
                return;
            }
            if !matches!(arm, Arm::Posted { .. }) {
                return;
            }
        }
    });
}

/// The guard's `terminate:`: whether this quit is Install and Restart's (a posted arming within reach becomes the
/// question's: then it holds however long the question waits).
pub fn take_quit() -> bool {
    let mut a = lock(&ARM);
    let now = now_ms();
    *a = a.decide(now);
    a.holds(now)
}

/// The quit guard answered Now for the update (guard.rs).
pub fn approved() {
    let mut a = lock(&ARM);
    *a = a.approve(now_ms());
}

/// The quit guard's question was cancelled, dropped, or could not be asked: no install (an approved one is under way
/// already: the exit installs it — the server's stop at the exit drops nothing of it).
pub fn cancelled(app: &AppHandle) {
    let a = *lock(&ARM);
    if a != Arm::Approved && a.holds(now_ms()) {
        later(app, "the question was cancelled");
    }
}

/// RunEvent::Exit, after the owned server stopped: install the approved update, then restart — the new version, or the
/// old one with the failure remembered (said at its launch). An approved install with no archive left says so and
/// restarts; a swap that could not put the old app back says where it is and restarts nothing.
pub fn finish(app: &AppHandle) {
    let arm = *lock(&ARM);
    let (found, archive) = {
        let g = lock(&UPD);
        g.as_ref().map_or((None, None), |u| (u.found.clone(), u.archive.clone()))
    };
    let have = found.is_some() && archive.as_ref().is_some_and(|p| p.is_file());
    // Only a quit the guard approved for the update (a signal's quit, or a plain ⌘Q after a Later, installs nothing).
    match uf::exit_step(arm, have) {
        Exit::Nothing => {}
        Exit::FailAndRestart => {
            let version = found.as_ref().map(found_version).or_else(|| match state_now() {
                Some(State::Installing { version }) => Some(version),
                _ => None,
            });
            log("updates: the approved install has no archive left — nothing installed, the app restarts");
            if let Some(v) = version {
                remember(|r| r.failed = Some((Failure::Install, v)));
            }
            restart(app);
        }
        Exit::Install => {
            let (Some(found), Some(path)) = (found, archive) else { return };
            let version = found_version(&found);
            log(&format!("updates: installing {version}"));
            let r = std::fs::read(&path).map_err(|e| Swap::Failed(format!("the kept archive could not be read: {e}"))).and_then(|bytes| swap(&found, &bytes));
            let _ = std::fs::remove_file(&path);
            match r {
                Ok(()) => {
                    remember(|r| r.failed = None);
                    log(&format!("updates: {version} installed — restarting"));
                }
                Err(Swap::NotRestored(kept)) => {
                    let kept = kept.to_string_lossy().into_owned();
                    log(&format!("updates: the install failed and the previous app could not be put back — it is at {}", dc::sanitize(&kept)));
                    remember(|r| r.failed = Some((Failure::Install, version.clone())));
                    macos::alert(&format!("{} was not updated", app_name()), &uf::not_restored_words(app_name(), &kept), &["OK"]);
                    return;
                }
                Err(Swap::Failed(e)) => {
                    log(&format!("updates: the install failed, the old app is kept — {}", dc::sanitize(&e)));
                    remember(|r| r.failed = Some((Failure::Install, version.clone())));
                }
            }
            restart(app);
        }
    }
}

/// Start the app again from its (possibly new) bundle. Test mode: the binary itself, directly (never LaunchServices),
/// its environment and stdout inherited, the real stderr (never the log filter's pipe: its reader ends with this
/// process), after which this process waits a moment (so the child's test mode, decided from its parent at launch,
/// holds) and exits; otherwise Tauri's restart (LaunchServices, `open -n`), the log filter flushed first (the restart
/// exits the process: RunEvent::Exit's own flush never runs — review d A-L6).
fn restart(app: &AppHandle) {
    if test_mode() {
        let exe = std::env::current_exe().unwrap_or_default();
        let mut cmd = std::process::Command::new(&exe);
        cmd.args(std::env::args_os().skip(1)).stdin(std::process::Stdio::null());
        // The real stderr, not this process's log filter (its pipe's reader ends with this process).
        if let Some(err) = crate::logfilter::real_stderr() {
            cmd.stderr(err);
        }
        match cmd.spawn() {
            Ok(c) => log(&format!("(test mode) restarted the app directly (pid {})", c.id())),
            Err(e) => log(&format!("(test mode) could not restart the app: {e}")),
        }
        std::thread::sleep(Duration::from_millis(1500));
        return;
    }
    crate::logfilter::finish();
    app.restart();
}

#[cfg(feature = "updater")]
async fn ask_feed(app: &AppHandle) -> Result<Option<(Found, String, String)>, String> {
    use tauri_plugin_updater::UpdaterExt;
    // The feed must answer within CHECK_TIMEOUT (the plugin's request timeout); the download has its own limits
    // (`watch`), so the found update carries none (a request timeout counts the whole body). The client of the check and
    // of the download (the found update keeps the builder's) is https only at every hop, the redirects GitHub's releases
    // answer with included (update_flow `https_only`; the e2e build's 127.0.0.1 feed aside).
    let https = uf::https_only(test_feed());
    let u = app.updater_builder().timeout(uf::CHECK_TIMEOUT).configure_client(move |b| b.https_only(https)).build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(u.map(|mut f| {
        f.timeout = None;
        let (v, n) = (f.version.clone(), f.body.clone().unwrap_or_default());
        (f, v, n)
    }))
}
#[cfg(not(feature = "updater"))]
async fn ask_feed(_: &AppHandle) -> Result<Option<(Found, String, String)>, String> {
    Err("this build has no updater".into())
}

/// The archive: https only (the e2e test's 127.0.0.1 feed aside — review d A-M2: the plugin only warns) — its address
/// here, and every redirect on the way to GitHub's download host in the client (`ask_feed`) —, every chunk reported to
/// `watch`, verified by the plugin before it is returned.
#[cfg(feature = "updater")]
async fn fetch_archive(f: &Found, p: &uf::Progress) -> Result<Vec<u8>, String> {
    if f.download_url.scheme() != "https" && !(test_feed() && f.download_url.as_str().starts_with("http://127.0.0.1:")) {
        return Err("the archive's address is not https: refused".into());
    }
    f.download(|n, total| p.chunk(n, total), || {}).await.map_err(|e| e.to_string())
}
#[cfg(not(feature = "updater"))]
async fn fetch_archive(f: &Found, _: &uf::Progress) -> Result<Vec<u8>, String> {
    match *f {}
}

#[cfg_attr(not(feature = "updater"), allow(dead_code))]
enum Swap {
    Failed(String),
    /// The plugin could not put the old app back: where it left it.
    NotRestored(PathBuf),
}

#[cfg(feature = "updater")]
fn swap(f: &Found, bytes: &[u8]) -> Result<(), Swap> {
    // `install` verifies the bytes again (the file could have changed since the download).
    f.install(bytes).map_err(|e| match e {
        tauri_plugin_updater::Error::PreviousAppNotRestored(p) => Swap::NotRestored(p),
        e => Swap::Failed(e.to_string()),
    })
}
#[cfg(not(feature = "updater"))]
fn swap(f: &Found, _: &[u8]) -> Result<(), Swap> {
    match *f {}
}
