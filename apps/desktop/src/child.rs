//! The child `retake ui --supervised`: started with its three pipes, its first stdout line read (≤ 30 s) and checked,
//! its stderr forwarded line by line (through the log filter) and its last 8 KB kept for an alert. Owned (it serves):
//! the shell holds the only write end of its stdin — the shell's death is its EOF, so no orphan — and stops it on
//! Quit (desktop_core::stop_child). Attached (`reused`: another process serves the workspace): it exits at once and
//! the shell never touches that server. A release build gives the child the app's environment without the variables
//! that make Node.js or the linker load code (desktop_core::child_env_dropped: review A L4).
//! L5.2b: after the line, stdout keeps being read through a capped line reader (desktop_core::LineReader, 16 KB a line):
//! each `pending` replaces the snapshot the quit guard reads (a malformed one marks it unreadable until the next), each
//! `job_end` goes to the notifier (held, at most 32, until `on_job_end` is installed), a blank line (the server frames
//! each line with one before it: review A L3) is skipped silently, anything else is ignored (said once). The counts are logged when they change (`pending: 1 job, 0 unsaved`: the gated test's signal). At the
//! server's end its jobs are history (critique L2): the snapshot keeps only the unsaved text.

use crate::log;
use desktop_core::{child_env_dropped, parse_ui_line, parse_pipe_line, sanitize, stop_child, JobEnd, LaunchConfig, Line, LineError, LineReader, Pending, PipeMsg, Stopped, UiLine, PIPE_LINE_MAX};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// The first line's deadline.
const LINE_TIMEOUT: Duration = Duration::from_secs(30);
/// Quit: SIGTERM and EOF, then SIGKILL after this.
pub const STOP_GRACE: Duration = Duration::from_secs(5);
/// The stderr tail kept for an alert (bytes).
const TAIL_MAX: usize = 8 * 1024;
/// The longest first line read.
const LINE_MAX: usize = 64 * 1024;
/// Job ends kept until the notifier is installed.
const ENDS_HELD_MAX: usize = 32;

/// The CLI's usage exit code (EXIT.usage): "no workspace here" comes with its JSON error line; without it, the CLI
/// refused its arguments (review B L4: a build older than `ui --supervised`).
const EXIT_USAGE: i32 = 2;

#[derive(Default)]
struct Tail {
    lines: VecDeque<String>,
    bytes: usize,
}

impl Tail {
    fn push(&mut self, line: String) {
        self.bytes += line.len() + 1;
        self.lines.push_back(line);
        while self.bytes > TAIL_MAX {
            match self.lines.pop_front() {
                Some(l) => self.bytes -= l.len() + 1,
                None => break,
            }
        }
    }
    fn text(&self) -> String {
        self.lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }
}

pub enum StartError {
    /// The CLI says the folder is no workspace (`{"type":"error","code":"no_workspace"}`, exit 2); its words.
    NotWorkspace(String),
    /// It could not be started at all.
    Spawn(String),
    /// It exited before its line (code, its last stderr lines).
    Exited(Option<i32>, String),
    /// Its line is not the supervised one.
    BadLine(String),
    Timeout,
}

impl StartError {
    /// Its words; `bundled` (launch.json version 2): the app's own engine — no repository command (L5.16).
    pub fn text(&self, bundled: bool) -> String {
        match self {
            StartError::NotWorkspace(t) => t.clone(),
            StartError::Spawn(e) => format!("Node.js could not be started: {e}"),
            StartError::Exited(Some(EXIT_USAGE), tail) if bundled => format!(
                "retake ui refused its arguments (exit {EXIT_USAGE}): this copy of {} is damaged — install it again from its disk image.\n\n{tail}",
                crate::app_name()
            ),
            StartError::Exited(Some(EXIT_USAGE), tail) => format!(
                "retake ui refused its arguments (exit {EXIT_USAGE}) — a CLI older than this app, without `ui --supervised`? Run pnpm build and pnpm desktop:build in the repository.\n\n{tail}"
            ),
            StartError::Exited(code, tail) => format!("retake ui exited ({}) before serving.\n\n{tail}", code.map_or("signal".into(), |c| format!("exit {c}"))),
            StartError::BadLine(e) => e.clone(),
            StartError::Timeout => format!("retake ui did not answer within {} s.", LINE_TIMEOUT.as_secs()),
        }
    }
}

