//! When a job end becomes a notification (L5.2b, DESIGN §4j) — pure, so the no-storm rule is tested without macOS:
//!
//! - the window in front (the app active, its window key, visible, not minimised): nothing — the page shows it;
//! - otherwise the first end posts at once; ends within `NOTIFY_GAP` of a post are held and flushed as ONE summary at
//!   the gap's end (dropped if the window came to front meanwhile) — at most one post per gap, 12 a minute;
//! - a summary lists at most `BATCH_MAX` ends; the rest are counted.
//!
//! The notification permission (`Auth`, review B L9): asked at the first post that would be shown; a denial or an error
//! is never kept for the session — the next post asks again (once the person answered, that call never prompts: a
//! switch turned on in System Settings takes effect without a relaunch); each different outcome is said once, an error
//! with its domain and code (an unsigned or ad hoc bundle is refused for another reason than a person's "no").

use crate::pipe::JobEnd;
use std::time::{Duration, Instant};

pub const NOTIFY_GAP: Duration = Duration::from_secs(5);
pub const BATCH_MAX: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Post one notification of these ends (`more`: ends not listed).
    Post { ends: Vec<JobEnd>, more: usize },
    /// The window is in front: these many ends were not notified.
    Dropped(usize),
    /// Held for the next summary.
    Held,
    Nothing,
}

#[derive(Debug, Default)]
pub struct Notifier {
    last_post: Option<Instant>,
    held: Vec<JobEnd>,
    held_more: usize,
}

impl Notifier {
    pub fn new() -> Self {
        Notifier::default()
    }

    /// Ends are held for a summary.
    pub fn has_held(&self) -> bool {
        !self.held.is_empty() || self.held_more > 0
    }

    fn quiet(&self, now: Instant) -> bool {
        match self.last_post {
            None => true,
            Some(t) => now.duration_since(t) >= NOTIFY_GAP,
        }
    }

    /// A job ended; `front`: the window is in front now.
    pub fn on_job_end(&mut self, end: JobEnd, now: Instant, front: bool) -> Decision {
        if front {
            return Decision::Dropped(1);
        }
        if self.held.is_empty() && self.held_more == 0 && self.quiet(now) {
            self.last_post = Some(now);
            return Decision::Post { ends: vec![end], more: 0 };
        }
        if self.held.len() < BATCH_MAX {
            self.held.push(end);
        } else {
            self.held_more += 1;
        }
        Decision::Held
    }

    /// The clock (about once a second): the held ends as one summary once the gap since the last post is over.
    pub fn on_tick(&mut self, now: Instant, front: bool) -> Decision {
        if self.held.is_empty() && self.held_more == 0 {
            return Decision::Nothing;
        }
        if !self.quiet(now) {
            return Decision::Nothing;
        }
        let ends = std::mem::take(&mut self.held);
        let more = std::mem::take(&mut self.held_more);
        if front {
            return Decision::Dropped(ends.len() + more);
        }
        self.last_post = Some(now);
        Decision::Post { ends, more }
    }
}

/// Where the notification permission stands.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Auth {
    /// Not asked yet in this session, or the last answer was no (ask again: it never prompts twice).
    #[default]
    Unknown,
    /// A request is out: the notification waits for its answer.
    Asking,
    Granted,
}

/// What to do with a notification to post now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStep {
    Post,
    /// Keep it as the one waiting for the answer.
    Wait,
    /// Ask (and keep it waiting).
    Ask,
}

/// The answer to a permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthAnswer {
    Granted,
    Denied,
    /// macOS refused the request itself: its error's domain and code.
    Error(String, i64),
}

#[derive(Debug, Default)]
pub struct Permission {
    state: Auth,
    said: Option<AuthAnswer>,
}

impl Permission {
    pub fn state(&self) -> Auth {
        self.state
    }

    pub fn on_post(&mut self) -> AuthStep {
        match self.state {
            Auth::Granted => AuthStep::Post,
            Auth::Asking => AuthStep::Wait,
            Auth::Unknown => {
                self.state = Auth::Asking;
                AuthStep::Ask
            }
        }
    }

