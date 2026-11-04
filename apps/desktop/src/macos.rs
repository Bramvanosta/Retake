//! The two native dialogs of the shell, on the main thread: the workspace folder picker (NSOpenPanel, folders only)
//! and an alert with buttons (NSAlert). Under RETAKE_DESKTOP_TEST=1 neither is shown (a test never waits on a
//! modal): the picker answers the folders of RETAKE_DESKTOP_TEST_PICK (a `:` list, each once: the gated test's
//! File › Open Workspace…), then Cancel, and an alert prints its text and its buttons' keys and answers its cancel
//! button (`alert`: the last; `ask`: the one it names) — or, L5.2b, the next index of RETAKE_DESKTOP_TEST_ANSWERS
//! (a `,` list, one per alert). RETAKE_DESKTOP_TEST_MODAL_MS=<ms> (test mode only) shows the alert for real and
//! aborts it after that delay: the gated test's proof that a question is a real window that goes away, and that SIGTERM
//! ends it.
//!
//! Every modal of the shell is counted while it is up (review B M1 / L13): `end_modals` — the signal thread's, on
//! SIGTERM / SIGINT / SIGHUP — ends whichever is up through `performSelectorOnMainThread:` (it runs in the modal panel
//! mode: a run loop source of the modal loop, outside any callout of it): the picker by its own `cancel:`, an alert by
//! `abortModal`, each only while `[NSApp modalWindow]` says a modal loop runs (abortModal without one raises). Once a
//! signal asked to quit, no new modal opens (`quitting`): the code waiting on one goes on to the queued exit. The
//! quit hook answers Cancel while one is up (guard.rs: no question nested in another, no `terminate:` inside a modal
//! of a Tauri callback).

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject};
use objc2::{define_class, msg_send, sel, AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSApplication, NSOpenPanel};
use objc2_foundation::NSString;
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// NSModalResponseOK.
const MODAL_OK: isize = 1;

fn headless() -> bool {
    crate::test_mode()
}

/// A signal asked to quit: no new modal (B M1).
fn quitting() -> bool {
    crate::guard::QUIT_NOW.load(Ordering::SeqCst)
}

fn activate(mtm: MainThreadMarker) {
    NSApplication::sharedApplication(mtm).activate();
}

static TEST_PICKED: AtomicUsize = AtomicUsize::new(0);
static TEST_ANSWERED: AtomicUsize = AtomicUsize::new(0);

/// The shell's modals up now, innermost last (their sequence numbers).
static MODALS: Mutex<Vec<u64>> = Mutex::new(Vec::new());
static MODAL_SEQ: AtomicU64 = AtomicU64::new(0);
/// Modals the test asked to abort (RETAKE_DESKTOP_TEST_MODAL_MS).
static TEST_ABORTS: Mutex<Vec<u64>> = Mutex::new(Vec::new());

thread_local! {
    /// The picker while it is up (main thread): ended by its own `cancel:`.
    static PICKER: RefCell<Option<Retained<NSOpenPanel>>> = const { RefCell::new(None) };
}

/// A shell modal is up (an alert or the picker).
pub fn modal_up() -> bool {
    !crate::lock(&MODALS).is_empty()
}

/// A modal's place in MODALS while it is up.
struct Modal(u64);

impl Modal {
    fn enter() -> Modal {
        let n = MODAL_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
        crate::lock(&MODALS).push(n);
        Modal(n)
    }
}

impl Drop for Modal {
    fn drop(&mut self) {
        crate::lock(&MODALS).retain(|m| *m != self.0);
    }
}

define_class!(
    /// The target of the main-thread calls that end a modal (any thread may create one and post to it).
    #[unsafe(super(NSObject))]
    #[name = "StudioShellModalEnder"]
    struct Ender;

    impl Ender {
        /// A signal: end the modal up now, whichever it is.
        #[unsafe(method(endModal:))]
        fn end_modal(&self, _arg: *mut AnyObject) {
            end_current();
        }

        /// The test's abort: end the modal up now only if the test asked for that one.
        #[unsafe(method(endTestModal:))]
        fn end_test_modal(&self, _arg: *mut AnyObject) {
            let top = crate::lock(&MODALS).last().copied();
            if top.is_some_and(|t| crate::lock(&TEST_ABORTS).contains(&t)) {
                end_current();
            }
        }
    }
);