struct Proc {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    stopping: AtomicBool,
    tail: Arc<Mutex<Tail>>,
    stderr_done: Mutex<Option<mpsc::Receiver<()>>>,
}

/// Where job ends go: the notifier once installed, held until then.
#[derive(Default)]
struct EndSink {
    handler: Option<Box<dyn Fn(JobEnd) + Send>>,
    held: VecDeque<JobEnd>,
}

/// A started server: the line, and the process when this shell owns it.
pub struct Server {
    pub line: UiLine,
    proc: Option<Arc<Proc>>,
    /// The server's last `pending` snapshot (the pipe of an owned server).
    pending: Arc<Mutex<Pending>>,
    ends: Arc<Mutex<EndSink>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn plural(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The lines after the `ui` line, until the server's stdout ends.
fn read_pipe(mut reader: LineReader<std::process::ChildStdout>, pending: Arc<Mutex<Pending>>, ends: Arc<Mutex<EndSink>>) {
    reader.set_cap(PIPE_LINE_MAX);
    let (mut said_ignored, mut said_long, mut said_bad) = (false, false, false);
    let mut counts: Option<(u32, u32, bool)> = None;
    while let Some(line) = reader.next_line() {
        match line {
            Line::TooLong => {
                lock(&pending).unknown = true;
                if !std::mem::replace(&mut said_long, true) {
                    log(&format!("a line from the Studio server was longer than {} KB: dropped", PIPE_LINE_MAX / 1024));
                }
            }
            Line::Text(text) => match parse_pipe_line(&text) {
                PipeMsg::Pending(p) => *lock(&pending) = p,
                PipeMsg::BadPending(why) => {
                    lock(&pending).unknown = true;
                    if !std::mem::replace(&mut said_bad, true) {
                        log(&format!("the Studio server sent a pending state this app cannot read ({why}): Quit asks with generic words"));
                    }
                }
                PipeMsg::JobEnd(e) => {
                    let mut sink = lock(&ends);
                    match &sink.handler {
                        Some(f) => f(e),
                        None if sink.held.len() < ENDS_HELD_MAX => sink.held.push_back(e),
                        None => {}
                    }
                }
                // L5.12d: the window page's ack or answer to the quit question (checked against the question up).
                msg @ (PipeMsg::Answer { .. } | PipeMsg::Shown { .. }) => {
                    crate::guard::from_page(msg);
                    continue;
                }
                // L5.16c: the Set-up sheet's request (the person's click in the page, through the server's setup ops).
                PipeMsg::Setup(a) => {
                    crate::setup_request(a);
                    continue;
                }
                // The server's framing newline (review A L3): nothing to say, nothing changed.
                PipeMsg::Blank => continue,
                PipeMsg::Ignored(why) => {
                    if !std::mem::replace(&mut said_ignored, true) {
                        log(&format!("ignored a line from the Studio server ({why})"));
                    }
                }
            },
        }
        let now = {
            let p = lock(&pending);
            (p.jobs_total, p.unsaved_total, p.unknown)
        };
        if counts != Some(now) {
            counts = Some(now);
            log(&format!("pending: {}, {} unsaved{}", plural(now.0, "job", "jobs"), now.1, if now.2 { " (unreadable state)" } else { "" }));
        }
    }
    lock(&pending).server_gone();
}

pub fn start(cfg: &LaunchConfig, workspace: &Path) -> Result<Server, StartError> {
    // The child gets the app's environment (README: Finder launches), less the code loaders in a release build. The
    // bundled app's (launch.json version 2): its module lookup guard first (`--require`: NODE_OPTIONS is dropped), and
    // ws's optional native addons off (the guard already keeps them from being found above the app).
    let mut cmd = Command::new(&cfg.node);
    if let Some(preload) = &cfg.preload {
        cmd.arg("--require").arg(preload);
    }
    if cfg.bundled {
        cmd.env("WS_NO_BUFFER_UTIL", "1").env("WS_NO_UTF_8_VALIDATE", "1");
    }
    cmd.arg(&cfg.cli).arg("--root").arg(workspace).args(["ui", "--supervised"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if !cfg!(debug_assertions) {
        for (k, _) in std::env::vars_os() {
            if k.to_str().is_some_and(child_env_dropped) {
                cmd.env_remove(&k);
            }
        }
    }
    let mut child = cmd.spawn().map_err(|e| StartError::Spawn(e.to_string()))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let tail = Arc::new(Mutex::new(Tail::default()));
    let (err_done_tx, err_done_rx) = mpsc::channel();
    {
        let tail = tail.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).split(b'\n') {
                let Ok(bytes) = line else { break };
                let text = sanitize(&String::from_utf8_lossy(&bytes));
                eprintln!("retake: {text}");
                tail.lock().unwrap_or_else(|e| e.into_inner()).push(text);
            }
            let _ = err_done_tx.send(());
        });
    }
    let (line_tx, line_rx) = mpsc::channel::<Option<String>>();
    let pending = Arc::new(Mutex::new(Pending::default()));
    let ends = Arc::new(Mutex::new(EndSink::default()));
    {
        let (pending, ends) = (pending.clone(), ends.clone());
        thread::spawn(move || {
            let mut reader = LineReader::new(stdout, LINE_MAX);
            let first = match reader.next_line() {
                Some(Line::Text(t)) => Some(t),
                _ => None,
            };
            let got = first.is_some();
            let _ = line_tx.send(first);
            // L5.2b: the pipe lines (read to the end, so the child never blocks on a full pipe).
            if got {
                read_pipe(reader, pending, ends);
            } else {
                while reader.next_line().is_some() {}
            }
        });
    }

    let fail = |child: &mut Child, stdin: Option<ChildStdin>| {
        let _ = stop_child(child, stdin, STOP_GRACE);
    };
    let line = match line_rx.recv_timeout(LINE_TIMEOUT) {
        Ok(Some(l)) => l,
        Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
            // Closed stdout without a line: it exited (or is exiting) — its code and words decide.
            let status = wait_for(&mut child, Duration::from_secs(5));
            let _ = err_done_rx.recv_timeout(Duration::from_secs(1));
            let words = tail.lock().unwrap_or_else(|e| e.into_inner()).text();
            drop(stdin);
            if status.is_none() {
                fail(&mut child, None);
            }
            return Err(StartError::Exited(status.and_then(|s| s.code()), words));
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            fail(&mut child, stdin);
            return Err(StartError::Timeout);
        }
    };
    let line = match parse_ui_line(&line) {
        Ok(l) => l,
        Err(LineError::NoWorkspace) => {
            drop(stdin);
            if wait_for(&mut child, Duration::from_secs(5)).is_none() {
                fail(&mut child, None);
            }
            let _ = err_done_rx.recv_timeout(Duration::from_secs(1));
            return Err(StartError::NotWorkspace(tail.lock().unwrap_or_else(|e| e.into_inner()).text()));
        }
        Err(e) => {
            fail(&mut child, stdin);
            return Err(StartError::BadLine(e.text(cfg.bundled)));
        }
    };
    if line.reused {
        // It printed and exits by itself; it never served.
        drop(stdin);
        if wait_for(&mut child, Duration::from_secs(5)).is_none() {
            fail(&mut child, None);
        }
        return Ok(Server { line, proc: None, pending, ends });
    }
    let proc = Arc::new(Proc { child: Mutex::new(child), stdin: Mutex::new(stdin), stopping: AtomicBool::new(false), tail, stderr_done: Mutex::new(Some(err_done_rx)) });
    Ok(Server { line, proc: Some(proc), pending, ends })
}

