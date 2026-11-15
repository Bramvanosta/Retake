// ! The two native dialogs of the shell, on the main thread: the workspace folder picker (NSOpenPanel, folders only) !
// and an alert with buttons (NSAlert). Under RETAKE_DESKTOP_TEST=1 neither is shown (a test never waits on a ! modal):
// the picker answers the folders of RETAKE_DESKTOP_TEST_PICK (a `:` list, each once: the gated test's ! File › Open
// Workspace…), then Cancel, and an alert prints its text and its buttons' keys and answers its cancel ! button
// (`alert`: the last; `ask`: the one it names) — or the next index of RETAKE_DESKTOP_TEST_ANSWERS ! (a `,` list, one
// per alert). RETAKE_DESKTOP_TEST_MODAL_MS=<ms> (test mode only) shows the alert for real and ! aborts it after that
// delay: the gated test's proof that a question is a real window that goes away, and that SIGTERM ! ends it. ! ! Every
// modal of the shell is counted while it is up: `end_modals` — the signal thread's, on ! SIGTERM / SIGINT / SIGHUP —
// ends whichever is up through `performSelectorOnMainThread:` (it runs in the modal panel ! mode: a run loop source of
// the modal loop, outside any callout of it): the picker by its own `cancel:`, an alert by ! `abortModal`, each only
// while `[NSApp modalWindow]` says a modal loop runs (abortModal without one raises). Once a ! signal asked to quit, no
// new modal opens (`quitting`): the code waiting on one goes on to the queued exit. The ! quit hook answers Cancel
// while one is up (guard.rs: no question nested in another, no `terminate:` inside a modal ! of a Tauri callback).

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject};
use objc2::{define_class, msg_send, sel, AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSApplication, NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSMenu, NSOpenPanel, NSWindow, NSWorkspace};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSString};
use std::cell::{Cell, RefCell};
use std::ptr::NonNull;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

/// NSModalResponseOK.
const MODAL_OK: isize = 1;

fn headless() -> bool {
    crate::test_mode()
}

