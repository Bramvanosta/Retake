//! The updater's rules (L5.16d, DESIGN §4p (d)) — pure, so each one is a unit test; main.rs / update.rs do the I/O
//! (tauri-plugin-updater, the quit guard, the server's stdin).
//!
//! - Which build can update itself (`availability`): only one made with the cargo `updater` feature (bundle.mjs, when
//!   the build was given a feed and a public key: `plugins.updater` comes from its generated overlay, never from the
//!   repository); RETAKE_DISABLE_UPDATE_CHECK=1 (or true / yes) turns the checks off; an app running from a translocated
//!   copy or a read-only disk cannot replace itself (critique H1: the plugin's renames need a writable folder on the
//!   app's volume) — "Move Retake to Applications".
//! - When (`launch_check_due`): at launch, at most once a day (the last successful check is remembered in
//!   `<Retake home>/desktop-updates.json`, which doctor reads too: critique L7) — at once after an install that failed;
//!   Help › Check for Updates… asks now, unless an install is under way (`check_refused`: said, never silent).
//! - Install (`install_step`): only on the person's click (the Studio's sheet, or the native alert when the page cannot
//!   show it), never while a job of this workspace runs or waits (critique M6: an idle worker hands over by itself when
//!   its code changes; a running one is waited for), then as a quit through the existing quit guard (Action::Update:
//!   unsaved text asks, the page's sheet first) — the owned server stops gracefully, the plugin swaps the bundle, the
//!   app restarts. The person's Install and Restart holds however long the question waits (`Arm`); an approved install
//!   ends in the swap and a restart, or a failure said. An install that fails keeps the old app: it restarts and says so
//!   (`Remembered::failed`, kept until a newer check, an install or the person's Later: doctor says it meanwhile).
//! - The download (review d A-M2 / A-M4): a timeout on the check, a byte cap, a stall and a total limit, Later aborts it
//!   (`watch`: a seam unit-tested with an endless and a hanging producer); the verified archive is kept in a 0600 file in
//!   the app's cache folder, never in memory (`write_archive`), removed after the install, on Later and at the next start.
//! - What the server is told (`state_line`): one JSON line per state on its stdin, fixed keys, enums, a checked version
//!   and the feed's notes cleaned (`clean_notes`: no control or bidi character, at most NOTES_MAX characters, the line
//!   within SHELL_LINE_MAX bytes) — the feed is not signed (only the archive is): the Studio shows the notes as untrusted
//!   text (Txt); the native alert never shows them.

use crate::json::{self, Json};
use crate::pipe::Pending;
use crate::setup::{fits_shell_line, InstallLocation};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Turns the update checks off (1, true or yes).
pub const DISABLE_ENV: &str = "RETAKE_DISABLE_UPDATE_CHECK";
/// The automatic check runs at most this often (seconds).
pub const CHECK_EVERY_S: u64 = 24 * 60 * 60;
/// The longest notes kept (characters).
pub const NOTES_MAX: usize = 2000;
/// The longest version taken (characters).
pub const VERSION_MAX: usize = 64;
/// The remembered checks, in the Retake home.
pub const UPDATES_FILE: &str = "desktop-updates.json";
/// The page's event: refresh the update state and open the sheet (packages/ui shell/update.ts UPDATE_EVENT).
pub const UPDATE_EVENT: &str = "studio:update";

/// RETAKE_DISABLE_UPDATE_CHECK's value turns the checks off.
pub fn disabled(v: Option<&str>) -> bool {
    v.is_some_and(|v| {
        let v = v.trim();
        v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("yes")
    })
}

/// Why this app does not update itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Off {
    /// A build without the updater (the developer build, a bundle built without a feed and a key).
    Build,
    /// RETAKE_DISABLE_UPDATE_CHECK.
    Disabled,
    /// A translocated copy or a read-only disk.
    Location(InstallLocation),
}

impl Off {
    pub fn wire(self) -> &'static str {
        match self {
            Off::Build => "build",
            Off::Disabled => "disabled",
            Off::Location(InstallLocation::Translocated) => "translocated",
            Off::Location(_) => "read_only",
        }
    }

    /// The sentence the Help menu's alert says (the Studio has its own words for the same enums).
    pub fn words(self, app: &str) -> String {
        match self {
            Off::Build => "Updates are off in this build.".into(),
            Off::Disabled => format!("Update checks are off ({DISABLE_ENV} is set)."),
            Off::Location(loc) => format!("{}: it cannot replace itself there. {}.", crate::setup::location_words(loc).replace("Retake", app), crate::setup::MOVE_TO_APPLICATIONS.replace("Retake", app)),
        }
    }
}

/// None: this app can update itself. `built`: the build has the updater (the cargo feature and its config).
pub fn availability(built: bool, disabled: bool, loc: InstallLocation) -> Option<Off> {
    if !built {
        Some(Off::Build)
    } else if disabled {
        Some(Off::Disabled)
    } else {
        match loc {
            InstallLocation::Translocated | InstallLocation::ReadOnly => Some(Off::Location(loc)),
            // An external disk is writable: the plugin's temporary folders go next to the app there.
            InstallLocation::Volumes | InstallLocation::Ok => None,
        }
    }
}

/// The automatic check is due: never checked, a day since the last successful one, or a clock that went back.
pub fn check_due(last: Option<u64>, now: u64) -> bool {
    match last {
        None => true,
        Some(t) => t > now || now - t >= CHECK_EVERY_S,
    }
}

/// The launch check: due by the day rule — or at once when an install failed (review d B-M2: the Studio then shows a
/// fresh answer, never a dead Install and Restart).
pub fn launch_check_due(last: Option<u64>, now: u64, failed_remembered: bool) -> bool {
    failed_remembered || check_due(last, now)
}

/// Why a check is refused now (said: Help's alert), or None. A check while an install is under way would drop the
/// downloaded archive the wait holds (review d B-M1); a check already under way answers itself.
pub fn check_refused(s: &State, app: &str) -> Option<String> {
    match s {
        State::Checking => Some(format!("{app} is checking for updates already.")),
        State::Downloading { version } => Some(format!("{app} is downloading {version}: Later in the Studio's update sheet stops it.")),
        State::Waiting { version, .. } => Some(format!("{app} waits for its jobs to end to install {version}: Later in the Studio's update sheet stops it.")),
        State::Installing { version } => Some(format!("{app} is quitting to install {version}.")),
        _ => None,
    }
}

