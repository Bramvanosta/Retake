//! The quit guard (L5.2b, DESIGN §4j): before the app quits (⌘Q, the menu, the Dock, a quit Apple event, logout) or
//! opens another workspace with jobs running or unsaved text in the window, it asks — words from desktop_core::words,
//! the server's last `pending` snapshot (child.rs) as the facts. Nothing pending (or no server of this app's own: an
//! attached one has no pipe): no question, Quit stays instant — a mutex read.
//!
//! - The hook: `applicationShouldTerminate:` added at launch to the class of NSApp's delegate (tao 0.37 does not
//!   implement it; Tauri's ExitRequested never fires for ⌘Q). If the class already has it (a later tao), the guard is
//!   off and says so ("quit guard off"): the gated test turns red at that upgrade, never silent.
//! - L5.12d: a plain Quit asks the window's page first (desktop_core::guard_flow — its rules and their tests): the hook
//!   answers Cancel at once, shows the window and dispatches `studio:quit` (the question's words from words.rs as
//!   JSON data and a fresh id, only while the window is on the Studio's own origin); the page's kit Sheet acks `shown`
//!   and answers through the op `desktop_answer`, which the server writes on its pipe (child.rs → `from_page`). Quit
//!   Anyway re-enters through `request_terminate()` (as SIGUSR2 does: no TerminateLater, no reply from a tao callback);
//!   no ack within 1.5 s, logout / restart / shut down, test mode's DEMO_STUDIO_DESKTOP_TEST_QUIT=native: the native
//!   alert below. Every exit from a page question closes its sheet (`studio:quit-close`).
//! - The native alert: app-modal inside the hook (the standard pattern: logout waits for it), the window shown first.
//!   Unsaved text: Cancel is the default button and Quit Anyway destructive (critique M3); jobs only: Quit Anyway first.
//! - Logout, restart and shut down (review B M2): the quit Apple event's `kAEQuitReason` picks the words — the jobs
//!   worker ends with the session, so its jobs stop; at a restart or shut down, jobs alone ask nothing (an unattended
//!   restart is never held by them), unsaved text still asks.
//! - SIGTERM / SIGINT / SIGHUP stay "quit now" (`app.exit` → `[NSApp stop:]`, never `terminate:`): QUIT_NOW is set
//!   before, and the signal thread ends whichever modal of the shell is up (macos::end_modals: this question, Open
//!   Workspace…'s, the restart alert, "not a workspace", the picker — review B M1); the hook then answers Now.
//! - AppKit treats a `terminate:` sent while the hook is still deciding as Now, without asking again (critique H2):
//!   GUARD_OPEN is set while a question is up; the test hook (SIGUSR2) is ignored then, and the restart alerts wait.
//!   A `terminate:` while any other modal of the shell is up (the restart alert, the picker, a question of Open
//!   Workspace…) answers Cancel (review B L13): no question nested in another, no `applicationWillTerminate` inside a
//!   modal a Tauri callback opened (tao's callback lock: the H1 hang).
//! - Never call `terminate:` from a Tauri / tao callback (critique H1: tao's callback lock is held there, and
//!   `applicationWillTerminate` takes it again — a hang): the test hook sends it through
//!   `performSelectorOnMainThread:` from its own thread, like a real ⌘Q arrives (outside tao's callback).
//! - A panic in the hook answers Now (catch_unwind): an app that cannot quit is worse than a question not asked.
//! - Open Workspace… stays native (BL-135: through the page it would turn a synchronous menu callback into an async
//!   flow); it drops a page question first.

