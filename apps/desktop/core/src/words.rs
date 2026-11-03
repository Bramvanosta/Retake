//! The shell's own words for the quit question, the restart alert and the notifications (L5.2b, DESIGN §4j). Every
//! character of an alert or a notification comes from the tables below, from the app's name (tauri.conf.json
//! `productName`), or from a name that passed the slug rules (`pipe::project_ok` / `scenario_ok`) — and that the server
//! found in the workspace. Such a name is still words a person or an agent chose (review A L1): it is shown cut to
//! `NAME_SHOWN_MAX` characters, never as a sentence of the shell. Nothing of the page or the server's prose reaches
//! here (there is none on the pipe). An empty `Pending` gives no question at all: Quit stays instant.

use crate::pipe::{JobEnd, JobItem, JobKind, JobState, Outcome, Pending, Reason, UnsavedItem, UnsavedKind};

/// The longest name shown (characters); a longer one is cut, with "…".
pub const NAME_SHOWN_MAX: usize = 40;

/// What the question is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// ⌘Q, the menu, the Dock, a quit Apple event without a session reason.
    Quit,
    /// File › Open Workspace… (the owned server stops before the next one starts).
    OpenWorkspace,
    /// Logout (review B M2): the jobs worker, a process of the session, ends with it — the jobs stop.
    LogOut,
    /// A restart or shut down of the Mac (review B M2): the jobs stop; jobs alone never hold it (no question).
    SystemRestart,
}

/// `kAEQuitReason` values (AERegistry.h) of a quit Apple event.
const AE_LOG_OUT: u32 = u32::from_be_bytes(*b"logo");
const AE_REALLY_LOG_OUT: u32 = u32::from_be_bytes(*b"rlgo");
const AE_SHOW_RESTART: u32 = u32::from_be_bytes(*b"rrst");
const AE_RESTART: u32 = u32::from_be_bytes(*b"rest");
const AE_SHOW_SHUTDOWN: u32 = u32::from_be_bytes(*b"rsdn");
const AE_SHUT_DOWN: u32 = u32::from_be_bytes(*b"shut");

/// The question's action for a quit: the quit Apple event's `kAEQuitReason` (logout, restart, shut down), if any.
pub fn quit_action(reason: Option<u32>) -> Action {
    match reason {
        Some(AE_LOG_OUT | AE_REALLY_LOG_OUT) => Action::LogOut,
        Some(AE_SHOW_RESTART | AE_RESTART | AE_SHOW_SHUTDOWN | AE_SHUT_DOWN) => Action::SystemRestart,
        _ => Action::Quit,
    }
}

/// An alert: its words, its two buttons in order, which one goes on, which one cancels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub title: String,
    pub text: String,
    pub buttons: [&'static str; 2],
    /// The index of the button that quits (or opens).
    pub proceed: usize,
    /// The index of the button that keeps everything as it is (also what test mode answers).
    pub cancel: usize,
    /// The proceed button loses unsaved text: shown as destructive, never the default (critique M3).
    pub destructive: bool,
}

pub fn kind_words(k: JobKind) -> &'static str {
    match k {
        JobKind::Capture => "Capture",
        JobKind::DryRun => "Rehearsal",
        JobKind::Render => "Render",
        JobKind::Review => "Review",
        JobKind::Export => "Export",
        JobKind::Recording | JobKind::StudioRecording => "Recording",
        JobKind::Hooks => "Hooks",
        JobKind::EnvReset => "Environment reset",
        JobKind::SandboxStart => "Sandbox start",
        JobKind::SandboxReset => "Sandbox reset",
    }
}

pub fn reason_words(r: Reason) -> &'static str {
    match r {
        Reason::RunFailed => "The run stopped at a step.",
        Reason::Interrupted => "Interrupted: the worker stopped.",
        Reason::ReviewIssues => "The review found errors or warnings.",
        Reason::CheckFailed => "The check replay failed.",
        Reason::ReadyToSave => "Ready to save on the Record screen.",
        Reason::NothingRecorded => "Nothing was recorded.",
        Reason::HooksFailed => "A hook failed.",
        Reason::ResetFailed => "A rollback or a reset hook failed.",
    }
}