/// What went wrong (the Studio's words are keyed by these: shell/update.ts FAILURES).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The feed could not be read (network, an unparsable manifest, no entry for this Mac).
    Check,
    /// The archive could not be downloaded, or its signature (or its signed version) did not match.
    Download,
    /// The swap failed: the old app was kept.
    Install,
    /// The app's folder is not writable by this user (a root-owned /Applications): no swap is tried.
    NotWritable,
}

impl Failure {
    pub const ALL: [Failure; 4] = [Failure::Check, Failure::Download, Failure::Install, Failure::NotWritable];

    pub fn wire(self) -> &'static str {
        match self {
            Failure::Check => "check",
            Failure::Download => "download",
            Failure::Install => "install",
            Failure::NotWritable => "not_writable",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Failure::ALL.into_iter().find(|f| f.wire() == s)
    }

    pub fn words(self, app: &str, current: &str) -> String {
        match self {
            Failure::Check => "The update feed could not be read.".into(),
            Failure::Download => "The update could not be downloaded, or its signature did not match: nothing was installed.".into(),
            Failure::Install => format!("The update could not be installed: {app} {current} was kept."),
            Failure::NotWritable => format!("{app} cannot replace itself in its folder (this account may not write there): install the new version from its disk image."),
        }
    }

    /// The person may click Install and Restart again (with an update known): a download that failed may work next time,
    /// a failed install once a fresh check found the update again; a folder this account may not write, never.
    pub fn retry(self, found: bool) -> bool {
        found && matches!(self, Failure::Download | Failure::Install)
    }
}

/// A swap that failed AND could not put the old app back (the plugin's fallback path, rare): the app is gone from its
/// place — said in an alert before exiting, no restart (there is nothing to start).
pub fn not_restored_words(app: &str, kept: &str) -> String {
    format!("The update could not be installed, and the previous {app} could not be put back in its place. It was kept at:\n{kept}\nMove it back to its folder (named {app}.app), then open it.")
}

/// What a click on Install and Restart does now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Nothing happens: why.
    Refuse(Refusal),
    /// Jobs of this workspace run or wait: the install waits for them (the person may say Later).
    Wait { jobs: u32 },
    /// Quit through the quit guard (Action::Update): unsaved text asks; then install and restart.
    Quit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Off(Off),
    /// No update was found by the last check (or it was installed already).
    NoUpdate,
    NotWritable,
}

/// The rules of an install request: off → refused; no update known → refused; a folder this user cannot write →
/// refused (no admin prompt from a background flow); jobs of this workspace (the owned server's last `pending`) →
/// wait; else quit through the guard. `pending` None: no server of this app's own (attached, or none) — nothing to
/// wait for here.
pub fn install_step(off: Option<Off>, has_update: bool, writable: bool, pending: Option<&Pending>) -> Step {
    if let Some(o) = off {
        return Step::Refuse(Refusal::Off(o));
    }
    if !has_update {
        return Step::Refuse(Refusal::NoUpdate);
    }
    if !writable {
        return Step::Refuse(Refusal::NotWritable);
    }
    match pending {
        Some(p) if p.jobs_total > 0 => Step::Wait { jobs: p.jobs_total },
        _ => Step::Quit,
    }
}

/// A version as the feed and the plugin give it: `major.minor.patch`, an optional `-pre` of `[0-9A-Za-z.-]`, at most
/// VERSION_MAX characters.
pub fn version_ok(v: &str) -> bool {
    if v.is_empty() || v.len() > VERSION_MAX {
        return false;
    }
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && pre.map_or(true, |p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-'))
}

/// The feed's notes as the Studio may show them: CR LF → LF, tabs → a space, every other control, bidi or zero-width
/// character dropped, at most NOTES_MAX characters (then "…"), trimmed.
pub fn clean_notes(notes: &str) -> String {
    let mut out = String::new();
    let mut n = 0;
    for c in notes.replace("\r\n", "\n").chars() {
        let c = match c {
            '\t' => ' ',
            '\n' => '\n',
            c if c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}') => continue,
            c => c,
        };
        if n == NOTES_MAX {
            out.push('…');
            break;
        }
        out.push(c);
        n += 1;
    }
    out.trim().to_string()
}

/// The update's state as the server is told it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    Off(Off),
    /// Up to date (or not checked yet: `checked` None).
    Idle { checked: Option<u64> },
    Checking,
    Available { version: String, notes: String, checked: Option<u64> },
    Downloading { version: String },
    Waiting { version: String, jobs: u32 },
    /// The quit (and its question) is under way.
    Installing { version: String },
    /// `retry`: Install and Restart may be clicked again (`Failure::retry`).
    Failed { failure: Failure, version: Option<String>, checked: Option<u64>, retry: bool },
}

fn opt_num(v: Option<u64>) -> String {
    v.map_or_else(|| "null".into(), |n| n.to_string())
}

/// The line for the server's stdin (ui desktop.ts parseShellLine takes exactly these keys per state); None when a
/// version fails `version_ok` (nothing is sent: the server keeps its last state). `current`: this app's version. The
/// notes are shortened (then "…") until the line fits SHELL_LINE_MAX bytes (review d B-L4).
pub fn state_line(current: &str, s: &State) -> Option<String> {
    let State::Available { version, notes, checked } = s else { return state_line_with(current, s, "") };
    let mut keep: Vec<char> = clean_notes(notes).chars().collect();
    let mut cut = false;
    loop {
        let mut n: String = keep.iter().collect();
        if cut {
            n = format!("{}…", n.trim_end());
        }
        let line = state_line_with(current, &State::Available { version: version.clone(), notes: String::new(), checked: *checked }, &n)?;
        if fits_shell_line(&line) {
            return Some(line);
        }
        let over = line.len() - crate::setup::SHELL_LINE_MAX;
        // At most 6 bytes a character once quoted: drop at least what is over, a character at the least.
        let drop = (over / 6).max(1).min(keep.len());
        if drop == 0 {
            return None;
        }
        keep.truncate(keep.len() - drop);
        cut = true;
    }
}

