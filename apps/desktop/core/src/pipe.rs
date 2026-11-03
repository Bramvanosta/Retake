//! The supervised server's lines after the `ui` line (L5.2b, DESIGN §4j): `pending` — what Quit would leave behind,
//! whole, on every change — and `job_end` — a job that ended. Read through a capped line reader (`LineReader`: a line
//! longer than the cap is drained to its newline and reported, never kept), parsed by the strict JSON reader, then
//! checked field by field: every field is an enum this module knows or a slug it checks again (`project_ok`,
//! `scenario_ok`) — the shell's words (words.rs) are keyed by the enums, so neither the page nor the server can put
//! prose in an alert or a notification. An item with an unknown enum is dropped from its list but still counted in its
//! total (the question still asks); a bad slug drops the name, the item stays. Lists are cut to `LIST_MAX`.
//!
//! L5.12d: `answer` {id, answer: proceed | cancel} and `shown` {id, shown: true} — the window page's word on the quit
//! question (guard_flow), the id checked here (22 base64url characters) and against the question up in the shell.
//!
//! What is ignored (forward compatible, critique M4): a line that is no JSON object, a `type` this shell does not know,
//! a `job_end` of an unknown kind or outcome. Only a `pending` that fails its checks is `BadPending` — the shell then
//! asks with generic words until the next valid one. The server frames each line with a newline before it (review A
//! L3: a stray partial write on its stdout becomes a line of its own): a blank line is `Blank`, ignored without a word.

use crate::json::{self, Json};
use std::io::{BufRead, BufReader, ErrorKind, Read};

/// Longest line read after the `ui` line (bytes); the server writes at most 8 KB.
pub const PIPE_LINE_MAX: usize = 16 * 1024;
/// Items kept per list.
pub const LIST_MAX: usize = 8;
const TOTAL_MAX: u64 = 1_000_000;

/// One line of a capped reader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    /// A whole line, its newline removed (invalid UTF-8 replaced).
    Text(String),
    /// A line longer than the cap: drained to its newline, nothing of it kept.
    TooLong,
}

/// Newline-terminated lines of `R`, each at most `cap` bytes (`set_cap` changes it between lines).
pub struct LineReader<R: Read> {
    inner: BufReader<R>,
    cap: usize,
}

impl<R: Read> LineReader<R> {
    pub fn new(r: R, cap: usize) -> Self {
        LineReader { inner: BufReader::new(r), cap }
    }

    pub fn set_cap(&mut self, cap: usize) {
        self.cap = cap;
    }

    /// The next line; None at the end of the stream (or a read error). A last line without its newline is dropped.
    pub fn next_line(&mut self) -> Option<Line> {
        let mut buf = Vec::new();
        let mut too_long = false;
        loop {
            let avail = match self.inner.fill_buf() {
                Ok(b) => b,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(_) => return None,
            };
            if avail.is_empty() {
                return None;
            }
            let (chunk, end) = match avail.iter().position(|&b| b == b'\n') {
                Some(i) => (i, Some(i + 1)),
                None => (avail.len(), None),
            };
            if !too_long {
                if buf.len() + chunk > self.cap {
                    too_long = true;
                    buf = Vec::new();
                } else {
                    buf.extend_from_slice(&avail[..chunk]);
                }
            }
            match end {
                Some(n) => {
                    self.inner.consume(n);
                    return Some(if too_long { Line::TooLong } else { Line::Text(String::from_utf8_lossy(&buf).into_owned()) });
                }
                None => {
                    let n = avail.len();
                    self.inner.consume(n);
                }
            }
        }
    }
}

macro_rules! wire_enum {
    ($(#[$m:meta])* $name:ident { $($v:ident = $s:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($v),+ }
        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$v),+];
            /// The value of its wire name; None for any other text.
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($s => Some($name::$v),)+ _ => None }
            }
            pub fn wire(self) -> &'static str {
                match self { $($name::$v => $s),+ }
            }
        }
    };
}

