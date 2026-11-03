//! What the window may load, what the child's line must say, and what the shell may print.
//!
//! - `parse_ui_line`: the one line `retake ui --supervised` prints — `type: "ui"`, `v: 2` (L5.2b: the pipe lines of
//!   pipe.rs follow it; `retake ui --json` keeps `v: 1`, which this shell refuses), `url` exactly
//!   `http://127.0.0.1:<port>/#c=<code>`, `player` exactly `http://127.0.0.1:<other port>`; anything else is refused.
//!   `{"type":"error","code":"no_workspace"}` (the CLI's answer for a folder that is no workspace) is told apart.
//! - `navigation_allowed`: every frame's navigation (wry asks for all frames): only the Studio's and the player's exact
//!   origins, and `about:blank` / `about:srcdoc`. `localhost`, another port, `https:`, `file:`, userinfo… are refused.
//!   `navigation_decision` adds the server's life: no origin once the server stopped (`Allowed::NONE`), and an
//!   attached server found gone on a navigation is `ServerGone` (refused; the shell offers a restart).
//! - `redact` / `sanitize`: every text the shell prints keeps a URL's origin only (a path may hold the player's
//!   capability, a fragment the one-time code), drops secret-shaped runs, `Bearer` values and control characters.
//! - `route_ok`: the `--route` hash of debug builds and tests.

use crate::json::{self, Json};
use std::time::{Duration, Instant};

/// The supervised line's version this shell reads (`retake ui` SUPERVISED_LINE_VERSION; 2 since L5.2b).
pub const UI_LINE_VERSION: u64 = 2;
const LOOPBACK: &str = "http://127.0.0.1:";

/// The port of an `http://127.0.0.1:<port>` URL and what follows the authority (empty, or starting with `/`, `?`, `#`).
/// Strict, on the serialised form: lower-case scheme, the exact address, a port with no leading zero, no userinfo.
pub fn loopback_port(url: &str) -> Option<(u16, &str)> {
    let rest = url.strip_prefix(LOOPBACK)?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || digits > 5 || rest.starts_with('0') {
        return None;
    }
    let port: u32 = rest[..digits].parse().ok()?;
    let tail = &rest[digits..];
    if port == 0 || port > 65535 || !(tail.is_empty() || tail.starts_with(['/', '?', '#'])) {
        return None;
    }
    Some((port as u16, tail))
}

/// `http://127.0.0.1:<port>`.
pub fn origin(port: u16) -> String {
    format!("{LOOPBACK}{port}")
}

/// The one line of `retake ui --supervised`, checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UiLine {
    /// `http://127.0.0.1:<port>/#c=<code>`: the one-time URL (a secret for 60 s: never printed).
    pub url: String,
    pub port: u16,
    pub pid: u32,
    /// true: another process serves the workspace; this shell only attaches.
    pub reused: bool,
    pub player_port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineError {
    NotJson(String),
    WrongType,
    /// `v` absent or another version: the app and the CLI it runs drifted apart.
    WrongVersion(Option<u64>),
    BadUrl,
    BadPort,
    BadPid,
    BadReused,
    /// No `player`: a running server older than this app.
    NoPlayer,
    BadPlayer,
    /// `{"type":"error","code":"no_workspace"}`: the folder is no workspace (the CLI then exits 2).
    NoWorkspace,
}