/// On the main thread: end the modal loop that runs now (the picker by `cancel:`, an alert by `abortModal`).
fn end_current() {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let app = NSApplication::sharedApplication(mtm);
    let Some(window) = app.modalWindow() else { return };
    let picker = PICKER.with(|p| p.borrow().clone());
    match picker {
        Some(panel) if std::ptr::eq(Retained::as_ptr(&panel).cast::<AnyObject>(), Retained::as_ptr(&window).cast::<AnyObject>()) => unsafe { panel.cancel(None) },
        _ => app.abortModal(),
    }
}

/// Post `selector` to a fresh Ender on the main thread (from any thread; the run loop's common modes include the
/// modal panel mode).
fn post_to_main(selector: objc2::runtime::Sel) {
    let ender: Retained<Ender> = unsafe { msg_send![Ender::alloc(), init] };
    unsafe {
        let _: () = msg_send![&*ender, performSelectorOnMainThread: selector, withObject: std::ptr::null_mut::<AnyObject>(), waitUntilDone: Bool::NO];
    }
}

/// End every shell modal (the signal thread, after QUIT_NOW): posted again every 100 ms while one is up, at most 5 s
/// (a modal that opens right as the signal comes, or one an ended one returns to).
pub fn end_modals() {
    for _ in 0..50 {
        if !modal_up() {
            return;
        }
        post_to_main(sel!(endModal:));
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// RETAKE_DESKTOP_TEST_MODAL_MS: abort modal `n` after `ms` (asked again every 100 ms until it is gone: a modal
/// nested in it ends first).
fn test_abort_after(n: u64, ms: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        crate::lock(&TEST_ABORTS).push(n);
        while crate::lock(&MODALS).contains(&n) {
            post_to_main(sel!(endTestModal:));
            std::thread::sleep(Duration::from_millis(100));
        }
        crate::lock(&TEST_ABORTS).retain(|m| *m != n);
    });
}

/// Ask for a workspace folder; None when cancelled (or not on the main thread, or the app is quitting).
pub fn pick_folder(message: &str) -> Option<PathBuf> {
    pick_folder_with(&format!("Open a {} workspace", crate::app_name()), message, "Open")
}

/// Ask for a folder with this panel title and button (L5.16c: the `retake` command's folder); as `pick_folder`.
pub fn pick_folder_with(title: &str, message: &str, prompt: &str) -> Option<PathBuf> {
    if quitting() {
        return None;
    }
    if headless() {
        let picks = std::env::var_os("RETAKE_DESKTOP_TEST_PICK").map(|v| std::env::split_paths(&v).collect::<Vec<_>>()).unwrap_or_default();
        if let Some(p) = picks.get(TEST_PICKED.fetch_add(1, Ordering::SeqCst)) {
            crate::log(&format!("(test mode) folder picker: {message} → {}", p.display()));
            return Some(p.clone());
        }
        crate::log(&format!("(test mode) no folder picker: {message}"));
        return None;
    }
    let mtm = MainThreadMarker::new()?;
    activate(mtm);
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setCanChooseDirectories(true);
    panel.setCanChooseFiles(false);
    panel.setAllowsMultipleSelection(false);
    panel.setCanCreateDirectories(true);
    panel.setTitle(Some(&NSString::from_str(title)));
    panel.setMessage(Some(&NSString::from_str(message)));
    panel.setPrompt(Some(&NSString::from_str(prompt)));
    let modal = Modal::enter();
    if quitting() {
        return None;
    }
    PICKER.with(|p| *p.borrow_mut() = Some(panel.clone()));
    let r = panel.runModal();
    PICKER.with(|p| *p.borrow_mut() = None);
    drop(modal);
    if r != MODAL_OK || quitting() {
        return None;
    }
    let path = panel.URL()?.path()?;
    Some(PathBuf::from(path.to_string()))
}

