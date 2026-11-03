//! The quit question's flow (L5.12d, DESIGN §4j): page first, the native alert as the fallback. A pure state machine —
//! no thread, no clock of its own (every input carries `now`, milliseconds of the shell's own monotonic clock), no
//! AppKit — so that each rule below is a unit test.
//!
//! - ⌘Q with something pending, a plain Quit (not logout / restart / shut down), an owned server, the window on the
//!   Studio's origin: the hook answers Cancel at once and the page is asked — `ShowWindow`, then `Dispatch` of one
//!   constant-shaped script (`page_quit_js`: the question's words from words.rs as JSON data, a fresh id). No
//!   TerminateLater (it would reply from a tao callback: the H1 hang): a "Quit Anyway" from the page sets APPROVED and
//!   sends `terminate:` again (`Terminate`); the re-entered hook consumes it and answers Now.
//! - The page acks `shown` (sheet open, one frame painted, the window visible) through the server's pipe. No ack within
//!   SHOWN_WITHIN_MS: `tick` closes the page's question and re-sends `terminate:` with FALLBACK set — the re-entered
//!   hook asks with today's native alert.
//! - `shown` / `answer` are taken only for the id of the question up now, once (an old, replayed or post-fallback id
//!   is ignored); APPROVED is tied to the answer of that id, expires after APPROVED_FOR_MS and any Cancel clears it
//!   (the restart alert opening between the page's Quit Anyway and the re-entered `terminate:`).
//! - Every exit from Asked closes the page's sheet (`Close`: `studio:quit-close {id}`) — the fallback, logout /
//!   restart arriving while asked, the server gone, a signal, the native question, another question of the shell.
//! - A second ⌘Q while the page question is up re-dispatches the same id (a reloaded page shows it again) and waits for
//!   `shown` again; once the question was shown REASK_NATIVE_AFTER_MS ago and is still unanswered, it goes native (a
//!   page that acked and then hung never traps the person).

use crate::json;
use crate::words::Question;

/// No `shown` within this: the native alert.
pub const SHOWN_WITHIN_MS: u64 = 1500;
/// A page's Quit Anyway holds this long for the re-entered `terminate:`.
pub const APPROVED_FOR_MS: u64 = 5000;
/// The fallback holds this long for the re-entered `terminate:`.
pub const FALLBACK_FOR_MS: u64 = 5000;
/// A question shown this long ago and still unanswered: the next ⌘Q asks natively.
pub const REASK_NATIVE_AFTER_MS: u64 = 10_000;

/// The page's events (packages/ui shell/quit.ts QUIT_EVENT / QUIT_CLOSE_EVENT).
pub const QUIT_EVENT: &str = "studio:quit";
pub const QUIT_CLOSE_EVENT: &str = "studio:quit-close";
/// The keys of the question's `detail`, in order — the page's parser takes exactly these (QUIT_DETAIL_KEYS in the
/// page's shell/quit.ts; a static test compares the two lists).
pub const QUIT_DETAIL_KEYS: [&str; 8] = ["id", "action", "title", "text", "buttons", "proceed", "cancel", "destructive"];

/// The longest title or text the page takes, in UTF-16 units (what the page's `.length` counts): shell/quit.ts
/// QUIT_TEXT_MAX, compared by a static test (review A-L1 / B-L1). words.rs's longest question fits (its test builds it:
/// eight unsaved lines and eight job lines of cut names, the largest totals, the recording and unknown notes); a
/// question that would not is asked natively at once (`page_fits`), never sent to be refused.
pub const QUIT_TEXT_MAX: usize = 4000;
/// The longest button label the page takes (shell/quit.ts QUIT_LABEL_MAX).
pub const QUIT_LABEL_MAX: usize = 100;

/// The question is within the page's bounds (a title, a text and two labels, none empty, none too long).
pub fn page_fits(q: &Question) -> bool {
    let within = |s: &str, max: usize| (1..=max).contains(&s.encode_utf16().count());
    within(&q.title, QUIT_TEXT_MAX) && within(&q.text, QUIT_TEXT_MAX) && q.buttons.iter().all(|b| within(b, QUIT_LABEL_MAX))
}