use crate::{app_name, log};
use desktop_core::guard_flow::{new_id, SHOWN_WITHIN_MS};
use desktop_core::{guard_question, quit_action, Action, Ask, Effect, Flow, PipeMsg, Question, Reply};
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{class, msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// A question of the guard is up (H2).
pub static GUARD_OPEN: AtomicBool = AtomicBool::new(false);
/// A signal asked to quit now (M1).
pub static QUIT_NOW: AtomicBool = AtomicBool::new(false);

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Add `applicationShouldTerminate:` to NSApp's delegate class (main thread, after tao set its delegate: `setup`).
pub fn install(app: &AppHandle) -> bool {
    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else {
        log("quit guard off: not on the main thread");
        return false;
    };
    let ns = NSApplication::sharedApplication(mtm);
    let Some(delegate) = ns.delegate() else {
        log("quit guard off: no app delegate");
        return false;
    };
    let obj: &AnyObject = delegate.as_ref();
    let cls: &AnyClass = obj.class();
    // SAFETY: the IMP's signature is `NSApplicationTerminateReply (id self, SEL _cmd, id sender)`, type "Q@:@"
    // (NSApplicationTerminateReply is an NSUInteger).
    let added = unsafe {
        let imp: Imp = std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> NSApplicationTerminateReply, Imp>(should_terminate);
        objc2::ffi::class_addMethod(cls as *const AnyClass as *mut AnyClass, sel!(applicationShouldTerminate:), imp, c"Q@:@".as_ptr()).as_bool()
    };
    if added {
        log("quit guard on");
    } else {
        log("quit guard off: the app delegate already answers applicationShouldTerminate:");
    }
    added
}

extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> NSApplicationTerminateReply {
    std::panic::catch_unwind(decide).unwrap_or(NSApplicationTerminateReply::TerminateNow)
}

fn decide() -> NSApplicationTerminateReply {
    let other_modal = GUARD_OPEN.load(Ordering::SeqCst) || crate::macos::modal_up();
    let quit_now = QUIT_NOW.load(Ordering::SeqCst);
    let Some(app) = APP.get() else { return NSApplicationTerminateReply::TerminateNow };
    // No server of this app's own (none, or an attached one: no pipe), or nothing pending: no question.
    let pending = if other_modal || quit_now { None } else { crate::current_pending(app) };
    let action = quit_action(quit_reason());
    let question = pending.as_ref().and_then(|p| {
        let q = guard_question(p, action, app_name());
        if q.is_none() && action == Action::SystemRestart && !p.is_empty() {
            log("quit: the Mac restarts or shuts down — its jobs stop with it (no question for jobs alone)");
        }
        q
    });
    // L5.12d: the page is asked for a plain Quit only (loginwindow never waits on a web page), with the window on the
    // Studio's own origin (the player's would swallow the event), unless test mode keeps the native alert.
    let page = question.is_some() && action == Action::Quit && page_question_on() && crate::window_on_studio(app);
    let ask_ = Ask { now: now_ms(), other_modal, quit_now, question, page, new_id: if page { fresh_id() } else { String::new() } };
    let (reply, fx) = crate::lock(&FLOW).terminate(ask_);
    run(app, fx);
    match reply {
        Reply::Now => NSApplicationTerminateReply::TerminateNow,
        Reply::Cancel if other_modal => {
            // Another question of the shell is up (Open Workspace…, the restart alert, the picker): answered first (L13).
            log("quit: another question is open — answer it first");
            NSApplicationTerminateReply::TerminateCancel
        }
        Reply::Cancel => NSApplicationTerminateReply::TerminateCancel,
        Reply::Native(q) => match ask(app, &q) {
            Answer::Proceed => {
                log("quit: Quit Anyway");
                NSApplicationTerminateReply::TerminateNow
            }
            Answer::QuitNow => {
                log("quit: a signal ended the question");
                NSApplicationTerminateReply::TerminateNow
            }
            Answer::Cancel => {
                log("quit cancelled: the app stays open");
                NSApplicationTerminateReply::TerminateCancel
            }
        },
    }
}

/// The quit question's flow (desktop_core::guard_flow): the hook, the pipe reader and the timers share it.
static FLOW: Mutex<Flow> = Mutex::new(Flow::new());

/// The shell's monotonic clock for the flow (milliseconds since the first use).
fn now_ms() -> u64 {
    static T0: OnceLock<Instant> = OnceLock::new();
    T0.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// A question id: 16 bytes of /dev/urandom (std only); empty when it cannot be read (the native alert then).
fn fresh_id() -> String {
    let mut b = [0u8; 16];
    match std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut b)) {
        Ok(()) => new_id(b),
        Err(_) => String::new(),
    }
}

/// DEMO_STUDIO_DESKTOP_TEST_QUIT=native (test mode only): the quit question is the native alert, as before L5.12d —
/// the L5.2b gated tests answer it through DEMO_STUDIO_DESKTOP_TEST_ANSWERS / MODAL_MS.
fn page_question_on() -> bool {
    !(crate::test_mode() && std::env::var("DEMO_STUDIO_DESKTOP_TEST_QUIT").is_ok_and(|v| v == "native"))
}

/// Do what the flow said, in order (any thread but a Tauri callback's: `terminate:` is posted, never sent).
fn run(app: &AppHandle, fx: Vec<Effect>) {
    for e in fx {
        match e {
            Effect::ShowWindow => crate::show_window(app),
            Effect::Dispatch { id, js } => {
                if crate::test_mode() {
                    // The id only in test mode (the gated test answers with it, as the page would).
                    log(&format!("(test mode) page question {id}"));
                } else {
                    log("quit: asked in the window");
                }
                crate::eval_in_window(app, js);
                let h = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(SHOWN_WITHIN_MS + 20));
                    let fx = crate::lock(&FLOW).tick(now_ms());
                    if fx.contains(&Effect::Terminate) {
                        log("quit: the window did not show the question — asking with the alert");
                    }
                    run(&h, fx);
                });
            }
            Effect::Close { js, .. } => crate::eval_in_window(app, js),
            // Queued on the main thread behind the Close just evaluated (an eval from another thread takes the same
            // queue: tauri-runtime-wry's event loop proxy), then posted: the page's sheet is closed before the
            // re-entered `terminate:` opens the native alert (review A's note), and `terminate:` still arrives outside
            // any Tauri callback (H1).
            Effect::Terminate => {
                let _ = app.run_on_main_thread(request_terminate);
            }
        }
    }
}