/// Show an alert; the index of the button pressed (`buttons` in order; the first is the default; the last is what
/// test mode and a stopped modal answer).
pub fn alert(title: &str, text: &str, buttons: &[&str]) -> usize {
    let last = buttons.len().saturating_sub(1);
    ask(title, text, buttons, last, &[]).unwrap_or(last)
}

/// The test answer of the next alert (RETAKE_DESKTOP_TEST_ANSWERS), if it names a button.
fn test_answer(buttons: usize) -> Option<usize> {
    let list = std::env::var("RETAKE_DESKTOP_TEST_ANSWERS").ok()?;
    let n = TEST_ANSWERED.fetch_add(1, Ordering::SeqCst);
    list.split(',').nth(n)?.trim().parse::<usize>().ok().filter(|i| *i < buttons)
}

/// RETAKE_DESKTOP_TEST_MODAL_MS (test mode only).
fn test_modal_ms() -> Option<u64> {
    std::env::var("RETAKE_DESKTOP_TEST_MODAL_MS").ok()?.parse().ok().filter(|ms| (100..=60_000).contains(ms))
}

/// What Return and Escape do on each button (AppKit's own: the first button takes Return, one titled Cancel takes
/// Escape when it is not the first; a destructive one here has none).
fn keys(a: &NSAlert, buttons: &[&str]) -> String {
    let list = a.buttons();
    (0..list.count())
        .map(|i| {
            let k = list.objectAtIndex(i).keyEquivalent().to_string();
            format!("{}={}", buttons.get(i).copied().unwrap_or("?"), match k.as_str() { "\r" => "return", "\u{1b}" => "escape", "" => "none", _ => "other" })
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Show an alert: the index of the button pressed; None when its modal loop was ended without a button (a signal —
/// the shell quitting — or the test's abort), or when the app is quitting (no new alert then). `cancel`: what test mode
/// answers; `destructive`: the buttons shown as destructive (never Return: critique M3, review B M4).
pub fn ask(title: &str, text: &str, buttons: &[&str], cancel: usize, destructive: &[usize]) -> Option<usize> {
    if quitting() {
        return None;
    }
    if headless() {
        crate::log(&format!("(test mode) alert: {title} — {text}"));
    }
    let mtm = MainThreadMarker::new()?;
    let a = NSAlert::new(mtm);
    a.setMessageText(&NSString::from_str(title));
    a.setInformativeText(&NSString::from_str(text));
    for b in buttons {
        a.addButtonWithTitle(&NSString::from_str(b));
    }
    let list = a.buttons();
    for &d in destructive {
        if d < list.count() {
            let b = list.objectAtIndex(d);
            b.setHasDestructiveAction(true);
            // Never Return: a reflex ⌘Q-Return (or Return on the restart alert) does not lose text.
            b.setKeyEquivalent(&NSString::from_str(""));
        }
    }
    let modal_ms = if headless() {
        crate::log(&format!("(test mode) alert keys: {}", keys(&a, buttons)));
        match test_modal_ms() {
            Some(ms) => Some(ms),
            None => return Some(test_answer(buttons.len()).unwrap_or(cancel)),
        }
    } else {
        None
    };
    activate(mtm);
    let modal = Modal::enter();
    if quitting() {
        return None;
    }
    if let Some(ms) = modal_ms {
        test_abort_after(modal.0, ms);
    }
    let r = a.runModal() - NSAlertFirstButtonReturn;
    drop(modal);
    let answer = (r >= 0 && (r as usize) < buttons.len()).then_some(r as usize);
    if modal_ms.is_some() {
        crate::log(&format!("(test mode) alert closed: {}", answer.map_or("no button (stopped or aborted)".to_string(), |i| buttons[i].to_string())));
    }
    answer
}