/// L5.16c, the first run: `retake init <dir>` with the app's own Node.js and CLI (its guard first, the same
/// environment as the server's), at most 30 s. Err: its last words.
pub fn init_workspace(cfg: &LaunchConfig, dir: &Path) -> Result<(), String> {
    let mut cmd = Command::new(&cfg.node);
    if let Some(preload) = &cfg.preload {
        cmd.arg("--require").arg(preload);
    }
    cmd.arg(&cfg.cli).arg("init").arg(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if !cfg!(debug_assertions) {
        for (k, _) in std::env::vars_os() {
            if k.to_str().is_some_and(child_env_dropped) {
                cmd.env_remove(&k);
            }
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("Node.js could not be started: {e}"))?;
    let (mut out, mut err) = (child.stdout.take().expect("piped stdout"), child.stderr.take().expect("piped stderr"));
    let reader = thread::spawn(move || {
        use std::io::Read;
        let mut text = String::new();
        let mut buf = Vec::new();
        let _ = err.read_to_end(&mut buf);
        let _ = out.read_to_string(&mut text);
        format!("{}{}", String::from_utf8_lossy(&buf), text)
    });
    let status = wait_for(&mut child, Duration::from_secs(30));
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let words = reader.join().unwrap_or_default();
    let words = sanitize(words.trim());
    match status {
        Some(s) if s.success() => Ok(()),
        Some(_) => Err(if words.is_empty() { "retake init failed".into() } else { words }),
        None => Err("retake init did not finish within 30 s".into()),
    }
}

fn wait_for(child: &mut Child, max: Duration) -> Option<ExitStatus> {
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return Some(s),
            Ok(None) if t0.elapsed() < max => thread::sleep(Duration::from_millis(20)),
            _ => return None,
        }
    }
}