/// `state_line` with Available's notes given already cleaned (`notes`; ignored for the other states).
fn state_line_with(current: &str, s: &State, notes: &str) -> Option<String> {
    let v = |x: &str| version_ok(x).then(|| json::quote(x));
    let head = |state: &str| format!("{{\"type\":\"update\",\"state\":\"{state}\",\"current\":{}", json::quote(current));
    if !version_ok(current) {
        return None;
    }
    Some(match s {
        State::Off(o) => format!("{},\"reason\":\"{}\"}}", head("off"), o.wire()),
        State::Idle { checked } => format!("{},\"checked\":{}}}", head("idle"), opt_num(*checked)),
        State::Checking => format!("{}}}", head("checking")),
        State::Available { version, checked, .. } => format!("{},\"version\":{},\"notes\":{},\"checked\":{}}}", head("available"), v(version)?, json::quote(notes), opt_num(*checked)),
        State::Downloading { version } => format!("{},\"version\":{}}}", head("downloading"), v(version)?),
        State::Waiting { version, jobs } => format!("{},\"version\":{},\"jobs\":{}}}", head("waiting"), v(version)?, jobs),
        State::Installing { version } => format!("{},\"version\":{}}}", head("installing"), v(version)?),
        State::Failed { failure, version, checked, retry } => {
            let ver = match version {
                Some(x) => v(x)?,
                None => "null".into(),
            };
            // No version known: nothing to retry.
            let retry = *retry && version.is_some();
            format!("{},\"failure\":\"{}\",\"version\":{ver},\"checked\":{},\"retry\":{retry}}}", head("failed"), failure.wire(), opt_num(*checked))
        }
    })
}

/// The page script of Help › Check for Updates… when an update is there: the Studio refreshes its state and opens its
/// sheet. A constant: no data of anyone's.
pub fn update_page_js() -> String {
    format!("window.dispatchEvent(new CustomEvent({}, {{ detail: {{}} }}))", json::quote(UPDATE_EVENT))
}

/// What `<Retake home>/desktop-updates.json` remembers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Remembered {
    /// The last successful check (seconds since 1970).
    pub checked: Option<u64>,
    /// An install that failed (the old app restarted): said by the next launch, and kept (doctor says it too) until
    /// `failed_after_check` drops it, an install succeeds, or the person's Later acknowledges it (review d B-L2).
    pub failed: Option<(Failure, String)>,
}

/// The remembered failure after a successful check that found `found` (None: up to date): kept while the feed still
/// offers the version that failed, dropped otherwise (a newer version, or none).
pub fn failed_after_check(failed: Option<(Failure, String)>, found: Option<&str>) -> Option<(Failure, String)> {
    failed.filter(|(_, v)| Some(v.as_str()) == found)
}

/// The remembered checks (nothing, or anything unreadable: the default — the next check is due).
pub fn read_remembered(home: &Path) -> Remembered {
    let Ok(text) = fs::read_to_string(home.join(UPDATES_FILE)) else { return Remembered::default() };
    let Ok(v) = json::parse(&text) else { return Remembered::default() };
    if v.get("version").and_then(|x| x.as_uint(1000)) != Some(1) {
        return Remembered::default();
    }
    let checked = v.get("checked").and_then(|x| x.as_uint(u64::MAX >> 1));
    let failed = match v.get("failed") {
        Some(f @ Json::Obj(_)) => {
            let failure = f.get("failure").and_then(Json::as_str).and_then(Failure::parse);
            let version = f.get("version").and_then(Json::as_str).filter(|s| version_ok(s)).map(str::to_string);
            failure.zip(version)
        }
        _ => None,
    };
    Remembered { checked, failed }
}

/// Write the remembered checks: mode 0600, a temporary file renamed (the home made 0700 when missing).
pub fn write_remembered(home: &Path, r: &Remembered) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    fs::DirBuilder::new().recursive(true).mode(0o700).create(home)?;
    let failed = match &r.failed {
        Some((f, v)) if version_ok(v) => format!("{{\"failure\":\"{}\",\"version\":{}}}", f.wire(), json::quote(v)),
        _ => "null".into(),
    };
    let body = format!("{{\"version\":1,\"checked\":{},\"failed\":{failed}}}\n", opt_num(r.checked));
    let tmp = home.join(format!(".{UPDATES_FILE}.{}.tmp", std::process::id()));
    let result = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, home.join(UPDATES_FILE))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// A date the alerts show: `YYYY-MM-DD HH:MM UTC` (no time zone database in the shell).
pub fn date_words(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02} UTC", rem / 3600, (rem % 3600) / 60)
}

/// "Last successful check: …" (or "never").
pub fn last_check_words(checked: Option<u64>) -> String {
    format!("Last successful check: {}.", checked.map_or_else(|| "never".into(), date_words))
}

/// The native alert of an available update (when the page cannot show its sheet): title, text, buttons (Install and
/// Restart first: Return; Later is the cancel answer). The feed's notes are NOT shown in it (review d A-L3: the feed is
/// not signed — its text never appears in the app's own native chrome; the Studio's sheet shows it as the feed's text).
pub fn available_alert(app: &str, current: &str, version: &str) -> (String, String, [&'static str; 2]) {
    let text = format!("You have {current}. Install and Restart downloads the update and checks its signature, waits for this workspace's jobs to end, then restarts {app}. The release notes are in the Studio's update sheet.");
    (format!("{app} {version} is available"), text, ["Install and Restart", "Later"])
}

/// The alert of a click that cannot install (the native path; the Studio's sheet says the same from the state).
pub fn refusal_words(r: Refusal, app: &str, current: &str) -> String {
    match r {
        Refusal::Off(o) => o.words(app),
        Refusal::NoUpdate => format!("No update is known any more: {app} checks its feed again."),
        Refusal::NotWritable => Failure::NotWritable.words(app, current),
    }
}

/// RETAKE_DESKTOP_TEST_UPDATE=install clicks Install and Restart by itself (the gated end-to-end test) only in test mode
/// AND in a build made with the e2e test's overlay (`test_feed`: its feed is http on 127.0.0.1 — review d A-L7: no
/// release build installs without the person's click, whatever its environment says).
pub fn test_install_allowed(test_mode: bool, var: Option<&str>, test_feed: bool) -> bool {
    test_mode && test_feed && var == Some("install")
}

/// The e2e test's overlay: the plugin's insecure-transport flag (a release overlay never has a `dangerous*` key: the
/// build's tests) on a feed of 127.0.0.1.
pub fn is_test_feed(insecure_transport: bool, endpoints: &[&str]) -> bool {
    insecure_transport && !endpoints.is_empty() && endpoints.iter().all(|e| e.starts_with("http://127.0.0.1:"))
}

// ---- Install and Restart's quit (review d A-M1 / B-L1) ---------------------------------------------------------

/// How long the posted `terminate:` may take to reach the quit guard (milliseconds). Once the guard took it, the
/// person's question holds the choice however long it waits.
pub const ARM_REACH_MS: u64 = 10_000;

/// Whether the quit under way is Install and Restart's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Arm {
    #[default]
    Off,
    /// The wait posted `terminate:` at `at` (the shell's monotonic milliseconds).
    Posted { at: u64 },
    /// The guard took this quit for the update: its question (the page's sheet, or the native alert) is up.
    Asked,
    /// The guard's Now for it (the person's Install and Restart, or nothing to ask): the exit installs.
    Approved,
}