    /// The answer came: true when the waiting notification may be posted; the line to log, if this outcome was not said.
    pub fn on_answer(&mut self, answer: AuthAnswer, app: &str) -> (bool, Option<String>) {
        let granted = answer == AuthAnswer::Granted;
        self.state = if granted { Auth::Granted } else { Auth::Unknown };
        if self.said.as_ref() == Some(&answer) {
            return (granted, None);
        }
        let line = match &answer {
            AuthAnswer::Granted => self.said.is_some().then(|| "notifications are on".to_string()),
            AuthAnswer::Denied => Some(format!("notifications are off: System Settings › Notifications › {app} turns them on")),
            AuthAnswer::Error(domain, code) => Some(format!("notifications could not be allowed: macOS refused the request ({domain} {code})")),
        };
        self.said = Some(answer);
        (granted, line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipe::{JobKind, Outcome};

    fn end(n: usize) -> JobEnd {
        JobEnd { kind: JobKind::Render, outcome: [Outcome::Succeeded, Outcome::Failed][n % 2], reason: None, project: Some("shop".into()), scenario: None }
    }

    #[test]
    fn fifty_job_ends_within_a_second_are_one_post_and_one_summary_no_storm() {
        let t0 = Instant::now();
        let mut n = Notifier::new();
        let mut posts = Vec::new();
        for i in 0..50 {
            let now = t0 + Duration::from_millis(i as u64 * 20);
            if let Decision::Post { ends, more } = n.on_job_end(end(i), now, false) {
                posts.push((now, ends.len(), more));
            }
            if let Decision::Post { ends, more } = n.on_tick(now, false) {
                posts.push((now, ends.len(), more));
            }
        }
        for s in 1..=12 {
            let now = t0 + Duration::from_secs(s);
            if let Decision::Post { ends, more } = n.on_tick(now, false) {
                posts.push((now, ends.len(), more));
            }
        }
        assert_eq!(posts.len(), 2, "{posts:?}");
        assert_eq!((posts[0].1, posts[0].2), (1, 0));
        assert_eq!((posts[1].1, posts[1].2), (BATCH_MAX, 49 - BATCH_MAX));
        assert!(posts[1].0.duration_since(posts[0].0) >= NOTIFY_GAP);
    }

    #[test]
    fn the_window_in_front_drops_ends_and_a_held_summary() {
        let t0 = Instant::now();
        let mut n = Notifier::new();
        assert_eq!(n.on_job_end(end(0), t0, true), Decision::Dropped(1));
        assert!(matches!(n.on_job_end(end(1), t0, false), Decision::Post { .. }));
        assert_eq!(n.on_job_end(end(2), t0 + Duration::from_secs(1), false), Decision::Held);
        assert_eq!(n.on_job_end(end(3), t0 + Duration::from_secs(2), false), Decision::Held);
        assert_eq!(n.on_tick(t0 + Duration::from_secs(3), false), Decision::Nothing);
        // The person came back to the window before the summary: it is dropped, not posted later.
        assert_eq!(n.on_tick(t0 + Duration::from_secs(5), true), Decision::Dropped(2));
        assert_eq!(n.on_tick(t0 + Duration::from_secs(6), false), Decision::Nothing);
    }

    /// Review B L9: a denial or an error is not kept for the session; each different outcome is said once, honestly.
    #[test]
    fn permission_asks_again_after_a_no_and_says_each_outcome_once() {
        let mut p = Permission::default();
        assert_eq!(p.on_post(), AuthStep::Ask);
        assert_eq!(p.on_post(), AuthStep::Wait);
        let (ok, line) = p.on_answer(AuthAnswer::Denied, "Retake");
        assert!(!ok);
        assert_eq!(line.as_deref(), Some("notifications are off: System Settings › Notifications › Retake turns them on"));
        // The next post asks again (no prompt then: the person answered), and the same no is not said again.
        assert_eq!(p.on_post(), AuthStep::Ask);
        assert_eq!(p.on_answer(AuthAnswer::Denied, "Retake"), (false, None));
        // Turned on in System Settings meanwhile: granted at the next post, said.
        assert_eq!(p.on_post(), AuthStep::Ask);
        assert_eq!(p.on_answer(AuthAnswer::Granted, "Retake"), (true, Some("notifications are on".into())));
        assert_eq!(p.on_post(), AuthStep::Post);
        // An error is not a person's no: its domain and code are said.
        let mut q = Permission::default();
        q.on_post();
        let (ok, line) = q.on_answer(AuthAnswer::Error("UNErrorDomain".into(), 1), "Retake");
        assert!(!ok);
        assert_eq!(line.as_deref(), Some("notifications could not be allowed: macOS refused the request (UNErrorDomain 1)"));
        assert_eq!(q.state(), Auth::Unknown);
        // Granted at once (the usual case): nothing to say.
        let mut g = Permission::default();
        g.on_post();
        assert_eq!(g.on_answer(AuthAnswer::Granted, "Retake"), (true, None));
    }

    #[test]
    fn at_most_one_post_per_gap() {
        let t0 = Instant::now();
        let mut n = Notifier::new();
        let mut last: Option<Instant> = None;
        for ms in (0..60_000).step_by(700) {
            let now = t0 + Duration::from_millis(ms);
            for d in [n.on_job_end(end(ms as usize), now, false), n.on_tick(now, false)] {
                if let Decision::Post { .. } = d {
                    if let Some(l) = last {
                        assert!(now.duration_since(l) >= NOTIFY_GAP);
                    }
                    last = Some(now);
                }
            }
        }
    }
}