/// A signal asked to quit: no new modal.
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
    /// Our context menu while AppKit tracks it (main thread; NSMenuDidBeginTrackingNotification): ended by
    /// `cancelTracking`.
    static POPUP: RefCell<Option<Retained<NSMenu>>> = const { RefCell::new(None) };
    /// A context menu of ours is being shown (the next menu that begins tracking is ours).
    static POPUP_WANTED: Cell<bool> = const { Cell::new(false) };
    /// The secondary-click monitor and the tracking observer, kept for the app's life.
    static KEPT: RefCell<Vec<Retained<AnyObject>>> = const { RefCell::new(Vec::new()) };
}
/// RETAKE_DESKTOP_TEST_POPUP_MS: the item test mode picks in the context menu shown (-1: none).
static TEST_POPUP_PICK: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(-1);

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

        /// A menu began tracking: ours, when a context menu of ours is being shown.
        #[unsafe(method(menuBegan:))]
        fn menu_began(&self, n: &NSNotification) {
            if !POPUP_WANTED.with(Cell::get) {
                // Another menu (WebKit's own in a text field, the menu bar's): the click it answered opens none of ours.
                crate::menu::other_menu_began();
                return;
            }
            if let Some(m) = n.object().and_then(|o| o.downcast::<NSMenu>().ok()) {
                POPUP.with(|p| *p.borrow_mut() = Some(m));
            }
        }

        /// Test mode's end of the context menu shown (RETAKE_DESKTOP_TEST_POPUP_MS): its pick, if any, then closed.
        #[unsafe(method(endTestPopup:))]
        fn end_test_popup(&self, _arg: *mut AnyObject) {
            let Some(m) = POPUP.with(|p| p.borrow().clone()) else { return };
            let pick = TEST_POPUP_PICK.swap(-1, Ordering::SeqCst);
            if pick >= 0 && pick < m.numberOfItems() {
                m.performActionForItemAtIndex(pick);
            }
            m.cancelTrackingWithoutAnimation();
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

/// On the main thread: end the modal loop that runs now (our context menu by `cancelTracking`, the picker by
/// `cancel:`, an alert by `abortModal`).
fn end_current() {
    let Some(mtm) = MainThreadMarker::new() else { return };
    if let Some(m) = POPUP.with(|p| p.borrow().clone()) {
        m.cancelTrackingWithoutAnimation();
        return;
    }
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

/// Ask for a folder with this panel title and button (the `retake` command's folder); as `pick_folder`.
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
/// answers; `destructive`: the buttons shown as destructive (never Return).
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

/// BL-167: the Dock icon's badge (the update's percent while it downloads; None clears it). Main thread only.
pub fn dock_badge(mtm: MainThreadMarker, label: Option<&str>) {
    let app = NSApplication::sharedApplication(mtm);
    // NSDockTile through the runtime: its feature of objc2-app-kit is not built in (no new package for one call).
    let tile: *mut AnyObject = unsafe { msg_send![&*app, dockTile] };
    if tile.is_null() {
        return;
    }
    let text = label.map(NSString::from_str);
    let ptr: *const NSString = text.as_deref().map_or(std::ptr::null(), |t| t as *const NSString);
    unsafe {
        let _: () = msg_send![tile, setBadgeLabel: ptr];
    }
}

// ---- The context menus (DESIGN §4j) ---------------------------------------------------------------------------

/// On the main thread, once the window exists: a local monitor of the app's mouse-downs, which tells `on_click` each
/// secondary click in the main window's content (desktop_core::menu::secondary_click) and its place (points from the
/// content's top left) — it never consumes an event; and the observer that finds our context menu while it is tracked.
pub fn install_context_monitor(window: &tauri::WebviewWindow, on_click: fn((f64, f64))) {
    let Some(_mtm) = MainThreadMarker::new() else { return };
    let Ok(ptr) = window.ns_window() else { return };
    // The one window of the app (main.rs WINDOW), alive while the app runs.
    let Some(win) = (unsafe { Retained::retain(ptr.cast::<NSWindow>()) }) else { return };
    let main_no = win.windowNumber();
    let block = block2::RcBlock::new(move |e: NonNull<NSEvent>| -> *mut NSEvent {
        let ev = unsafe { e.as_ref() };
        let kind = match ev.r#type() {
            NSEventType::RightMouseDown => desktop_core::menu::MouseDown::Right,
            NSEventType::LeftMouseDown => desktop_core::menu::MouseDown::Left,
            _ => desktop_core::menu::MouseDown::Other,
        };
        let p = ev.locationInWindow();
        let size = win.contentView().map(|v| v.frame().size);
        let in_content = size.is_some_and(|s| p.x >= 0.0 && p.y >= 0.0 && p.x <= s.width && p.y <= s.height);
        let control = ev.modifierFlags().contains(NSEventModifierFlags::Control);
        if desktop_core::menu::secondary_click(kind, control, ev.windowNumber() == main_no, in_content) {
            let h = size.map_or(0.0, |s| s.height);
            on_click((p.x, h - p.y));
        }
        e.as_ptr()
    });
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::RightMouseDown | NSEventMask::LeftMouseDown, &block) };
    let observer: Retained<Ender> = unsafe { msg_send![Ender::alloc(), init] };
    unsafe {
        NSNotificationCenter::defaultCenter().addObserver_selector_name_object(&observer, sel!(menuBegan:), Some(objc2_app_kit::NSMenuDidBeginTrackingNotification), None);
    }
    KEPT.with(|k| {
        let mut k = k.borrow_mut();
        k.push(Retained::into_super(Retained::into_super(observer)));
        if let Some(m) = monitor {
            k.push(m);
        }
    });
}

/// Show one of our context menus (`show` pops it: AppKit's tracking loop, on the main thread) as a shell modal:
/// counted while it is up (`modal_up`: no question or panel opens behind it) and ended by a signal (`end_modals`
/// cancels its tracking). False when it was not shown (the app quitting, not the main thread). Test mode closes it
/// after RETAKE_DESKTOP_TEST_POPUP_MS (default 400), picking item `pick` first (an index of the menu, separators
/// counted) — the native path of a person's click.
pub fn popup(show: impl FnOnce(), test_pick: Option<isize>) -> bool {
    if quitting() || MainThreadMarker::new().is_none() {
        return false;
    }
    let modal = Modal::enter();
    if headless() {
        let ms = std::env::var("RETAKE_DESKTOP_TEST_POPUP_MS").ok().and_then(|v| v.parse::<u64>().ok()).filter(|ms| (50..=10_000).contains(ms)).unwrap_or(400);
        TEST_POPUP_PICK.store(test_pick.unwrap_or(-1), Ordering::SeqCst);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            post_to_main(sel!(endTestPopup:));
        });
    }
    POPUP_WANTED.with(|w| w.set(true));
    show();
    POPUP_WANTED.with(|w| w.set(false));
    POPUP.with(|p| *p.borrow_mut() = None);
    drop(modal);
    true
}

/// File › Show Workspace in Finder: a Finder window with the workspace selected (test mode logs it instead).
pub fn reveal(path: &std::path::Path) {
    if headless() {
        crate::log(&format!("(test mode) reveal: {}", path.display()));
        return;
    }
    if MainThreadMarker::new().is_none() {
        return;
    }
    let ws = NSWorkspace::sharedWorkspace();
    let p = NSString::from_str(&path.to_string_lossy());
    let _ = ws.selectFile_inFileViewerRootedAtPath(Some(&p), &NSString::from_str(""));
}