impl Arm {
    /// The quit is the update's.
    pub fn holds(self, now: u64) -> bool {
        match self {
            Arm::Off => false,
            Arm::Posted { at } => now.saturating_sub(at) <= ARM_REACH_MS,
            Arm::Asked | Arm::Approved => true,
        }
    }

    /// The guard's `terminate:`: a posted arming within reach becomes the question's — no clock after that.
    pub fn decide(self, now: u64) -> Arm {
        match self {
            Arm::Posted { .. } if self.holds(now) => Arm::Asked,
            Arm::Posted { .. } => Arm::Off,
            a => a,
        }
    }

    /// The guard's Now for the update's quit.
    pub fn approve(self, now: u64) -> Arm {
        if self.holds(now) {
            Arm::Approved
        } else {
            Arm::Off
        }
    }

    /// The posted `terminate:` never reached the guard: the update goes back to Available.
    pub fn lapsed(self, now: u64) -> bool {
        matches!(self, Arm::Posted { at } if now.saturating_sub(at) > ARM_REACH_MS)
    }
}

/// What an exit does with the arming (`finish`): Approved → install (or, without an archive to install, say why and
/// restart: an approved install never just closes the app — review d B-M1); anything else → nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Nothing,
    Install,
    /// Approved, but the archive is gone: the failure remembered, the old app restarted.
    FailAndRestart,
}

pub fn exit_step(arm: Arm, have_archive: bool) -> Exit {
    match (arm, have_archive) {
        (Arm::Approved, true) => Exit::Install,
        (Arm::Approved, false) => Exit::FailAndRestart,
        _ => Exit::Nothing,
    }
}

// ---- The download (review d A-M2 / A-M4) ---------------------------------------------------------------------

/// The feed's answer must come within this (the plugin's request timeout for the check).
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// When a download is stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// More bytes than this (received, or announced by Content-Length).
    pub max_bytes: u64,
    /// No byte for this long (milliseconds).
    pub stall_ms: u64,
    /// The whole download (milliseconds).
    pub total_ms: u64,
    /// How often `watch` looks (milliseconds).
    pub step_ms: u64,
}

/// The app's limits: 1.5 GB (the archive measured 345 MB), a minute without a byte, two hours in all.
pub const DOWNLOAD: Limits = Limits { max_bytes: 1_500_000_000, stall_ms: 60_000, total_ms: 2 * 60 * 60 * 1000, step_ms: 250 };

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    TooBig,
    Stalled,
    TooLong,
    /// Later (a newer generation).
    Cancelled,
}

impl Stop {
    pub fn words(self, l: &Limits) -> String {
        match self {
            Stop::TooBig => format!("the archive is larger than {} MB", l.max_bytes / 1_000_000),
            Stop::Stalled => format!("nothing arrived for {} s", l.stall_ms / 1000),
            Stop::TooLong => format!("the download took longer than {} min", l.total_ms / 60_000),
            Stop::Cancelled => "Later".into(),
        }
    }
}

/// The rule: `bytes` received (`announced` by Content-Length), `idle` ms since the last byte (or the start), `elapsed`
/// ms in all; a finished download is only stopped for its size or a Later.
pub fn verdict(l: &Limits, bytes: u64, announced: Option<u64>, idle: u64, elapsed: u64, cancelled: bool, finished: bool) -> Option<Stop> {
    if cancelled {
        Some(Stop::Cancelled)
    } else if bytes > l.max_bytes || announced.is_some_and(|a| a > l.max_bytes) {
        Some(Stop::TooBig)
    } else if finished {
        None
    } else if idle >= l.stall_ms {
        Some(Stop::Stalled)
    } else if elapsed >= l.total_ms {
        Some(Stop::TooLong)
    } else {
        None
    }
}

/// What the download's chunk callback reports (shared with `watch`'s thread).
#[derive(Debug)]
pub struct Progress {
    start: Instant,
    bytes: AtomicU64,
    /// Content-Length + 1 (0: not announced).
    announced: AtomicU64,
    /// Milliseconds from `start` to the last chunk.
    last: AtomicU64,
}

impl Default for Progress {
    fn default() -> Self {
        Progress { start: Instant::now(), bytes: AtomicU64::new(0), announced: AtomicU64::new(0), last: AtomicU64::new(0) }
    }
}

impl Progress {
    /// One chunk of `n` bytes (`total`: the response's Content-Length).
    pub fn chunk(&self, n: usize, total: Option<u64>) {
        self.bytes.fetch_add(n as u64, Ordering::SeqCst);
        if let Some(t) = total {
            self.announced.store(t.saturating_add(1), Ordering::SeqCst);
        }
        self.last.store(self.start.elapsed().as_millis() as u64, Ordering::SeqCst);
    }

    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::SeqCst)
    }
}

