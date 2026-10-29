//! The two native dialogs of the shell, on the main thread: the workspace folder picker (NSOpenPanel, folders only)
//! and an alert with buttons (NSAlert). Under DEMO_STUDIO_DESKTOP_TEST=1 neither is shown (a test never waits on a
//! modal): the picker answers the folders of DEMO_STUDIO_DESKTOP_TEST_PICK (a `:` list, each once: the gated test's
//! File › Open Workspace…), then Cancel, and an alert prints its text and answers its last button.

use objc2::MainThreadMarker;
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSApplication, NSOpenPanel};
use objc2_foundation::NSString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

/// NSModalResponseOK.
const MODAL_OK: isize = 1;

fn headless() -> bool {
    crate::test_mode()
}

fn activate(mtm: MainThreadMarker) {
    NSApplication::sharedApplication(mtm).activate();
}

static TEST_PICKED: AtomicUsize = AtomicUsize::new(0);

/// Ask for a workspace folder; None when cancelled (or not on the main thread).
pub fn pick_folder(message: &str) -> Option<PathBuf> {
    if headless() {
        let picks = std::env::var_os("DEMO_STUDIO_DESKTOP_TEST_PICK").map(|v| std::env::split_paths(&v).collect::<Vec<_>>()).unwrap_or_default();
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
    panel.setTitle(Some(&NSString::from_str(&format!("Open a {} workspace", crate::app_name()))));
    panel.setMessage(Some(&NSString::from_str(message)));
    panel.setPrompt(Some(&NSString::from_str("Open")));
    if panel.runModal() != MODAL_OK {
        return None;
    }
    let path = panel.URL()?.path()?;
    Some(PathBuf::from(path.to_string()))
}

/// Show an alert; the index of the button pressed (`buttons` in order; the first is the default).
pub fn alert(title: &str, text: &str, buttons: &[&str]) -> usize {
    let last = buttons.len().saturating_sub(1);
    if headless() {
        crate::log(&format!("(test mode) alert: {title} — {text}"));
        return last;
    }
    let Some(mtm) = MainThreadMarker::new() else { return last };
    activate(mtm);
    let a = NSAlert::new(mtm);
    a.setMessageText(&NSString::from_str(title));
    a.setInformativeText(&NSString::from_str(text));
    for b in buttons {
        a.addButtonWithTitle(&NSString::from_str(b));
    }
    let r = a.runModal() - NSAlertFirstButtonReturn;
    if r >= 0 && (r as usize) < buttons.len() {
        r as usize
    } else {
        last
    }
}