wire_enum!(
    /// A job's kind on the pipe (ui supervise.ts PIPE_KINDS).
    JobKind { Capture = "capture", DryRun = "dry_run", Render = "render", Review = "review", Export = "export", Recording = "recording", StudioRecording = "studio_recording", Hooks = "hooks", EnvReset = "env_reset", SandboxStart = "sandbox_start", SandboxReset = "sandbox_reset" }
);
wire_enum!(JobState { Running = "running", Queued = "queued" });
wire_enum!(Outcome { Succeeded = "succeeded", Failed = "failed", Attention = "attention" });
wire_enum!(
    /// Why a job needs attention or failed (ui supervise.ts PIPE_REASONS).
    Reason { RunFailed = "run_failed", Interrupted = "interrupted", ReviewIssues = "review_issues", CheckFailed = "check_failed", ReadyToSave = "ready_to_save", NothingRecorded = "nothing_recorded", HooksFailed = "hooks_failed", ResetFailed = "reset_failed" }
);
wire_enum!(
    /// What unsaved text a tab holds (ui unsaved.ts UNSAVED_KINDS).
    UnsavedKind { Readme = "readme", YamlDraft = "yaml_draft", StepForm = "step_form", Comment = "comment", ComponentBrief = "component_brief", NewTheme = "new_theme", ThemeDraft = "theme_draft" }
);