impl std::fmt::Display for LineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LineError::NotJson(e) => write!(f, "the retake CLI did not print its JSON line ({e})"),
            LineError::WrongType => write!(f, "the retake CLI printed another line than the ui one"),
            LineError::WrongVersion(Some(v)) if *v > UI_LINE_VERSION => write!(
                f,
                "the retake CLI is newer than this app (line version {v}, the app reads {UI_LINE_VERSION}): rebuild the app — pnpm desktop:build in the repository"
            ),
            LineError::WrongVersion(v) => write!(
                f,
                "the retake CLI is older than this app (line version {}, the app reads {UI_LINE_VERSION}): run pnpm build in the repository, then pnpm desktop:build",
                v.map_or("none".to_string(), |v| v.to_string())
            ),
            LineError::BadUrl => write!(f, "the retake CLI gave a URL that is not http://127.0.0.1:<port>/#c=<code>"),
            LineError::BadPort => write!(f, "the retake CLI gave a bad port"),
            LineError::BadPid => write!(f, "the retake CLI gave a bad pid"),
            LineError::BadReused => write!(f, "the retake CLI did not say whether it reused a server"),
            LineError::NoPlayer => write!(
                f,
                "a Studio server older than this app serves this workspace (it does not name its player origin): stop it (Ctrl-C in its terminal) and open the workspace again"
            ),
            LineError::BadPlayer => write!(f, "the retake CLI gave a player origin that is not http://127.0.0.1:<port>"),
            LineError::NoWorkspace => write!(f, "the folder is not a workspace (no retake.yaml or projects/ folder)"),
        }
    }
}

fn is_code(s: &str) -> bool {
    s.len() == 43 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn parse_ui_line(line: &str) -> Result<UiLine, LineError> {
    let v = json::parse(line.trim_end_matches(['\n', '\r'])).map_err(LineError::NotJson)?;
    match v.get("type").and_then(Json::as_str) {
        Some("ui") => {}
        Some("error") if v.get("code").and_then(Json::as_str) == Some("no_workspace") => return Err(LineError::NoWorkspace),
        _ => return Err(LineError::WrongType),
    }
    match v.get("v").map(|x| x.as_uint(u64::MAX >> 11)) {
        Some(Some(UI_LINE_VERSION)) => {}
        Some(found) => return Err(LineError::WrongVersion(found)),
        None => return Err(LineError::WrongVersion(None)),
    }
    let port = v.get("port").and_then(|x| x.as_uint(65535)).filter(|p| *p > 0).ok_or(LineError::BadPort)? as u16;
    let url = v.get("url").and_then(Json::as_str).ok_or(LineError::BadUrl)?;
    match loopback_port(url) {
        Some((p, tail)) if p == port && tail.strip_prefix("/#c=").is_some_and(is_code) => {}
        _ => return Err(LineError::BadUrl),
    }
    let pid = v.get("pid").and_then(|x| x.as_uint(u32::MAX as u64)).filter(|p| *p > 0).ok_or(LineError::BadPid)? as u32;
    let reused = v.get("reused").and_then(Json::as_bool).ok_or(LineError::BadReused)?;
    let player = v.get("player").ok_or(LineError::NoPlayer)?.as_str().ok_or(LineError::BadPlayer)?;
    let player_port = match loopback_port(player) {
        Some((q, "")) if q != port => q,
        _ => return Err(LineError::BadPlayer),
    };
    Ok(UiLine { url: url.to_string(), port, pid, reused, player_port })
}

/// Whether a frame may navigate to `url` (the serialised URL wry gives): the Studio's or the player's exact origin,
/// or `about:blank` / `about:srcdoc`.
pub fn navigation_allowed(url: &str, studio_port: u16, player_port: u16) -> bool {
    if url == "about:blank" || url == "about:srcdoc" {
        return true;
    }
    matches!(loopback_port(url), Some((p, _)) if p == studio_port || p == player_port)
}

/// The origins the window may load now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Allowed {
    pub studio: u16,
    pub player: u16,
    /// The pid of an attached server (another process serves the workspace; nothing watches it).
    pub attached: Option<u32>,
}

impl Allowed {
    /// No origin: no server, or the server stopped (review A L3: a port freed by a stopped server may be bound by
    /// another local process, whose page the window must not load on a reload).
    pub const NONE: Allowed = Allowed { studio: 0, player: 0, attached: None };
}

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    Refuse,
    /// An allowed origin, but the attached server is gone: refused, and the shell says the server stopped.
    ServerGone,
}