/// A pipe line of the window's page (desktop_answer → the server → here): its ack or its answer.
pub fn from_page(msg: PipeMsg) {
    let Some(app) = APP.get() else { return };
    let now = now_ms();
    match msg {
        PipeMsg::Shown { id } => {
            if crate::lock(&FLOW).shown(&id, now) {
                log("quit: the window shows the question");
            } else {
                log("ignored a page ack: not the question up now");
            }
        }
        PipeMsg::Answer { id, proceed } => {
            let (ok, fx) = crate::lock(&FLOW).answer(&id, proceed, now);
            if !ok {
                log("ignored a page answer: not the question up now");
                return;
            }
            log(if proceed { "quit: Quit Anyway (in the window)" } else { "quit cancelled in the window: the app stays open" });
            run(app, fx);
        }
        _ => {}
    }
}

/// The page question up now is dropped (the server gone, a signal, another question of the shell): its sheet closes.
pub fn drop_page_question(app: &AppHandle) {
    let fx = crate::lock(&FLOW).drop_asked();
    if !fx.is_empty() {
        log("quit: the question in the window was dropped");
    }
    run(app, fx);
}

/// The `kAEQuitReason` of the quit Apple event being handled (logout, restart, shut down); None for ⌘Q, the menu, the
/// Dock, or a quit event without one.
fn quit_reason() -> Option<u32> {
    let code = |b: &[u8; 4]| u32::from_be_bytes(*b);
    // SAFETY: NSAppleEventManager / NSAppleEventDescriptor messages with their documented types (FourCharCode: u32).
    unsafe {
        let mgr: *mut AnyObject = msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
        if mgr.is_null() {
            return None;
        }
        let ev: *mut AnyObject = msg_send![mgr, currentAppleEvent];
        if ev.is_null() {
            return None;
        }
        let (class, id): (u32, u32) = (msg_send![ev, eventClass], msg_send![ev, eventID]);
        if class != code(b"aevt") || id != code(b"quit") {
            return None;
        }
        let key = code(b"why?");
        let mut d: *mut AnyObject = msg_send![ev, paramDescriptorForKeyword: key];
        if d.is_null() {
            d = msg_send![ev, attributeDescriptorForKeyword: key];
        }
        if d.is_null() {
            return None;
        }
        let v: u32 = msg_send![d, enumCodeValue];
        Some(v)
    }
}

enum Answer {
    Proceed,
    Cancel,
    /// A signal asked to quit while the question was up.
    QuitNow,
}

fn ask(app: &AppHandle, q: &Question) -> Answer {
    GUARD_OPEN.store(true, Ordering::SeqCst);
    crate::show_window(app);
    let destructive: &[usize] = if q.destructive { &[q.proceed] } else { &[] };
    let answer = crate::macos::ask(&q.title, &q.text, &q.buttons, q.cancel, destructive);
    GUARD_OPEN.store(false, Ordering::SeqCst);
    if QUIT_NOW.load(Ordering::SeqCst) {
        Answer::QuitNow
    } else if answer == Some(q.proceed) {
        Answer::Proceed
    } else {
        Answer::Cancel
    }
}

/// File › Open Workspace…: true when the owned server may stop (nothing pending, or Open Anyway).
pub fn confirm_open_other(app: &AppHandle) -> bool {
    if GUARD_OPEN.load(Ordering::SeqCst) || QUIT_NOW.load(Ordering::SeqCst) || crate::macos::modal_up() {
        return false;
    }
    // One question at a time (H1): a quit question in the window ends before this one.
    drop_page_question(app);
    let Some(pending) = crate::current_pending(app) else { return true };
    let Some(q) = guard_question(&pending, Action::OpenWorkspace, app_name()) else { return true };
    matches!(ask(app, &q), Answer::Proceed)
}

/// `[NSApp terminate:nil]` from any thread but a Tauri / tao callback's (H1): queued on the main run loop, it arrives
/// like a real ⌘Q. The gated test's way to Quit (test mode: SIGUSR2).
pub fn request_terminate() {
    // SAFETY: NSApp exists (the event loop runs); performSelectorOnMainThread: may be sent from any thread.
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![app, performSelectorOnMainThread: sel!(terminate:), withObject: std::ptr::null_mut::<AnyObject>(), waitUntilDone: Bool::NO];
    }
}
