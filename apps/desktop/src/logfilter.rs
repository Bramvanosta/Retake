//! Everything this process prints on stderr goes through one filter (critique M5): its own lines, the child server's
//! forwarded lines and Tauri's own — which include the text a page frame sends to the IPC handler wry registers for
//! every frame. fd 2 is a pipe read by a thread that redacts (origins only, no secret-shaped run), replaces control
//! characters, caps each line, rate-limits, and drops Tauri's IPC-key lines (counted), before writing to the real
//! stderr. `finish` restores fd 2 and drains the pipe before the process exits. A panic writes its sanitised message to
//! the real stderr itself (review B L7: an abort would kill the process before the filter thread prints it).

use crate::BIN;
use desktop_core::{is_ipc_noise, sanitize, Admit, RateLimit};
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::FromRawFd;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Lines per second let through.
const LINES_PER_SECOND: u32 = 50;

struct Installed {
    original: i32,
    done: mpsc::Receiver<()>,
}

static INSTALLED: Mutex<Option<Installed>> = Mutex::new(None);

fn cloexec(fd: i32) {
    unsafe {
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
    }
}

/// Route fd 2 through the filter (once; a failure leaves stderr as it is).
pub fn install() {
    let mut fds = [0i32; 2];
    let original = unsafe { libc::dup(2) };
    if original < 0 || unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    cloexec(original);
    cloexec(fds[0]);
    std::panic::set_hook(Box::new(move |info| {
        let line = format!("{BIN}: {}\n", sanitize(&info.to_string().replace('\n', " ")));
        unsafe {
            libc::write(original, line.as_ptr() as *const libc::c_void, line.len());
        }
    }));
    unsafe {
        libc::dup2(fds[1], 2);
        libc::close(fds[1]);
    }
    let (tx, rx) = mpsc::channel();
    let reader = unsafe { File::from_raw_fd(fds[0]) };
    let out_fd = original;
    std::thread::spawn(move || {
        // Borrowed: `finish` closes nothing it does not own; the process exits right after.
        let mut out = std::mem::ManuallyDrop::new(unsafe { File::from_raw_fd(out_fd) });
        let mut limit = RateLimit::new(LINES_PER_SECOND, Duration::from_secs(1));
        let mut ipc: u64 = 0;
        let mut last_ipc_note = Instant::now() - Duration::from_secs(60);
        for line in BufReader::new(reader).split(b'\n') {
            let Ok(bytes) = line else { break };
            let text = String::from_utf8_lossy(&bytes);
            if is_ipc_noise(&text) {
                ipc += 1;
                if last_ipc_note.elapsed() >= Duration::from_secs(10) {
                    last_ipc_note = Instant::now();
                    let _ = writeln!(out, "{BIN}: refused {ipc} IPC message(s) from a page frame (the page has no command)");
                }
                continue;
            }
            match limit.admit(Instant::now()) {
                Admit::Drop => continue,
                Admit::PassAfterDrop(n) => {
                    let _ = writeln!(out, "{BIN}: {n} line(s) dropped (more than {LINES_PER_SECOND} a second)");
                }
                Admit::Pass => {}
            }
            let _ = writeln!(out, "{}", sanitize(&text));
        }
        let _ = out.flush();
        let _ = tx.send(());
    });
    *INSTALLED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Installed { original, done: rx });
}

/// Put the real stderr back on fd 2 (closing the pipe's last writer) and let the filter print what is left.
pub fn finish() {
    let taken = INSTALLED.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(i) = taken {
        unsafe {
            libc::dup2(i.original, 2);
        }
        let _ = i.done.recv_timeout(Duration::from_secs(2));
    }
}