/// `navigation_allowed`, and for an attached server whether it still runs (`alive(pid)`: kill(pid, 0)).
pub fn navigation_decision(url: &str, allowed: Allowed, alive: impl Fn(u32) -> bool) -> Navigation {
    if !navigation_allowed(url, allowed.studio, allowed.player) {
        return Navigation::Refuse;
    }
    match allowed.attached {
        Some(pid) if url != "about:blank" && url != "about:srcdoc" && !alive(pid) => Navigation::ServerGone,
        _ => Navigation::Allow,
    }
}

/// The `--route` hash: `#/` and up to 200 of `A-Z a-z 0-9 / _ . -`.
pub fn route_ok(route: &str) -> bool {
    route.len() <= 202 && route.starts_with("#/") && route[2..].bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'_' | b'.' | b'-'))
}

fn secretish(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// A run of this many secret-shaped characters is dropped (the token, a code and a capability are 43).
pub const SECRET_RUN: usize = 40;

/// `text` with every URL cut to its origin (`scheme://host[:port]` — path, query, fragment and userinfo dropped),
/// `Bearer <value>` hidden and any run of `SECRET_RUN` or more base64url characters replaced.
pub fn redact(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    let ends_url = |c: u8| c.is_ascii_whitespace() || matches!(c, b'"' | b'\'' | b'<' | b'>' | b'`' | b')' | b']' | b'}' | b',');
    while i < b.len() {
        if b[i..].starts_with(b"://") {
            // The scheme: letters before "://".
            let mut s = i;
            while s > copied && (b[s - 1].is_ascii_alphanumeric() || matches!(b[s - 1], b'+' | b'.' | b'-')) {
                s -= 1;
            }
            let mut end = i + 3;
            while end < b.len() && !ends_url(b[end]) {
                end += 1;
            }
            let after = &text[i + 3..end];
            let auth_len = after.find(['/', '?', '#']).unwrap_or(after.len());
            let auth = &after[..auth_len];
            let host = auth.rsplit('@').next().unwrap_or("");
            out.push_str(&text[copied..s]);
            out.push_str(&text[s..i]);
            out.push_str("://");
            out.push_str(&redact_runs(host));
            if auth_len < after.len() || host.len() < auth.len() {
                out.push_str("/…");
            }
            i = end;
            copied = end;
            continue;
        }
        if b[i..].starts_with(b"#c=") {
            out.push_str(&text[copied..i]);
            out.push_str("#c=…");
            i += 3;
            while i < b.len() && secretish(b[i]) {
                i += 1;
            }
            copied = i;
            continue;
        }
        if b[i..].starts_with(b"Bearer ") {
            out.push_str(&text[copied..i]);
            out.push_str("Bearer …");
            i += 7;
            while i < b.len() && !b[i].is_ascii_whitespace() {
                i += 1;
            }
            copied = i;
            continue;
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    redact_runs(&out)
}

fn redact_runs(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut copied) = (0, 0);
    while i < b.len() {
        if secretish(b[i]) {
            let s = i;
            while i < b.len() && secretish(b[i]) {
                i += 1;
            }
            if i - s >= SECRET_RUN {
                out.push_str(&text[copied..s]);
                out.push('…');
                copied = i;
            }
        } else {
            i += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// Longest line printed (characters).
pub const LINE_MAX: usize = 1000;

/// One line as the shell prints it: redacted, control and bidi characters replaced by `?`, at most `LINE_MAX`
/// characters.
pub fn sanitize(line: &str) -> String {
    let red = redact(line);
    let mut out = String::with_capacity(red.len().min(LINE_MAX + 4));
    for (n, c) in red.chars().enumerate() {
        if n >= LINE_MAX {
            out.push('…');
            break;
        }
        let bad = (c.is_control() && c != '\t') || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}');
        out.push(if bad { '?' } else { c });
    }
    out
}

/// Lines Tauri prints for a page frame's message to its IPC handler (its text is the frame's: dropped, counted).
pub fn is_ipc_noise(line: &str) -> bool {
    line.contains("__TAURI_INVOKE_KEY__")
}

/// At most `max` lines per `window`; the next admitted line first says how many were dropped.
pub struct RateLimit {
    max: u32,
    window: Duration,
    start: Option<Instant>,
    count: u32,
    dropped: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Admit {
    Pass,
    /// Pass, after saying that this many lines were dropped.
    PassAfterDrop(u64),
    Drop,
}

impl RateLimit {
    pub fn new(max: u32, window: Duration) -> Self {
        RateLimit { max, window, start: None, count: 0, dropped: 0 }
    }
    pub fn admit(&mut self, now: Instant) -> Admit {
        match self.start {
            Some(s) if now.duration_since(s) < self.window => {}
            _ => {
                self.start = Some(now);
                self.count = 0;
            }
        }
        if self.count >= self.max {
            self.dropped += 1;
            return Admit::Drop;
        }
        self.count += 1;
        match std::mem::take(&mut self.dropped) {
            0 => Admit::Pass,
            n => Admit::PassAfterDrop(n),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456";

    fn line(url: &str, port: u64, player: Option<&str>) -> String {
        format!(
            r#"{{"type":"ui","v":2,"url":{},"port":{port},"pid":4242,"reused":false{}}}"#,
            json::quote(url),
            player.map(|p| format!(r#","player":{}"#, json::quote(p))).unwrap_or_default()
        )
    }

    #[test]
    fn the_line_of_studio_ui_supervised() {
        let ok = parse_ui_line(&line(&format!("http://127.0.0.1:4100/#c={CODE}"), 4100, Some("http://127.0.0.1:4101"))).unwrap();
        assert_eq!(ok, UiLine { url: format!("http://127.0.0.1:4100/#c={CODE}"), port: 4100, pid: 4242, reused: false, player_port: 4101 });
        let reused = format!(r#"{{"type":"ui","v":2,"url":"http://127.0.0.1:9/#c={CODE}","port":9,"pid":1,"reused":true,"player":"http://127.0.0.1:10"}}"#);
        assert!(parse_ui_line(&reused).unwrap().reused);
    }

    #[test]
    fn a_line_with_any_other_host_scheme_port_or_shape_is_refused() {
        let p = Some("http://127.0.0.1:4101");
        for url in [
            format!("http://localhost:4100/#c={CODE}"),
            format!("http://127.0.0.2:4100/#c={CODE}"),
            format!("https://127.0.0.1:4100/#c={CODE}"),
            format!("http://127.0.0.1:4101/#c={CODE}"),
            format!("http://127.0.0.1:04100/#c={CODE}"),
            format!("http://127.0.0.1:4100@example.com/#c={CODE}"),
            format!("http://user@127.0.0.1:4100/#c={CODE}"),
            format!("http://127.0.0.1:4100/x#c={CODE}"),
            format!("http://127.0.0.1:4100/#c={CODE}x"),
            "http://127.0.0.1:4100/".to_string(),
            format!("http://[::1]:4100/#c={CODE}"),
            format!("http://127.0.0.1/#c={CODE}"),
        ] {
            assert_eq!(parse_ui_line(&line(&url, 4100, p)), Err(LineError::BadUrl), "{url}");
        }
        let url = format!("http://127.0.0.1:4100/#c={CODE}");
        assert_eq!(parse_ui_line(&line(&url, 4100, None)), Err(LineError::NoPlayer));
        for bad in ["http://localhost:4101", "http://127.0.0.1:4101/", "http://127.0.0.1:4100", "https://127.0.0.1:4101", "http://127.0.0.1:4101/s/x"] {
            assert_eq!(parse_ui_line(&line(&url, 4100, Some(bad))), Err(LineError::BadPlayer), "{bad}");
        }
        // L5.2b: `retake ui --json`'s v 1 (a CLI older than the app) and a newer line are refused, each saying what to build.
        let v1 = parse_ui_line(&line(&url, 4100, p).replace("\"v\":2", "\"v\":1"));
        assert_eq!(v1, Err(LineError::WrongVersion(Some(1))));
        assert!(v1.unwrap_err().to_string().contains("run pnpm build in the repository, then pnpm desktop:build"));
        let v3 = parse_ui_line(&line(&url, 4100, p).replace("\"v\":2", "\"v\":3"));
        assert!(v3.unwrap_err().to_string().contains("rebuild the app — pnpm desktop:build"));
        assert_eq!(parse_ui_line(&line(&url, 4100, p).replace("\"v\":2,", "")), Err(LineError::WrongVersion(None)));
        assert_eq!(parse_ui_line(&line(&url, 4100, p).replace("\"ui\"", "\"job\"")), Err(LineError::WrongType));
        assert_eq!(parse_ui_line(&line(&url, 4100, p).replace("4242", "0")), Err(LineError::BadPid));
        assert_eq!(parse_ui_line(&line(&url, 4100, p).replace("false", "\"no\"")), Err(LineError::BadReused));
        assert!(matches!(parse_ui_line("Retake serves …"), Err(LineError::NotJson(_))));
    }

    #[test]
    fn the_no_workspace_line_is_told_from_another_failure() {
        assert_eq!(parse_ui_line(r#"{"type":"error","v":1,"code":"no_workspace"}"#), Err(LineError::NoWorkspace));
        assert_eq!(parse_ui_line(r#"{"type":"error","v":1,"code":"other"}"#), Err(LineError::WrongType));
        assert_eq!(parse_ui_line(r#"{"type":"error"}"#), Err(LineError::WrongType));
    }

    #[test]
    fn navigation_exact_origins_only() {
        for ok in ["http://127.0.0.1:4100/", "http://127.0.0.1:4100/#/p/x", "http://127.0.0.1:4101/s/cap/frame", "http://127.0.0.1:4100", "about:blank", "about:srcdoc"] {
            assert!(navigation_allowed(ok, 4100, 4101), "{ok}");
        }
        for no in [
            "http://127.0.0.1:4102/",
            "http://localhost:4100/",
            "http://127.0.0.2:4100/",
            "https://127.0.0.1:4100/",
            "http://127.0.0.1/",
            "http://127.0.0.1:80/",
            "http://user:pw@127.0.0.1:4100/",
            "http://127.0.0.1:4100@example.com/",
            "http://127.0.0.1:41000/",
            "http://127.0.0.1:410/",
            "http://[::1]:4100/",
            "file:///etc/passwd",
            "data:text/html,x",
            "javascript:alert(1)",
            "blob:http://127.0.0.1:4100/x",
            "about:config",
            "https://example.com/",
            "",
        ] {
            assert!(!navigation_allowed(no, 4100, 4101), "{no}");
        }
    }

    #[test]
    fn navigation_after_the_server_stopped_or_with_an_attached_server_gone() {
        let owned = Allowed { studio: 4100, player: 4101, attached: None };
        let never = |_: u32| -> bool { panic!("an owned server is not probed") };
        assert_eq!(navigation_decision("http://127.0.0.1:4100/", owned, never), Navigation::Allow);
        assert_eq!(navigation_decision("http://127.0.0.1:4102/", owned, never), Navigation::Refuse);
        // The owned server stopped: no origin at all, the old ports included.
        for url in ["http://127.0.0.1:4100/", "http://127.0.0.1:4101/s/x/frame", "http://127.0.0.1:0/"] {
            assert_eq!(navigation_decision(url, Allowed::NONE, never), Navigation::Refuse, "{url}");
        }
        assert_eq!(navigation_decision("about:blank", Allowed::NONE, never), Navigation::Allow);
        // Attached: probed on each navigation to its origins; gone → ServerGone, never Allow.
        let attached = Allowed { attached: Some(77), ..owned };
        assert_eq!(navigation_decision("http://127.0.0.1:4100/", attached, |p| p == 77), Navigation::Allow);
        assert_eq!(navigation_decision("http://127.0.0.1:4100/", attached, |_| false), Navigation::ServerGone);
        assert_eq!(navigation_decision("http://127.0.0.1:4101/s/x/frame", attached, |_| false), Navigation::ServerGone);
        assert_eq!(navigation_decision("about:srcdoc", attached, |_| false), Navigation::Allow);
        assert_eq!(navigation_decision("http://127.0.0.1:4102/", attached, |_| true), Navigation::Refuse);
    }

    #[test]
    fn route_shape() {
        for ok in ["#/", "#/p/northfield-fixture/s/quote/timeline", "#/p/a_b.c-d"] {
            assert!(route_ok(ok), "{ok}");
        }
        for no in ["", "#", "/p/x", "#p/x", "#/p/x?y", "#/p/x\"", "#/p/x';alert(1)//", "#/p x", &format!("#/{}", "a".repeat(201))] {
            assert!(!route_ok(no), "{no}");
        }
    }

    #[test]
    fn redact_keeps_origins_only() {
        assert_eq!(redact(&format!("open http://127.0.0.1:4100/#c={CODE} now")), "open http://127.0.0.1:4100/… now");
        assert_eq!(redact(&format!("frame http://127.0.0.1:4101/s/{CODE}/frame")), "frame http://127.0.0.1:4101/…");
        assert_eq!(redact(&format!("media \"http://127.0.0.1:4101/m/{CODE}/id/capture.mp4\".")), "media \"http://127.0.0.1:4101/…\".");
        assert_eq!(redact("http://user:pw@example.com:8/x?y"), "http://example.com:8/…");
        assert_eq!(redact("at http://127.0.0.1:4100"), "at http://127.0.0.1:4100");
        assert_eq!(redact(&format!("hash #c={CODE}")), "hash #c=…");
        assert_eq!(redact("Authorization: Bearer abc.def"), "Authorization: Bearer …");
        assert_eq!(redact(&format!("token {CODE} end")), "token … end");
        assert_eq!(redact("kept: /Users/x/projects/northfield-fixture (pid 42)"), "kept: /Users/x/projects/northfield-fixture (pid 42)");
        assert_eq!(redact("é http://h/é"), "é http://h/…");
    }

    #[test]
    fn sanitize_strips_control_and_bidi_characters_and_caps_the_length() {
        assert_eq!(sanitize("a\u{1b}[31mred\u{7}\tok\u{202e}x\u{9b}"), "a?[31mred?\tok?x?");
        let long = "x ".repeat(LINE_MAX);
        assert_eq!(sanitize(&long).chars().count(), LINE_MAX + 1);
        assert!(sanitize(&format!("__TAURI_INVOKE_KEY__ expected {CODE} but received \u{1b}]0;x")).contains('…'));
        assert!(is_ipc_noise("__TAURI_INVOKE_KEY__ expected a but received b"));
        assert!(!is_ipc_noise("retake: ready"));
    }

    #[test]
    fn rate_limit_drops_then_says_how_many() {
        let t0 = Instant::now();
        let mut r = RateLimit::new(2, Duration::from_secs(1));
        assert_eq!(r.admit(t0), Admit::Pass);
        assert_eq!(r.admit(t0), Admit::Pass);
        assert_eq!(r.admit(t0), Admit::Drop);
        assert_eq!(r.admit(t0 + Duration::from_millis(500)), Admit::Drop);
        assert_eq!(r.admit(t0 + Duration::from_millis(1001)), Admit::PassAfterDrop(2));
        assert_eq!(r.admit(t0 + Duration::from_millis(1002)), Admit::Pass);
    }
}