/// A project slug: `^[a-z0-9][a-z0-9-]{0,99}$`.
pub fn project_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 100 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// A scenario name: `^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`.
pub fn scenario_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 100 && b[0].is_ascii_alphanumeric() && b.iter().all(|&c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobItem {
    pub kind: JobKind,
    pub state: JobState,
    pub project: Option<String>,
    pub scenario: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnsavedItem {
    pub kind: UnsavedKind,
    pub project: Option<String>,
    pub scenario: Option<String>,
}

/// What Quit would leave behind, as the server last said it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Pending {
    pub jobs: Vec<JobItem>,
    pub jobs_total: u32,
    pub unsaved: Vec<UnsavedItem>,
    pub unsaved_total: u32,
    /// The server sent a `pending` this shell cannot read: ask with generic words.
    pub unknown: bool,
}

impl Pending {
    /// Nothing pending: Quit needs no question.
    pub fn is_empty(&self) -> bool {
        self.jobs_total == 0 && self.unsaved_total == 0 && !self.unknown
    }

    /// The server is gone (critique L2): its jobs are history now; the unsaved text is still in the window.
    pub fn server_gone(&mut self) {
        self.jobs.clear();
        self.jobs_total = 0;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobEnd {
    pub kind: JobKind,
    pub outcome: Outcome,
    pub reason: Option<Reason>,
    pub project: Option<String>,
    pub scenario: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipeMsg {
    Pending(Pending),
    JobEnd(JobEnd),
    /// A `pending` that failed its checks (why).
    BadPending(String),
    /// L5.12d: the window's page answered the quit question `id` (Quit Anyway: `proceed`) — through `desktop_answer`.
    Answer { id: String, proceed: bool },
    /// L5.12d: the window's page shows the quit question `id`.
    Shown { id: String },
    /// Not for this shell (why): no JSON object, an unknown type, a job_end it cannot word.
    Ignored(&'static str),
    /// An empty line (the server's framing newline: review A L3) — nothing to say.
    Blank,
}

fn names(v: &Json) -> (Option<String>, Option<String>) {
    let project = v.get("project").and_then(Json::as_str).filter(|s| project_ok(s)).map(str::to_string);
    let scenario = v.get("scenario").and_then(Json::as_str).filter(|s| scenario_ok(s)).map(str::to_string);
    (project, scenario)
}

/// A list and its total: the items `item` reads (unknown ones dropped), cut to LIST_MAX; the total at least the number
/// of entries given.
fn list<T>(v: &Json, key: &str, total_key: &str, item: impl Fn(&Json) -> Option<T>) -> Result<(Vec<T>, u32), String> {
    let Some(Json::Arr(entries)) = v.get(key) else { return Err(format!("`{key}` is not a list")) };
    let total = v.get(total_key).and_then(|t| t.as_uint(TOTAL_MAX)).ok_or_else(|| format!("`{total_key}` is not a count"))?;
    let mut out: Vec<T> = entries.iter().filter_map(&item).collect();
    out.truncate(LIST_MAX);
    Ok((out, total.max(entries.len() as u64).min(TOTAL_MAX) as u32))
}

fn pending(v: &Json) -> Result<Pending, String> {
    let (jobs, jobs_total) = list(v, "jobs", "jobs_total", |j| {
        let kind = JobKind::parse(j.get("kind")?.as_str()?)?;
        let state = JobState::parse(j.get("state")?.as_str()?)?;
        let (project, scenario) = names(j);
        Some(JobItem { kind, state, project, scenario })
    })?;
    let (unsaved, unsaved_total) = list(v, "unsaved", "unsaved_total", |u| {
        let kind = UnsavedKind::parse(u.get("kind")?.as_str()?)?;
        let (project, scenario) = names(u);
        Some(UnsavedItem { kind, project, scenario })
    })?;
    Ok(Pending { jobs, jobs_total, unsaved, unsaved_total, unknown: false })
}

/// One line after the `ui` line.
pub fn parse_pipe_line(line: &str) -> PipeMsg {
    if line.trim().is_empty() {
        return PipeMsg::Blank;
    }
    let Ok(v) = json::parse(line.trim_end_matches('\r')) else { return PipeMsg::Ignored("not JSON") };
    match v.get("type").and_then(Json::as_str) {
        Some("pending") => match pending(&v) {
            Ok(p) => PipeMsg::Pending(p),
            Err(e) => PipeMsg::BadPending(e),
        },
        Some("job_end") => {
            let kind = v.get("kind").and_then(Json::as_str).and_then(JobKind::parse);
            let outcome = v.get("outcome").and_then(Json::as_str).and_then(Outcome::parse);
            let (Some(kind), Some(outcome)) = (kind, outcome) else { return PipeMsg::Ignored("a job_end of an unknown kind or outcome") };
            let reason = v.get("reason").and_then(Json::as_str).and_then(Reason::parse);
            let (project, scenario) = names(&v);
            PipeMsg::JobEnd(JobEnd { kind, outcome, reason, project, scenario })
        }
        Some(t @ ("answer" | "shown")) => {
            // Strict (review A-L6): exactly `type`, `id` and its own field — the server writes these two fixed shapes.
            let Json::Obj(fields) = &v else { return PipeMsg::Ignored("not JSON") };
            let own = if t == "shown" { "shown" } else { "answer" };
            if fields.len() != 3 || !fields.iter().all(|(k, _)| k == "type" || k == "id" || k == own) {
                return PipeMsg::Ignored("a page line with other fields");
            }
            let Some(id) = v.get("id").and_then(Json::as_str).filter(|s| crate::guard_flow::id_ok(s)) else { return PipeMsg::Ignored("a page line without a question id") };
            if t == "shown" {
                return match v.get("shown") {
                    Some(Json::Bool(true)) => PipeMsg::Shown { id: id.to_string() },
                    _ => PipeMsg::Ignored("a shown line without shown: true"),
                };
            }
            match v.get("answer").and_then(Json::as_str) {
                Some("proceed") => PipeMsg::Answer { id: id.to_string(), proceed: true },
                Some("cancel") => PipeMsg::Answer { id: id.to_string(), proceed: false },
                _ => PipeMsg::Ignored("an answer this app does not know"),
            }
        }
        Some(_) => PipeMsg::Ignored("a line type this app does not know"),
        None => PipeMsg::Ignored("no line type"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(input: &[u8], cap: usize) -> Vec<Line> {
        let mut r = LineReader::new(input, cap);
        std::iter::from_fn(|| r.next_line()).collect()
    }

    #[test]
    fn a_line_longer_than_the_cap_is_drained_and_the_next_line_still_reads() {
        let long = format!("{{\"type\":\"pending\",\"x\":\"{}\"}}\n", "a".repeat(20 * 1024));
        let input = format!("first\n{long}after\nlast-without-newline");
        assert_eq!(lines(input.as_bytes(), PIPE_LINE_MAX), vec![Line::Text("first".into()), Line::TooLong, Line::Text("after".into())]);
        // Exactly the cap fits; one byte more does not.
        let at = format!("{}\n{}\n", "b".repeat(16), "c".repeat(17));
        assert_eq!(lines(at.as_bytes(), 16), vec![Line::Text("b".repeat(16)), Line::TooLong]);
        // A cap changed between lines (the ui line's 64 KB, then 16 KB).
        let two = format!("{}\n{}\n", "x".repeat(100), "y".repeat(100));
        let mut r = LineReader::new(two.as_bytes(), 200);
        assert_eq!(r.next_line(), Some(Line::Text("x".repeat(100))));
        r.set_cap(50);
        assert_eq!(r.next_line(), Some(Line::TooLong));
        assert_eq!(r.next_line(), None);
    }

    fn job_json(kind: &str, project: &str) -> String {
        format!(r#"{{"kind":"{kind}","state":"running","project":{},"scenario":"quote"}}"#, json::quote(project))
    }

    #[test]
    fn pending_lines_are_read_with_their_totals_and_cut_to_eight() {
        let ok = r#"{"type":"pending","jobs":[{"kind":"capture","state":"running","project":"shop","scenario":"quote"},{"kind":"render","state":"queued","project":"shop"}],"jobs_total":2,"unsaved":[{"kind":"readme","project":"shop"}],"unsaved_total":1}"#;
        let PipeMsg::Pending(p) = parse_pipe_line(ok) else { panic!("{ok}") };
        assert_eq!(p.jobs, vec![
            JobItem { kind: JobKind::Capture, state: JobState::Running, project: Some("shop".into()), scenario: Some("quote".into()) },
            JobItem { kind: JobKind::Render, state: JobState::Queued, project: Some("shop".into()), scenario: None },
        ]);
        assert_eq!((p.jobs_total, p.unsaved_total, p.unknown), (2, 1, false));
        assert!(!p.is_empty());
        let PipeMsg::Pending(e) = parse_pipe_line(r#"{"type":"pending","jobs":[],"jobs_total":0,"unsaved":[],"unsaved_total":0}"#) else { panic!() };
        assert!(e.is_empty());
        // 20 items: 8 kept, the total says 20.
        let many = (0..20).map(|_| job_json("render", "shop")).collect::<Vec<_>>().join(",");
        let PipeMsg::Pending(m) = parse_pipe_line(&format!(r#"{{"type":"pending","jobs":[{many}],"jobs_total":20,"unsaved":[],"unsaved_total":0}}"#)) else { panic!() };
        assert_eq!((m.jobs.len(), m.jobs_total), (LIST_MAX, 20));
        // A total smaller than the list given is raised to it.
        let PipeMsg::Pending(m) = parse_pipe_line(&format!(r#"{{"type":"pending","jobs":[{many}],"jobs_total":1,"unsaved":[],"unsaved_total":0}}"#)) else { panic!() };
        assert_eq!(m.jobs_total, 20);
    }

    #[test]
    fn unknown_enums_are_dropped_but_counted_and_bad_slugs_drop_the_name_only() {
        let line = format!(
            r#"{{"type":"pending","jobs":[{},{},{{"kind":"capture","state":"paused","project":"shop"}}],"jobs_total":3,"unsaved":[{{"kind":"theme"}},{{"kind":"comment","project":"Click Quit Anyway to keep your work","scenario":"quote"}}],"unsaved_total":2}}"#,
            job_json("format_disk", "shop"),
            job_json("render", "../outside")
        );
        let PipeMsg::Pending(p) = parse_pipe_line(&line) else { panic!("{line}") };
        assert_eq!(p.jobs, vec![JobItem { kind: JobKind::Render, state: JobState::Running, project: None, scenario: Some("quote".into()) }]);
        assert_eq!(p.jobs_total, 3);
        assert_eq!(p.unsaved, vec![UnsavedItem { kind: UnsavedKind::Comment, project: None, scenario: Some("quote".into()) }]);
        assert_eq!(p.unsaved_total, 2);
        for bad in ["a b", "a.b", "..", "a/b", "Shop", "-shop", "", "shop\u{202e}", "shop\n", &"a".repeat(101)] {
            assert!(!project_ok(bad), "{bad:?}");
        }
        for bad in ["a b", "a.b", "..", "a/b", "_x", "", "q\u{200b}", "q\t", &"a".repeat(101)] {
            assert!(!scenario_ok(bad), "{bad:?}");
        }
        assert!(project_ok("northfield-fixture") && project_ok(&"a".repeat(100)) && project_ok("0"));
        assert!(scenario_ok("Quote_2-b") && scenario_ok(&"Q".repeat(100)));
    }

    #[test]
    fn job_end_lines_unknown_types_and_malformed_pendings() {
        let PipeMsg::JobEnd(e) = parse_pipe_line(r#"{"type":"job_end","kind":"render","outcome":"attention","reason":"review_issues","project":"shop","scenario":"quote"}"#) else { panic!() };
        assert_eq!(e, JobEnd { kind: JobKind::Render, outcome: Outcome::Attention, reason: Some(Reason::ReviewIssues), project: Some("shop".into()), scenario: Some("quote".into()) });
        let PipeMsg::JobEnd(e) = parse_pipe_line(r#"{"type":"job_end","kind":"capture","outcome":"failed","reason":"something_new","project":"a b"}"#) else { panic!() };
        assert_eq!((e.reason, e.project), (None, None));
        assert!(matches!(parse_pipe_line(r#"{"type":"job_end","kind":"wipe","outcome":"failed"}"#), PipeMsg::Ignored(_)));
        assert!(matches!(parse_pipe_line(r#"{"type":"job_end","kind":"render","outcome":"exploded"}"#), PipeMsg::Ignored(_)));
        assert!(matches!(parse_pipe_line(r#"{"type":"progress","n":1}"#), PipeMsg::Ignored(_)));
        assert!(matches!(parse_pipe_line("Debugger listening on ws://127.0.0.1:9229"), PipeMsg::Ignored(_)));
        assert!(matches!(parse_pipe_line("[1,2]"), PipeMsg::Ignored(_)));
        // Duplicate keys: refused by the strict reader, so not JSON to this shell.
        assert!(matches!(parse_pipe_line(r#"{"type":"pending","jobs":[],"jobs_total":0,"jobs_total":1,"unsaved":[],"unsaved_total":0}"#), PipeMsg::Ignored(_)));
        for bad in [
            r#"{"type":"pending","jobs":{},"jobs_total":0,"unsaved":[],"unsaved_total":0}"#,
            r#"{"type":"pending","jobs":[],"unsaved":[],"unsaved_total":0}"#,
            r#"{"type":"pending","jobs":[],"jobs_total":-1,"unsaved":[],"unsaved_total":0}"#,
            r#"{"type":"pending","jobs":[],"jobs_total":0,"unsaved":[],"unsaved_total":"many"}"#,
        ] {
            assert!(matches!(parse_pipe_line(bad), PipeMsg::BadPending(_)), "{bad}");
        }
        let mut p = Pending { jobs: vec![JobItem { kind: JobKind::Capture, state: JobState::Running, project: None, scenario: None }], jobs_total: 1, unsaved_total: 1, ..Pending::default() };
        p.server_gone();
        assert_eq!((p.jobs.len(), p.jobs_total, p.unsaved_total), (0, 0, 1));
        for k in JobKind::ALL {
            assert_eq!(JobKind::parse(k.wire()), Some(*k));
        }
    }

    /// L5.12d: the page's answer and ack — strict fields, the id's shape checked; anything else ignored.
    #[test]
    fn answer_and_shown_lines_are_strict() {
        const ID: &str = "AAAAAAAAAAAAAAAAAAAAAA";
        assert_eq!(parse_pipe_line(&format!(r#"{{"type":"answer","id":"{ID}","answer":"proceed"}}"#)), PipeMsg::Answer { id: ID.into(), proceed: true });
        assert_eq!(parse_pipe_line(&format!(r#"{{"type":"answer","id":"{ID}","answer":"cancel"}}"#)), PipeMsg::Answer { id: ID.into(), proceed: false });
        assert_eq!(parse_pipe_line(&format!(r#"{{"type":"shown","id":"{ID}","shown":true}}"#)), PipeMsg::Shown { id: ID.into() });
        for bad in [
            format!(r#"{{"type":"answer","id":"{ID}","answer":"yes"}}"#),
            format!(r#"{{"type":"answer","id":"{ID}"}}"#),
            r#"{"type":"answer","id":"short","answer":"proceed"}"#.to_string(),
            r#"{"type":"answer","id":"AAAAAAAAAAAAAAAAAAAA/+","answer":"proceed"}"#.to_string(),
            format!(r#"{{"type":"shown","id":"{ID}","shown":false}}"#),
            format!(r#"{{"type":"shown","id":"{ID}"}}"#),
            r#"{"type":"shown","id":7,"shown":true}"#.to_string(),
            // Review A-L6: no other field, not even one of the other line's.
            format!(r#"{{"type":"answer","id":"{ID}","answer":"proceed","shown":true}}"#),
            format!(r#"{{"type":"shown","id":"{ID}","shown":true,"answer":"cancel"}}"#),
            format!(r#"{{"type":"answer","id":"{ID}","answer":"proceed","text":"x"}}"#),
            format!(r#"{{"type":"shown","id":"{ID}","answer":"proceed"}}"#),
        ] {
            assert!(matches!(parse_pipe_line(&bad), PipeMsg::Ignored(_)), "{bad}");
        }
    }

    /// Review A L3: the server writes "\n" + line + "\n"; a partial write before it is a line of its own, ignored, and
    /// the framing's blank lines are Blank (said nothing about) — the next state still reads.
    #[test]
    fn a_partial_write_before_a_framed_line_stays_apart_and_blank_lines_are_blank() {
        let pending = r#"{"type":"pending","jobs":[],"jobs_total":0,"unsaved":[{"kind":"readme","project":"shop"}],"unsaved_total":1}"#;
        let stream = format!("x\n{pending}\n\n{pending}\n");
        let got: Vec<PipeMsg> = lines(stream.as_bytes(), PIPE_LINE_MAX)
            .into_iter()
            .map(|l| match l {
                Line::Text(t) => parse_pipe_line(&t),
                Line::TooLong => panic!("too long"),
            })
            .collect();
        assert!(matches!(got[0], PipeMsg::Ignored(_)));
        assert!(matches!(&got[1], PipeMsg::Pending(p) if p.unsaved_total == 1));
        assert_eq!(got[2], PipeMsg::Blank);
        assert!(matches!(&got[3], PipeMsg::Pending(p) if p.unsaved_total == 1));
        assert_eq!(parse_pipe_line(" \r"), PipeMsg::Blank);
    }
}
