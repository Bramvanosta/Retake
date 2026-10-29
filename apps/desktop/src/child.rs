//! The child `studio ui --supervised`: started with its three pipes, its first stdout line read (≤ 30 s) and checked,
//! its stderr forwarded line by line (through the log filter) and its last 8 KB kept for an alert. Owned (it serves):
//! the shell holds the only write end of its stdin — the shell's death is its EOF, so no orphan — and stops it on
//! Quit (desktop_core::stop_child). Attached (`reused`: another process serves the workspace): it exits at once and
//! the shell never touches that server. A release build gives the child the app's environment without the variables
//! that make Node.js or the linker load code (desktop_core::child_env_dropped: review A L4).

use crate::log;
use desktop_core::{child_env_dropped, parse_ui_line, sanitize, stop_child, LaunchConfig, LineError, Stopped, UiLine};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
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
const LINE_MAX: u64 = 64 * 1024;

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
    pub fn text(&self) -> String {
        match self {
            StartError::NotWorkspace(t) => t.clone(),
            StartError::Spawn(e) => format!("Node.js could not be started: {e}"),
            StartError::Exited(Some(EXIT_USAGE), tail) => format!(
                "studio ui refused its arguments (exit {EXIT_USAGE}) — a CLI older than this app, without `ui --supervised`? Run pnpm build and pnpm desktop:build in the repository.\n\n{tail}"
            ),
            StartError::Exited(code, tail) => format!("studio ui exited ({}) before serving.\n\n{tail}", code.map_or("signal".into(), |c| format!("exit {c}"))),
            StartError::BadLine(e) => e.clone(),
            StartError::Timeout => format!("studio ui did not answer within {} s.", LINE_TIMEOUT.as_secs()),
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

/// A started server: the line, and the process when this shell owns it.
pub struct Server {
    pub line: UiLine,
    proc: Option<Arc<Proc>>,
}

pub fn start(cfg: &LaunchConfig, workspace: &Path) -> Result<Server, StartError> {
    // No variable of the shell's own is added: the child gets the app's environment (README: Finder launches), less the
    // code loaders in a release build.
    let mut cmd = Command::new(&cfg.node);
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
                eprintln!("studio: {text}");
                tail.lock().unwrap_or_else(|e| e.into_inner()).push(text);
            }
            let _ = err_done_tx.send(());
        });
    }
    let (line_tx, line_rx) = mpsc::channel::<Option<String>>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut first = Vec::new();
        let got = (&mut reader).take(LINE_MAX).read_until(b'\n', &mut first).unwrap_or(0) > 0 && first.ends_with(b"\n");
        let _ = line_tx.send(got.then(|| String::from_utf8_lossy(&first).into_owned()));
        // Later lines are not read for anything (no protocol yet: BL-106); drained so the child never blocks.
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });

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
            return Err(StartError::BadLine(e.to_string()));
        }
    };
    if line.reused {
        // It printed and exits by itself; it never served.
        drop(stdin);
        if wait_for(&mut child, Duration::from_secs(5)).is_none() {
            fail(&mut child, None);
        }
        return Ok(Server { line, proc: None });
    }
    let proc = Arc::new(Proc { child: Mutex::new(child), stdin: Mutex::new(stdin), stopping: AtomicBool::new(false), tail, stderr_done: Mutex::new(Some(err_done_rx)) });
    Ok(Server { line, proc: Some(proc) })
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
