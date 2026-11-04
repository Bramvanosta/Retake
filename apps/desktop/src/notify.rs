//! Job notifications (L5.2b, DESIGN §4j): a capture, render, review, export, recording… that ends while the window is
//! not in front posts a macOS notification (UNUserNotificationCenter) — the shell's words (desktop_core::words), the
//! no-storm rule of desktop_core::Notifier (one post at once, then one summary per 5 s), grouped under one thread, no
//! sound. A click shows the window. In front (the app active, its window key, visible, not minimised): nothing — the
//! page shows it.
//!
//! - Permission is asked on the first notification that would be shown (a prompt with context, never at launch), and
//!   that first one is posted once granted (if the answer came within a minute). A no or an error is not kept for the
//!   session (review B L9, desktop_core::Permission): the next notification asks again — no prompt once the person
//!   answered, so turning them on in System Settings works without a relaunch — and each outcome is said once, an error
//!   with its domain and code.
//! - Only a real bundle calls UN (`desktop:dev` runs a bare binary: UN would raise) — said once otherwise.
//! - Test mode never calls UN (no prompt, nothing in the person's notification settings): it logs
//!   `(test mode) notification: <title> — <body>` and `(test mode) notification dropped (window in front): <n>`;
//!   RETAKE_DESKTOP_TEST_FRONT=0|1 says whether the window counts as in front.
//! - An attached server has no pipe: no notifications (main.rs says so at attach).

use crate::{lock, log, test_mode};
use block2::RcBlock;
use desktop_core::{notification_text, AuthAnswer, AuthStep, Decision, JobEnd, Notifier, Permission};
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, MainThreadMarker};
use objc2_app_kit::NSApplication;
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();
static NOTIFIER: Mutex<Option<Notifier>> = Mutex::new(None);
static PERMISSION: Mutex<Option<Permission>> = Mutex::new(None);
/// The notification waiting for the permission answer (the latest one).
static WAITING: Mutex<Option<(Instant, String, String)>> = Mutex::new(None);
static SAID_UNBUNDLED: AtomicBool = AtomicBool::new(false);
static SAID_FAILED: AtomicBool = AtomicBool::new(false);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// A first notification older than this when permission is granted is not posted late.
const WAITING_MAX: Duration = Duration::from_secs(60);

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "StudioShellNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// The app active with its window hidden: still a banner (and in the list).
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _c: &UNUserNotificationCenter, _n: &UNNotification, done: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
            done.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List,));
        }

        /// A click: the window, in front (no navigation to the job's screen: BL-125).
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _c: &UNUserNotificationCenter, _r: &UNNotificationResponse, done: &block2::DynBlock<dyn Fn()>) {
            if let Some(app) = APP.get() {
                let h = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(mtm) = MainThreadMarker::new() {
                        NSApplication::sharedApplication(mtm).activate();
                    }
                    crate::show_window(&h);
                });
            }
            done.call(());
        }
    }
);

/// A real app bundle (`<App>.app` with a bundle id): the only place UN may be called.
fn bundled() -> bool {
    let b = NSBundle::mainBundle();
    b.bundleIdentifier().is_some() && b.bundlePath().to_string().ends_with(".app")
}

/// At launch (`setup`): the clock of the summaries; the UN delegate when bundled (a click on a notification left in
/// Notification Center from an earlier session then still shows the window — no prompt comes from it).
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    *lock(&NOTIFIER) = Some(Notifier::new());
    if !test_mode() && bundled() {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let d: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*d)));
        // The center holds its delegate weakly: this one lives as long as the app.
        std::mem::forget(d);
    }
    let h = app.clone();
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let h2 = h.clone();
        if h.run_on_main_thread(move || tick(&h2)).is_err() {
            return;
        }
    });
}

/// RETAKE_DESKTOP_TEST_FRONT (test mode only).
fn test_front() -> Option<bool> {
    if !test_mode() {
        return None;
    }
    match std::env::var("RETAKE_DESKTOP_TEST_FRONT").as_deref() {
        Ok("1") => Some(true),
        Ok("0") => Some(false),
        _ => None,
    }
}

/// The window is in front: the app active, the window key, visible, not minimised (main thread).
fn front(app: &AppHandle) -> bool {
    if let Some(f) = test_front() {
        return f;
    }
    let active = MainThreadMarker::new().is_some_and(|mtm| NSApplication::sharedApplication(mtm).isActive());
    let Some(w) = app.get_webview_window(crate::WINDOW) else { return false };
    active && w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(true)
}

