//! The quit guard (L5.2b, DESIGN §4j): before the app quits (⌘Q, the menu, the Dock, a quit Apple event, logout) or
//! opens another workspace with jobs running or unsaved text in the window, it asks — words from desktop_core::words,
//! the server's last `pending` snapshot (child.rs) as the facts. Nothing pending (or no server of this app's own: an
//! attached one has no pipe): no question, Quit stays instant — a mutex read.
//!
//! - The hook: `applicationShouldTerminate:` added at launch to the class of NSApp's delegate (tao 0.37 does not
//!   implement it; Tauri's ExitRequested never fires for ⌘Q). If the class already has it (a later tao), the guard is
//!   off and says so ("quit guard off"): the gated test turns red at that upgrade, never silent.
//! - An app-modal alert inside the hook (the standard pattern: logout waits for it), the window shown first. Unsaved
//!   text: Cancel is the default button and Quit Anyway destructive (critique M3); jobs only: Quit Anyway first.
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

use crate::{app_name, log};
use desktop_core::{guard_question, quit_action, Action, Question};
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{class, msg_send, sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
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
    if GUARD_OPEN.load(Ordering::SeqCst) || crate::macos::modal_up() {
        // Another question of the shell is up (Open Workspace…, the restart alert, the picker): answered first (L13).
        log("quit: another question is open — answer it first");
        return NSApplicationTerminateReply::TerminateCancel;
    }
    if QUIT_NOW.load(Ordering::SeqCst) {
        return NSApplicationTerminateReply::TerminateNow;
    }
    let Some(app) = APP.get() else { return NSApplicationTerminateReply::TerminateNow };
    // No server of this app's own (none, or an attached one: no pipe), or nothing pending: no question.
    let Some(pending) = crate::current_pending(app) else { return NSApplicationTerminateReply::TerminateNow };
    let action = quit_action(quit_reason());
    let Some(q) = guard_question(&pending, action, app_name()) else {
        if action == Action::SystemRestart && !pending.is_empty() {
            log("quit: the Mac restarts or shuts down — its jobs stop with it (no question for jobs alone)");
        }
        return NSApplicationTerminateReply::TerminateNow;
    };
    match ask(app, &q) {
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
    }
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