/// Watch a download until it ends (`finished`) or a limit stops it (then the caller aborts it): None when it finished
/// within its limits. Polls every `step_ms`.
pub fn watch(p: &Progress, l: &Limits, finished: impl Fn() -> bool, cancelled: impl Fn() -> bool) -> Option<Stop> {
    loop {
        let done = finished();
        let elapsed = p.start.elapsed().as_millis() as u64;
        let announced = match p.announced.load(Ordering::SeqCst) {
            0 => None,
            a => Some(a - 1),
        };
        let idle = elapsed.saturating_sub(p.last.load(Ordering::SeqCst));
        if let Some(s) = verdict(l, p.bytes(), announced, idle, elapsed, cancelled(), done) {
            return Some(s);
        }
        if done {
            return None;
        }
        std::thread::sleep(Duration::from_millis(l.step_ms));
    }
}

// ---- The downloaded archive, on disk (review d A-M4) -----------------------------------------------------------

/// The folder of the downloaded archive in the app's cache folder (made 0700).
pub const ARCHIVE_DIR: &str = "updates";

/// The archive of process `pid` (one per running app: two apps never share one).
pub fn archive_path(cache: &Path, pid: u32) -> PathBuf {
    cache.join(ARCHIVE_DIR).join(format!("update-{pid}.tar.gz"))
}