/// A checked name as shown: at most NAME_SHOWN_MAX characters (review A L1).
fn shown(name: &str) -> String {
    if name.chars().count() <= NAME_SHOWN_MAX {
        return name.to_string();
    }
    let mut cut: String = name.chars().take(NAME_SHOWN_MAX - 1).collect();
    cut.push('…');
    cut
}

/// "shop · quote", "shop", or "" (a scenario without its project is not named).
fn where_(project: &Option<String>, scenario: &Option<String>) -> String {
    match (project, scenario) {
        (Some(p), Some(s)) => format!("{} · {}", shown(p), shown(s)),
        (Some(p), None) => shown(p),
        _ => String::new(),
    }
}

fn job_line(j: &JobItem) -> String {
    let at = where_(&j.project, &j.scenario);
    let state = match j.state {
        JobState::Running => "running",
        JobState::Queued => "queued",
    };
    if at.is_empty() {
        format!("{} ({state})", kind_words(j.kind))
    } else {
        format!("{} of {at} ({state})", kind_words(j.kind))
    }
}

fn unsaved_line(u: &UnsavedItem) -> String {
    let p = u.project.as_deref().map(shown);
    let s = u.scenario.as_deref().map(shown);
    let of = |what: &str| match &p {
        Some(p) => format!("{what} of {p}"),
        None => what.to_string(),
    };
    match (u.kind, &p, &s) {
        (UnsavedKind::Readme, Some(p), _) => format!("README.md of {p}"),
        (UnsavedKind::Readme, None, _) => "A README.md".into(),
        (UnsavedKind::YamlDraft, Some(p), Some(s)) => format!("Scenario {s} of {p} (YAML)"),
        (UnsavedKind::YamlDraft, _, _) => format!("{} (YAML)", of("A scenario")),
        (UnsavedKind::StepForm, Some(_), _) => format!("A step form of {}", where_(&u.project, &u.scenario)),
        (UnsavedKind::StepForm, None, _) => "A step form".into(),
        (UnsavedKind::Comment, Some(_), _) => format!("A comment being written ({})", where_(&u.project, &u.scenario)),
        (UnsavedKind::Comment, None, _) => "A comment being written".into(),
        (UnsavedKind::ComponentBrief, _, _) => format!("{} (Library)", of("A new component's description")),
        (UnsavedKind::NewTheme, _, _) => format!("{} (Themes)", of("A new theme's form")),
        (UnsavedKind::ThemeDraft, _, _) => format!("{} (Themes)", of("Theme colours not written yet")),
    }
}

/// "• a\n• b\n…and 3 more" — `total` counts the items not listed (unknown kinds, past the cut); no item listed: one
/// line with the count.
fn bullets(items: Vec<String>, total: u32, one: &str, many: &str) -> String {
    if items.is_empty() {
        return format!("• {total} {}", if total == 1 { one } else { many });
    }
    let more = (total as usize).saturating_sub(items.len());
    let mut out = items.iter().map(|i| format!("• {i}")).collect::<Vec<_>>().join("\n");
    if more > 0 {
        out.push_str(&format!("\n…and {more} more"));
    }
    out
}

/// Review B L6: the board holds every tab on the server — the app's window and a browser tab alike; the text stays on
/// screen in a browser tab, but nothing saves it once the server stops.
const UNSAVED_LEAD: &str = "Unsaved text in the Studio (this window, or a browser tab on it) can no longer be saved:";

fn unsaved_part(p: &Pending, lead: &str) -> Option<String> {
    (p.unsaved_total > 0).then(|| format!("{lead}\n{}", bullets(p.unsaved.iter().map(unsaved_line).collect(), p.unsaved_total, "unsaved text", "unsaved texts")))
}