impl Server {
    pub fn owned(&self) -> bool {
        self.proc.is_some()
    }

    /// The server's last `pending` snapshot; None for an attached server (no pipe reaches it).
    pub fn pending(&self) -> Option<Pending> {
        self.proc.as_ref().map(|_| lock(&self.pending).clone())
    }

    /// L5.16c: write one line on the owned server's stdin (the Set-up sheet's answers: desktop_core::setup's lines);
    /// false for an attached server or a closed pipe.
    pub fn send_line(&self, line: &str) -> bool {
        use std::io::Write;
        let Some(p) = &self.proc else { return false };
        let mut stdin = p.stdin.lock().unwrap_or_else(|e| e.into_inner());
        match stdin.as_mut() {
            Some(w) => w.write_all(format!("{line}\n").as_bytes()).and_then(|_| w.flush()).is_ok(),
            None => false,
        }
    }

    /// Send each job end of an owned server to `f` (from the reader thread), the ones held so far first.
    pub fn on_job_end(&self, f: impl Fn(JobEnd) + Send + 'static) {
        if self.proc.is_none() {
            return;
        }
        let mut sink = lock(&self.ends);
        for e in std::mem::take(&mut sink.held) {
            f(e);
        }
        sink.handler = Some(Box::new(f));
    }

    /// Stop the owned server (SIGTERM + EOF, then SIGKILL after STOP_GRACE) and let its last stderr lines through;
    /// nothing for an attached one.
    pub fn stop(&self, why: &str) {
        let Some(p) = &self.proc else { return };
        p.stopping.store(true, Ordering::SeqCst);
        let stdin = p.stdin.lock().unwrap_or_else(|e| e.into_inner()).take();
        let r = {
            let mut c = p.child.lock().unwrap_or_else(|e| e.into_inner());
            stop_child(&mut c, stdin, STOP_GRACE)
        };
        if let Some(rx) = p.stderr_done.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = rx.recv_timeout(Duration::from_secs(1));
        }
        let pid = self.line.pid;
        match r {
            Ok(Stopped::Exited(s, d)) => log(&format!("stopped the Studio server (pid {pid}, {why}): {s} after {} ms", d.as_millis())),
            Ok(Stopped::Killed(_)) => log(&format!("stopped the Studio server (pid {pid}, {why}): killed after {} s", STOP_GRACE.as_secs())),
            Ok(Stopped::AlreadyGone(s)) => log(&format!("the Studio server (pid {pid}) had already exited: {s}")),
            Err(e) => log(&format!("could not stop the Studio server (pid {pid}): {e}")),
        }
    }

    /// Call `on_exit` (from another thread) when the owned server exits while not being stopped: its status and its
    /// last stderr lines.
    pub fn watch(&self, on_exit: impl FnOnce(ExitStatus, String) + Send + 'static) {
        let Some(p) = self.proc.clone() else { return };
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(250));
            if p.stopping.load(Ordering::SeqCst) {
                return;
            }
            let status = p.child.lock().unwrap_or_else(|e| e.into_inner()).try_wait();
            match status {
                Ok(Some(s)) => {
                    if p.stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    if let Some(rx) = p.stderr_done.lock().unwrap_or_else(|e| e.into_inner()).take() {
                        let _ = rx.recv_timeout(Duration::from_secs(1));
                    }
                    let tail = p.tail.lock().unwrap_or_else(|e| e.into_inner()).text();
                    on_exit(s, tail);
                    return;
                }
                Ok(None) => {}
                Err(_) => return,
            }
        });
    }
}