/// A job ended (from the child's reader thread).
pub fn job_end(app: &AppHandle, end: JobEnd) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        let in_front = front(&h);
        let d = lock(&NOTIFIER).as_mut().map(|n| n.on_job_end(end, Instant::now(), in_front));
        act(d);
    });
}

fn tick(app: &AppHandle) {
    let mut n = lock(&NOTIFIER);
    // Cheap when nothing is held: the window is only looked at for a summary.
    let d = match n.as_mut() {
        Some(n) if n.has_held() => Some(n.on_tick(Instant::now(), front(app))),
        _ => None,
    };
    drop(n);
    act(d);
}

fn act(d: Option<Decision>) {
    match d {
        Some(Decision::Post { ends, more }) => {
            let (title, body) = notification_text(&ends, more);
            post(title, body);
        }
        Some(Decision::Dropped(n)) if test_mode() => log(&format!("(test mode) notification dropped (window in front): {n}")),
        _ => {}
    }
}

fn post(title: String, body: String) {
    if test_mode() {
        log(&format!("(test mode) notification: {title} — {}", body.replace('\n', " / ")));
        return;
    }
    if !bundled() {
        if !SAID_UNBUNDLED.swap(true, Ordering::SeqCst) {
            log("notifications need the app bundle (a development build: pnpm desktop:build): not shown");
        }
        return;
    }
    let step = lock(&PERMISSION).get_or_insert_with(Permission::default).on_post();
    match step {
        AuthStep::Post => add(&title, &body),
        AuthStep::Wait => *lock(&WAITING) = Some((Instant::now(), title, body)),
        AuthStep::Ask => {
            *lock(&WAITING) = Some((Instant::now(), title, body));
            let answered = RcBlock::new(|granted: Bool, e: *mut NSError| {
                let answer = if granted.as_bool() {
                    AuthAnswer::Granted
                } else if e.is_null() {
                    AuthAnswer::Denied
                } else {
                    // SAFETY: a non-null NSError the completion handler hands over, read for its domain and code only.
                    let e = unsafe { &*e };
                    AuthAnswer::Error(e.domain().to_string(), e.code() as i64)
                };
                let (ok, line) = lock(&PERMISSION).get_or_insert_with(Permission::default).on_answer(answer, crate::app_name());
                if let Some(l) = line {
                    log(&l);
                }
                let waiting = lock(&WAITING).take();
                if let (true, Some((at, t, b))) = (ok, waiting) {
                    if at.elapsed() < WAITING_MAX {
                        add(&t, &b);
                    }
                }
            });
            UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert, &answered);
        }
    }
}

/// L5.16c, the Set-up sheet's Allow…: ask macOS for the permission now (it prompts only when the person never answered;
/// otherwise it answers what they chose), and tell the server the outcome (desktop_core::setup::notifications_line).
/// Test mode never calls UN: it logs and answers `unknown`; a bare binary has no bundle id to ask for.
pub fn request_permission(_app: &AppHandle) {
    if test_mode() {
        log("(test mode) notifications: the permission would be asked now (set-up)");
        crate::send_to_server(&desktop_core::setup::notifications_line(None));
        return;
    }
    if !bundled() {
        log("notifications need the app bundle: not asked");
        crate::send_to_server(&desktop_core::setup::notifications_line(None));
        return;
    }
    let answered = RcBlock::new(|granted: Bool, e: *mut NSError| {
        let answer = if granted.as_bool() {
            AuthAnswer::Granted
        } else if e.is_null() {
            AuthAnswer::Denied
        } else {
            // SAFETY: a non-null NSError the completion handler hands over, read for its domain and code only.
            let e = unsafe { &*e };
            AuthAnswer::Error(e.domain().to_string(), e.code() as i64)
        };
        let errored = matches!(answer, AuthAnswer::Error(..));
        let (ok, line) = lock(&PERMISSION).get_or_insert_with(Permission::default).on_answer(answer, crate::app_name());
        if let Some(l) = line {
            log(&l);
        }
        crate::send_to_server(&desktop_core::setup::notifications_line(if errored { None } else { Some(ok) }));
    });
    UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert, &answered);
}

/// Post one notification (permission granted). Grouped under one thread, no sound.
fn add(title: &str, body: &str) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setThreadIdentifier(&NSString::from_str("jobs"));
    let id = NSString::from_str(&format!("job-{}", NEXT_ID.fetch_add(1, Ordering::SeqCst)));
    let req = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
    let done = RcBlock::new(|e: *mut NSError| {
        if !e.is_null() && !SAID_FAILED.swap(true, Ordering::SeqCst) {
            log("a notification could not be posted (macOS refused it)");
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&req, Some(&done));
}