/// The question before quitting or opening another workspace; None when nothing is pending (no question: instant) —
/// and, at a restart or shut down of the Mac, when only jobs are pending (review B M2: jobs alone never hold an
/// unattended restart; they stop with it either way).
pub fn guard_question(p: &Pending, action: Action, app: &str) -> Option<Question> {
    if p.is_empty() {
        return None;
    }
    let text_at_stake = p.unsaved_total > 0 || p.unknown;
    if action == Action::SystemRestart && !text_at_stake {
        return None;
    }
    let mut parts = Vec::new();
    if let Some(u) = unsaved_part(p, UNSAVED_LEAD) {
        parts.push(u);
    }
    if p.jobs_total > 0 {
        let lead = match action {
            Action::Quit => "These jobs keep running after the app quits, but it will not tell you when they end:",
            Action::OpenWorkspace => "These jobs keep running; this window stops following them:",
            Action::LogOut => "These jobs stop when you log out (the jobs worker ends with your session):",
            Action::SystemRestart => "These jobs stop when the Mac restarts or shuts down:",
        };
        parts.push(format!("{lead}\n{}", bullets(p.jobs.iter().map(job_line).collect(), p.jobs_total, "job", "jobs")));
        // Review B L5: a recording the Studio started is ended and saved from its Record screen only.
        if p.jobs.iter().any(|j| j.kind == JobKind::StudioRecording) {
            parts.push(
                match action {
                    Action::Quit | Action::OpenWorkspace => {
                        "A recording started in the Studio keeps its window open: close that window to end it, then save it from the Record screen when this workspace is open again."
                    }
                    Action::LogOut | Action::SystemRestart => "A recording started in the Studio stops too: what it recorded is kept — save it from the Record screen next time.",
                }
                .into(),
            );
        }
    }
    if p.unknown {
        parts.push("The Studio sent a state this app cannot read: there may be unsaved text or running jobs.".into());
    }
    let (title, go) = match action {
        Action::Quit | Action::LogOut | Action::SystemRestart => (format!("Quit {app}?"), "Quit Anyway"),
        Action::OpenWorkspace => ("Open another workspace?".to_string(), "Open Anyway"),
    };
    // Critique M3: losing text is never the default button (Return); jobs only keep running, so going on is.
    let destructive = text_at_stake;
    let (buttons, proceed, cancel) = if destructive { (["Cancel", go], 1, 0) } else { ([go, "Cancel"], 0, 1) };
    Some(Question { title, text: parts.join("\n\n"), buttons, proceed, cancel, destructive })
}

/// The note added to the restart alert when the window still holds unsaved text (its server died); None otherwise.
pub fn restart_note(p: &Pending) -> Option<String> {
    unsaved_part(p, "Unsaved text in the Studio (this window, or a browser tab on it) can no longer be saved; Restart or Quit loses what this window holds:")
        .map(|u| format!("{u}\n\nCopy it first: Not Now keeps the window as it is."))
}

/// The restart alert's buttons (review B M4): with unsaved text, Not Now first — the default, Return — and Restart and
/// Quit, which lose it, destructive with no key; without, Restart (Return) and Quit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestartButtons {
    pub buttons: Vec<&'static str>,
    pub restart: usize,
    pub quit: usize,
    pub not_now: Option<usize>,
    /// What test mode answers (and a modal ended without a button means: nothing is lost).
    pub cancel: usize,
    pub destructive: Vec<usize>,
}

pub fn restart_buttons(note: bool) -> RestartButtons {
    if note {
        RestartButtons { buttons: vec!["Not Now", "Restart", "Quit"], restart: 1, quit: 2, not_now: Some(0), cancel: 0, destructive: vec![1, 2] }
    } else {
        RestartButtons { buttons: vec!["Restart", "Quit"], restart: 0, quit: 1, not_now: None, cancel: 1, destructive: vec![] }
    }
}

/// A notification's title for one job end (review B L14: "Sandbox started", not "Sandbox start finished").
fn end_title(kind: JobKind, outcome: Outcome) -> String {
    match (kind, outcome) {
        (JobKind::SandboxStart, Outcome::Succeeded) => "Sandbox started".into(),
        (k, o) => format!(
            "{} {}",
            kind_words(k),
            match o {
                Outcome::Succeeded => "finished",
                Outcome::Failed => "failed",
                Outcome::Attention => "needs attention",
            }
        ),
    }
}