/// A question's id: 22 base64url characters (16 random bytes).
pub fn id_ok(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// 16 bytes as 22 base64url characters (no padding).
pub fn new_id(bytes: [u8; 16]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(22);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(A[((acc >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(A[((acc << (6 - bits)) & 63) as usize] as char);
    }
    out
}

/// The script that asks the page: one `studio:quit` event, its detail the question as JSON (every string quoted).
pub fn page_quit_js(id: &str, q: &Question) -> String {
    let values = [
        json::quote(id),
        json::quote("quit"),
        json::quote(&q.title),
        json::quote(&q.text),
        format!("[{}]", q.buttons.iter().map(|b| json::quote(b)).collect::<Vec<_>>().join(",")),
        q.proceed.to_string(),
        q.cancel.to_string(),
        q.destructive.to_string(),
    ];
    let detail = QUIT_DETAIL_KEYS.iter().zip(values).map(|(k, v)| format!("{}:{v}", json::quote(k))).collect::<Vec<_>>().join(",");
    format!("window.dispatchEvent(new CustomEvent({}, {{ detail: {{{detail}}} }}))", json::quote(QUIT_EVENT))
}

/// The script that closes the page's sheet of question `id` (a page showing no such question ignores it).
pub fn page_close_js(id: &str) -> String {
    format!("window.dispatchEvent(new CustomEvent({}, {{ detail: {{\"id\":{}}} }}))", json::quote(QUIT_CLOSE_EVENT), json::quote(id))
}

/// What the hook answers AppKit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Now,
    Cancel,
    /// Ask with the native alert (then Now or Cancel by its answer).
    Native(Question),
}

/// What the shell does, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Show the window (unminimise, bring it to the front) — before a dispatch.
    ShowWindow,
    /// Evaluate `js` in the window's page (the question `id`); arm the SHOWN_WITHIN_MS timer (`tick`).
    Dispatch { id: String, js: String },
    /// Evaluate `js`: the page's sheet of `id` closes.
    Close { id: String, js: String },
    /// Send `terminate:` again from a thread (performSelectorOnMainThread), never from a Tauri callback.
    Terminate,
}

/// One `terminate:` as the hook sees it.
#[derive(Debug, Clone)]
pub struct Ask {
    pub now: u64,
    /// A question of the shell is up (the native quit question, Open Workspace…'s, the restart alert, the picker).
    pub other_modal: bool,
    /// A signal asked to quit.
    pub quit_now: bool,
    /// The question to ask; None: nothing pending (Quit is instant).
    pub question: Option<Question>,
    /// The page may be asked: a plain Quit, an owned server, the window on the Studio's origin, test mode not native.
    pub page: bool,
    /// A fresh id (empty when none could be made: native).
    pub new_id: String,
}

#[derive(Debug, Clone)]
struct Asked {
    id: String,
    /// When it was (re-)dispatched.
    at: u64,
    /// The page acked this dispatch.
    shown: Option<u64>,
    /// The first ack of this question.
    first_shown: Option<u64>,
}

/// The flow's state: Idle, or one page question up; the one-shot APPROVED and FALLBACK.
#[derive(Debug, Default)]
pub struct Flow {
    asked: Option<Asked>,
    approved: Option<(String, u64)>,
    fallback: Option<u64>,
}

impl Flow {
    pub const fn new() -> Self {
        Flow { asked: None, approved: None, fallback: None }
    }

    /// The id of the page question up now.
    pub fn asked_id(&self) -> Option<&str> {
        self.asked.as_ref().map(|a| a.id.as_str())
    }

    /// The page question up now ends (any exit from Asked but an answer): its sheet closes.
    fn close(&mut self, fx: &mut Vec<Effect>) {
        if let Some(a) = self.asked.take() {
            let js = page_close_js(&a.id);
            fx.push(Effect::Close { id: a.id, js });
        }
    }

    /// `applicationShouldTerminate:`.
    pub fn terminate(&mut self, a: Ask) -> (Reply, Vec<Effect>) {
        let mut fx = Vec::new();
        if a.other_modal {
            // Answered first (review B L13); a Cancel clears APPROVED (H1: the restart alert came in between).
            self.approved = None;
            return (Reply::Cancel, fx);
        }
        if a.quit_now {
            self.close(&mut fx);
            self.approved = None;
            self.fallback = None;
            return (Reply::Now, fx);
        }
        if let Some((_, at)) = self.approved.take() {
            if a.now.saturating_sub(at) <= APPROVED_FOR_MS {
                return (Reply::Now, fx);
            }
        }
        let fallback = self.fallback.take().is_some_and(|at| a.now.saturating_sub(at) <= FALLBACK_FOR_MS);
        let Some(q) = a.question else {
            self.close(&mut fx);
            return (Reply::Now, fx);
        };
        if fallback || !a.page || !page_fits(&q) {
            self.close(&mut fx);
            return (Reply::Native(q), fx);
        }
        if let Some(asked) = &mut self.asked {
            if asked.first_shown.is_some_and(|t| a.now.saturating_sub(t) >= REASK_NATIVE_AFTER_MS) {
                self.close(&mut fx);
                return (Reply::Native(q), fx);
            }
            asked.at = a.now;
            asked.shown = None;
            let id = asked.id.clone();
            let js = page_quit_js(&id, &q);
            fx.push(Effect::ShowWindow);
            fx.push(Effect::Dispatch { id, js });
            return (Reply::Cancel, fx);
        }
        if !id_ok(&a.new_id) {
            return (Reply::Native(q), fx);
        }
        let id = a.new_id;
        self.asked = Some(Asked { id: id.clone(), at: a.now, shown: None, first_shown: None });
        let js = page_quit_js(&id, &q);
        fx.push(Effect::ShowWindow);
        fx.push(Effect::Dispatch { id, js });
        (Reply::Cancel, fx)
    }

    /// The SHOWN_WITHIN_MS timer of a dispatch: no ack yet → close the page's sheet, FALLBACK, `terminate:` again.
    pub fn tick(&mut self, now: u64) -> Vec<Effect> {
        let mut fx = Vec::new();
        if let Some(a) = &self.asked {
            if a.shown.is_none() && now.saturating_sub(a.at) >= SHOWN_WITHIN_MS {
                self.close(&mut fx);
                self.fallback = Some(now);
                fx.push(Effect::Terminate);
            }
        }
        fx
    }

    /// The page showed question `id`; false when it is not the question up now or was already acked.
    pub fn shown(&mut self, id: &str, now: u64) -> bool {
        match &mut self.asked {
            Some(a) if a.id == id && a.shown.is_none() => {
                a.shown = Some(now);
                a.first_shown.get_or_insert(now);
                true
            }
            _ => false,
        }
    }

    /// The page's answer to question `id`; false (nothing done) when it is not the question up now.
    pub fn answer(&mut self, id: &str, proceed: bool, now: u64) -> (bool, Vec<Effect>) {
        let mut fx = Vec::new();
        if self.asked.as_ref().map_or(true, |a| a.id != id) {
            return (false, fx);
        }
        self.close(&mut fx);
        if proceed {
            self.approved = Some((id.to_string(), now));
            fx.push(Effect::Terminate);
        } else {
            self.approved = None;
        }
        (true, fx)
    }

    /// The question up now is dropped: the server gone (no answer can come), a signal, another question of the shell.
    pub fn drop_asked(&mut self) -> Vec<Effect> {
        let mut fx = Vec::new();
        self.close(&mut fx);
        self.approved = None;
        fx
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::Json;

    fn q(destructive: bool) -> Question {
        let (buttons, proceed, cancel) = if destructive { (["Cancel", "Quit Anyway"], 1, 0) } else { (["Quit Anyway", "Cancel"], 0, 1) };
        Question { title: "Quit Retake?".into(), text: "Unsaved \"text\"\n• README.md of shop\u{2028}</script>".into(), buttons, proceed, cancel, destructive }
    }

    const ID: &str = "AAAAAAAAAAAAAAAAAAAAAA";
    const ID2: &str = "BBBBBBBBBBBBBBBBBBBBBB";

    fn ask(now: u64) -> Ask {
        Ask { now, other_modal: false, quit_now: false, question: Some(q(true)), page: true, new_id: ID.into() }
    }

    fn dispatched(fx: &[Effect]) -> Option<&str> {
        fx.iter().find_map(|e| match e {
            Effect::Dispatch { id, .. } => Some(id.as_str()),
            _ => None,
        })
    }

    fn closed(fx: &[Effect]) -> Option<&str> {
        fx.iter().find_map(|e| match e {
            Effect::Close { id, .. } => Some(id.as_str()),
            _ => None,
        })
    }

    #[test]
    fn quit_asks_the_page_first_window_shown_before_the_dispatch_then_quit_anyway_re_enters_once() {
        let mut f = Flow::new();
        let (r, fx) = f.terminate(ask(0));
        assert_eq!(r, Reply::Cancel);
        assert_eq!(fx.len(), 2);
        assert_eq!(fx[0], Effect::ShowWindow);
        assert_eq!(dispatched(&fx), Some(ID));
        assert!(f.shown(ID, 300));
        // Shown once: a replayed ack is ignored.
        assert!(!f.shown(ID, 400));
        let (ok, fx) = f.answer(ID, true, 2000);
        assert!(ok);
        assert_eq!(fx, vec![Effect::Close { id: ID.into(), js: page_close_js(ID) }, Effect::Terminate]);
        // The re-entered terminate: consumes APPROVED → Now; the next one asks again (APPROVED consumed once).
        assert_eq!(f.terminate(ask(2010)).0, Reply::Now);
        let (r, fx) = f.terminate(Ask { new_id: ID2.into(), ..ask(3000) });
        assert_eq!(r, Reply::Cancel);
        assert_eq!(dispatched(&fx), Some(ID2));
    }

    #[test]
    fn no_ack_within_the_window_goes_native_and_the_page_sheet_is_closed() {
        let mut f = Flow::new();
        f.terminate(ask(0));
        assert_eq!(f.tick(SHOWN_WITHIN_MS - 1), vec![]);
        let fx = f.tick(SHOWN_WITHIN_MS);
        assert_eq!(fx, vec![Effect::Close { id: ID.into(), js: page_close_js(ID) }, Effect::Terminate]);
        // A late ack or answer of that id: ignored (post-fallback).
        assert!(!f.shown(ID, SHOWN_WITHIN_MS + 100));
        assert_eq!(f.answer(ID, true, SHOWN_WITHIN_MS + 100), (false, vec![]));
        // The re-entered terminate: asks natively.
        assert_eq!(f.terminate(ask(SHOWN_WITHIN_MS + 120)).0, Reply::Native(q(true)));
        // The fallback was consumed: the next ⌘Q asks the page again.
        assert_eq!(f.terminate(Ask { new_id: ID2.into(), ..ask(9000) }).0, Reply::Cancel);
        // A tick after an ack does nothing.
        assert!(f.shown(ID2, 9100));
        assert_eq!(f.tick(9000 + SHOWN_WITHIN_MS * 4), vec![]);
    }

    #[test]
    fn a_wrong_old_or_replayed_id_is_ignored_and_a_cancel_leaves_nothing_approved() {
        let mut f = Flow::new();
        f.terminate(ask(0));
        assert!(!f.shown(ID2, 10));
        assert_eq!(f.answer(ID2, true, 20), (false, vec![]));
        assert_eq!(f.answer("", true, 20), (false, vec![]));
        let (ok, fx) = f.answer(ID, false, 30);
        assert!(ok);
        assert_eq!(fx, vec![Effect::Close { id: ID.into(), js: page_close_js(ID) }]);
        // Replayed: the same answer again, then a proceed of the old id after a new question.
        assert_eq!(f.answer(ID, true, 40), (false, vec![]));
        let (_, fx) = f.terminate(Ask { new_id: ID2.into(), ..ask(100) });
        assert_eq!(dispatched(&fx), Some(ID2));
        assert_eq!(f.answer(ID, true, 110), (false, vec![]));
        assert!(!f.shown(ID, 110));
        assert_eq!(f.asked_id(), Some(ID2));
    }

    #[test]
    fn approved_expires_and_any_cancel_clears_it_the_restart_alert_case() {
        let mut f = Flow::new();
        f.terminate(ask(0));
        f.answer(ID, true, 100);
        // The restart alert opened before the re-entered terminate: → Cancel, APPROVED gone.
        assert_eq!(f.terminate(Ask { other_modal: true, ..ask(150) }).0, Reply::Cancel);
        let (r, fx) = f.terminate(Ask { new_id: ID2.into(), ..ask(200) });
        assert_eq!(r, Reply::Cancel);
        assert_eq!(dispatched(&fx), Some(ID2), "a later ⌘Q asks again, never quits silently");
        // Expired: a terminate: more than APPROVED_FOR_MS after the answer asks again.
        let mut f = Flow::new();
        f.terminate(ask(0));
        f.answer(ID, true, 100);
        let (r, fx) = f.terminate(Ask { new_id: ID2.into(), ..ask(100 + APPROVED_FOR_MS + 1) });
        assert_eq!(r, Reply::Cancel);
        assert_eq!(dispatched(&fx), Some(ID2));
    }

    #[test]
    fn logout_restart_signal_server_gone_and_nothing_pending_close_the_page_question() {
        // Logout / restart while asked (page false): native, the page's sheet closed.
        let mut f = Flow::new();
        f.terminate(ask(0));
        let (r, fx) = f.terminate(Ask { page: false, ..ask(500) });
        assert_eq!(r, Reply::Native(q(true)));
        assert_eq!(closed(&fx), Some(ID));
        assert!(!f.shown(ID, 600));
        // A signal: Now, closed.
        let mut f = Flow::new();
        f.terminate(ask(0));
        let (r, fx) = f.terminate(Ask { quit_now: true, ..ask(10) });
        assert_eq!(r, Reply::Now);
        assert_eq!(closed(&fx), Some(ID));
        // The server gone: dropped, closed, APPROVED gone too.
        let mut f = Flow::new();
        f.terminate(ask(0));
        assert_eq!(closed(&f.drop_asked()), Some(ID));
        assert_eq!(f.answer(ID, true, 20), (false, vec![]));
        assert_eq!(f.drop_asked(), vec![]);
        // Nothing pending any more: Now, closed.
        let mut f = Flow::new();
        f.terminate(ask(0));
        let (r, fx) = f.terminate(Ask { question: None, ..ask(10) });
        assert_eq!(r, Reply::Now);
        assert_eq!(closed(&fx), Some(ID));
        // Another question of the shell up: Cancel, the page question stays (answered after it).
        let mut f = Flow::new();
        f.terminate(ask(0));
        assert_eq!(f.terminate(Ask { other_modal: true, ..ask(10) }), (Reply::Cancel, vec![]));
        assert_eq!(f.asked_id(), Some(ID));
        // No id could be made: native at once.
        let mut f = Flow::new();
        assert_eq!(f.terminate(Ask { new_id: String::new(), ..ask(0) }).0, Reply::Native(q(true)));
        assert_eq!(f.asked_id(), None);
    }

    #[test]
    fn a_second_quit_re_dispatches_the_same_id_and_after_ten_seconds_shown_goes_native() {
        let mut f = Flow::new();
        f.terminate(ask(0));
        // Not shown yet: the same id again (a reloaded page shows it), the timer restarted.
        let (r, fx) = f.terminate(Ask { new_id: ID2.into(), ..ask(1000) });
        assert_eq!(r, Reply::Cancel);
        assert_eq!(fx[0], Effect::ShowWindow);
        assert_eq!(dispatched(&fx), Some(ID));
        assert_eq!(f.tick(SHOWN_WITHIN_MS), vec![], "the re-dispatch at 1000 restarted the window");
        assert!(f.shown(ID, 1200));
        // Shown, unanswered: a ⌘Q within REASK_NATIVE_AFTER_MS re-dispatches (and the page acks again).
        let (_, fx) = f.terminate(ask(5000));
        assert_eq!(dispatched(&fx), Some(ID));
        assert!(f.shown(ID, 5100));
        // Still unanswered REASK_NATIVE_AFTER_MS after the first ack: native, the sheet closed.
        let (r, fx) = f.terminate(ask(1200 + REASK_NATIVE_AFTER_MS));
        assert_eq!(r, Reply::Native(q(true)));
        assert_eq!(closed(&fx), Some(ID));
    }

    #[test]
    fn the_page_script_is_one_constant_shape_with_the_question_as_json_data() {
        let js = page_quit_js(ID, &q(true));
        let prefix = "window.dispatchEvent(new CustomEvent(\"studio:quit\", { detail: ";
        assert!(js.starts_with(prefix) && js.ends_with(" }))"), "{js}");
        let detail = json::parse(&js[prefix.len()..js.len() - 4]).unwrap();
        let Json::Obj(fields) = &detail else { panic!("{js}") };
        assert_eq!(fields.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), QUIT_DETAIL_KEYS.to_vec());
        assert_eq!(detail.get("id").and_then(Json::as_str), Some(ID));
        assert_eq!(detail.get("action").and_then(Json::as_str), Some("quit"));
        assert_eq!(detail.get("text").and_then(Json::as_str), Some(q(true).text.as_str()));
        assert_eq!(detail.get("proceed").and_then(|v| v.as_uint(9)), Some(1));
        assert_eq!(detail.get("cancel").and_then(|v| v.as_uint(9)), Some(0));
        assert_eq!(detail.get("destructive"), Some(&Json::Bool(true)));
        // The line separator never reaches the script raw (a JS string literal would break on it).
        assert!(!js.contains('\u{2028}') && js.contains("\\u2028"));
        assert_eq!(page_close_js(ID), "window.dispatchEvent(new CustomEvent(\"studio:quit-close\", { detail: {\"id\":\"AAAAAAAAAAAAAAAAAAAAAA\"} }))");
    }

    /// Review A-L1 / B-L1: a question past the page's bounds is asked natively at once (never sent to be refused, never
    /// the 1.5 s wait); one at the bound still goes to the page.
    #[test]
    fn a_question_past_the_page_bounds_is_asked_natively_at_once() {
        let at = |len: usize| Question { text: "x".repeat(len), ..q(true) };
        let mut f = Flow::new();
        let (r, fx) = f.terminate(Ask { question: Some(at(QUIT_TEXT_MAX)), ..ask(0) });
        assert_eq!(r, Reply::Cancel);
        assert_eq!(dispatched(&fx), Some(ID));
        let mut f = Flow::new();
        assert_eq!(f.terminate(Ask { question: Some(at(QUIT_TEXT_MAX + 1)), ..ask(0) }), (Reply::Native(at(QUIT_TEXT_MAX + 1)), vec![]));
        assert_eq!(f.asked_id(), None);
        // UTF-16 units, as the page counts: a character outside the BMP counts two.
        assert!(!page_fits(&Question { text: "\u{1F600}".repeat(QUIT_TEXT_MAX / 2 + 1), ..q(true) }));
        assert!(page_fits(&Question { text: "\u{1F600}".repeat(QUIT_TEXT_MAX / 2), ..q(true) }));
        assert!(!page_fits(&Question { title: String::new(), ..q(true) }));
    }

    #[test]
    fn ids_are_22_base64url_characters() {
        assert_eq!(new_id([0; 16]), "AAAAAAAAAAAAAAAAAAAAAA");
        assert_eq!(new_id([255; 16]), "_____________________w");
        let id = new_id([0xfb, 0xef, 0xbe, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
        assert!(id_ok(&id), "{id}");
        assert!(id.starts_with("----"));
        for bad in ["", "AAAAAAAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAA+/", "AAAAAAAAAAAAAAAAAAAAA=", "AAAAAAAAAAAAAAAAAAAAA\u{e9}"] {
            assert!(!id_ok(bad), "{bad:?}");
        }
    }
}
