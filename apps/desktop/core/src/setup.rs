//! The installed app's first run and Set-up sheet (DESIGN §4p (c)): where the app runs from,
//! the first-run alert (no workspace yet), the `studio:setup` page event of the Help menu, and the lines the shell
//! writes on the server's stdin for the sheet (the folder picked in the native panel for the `retake` command, the
//! notification permission's state). Words and shapes only — main.rs shows the alert and the panel, child.rs writes
//! the lines; the server (ui setup-ops.ts) checks everything again.

use crate::json;
use std::path::{Path, PathBuf};

/// Where the app runs from: `Ok`, or a place that makes every integration point at a folder that goes away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallLocation {
    Ok,
    /// A quarantined app opened from Downloads or a disk image: a random read-only copy, gone after a restart.
    Translocated,
    /// A read-only volume (MNT_RDONLY: the mounted disk image).
    ReadOnly,
    /// Under /Volumes: a disk image or an external disk, which come and go.
    Volumes,
}

/// What the person does about a location that is not Ok (the same words as the engine's integrations/app-setup.ts).
pub const MOVE_TO_APPLICATIONS: &str = "Move Retake to Applications, then open it again";

/// Where `app` (the `.app` folder) runs from — the App Translocation marker first, then a read-only volume
/// (`read_only`: the caller's statfs MNT_RDONLY), then anything under /Volumes. Pure (the engine's
/// integrations/app-setup.ts `installLocation` has the same rules: the engine's app-setup test
/// (packages/engine/test/app-setup.test.ts) replays every `install_location` assert of this file's tests).
pub fn install_location(app: &Path, read_only: bool) -> InstallLocation {
    let s = app.to_string_lossy();
    if s.contains("/AppTranslocation/") {
        InstallLocation::Translocated
    } else if read_only {
        InstallLocation::ReadOnly
    } else if s == "/Volumes" || s.starts_with("/Volumes/") {
        InstallLocation::Volumes
    } else {
        InstallLocation::Ok
    }
}

/// Why a location stops the integrations, in a sentence (MOVE_TO_APPLICATIONS follows it).
pub fn location_words(loc: InstallLocation) -> &'static str {
    match loc {
        InstallLocation::Translocated => "Retake runs from a temporary copy macOS made when it was opened from Downloads or a disk image",
        InstallLocation::ReadOnly => "Retake runs from a read-only disk (its disk image)",
        InstallLocation::Volumes => "Retake runs from a disk under /Volumes, which can go away",
        InstallLocation::Ok => "Retake runs from where it was installed",
    }
}

/// The `.app` folder of the app's binary (`<X>.app/Contents/MacOS/<bin>`), or None (a bare binary: `desktop:dev`).
pub fn app_of_exe(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && app.extension()? == "app").then(|| app.to_path_buf())
}

/// The first run's workspace folder: `~/Retake`.
pub fn default_workspace(home: &Path) -> PathBuf {
    home.join("Retake")
}

/// The first-run alert (a bundled app with no workspace yet).
pub const FIRST_RUN_TITLE: &str = "Welcome to Retake";
pub const FIRST_RUN_BUTTONS: [&str; 3] = ["Create ~/Retake", "Choose a Folder…", "Quit"];

pub fn first_run_text(default_dir: &Path) -> String {
    format!(
        "Retake keeps your projects in a workspace folder. Create one at {} (a retake.yaml and a projects/ folder), or choose a folder: a workspace you have, or an empty folder to make one.",
        default_dir.display()
    )
}

/// The person's answer to the first-run alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstRun {
    Create,
    Choose,
    Quit,
}

/// The alert's button index (None: ended without a button — a signal, the test's abort) → the answer.
pub fn first_run_choice(answer: Option<usize>) -> FirstRun {
    match answer {
        Some(0) => FirstRun::Create,
        Some(1) => FirstRun::Choose,
        _ => FirstRun::Quit,
    }
}

/// The sections a `studio:setup` event may open on (ui shell/setup.ts SETUP_SECTIONS: a static test compares them).
pub const SETUP_SECTIONS: [&str; 2] = ["cli", "cli-remove"];