/// A notification's title and body for job ends (one, or a summary of several; `more`: ends not in `ends`).
pub fn notification_text(ends: &[JobEnd], more: usize) -> (String, String) {
    if let ([e], 0) = (ends, more) {
        let body = [where_(&e.project, &e.scenario), e.reason.map(reason_words).unwrap_or_default().to_string()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
        return (end_title(e.kind, e.outcome), body);
    }
    let count = |o: Outcome| ends.iter().filter(|e| e.outcome == o).count();
    let mut counts = Vec::new();
    for (n, words) in [(count(Outcome::Succeeded), "finished"), (count(Outcome::Failed), "failed"), (count(Outcome::Attention), "need attention")] {
        if n > 0 {
            counts.push(format!("{n} {words}"));
        }
    }
    let mut places: Vec<String> = Vec::new();
    for e in ends {
        let w = where_(&e.project, &e.scenario);
        if !w.is_empty() && !places.contains(&w) {
            places.push(w);
        }
    }
    let total = ends.len() + more;
    let mut body = counts.join(", ");
    if more > 0 {
        body.push_str(&format!("{}{more} more", if body.is_empty() { "" } else { ", " }));
    }
    if let Some(first) = places.first() {
        let others = places.len() - 1;
        body.push('\n');
        body.push_str(first);
        if others > 0 {
            body.push_str(&format!(" and {others} more"));
        }
    }
    (format!("{total} jobs ended"), body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipe::{parse_pipe_line, PipeMsg};

    const APP: &str = "Demo Studio";

    fn pending(line: &str) -> Pending {
        match parse_pipe_line(line) {
            PipeMsg::Pending(p) => p,
            other => panic!("{other:?}"),
        }
    }

    /// Review A-L1 / B-L1: the longest question these words can build fits the page's bound (guard_flow QUIT_TEXT_MAX,
    /// the page's QUIT_TEXT_MAX): eight lines of the longest kind on each side, names of 100 characters (cut where
    /// shown), the largest totals ("…and 999992 more"), a Studio recording's note and the unknown state's note.
    #[test]
    fn the_longest_question_fits_the_page_bound() {
        use crate::guard_flow::{page_fits, QUIT_TEXT_MAX};
        use crate::pipe::LIST_MAX;
        let (p100, s100) = ("p".repeat(100), "S".repeat(100));
        let u = |kind| UnsavedItem { kind, project: Some(p100.clone()), scenario: Some(s100.clone()) };
        let j = |kind| JobItem { kind, state: JobState::Running, project: Some(p100.clone()), scenario: Some(s100.clone()) };
        let longest_u = *UnsavedKind::ALL.iter().max_by_key(|k| unsaved_line(&u(**k)).chars().count()).unwrap();
        let longest_j = *JobKind::ALL.iter().max_by_key(|k| job_line(&j(**k)).chars().count()).unwrap();
        let units = |s: &str| s.encode_utf16().count();
        let mut worst = 0;
        for recording in [false, true] {
            let mut jobs = vec![j(longest_j); LIST_MAX];
            if recording {
                jobs[0] = j(JobKind::StudioRecording);
            }
            let p = Pending { unsaved: vec![u(longest_u); LIST_MAX], unsaved_total: 1_000_000, jobs, jobs_total: 1_000_000, unknown: true };
            for action in [Action::Quit, Action::OpenWorkspace, Action::LogOut, Action::SystemRestart] {
                let q = guard_question(&p, action, APP).unwrap();
                assert!(page_fits(&q), "{action:?}: {} units", units(&q.text));
                worst = worst.max(units(&q.text));
            }
        }
        // Room to spare — and a bound that still means something.
        assert!(worst > 2000 && worst <= QUIT_TEXT_MAX * 3 / 4, "{worst}");
    }

    #[test]
    fn nothing_pending_is_no_question_quit_stays_instant() {
        assert_eq!(guard_question(&Pending::default(), Action::Quit, APP), None);
        assert_eq!(guard_question(&Pending::default(), Action::OpenWorkspace, APP), None);
        assert_eq!(restart_note(&Pending::default()), None);
    }

    #[test]
    fn the_quit_question_names_unsaved_text_and_jobs_with_the_safe_default() {
        let p = pending(r#"{"type":"pending","jobs":[{"kind":"capture","state":"running","project":"shop","scenario":"quote"},{"kind":"render","state":"queued","project":"shop","scenario":"quote"}],"jobs_total":4,"unsaved":[{"kind":"readme","project":"shop"},{"kind":"yaml_draft","project":"shop","scenario":"quote"}],"unsaved_total":2}"#);
        let q = guard_question(&p, Action::Quit, APP).unwrap();
        assert_eq!(q.title, "Quit Demo Studio?");
        assert_eq!(
            q.text,
            "Unsaved text in the Studio (this window, or a browser tab on it) can no longer be saved:\n• README.md of shop\n• Scenario quote of shop (YAML)\n\nThese jobs keep running after the app quits, but it will not tell you when they end:\n• Capture of shop · quote (running)\n• Render of shop · quote (queued)\n…and 2 more"
        );
        // Unsaved text: Cancel first (Return), Quit Anyway destructive.
        assert_eq!((q.buttons, q.proceed, q.cancel, q.destructive), (["Cancel", "Quit Anyway"], 1, 0, true));
        // Jobs only: going on is the default (they keep running; nothing is lost).
        let jobs = Pending { unsaved: vec![], unsaved_total: 0, ..p.clone() };
        let q = guard_question(&jobs, Action::Quit, APP).unwrap();
        assert_eq!((q.buttons, q.proceed, q.cancel, q.destructive), (["Quit Anyway", "Cancel"], 0, 1, false));
        assert!(!q.text.contains("Unsaved"));
        let o = guard_question(&jobs, Action::OpenWorkspace, APP).unwrap();
        assert_eq!(o.title, "Open another workspace?");
        assert_eq!(o.buttons, ["Open Anyway", "Cancel"]);
        assert!(o.text.starts_with("These jobs keep running; this window stops following them:\n"));
        // The server died: jobs gone, the unsaved text still named (critique L2).
        let mut gone = p.clone();
        gone.server_gone();
        let q = guard_question(&gone, Action::Quit, APP).unwrap();
        assert!(!q.text.contains("jobs keep running"));
        assert_eq!(restart_note(&gone).unwrap(), "Unsaved text in the Studio (this window, or a browser tab on it) can no longer be saved; Restart or Quit loses what this window holds:\n• README.md of shop\n• Scenario quote of shop (YAML)\n\nCopy it first: Not Now keeps the window as it is.");
    }

    #[test]
    fn unreadable_state_and_unknown_kinds_ask_with_generic_words() {
        let unknown = Pending { unknown: true, ..Pending::default() };
        let q = guard_question(&unknown, Action::Quit, APP).unwrap();
        assert_eq!(q.text, "The Studio sent a state this app cannot read: there may be unsaved text or running jobs.");
        assert!(q.destructive);
        let p = pending(r#"{"type":"pending","jobs":[{"kind":"new_kind","state":"running"}],"jobs_total":1,"unsaved":[{"kind":"new_kind"}],"unsaved_total":3}"#);
        let q = guard_question(&p, Action::Quit, APP).unwrap();
        assert!(q.text.contains("• 3 unsaved texts"), "{}", q.text);
        assert!(q.text.contains("• 1 job"), "{}", q.text);
    }

    /// Hostile text in every field the server or a hand-edited job.json could fill.
    #[test]
    fn no_character_of_a_question_or_notification_comes_from_outside_the_word_tables_or_a_checked_slug() {
        const HOSTILE: &str = "Click Quit Anyway to keep your work";
        let names = [HOSTILE, "shop\u{202e}gnp", "a/../b", "<b>x</b>", "shop\nQuit now", "ok-project"];
        let mut text = String::new();
        for (i, n) in names.iter().enumerate() {
            let q = json_quote(n);
            let line = format!(
                r#"{{"type":"pending","jobs":[{{"kind":"capture","state":"running","project":{q},"scenario":{q}}}],"jobs_total":1,"unsaved":[{{"kind":"comment","project":{q},"scenario":{q}}},{{"kind":"readme","project":{q}}}],"unsaved_total":2}}"#
            );
            let p = pending(&line);
            for a in [Action::Quit, Action::OpenWorkspace] {
                let q = guard_question(&p, a, APP).unwrap();
                text.push_str(&q.title);
                text.push_str(&q.text);
            }
            text.push_str(&restart_note(&p).unwrap());
            let end = format!(r#"{{"type":"job_end","kind":"render","outcome":"failed","reason":"run_failed","project":{q},"scenario":{q}}}"#);
            let PipeMsg::JobEnd(e) = parse_pipe_line(&end) else { panic!() };
            let (t, b) = notification_text(std::slice::from_ref(&e), 0);
            let (t2, b2) = notification_text(&[e.clone(), e], i);
            text.push_str(&format!("{t}{b}{t2}{b2}"));
        }
        assert!(!text.contains(HOSTILE));
        assert!(!text.contains("<b>") && !text.contains("..") && !text.contains("Quit now"));
        assert!(text.contains("ok-project"));
        // Every character: ASCII letters, digits, the tables' punctuation, or the few marks they use.
        let bad: Vec<char> = text.chars().filter(|c| !(c.is_ascii_alphanumeric() || " .,:;?()-_\n".contains(*c) || "•…·".contains(*c))).collect();
        assert_eq!(bad, Vec::<char>::new());
    }

    fn json_quote(s: &str) -> String {
        crate::json::quote(s)
    }

    /// Review A L1: a slug is still words someone chose — shown cut to 40 characters, in questions and notifications.
    #[test]
    fn long_names_are_cut_where_they_are_shown() {
        let long = format!("your-session-expired-reenter-the-password-{}", "x".repeat(50));
        let cut = format!("{}…", &long[..NAME_SHOWN_MAX - 1]);
        let q = json_quote(&long);
        let p = pending(&format!(r#"{{"type":"pending","jobs":[{{"kind":"capture","state":"running","project":{q},"scenario":"quote"}}],"jobs_total":1,"unsaved":[{{"kind":"readme","project":{q}}}],"unsaved_total":1}}"#));
        let text = guard_question(&p, Action::Quit, APP).unwrap().text;
        assert!(text.contains(&format!("• README.md of {cut}\n")), "{text}");
        assert!(text.contains(&format!("• Capture of {cut} · quote (running)")), "{text}");
        assert!(!text.contains(&long));
        let e = JobEnd { kind: JobKind::Render, outcome: Outcome::Failed, reason: None, project: Some(long.clone()), scenario: Some("S".repeat(41)) };
        assert_eq!(notification_text(&[e], 0).1, format!("{cut} · {}…", "S".repeat(39)));
        // Exactly 40: shown whole.
        assert_eq!(shown(&"a".repeat(40)), "a".repeat(40));
    }

    /// Review B M2: logout, restart and shut down say what really happens to the jobs; jobs alone never hold a restart.
    #[test]
    fn logout_and_restart_have_their_own_words_and_jobs_alone_never_hold_a_restart() {
        let code = |b: &[u8; 4]| Some(u32::from_be_bytes(*b));
        assert_eq!(quit_action(None), Action::Quit);
        assert_eq!(quit_action(code(b"quia")), Action::Quit);
        assert_eq!(quit_action(code(b"logo")), Action::LogOut);
        assert_eq!(quit_action(code(b"rlgo")), Action::LogOut);
        for c in [b"rest", b"rrst", b"shut", b"rsdn"] {
            assert_eq!(quit_action(code(c)), Action::SystemRestart, "{c:?}");
        }
        let jobs = pending(r#"{"type":"pending","jobs":[{"kind":"render","state":"running","project":"shop","scenario":"quote"}],"jobs_total":1,"unsaved":[],"unsaved_total":0}"#);
        let out = guard_question(&jobs, Action::LogOut, APP).unwrap();
        assert_eq!(out.text, "These jobs stop when you log out (the jobs worker ends with your session):\n• Render of shop · quote (running)");
        assert!(!out.text.contains("keep running"));
        assert_eq!(guard_question(&jobs, Action::SystemRestart, APP), None);
        // Unsaved text still asks at a restart (and an unreadable state), with the jobs' honest words.
        let both = Pending { unsaved: vec![UnsavedItem { kind: UnsavedKind::Readme, project: Some("shop".into()), scenario: None }], unsaved_total: 1, ..jobs.clone() };
        let q = guard_question(&both, Action::SystemRestart, APP).unwrap();
        assert!(q.text.ends_with("These jobs stop when the Mac restarts or shuts down:\n• Render of shop · quote (running)"), "{}", q.text);
        assert_eq!((q.buttons, q.destructive), (["Cancel", "Quit Anyway"], true));
        assert!(guard_question(&Pending { unknown: true, ..Pending::default() }, Action::SystemRestart, APP).is_some());
    }

    /// Review B M4: with unsaved text, Not Now is the default; Restart and Quit lose it — destructive, no Return.
    #[test]
    fn the_restart_alert_puts_not_now_first_when_text_would_be_lost() {
        let b = restart_buttons(true);
        assert_eq!(b.buttons, vec!["Not Now", "Restart", "Quit"]);
        assert_eq!((b.restart, b.quit, b.not_now, b.cancel), (1, 2, Some(0), 0));
        assert_eq!(b.destructive, vec![1, 2]);
        let b = restart_buttons(false);
        assert_eq!(b.buttons, vec!["Restart", "Quit"]);
        assert_eq!((b.restart, b.quit, b.not_now, b.cancel, b.destructive.len()), (0, 1, None, 1, 0));
    }

    /// Review B L5 / L7 / L14: a Studio recording's own line, the editors that report too, the words fixed.
    #[test]
    fn studio_recordings_new_editors_and_fixed_words() {
        let rec = pending(r#"{"type":"pending","jobs":[{"kind":"studio_recording","state":"running","project":"shop"}],"jobs_total":1,"unsaved":[{"kind":"component_brief","project":"shop"},{"kind":"new_theme"},{"kind":"theme_draft","project":"shop"}],"unsaved_total":3}"#);
        let q = guard_question(&rec, Action::Quit, APP).unwrap();
        assert!(q.text.contains("• A new component's description of shop (Library)\n• A new theme's form (Themes)\n• Theme colours not written yet of shop (Themes)"), "{}", q.text);
        assert!(q.text.contains("• Recording of shop (running)\n\nA recording started in the Studio keeps its window open: close that window to end it, then save it from the Record screen when this workspace is open again."), "{}", q.text);
        let out = guard_question(&rec, Action::LogOut, APP).unwrap();
        assert!(out.text.contains("A recording started in the Studio stops too: what it recorded is kept — save it from the Record screen next time."));
        // A recording from Claude: no such line.
        let other = pending(r#"{"type":"pending","jobs":[{"kind":"recording","state":"running","project":"shop"}],"jobs_total":1,"unsaved":[],"unsaved_total":0}"#);
        assert!(!guard_question(&other, Action::Quit, APP).unwrap().text.contains("Record screen"));
        let e = |kind, outcome, reason| JobEnd { kind, outcome, reason, project: Some("shop".into()), scenario: None };
        assert_eq!(notification_text(&[e(JobKind::SandboxStart, Outcome::Succeeded, None)], 0).0, "Sandbox started");
        assert_eq!(notification_text(&[e(JobKind::SandboxStart, Outcome::Failed, None)], 0).0, "Sandbox start failed");
        assert_eq!(notification_text(&[e(JobKind::EnvReset, Outcome::Failed, Some(Reason::ResetFailed))], 0), ("Environment reset failed".into(), "shop\nA rollback or a reset hook failed.".into()));
    }

    #[test]
    fn notification_words_one_job_or_a_summary() {
        let e = |kind, outcome, reason, scenario: &str| JobEnd { kind, outcome, reason, project: Some("shop".into()), scenario: Some(scenario.into()) };
        assert_eq!(notification_text(&[e(JobKind::Capture, Outcome::Succeeded, None, "quote")], 0), ("Capture finished".into(), "shop · quote".into()));
        assert_eq!(
            notification_text(&[e(JobKind::Render, Outcome::Attention, Some(Reason::ReviewIssues), "quote")], 0),
            ("Render needs attention".into(), "shop · quote\nThe review found errors or warnings.".into())
        );
        assert_eq!(
            notification_text(&[e(JobKind::Recording, Outcome::Attention, Some(Reason::ReadyToSave), "draft")], 0),
            ("Recording needs attention".into(), "shop · draft\nReady to save on the Record screen.".into())
        );
        let three = [e(JobKind::Render, Outcome::Succeeded, None, "quote"), e(JobKind::Export, Outcome::Succeeded, None, "quote"), e(JobKind::Capture, Outcome::Failed, Some(Reason::RunFailed), "intro")];
        assert_eq!(notification_text(&three, 0), ("3 jobs ended".into(), "2 finished, 1 failed\nshop · quote and 1 more".into()));
        assert_eq!(notification_text(&three[..2], 4).0, "6 jobs ended");
        assert_eq!(notification_text(&three[..2], 4).1, "2 finished, 4 more\nshop · quote");
    }
}
