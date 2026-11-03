//! Stopping the child server: SIGTERM, then its stdin closed (the `--supervised` EOF rule) when it has not exited
//! within `EOF_AFTER`, then SIGKILL at the end of the grace period. `retake ui` stops in a few milliseconds on SIGTERM
//! (and says `stopped: SIGTERM`: a graceful Quit is told from the app's death, whose only signal is the EOF).

use std::io;
use std::process::{Child, ChildStdin, ExitStatus};
use std::thread;
use std::time::{Duration, Instant};

extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

const SIGTERM: i32 = 15;
/// SIGTERM alone first, for at most this long.
pub const EOF_AFTER: Duration = Duration::from_secs(1);

/// How the child ended.
#[derive(Debug)]
pub enum Stopped {
    /// It had already exited.
    AlreadyGone(ExitStatus),
    /// It exited within the grace period.
    Exited(ExitStatus, Duration),
    /// SIGKILL after the grace period.
    Killed(ExitStatus),
}

/// SIGTERM to `child`, `stdin` closed after `EOF_AFTER` (or at once if `grace` is shorter), at most `grace` in all to
/// exit, then SIGKILL; always reaped.
pub fn stop_child(child: &mut Child, stdin: Option<ChildStdin>, grace: Duration) -> io::Result<Stopped> {
    if let Some(s) = child.try_wait()? {
        drop(stdin);
        return Ok(Stopped::AlreadyGone(s));
    }
    let t0 = Instant::now();
    // The child is ours and not yet reaped (try_wait above): its pid cannot have been reused.
    unsafe {
        kill(child.id() as i32, SIGTERM);
    }
    let mut stdin = stdin;
    while t0.elapsed() < grace {
        if stdin.is_some() && t0.elapsed() >= EOF_AFTER.min(grace / 2) {
            drop(stdin.take());
        }
        if let Some(s) = child.try_wait()? {
            return Ok(Stopped::Exited(s, t0.elapsed()));
        }
        thread::sleep(Duration::from_millis(10));
    }
    child.kill()?;
    Ok(Stopped::Killed(child.wait()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    #[test]
    fn a_child_that_ignores_sigterm_is_killed_after_the_grace_period() {
        let mut c = Command::new("/bin/sh").args(["-c", "trap '' TERM; echo ready; exec sleep 30"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut ready = [0u8; 6];
        std::io::Read::read_exact(c.stdout.as_mut().unwrap(), &mut ready).unwrap();
        let stdin = c.stdin.take();
        let t0 = Instant::now();
        let r = stop_child(&mut c, stdin, Duration::from_millis(300)).unwrap();
        assert!(matches!(r, Stopped::Killed(_)), "{r:?}");
        assert!(t0.elapsed() >= Duration::from_millis(300));
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
        assert!(c.try_wait().unwrap().is_some());
    }

    #[test]
    fn a_well_behaved_child_exits_on_sigterm_without_sigkill() {
        let mut c = Command::new("/bin/sh").args(["-c", "trap 'exit 0' TERM; echo ready; while :; do sleep 0.05; done"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut ready = [0u8; 6];
        std::io::Read::read_exact(c.stdout.as_mut().unwrap(), &mut ready).unwrap();
        let stdin = c.stdin.take();
        match stop_child(&mut c, stdin, Duration::from_secs(5)).unwrap() {
            Stopped::Exited(s, d) => {
                assert_eq!(s.code(), Some(0));
                assert!(d < Duration::from_secs(2), "{d:?}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_child_that_stops_on_stdin_eof_exits_too() {
        // `read` returns at EOF: the supervised rule, without SIGTERM handling.
        let mut c = Command::new("/bin/sh").args(["-c", "trap '' TERM; echo ready; read x; exit 3"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut ready = [0u8; 6];
        std::io::Read::read_exact(c.stdout.as_mut().unwrap(), &mut ready).unwrap();
        let stdin = c.stdin.take();
        match stop_child(&mut c, stdin, Duration::from_secs(5)).unwrap() {
            Stopped::Exited(s, d) => {
                assert_eq!(s.code(), Some(3));
                // SIGTERM alone first: the EOF comes EOF_AFTER later.
                assert!(d >= EOF_AFTER, "{d:?}");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(stop_child(&mut c, None, Duration::from_secs(1)).unwrap(), Stopped::AlreadyGone(_)));
    }
}