/// Keep the verified archive: `<cache>/updates/update-<pid>.tar.gz`, mode 0600 (written to a temporary file, renamed),
/// the folder 0700. Returns its path.
pub fn write_archive(cache: &Path, pid: u32, bytes: &[u8]) -> io::Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
    let dir = cache.join(ARCHIVE_DIR);
    fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    let path = archive_path(cache, pid);
    let tmp = dir.join(format!(".update-{pid}.tmp"));
    let _ = fs::remove_file(&tmp);
    let result = (|| {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map(|()| path)
}

/// At start: remove the archives (and temporary files) of processes no longer running (`alive`), this one's included
/// (a previous run of the same pid is not this run). Returns how many were removed.
pub fn remove_stale_archives(cache: &Path, me: u32, alive: impl Fn(u32) -> bool) -> usize {
    let Ok(rd) = fs::read_dir(cache.join(ARCHIVE_DIR)) else { return 0 };
    let mut n = 0;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let pid = name.strip_prefix("update-").and_then(|r| r.strip_suffix(".tar.gz")).or_else(|| name.strip_prefix(".update-").and_then(|r| r.strip_suffix(".tmp"))).and_then(|p| p.parse::<u32>().ok());
        if let Some(pid) = pid {
            if (pid == me || !alive(pid)) && fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipe::{JobItem, JobKind, JobState};

    #[test]
    fn the_disable_variable() {
        for on in ["1", "true", "TRUE", "yes", "Yes", " 1 "] {
            assert!(disabled(Some(on)), "{on}");
        }
        for off in ["0", "false", "no", "", "2", "on"] {
            assert!(!disabled(Some(off)), "{off}");
        }
        assert!(!disabled(None));
        assert_eq!(DISABLE_ENV, "RETAKE_DISABLE_UPDATE_CHECK");
    }

    #[test]
    fn which_app_updates_itself() {
        use InstallLocation::*;
        assert_eq!(availability(true, false, Ok), None);
        assert_eq!(availability(true, false, Volumes), None);
        assert_eq!(availability(false, false, Ok), Some(Off::Build));
        // A build without the updater says so first, whatever else is true.
        assert_eq!(availability(false, true, Translocated), Some(Off::Build));
        assert_eq!(availability(true, true, Ok), Some(Off::Disabled));
        assert_eq!(availability(true, true, Translocated), Some(Off::Disabled));
        assert_eq!(availability(true, false, Translocated), Some(Off::Location(Translocated)));
        assert_eq!(availability(true, false, ReadOnly), Some(Off::Location(ReadOnly)));
        assert_eq!(Off::Build.words("Retake"), "Updates are off in this build.");
        assert!(Off::Location(Translocated).words("Retake").contains("Move Retake to Applications"));
        assert_eq!((Off::Build.wire(), Off::Disabled.wire(), Off::Location(Translocated).wire(), Off::Location(ReadOnly).wire()), ("build", "disabled", "translocated", "read_only"));
    }

    #[test]
    fn a_check_at_most_once_a_day() {
        // Once a day: the constant itself is the rule.
        assert_eq!(CHECK_EVERY_S, 86_400);
        let day = CHECK_EVERY_S;
        assert!(check_due(None, 1_000_000));
        assert!(!check_due(Some(1_000_000), 1_000_000));
        assert!(!check_due(Some(1_000_000), 1_000_000 + day - 1));
        assert!(check_due(Some(1_000_000), 1_000_000 + day));
        // A clock that went back: due (a remembered future date never blocks the checks).
        assert!(check_due(Some(2_000_000), 1_000_000));
    }

    fn pending(running: u32, unsaved: u32) -> Pending {
        let jobs = (0..running.min(8)).map(|_| JobItem { kind: JobKind::Render, state: JobState::Running, project: None, scenario: None }).collect();
        Pending { jobs, jobs_total: running, unsaved: vec![], unsaved_total: unsaved, unknown: false }
    }

    #[test]
    fn install_requests_wait_for_jobs_and_refuse_what_cannot_work() {
        let none = pending(0, 0);
        assert_eq!(install_step(None, true, true, Some(&none)), Step::Quit);
        // Unsaved text is the quit guard's question, not a wait.
        assert_eq!(install_step(None, true, true, Some(&pending(0, 2))), Step::Quit);
        assert_eq!(install_step(None, true, true, Some(&pending(3, 0))), Step::Wait { jobs: 3 });
        assert_eq!(install_step(None, true, true, Some(&pending(1, 1))), Step::Wait { jobs: 1 });
        // A queued job counts too (it would start on the old engine).
        let queued = Pending { jobs: vec![JobItem { kind: JobKind::Capture, state: JobState::Queued, project: None, scenario: None }], jobs_total: 1, ..Pending::default() };
        assert_eq!(install_step(None, true, true, Some(&queued)), Step::Wait { jobs: 1 });
        assert_eq!(install_step(None, true, true, None), Step::Quit);
        assert_eq!(install_step(Some(Off::Build), true, true, Some(&none)), Step::Refuse(Refusal::Off(Off::Build)));
        assert_eq!(install_step(Some(Off::Location(InstallLocation::Translocated)), true, true, None), Step::Refuse(Refusal::Off(Off::Location(InstallLocation::Translocated))));
        assert_eq!(install_step(None, false, true, Some(&none)), Step::Refuse(Refusal::NoUpdate));
        assert_eq!(install_step(None, true, false, Some(&pending(2, 0))), Step::Refuse(Refusal::NotWritable));
    }

    #[test]
    fn versions_and_notes() {
        for ok in ["0.2.1", "1.0.0", "10.20.30", "0.2.1-rc.1", "1.0.0-beta-2"] {
            assert!(version_ok(ok), "{ok}");
        }
        for bad in ["", "0.2", "0.2.1.4", "v0.2.1", "0.2.x", "0.2.1-", "0.2.1-rc 1", "0.2.1\n", "0.2.1-\u{202e}", &format!("0.2.1-{}", "a".repeat(64))] {
            assert!(!version_ok(bad), "{bad:?}");
        }
        assert_eq!(clean_notes("  Faster renders.\r\nFixed:\tthe sheet \u{202e}gnp.exe\u{0007}\n"), "Faster renders.\nFixed: the sheet gnp.exe");
        let long = "a".repeat(NOTES_MAX + 10);
        let c = clean_notes(&long);
        assert_eq!(c.chars().count(), NOTES_MAX + 1);
        assert!(c.ends_with('…'));
        assert_eq!(clean_notes(&"é".repeat(NOTES_MAX)).chars().count(), NOTES_MAX);
    }

    #[test]
    fn the_lines_for_the_server() {
        let l = |s: &State| state_line("0.2.0", s).unwrap();
        assert_eq!(l(&State::Off(Off::Build)), r#"{"type":"update","state":"off","current":"0.2.0","reason":"build"}"#);
        assert_eq!(l(&State::Idle { checked: None }), r#"{"type":"update","state":"idle","current":"0.2.0","checked":null}"#);
        assert_eq!(l(&State::Idle { checked: Some(1_762_000_000) }), r#"{"type":"update","state":"idle","current":"0.2.0","checked":1762000000}"#);
        assert_eq!(l(&State::Checking), r#"{"type":"update","state":"checking","current":"0.2.0"}"#);
        assert_eq!(
            l(&State::Available { version: "0.2.1".into(), notes: "Better \"renders\"\u{202e}".into(), checked: Some(5) }),
            r#"{"type":"update","state":"available","current":"0.2.0","version":"0.2.1","notes":"Better \"renders\"","checked":5}"#
        );
        assert_eq!(l(&State::Downloading { version: "0.2.1".into() }), r#"{"type":"update","state":"downloading","current":"0.2.0","version":"0.2.1"}"#);
        assert_eq!(l(&State::Waiting { version: "0.2.1".into(), jobs: 2 }), r#"{"type":"update","state":"waiting","current":"0.2.0","version":"0.2.1","jobs":2}"#);
        assert_eq!(l(&State::Installing { version: "0.2.1".into() }), r#"{"type":"update","state":"installing","current":"0.2.0","version":"0.2.1"}"#);
        assert_eq!(
            l(&State::Failed { failure: Failure::Install, version: Some("0.2.1".into()), checked: None, retry: false }),
            r#"{"type":"update","state":"failed","current":"0.2.0","failure":"install","version":"0.2.1","checked":null,"retry":false}"#
        );
        assert_eq!(
            l(&State::Failed { failure: Failure::Download, version: Some("0.2.1".into()), checked: Some(3), retry: true }),
            r#"{"type":"update","state":"failed","current":"0.2.0","failure":"download","version":"0.2.1","checked":3,"retry":true}"#
        );
        // No version: nothing to retry, whatever the flag says.
        assert_eq!(l(&State::Failed { failure: Failure::Check, version: None, checked: Some(9), retry: true }), r#"{"type":"update","state":"failed","current":"0.2.0","failure":"check","version":null,"checked":9,"retry":false}"#);
        // A version that is no version: nothing is sent.
        assert_eq!(state_line("0.2.0", &State::Available { version: "0.2.1\",\"x\":\"".into(), notes: String::new(), checked: None }), None);
        assert_eq!(state_line("dev", &State::Checking), None);
        assert_eq!(update_page_js(), "window.dispatchEvent(new CustomEvent(\"studio:update\", { detail: {} }))");
        for f in Failure::ALL {
            assert_eq!(Failure::parse(f.wire()), Some(f));
        }
    }

    #[test]
    fn the_remembered_checks() {
        let home = crate::test_dir("updates");
        assert_eq!(read_remembered(&home), Remembered::default());
        let r = Remembered { checked: Some(1_762_000_000), failed: Some((Failure::Install, "0.2.1".into())) };
        write_remembered(&home, &r).unwrap();
        assert_eq!(read_remembered(&home), r);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(home.join(UPDATES_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        // A bad failed entry is dropped, the date kept; a foreign file is the default.
        fs::write(home.join(UPDATES_FILE), r#"{"version":1,"checked":7,"failed":{"failure":"format_disk","version":"0.2.1"}}"#).unwrap();
        assert_eq!(read_remembered(&home), Remembered { checked: Some(7), failed: None });
        fs::write(home.join(UPDATES_FILE), r#"{"version":1,"checked":7,"failed":{"failure":"install","version":"0.2.1\nOK"}}"#).unwrap();
        assert_eq!(read_remembered(&home), Remembered { checked: Some(7), failed: None });
        fs::write(home.join(UPDATES_FILE), r#"{"version":2,"checked":7}"#).unwrap();
        assert_eq!(read_remembered(&home), Remembered::default());
        fs::write(home.join(UPDATES_FILE), "not json").unwrap();
        assert_eq!(read_remembered(&home), Remembered::default());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn dates_and_alerts() {
        assert_eq!(date_words(0), "1970-01-01 00:00 UTC");
        assert_eq!(date_words(1_762_172_100), "2025-11-03 12:15 UTC");
        assert_eq!(date_words(951_782_400), "2000-02-29 00:00 UTC");
        assert_eq!(last_check_words(None), "Last successful check: never.");
        assert_eq!(last_check_words(Some(0)), "Last successful check: 1970-01-01 00:00 UTC.");
        let (title, text, buttons) = available_alert("Retake", "0.2.0", "0.2.1");
        assert_eq!(title, "Retake 0.2.1 is available");
        // Before the click, in the future tense; the feed's notes never in the native alert (review d A-L3 / A-L4).
        assert_eq!(text, "You have 0.2.0. Install and Restart downloads the update and checks its signature, waits for this workspace's jobs to end, then restarts Retake. The release notes are in the Studio's update sheet.");
        assert_eq!(buttons, ["Install and Restart", "Later"]);
        assert!(Failure::Install.words("Retake", "0.2.0").contains("Retake 0.2.0 was kept"));
        assert_eq!(refusal_words(Refusal::NotWritable, "Retake", "0.2.0"), Failure::NotWritable.words("Retake", "0.2.0"));
        assert!(refusal_words(Refusal::NotWritable, "Retake", "0.2.0").contains("install the new version from its disk image"));
        assert_eq!(refusal_words(Refusal::Off(Off::Build), "Retake", "0.2.0"), "Updates are off in this build.");
        assert!(refusal_words(Refusal::NoUpdate, "Retake", "0.2.0").contains("checks its feed again"));
        // A failed swap that could not put the old app back says where it is (review d A-L5).
        let w = not_restored_words("Retake", "/Applications/Retake (previous version).app");
        assert!(w.contains("could not be put back") && w.contains("\n/Applications/Retake (previous version).app\n") && w.contains("named Retake.app"));
    }

    /// Review d B-L4: the notes are cut until the line fits the server's byte cap — 2000 characters that quote to 6 bytes
    /// each, or 4-byte characters, would push it past 8192 and the server would drop the update.
    #[test]
    fn the_available_line_fits_the_servers_byte_cap() {
        use crate::setup::SHELL_LINE_MAX;
        let v = "1.0.0-".to_string() + &"a".repeat(VERSION_MAX - 6);
        // (U+2028 is white space, kept between two letters: it quotes to 6 bytes.)
        for notes in ["\u{1f600}\u{2028}".repeat(NOTES_MAX / 2), "\u{1f600}".repeat(NOTES_MAX), "\"\u{2028}".repeat(NOTES_MAX / 2)] {
            let line = state_line(&v, &State::Available { version: v.clone(), notes: notes.clone(), checked: Some(u64::MAX >> 1) }).unwrap();
            assert!(line.len() <= SHELL_LINE_MAX, "{} bytes", line.len());
            assert!(line.ends_with(&format!("…\",\"checked\":{}}}", u64::MAX >> 1)), "cut and marked: {}", &line[line.len() - 60..]);
            // Not cut more than needed (a quoted character is at most 6 bytes, "…" 3).
            assert!(line.len() + 12 > SHELL_LINE_MAX, "{} bytes", line.len());
            assert!(json::parse(&line).is_ok());
        }
        // Notes that fit are kept whole.
        let l = state_line("0.2.0", &State::Available { version: "0.2.1".into(), notes: "a".repeat(NOTES_MAX), checked: None }).unwrap();
        assert!(l.contains(&format!("\"notes\":\"{}\"", "a".repeat(NOTES_MAX))));
    }

    /// Review d A-M1 / B-L1: once the guard took the quit for the update, the person's choice holds however long the
    /// question waits; only the posting itself has a reach.
    #[test]
    fn install_and_restart_holds_once_asked() {
        let t = 1_000_000;
        let posted = Arm::Posted { at: t };
        assert!(posted.holds(t + ARM_REACH_MS));
        assert!(!posted.holds(t + ARM_REACH_MS + 1));
        assert!(!Arm::Off.holds(t));
        // The guard took it: the question holds it — a day later still.
        let asked = posted.decide(t + 5);
        assert_eq!(asked, Arm::Asked);
        let day = 86_400_000;
        assert!(asked.holds(t + day));
        assert_eq!(asked.decide(t + day), Arm::Asked);
        assert_eq!(asked.approve(t + day), Arm::Approved);
        assert_eq!(Arm::Approved.decide(t + day), Arm::Approved);
        // A posting that never reached the guard lapses (the update goes back to Available).
        assert_eq!(posted.decide(t + ARM_REACH_MS + 1), Arm::Off);
        assert_eq!(posted.approve(t + ARM_REACH_MS + 1), Arm::Off);
        assert!(posted.lapsed(t + ARM_REACH_MS + 1) && !posted.lapsed(t + ARM_REACH_MS) && !asked.lapsed(t + day));
        assert_eq!(Arm::Off.approve(t), Arm::Off);
        // The exit: only an approved quit installs; approved without an archive still restarts, saying why.
        assert_eq!(exit_step(Arm::Approved, true), Exit::Install);
        assert_eq!(exit_step(Arm::Approved, false), Exit::FailAndRestart);
        for a in [Arm::Off, Arm::Posted { at: t }, Arm::Asked] {
            assert_eq!(exit_step(a, true), Exit::Nothing, "{a:?}");
        }
    }

    /// Review d B-M1 / B-M2: no check while an install is under way (said), a check at once after a failed install;
    /// what a click may retry; the remembered failure kept while the feed offers that version.
    #[test]
    fn checks_during_an_install_and_after_a_failed_one() {
        let v = || "0.2.1".to_string();
        for s in [State::Checking, State::Downloading { version: v() }, State::Waiting { version: v(), jobs: 2 }, State::Installing { version: v() }] {
            assert!(check_refused(&s, "Retake").is_some_and(|w| w.starts_with("Retake ")), "{s:?}");
        }
        assert!(check_refused(&State::Waiting { version: v(), jobs: 2 }, "Retake").unwrap().contains("Later"));
        for s in [State::Idle { checked: None }, State::Off(Off::Build), State::Available { version: v(), notes: String::new(), checked: None }, State::Failed { failure: Failure::Download, version: Some(v()), checked: None, retry: true }] {
            assert_eq!(check_refused(&s, "Retake"), None, "{s:?}");
        }
        let now = 1_000_000;
        assert!(!launch_check_due(Some(now - 60), now, false));
        assert!(launch_check_due(Some(now - 60), now, true));
        assert!(launch_check_due(None, now, false));
        assert!(Failure::Download.retry(true) && Failure::Install.retry(true));
        assert!(!Failure::Download.retry(false) && !Failure::Install.retry(false) && !Failure::NotWritable.retry(true) && !Failure::Check.retry(true));
        let f = Some((Failure::Install, v()));
        assert_eq!(failed_after_check(f.clone(), Some("0.2.1")), f);
        assert_eq!(failed_after_check(f.clone(), Some("0.2.2")), None);
        assert_eq!(failed_after_check(f, None), None);
    }

    /// Review d A-L7: a click by itself only in test mode, with the variable, in a build made with the e2e overlay.
    #[test]
    fn no_install_without_the_click_outside_the_e2e_build() {
        assert!(test_install_allowed(true, Some("install"), true));
        assert!(!test_install_allowed(true, Some("install"), false));
        assert!(!test_install_allowed(false, Some("install"), true));
        assert!(!test_install_allowed(true, Some("yes"), true));
        assert!(!test_install_allowed(true, None, true));
        assert!(is_test_feed(true, &["http://127.0.0.1:4990/retake/latest.json"]));
        assert!(!is_test_feed(false, &["http://127.0.0.1:4990/retake/latest.json"]));
        assert!(!is_test_feed(true, &["https://downloads.example.test/retake/latest.json"]));
        assert!(!is_test_feed(true, &["http://127.0.0.1:4990/x.json", "http://downloads.example.test/x.json"]));
        assert!(!is_test_feed(true, &[]));
    }

    /// Review d A-M2: the download's limits — size (received or announced), a stall, the total, Later.
    #[test]
    fn the_download_limits() {
        let l = Limits { max_bytes: 1000, stall_ms: 100, total_ms: 10_000, step_ms: 5 };
        assert_eq!(verdict(&l, 10, None, 0, 0, false, false), None);
        assert_eq!(verdict(&l, 1001, None, 0, 0, false, false), Some(Stop::TooBig));
        assert_eq!(verdict(&l, 10, Some(1001), 0, 0, false, false), Some(Stop::TooBig));
        assert_eq!(verdict(&l, 1001, None, 0, 0, false, true), Some(Stop::TooBig));
        assert_eq!(verdict(&l, 10, None, 100, 100, false, false), Some(Stop::Stalled));
        assert_eq!(verdict(&l, 10, None, 99, 10_000, false, false), Some(Stop::TooLong));
        assert_eq!(verdict(&l, 10, None, 500, 20_000, false, true), None);
        assert_eq!(verdict(&l, 10, None, 0, 0, true, true), Some(Stop::Cancelled));
        assert_eq!(DOWNLOAD.max_bytes, 1_500_000_000);
        assert_eq!((DOWNLOAD.stall_ms, DOWNLOAD.total_ms), (60_000, 7_200_000));
        assert_eq!(CHECK_TIMEOUT, Duration::from_secs(30));
        assert_eq!(Stop::TooBig.words(&DOWNLOAD), "the archive is larger than 1500 MB");
    }

    /// Review d A-M2: `watch` against an endless feed, a hanging one, a Later, and one that ends in time.
    #[test]
    fn watch_stops_an_endless_or_hanging_download_and_a_later() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;
        let l = Limits { max_bytes: 5_000_000, stall_ms: 150, total_ms: 3_000, step_ms: 5 };
        // Endless: a producer that never stops sending.
        let p = Arc::new(Progress::default());
        let stop = Arc::new(AtomicBool::new(false));
        let (p2, s2) = (p.clone(), stop.clone());
        let producer = std::thread::spawn(move || {
            while !s2.load(Ordering::SeqCst) {
                p2.chunk(64 * 1024, None);
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        assert_eq!(watch(&p, &l, || false, || false), Some(Stop::TooBig));
        stop.store(true, Ordering::SeqCst);
        producer.join().unwrap();
        // Hanging: headers came, then nothing.
        let p = Progress::default();
        p.chunk(10, Some(1_000));
        let t = Instant::now();
        assert_eq!(watch(&p, &l, || false, || false), Some(Stop::Stalled));
        assert!(t.elapsed() < Duration::from_millis(2_000));
        // Announced too big: stopped at once.
        let p = Progress::default();
        p.chunk(10, Some(l.max_bytes + 1));
        assert_eq!(watch(&p, &l, || false, || false), Some(Stop::TooBig));
        // Later.
        let p = Progress::default();
        let later = AtomicBool::new(false);
        let t = std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_millis(30));
                later.store(true, Ordering::SeqCst);
            });
            watch(&p, &Limits { stall_ms: 60_000, ..l }, || false, || later.load(Ordering::SeqCst))
        });
        assert_eq!(t, Some(Stop::Cancelled));
        // A download that ends within its limits.
        let p = Progress::default();
        p.chunk(100, Some(100));
        assert_eq!(watch(&p, &l, || true, || false), None);
        // One that ended between two looks, past the cap: still refused (its bytes are never kept).
        let p = Progress::default();
        p.chunk(l.max_bytes as usize + 1, None);
        assert_eq!(watch(&p, &l, || true, || false), Some(Stop::TooBig));
    }

    /// Review d A-M4: the archive on disk — 0600 in a 0700 folder, one per process, stale ones removed at start.
    #[test]
    fn the_archive_on_disk() {
        use std::os::unix::fs::PermissionsExt;
        let cache = crate::test_dir("archive");
        let p = write_archive(&cache, 42, b"archive bytes").unwrap();
        assert_eq!(p, cache.join("updates").join("update-42.tar.gz"));
        assert_eq!(fs::read(&p).unwrap(), b"archive bytes");
        assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(cache.join("updates")).unwrap().permissions().mode() & 0o777, 0o700);
        // Written again: replaced.
        write_archive(&cache, 42, b"newer").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"newer");
        write_archive(&cache, 7, b"another app's").unwrap();
        fs::write(cache.join("updates").join(".update-9.tmp"), b"half").unwrap();
        fs::write(cache.join("updates").join("notes.txt"), b"not ours").unwrap();
        // At start (pid 42 again): its own old one and a dead process's go; a running app's stays; nothing else touched.
        assert_eq!(remove_stale_archives(&cache, 42, |pid| pid == 7), 2);
        assert!(!p.exists() && cache.join("updates").join("update-7.tar.gz").exists() && cache.join("updates").join("notes.txt").exists());
        assert_eq!(remove_stale_archives(&cache.join("none"), 1, |_| false), 0);
        let _ = fs::remove_dir_all(&cache);
    }
}