/// The page script of Help › Set Up Retake… (None) and Install / Uninstall the retake Command… (a section of
/// SETUP_SECTIONS); None for any other section. A constant shape: no data of anyone's.
pub fn setup_page_js(section: Option<&str>) -> Option<String> {
    let detail = match section {
        None => "{}".to_string(),
        Some(s) if SETUP_SECTIONS.contains(&s) => format!("{{\"section\":{}}}", json::quote(s)),
        Some(_) => return None,
    };
    Some(format!("window.dispatchEvent(new CustomEvent('studio:setup', {{ detail: {detail} }}))"))
}

/// The longest path the shell writes on the server's stdin (ui shell-line.ts parseShellLine: 4096 characters).
pub const SHELL_PATH_MAX: usize = 4096;

/// The longest line the shell writes on the server's stdin, in BYTES (UTF-8, its newline not counted): ui shell-line.ts
/// SHELL_LINE_MAX and the CLI's stdin reader drop anything longer (a cap in characters is not one in bytes — a JSON
/// escape is 6 bytes, a character up to 4).
pub const SHELL_LINE_MAX: usize = 8192;

/// A line the server will take: at most SHELL_LINE_MAX bytes, no newline inside.
pub fn fits_shell_line(line: &str) -> bool {
    line.len() <= SHELL_LINE_MAX && !line.contains(['\n', '\r'])
}

/// The line that gives the server the folder picked for the command: an absolute UTF-8 path, no NUL / newline, at
/// most SHELL_PATH_MAX characters, the line within SHELL_LINE_MAX bytes; None otherwise (then the cancelled line is sent).
pub fn cli_folder_line(path: &Path) -> Option<String> {
    let s = path.to_str()?;
    if !path.is_absolute() || s.chars().count() > SHELL_PATH_MAX || s.contains(['\0', '\n', '\r']) {
        return None;
    }
    Some(format!("{{\"type\":\"cli_folder\",\"path\":{}}}", json::quote(s))).filter(|l| fits_shell_line(l))
}

pub const CLI_FOLDER_CANCELLED_LINE: &str = "{\"type\":\"cli_folder_cancelled\"}";

/// Sent just before the folder panel shows: the sheet says "choose in the panel" only after it.
pub const CLI_FOLDER_OPEN_LINE: &str = "{\"type\":\"cli_folder_open\"}";

/// The notification permission as the server shows it: on, off, or not known.
pub fn notifications_line(granted: Option<bool>) -> String {
    let state = match granted {
        Some(true) => "on",
        Some(false) => "off",
        None => "unknown",
    };
    format!("{{\"type\":\"notifications\",\"state\":\"{state}\"}}")
}

/// Help's Install item's two labels (fixed words): another copy's command is replaced (the sheet's Replace).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliLabel {
    Install,
    Replace,
}

impl CliLabel {
    pub fn label(self) -> &'static str {
        match self {
            CliLabel::Install => "Install the retake Command…",
            CliLabel::Replace => "Replace the retake Command…",
        }
    }
}

/// Help's Install / Uninstall the retake Command… by what is installed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CliItems {
    pub install: bool,
    pub install_label: CliLabel,
    pub remove: bool,
}

/// The items for a build (`bundled`: the installed app — a developer build has no command of its own) and the
/// server's last word on the link (None: not told — an attached server, a server just started: both on, the sheet
/// says). This app's command (`ours`): Uninstall only (Install would be refused: one command per app). Another copy's
/// (`other_app`): Replace, no Uninstall (it removes only this app's link). Nothing or something else there: Install.
pub fn cli_items(bundled: bool, state: Option<crate::pipe::CliState>) -> CliItems {
    use crate::pipe::CliState;
    let (install, install_label, remove) = match (bundled, state) {
        (false, _) => (false, CliLabel::Install, false),
        (true, None) => (true, CliLabel::Install, true),
        (true, Some(CliState::Absent | CliState::Foreign)) => (true, CliLabel::Install, false),
        (true, Some(CliState::Ours)) => (false, CliLabel::Install, true),
        (true, Some(CliState::OtherApp)) => (true, CliLabel::Replace, false),
    };
    CliItems { install, install_label, remove }
}

/// The server's word in one byte (the shell keeps the latest in an atomic: the newest wins): 0 = not told.
pub fn cli_code(state: Option<crate::pipe::CliState>) -> u8 {
    state.map_or(0, |s| crate::pipe::CliState::ALL.iter().position(|x| *x == s).map_or(0, |i| i as u8 + 1))
}

/// `cli_code`'s inverse; an unknown byte is "not told".
pub fn cli_from_code(c: u8) -> Option<crate::pipe::CliState> {
    c.checked_sub(1).and_then(|i| crate::pipe::CliState::ALL.get(usize::from(i)).copied())
}

/// The line that asks the server to read the command's link again (the window became key: a link removed in
/// Terminal shows in Help at once).
pub const CLI_REFRESH_LINE: &str = "{\"type\":\"cli_refresh\"}";
/// At most one refresh line in this many ms.
pub const CLI_REFRESH_EVERY_MS: u64 = 2000;

/// Is a refresh due now (`last`: when the last one was sent)?
pub fn refresh_due(last_ms: Option<u64>, now_ms: u64) -> bool {
    last_ms.is_none_or(|l| now_ms < l || now_ms - l >= CLI_REFRESH_EVERY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The paths of a translocated copy, the mounted disk image and an external disk are each caught; an
    /// app in /Applications or ~/Applications is Ok — the same cases as the engine's integrations/app-setup.ts
    /// `installLocation`.
    #[test]
    fn install_location_on_fake_paths() {
        let p = |s: &str| PathBuf::from(s);
        assert_eq!(install_location(&p("/private/var/folders/xy/T/AppTranslocation/0A1B-2C3D/d/Retake.app"), false), InstallLocation::Translocated);
        assert_eq!(install_location(&p("/private/var/folders/xy/T/AppTranslocation/0A1B-2C3D/d/Retake.app"), true), InstallLocation::Translocated);
        assert_eq!(install_location(&p("/Volumes/Retake/Retake.app"), true), InstallLocation::ReadOnly);
        assert_eq!(install_location(&p("/Applications/Retake.app"), true), InstallLocation::ReadOnly);
        assert_eq!(install_location(&p("/Volumes/External/Apps/Retake.app"), false), InstallLocation::Volumes);
        assert_eq!(install_location(&p("/Volumes"), false), InstallLocation::Volumes);
        assert_eq!(install_location(&p("/Applications/Retake.app"), false), InstallLocation::Ok);
        assert_eq!(install_location(&p("/Users/me/Applications/Retake.app"), false), InstallLocation::Ok);
        // Only the folder name counts, not a look-alike.
        assert_eq!(install_location(&p("/Users/me/VolumesOld/Retake.app"), false), InstallLocation::Ok);
        assert_eq!(install_location(&p("/VolumesOld/Retake.app"), false), InstallLocation::Ok);
        assert_eq!(install_location(&p("/VolumesX/Apps/Retake.app"), false), InstallLocation::Ok);
        assert_eq!(install_location(&p("/Users/me/AppTranslocationNotes/Retake.app"), false), InstallLocation::Ok);
        for loc in [InstallLocation::Translocated, InstallLocation::ReadOnly, InstallLocation::Volumes] {
            assert!(location_words(loc).starts_with("Retake runs from"));
        }
        assert_eq!(MOVE_TO_APPLICATIONS, "Move Retake to Applications, then open it again");
    }

    #[test]
    fn the_app_of_a_binary() {
        assert_eq!(app_of_exe(Path::new("/Applications/Retake.app/Contents/MacOS/retake-desktop")), Some(PathBuf::from("/Applications/Retake.app")));
        assert_eq!(app_of_exe(Path::new("/x/target/debug/retake-desktop")), None);
        assert_eq!(app_of_exe(Path::new("/x/Retake.app/Contents/Resources/retake-desktop")), None);
    }

    #[test]
    fn first_run_answers_and_words() {
        assert_eq!(first_run_choice(Some(0)), FirstRun::Create);
        assert_eq!(first_run_choice(Some(1)), FirstRun::Choose);
        assert_eq!(first_run_choice(Some(2)), FirstRun::Quit);
        assert_eq!(first_run_choice(None), FirstRun::Quit);
        assert_eq!(first_run_choice(Some(7)), FirstRun::Quit);
        assert_eq!(default_workspace(Path::new("/Users/me")), PathBuf::from("/Users/me/Retake"));
        assert!(first_run_text(Path::new("/Users/me/Retake")).contains("/Users/me/Retake"));
        assert_eq!(FIRST_RUN_BUTTONS[0], "Create ~/Retake");
    }

    #[test]
    fn the_setup_event_has_a_constant_shape() {
        assert_eq!(setup_page_js(None).unwrap(), "window.dispatchEvent(new CustomEvent('studio:setup', { detail: {} }))");
        assert_eq!(setup_page_js(Some("cli")).unwrap(), "window.dispatchEvent(new CustomEvent('studio:setup', { detail: {\"section\":\"cli\"} }))");
        assert!(setup_page_js(Some("cli-remove")).is_some());
        for bad in ["", "claude", "cli'); alert(1); ('", "CLI"] {
            assert_eq!(setup_page_js(Some(bad)), None, "{bad}");
        }
    }

    #[test]
    fn the_lines_for_the_server() {
        assert_eq!(cli_folder_line(Path::new("/Users/me/bin")).unwrap(), r#"{"type":"cli_folder","path":"/Users/me/bin"}"#);
        assert_eq!(cli_folder_line(Path::new("/Users/me/a \"b\"")).unwrap(), r#"{"type":"cli_folder","path":"/Users/me/a \"b\""}"#);
        assert_eq!(cli_folder_line(Path::new("relative/bin")), None);
        assert_eq!(cli_folder_line(Path::new("/a\nb")), None);
        assert_eq!(cli_folder_line(&PathBuf::from(format!("/{}", "a".repeat(SHELL_PATH_MAX)))), None);
        assert!(cli_folder_line(&PathBuf::from(format!("/{}", "a".repeat(SHELL_PATH_MAX - 1)))).is_some());
        // The line's cap counts bytes — 4095 four-byte characters fit the path's 4096 characters, not
        // the server's 8192 bytes.
        assert_eq!(cli_folder_line(&PathBuf::from(format!("/{}", "\u{1f600}".repeat(SHELL_PATH_MAX - 1)))), None);
        assert!(fits_shell_line(&"a".repeat(SHELL_LINE_MAX)) && !fits_shell_line(&"a".repeat(SHELL_LINE_MAX + 1)) && !fits_shell_line("a\nb"));
        assert_eq!(notifications_line(Some(true)), r#"{"type":"notifications","state":"on"}"#);
        assert_eq!(notifications_line(Some(false)), r#"{"type":"notifications","state":"off"}"#);
        assert_eq!(notifications_line(None), r#"{"type":"notifications","state":"unknown"}"#);
        assert_eq!(CLI_FOLDER_OPEN_LINE, r#"{"type":"cli_folder_open"}"#);
        assert_eq!(CLI_FOLDER_CANCELLED_LINE, r#"{"type":"cli_folder_cancelled"}"#);
    }

    #[test]
    fn the_cli_items_by_bundle_and_link_state() {
        use crate::pipe::CliState;
        let i = |install, install_label, remove| CliItems { install, install_label, remove };
        // A developer build: both greyed, whatever the server says.
        for s in [None, Some(CliState::Ours), Some(CliState::Absent)] {
            assert_eq!(cli_items(false, s), i(false, CliLabel::Install, false));
        }
        assert_eq!(cli_items(true, None), i(true, CliLabel::Install, true));
        assert_eq!(cli_items(true, Some(CliState::Absent)), i(true, CliLabel::Install, false));
        assert_eq!(cli_items(true, Some(CliState::Foreign)), i(true, CliLabel::Install, false));
        assert_eq!(cli_items(true, Some(CliState::Ours)), i(false, CliLabel::Install, true));
        assert_eq!(cli_items(true, Some(CliState::OtherApp)), i(true, CliLabel::Replace, false));
        assert_eq!(CliLabel::Install.label(), "Install the retake Command…");
        assert_eq!(CliLabel::Replace.label(), "Replace the retake Command…");
        for s in [None, Some(CliState::Absent), Some(CliState::Ours), Some(CliState::OtherApp), Some(CliState::Foreign)] {
            assert_eq!(cli_from_code(cli_code(s)), s);
        }
        assert_eq!(cli_code(None), 0);
        assert_eq!(cli_from_code(99), None);
    }

    #[test]
    fn the_cli_refresh_line_is_sent_at_most_every_two_seconds() {
        assert_eq!(CLI_REFRESH_LINE, r#"{"type":"cli_refresh"}"#);
        assert!(fits_shell_line(CLI_REFRESH_LINE));
        assert!(refresh_due(None, 0));
        assert!(!refresh_due(Some(1000), 1000));
        assert!(!refresh_due(Some(1000), 1000 + CLI_REFRESH_EVERY_MS - 1));
        assert!(refresh_due(Some(1000), 1000 + CLI_REFRESH_EVERY_MS));
        // A clock that went back sends one (never stuck).
        assert!(refresh_due(Some(5000), 10));
    }
}
